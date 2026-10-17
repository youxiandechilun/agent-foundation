import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { VERSION } from "../version.js";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { invariant, errorText, delay, abortable, hash } from "../util.js";
import { readJson } from "../providers/sse.js";
import { terminateProcessTree } from "../execution/lifecycle.js";
import {
  headerBindings,
  parameterHeaders,
  mcpHeaderValue,
  type HeaderBinding,
} from "./mcp-headers.js";
import { compileSchema } from "../runtime/json-schema.js";
import {
  MCPTaskContexts,
  RELATED_TASK,
  taskMetadata,
  validateTask,
} from "./mcp-task-context.js";
import {
  MCPTaskReceiver,
  MCPTaskReceiverError,
  type MCPReceiverOptions,
} from "./mcp-task-receiver.js";
import {
  ModernMCPTasks,
  TASKS_EXTENSION,
  modernTask,
  taskTerminal,
  taskFingerprint,
  type ModernTaskEvent,
} from "./mcp-modern-tasks.js";

export const MCP_MODERN_VERSION = "2026-07-28";
export interface MCPRequestContext {
  requestId: RpcId;
  method: string;
  params: any;
  localContext?: unknown;
  signal: AbortSignal;
  setTaskStatus?: (status: "working" | "input_required") => void;
}
export type MCPInputHandler = (
  params: any,
  context: MCPRequestContext,
) => Promise<unknown>;
export interface MCPRequestOptions {
  /** Host-only absolute callback deadline; never serialized to the peer. */
  taskDeadline?: number;
  signal?: AbortSignal;
  timeout?: number;
  progress?: (value: any) => void;
  localContext?: unknown;
  onSubscriptionAcknowledged?: (filter: MCPNotificationFilter) => void;
}
export interface MCPNotificationFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  taskIds?: string[];
}

