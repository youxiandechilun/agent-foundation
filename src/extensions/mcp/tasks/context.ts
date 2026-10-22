import { invariant } from "../../../core/util.js";
import {
  wireMember,
  wireObject,
  type MCPRequestContext,
  type WireObject,
} from "../protocol.js";

export const RELATED_TASK = "io.modelcontextprotocol/related-task";
const terminal = new Set(["completed", "failed", "cancelled"]);
export const taskStatuses = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;
const statuses: readonly unknown[] = taskStatuses;
/** A legacy task status that passed {@link validateTask}. */
export type MCPTask = WireObject & {
  taskId: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  ttl?: number | null;
};
export function taskMetadata(params: unknown): string | undefined {
  const meta = wireMember(params, "_meta");
  if (!meta || typeof meta !== "object" || !Object.hasOwn(meta, RELATED_TASK))
    return;
  const taskId = wireObject(wireMember(meta, RELATED_TASK))?.taskId;
  invariant(
    typeof taskId === "string" && taskId.length > 0 && taskId.length <= 512,
    "Invalid related-task metadata",
    400,
  );
  return taskId;
}
export function validateTask(task: unknown, expected?: unknown): MCPTask {
  const taskId = wireMember(task, "taskId");
  invariant(
    typeof taskId === "string" &&
      taskId.length > 0 &&
      taskId.length <= 512 &&
      (!expected || taskId === expected) &&
      statuses.includes(wireMember(task, "status")),
    "Invalid MCP task status",
    502,
  );
  const ttl = wireMember(task, "ttl");
  invariant(
    ttl == null ||
      (typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl >= 0),
    "Invalid MCP task TTL",
    502,
  );
  return task as MCPTask;
}
/** Connection-scoped origins, retained after CreateTaskResult and revoked independently of the RPC. */
export class MCPTaskContexts {
  private entries = new Map<
    string,
    {
      context: MCPRequestContext;
      controller: AbortController;
      cleanup: () => void;
      progress?: (value: WireObject) => void;
      progressToken?: string;
    }
  >();
  private used = new Set<string>();
  get size() {
    return this.entries.size;
  }
  create(
    value: unknown,
    context: MCPRequestContext,
    options: {
      signal?: AbortSignal;
      deadline: number;
      progress?: (value: WireObject) => void;
      progressToken?: string;
    },
  ) {
    const task = validateTask(value);
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
  observe(value: unknown) {
    const task = validateTask(value);
    if (terminal.has(task.status)) this.release(task.taskId);
  }
  progress(taskId: string, params: WireObject) {
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
