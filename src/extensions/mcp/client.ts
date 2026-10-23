import { VERSION } from "../../version.js";
import { invariant, errorText } from "../../core/util.js";
import { MCPStdioTransport } from "./client/stdio.js";
import { MCPHttpTransport } from "./client/http.js";
import {
  MCPToolCatalog,
  type MCPToolOutputValidator,
} from "./client/tool-catalog.js";
import { collectCatalog } from "./catalog.js";
import type { HeaderBinding } from "./headers.js";
import { MCPClientInput } from "./client/input.js";
import {
  modernTaskResult,
  waitModernTask,
} from "./client/modern-task-runner.js";
import { MCPClientRequests } from "./client/requests.js";
import {
  listenNotifications,
  receiveSubscription,
  subscriptionMethods,
} from "./client/subscriptions.js";
import {
  MCPTaskContexts,
  taskMetadata,
  validateTask,
} from "./tasks/context.js";
import { MCPTaskReceiver, type MCPReceiverOptions } from "./tasks/receiver.js";
import {
  ModernMCPTasks,
  TASKS_EXTENSION,
  type ModernTask,
  type ModernTaskEvent,
} from "./tasks/modern.js";

import {
  MCP_MODERN_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCPProtocolError,
  type MCPNotificationFilter,
  type MCPRequestOptions,
  type MCPInputHandler,
  isProtocolVersion,
  isProtocolVersionList,
  isRpcId,
  wireMember,
  wireObject,
  type MCPServerCapabilities,
  type MCPToolResult,
  type RpcId,
  type RpcMessage,
  type WireObject,
} from "./protocol.js";
export {
  MCP_MODERN_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCPProtocolError,
  type MCPInputHandler,
  type MCPNotificationFilter,
  type MCPRequestContext,
  type MCPRequestOptions,
  type MCPToolDeclaration as MCPTool,
} from "./protocol.js";

