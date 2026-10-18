import { randomUUID, randomBytes } from "node:crypto";
import { invariant, errorText, abortable, redactJson } from "../../../core/util.js";
import type { MCPRequestContext } from "../client.js";
import { RELATED_TASK } from "./context.js";

export interface MCPReceiverOptions {
  sampling?: boolean;
  elicitation?: boolean;
  maxTasks?: number;
  maxTtlMs?: number;
  pollIntervalMs?: number;
  pageSize?: number;
  persist?: (record: MCPReceivedTask) => void;
}
export interface MCPReceivedTask {
  id: string;
  connectionId: string;
  taskId: string;
  method: string;
  origin?: unknown;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
  statusMessage?: string;
  result?: any;
  error?: { code: number; message: string };
}
export class MCPTaskReceiverError extends Error {
  constructor(
    message: string,
    readonly code = -32602,
  ) {
    super(message);
  }
}
type LiveTask = {
  record: MCPReceivedTask;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  cleanup: () => void;
  expiresAt: number;
};
const terminal = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
/** Legacy 2025 task receiver. Every task is scoped to one authenticated peer connection. */
export class MCPTaskReceiver {
  readonly connectionId = randomUUID();
  private tasks = new Map<string, LiveTask>();
  private cursors = new Map<
    string,
    { ids: string[]; offset: number; expiresAt: number }
  >();
  private closed = false;
  constructor(
    readonly options: MCPReceiverOptions,
    private notify: (method: string, params: any) => Promise<void>,
    private maxBytes: number,
  ) {}
  supports(method: string) {
    return method === "sampling/createMessage"
      ? this.options.sampling === true
      : method === "elicitation/create" && this.options.elicitation === true;
  }
  capabilities() {
    return {
      list: {},
      cancel: {},
      requests: {
        ...(this.options.sampling ? { sampling: { createMessage: {} } } : {}),
        ...(this.options.elicitation ? { elicitation: { create: {} } } : {}),
      },
    };
  }
  private publicTask(record: MCPReceivedTask) {
    const {
      taskId,
      status,
      createdAt,
      lastUpdatedAt,
      ttl,
      pollInterval,
      statusMessage,
    } = record;
    return {
      taskId,
      status,
      createdAt,
      lastUpdatedAt,
      ttl,
      pollInterval,
      ...(statusMessage ? { statusMessage } : {}),
    };
  }
  private prune() {
    const time = Date.now();
    for (const [id, task] of this.tasks)
      if (task.expiresAt <= time) {
        this.end(task, "cancelled", undefined, {
          code: -32603,
          message: "Client task TTL expired",
        });
        this.tasks.delete(id);
      }
    for (const [key, cursor] of this.cursors)
      if (cursor.expiresAt <= time) this.cursors.delete(key);
  }
  private save(task: LiveTask) {
    this.options.persist?.(redactJson(structuredClone(task.record)));
  }
  private end(
    task: LiveTask,
    status: MCPReceivedTask["status"],
    result?: unknown,
    error?: { code: number; message: string },
  ) {
    if (terminal(task.record.status)) return;
    const previous = task.record;
    task.record = {
      ...previous,
      status,
      lastUpdatedAt: new Date().toISOString(),
      ...(result === undefined ? {} : { result }),
      ...(error ? { error, statusMessage: error.message } : {}),
    };
    try {
      this.save(task);
    } catch (e) {
      task.record = {
        ...previous,
        status: "failed",
        lastUpdatedAt: new Date().toISOString(),
        error: { code: -32603, message: "Client task persistence failed" },
      };
      throw e;
    } finally {
      task.cleanup();
      task.controller.abort(new Error("Client task ended"));
      task.finish();
    }
    if (!this.closed)
      void this.notify(
        "notifications/tasks/status",
        this.publicTask(task.record),
      ).catch(() => undefined);
  }
  create(
    method: string,
    params: any,
    context: MCPRequestContext,
    execute: (context: MCPRequestContext) => Promise<any>,
  ) {
    if (this.closed)
      throw new MCPTaskReceiverError("Client task receiver closed", -32603);
    if (!this.supports(method))
      throw new MCPTaskReceiverError(
        "Task augmentation is not supported for this client method",
        -32601,
      );
    if (!(
      params.task &&
      typeof params.task === "object" &&
      !Array.isArray(params.task) &&
      (params.task.ttl === undefined ||
        params.task.ttl === null ||
        (Number.isSafeInteger(params.task.ttl) && params.task.ttl > 0))
    ))
      throw new MCPTaskReceiverError("Invalid requested client task TTL");
    context.signal.throwIfAborted();
    this.prune();
    invariant(
      this.tasks.size < (this.options.maxTasks || 32),
      "Client task capacity exceeded",
      429,
    );
    const ttl = Math.min(
        params.task.ttl ?? this.options.maxTtlMs ?? 300000,
        this.options.maxTtlMs || 300000,
      ),
      createdAt = new Date().toISOString(),
      taskId = randomBytes(32).toString("base64url"),
      controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const abort = () =>
      this.end(task, "cancelled", undefined, {
        code: -32603,
        message: "Originating request or connection ended",
      });
    const timer = setTimeout(() => {
      this.end(task, "cancelled", undefined, {
        code: -32603,
        message: "Client task TTL expired",
      });
    }, ttl);
    timer.unref();
    const task: LiveTask = {
      record: {
        id: taskId,
        connectionId: this.connectionId,
        taskId,
        method,
        origin: context.localContext,
        status: "working",
        createdAt,
        lastUpdatedAt: createdAt,
        ttl,
        pollInterval: this.options.pollIntervalMs || 100,
      },
      controller,
      done,
      finish,
      expiresAt: Date.now() + ttl,
      cleanup: () => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
      },
    };
    try {
      this.save(task);
    } catch (e) {
      task.cleanup();
      throw e;
    }
    this.tasks.set(taskId, task);
    context.signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) return;
        try {
          const result = await abortable(
            execute({
              ...context,
              signal: controller.signal,
              setTaskStatus: (status) => this.state(taskId, status),
            }),
            controller.signal,
          );
          controller.signal.throwIfAborted();
          invariant(
            Buffer.byteLength(JSON.stringify(result)) <= this.maxBytes,
            "Client task result exceeds limit",
            413,
          );
          this.end(task, result?.isError ? "failed" : "completed", result);
        } catch (e) {
          if (!terminal(task.record.status))
            this.end(task, "failed", undefined, {
              code:
                typeof (e as any)?.code === "number" ? (e as any).code : -32603,
              message: errorText(e),
            });
        }
      })
      .catch(() => undefined);
    return { task: this.publicTask(task.record) };
  }
  state(taskId: string, status: "working" | "input_required") {
    const task = this.tasks.get(taskId);
    if (!task || terminal(task.record.status) || task.record.status === status)
      return;
    task.record = {
      ...task.record,
      status,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.save(task);
    if (!this.closed)
      void this.notify(
        "notifications/tasks/status",
        this.publicTask(task.record),
      ).catch(() => undefined);
  }
  private lookup(taskId: unknown) {
    this.prune();
    if (typeof taskId !== "string" || !this.tasks.has(taskId))
      throw new MCPTaskReceiverError("Client task not found or expired");
    return this.tasks.get(taskId)!;
  }
  async handle(method: string, params: any, signal: AbortSignal) {
    if (this.closed)
      throw new MCPTaskReceiverError("Client task receiver closed", -32603);
    if (method === "tasks/list") {
      this.prune();
      let ids: string[],
        offset = 0;
      if (params.cursor !== undefined) {
        const cursor =
          typeof params.cursor === "string"
            ? this.cursors.get(params.cursor)
            : undefined;
        if (!cursor)
          throw new MCPTaskReceiverError("Invalid client task cursor");
        ids = cursor.ids;
        offset = cursor.offset;
      } else ids = [...this.tasks.keys()];
      const size = this.options.pageSize || 20,
        tasks = ids
          .slice(offset, offset + size)
          .map((id) => this.tasks.get(id))
          .filter((t) => t !== undefined)
          .map((t) => this.publicTask(t!.record));
      let nextCursor: string | undefined;
      if (offset + size < ids.length) {
        invariant(
          this.cursors.size < 128,
          "Client task cursor capacity exceeded",
          429,
        );
        nextCursor = randomBytes(24).toString("base64url");
        this.cursors.set(nextCursor, {
          ids,
          offset: offset + size,
          expiresAt: Date.now() + 60000,
        });
      }
      return { tasks, ...(nextCursor ? { nextCursor } : {}) };
    }
    const task = this.lookup(params.taskId);
    if (method === "tasks/get") return this.publicTask(task.record);
    if (method === "tasks/cancel") {
      if (terminal(task.record.status))
        throw new MCPTaskReceiverError("Cannot cancel a terminal client task");
      this.end(task, "cancelled", undefined, {
        code: -32603,
        message: "Cancelled by MCP peer",
      });
      return this.publicTask(task.record);
    }
    if (method !== "tasks/result")
      throw new MCPTaskReceiverError(
        "Unsupported client task operation",
        -32601,
      );
    await abortable(task.done, signal);
    if (task.record.error)
      throw new MCPTaskReceiverError(
        task.record.error.message,
        task.record.error.code,
      );
    if (task.record.result === undefined)
      throw new MCPTaskReceiverError("Client task has no result", -32603);
    return {
      ...task.record.result,
      _meta: {
        ...task.record.result._meta,
        [RELATED_TASK]: { taskId: task.record.taskId },
      },
    };
  }
  close() {
    this.closed = true;
    for (const task of this.tasks.values()) {
      try {
        this.end(task, "cancelled", undefined, {
          code: -32603,
          message: "MCP peer connection closed",
        });
      } catch {}
    }
    this.cursors.clear();
  }
}
