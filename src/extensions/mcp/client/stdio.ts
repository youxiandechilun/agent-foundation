import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { invariant } from "../../../core/util.js";
import { terminateProcessTree } from "../../../execution/lifecycle.js";
import { MCPProtocolError, rpc, type RpcMessage } from "../protocol.js";
import type { MCPClientOptions } from "../client.js";

interface StdioHost {
  receive: (message: RpcMessage) => void;
  fail: (error: unknown) => Promise<void>;
  closed: () => boolean;
}
/** Owns stdio framing and process cleanup independently of pending RPC requests. */
export class MCPStdioTransport {
  private child?: ChildProcessWithoutNullStreams;
  constructor(
    private options: MCPClientOptions,
    private limits: { message: number; stderr: number },
    private host: StdioHost,
  ) {}
  async start() {
    invariant(this.options.command, "MCP stdio command required");
    const child = (this.child = spawn(
      this.options.command,
      this.options.args || [],
      {
        env: this.options.env,
        cwd: this.options.cwd,
        windowsHide: true,
        shell: false,
        detached:
          process.platform !== "win32" || this.options.ownerMonitored === true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ));
    const decoder = new StringDecoder("utf8");
    let buffer = "",
      stderr = 0;
    child.stdout.on("data", (chunk) => {
      try {
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (line.trim()) {
            invariant(
              Buffer.byteLength(line) <= this.limits.message,
              "MCP message exceeds limit",
              502,
            );
            this.host.receive(rpc(JSON.parse(line)));
          }
        }
        invariant(
          Buffer.byteLength(buffer) <= this.limits.message,
          "MCP stdout frame exceeds limit",
          502,
        );
      } catch (e) {
        void this.host.fail(e);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.length;
      if (stderr > this.limits.stderr)
        void this.host.fail(new MCPProtocolError("MCP stderr exceeds limit"));
    });
    child.on("error", (e) => void this.host.fail(e));
    child.on("close", (code) => {
      if (!this.host.closed())
        void this.host.fail(
          new MCPProtocolError(
            `MCP child exited (${code}); pending effects may be unknown`,
          ),
        );
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  async send(data: string): Promise<void> {
    const stdin = this.child?.stdin;
    invariant(stdin?.writable, "MCP stdin closed", 503);
    await new Promise<void>((resolve, reject) => {
      stdin.write(data + "\n", (error) => (error ? reject(error) : resolve()));
    });
  }
  async close(): Promise<void> {
    if (this.child) await terminateProcessTree(this.child);
  }
}