interface MCPCatalogOptions {
  signal?: AbortSignal;
  validate?: () => void;
}

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
/** Foundation-maintained MCP client. Node streams/fetch only; no MCP or agent SDK. */
export class MCPClient {
  private receiver?: MCPTaskReceiver;
  private modernTasks: ModernMCPTasks;
  private taskContexts = new MCPTaskContexts();
  onclose?: (cleanupError?: Error) => void;
  onnotification?: (method: string, params: unknown) => void;
  protocolVersion = "";
  serverInfo: Record<string, unknown> = {};
  capabilities: MCPServerCapabilities = {};
  private stdio: MCPStdioTransport;
  private http: MCPHttpTransport;
  private catalog: MCPToolCatalog;
  private input: MCPClientInput;
  private initialized = false;
  private closed = false;
  private lifetime = new AbortController();
  private background?: AbortController;
  private requests: MCPClientRequests;
  private closeCompletion?: Promise<void>;
  private modern = false;
  private catalogRevision = 0;
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
    this.catalog = new MCPToolCatalog((method, params) =>
      this.record(method, params),
    );
    this.stdio = new MCPStdioTransport(options, this.limits, {
      receive: (message) => this.receive(message),
      fail: (error) => this.fail(error),
      closed: () => this.closed,
    });
    this.http = new MCPHttpTransport(options, this.limits, {
      signal: this.lifetime.signal,
      closed: () => this.closed,
      modern: () => this.modern,
      protocolVersion: () => this.protocolVersion,
      receive: (message, parentId) => this.receive(message, parentId),
      hasPending: (id) => this.requests.pending.has(id),
      sessionExpired: (error) => {
        this.initialized = false;
        void this.fail(error);
      },
      record: (method, params) => this.record(method, params),
    });
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
    this.requests = new MCPClientRequests(options, this.limits, {
      signal: this.lifetime.signal,
      modern: () => this.modern,
      closed: () => this.closed,
      initialized: () => this.initialized,
      clientCapabilities: () => this.clientCapabilities(),
      toolHeaders: (name) => this.catalog.headers(name),
      send: (message, signal, toolHeaders) =>
        this.send(message, signal, toolHeaders),
      notify: (method, params) => this.notify(method, params),
      handleInput: (method, params, context) =>
        this.input.handleInput(method, params, context),
    });
    this.input = new MCPClientInput({
      pending: this.requests.pending,
      taskContexts: this.taskContexts,
      signal: this.lifetime.signal,
      timeout: this.limits.timeout,
      receiver: this.receiver,
      handlers: options.handlers,
      protocolVersion: () => this.protocolVersion,
      closed: () => this.closed,
      fail: (error) => this.fail(error),
      send: (message, signal) => this.send(message, signal),
    });
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
      if (this.options.transport === "stdio") await this.stdio.start();
      if (
        this.options.protocol === "modern" ||
        this.options.protocol === "auto"
      ) {
        this.modern = true;
        this.protocolVersion = MCP_MODERN_VERSION;
        try {
          const discovered = await this.requests.requestOnce(
            "server/discover",
            {},
            undefined,
            true,
          );
          const versions = wireMember(discovered, "supportedVersions"),
            capabilities = wireMember(discovered, "capabilities");
          invariant(
            Array.isArray(versions) &&
              versions.includes(MCP_MODERN_VERSION) &&
              capabilities &&
              typeof capabilities === "object",
            "Invalid MCP discovery",
            502,
          );
          this.capabilities = capabilities as MCPServerCapabilities;
          this.serverInfo =
            wireObject(
              wireMember(
                discovered,
                "_meta",
                "io.modelcontextprotocol/serverInfo",
              ),
            ) || {};
          this.initialized = true;
          return;
        } catch (error) {
          const legacyFallback =
            error instanceof MCPProtocolError &&
            (error.code === -32601 ||
              (error.code === -32022 &&
                isProtocolVersionList(
                  wireMember(error.data, "supportedVersions"),
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
      const version = result.protocolVersion,
        capabilities = result.capabilities,
        serverInfo = result.serverInfo as WireObject | undefined;
      invariant(
        isProtocolVersion(version) &&
          capabilities &&
          typeof capabilities === "object" &&
          typeof wireMember(serverInfo, "name") === "string",
        "Invalid or unsupported MCP initialization",
        502,
      );
      invariant(
        this.options.transport !== "http" || version !== "2024-11-05",
        "Legacy HTTP+SSE transport is not enabled",
        502,
      );
      this.protocolVersion = version;
      this.capabilities = capabilities as MCPServerCapabilities;
      // A non-null object with a string name, as checked above.
      this.serverInfo = serverInfo!;
      await this.notify("notifications/initialized");
      this.initialized = true;
      if (this.options.transport === "http") {
        this.background = new AbortController();
        void this.http.listen(this.background.signal).catch((e) => {
          if (!this.closed && !this.background?.signal.aborted)
            this.record("transport/error", { message: errorText(e) });
        });
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private record(method: string, params: unknown) {
    if (method === "notifications/tools/list_changed") this.catalogRevision++;
    this.messages.push({ method, params, timestamp: new Date().toISOString() });
    if (this.messages.length > 100) this.messages.shift();
    this.onnotification?.(method, params);
  }
  private receive(message: RpcMessage, parentId?: RpcId) {
    if (this.closed) return;
    if (message.method) {
      const params: WireObject = wireObject(message.params) ?? {};
      if (message.id !== undefined) {
        if (this.modern) {
          void this.fail(
            new MCPProtocolError(
              "Modern MCP servers cannot initiate JSON-RPC requests",
            ),
          );
          return;
        }
        void this.input
          .receive(message, parentId)
          .catch((error) =>
            this.record("transport/error", { message: errorText(error) }),
          );
        return;
      }
      if (
        message.method === "notifications/cancelled" &&
        isRpcId(params.requestId)
      )
        this.input.cancel(params.requestId);
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
      if (this.modern && subscriptionMethods.includes(message.method)) {
        try {
          receiveSubscription(
            message.method,
            params,
            this.requests.pending,
            this.modernTasks,
            this.tasksNegotiated(),
          );
        } catch (error) {
          this.record("subscriptions/rejected", { message: errorText(error) });
          return;
        }
      }
      if (message.method === "notifications/progress") {
        try {
          const taskId = taskMetadata(params);
          if (taskId) this.taskContexts.progress(taskId, params);
        } catch {
          return;
        }
        if (typeof params.progressToken === "string")
          this.requests.progressRequests
            .get(params.progressToken)
            ?.progress?.(params);
      }
      this.record(message.method, message.params);
      return;
    }
    const p = this.requests.pending.get(message.id!);
    if (!p) return;
    // Task methods are only sent by this client, always with a string taskId.
    const requestedTask =
      typeof p.context.params.taskId === "string"
        ? p.context.params.taskId
        : undefined;
    if (!message.error) {
      try {
        if (p.taskOptions)
          this.taskContexts.create(
            wireMember(message.result, "task"),
            p.context,
            p.taskOptions,
          );
        if (
          !this.modern &&
          ["tasks/get", "tasks/cancel"].includes(p.context.method)
        ) {
          validateTask(message.result, requestedTask);
          this.taskContexts.observe(message.result);
        }
        if (!this.modern && p.context.method === "tasks/result") {
          invariant(
            requestedTask !== undefined &&
              taskMetadata(message.result) === requestedTask,
            "MCP task result has missing or mismatched related-task metadata",
            502,
          );
          this.taskContexts.release(requestedTask);
        }
        if (
          this.modern &&
          wireMember(message.result, "resultType") === "task"
        ) {
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
            wireMember(message.result, "resultType") === "complete",
            "Modern tasks/get requires a complete result",
            502,
          );
          message.result = {
            ...this.modernTasks.update(message.result, requestedTask),
            resultType: "complete",
          };
        }
      } catch (error) {
        if (p.context.method === "tasks/result" && requestedTask)
          this.taskContexts.release(requestedTask);
        this.requests
          .take(message.id!)
          ?.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    this.requests.take(
      message.id!,
      new Error("Originating MCP request completed"),
    );
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
  request(
    method: string,
    params: WireObject = {},
    options?: MCPRequestOptions,
    initializing = false,
  ): Promise<WireObject> {
    return this.requests.request(method, params, options, initializing);
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
  private async send(
    message: RpcMessage,
    signal: AbortSignal,
    toolHeaders?: HeaderBinding[],
  ): Promise<void> {
    signal.throwIfAborted();
    const data = JSON.stringify(message);
    invariant(
      Buffer.byteLength(data) <= this.limits.message,
      "MCP request exceeds limit",
      413,
    );
    if (this.options.transport === "stdio") await this.stdio.send(data);
    else await this.http.send(message, data, signal, toolHeaders);
  }
  private async fail(error: unknown) {
    if (this.closed) return;
    this.requests.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
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
    this.catalog.clear();
    this.requests.reject(
      new MCPProtocolError(
        "MCP connection closed; pending effects may be unknown",
      ),
    );
    this.closeCompletion = (async () => {
      let cleanupFailure: unknown;
      await this.stdio.close();
      await this.options.cleanup?.().catch((error) => {
        cleanupFailure = error;
        this.record("transport/cleanup_error", { message: errorText(error) });
      });
      if (this.options.transport === "http") await this.http.close();
      const error = cleanupFailure
        ? new MCPProtocolError(
            "MCP execution cleanup unconfirmed: " + errorText(cleanupFailure),
            "isolation_cleanup_failed",
          )
        : undefined;
      this.onclose?.(error);
      this.http.clearAuthorization();
      if (error) throw error;
    })();
    return this.closeCompletion;
  }
  private async toolPage(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ) {
    return this.catalog.prepare(
      await this.request("tools/list", params || {}, options),
      this.options.transport === "http" && this.modern,
    );
  }
  async listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ) {
    const revision = this.catalogRevision;
    const { page, metadata } = await this.toolPage(params, options);
    this.validateCatalog(revision, options);
    // One-page lists replace stale entries; paged callers register each page.
    if (!params?.cursor && !page.nextCursor) this.catalog.replace(metadata);
    else this.catalog.append(metadata);
    return page;
  }
  private validateCatalog(revision: number, options?: MCPCatalogOptions) {
    options?.signal?.throwIfAborted();
    invariant(
      this.connected && revision === this.catalogRevision,
      "MCP catalog changed during listing; resolve again",
      409,
    );
    options?.validate?.();
  }
  /** Publish a complete catalog's schemas and headers together after validation. */
  async toolCatalog(options?: MCPCatalogOptions) {
    const revision = this.catalogRevision;
    const metadata: ReturnType<MCPToolCatalog["prepare"]>["metadata"] =
      new Map();
    const tools = await collectCatalog(
      async (cursor) => {
        const current = await this.toolPage({ cursor }, options);
        for (const [name, entry] of current.metadata) metadata.set(name, entry);
        return {
          items: current.page.tools,
          nextCursor: current.page.nextCursor,
        };
      },
      () => this.validateCatalog(revision, options),
    );
    this.validateCatalog(revision, options);
    this.catalog.replace(metadata);
    return { tools };
  }
  callTool(
    params: { name: string; arguments: unknown },
    options?: MCPRequestOptions,
  ) {
    this.catalog.validateInput(params.name, params.arguments);
    const output = this.toolOutputValidator(params.name);
    const deadline = Date.now() + (options?.timeout || this.limits.timeout);
    return this.request("tools/call", params, {
      ...options,
      taskDeadline: deadline,
    }).then(async (r) => {
      if (this.modern && r.resultType === "task") {
        // receive() validated the task before resolving this request.
        invariant(typeof r.taskId === "string", "Invalid MCP task", 502);
        return this.validateToolResult(
          params.name,
          await waitModernTask(
            r.taskId,
            {
              tasks: this.modernTasks,
              signal: this.lifetime.signal,
              maxInputRounds: this.options.maxInputRounds,
              get: (taskId, signal, timeout) =>
                this.modernTaskGet(taskId, signal, timeout),
              update: (taskId, responses, signal, timeout) =>
                this.taskUpdate(taskId, responses, signal, timeout),
              cancel: (taskId, signal, timeout) =>
                this.taskCancel(taskId, signal, timeout),
              handleInput: (method, params, context) =>
                this.input.handleInput(method, params, context),
              validateResult: (name, value) =>
                this.validateToolResult(name, value, output),
            },
            options,
          ),
          output,
        );
      }
      return this.validateToolResult(params.name, r, output);
    });
  }
  /** Capture the output contract before starting immediate or deferred work. */
  toolOutputValidator(name: string): MCPToolOutputValidator {
    return this.catalog.outputValidator(name);
  }
  validateToolResult(
    name: string,
    value: unknown,
    output: MCPToolOutputValidator = this.toolOutputValidator(name),
  ): MCPToolResult {
    return this.catalog.validateResult(name, value, output);
  }
  listResources(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ) {
    return this.request("resources/list", params || {}, options);
  }
  listResourceTemplates(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ) {
    return this.request("resources/templates/list", params || {}, options);
  }
  readResource(params: { uri: string }, options?: { signal?: AbortSignal }) {
    return this.request("resources/read", params, options);
  }
  listPrompts(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ) {
    return this.request("prompts/list", params || {}, options);
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
        const values = wireMember(result, "completion", "values");
        invariant(
          Array.isArray(values) &&
            values.length <= 100 &&
            values.every((v) => typeof v === "string"),
          "Invalid MCP completion result",
          502,
        );
        return {
          ...result,
          completion: { ...wireObject(result.completion), values },
        };
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
  private tasksNegotiated(): boolean {
    return Boolean(
      this.options.taskExtension &&
      this.capabilities.extensions?.[TASKS_EXTENSION],
    );
  }
  listenNotifications(filter: MCPNotificationFilter, signal?: AbortSignal) {
    return listenNotifications(
      filter,
      {
        modern: this.modern,
        taskNegotiated: this.tasksNegotiated(),
        timeout: this.limits.timeout,
        request: (method, params, options) =>
          this.request(method, params, options),
      },
      signal,
    );
  }
  createToolTask(
    params: { name: string; arguments: unknown },
    options?: MCPRequestOptions & { ttl?: number },
  ): Promise<WireObject & { taskId: string }> {
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
      const task = wireObject(result.task);
      invariant(
        typeof task?.taskId === "string" && task.taskId.length > 0,
        "Invalid MCP task creation",
        502,
      );
      return { ...task, taskId: task.taskId };
    });
  }
  releaseTaskContext(taskId: string) {
    this.taskContexts.release(taskId);
  }
  /** tasks/get in modern mode; receive() already replaced the result with the validated task. */
  private async modernTaskGet(
    taskId: string,
    signal?: AbortSignal,
    timeout?: number,
  ) {
    return (await this.taskGet(taskId, signal, timeout)) as ModernTask;
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
      return this.modernTaskGet(taskId, signal, timeout).then((task) =>
        modernTaskResult(task),
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
