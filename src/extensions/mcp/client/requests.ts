import { randomUUID } from "node:crypto";
import { VERSION } from "../../../version.js";
import { invariant } from "../../../core/util.js";
import {
  MCP_MODERN_VERSION,
  MCPProtocolError,
  wireObject,
  wireMember,
  type MCPNotificationFilter,
  type MCPRequestContext,
  type MCPRequestOptions,
  type RpcId,
  type RpcMessage,
  type WireObject,
} from "../protocol.js";
import type { MCPClientOptions } from "../client.js";
import type { HeaderBinding } from "../headers.js";

export interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  controller: AbortController;
  progressToken?: string;
  progress?: (value: WireObject) => void;
  context: MCPRequestContext;
  taskOptions?: {
    signal?: AbortSignal;
    deadline: number;
    progress?: (value: WireObject) => void;
    progressToken?: string;
  };
  modernTaskOptions?: { signal?: AbortSignal; deadline: number };
  subscription?: {
    filter: MCPNotificationFilter;
    acknowledged?: MCPNotificationFilter;
    onAck?: (filter: MCPNotificationFilter) => void;
  };
}

interface RequestHost {
  signal: AbortSignal;
  modern: () => boolean;
  closed: () => boolean;
  initialized: () => boolean;
  clientCapabilities: () => WireObject;
  toolHeaders: (name: string) => HeaderBinding[] | undefined;
  send: (
    message: RpcMessage,
    signal: AbortSignal,
    toolHeaders?: HeaderBinding[],
  ) => Promise<void>;
  notify: (method: string, params: unknown) => Promise<void>;
  handleInput: (
    method: string,
    params: unknown,
    context: MCPRequestContext,
  ) => Promise<unknown>;
}
/** Owns pending RPC deadlines, abort listeners, progress correlation and MRTR rounds. */
export class MCPClientRequests {
  readonly pending = new Map<RpcId, Pending>();
  readonly progressRequests = new Map<string, Pending>();
  private nextId = 0;
  constructor(
    private options: MCPClientOptions,
    private limits: { timeout: number },
    private host: RequestHost,
  ) {}
  take(requestId: RpcId, reason?: Error): Pending | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.progressToken)
      this.progressRequests.delete(pending.progressToken);
    pending.cleanup();
    pending.controller.abort(reason);
    return pending;
  }
  reject(error: Error): void {
    for (const requestId of this.pending.keys())
      this.take(requestId, error)?.reject(error);
  }
  async request(
    method: string,
    params: WireObject = {},
    options?: MCPRequestOptions,
    initializing = false,
  ): Promise<WireObject> {
    const deadline = Date.now() + (options?.timeout || this.limits.timeout),
      seen = new Set<string>();
    // All rounds of this request use the bindings present when it started.
    const toolHeaders =
      method === "tools/call" && typeof params.name === "string"
        ? this.host.toolHeaders(params.name)
        : undefined;
    let current = params;
    for (let round = 0; round <= (this.options.maxInputRounds || 8); round++) {
      options?.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      invariant(remaining > 0, "MCP multi-round request timed out", 504);
      const result = wireObject(
        await this.requestOnce(
          method,
          current,
          { ...options, timeout: remaining },
          initializing,
          toolHeaders,
        ),
      );
      // Every MCP result is a JSON object; anything else is a broken peer.
      invariant(result, "Invalid MCP result", 502);
      if (!this.host.modern()) return result;
      invariant(
        !result.resultType ||
          ["complete", "input_required", "task"].some(
            (type) => type === result.resultType,
          ),
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
      const inputRequests = wireObject(result.inputRequests);
      invariant(
        inputRequests || typeof result.requestState === "string",
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
      const requests = Object.entries(inputRequests || {});
      invariant(requests.length <= 16, "Too many input requests", 502);
      const signal = AbortSignal.any([
        this.host.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ...(options?.signal ? [options.signal] : []),
      ]);
      for (const [key, value] of requests) {
        invariant(key && !seen.has(key), "Duplicate MCP input request ID", 502);
        seen.add(key);
        const embeddedMethod = wireMember(value, "method");
        invariant(
          typeof embeddedMethod === "string",
          "Invalid embedded input request",
          502,
        );
        inputResponses[key] = await this.host.handleInput(
          embeddedMethod,
          wireMember(value, "params") || {},
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
    // The last round either returned or failed its round-limit check.
    invariant(false, "MCP input round limit exceeded", 502);
  }
  async requestOnce(
    method: string,
    params: WireObject = {},
    options?: MCPRequestOptions,
    initializing = false,
    toolHeaders?: HeaderBinding[],
  ): Promise<unknown> {
    invariant(
      !this.host.closed() && (this.host.initialized() || initializing),
      "MCP connection is not initialized",
      503,
    );
    options?.signal?.throwIfAborted();
    const requestId = ++this.nextId,
      controller = new AbortController(),
      progressToken = options?.progress ? randomUUID() : undefined;
    return new Promise((resolve, reject) => {
      const abort = (reason: Error) => {
        const p = this.take(requestId, reason);
        if (!p) return;
        p.reject(reason);
        if (
          !initializing &&
          (!this.host.modern() || this.options.transport === "stdio")
        )
          void this.host
            .notify("notifications/cancelled", {
              requestId,
              reason: reason.message,
            })
            .catch(() => undefined);
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
      const pending: Pending = {
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
        ...(method === "tools/call" && params.task
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
        ...(this.host.modern() &&
        method === "tools/call" &&
        this.options.taskExtension
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
                // Callers build this filter; it is not peer data.
                filter: params.notifications as MCPNotificationFilter,
                onAck: options?.onSubscriptionAcknowledged,
              },
            }
          : {}),
        cleanup: () => {
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.set(requestId, pending);
      if (progressToken) this.progressRequests.set(progressToken, pending);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      let enriched = progressToken
        ? {
            ...params,
            _meta: { ...wireObject(params._meta), progressToken },
          }
        : params;
      if (this.host.modern())
        enriched = {
          ...enriched,
          _meta: {
            ...wireObject(enriched._meta),
            "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "agent-foundation",
              version: VERSION,
            },
            "io.modelcontextprotocol/clientCapabilities":
              this.host.clientCapabilities(),
          },
        };
      void this.host
        .send(
          { jsonrpc: "2.0", id: requestId, method, params: enriched },
          controller.signal,
          toolHeaders,
        )
        .catch((e) => {
          const error = e instanceof Error ? e : new Error(String(e));
          this.take(requestId, error)?.reject(error);
        });
    });
  }
}