export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
type RpcId = number | string;
type RpcMessage = {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};
export interface MCPClientOptions {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  cleanup?: () => Promise<void>;
  /** Only a trusted owner-monitoring launcher should enable this Windows lifecycle option. */
  ownerMonitored?: boolean;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  protocol?: "legacy" | "modern" | "auto";
  handlers?: Partial<
    Record<
      "roots/list" | "sampling/createMessage" | "elicitation/create",
      MCPInputHandler
    >
  >;
  samplingTools?: boolean;
  receiverTasks?: MCPReceiverOptions;
  taskExtension?: boolean;
  onTask?: (event: ModernTaskEvent) => void;
  maxInputRounds?: number;
  authorization?: () => Promise<string>;
  onAuthChallenge?: (header: string, status: number) => void;
}
interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  controller: AbortController;
  progressToken?: string;
  progress?: (value: any) => void;
  context: MCPRequestContext;
  taskOptions?: {
    signal?: AbortSignal;
    deadline: number;
    progress?: (v: any) => void;
    progressToken?: string;
  };
  modernTaskOptions?: { signal?: AbortSignal; deadline: number };
  subscription?: {
    filter: MCPNotificationFilter;
    acknowledged?: MCPNotificationFilter;
    onAck?: (filter: MCPNotificationFilter) => void;
  };
}
export class MCPProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number | string = "mcp_protocol_error",
    readonly data?: unknown,
  ) {
    super(message);
  }
}
function rpc(value: any): RpcMessage {
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.jsonrpc === "2.0",
    "Invalid MCP JSON-RPC message",
    502,
  );
  invariant(
    value.id === undefined ||
      typeof value.id === "string" ||
      Number.isSafeInteger(value.id),
    "Invalid MCP request ID",
    502,
  );
  if (value.method !== undefined)
    invariant(
      typeof value.method === "string" && value.method.length > 0,
      "Invalid MCP method",
      502,
    );
  else
    invariant(
      value.id !== undefined && "result" in value !== "error" in value,
      "Invalid MCP response",
      502,
    );
  if (value.error)
    invariant(
      Number.isInteger(value.error.code) &&
        typeof value.error.message === "string",
      "Invalid MCP error",
      502,
    );
  return value;
}
interface Frame {
  data: string;
  id?: string;
  retry?: number;
}
/** Own UTF-8/SSE framing. Empty data frames retain resume cursors; each frame is bounded. */
async function* frames(
  response: Response,
  max: number,
  signal: AbortSignal,
): AsyncGenerator<Frame> {
  invariant(response.body, "MCP response has no body", 502);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    first = true;
  const parse = (source: string): Frame => {
    const out: Frame = { data: "" },
      data: string[] = [];
    for (const line of source.split("\n")) {
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":"),
        key = i < 0 ? line : line.slice(0, i),
        value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (key === "data") data.push(value);
      else if (key === "id" && !value.includes("\0")) out.id = value;
      else if (key === "retry" && /^\d+$/.test(value))
        out.retry = Math.min(Number(value), 30000);
    }
    out.data = data.join("\n");
    return out;
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (first) {
        buffer = buffer.replace(/^\uFEFF/, "");
        first = false;
      }
      buffer = buffer.replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const source = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        invariant(
          Buffer.byteLength(source) <= max,
          "MCP SSE frame exceeds limit",
          502,
        );
        yield parse(source);
      }
      invariant(
        Buffer.byteLength(buffer) <= max,
        "MCP SSE buffer exceeds limit",
        502,
      );
      if (done) {
        if (buffer.trim()) yield parse(buffer);
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Foundation-maintained MCP client. Node streams/fetch only; no MCP or agent SDK. */
export class MCPClient {
  private receiver?: MCPTaskReceiver;
  private modernTasks: ModernMCPTasks;
  private taskContexts = new MCPTaskContexts();
  onclose?: (cleanupError?: Error) => void;
  onnotification?: (method: string, params: unknown) => void;
  protocolVersion = "";
  serverInfo: Record<string, unknown> = {};
  capabilities: Record<string, any> = {};
  private child?: ChildProcessWithoutNullStreams;
  private sessionId?: string;
  private lastAuthorization?: string;
  private initialized = false;
  private closed = false;
  private lifetime = new AbortController();
  private background?: AbortController;
  private nextId = 0;
  private pending = new Map<RpcId, Pending>();
  private closeCompletion?: Promise<void>;
  private seen = new Set<string>();
  private modern = false;
  private incoming = new Map<RpcId, AbortController>();
  private toolHeaders = new Map<string, HeaderBinding[]>();
  private toolSchemas = new Map<
    string,
    {
      input: ReturnType<typeof compileSchema>;
      output?: ReturnType<typeof compileSchema>;
    }
  >();
  private messages: { method: string; params: unknown; timestamp: string }[] =
    [];
  readonly limits: { message: number; stderr: number; timeout: number };
  constructor(readonly options: MCPClientOptions) {
    this.limits = {
      message: options.maxMessageBytes || 8 * 1024 * 1024,
      stderr: options.maxStderrBytes || 64000,
      timeout: options.timeoutMs || 30000,
    };
    this.modernTasks = new ModernMCPTasks(options.onTask);
    invariant(
      !options.receiverTasks?.sampling ||
        options.handlers?.["sampling/createMessage"],
      "Client sampling tasks require a sampling handler",
    );
    invariant(
      !options.receiverTasks?.elicitation ||
        options.handlers?.["elicitation/create"],
      "Client elicitation tasks require an elicitation handler",
    );
    if (options.receiverTasks)
      this.receiver = new MCPTaskReceiver(
        options.receiverTasks,
        (method, params) => this.notify(method, params),
        this.limits.message,
      );
  }
  get connected() {
    return this.initialized && !this.closed;
  }
  notifications() {
    return this.messages.slice();
  }
  private clientCapabilities() {
    const h = this.options.handlers || {};
    return {
      ...(this.modern && this.options.taskExtension
        ? { extensions: { [TASKS_EXTENSION]: {} } }
        : {}),
      ...(!this.modern && this.receiver
        ? { tasks: this.receiver.capabilities() }
        : {}),
      ...(h["roots/list"]
        ? { roots: this.modern ? {} : { listChanged: true } }
        : {}),
      ...(h["sampling/createMessage"]
        ? { sampling: this.options.samplingTools ? { tools: {} } : {} }
        : {}),
      ...(h["elicitation/create"]
        ? { elicitation: { form: {}, url: {} } }
        : {}),
    };
  }
  async connect() {
    invariant(
      !this.closed && !this.initialized,
      "MCP client cannot be reopened",
      409,
    );
    try {
      if (this.options.transport === "stdio") await this.startStdio();
      if (
        this.options.protocol === "modern" ||
        this.options.protocol === "auto"
      ) {
        this.modern = true;
        this.protocolVersion = MCP_MODERN_VERSION;
        try {
          const discovered = await this.requestOnce(
            "server/discover",
            {},
            undefined,
            true,
          );
          invariant(
            Array.isArray(discovered?.supportedVersions) &&
              discovered.supportedVersions.includes(MCP_MODERN_VERSION) &&
              discovered.capabilities &&
              typeof discovered.capabilities === "object",
            "Invalid MCP discovery",
            502,
          );
          this.capabilities = discovered.capabilities;
          this.serverInfo =
            discovered._meta?.["io.modelcontextprotocol/serverInfo"] || {};
          this.initialized = true;
          return;
        } catch (error) {
          const legacyFallback =
            error instanceof MCPProtocolError &&
            (error.code === -32601 ||
              (error.code === -32022 &&
                Array.isArray((error.data as any)?.supportedVersions) &&
                (error.data as any).supportedVersions.some((v: any) =>
                  MCP_PROTOCOL_VERSIONS.includes(v),
                )));
          if (this.options.protocol !== "auto" || !legacyFallback) throw error;
          this.modern = false;
          this.protocolVersion = "";
        }
      }
      const result = await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSIONS[0],
          capabilities: this.clientCapabilities(),
          clientInfo: { name: "agent-foundation", version: VERSION },
        },
        undefined,
        true,
      );
      invariant(
        result &&
          MCP_PROTOCOL_VERSIONS.includes(result.protocolVersion) &&
          result.capabilities &&
          typeof result.capabilities === "object" &&
          typeof result.serverInfo?.name === "string",
        "Invalid or unsupported MCP initialization",
        502,
      );
      invariant(
        this.options.transport !== "http" ||
          result.protocolVersion !== "2024-11-05",
        "Legacy HTTP+SSE transport is not enabled",
        502,
      );
      this.protocolVersion = result.protocolVersion;
      this.capabilities = result.capabilities;
      this.serverInfo = result.serverInfo;
      await this.notify("notifications/initialized");
      this.initialized = true;
      if (this.options.transport === "http") {
        this.background = new AbortController();
        void this.listen(this.background.signal).catch((e) => {
          if (!this.closed && !this.background?.signal.aborted)
            this.record("transport/error", { message: errorText(e) });
        });
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private async startStdio() {
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
            this.receive(rpc(JSON.parse(line)));
          }
        }
        invariant(
          Buffer.byteLength(buffer) <= this.limits.message,
          "MCP stdout frame exceeds limit",
          502,
        );
      } catch (e) {
        void this.fail(e);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.length;
      if (stderr > this.limits.stderr)
        void this.fail(new MCPProtocolError("MCP stderr exceeds limit"));
    });
    child.on("error", (e) => void this.fail(e));
    child.on("close", (code) => {
      if (!this.closed)
        void this.fail(
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
  private record(method: string, params: unknown) {
    this.messages.push({ method, params, timestamp: new Date().toISOString() });
    if (this.messages.length > 100) this.messages.shift();
    this.onnotification?.(method, params);
  }
  private receive(message: RpcMessage, parentId?: RpcId) {
    if (this.closed) return;
    if (message.method) {
      if (message.id !== undefined) {
        if (this.modern) {
          void this.fail(
            new MCPProtocolError(
              "Modern MCP servers cannot initiate JSON-RPC requests",
            ),
          );
          return;
        }
        void this.handleIncoming(message, parentId).catch((error) =>
          this.record("transport/error", { message: errorText(error) }),
        );
        return;
      }
      if (message.method === "notifications/cancelled")
        this.incoming
          .get(message.params?.requestId)
          ?.abort(new Error("Server cancelled client input"));
      if (message.method === "notifications/tasks/status") {
        try {
          this.taskContexts.observe(message.params);
        } catch {
          this.record("tasks/rejected", {
            message: "Invalid task status notification",
          });
          return;
        }
      }
      if (
        this.modern &&
        [
          "notifications/subscriptions/acknowledged",
          "notifications/tools/list_changed",
          "notifications/prompts/list_changed",
          "notifications/resources/list_changed",
          "notifications/resources/updated",
          "notifications/tasks",
        ].includes(message.method)
      ) {
        const key =
            message.params?._meta?.["io.modelcontextprotocol/subscriptionId"],
          sub = this.pending.get(key)?.subscription;
        try {
          invariant(sub, "Unsolicited MCP subscription notification", 502);
          if (message.method === "notifications/subscriptions/acknowledged") {
            invariant(
              !sub.acknowledged,
              "Duplicate subscription acknowledgement",
              502,
            );
            const actual = message.params?.notifications;
            invariant(
              actual && typeof actual === "object" && !Array.isArray(actual),
              "Invalid subscription acknowledgement",
              502,
            );
            for (const [name, value] of Object.entries(actual)) {
              invariant(
                [
                  "toolsListChanged",
                  "promptsListChanged",
                  "resourcesListChanged",
                  "resourceSubscriptions",
                  "taskIds",
                ].includes(name),
                "Unknown acknowledged notification filter",
                502,
              );
              if (name === "resourceSubscriptions" || name === "taskIds")
                invariant(
                  Array.isArray(value) &&
                    value.every(
                      (v) =>
                        typeof v === "string" && sub.filter[name]?.includes(v),
                    ),
                  "Unrequested resource subscription",
                  502,
                );
              else
                invariant(
                  value === true &&
                    sub.filter[name as keyof MCPNotificationFilter] === true,
                  "Unrequested notification type",
                  502,
                );
            }
            sub.acknowledged = actual;
            sub.onAck?.(actual);
          } else {
            invariant(
              sub.acknowledged,
              "Notification arrived before acknowledgement",
              502,
            );
            const expected: Record<string, string> = {
              "notifications/tools/list_changed": "toolsListChanged",
              "notifications/prompts/list_changed": "promptsListChanged",
              "notifications/resources/list_changed": "resourcesListChanged",
            };
            invariant(
              message.method === "notifications/tasks"
                ? sub.acknowledged.taskIds?.includes(message.params?.taskId)
                : message.method === "notifications/resources/updated"
                  ? sub.acknowledged.resourceSubscriptions?.includes(
                      message.params?.uri,
                    )
                  : (sub.acknowledged as any)[expected[message.method]] ===
                    true,
              "Notification was not subscribed",
              502,
            );
            if (message.method === "notifications/tasks") {
              invariant(
                this.options.taskExtension &&
                  this.capabilities.extensions?.[TASKS_EXTENSION],
                "Task notification extension is not negotiated",
                502,
              );
              this.modernTasks.update(message.params);
            }
          }
        } catch (error) {
          this.record("subscriptions/rejected", { message: errorText(error) });
          return;
        }
      }
      if (message.method === "notifications/progress") {
        try {
          const taskId = taskMetadata(message.params);
          if (taskId) this.taskContexts.progress(taskId, message.params);
        } catch {
          return;
        }
        for (const p of this.pending.values())
          if (p.progressToken === message.params?.progressToken)
            p.progress?.(message.params);
      }
      this.record(message.method, message.params);
      return;
    }
    const p = this.pending.get(message.id!);
    if (!p) return;
    if (!message.error) {
      try {
        if (p.taskOptions)
          this.taskContexts.create(
            message.result?.task,
            p.context,
            p.taskOptions,
          );
        if (
          !this.modern &&
          ["tasks/get", "tasks/cancel"].includes(p.context.method)
        ) {
          validateTask(message.result, p.context.params.taskId);
          this.taskContexts.observe(message.result);
        }
        if (!this.modern && p.context.method === "tasks/result") {
          invariant(
            taskMetadata(message.result) === p.context.params.taskId,
            "MCP task result has missing or mismatched related-task metadata",
            502,
          );
          this.taskContexts.release(p.context.params.taskId);
        }
        if (this.modern && message.result?.resultType === "task") {
          invariant(
            p.context.method === "tools/call" &&
              p.modernTaskOptions &&
              this.options.taskExtension &&
              this.capabilities.extensions?.[TASKS_EXTENSION],
            "Unexpected or unnegotiated modern task result",
            502,
          );
          this.modernTasks.create(
            message.result,
            p.context,
            p.modernTaskOptions.signal,
            p.modernTaskOptions.deadline,
          );
        }
        if (this.modern && p.context.method === "tasks/get") {
          invariant(
            message.result?.resultType === "complete",
            "Modern tasks/get requires a complete result",
            502,
          );
          message.result = {
            ...this.modernTasks.update(message.result, p.context.params.taskId),
            resultType: "complete",
          };
        }
      } catch (error) {
        if (p.context.method === "tasks/result")
          this.taskContexts.release(p.context.params.taskId);
        this.pending.delete(message.id!);
        p.cleanup();
        p.controller.abort();
        p.reject(error as Error);
        return;
      }
    }
    this.pending.delete(message.id!);
    p.cleanup();
    p.controller.abort(new Error("Originating MCP request completed"));
    if (message.error)
      p.reject(
        new MCPProtocolError(
          message.error.message,
          message.error.code,
          message.error.data,
        ),
      );
    else p.resolve(message.result);
  }
  private async handleIncoming(message: RpcMessage, parentId?: RpcId) {
    const requestId = message.id!;
    if (this.incoming.has(requestId)) {
      await this.fail(new MCPProtocolError("Duplicate server request ID"));
      return;
    }
    const controller = new AbortController();
    this.incoming.set(requestId, controller);
    const parents = [...this.pending.values()].filter((p) =>
      ["tools/call", "resources/read", "prompts/get"].includes(
        p.context.method,
      ),
    );
    const ordinaryParent =
      parentId === undefined
        ? parents.length === 1 && this.taskContexts.size === 0
          ? parents[0]
          : undefined
        : this.pending.get(parentId);
    const taskOperation = [
      "tasks/get",
      "tasks/result",
      "tasks/cancel",
      "tasks/list",
    ].includes(message.method!);
    let related: string | undefined;
    let invalidRelated: unknown;
    try {
      related = taskOperation ? undefined : taskMetadata(message.params);
    } catch (error) {
      invalidRelated = error;
    }
    const parent = related ? undefined : ordinaryParent;
    const context = related ? this.taskContexts.get(related) : parent?.context;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      controller.signal,
      AbortSignal.timeout(this.limits.timeout),
      ...(context ? [context.signal] : []),
    ]);
    try {
      if (invalidRelated || (related && !context))
        throw new MCPProtocolError(
          "Unknown, expired or invalid related task",
          -32602,
        );
      invariant(
        this.incoming.size <= 16,
        "Too many concurrent server input requests",
        429,
      );
      let result: any;
      if (taskOperation) {
        if (!this.receiver || this.protocolVersion !== "2025-11-25")
          throw new MCPProtocolError(
            "Client task receiver is not enabled",
            -32601,
          );
        if (
          message.method === "tasks/result" &&
          typeof message.params?.taskId === "string"
        )
          related = message.params.taskId;
        result = await this.receiver.handle(
          message.method!,
          message.params || {},
          signal,
        );
      } else if (message.params?.task !== undefined) {
        if (!(
          this.receiver &&
          this.protocolVersion === "2025-11-25" &&
          this.receiver.supports(message.method!) &&
          this.options.handlers?.[
            message.method! as keyof NonNullable<MCPClientOptions["handlers"]>
          ]
        ))
          throw new MCPProtocolError(
            "Client task capability not enabled",
            -32601,
          );
        invariant(
          context &&
            ["tools/call", "resources/read", "prompts/get"].includes(
              context.method,
            ),
          "Client task requires an originating host request",
          403,
        );
        signal.throwIfAborted();
        const { task: _, ...input } = message.params;
        result = this.receiver.create(
          message.method!,
          message.params,
          {
            ...context,
            signal: AbortSignal.any([this.lifetime.signal, context.signal]),
          },
          (taskContext) =>
            this.handleInput(message.method!, input, taskContext),
        );
      } else
        result =
          message.method === "ping"
            ? {}
            : await this.handleInput(message.method!, message.params || {}, {
                requestId: context?.requestId ?? requestId,
                method: context?.method || "",
                params: context?.params || {},
                localContext: context?.localContext,
                signal,
              });
      signal.throwIfAborted();
      await this.send(
        {
          jsonrpc: "2.0",
          id: requestId,
          result: related
            ? {
                ...(result as any),
                _meta: {
                  ...(result as any)?._meta,
                  [RELATED_TASK]: { taskId: related },
                },
              }
            : result,
        },
        this.lifetime.signal,
      );
    } catch (error) {
      if (!this.closed)
        await this.send(
          {
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code:
                error instanceof MCPProtocolError &&
                typeof error.code === "number"
                  ? error.code
                  : error instanceof MCPTaskReceiverError
                    ? error.code
                    : -32603,
              message: errorText(error),
              ...(related
                ? { data: { _meta: { [RELATED_TASK]: { taskId: related } } } }
                : {}),
            },
          },
          this.lifetime.signal,
        );
    } finally {
      this.incoming.delete(requestId);
    }
  }
  private async handleInput(
    method: string,
    params: any,
    context: MCPRequestContext,
  ) {
    const handler =
      ["roots/list", "sampling/createMessage", "elicitation/create"].includes(
        method,
      ) &&
      this.options.handlers &&
      Object.hasOwn(this.options.handlers, method)
        ? this.options.handlers[
            method as keyof NonNullable<MCPClientOptions["handlers"]>
          ]
        : undefined;
    if (!handler)
      throw new MCPProtocolError("Client capability not supported", -32601);
    invariant(
      method === "roots/list" ||
        ["tools/call", "resources/read", "prompts/get"].includes(
          context.method,
        ),
      "Client input has no unambiguous originating request",
      403,
    );
    context.signal.throwIfAborted();
    return await abortable(handler(params, context), context.signal);
  }
  async request(
    method: string,
    params: any = {},
    options?: MCPRequestOptions,
    initializing = false,
  ): Promise<any> {
    const deadline = Date.now() + (options?.timeout || this.limits.timeout),
      seen = new Set<string>();
    let current = params;
    for (let round = 0; round <= (this.options.maxInputRounds || 8); round++) {
      options?.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      invariant(remaining > 0, "MCP multi-round request timed out", 504);
      const result = await this.requestOnce(
        method,
        current,
        { ...options, timeout: remaining },
        initializing,
      );
      if (!this.modern) return result;
      invariant(
        result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          (!result.resultType ||
            ["complete", "input_required", "task"].includes(result.resultType)),
        "Unknown MCP result type",
        502,
      );
      if (result.resultType !== "input_required") return result;
      invariant(
        ["tools/call", "resources/read", "prompts/get"].includes(method),
        "InputRequiredResult on unsupported method",
        502,
      );
      invariant(
        round < (this.options.maxInputRounds || 8),
        "MCP input round limit exceeded",
        502,
      );
      invariant(
        (result.inputRequests &&
          typeof result.inputRequests === "object" &&
          !Array.isArray(result.inputRequests)) ||
          typeof result.requestState === "string",
        "Invalid input-required result",
        502,
      );
      invariant(
        result.requestState === undefined ||
          typeof result.requestState === "string",
        "Invalid opaque request state",
        502,
      );
      const inputResponses: Record<string, unknown> = Object.create(null);
      const requests = Object.entries(result.inputRequests || {});
      invariant(requests.length <= 16, "Too many input requests", 502);
      const signal = AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ...(options?.signal ? [options.signal] : []),
      ]);
      for (const [key, value] of requests) {
        invariant(key && !seen.has(key), "Duplicate MCP input request ID", 502);
        seen.add(key);
        const request = value as any;
        invariant(
          request && typeof request.method === "string",
          "Invalid embedded input request",
          502,
        );
        inputResponses[key] = await this.handleInput(
          request.method,
          request.params || {},
          {
            requestId: key,
            method,
            params,
            localContext: options?.localContext,
            signal,
          },
        );
      }
      current = {
        ...params,
        ...(requests.length ? { inputResponses } : {}),
        ...(result.requestState === undefined
          ? {}
          : { requestState: result.requestState }),
      };
    }
  }
  private async requestOnce(
    method: string,
    params: unknown = {},
    options?: MCPRequestOptions,
    initializing = false,
  ): Promise<any> {
    invariant(
      !this.closed && (this.initialized || initializing),
      "MCP connection is not initialized",
      503,
    );
    options?.signal?.throwIfAborted();
    const requestId = ++this.nextId,
      controller = new AbortController(),
      progressToken = options?.progress ? randomUUID() : undefined;
    return new Promise((resolve, reject) => {
      const abort = (reason: Error) => {
        const p = this.pending.get(requestId);
        if (!p) return;
        this.pending.delete(requestId);
        p.cleanup();
        controller.abort(reason);
        reject(reason);
        if (
          !initializing &&
          (!this.modern || this.options.transport === "stdio")
        )
          void this.notify("notifications/cancelled", {
            requestId,
            reason: reason.message,
          }).catch(() => undefined);
      };
      const onAbort = () =>
        abort(new MCPProtocolError("MCP request cancelled", "cancelled"));
      const timer = setTimeout(
        () =>
          abort(
            new MCPProtocolError(
              `MCP ${method} timed out; effect outcome may be unknown`,
              "timeout",
            ),
          ),
        options?.timeout || this.limits.timeout,
      );
      this.pending.set(requestId, {
        resolve,
        reject,
        controller,
        progressToken,
        progress: options?.progress,
        context: {
          requestId,
          method,
          params,
          localContext: options?.localContext,
          signal: controller.signal,
        },
        ...(method === "tools/call" && (params as any)?.task
          ? {
              taskOptions: {
                signal: options?.signal,
                deadline:
                  options?.taskDeadline ??
                  Date.now() + (options?.timeout || this.limits.timeout),
                progress: options?.progress,
                progressToken,
              },
            }
          : {}),
        ...(this.modern && method === "tools/call" && this.options.taskExtension
          ? {
              modernTaskOptions: {
                signal: options?.signal,
                deadline:
                  options?.taskDeadline ??
                  Date.now() + (options?.timeout || this.limits.timeout),
              },
            }
          : {}),
        ...(method === "subscriptions/listen"
          ? {
              subscription: {
                filter: (params as any).notifications,
                onAck: options?.onSubscriptionAcknowledged,
              },
            }
          : {}),
        cleanup: () => {
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", onAbort);
        },
      });
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      let enriched = progressToken
        ? {
            ...(params as any),
            _meta: { ...(params as any)?._meta, progressToken },
          }
        : params;
      if (this.modern)
        enriched = {
          ...(enriched as any),
          _meta: {
            ...(enriched as any)?._meta,
            "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "agent-foundation",
              version: VERSION,
            },
            "io.modelcontextprotocol/clientCapabilities":
              this.clientCapabilities(),
          },
        };
      void this.send(
        { jsonrpc: "2.0", id: requestId, method, params: enriched },
        controller.signal,
      ).catch((e) => {
        const p = this.pending.get(requestId);
        if (p) {
          this.pending.delete(requestId);
          p.cleanup();
          p.reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  }
  async notify(method: string, params?: unknown) {
    await this.send(
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(this.limits.timeout),
      ]),
    );
  }
  private async headers(sse = false) {
    // Shutdown must not initiate a fresh token exchange just to close a legacy session.
    const authorization = this.closed
      ? this.lastAuthorization
      : await this.options.authorization?.();
    if (!this.closed) this.lastAuthorization = authorization;
    return {
      ...this.options.headers,
      ...(authorization ? { Authorization: authorization } : {}),
      "Content-Type": "application/json",
      Accept: sse ? "text/event-stream" : "application/json, text/event-stream",
      ...(this.sessionId ? { "MCP-Session-Id": this.sessionId } : {}),
      ...(this.protocolVersion
        ? { "MCP-Protocol-Version": this.protocolVersion }
        : {}),
    };
  }
  private async send(message: RpcMessage, signal: AbortSignal) {
    signal.throwIfAborted();
    const data = JSON.stringify(message);
    invariant(
      Buffer.byteLength(data) <= this.limits.message,
      "MCP request exceeds limit",
      413,
    );
    if (this.options.transport === "stdio") {
      invariant(this.child?.stdin.writable, "MCP stdin closed", 503);
      await new Promise<void>((resolve, reject) => {
        this.child!.stdin.write(data + "\n", (error) =>
          error ? reject(error) : resolve(),
        );
      });
      return;
    }
    const response = await fetch(this.options.url!, {
      method: "POST",
      headers: {
        ...(await this.headers()),
        ...(this.modern && message.method
          ? { "Mcp-Method": message.method }
          : {}),
        ...(this.modern &&
        [
          "tools/call",
          "resources/read",
          "prompts/get",
          "tasks/get",
          "tasks/update",
          "tasks/cancel",
        ].includes(message.method || "")
          ? {
              "Mcp-Name": mcpHeaderValue(
                message.params?.taskId ??
                  message.params?.name ??
                  message.params?.uri,
              ),
            }
          : {}),
        ...(this.modern && message.method === "tools/call"
          ? parameterHeaders(
              this.toolHeaders.get(message.params?.name) || [],
              message.params?.arguments,
            )
          : {}),
      },
      body: data,
      signal: AbortSignal.any([signal, this.lifetime.signal]),
      redirect: "error",
    });
    if (response.status === 404 && this.sessionId) {
      this.initialized = false;
      void this.fail(
        new MCPProtocolError(
          "MCP session expired. Reconnect before a new operation; never replay an uncertain tool automatically",
          "session_expired",
        ),
      );
      throw new MCPProtocolError("MCP session expired", "session_expired");
    }
    if (!response.ok) {
      const challenge = response.headers.get("www-authenticate");
      if ((response.status === 401 || response.status === 403) && challenge) {
        this.options.onAuthChallenge?.(challenge, response.status);
        await response.body?.cancel();
        throw new MCPProtocolError(
          response.status === 401
            ? "MCP authorization required; authorize then issue a new request"
            : "MCP scope upgrade required; authorize then issue a new request",
          response.status === 401
            ? "authorization_required"
            : "insufficient_scope",
        );
      }
      if (
        (response.headers.get("content-type") || "").includes(
          "application/json",
        )
      ) {
        const value = await readJson(response, this.limits.message);
        if (
          value?.jsonrpc === "2.0" &&
          value.id === message.id &&
          value.error &&
          Number.isInteger(value.error.code)
        )
          throw new MCPProtocolError(
            String(value.error.message),
            value.error.code,
            value.error.data,
          );
      } else await response.body?.cancel();
      throw new MCPProtocolError(`MCP HTTP ${response.status}`);
    }
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession && !this.modern) {
      invariant(
        /^[\x21-\x7e]{1,512}$/.test(returnedSession),
        "Invalid MCP session ID",
        502,
      );
      invariant(
        message.method === "initialize" || returnedSession === this.sessionId,
        "MCP server changed session ID",
        502,
      );
      this.sessionId = returnedSession;
    }
    const expects = message.method !== undefined && message.id !== undefined;
    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      if (expects)
        throw new MCPProtocolError(
          "MCP request accepted without a JSON-RPC result",
        );
      return;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      await this.consume(response, signal, message.id);
      return;
    }
    invariant(
      contentType.includes("application/json"),
      "Unexpected MCP HTTP content type",
      502,
    );
    const parsed = rpc(await readJson(response, this.limits.message));
    if (expects)
      invariant(
        parsed.id === message.id && !parsed.method,
        "MCP response ID mismatch",
        502,
      );
    this.receive(parsed, message.id);
    if (expects)
      invariant(
        parsed.id === message.id || this.pending.has(message.id!) === false,
        "MCP response ID mismatch",
        502,
      );
  }
  private async consume(
    response: Response,
    signal: AbortSignal,
    target?: RpcId,
  ) {
    let cursor: string | undefined,
      retry = 1000,
      attempts = 0,
      current = response;
    while (true) {
      for await (const event of frames(
        current,
        this.limits.message,
        AbortSignal.any([signal, this.lifetime.signal]),
      )) {
        if (event.id !== undefined) cursor = event.id;
        if (event.retry !== undefined) retry = event.retry;
        if (!event.data) continue;
        if (!this.modern && event.id && this.seen.has(event.id)) continue;
        const message = rpc(JSON.parse(event.data));
        if (target !== undefined && !message.method)
          invariant(message.id === target, "MCP response ID mismatch", 502);
        if (event.id && !this.modern) {
          this.seen.add(event.id);
          if (this.seen.size > 2000)
            this.seen.delete(this.seen.values().next().value!);
        }
        this.receive(message, target);
        if (target !== undefined && message.id === target && !message.method)
          return;
      }
      if (target === undefined || !this.pending.has(target)) return;
      invariant(
        !this.modern,
        "MCP stream ended before its response; outcome may be unknown",
        502,
      );
      invariant(
        cursor && ++attempts <= 5,
        "MCP SSE ended before its response; outcome may be unknown",
        502,
      );
      await delay(retry, signal);
      current = await fetch(this.options.url!, {
        headers: { ...(await this.headers(true)), "Last-Event-ID": cursor },
        signal: AbortSignal.any([signal, this.lifetime.signal]),
        redirect: "error",
      });
      invariant(
        current.ok &&
          (current.headers.get("content-type") || "").includes(
            "text/event-stream",
          ),
        "MCP stream resumption failed",
        502,
      );
    }
  }
  private async listen(signal: AbortSignal) {
    let cursor: string | undefined,
      retry = 1000;
    while (!signal.aborted && !this.closed) {
      try {
        const response = await fetch(this.options.url!, {
          headers: {
            ...(await this.headers(true)),
            ...(cursor ? { "Last-Event-ID": cursor } : {}),
          },
          signal: AbortSignal.any([signal, this.lifetime.signal]),
          redirect: "error",
        });
        if (response.status === 405) {
          await response.body?.cancel();
          return;
        }
        invariant(response.ok, "MCP notification stream failed", 502);
        for await (const event of frames(
          response,
          this.limits.message,
          signal,
        )) {
          if (event.id !== undefined) cursor = event.id;
          if (event.retry !== undefined) retry = event.retry;
          if (event.data && (!event.id || !this.seen.has(event.id))) {
            if (event.id) {
              this.seen.add(event.id);
              if (this.seen.size > 2000)
                this.seen.delete(this.seen.values().next().value!);
            }
            this.receive(rpc(JSON.parse(event.data)));
          }
        }
      } catch (e) {
        if (signal.aborted || this.closed) return;
        this.record("transport/error", { message: errorText(e) });
      }
      await delay(Math.max(100, retry), signal);
    }
  }
  private async fail(error: unknown) {
    if (this.closed) return;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error instanceof Error ? error : new Error(String(error)));
      p.controller.abort();
    }
    this.pending.clear();
    // Transport event handlers have no awaiting caller. close() retains the
    // rejected cleanup promise for explicit callers; the notification and
    // onclose error preserve the failure without an unhandled rejection.
    await this.close().catch(() => undefined);
  }
  async close() {
    if (this.closeCompletion) return this.closeCompletion;
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    this.background?.abort();
    this.lifetime.abort();
    this.receiver?.close();
    this.modernTasks.close();
    this.taskContexts.close();
    for (const p of this.pending.values()) {
      p.cleanup();
      p.controller.abort();
      p.reject(
        new MCPProtocolError(
          "MCP connection closed; pending effects may be unknown",
        ),
      );
    }
    this.pending.clear();
    this.closeCompletion = (async () => {
      let cleanupFailure: unknown;
      if (this.child) await terminateProcessTree(this.child);
      await this.options.cleanup?.().catch((error) => {
        cleanupFailure = error;
        this.record("transport/cleanup_error", { message: errorText(error) });
      });
      if (this.options.transport === "http" && this.sessionId && !this.modern) {
        await fetch(this.options.url!, {
          method: "DELETE",
          headers: await this.headers(),
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        })
          .then((r) => r.body?.cancel())
          .catch(() => undefined);
      }
      const error = cleanupFailure
        ? new MCPProtocolError(
            "MCP execution cleanup unconfirmed: " + errorText(cleanupFailure),
            "isolation_cleanup_failed",
          )
        : undefined;
      this.onclose?.(error);
      this.lastAuthorization = undefined;
      if (error) throw error;
    })();
    return this.closeCompletion;
  }
  listTools(params?: { cursor?: string }, options?: { signal?: AbortSignal }) {
    return this.request("tools/list", params || {}, options).then((r) => {
      invariant(
        Array.isArray(r?.tools) &&
          r.tools.every(
            (t: any) =>
              typeof t.name === "string" &&
              t.inputSchema &&
              typeof t.inputSchema === "object",
          ),
        "Invalid MCP tool list",
        502,
      );
      r.tools = r.tools.filter((tool: any) => {
        try {
          if (!tool.inputSchema.$schema)
            tool.inputSchema = {
              ...tool.inputSchema,
              $schema: "https://json-schema.org/draft/2020-12/schema",
            };
          const input = compileSchema(tool.inputSchema),
            output = tool.outputSchema
              ? compileSchema({
                  ...tool.outputSchema,
                  $schema:
                    tool.outputSchema.$schema ||
                    "https://json-schema.org/draft/2020-12/schema",
                })
              : undefined;
          this.toolSchemas.set(tool.name, { input, output });
          if (this.options.transport === "http" && this.modern)
            this.toolHeaders.set(tool.name, headerBindings(tool.inputSchema));
          return true;
        } catch (error) {
          this.record("tools/rejected", {
            name: tool.name,
            reason: errorText(error),
          });
          return false;
        }
      });
      return r;
    });
  }
  callTool(
    params: { name: string; arguments: any },
    options?: MCPRequestOptions,
  ) {
    const schema = this.toolSchemas.get(params.name);
    if (schema)
      invariant(
        schema.input(params.arguments),
        "MCP tool input violates its catalog schema",
      );
    const deadline = Date.now() + (options?.timeout || this.limits.timeout);
    return this.request("tools/call", params, {
      ...options,
      taskDeadline: deadline,
    }).then(async (r) => {
      if (this.modern && r.resultType === "task")
        r = await this.waitModernTask(r.taskId, options);
      return this.validateToolResult(params.name, r);
    });
  }
  validateToolResult(name: string, r: any) {
    const schema = this.toolSchemas.get(name);
    invariant(
      r &&
        typeof r === "object" &&
        (Array.isArray(r.content) || r.structuredContent !== undefined),
      "Invalid MCP tool result",
      502,
    );
    if (!r.isError && schema?.output)
      invariant(
        r.structuredContent !== undefined && schema.output(r.structuredContent),
        "MCP tool structured output violates its catalog schema",
        502,
      );
    return {
      ...r,
      content: r.content || [
        { type: "text", text: JSON.stringify(r.structuredContent) },
      ],
    };
  }
  listResources(params?: { cursor?: string }) {
    return this.request("resources/list", params || {});
  }
  listResourceTemplates(params?: { cursor?: string }) {
    return this.request("resources/templates/list", params || {});
  }
  readResource(params: { uri: string }, options?: { signal?: AbortSignal }) {
    return this.request("resources/read", params, options);
  }
  listPrompts(params?: { cursor?: string }) {
    return this.request("prompts/list", params || {});
  }
  getPrompt(
    params: { name: string; arguments?: Record<string, string> },
    options?: { signal?: AbortSignal },
  ) {
    return this.request("prompts/get", params, options);
  }
  ping(signal?: AbortSignal) {
    return this.request("ping", {}, { signal });
  }
  completeArgument(
    params: {
      ref:
        | { type: "ref/prompt"; name: string }
        | { type: "ref/resource"; uri: string };
      argument: { name: string; value: string };
      context?: { arguments: Record<string, string> };
    },
    signal?: AbortSignal,
  ) {
    invariant(
      this.capabilities.completions,
      "MCP completion capability is unavailable",
      400,
    );
    return this.request("completion/complete", params, { signal }).then(
      (result) => {
        invariant(
          Array.isArray(result?.completion?.values) &&
            result.completion.values.length <= 100 &&
            result.completion.values.every((v: any) => typeof v === "string"),
          "Invalid MCP completion result",
          502,
        );
        return result;
      },
    );
  }
  setLoggingLevel(
    level:
      | "debug"
      | "info"
      | "notice"
      | "warning"
      | "error"
      | "critical"
      | "alert"
      | "emergency",
    signal?: AbortSignal,
  ) {
    invariant(
      this.capabilities.logging,
      "MCP logging capability is unavailable",
      400,
    );
    return this.request("logging/setLevel", { level }, { signal });
  }
  async setRootsChanged() {
    invariant(
      this.options.handlers?.["roots/list"],
      "Roots capability is disabled",
      403,
    );
    if (!this.modern) await this.notify("notifications/roots/list_changed");
  }
  subscribeResource(uri: string, signal?: AbortSignal) {
    invariant(
      !this.modern && this.capabilities.resources?.subscribe,
      "Legacy resource subscription unsupported",
      400,
    );
    return this.request("resources/subscribe", { uri }, { signal });
  }
  unsubscribeResource(uri: string, signal?: AbortSignal) {
    invariant(
      !this.modern && this.capabilities.resources?.subscribe,
      "Legacy resource subscription unsupported",
      400,
    );
    return this.request("resources/unsubscribe", { uri }, { signal });
  }
  listenNotifications(filter: MCPNotificationFilter, signal?: AbortSignal) {
    invariant(this.modern, "Subscription streams require modern MCP", 400);
    invariant(
      Object.keys(filter).every((k) =>
        [
          "toolsListChanged",
          "promptsListChanged",
          "resourcesListChanged",
          "resourceSubscriptions",
          "taskIds",
        ].includes(k),
      ),
      "Invalid subscription filter",
    );
    if (filter.taskIds)
      invariant(
        this.options.taskExtension &&
          this.capabilities.extensions?.[TASKS_EXTENSION] &&
          filter.taskIds.length <= 100 &&
          filter.taskIds.every(
            (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
          ),
        "Invalid or unnegotiated task subscriptions",
      );
    invariant(
      !filter.resourceSubscriptions ||
        (filter.resourceSubscriptions.length <= 100 &&
          filter.resourceSubscriptions.every(
            (v) => typeof v === "string" && v.length <= 8192,
          )),
      "Invalid resource subscriptions",
    );
    const controller = new AbortController();
    let readyResolve!: (filter: MCPNotificationFilter) => void,
      readyReject!: (error: unknown) => void;
    const ready = new Promise<MCPNotificationFilter>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const ackTimeout = setTimeout(() => {
      readyReject(new Error("MCP subscription acknowledgement timed out"));
      controller.abort();
    }, this.limits.timeout);
    const completion = this.request(
      "subscriptions/listen",
      { notifications: filter },
      {
        signal: AbortSignal.any([
          controller.signal,
          ...(signal ? [signal] : []),
        ]),
        timeout: 24 * 60 * 60 * 1000,
        onSubscriptionAcknowledged: (actual) => {
          clearTimeout(ackTimeout);
          readyResolve(actual);
        },
      },
    );
    completion.then(
      () => {
        clearTimeout(ackTimeout);
        readyReject(
          new Error("MCP subscription closed before acknowledgement"),
        );
      },
      (error) => {
        clearTimeout(ackTimeout);
        readyReject(error);
      },
    );
    // Keep a handled branch even when callers only await readiness.
    void completion.catch(() => undefined);
    void ready.catch(() => undefined);
    return { ready, completion, close: () => controller.abort() };
  }
  createToolTask(
    params: { name: string; arguments: any },
    options?: MCPRequestOptions & { ttl?: number },
  ) {
    invariant(
      !this.modern && this.capabilities.tasks?.requests?.tools?.call,
      "Server does not support legacy tool tasks",
      400,
    );
    return this.request(
      "tools/call",
      { ...params, task: { ttl: options?.ttl ?? 60000 } },
      options,
    ).then((result) => {
      invariant(
        typeof result?.task?.taskId === "string" &&
          result.task.taskId.length > 0,
        "Invalid MCP task creation",
        502,
      );
      return result.task;
    });
  }
  releaseTaskContext(taskId: string) {
    this.taskContexts.release(taskId);
  }
  private modernTaskResult(task: any) {
    if (task.status === "failed")
      throw new MCPProtocolError(
        task.error.message,
        task.error.code,
        task.error.data,
      );
    if (task.status === "cancelled")
      throw new MCPProtocolError(
        "Remote modern task was cancelled",
        "cancelled",
      );
    invariant(
      task.status === "completed" && task.result,
      "Modern task is not completed",
      409,
    );
    return task.result;
  }
  private async waitModernTask(taskId: string, options?: MCPRequestOptions) {
    const entry = this.modernTasks.get(taskId);
    invariant(entry, "Modern task origin is missing", 403);
    const remaining = () => {
      const time =
        entry.task.ttlMs === null
          ? entry.deadline
          : Math.min(
              entry.deadline,
              Date.parse(entry.task.createdAt) + entry.task.ttlMs,
            );
      invariant(time > Date.now(), "Modern task deadline or TTL exceeded", 504);
      return Math.max(1, time - Date.now());
    };
    try {
      main: while (true) {
        const signal = AbortSignal.any([
          this.lifetime.signal,
          entry.controller.signal,
          AbortSignal.timeout(remaining()),
          ...(options?.signal ? [options.signal] : []),
        ]);
        signal.throwIfAborted();
        const task = await this.taskGet(taskId, signal, remaining());
        if (taskTerminal(task.status)) {
          const result = this.modernTaskResult(task);
          try {
            return this.validateToolResult(entry.context.params.name, result);
          } catch (error) {
            this.modernTasks.unknown(taskId, errorText(error));
            throw error;
          }
        }
        if (task.status === "input_required") {
          const responses: Record<string, unknown> = Object.create(null),
            inputController = new AbortController();
          entry.inputController = inputController;
          try {
            for (const [key, request] of Object.entries(
              task.inputRequests!,
            ) as [string, any][]) {
              invariant(
                key.length > 0 &&
                  key.length <= 512 &&
                  request &&
                  typeof request.method === "string" &&
                  request.params &&
                  typeof request.params === "object" &&
                  !Array.isArray(request.params),
                "Invalid modern task input request",
                502,
              );
              invariant(
                request.params.task === undefined,
                "Modern extension does not support task-augmented client input",
                502,
              );
              const fingerprint = taskFingerprint(request),
                known = entry.inputs.get(key);
              if (known) {
                invariant(
                  known.fingerprint === fingerprint,
                  "Modern task reused an input key with different content",
                  502,
                );
                continue;
              }
              if (!Object.keys(responses).length)
                invariant(
                  entry.rounds < (this.options.maxInputRounds || 8),
                  "Modern task input round limit exceeded",
                  502,
                );
              invariant(
                entry.inputs.size < 128,
                "Modern task input capacity exceeded",
                429,
              );
              entry.inputs.set(key, { fingerprint, answered: false });
              const value = await this.handleInput(
                request.method,
                request.params,
                {
                  ...entry.context,
                  requestId: key,
                  signal: AbortSignal.any([signal, inputController.signal]),
                },
              );
              signal.throwIfAborted();
              inputController.signal.throwIfAborted();
              responses[key] = value;
            }
          } catch (e) {
            if (
              taskTerminal(entry.task.status) &&
              !entry.controller.signal.aborted &&
              !this.lifetime.signal.aborted
            )
              continue main;
            throw e;
          } finally {
            entry.inputController = undefined;
          }
          if (Object.keys(responses).length) {
            entry.rounds++;
            await this.taskUpdate(taskId, responses, signal, remaining());
            for (const key of Object.keys(responses))
              entry.inputs.get(key)!.answered = true;
          }
        }
        await delay(Math.min(task.pollIntervalMs ?? 100, remaining()), signal);
      }
    } catch (e) {
      const expired =
        Date.now() >=
        (entry.task.ttlMs === null
          ? entry.deadline
          : Math.min(
              entry.deadline,
              Date.parse(entry.task.createdAt) + entry.task.ttlMs,
            ));
      const failure =
        expired && !options?.signal?.aborted
          ? new MCPProtocolError(
              "Modern task deadline or TTL exceeded",
              "timeout",
            )
          : e;
      if (!entry.finalValidated) {
        const cancel =
          expired ||
          options?.signal?.aborted ||
          entry.controller.signal.aborted ||
          /deadline|TTL|timed out/i.test(errorText(e));
        this.modernTasks.unknown(taskId, errorText(failure));
        if (cancel)
          await this.taskCancel(taskId, undefined, 1500).catch(() => undefined);
      }
      throw failure;
    } finally {
      this.modernTasks.release(taskId);
    }
  }
  taskUpdate(
    taskId: string,
    inputResponses: Record<string, unknown>,
    signal?: AbortSignal,
    timeout?: number,
  ) {
    invariant(
      this.modern &&
        this.options.taskExtension &&
        this.capabilities.extensions?.[TASKS_EXTENSION],
      "Modern task extension is not negotiated",
      400,
    );
    invariant(
      inputResponses &&
        typeof inputResponses === "object" &&
        !Array.isArray(inputResponses) &&
        Object.keys(inputResponses).length > 0 &&
        Object.keys(inputResponses).length <= 16,
      "Invalid task input responses",
    );
    return this.request(
      "tasks/update",
      { taskId, inputResponses },
      { signal, timeout },
    ).then((r) => {
      invariant(
        r?.resultType === "complete",
        "Invalid modern task update acknowledgement",
        502,
      );
      return r;
    });
  }
  taskGet(taskId: string, signal?: AbortSignal, timeout?: number) {
    if (this.modern)
      invariant(
        this.options.taskExtension &&
          this.capabilities.extensions?.[TASKS_EXTENSION],
        "Modern task extension is not negotiated",
        400,
      );
    return this.request("tasks/get", { taskId }, { signal, timeout });
  }
  taskResult(taskId: string, signal?: AbortSignal, timeout?: number) {
    if (this.modern)
      return this.taskGet(taskId, signal, timeout).then((task) =>
        this.modernTaskResult(task),
      );
    return this.request("tasks/result", { taskId }, { signal, timeout });
  }
  taskCancel(taskId: string, signal?: AbortSignal, timeout?: number) {
    if (this.modern) {
      invariant(
        this.options.taskExtension &&
          this.capabilities.extensions?.[TASKS_EXTENSION],
        "Modern task extension is not negotiated",
        400,
      );
      this.modernTasks.unknown(
        taskId,
        "Cancellation requested; remote cancellation is not confirmed",
      );
      return this.request("tasks/cancel", { taskId }, { signal, timeout }).then(
        (r) => {
          invariant(
            r?.resultType === "complete",
            "Invalid modern task cancel acknowledgement",
            502,
          );
          return r;
        },
      );
    }
    return this.request("tasks/cancel", { taskId }, { signal, timeout });
  }
  taskList(cursor?: string, signal?: AbortSignal) {
    invariant(
      !this.modern,
      "Modern task extension has no remote task enumeration",
      400,
    );
    return this.request("tasks/list", cursor ? { cursor } : {}, { signal });
  }
}
