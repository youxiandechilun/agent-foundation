import { invariant } from "../util.js";
import type { MCPRequestContext } from "./mcp-client.js";

export const RELATED_TASK = "io.modelcontextprotocol/related-task";
const terminal = new Set(["completed", "failed", "cancelled"]);
export function taskMetadata(params: any): string | undefined {
  const meta = params?._meta;
  if (!meta || !Object.hasOwn(meta, RELATED_TASK)) return;
  const value = meta[RELATED_TASK];
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.taskId === "string" &&
      value.taskId.length > 0 &&
      value.taskId.length <= 512,
    "Invalid related-task metadata",
    400,
  );
  return value.taskId;
}
export function validateTask(task: any, expected?: string) {
  invariant(
    task &&
      typeof task.taskId === "string" &&
      task.taskId.length > 0 &&
      task.taskId.length <= 512 &&
      (!expected || task.taskId === expected) &&
      ["working", "input_required", ...terminal].includes(task.status),
    "Invalid MCP task status",
    502,
  );
  invariant(
    task.ttl == null || (Number.isSafeInteger(task.ttl) && task.ttl >= 0),
    "Invalid MCP task TTL",
    502,
  );
  return task;
}
/** Connection-scoped origins, retained after CreateTaskResult and revoked independently of the RPC. */
export class MCPTaskContexts {
  private entries = new Map<
    string,
    {
      context: MCPRequestContext;
      controller: AbortController;
      cleanup: () => void;
      progress?: (v: any) => void;
      progressToken?: string;
    }
  >();
  private used = new Set<string>();
  get size() {
    return this.entries.size;
  }
  create(
    task: any,
    context: MCPRequestContext,
    options: {
      signal?: AbortSignal;
      deadline: number;
      progress?: (v: any) => void;
      progressToken?: string;
    },
  ) {
    validateTask(task);
    invariant(!this.used.has(task.taskId), "MCP server reused a task ID", 502);
    invariant(
      this.used.size < 4096 && this.entries.size < 128,
      "MCP task context capacity exceeded",
      429,
    );
    options.signal?.throwIfAborted();
    const controller = new AbortController(),
      remaining = Math.min(
        options.deadline - Date.now(),
        task.ttl == null ? Infinity : task.ttl,
      );
    invariant(remaining > 0, "MCP task lifetime expired", 504);
    this.used.add(task.taskId);
    const abort = () => this.release(task.taskId),
      timer = setTimeout(abort, Math.min(remaining, 2147483647));
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    this.entries.set(task.taskId, {
      context: { ...context, signal: controller.signal },
      controller,
      cleanup,
      progress: options.progress,
      progressToken: options.progressToken,
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (terminal.has(task.status)) this.release(task.taskId);
  }
  get(taskId: string) {
    return this.entries.get(taskId)?.context;
  }
  observe(task: any) {
    validateTask(task);
    if (terminal.has(task.status)) this.release(task.taskId);
  }
  progress(taskId: string, params: any) {
    const entry = this.entries.get(taskId);
    if (entry && entry.progressToken === params.progressToken)
      entry.progress?.(params);
  }
  release(taskId: string) {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    entry.cleanup();
    entry.controller.abort(new Error("MCP task callback context ended"));
  }
  close() {
    for (const key of this.entries.keys()) this.release(key);
  }
}
