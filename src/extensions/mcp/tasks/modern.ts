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
  expected?: unknown,
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
/** JSON numeric spellings may be much shorter than JSON.stringify's decimals. */
function shortNumber(value: number): string {
  // Match native JSON semantics for negative zero and nonfinite passthrough data.
  if (!Number.isFinite(value)) return "null";
  const decimal = String(value),
    exponential = value.toExponential().replace("e+", "e");
  return exponential.length < decimal.length &&
    Object.is(Number(exponential), value)
    ? exponential
    : decimal;
}
function taskSnapshot(task: ModernTask): Buffer {
  const rawJSON = (
    JSON as typeof JSON & { rawJSON?: (value: string) => unknown }
  ).rawJSON;
  if (rawJSON)
    return Buffer.from(
      JSON.stringify(task, (_key, value: unknown) =>
        typeof value === "number" ? rawJSON(shortNumber(value)) : value,
      ),
    );
  // Older runtimes serialize first, then scan whole quoted strings or JSON number
  // tokens. Numeric-looking text and keys remain opaque; no placeholders occur.
  return Buffer.from(
    JSON.stringify(task).replace(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) => (token[0] === '"' ? token : shortNumber(Number(token))),
    ),
  );
}
export interface ModernTaskEntry {
  task: ModernTask;
  snapshot: Buffer;
  createdAtHash: string;
  updatedAt: number;
  finalFingerprint?: string;
  context: MCPRequestContext;
  controller: AbortController;
  cleanup: () => void;
  deadline: number;
  inputs: Map<string, { fingerprint: string; answered: boolean }>;
  rounds: number;
  inputController?: AbortController;
  finalValidated: boolean;
  /** Worst-case snapshot reservation owned until the live context is released. */
  reservedBytes: number;
}
export interface ModernTaskReservation {
  /** Unclaimed reservations are returned after the originating RPC settles. */
  release(): void;
}
interface RetainedTask {
  snapshot: Buffer;
  reservedBytes: number;
  createdAtHash: string;
  updatedAt: number;
  context: MCPRequestContext;
  finalFingerprint?: string;
}
const SNAPSHOT_METADATA_BYTES = 4096;
const releasedSignal = AbortSignal.abort("Modern task host context ended");
/** Tracks observable remote state; task handles never gain an unrelated host execution context. */
export class ModernMCPTasks {
  private entries = new Map<string, ModernTaskEntry>();
  private retained = new Map<string, RetainedTask>();
  private reservations = new Set<ModernTaskReservation>();
  private bytes = 0;
  private closed = false;
  private readonly maxBytes: number;
  private readonly maxMessageBytes: number;
  constructor(
    private emit?: (event: ModernTaskEvent) => void,
    options: { maxBytes?: number; maxMessageBytes?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    invariant(
      Number.isSafeInteger(this.maxBytes) &&
        this.maxBytes > 0 &&
        Number.isSafeInteger(this.maxMessageBytes) &&
        this.maxMessageBytes > 0,
      "Invalid modern task snapshot capacity",
    );
  }
  /** Admit a possible task before tools/call can send a real remote effect. */
  reserve(): ModernTaskReservation {
    invariant(!this.closed, "Modern task tracker is closed", 503);
    const bytes = this.maxMessageBytes + SNAPSHOT_METADATA_BYTES;
    invariant(
      this.entries.size + this.retained.size + this.reservations.size < 4096 &&
        this.bytes + bytes <= this.maxBytes,
      "Modern task snapshot capacity exceeded; reconnect before creating more tasks",
      429,
      "resource_capacity",
    );
    this.bytes += bytes;
    const reservation: ModernTaskReservation = {
      release: () => {
        if (this.reservations.delete(reservation)) this.bytes -= bytes;
      },
    };
    this.reservations.add(reservation);
    return reservation;
  }
  create(
    value: unknown,
    context: MCPRequestContext,
    signal: AbortSignal | undefined,
    deadline: number,
    reservation?: ModernTaskReservation,
  ) {
    const task = modernTask(value, undefined, true);
    const snapshot = taskSnapshot(task);
    invariant(
      snapshot.length <= this.maxMessageBytes,
      "Modern task snapshot exceeds message limit",
      502,
    );
    invariant(
      !this.entries.has(task.taskId) && !this.retained.has(task.taskId),
      "Modern task ID reused by server",
      502,
    );
    signal?.throwIfAborted();
    const lease = reservation ?? this.reserve();
    invariant(
      this.reservations.has(lease),
      "Invalid modern task reservation",
      500,
    );
    const controller = new AbortController(),
      abort = () => controller.abort(new Error("Originating Agent task ended"));
    signal?.addEventListener("abort", abort, { once: true });
    const entry: ModernTaskEntry = {
      task,
      snapshot,
      createdAtHash: hash(task.createdAt),
      updatedAt: Date.parse(task.lastUpdatedAt),
      context: { ...context, signal: controller.signal },
      controller,
      cleanup: () => signal?.removeEventListener("abort", abort),
      deadline,
      inputs: new Map(),
      rounds: 0,
      finalValidated: false,
      reservedBytes: this.maxMessageBytes + SNAPSHOT_METADATA_BYTES,
    };
    try {
      this.emit?.({ kind: "created", task, context: entry.context });
      invariant(
        !this.closed && this.reservations.has(lease),
        "Modern task tracker closed during creation",
        503,
      );
    } catch (e) {
      entry.cleanup();
      controller.abort();
      lease.release();
      throw e;
    }
    this.reservations.delete(lease);
    this.entries.set(task.taskId, entry);
    return entry;
  }
  get(taskId: string) {
    return this.entries.get(taskId);
  }
  update(value: unknown, expected?: unknown) {
    const task = modernTask(value, expected),
      entry = this.entries.get(task.taskId),
      retained = this.retained.get(task.taskId);
    if (!entry && !retained) return task;
    invariant(
      entry
        ? task.createdAt === entry.task.createdAt
        : hash(task.createdAt) === retained!.createdAtHash,
      "Modern task creation time changed",
      502,
    );
    if (
      Date.parse(task.lastUpdatedAt) <
      (entry ? Date.parse(entry.task.lastUpdatedAt) : retained!.updatedAt)
    )
      return (
        entry?.task ??
        (JSON.parse(retained!.snapshot.toString("utf8")) as ModernTask)
      );
    if (entry?.finalValidated || retained?.finalFingerprint)
      invariant(
        fingerprint(task) ===
          (retained?.finalFingerprint ?? entry!.finalFingerprint),
        "Modern task terminal state changed",
        502,
      );
    const snapshot = taskSnapshot(task);
    invariant(
      snapshot.length <= this.maxMessageBytes,
      "Modern task snapshot exceeds message limit",
      502,
    );
    const finalFingerprint = taskTerminal(task.status)
      ? fingerprint(task)
      : undefined;
    let reservedBytes = 0;
    if (retained) {
      reservedBytes = taskTerminal(task.status)
        ? snapshot.length + SNAPSHOT_METADATA_BYTES
        : retained.reservedBytes;
      invariant(
        this.bytes - retained.reservedBytes + reservedBytes <= this.maxBytes,
        "Modern task snapshot capacity exceeded",
        429,
        "resource_capacity",
      );
    }
    this.emit?.({
      kind: "updated",
      task,
      context: entry?.context ?? retained!.context,
    });
    // Observers may synchronously close or release this owner. Never commit an
    // update into a detached entry or adjust capacity after its maps were cleared.
    if (
      entry
        ? this.entries.get(task.taskId) !== entry
        : this.retained.get(task.taskId) !== retained
    )
      return task;
    if (entry) {
      entry.task = task;
      entry.snapshot = snapshot;
      entry.updatedAt = Date.parse(task.lastUpdatedAt);
      entry.finalFingerprint = finalFingerprint;
      if (taskTerminal(task.status)) entry.finalValidated = true;
      if (taskTerminal(task.status))
        entry.inputController?.abort(
          new Error("Remote task reached a terminal state"),
        );
    } else if (retained) {
      this.bytes += reservedBytes - retained.reservedBytes;
      retained.snapshot = snapshot;
      retained.reservedBytes = reservedBytes;
      retained.updatedAt = Date.parse(task.lastUpdatedAt);
      if (finalFingerprint) retained.finalFingerprint = finalFingerprint;
    }
    return task;
  }
  release(taskId: string) {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    const snapshot = entry.snapshot;
    this.entries.delete(taskId);
    entry.cleanup();
    entry.controller.abort(new Error("Modern task host context ended"));
    entry.inputs.clear();
    const reservedBytes = entry.finalValidated
      ? snapshot.length + SNAPSHOT_METADATA_BYTES
      : entry.reservedBytes;
    this.bytes += reservedBytes - entry.reservedBytes;
    this.retained.set(taskId, {
      snapshot,
      reservedBytes,
      createdAtHash: entry.createdAtHash,
      updatedAt: entry.updatedAt,
      context: {
        requestId: entry.context.requestId,
        method: "tools/call",
        params: {},
        signal: releasedSignal,
      },
      finalFingerprint: entry.finalFingerprint,
    });
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
    if (this.closed) return;
    this.closed = true;
    const emit = this.emit;
    this.emit = undefined;
    const failures: unknown[] = [];
    try {
      for (const entry of this.entries.values()) {
        try {
          if (!entry.finalValidated)
            emit?.({
              kind: "unknown",
              task: entry.task,
              context: entry.context,
              error: "MCP connection ended; inspect remote task explicitly",
            });
        } catch (error) {
          failures.push(error);
        }
        for (const operation of [
          () => entry.cleanup(),
          () => entry.controller.abort(new Error("Modern task tracker closed")),
          () => entry.inputs.clear(),
        ]) {
          try {
            operation();
          } catch (error) {
            failures.push(error);
          }
        }
      }
    } finally {
      this.entries.clear();
      this.retained.clear();
      this.reservations.clear();
      this.bytes = 0;
    }
    if (failures.length)
      throw new AggregateError(failures, "Modern task tracker close failures");
  }
}
