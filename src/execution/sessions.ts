import path from "node:path";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { hostname } from "node:os";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "../core/config.js";
import { Store } from "../storage/store.js";
import {
  nativeProcess,
  prepareCommand,
  processEnvironment,
  type PreparedCommand,
} from "./process.js";
import {
  id,
  hash,
  invariant,
  now,
  safePath,
  redactJson,
  processSecretSnapshot,
  abortable,
} from "../core/util.js";

export interface ProcessRecord {
  id: string;
  projectId: string;
  sessionId: string;
  runId?: string;
  host: string;
  command: string;
  args: string[];
  cwd: string;
  pty: boolean;
  boundary: "native" | "docker" | "windows-appcontainer";
  status: "starting" | "running" | "exited" | "stopped" | "failed" | "unknown";
  createdAt: string;
  updatedAt: string;
  pid?: number;
  brokerPid?: number;
  osSandbox?: boolean;
  exitCode?: number;
  error?: string;
}
export interface StartProcess {
  command: string;
  args: string[];
  cwd?: string;
  pty?: boolean;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  runId?: string;
}
const dimensions = (cols: number, rows: number) =>
  invariant(
    Number.isInteger(cols) &&
      cols >= 2 &&
      cols <= 500 &&
      Number.isInteger(rows) &&
      rows >= 2 &&
      rows <= 300,
    "Invalid PTY dimensions",
  );

