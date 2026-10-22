import { z } from "zod";
import { invariant, hash } from "../../../core/util.js";
import type { MCPRequestContext } from "../protocol.js";
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const jsonObject = z.record(z.string(), z.json());
const taskSchema = z
  .object({
    taskId: z.string().min(1).max(512),
    status: z.enum([
      "working",
      "input_required",
      "completed",
      "failed",
      "cancelled",
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    lastUpdatedAt: z.iso.datetime({ offset: true }),
    ttlMs: z.number().int().nonnegative().nullable(),
    pollIntervalMs: z.number().int().positive().max(2147483647).optional(),
    statusMessage: z.string().max(32000).optional(),
    inputRequests: jsonObject.optional(),
    result: jsonObject.optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().max(32000),
        data: z.json().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ModernTask = z.infer<typeof taskSchema>;
export interface ModernTaskEvent {
  kind: "created" | "updated" | "unknown";
  task: ModernTask;
  context: MCPRequestContext;
  error?: string;
}
export function modernTask(
  value: unknown,
  expected?: string,
  seed = false,
): ModernTask {
  const task = taskSchema.parse(value);
  invariant(
    !expected || task.taskId === expected,
    "Modern task ID mismatch",
    502,
  );
  invariant(
    Date.parse(task.lastUpdatedAt) >= Date.parse(task.createdAt),
    "Invalid modern task timestamps",
    502,
  );
  if (!seed) {
    invariant(
      task.status !== "input_required" ||
        (task.inputRequests &&
          Object.keys(task.inputRequests).length > 0 &&
          Object.keys(task.inputRequests).length <= 16),
      "Modern task is missing bounded input requests",
      502,
    );
    invariant(
      task.status !== "completed" || task.result,
      "Completed modern task is missing its result",
      502,
    );
    invariant(
      task.status !== "failed" || task.error,
      "Failed modern task is missing its JSON-RPC error",
      502,
    );
    invariant(
      task.status === "completed" || task.result === undefined,
      "Unexpected modern task result",
      502,
    );
    invariant(
      task.status === "failed" || task.error === undefined,
      "Unexpected modern task error",
      502,
    );
    invariant(
      task.status === "input_required" || task.inputRequests === undefined,
      "Unexpected modern task inputs",
      502,
    );
  }
  return task;
}
export const taskTerminal = (s: string) =>
  ["completed", "failed", "cancelled"].includes(s);
export const taskFingerprint = (value: unknown) =>
  hash(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ),
  );
const fingerprint = (task: ModernTask) =>
  taskFingerprint({
    status: task.status,
    result: task.result,
    error: task.error,
  });
export interface ModernTaskEntry {
  task: ModernTask;
  context: MCPRequestContext;
  controller: AbortController;
  cleanup: () => void;
  deadline: number;
  inputs: Map<string, { fingerprint: string; answered: boolean }>;
  rounds: number;
  inputController?: AbortController;
  finalValidated: boolean;
}
/** Tracks observable remote state; task handles never gain an unrelated host execution context. */
export class ModernMCPTasks {
  private entries = new Map<string, ModernTaskEntry>();
  constructor(private emit?: (event: ModernTaskEvent) => void) {}
  create(
    value: unknown,
    context: MCPRequestContext,
    signal: AbortSignal | undefined,
    deadline: number,
  ) {
    const task = modernTask(value, undefined, true);
    invariant(
      this.entries.size < 4096,
      "Modern task tracking capacity exceeded; reconnect before creating more tasks",
      429,
    );
    invariant(
      !this.entries.has(task.taskId),
      "Modern task ID reused by server",
      502,
    );
    signal?.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort(new Error("Originating Agent task ended"));
    signal?.addEventListener("abort", abort, { once: true });
    const entry: ModernTaskEntry = {
      task,
      context: { ...context, signal: controller.signal },
      controller,
      cleanup: () => signal?.removeEventListener("abort", abort),
      deadline,
      inputs: new Map(),
      rounds: 0,
      finalValidated: false,
    };
    try {
      this.emit?.({ kind: "created", task, context: entry.context });
    } catch (e) {
      entry.cleanup();
      controller.abort();
      throw e;
    }
    this.entries.set(task.taskId, entry);
    return entry;
  }
  get(taskId: string) {
    return this.entries.get(taskId);
  }
  update(value: unknown, expected?: string) {
    const task = modernTask(value, expected),
      entry = this.entries.get(task.taskId);
    if (!entry) return task;
    invariant(
      task.createdAt === entry.task.createdAt,
      "Modern task creation time changed",
      502,
    );
    if (Date.parse(task.lastUpdatedAt) < Date.parse(entry.task.lastUpdatedAt))
      return entry.task;
    if (entry.finalValidated)
      invariant(
        fingerprint(task) === fingerprint(entry.task),
        "Modern task terminal state changed",
        502,
      );
    this.emit?.({ kind: "updated", task, context: entry.context });
    entry.task = task;
    if (taskTerminal(task.status)) entry.finalValidated = true;
    if (taskTerminal(task.status))
      entry.inputController?.abort(
        new Error("Remote task reached a terminal state"),
      );
    return task;
  }
  release(taskId: string) {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    entry.cleanup();
    entry.controller.abort(new Error("Modern task host context ended"));
    entry.inputs.clear();
  }
  unknown(taskId: string, error: string) {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.emit?.({
      kind: "unknown",
      task: entry.task,
      context: entry.context,
      error,
    });
    this.release(taskId);
  }
  close() {
    for (const [id, entry] of this.entries) {
      if (!entry.finalValidated)
        this.unknown(
          id,
          "MCP connection ended; inspect remote task explicitly",
        );
      else this.release(id);
    }
  }
}
