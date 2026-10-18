import { createHash, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { Client, ClientChannel } from "ssh2";
import { now } from "../core/util.js";
import type { CommandEvidence, ServerCredentials, ServerProfile } from "./types.js";

export const hostFingerprint = (key: Buffer): string =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const matches = (key: Buffer, expected: string): boolean => {
  const observed = Buffer.from(hostFingerprint(key)), pinned = Buffer.from(expected);
  return observed.length === pinned.length && timingSafeEqual(observed, pinned);
};
interface Connection { client: Client; close: () => void }
/** SDK boundary: consumers do not need types from the optional SSH driver. */
interface SftpChannel {
  once(event: "close", listener: () => void): unknown;
  createReadStream(remotePath: string): Readable;
  writeFile(remotePath: string, bytes: Buffer, options: { flag: "w"; mode: number },
    callback: (error?: Error | null) => void): void;
}
export class SshTransport {
  private lifetime = new AbortController();
  private clients = new Set<Client>();
  private async client(): Promise<Client> {
    this.lifetime.signal.throwIfAborted();
    try {
      const { default: ssh } = await import("ssh2");
      this.lifetime.signal.throwIfAborted();
      return new ssh.Client();
    } catch (error) {
      if (this.lifetime.signal.aborted) throw error;
      throw new Error("SSH transport unavailable; install the optional ssh2 package");
    }
  }
  signal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  }
  private async open(profile: ServerProfile, credentials: ServerCredentials, signal: AbortSignal): Promise<Connection> {
    signal.throwIfAborted();
    const client = await this.client();
    signal.throwIfAborted();
    this.clients.add(client);
    return new Promise<Connection>((resolve, reject) => {
      let finished = false;
      const abort = () => {
        reject(new Error("SSH connection cancelled or timed out"));
        client.destroy();
      };
      const close = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        this.clients.delete(client);
        client.destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      client.once("close", () => {
        reject(new Error("SSH connection closed before authentication completed"));
        close();
      });
      client.on("error", (error: Error) => { reject(error); });
      client.once("ready", () => resolve({ client, close }));
      try {
        client.connect({
          host: profile.host, port: profile.port, username: profile.username,
          ...credentials,
          hostVerifier: (key: Buffer) => matches(key, profile.hostFingerprint),
          readyTimeout: 300000, keepaliveInterval: 15000, keepaliveCountMax: 2,
          tryKeyboard: false, agentForward: false,
        });
      } catch (error) { close(); reject(error); }
      if (signal.aborted) abort();
    });
  }
  async probe(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<{ host: string; port: number; hostFingerprint: string; trusted: false }> {
    const stop = this.signal(timeoutMs, signal), client = await this.client();
    stop.throwIfAborted();
    this.clients.add(client);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        stop.removeEventListener("abort", abort);
        this.clients.delete(client);
        client.destroy();
      };
      const abort = () => { cleanup(); reject(new Error("SSH probe cancelled or timed out")); };
      stop.addEventListener("abort", abort, { once: true });
      client.on("error", (error: Error) => { cleanup(); reject(error); });
      client.once("close", () => { cleanup(); reject(new Error("SSH probe closed without a host key")); });
      try {
        client.connect({
          host, port, username: "fingerprint-probe", readyTimeout: timeoutMs,
          hostVerifier: (key: Buffer) => {
            resolve({ host, port, hostFingerprint: hostFingerprint(key), trusted: false });
            // Reject the key: this handshake cannot authenticate or execute commands.
            queueMicrotask(cleanup);
            return false;
          },
        });
      } catch (error) { cleanup(); reject(error); }
      if (stop.aborted) abort();
    });
  }
  async exec(profile: ServerProfile, credentials: ServerCredentials, command: string, options: {
    timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal;
  }): Promise<CommandEvidence> {
    const startedAt = now(), stop = this.signal(options.timeoutMs, options.signal);
    let connection: Connection | undefined, dispatched = false;
    try {
      connection = await this.open(profile, credentials, stop);
      const { client } = connection;
      return await new Promise<CommandEvidence>((resolve) => {
        let channel: ClientChannel | undefined, settled = false, bytes = 0,
          truncated = false, exited = false, exitCode: number | null = null;
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        const finish = (error?: string) => {
          if (settled) return;
          settled = true;
          stop.removeEventListener("abort", abort);
          client.off("close", disconnected);
          client.off("error", failed);
          channel?.destroy();
          resolve({
            command, status: !error && exited ? "completed" : dispatched ? "unknown" : "failed",
            exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
            startedAt, finishedAt: now(), truncated, ...(error ? { error } : {}),
          });
        };
        const abort = () => finish("SSH command cancelled or timed out; remote state requires inspection");
        const disconnected = () => finish("SSH connection lost; remote state requires inspection");
        const failed = (error: Error) => finish(error.message);
        const receive = (chunk: Buffer, output: Buffer[]) => {
          if (settled) return;
          const remaining = options.maxOutputBytes - bytes;
          output.push(chunk.subarray(0, Math.max(0, remaining)));
          bytes += Math.min(chunk.length, remaining);
          if (chunk.length > remaining) { truncated = true; finish("SSH output limit reached; remote state requires inspection"); }
        };
        stop.addEventListener("abort", abort, { once: true });
        client.once("close", disconnected);
        client.once("error", failed);
        if (stop.aborted) { abort(); return; }
        dispatched = true;
        client.exec(command, { pty: false }, (error, stream) => {
          if (settled) { stream?.destroy(); return; }
          // A lost request acknowledgement cannot prove that the remote side did not execute.
          if (error) { finish(error.message); return; }
          channel = stream;
          stream.on("data", (chunk: Buffer) => receive(chunk, stdout));
          stream.stderr.on("data", (chunk: Buffer) => receive(chunk, stderr));
          stream.once("error", failed);
          stream.once("exit", (code: number | null) => { exited = true; exitCode = Number.isInteger(code) ? code : null; });
          stream.once("close", () => finish(exited ? undefined : "SSH channel closed without an observed exit status"));
          stream.end();
        });
      });
    } catch (error) {
      return { command, status: dispatched ? "unknown" : "failed", exitCode: null, stdout: "", stderr: "",
        startedAt, finishedAt: now(), truncated: false, error: error instanceof Error ? error.message : "SSH connection failed" };
    } finally { connection?.close(); }
  }
  async sftp<T>(profile: ServerProfile, credentials: ServerCredentials, timeoutMs: number, signal: AbortSignal | undefined,
    operation: (sftp: SftpChannel, stop: AbortSignal) => Promise<T>): Promise<T> {
    const stop = this.signal(timeoutMs, signal), connection = await this.open(profile, credentials, stop);
    try {
      const sftp = await new Promise<SftpChannel>((resolve, reject) => {
        const abort = () => reject(new Error("SFTP cancelled or timed out; inspect remote state before repeating"));
        const closed = () => reject(new Error("SSH connection lost during SFTP"));
        stop.addEventListener("abort", abort, { once: true });
        connection.client.once("close", closed);
        connection.client.sftp((error, wrapper) => {
          stop.removeEventListener("abort", abort);
          connection.client.off("close", closed);
          if (error) reject(error); else resolve(wrapper);
        });
        if (stop.aborted) abort();
      });
      stop.throwIfAborted();
      return await operation(sftp, stop);
    } finally { connection.close(); }
  }
  close(): void {
    this.lifetime.abort(new Error("Server integration closed"));
    for (const client of this.clients) client.destroy();
    this.clients.clear();
  }
}