/** Processes have a private broker, independent lifetime and durable output cursors. */
export class ProcessManager {
  private starting = 0;
  private startingIds = new Set<string>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private compiler?: Promise<string>;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  private directory(processId: string) {
    invariant(/^process_[a-f0-9-]{36}$/.test(processId), "Invalid process ID");
    return path.join(this.config.dataDir, "processes", processId);
  }
  owned(processId: string, sessionId: string) {
    const entry = this.store.get<ProcessRecord>("processes", processId);
    const session = this.store.session(sessionId);
    invariant(
      entry.sessionId === sessionId && entry.projectId === session.projectId,
      "Process belongs to another session",
      403,
    );
    invariant(
      entry.host === hostname(),
      "Process belongs to another host",
      409,
    );
    return entry;
  }
  private async helper() {
    if (process.platform !== "win32")
      return {
        command: this.config.execution.posixPython,
        args: [fileURLToPath(new URL("./native/pty_host.py", import.meta.url))],
      };
    this.compiler ||= (async () => {
      const source = fileURLToPath(
        new URL("./native/ConPtyHost.cs", import.meta.url),
      );
      const bytes = await readFile(source);
      const directory = path.join(this.config.dataDir, "native");
      await mkdir(directory, { recursive: true });
      const target = path.join(
        directory,
        `conpty-${hash(bytes).slice(0, 24)}.exe`,
      );
      try {
        await access(target);
        return target;
      } catch {}
      const compiler = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe",
      );
      const r = await nativeProcess({
        command: compiler,
        args: [
          "/nologo",
          "/r:System.Web.Extensions.dll",
          "/out:" + target,
          source,
        ],
        cwd: directory,
        timeoutMs: 30000,
      });
      invariant(
        r.exitCode === 0,
        "ConPTY source compilation failed: " + r.stdout + r.stderr,
        503,
        "pty_unavailable",
      );
      return target;
    })();
    return { command: await this.compiler, args: [] };
  }
  async start(
    sessionId: string,
    input: StartProcess,
    signal?: AbortSignal,
  ): Promise<ProcessRecord> {
    invariant(!this.closed, "Process manager is closed", 503);
    const task = this.startOnce(sessionId, input, signal);
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async startOnce(
    sessionId: string,
    input: StartProcess,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const session = this.store.session(sessionId),
      root = this.store.project(session.projectId).root;
    const running = (await this.list(sessionId, true)).filter(
      (p) =>
        !this.startingIds.has(p.id) &&
        ["starting", "running", "unknown"].includes(p.status),
    ).length;
    invariant(
      running + this.starting < this.config.execution.maxProcesses,
      "Process capacity exhausted",
      429,
    );
    this.starting++;
    let entry: ProcessRecord | undefined;
    let prepared: PreparedCommand | undefined;
    let brokerLaunched = false;
    try {
      invariant(
        input.command.length > 0 &&
          input.command.length <= 2000 &&
          Array.isArray(input.args) &&
          input.args.every((a) => typeof a === "string" && a.length <= 10000),
        "Invalid process request",
      );
      if (input.runId)
        invariant(
          this.store.run(input.runId).sessionId === sessionId,
          "Process run/session mismatch",
          403,
        );
      const timeoutMs =
        input.timeoutMs ?? this.config.execution.processLifetimeMs;
      invariant(
        Number.isInteger(timeoutMs) &&
          timeoutMs >= 100 &&
          timeoutMs <= this.config.execution.processLifetimeMs,
        "Invalid process lifetime",
      );
      dimensions(input.cols || 100, input.rows || 30);
      const command = await prepareCommand(
        this.config,
        {
          command: input.command,
          args: input.args,
          cwd: await safePath(root, input.cwd || ""),
          timeoutMs,
        },
        root,
        input.pty,
      );
      prepared = command;
      const helper = input.pty
        ? await (signal ? abortable(this.helper(), signal) : this.helper())
        : undefined;
      signal?.throwIfAborted();
      entry = {
        id: id("process"),
        projectId: session.projectId,
        sessionId,
        runId: input.runId,
        host: hostname(),
        command: input.command,
        args: input.args,
        cwd: input.cwd || "",
        pty: !!input.pty,
        boundary: command.boundary,
        status: "starting",
        createdAt: now(),
        updatedAt: now(),
      };
      this.startingIds.add(entry.id);
      this.store.put("processes", entry);
      const directory = this.directory(entry.id);
      await mkdir(directory, { recursive: true });
      const token = randomBytes(32).toString("hex");
      await writeFile(
        path.join(directory, "auth.json"),
        JSON.stringify({ token }),
        { mode: 0o600, flag: "wx" },
      );
      const file = path.join(directory, "request.json");
      await writeFile(
        file,
        JSON.stringify({
          ...command,
          id: entry.id,
          token,
          helper,
          pty: !!input.pty,
          secrets: processSecretSnapshot(),
          cols: input.cols || 100,
          rows: input.rows || 30,
          memoryMb: this.config.execution.memoryMb,
          pidsLimit: this.config.execution.pidsLimit,
          maxBufferBytes: this.config.execution.processBufferBytes,
          maxTotalOutputBytes: this.config.execution.processTotalOutputBytes,
        }),
        { mode: 0o600, flag: "wx" },
      );
      signal?.throwIfAborted();
      const broker = spawn(
        process.execPath,
        [fileURLToPath(new URL("./process-broker.mjs", import.meta.url)), file],
        {
          cwd: directory,
          env: processEnvironment(),
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        },
      );
      let spawnError: Error | undefined;
      broker.once("error", (e) => {
        spawnError = e;
      });
      broker.once("spawn", () => {
        brokerLaunched = true;
      });
      broker.unref();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (spawnError) throw spawnError;
        const current = await this.status(entry.id, sessionId);
        if (current.status === "running") {
          if (signal?.aborted || this.closed) {
            await this.stop(entry.id, sessionId);
            signal?.throwIfAborted();
            throw Error("Process manager closed");
          }
          if (input.runId)
            this.store.emit(input.runId, "process.started", {
              process: current,
            });
          return current;
        }
        if (["failed", "exited", "stopped"].includes(current.status)) {
          invariant(
            current.status !== "failed",
            current.error || "Process failed to start",
            503,
          );
          return current;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw Error("Process broker startup timed out");
    } catch (error) {
      let cleanupFailure: unknown;
      // No broker owns a prepared sandbox until spawn succeeds. An abort or
      // filesystem failure in this window must revoke its grants/staged secrets.
      if (!brokerLaunched && prepared?.cleanup) {
        try {
          const result = await nativeProcess({
            ...prepared.cleanup,
            cwd: prepared.cwd,
            timeoutMs: 30000,
          });
          invariant(
            result.exitCode === 0,
            "Prepared execution cleanup unconfirmed: " + result.stderr,
            503,
            "isolation_cleanup_failed",
          );
        } catch (e) {
          cleanupFailure = e;
        }
      }
      if (entry) {
        const terminal = brokerLaunched
          ? await this.stop(entry.id, sessionId).catch(() => undefined)
          : undefined;
        if (!brokerLaunched)
          await rm(path.join(this.directory(entry.id), "request.json"), {
            force: true,
          });
        this.store.put("processes", {
          ...entry,
          ...terminal,
          status:
            cleanupFailure ||
            (brokerLaunched && (!terminal || terminal.status === "unknown"))
              ? "unknown"
              : "failed",
          error:
            String((error as Error).message) +
            (cleanupFailure
              ? "; cleanup unconfirmed: " + String(cleanupFailure)
              : ""),
          updatedAt: now(),
        });
      }
      if (cleanupFailure)
        throw Object.assign(
          new AggregateError(
            [error, cleanupFailure],
            "Process startup failed and execution cleanup unconfirmed",
          ),
          { code: "isolation_cleanup_failed" },
        );
      throw error;
    } finally {
      this.starting--;
      if (entry) this.startingIds.delete(entry.id);
    }
  }
  async status(processId: string, sessionId: string): Promise<ProcessRecord> {
    const entry = this.owned(processId, sessionId);
    try {
      const state = JSON.parse(
        await readFile(
          path.join(this.directory(processId), "state.json"),
          "utf8",
        ),
      );
      const { port, ...publicState } = state;
      invariant(state.id === processId, "Invalid process journal", 409);
      const updated: ProcessRecord = {
        ...entry,
        ...publicState,
        projectId: entry.projectId,
        sessionId: entry.sessionId,
      };
      if (["starting", "running"].includes(updated.status)) {
        try {
          await this.rpc(processId, { op: "status" }, undefined, 2000);
        } catch {
          updated.status = "unknown";
          updated.error =
            "Process broker unreachable; no PID-based automatic replay or termination";
        }
      }
      return this.store.put("processes", updated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return entry;
      throw error;
    }
  }
  async list(sessionId: string, all = false) {
    this.store.session(sessionId);
    const entries = this.store.list<ProcessRecord>(
      "processes",
      all ? {} : { sessionId },
    );
    return Promise.all(entries.map((p) => this.status(p.id, p.sessionId)));
  }
  private async rpc(
    processId: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 35000,
  ): Promise<any> {
    signal?.throwIfAborted();
    const directory = this.directory(processId);
    const [{ token }, state] = await Promise.all([
      readFile(path.join(directory, "auth.json"), "utf8").then(JSON.parse),
      readFile(path.join(directory, "state.json"), "utf8").then(JSON.parse),
    ]);
    invariant(
      Number.isInteger(state.port) && state.port > 0 && state.port <= 65535,
      "Invalid broker endpoint",
      409,
    );
    const payload = {
      ...request,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: Date.now(),
    };
    const mac = (value: string) =>
      createHmac("sha256", token).update(value).digest("hex");
    return new Promise((resolve, reject) => {
      const socket = net.connect(state.port, "127.0.0.1");
      const decoder = new StringDecoder("utf8");
      let content = "",
        settled = false;
      const done = (error?: unknown, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        error ? reject(error) : resolve(result);
      };
      const abort = () => done(signal?.reason || Error("Cancelled"));
      const timer = setTimeout(
        () => done(Error("Process RPC timeout")),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({ ...payload, proof: mac(JSON.stringify(payload)) }) +
            "\n",
        ),
      );
      socket.on("data", (chunk) => {
        content += decoder.write(chunk);
        if (
          content.length >
          this.config.execution.processBufferBytes * 20 + 100000
        )
          return done(Error("Process response too large"));
        if (content.includes("\n"))
          try {
            const envelope = JSON.parse(
              content.slice(0, content.indexOf("\n")),
            );
            invariant(
              typeof envelope.payload === "string",
              "Process peer authentication failed",
              403,
            );
            const expected = Buffer.from(mac(envelope.payload), "hex"),
              given = Buffer.from(String(envelope.proof || ""), "hex");
            invariant(
              given.length === expected.length &&
                timingSafeEqual(given, expected),
              "Process peer authentication failed",
              403,
            );
            const response = JSON.parse(envelope.payload);
            invariant(
              response.nonce === payload.nonce,
              "Process response nonce mismatch",
              403,
            );
            response.ok
              ? done(undefined, response.result)
              : done(Error(response.error));
          } catch (e) {
            done(e);
          }
      });
      socket.once("error", done);
      socket.once("end", () => {
        if (!settled) done(Error("Incomplete process response"));
      });
    });
  }
  async read(
    processId: string,
    sessionId: string,
    cursor = 0,
    waitMs = 0,
    signal?: AbortSignal,
  ) {
    this.owned(processId, sessionId);
    invariant(
      Number.isSafeInteger(cursor) &&
        cursor >= 0 &&
        Number.isInteger(waitMs) &&
        waitMs >= 0 &&
        waitMs <= 30000,
      "Invalid process read",
    );
    try {
      return redactJson(
        await this.rpc(processId, { op: "read", cursor, waitMs }, signal),
      );
    } catch (error) {
      signal?.throwIfAborted();
      const state = await this.status(processId, sessionId);
      if (["running", "starting"].includes(state.status)) throw error;
      const journal = JSON.parse(
        await readFile(
          path.join(this.directory(processId), "output.json"),
          "utf8",
        ),
      );
      return redactJson({
        state,
        frames: journal.frames.filter((f: any) => f.seq > cursor),
        cursor: journal.cursor,
        truncated: cursor < journal.firstCursor - 1,
      });
    }
  }
  async write(
    processId: string,
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ) {
    this.owned(processId, sessionId);
    invariant(
      typeof text === "string" && Buffer.byteLength(text) <= 65536,
      "Process input too large",
      413,
    );
    return this.rpc(
      processId,
      { op: "write", data: Buffer.from(text).toString("base64") },
      signal,
    );
  }
  async resize(
    processId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ) {
    const entry = this.owned(processId, sessionId);
    invariant(entry.pty, "Process is not a PTY");
    dimensions(cols, rows);
    return this.rpc(processId, { op: "resize", cols, rows });
  }
  async stop(processId: string, sessionId: string) {
    const entry = this.owned(processId, sessionId);
    if (["exited", "stopped", "failed"].includes(entry.status))
      return this.status(processId, sessionId);
    await this.rpc(processId, { op: "stop" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await this.status(processId, sessionId);
      invariant(
        state.status !== "unknown",
        "Process termination is unconfirmed; inspect its unknown state",
        409,
      );
      if (!["starting", "running"].includes(state.status)) return state;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error("Process did not confirm termination; state remains unknown");
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    if (this.config.execution.processShutdown === "preserve") return;
    const entries = this.store
      .list<ProcessRecord>("processes")
      .filter((p) => ["starting", "running", "unknown"].includes(p.status));
    const results = await Promise.allSettled(
      entries.map((p) => this.stop(p.id, p.sessionId)),
    );
    if (results.some((r) => r.status === "rejected"))
      throw new AggregateError(
        results.filter((r) => r.status === "rejected").map((r) => r.reason),
        "Some process terminations could not be confirmed",
      );
  }
}
