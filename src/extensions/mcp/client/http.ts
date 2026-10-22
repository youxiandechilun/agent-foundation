import { invariant, errorText, delay } from "../../../core/util.js";
import { readJson } from "../../../providers/sse.js";
import {
  parameterHeaders,
  mcpHeaderValue,
  type HeaderBinding,
} from "../headers.js";
import {
  frames,
  rpc,
  MCPProtocolError,
  wireObject,
  wireMember,
  type RpcId,
  type RpcMessage,
} from "../protocol.js";
import type { MCPClientOptions } from "../client.js";

interface HttpHost {
  signal: AbortSignal;
  closed: () => boolean;
  modern: () => boolean;
  protocolVersion: () => string;
  receive: (message: RpcMessage, parentId?: RpcId) => void;
  hasPending: (id: RpcId) => boolean;
  sessionExpired: (error: MCPProtocolError) => void;
  record: (method: string, params: unknown) => void;
}
/** HTTP session identity, routing headers and SSE recovery belong to one connection. */
export class MCPHttpTransport {
  private sessionId?: string;
  private lastAuthorization?: string;
  private seen = new Set<string>();
  constructor(
    private options: MCPClientOptions,
    private limits: { message: number },
    private host: HttpHost,
  ) {}
  private async headers(sse = false) {
    // Shutdown must not initiate a fresh token exchange just to close a legacy session.
    const authorization = this.host.closed()
      ? this.lastAuthorization
      : await this.options.authorization?.();
    if (!this.host.closed()) this.lastAuthorization = authorization;
    return {
      ...this.options.headers,
      ...(authorization ? { Authorization: authorization } : {}),
      "Content-Type": "application/json",
      Accept: sse ? "text/event-stream" : "application/json, text/event-stream",
      ...(this.sessionId ? { "MCP-Session-Id": this.sessionId } : {}),
      ...(this.host.protocolVersion()
        ? { "MCP-Protocol-Version": this.host.protocolVersion() }
        : {}),
    };
  }
  async send(
    message: RpcMessage,
    data: string,
    signal: AbortSignal,
    toolHeaders?: HeaderBinding[],
  ) {
    const response = await fetch(this.options.url!, {
      method: "POST",
      headers: {
        ...(await this.headers()),
        ...(this.host.modern() && message.method
          ? { "Mcp-Method": message.method }
          : {}),
        ...(this.host.modern() &&
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
                wireMember(message.params, "taskId") ??
                  wireMember(message.params, "name") ??
                  wireMember(message.params, "uri"),
              ),
            }
          : {}),
        ...(this.host.modern() && message.method === "tools/call"
          ? parameterHeaders(
              toolHeaders || [],
              wireMember(message.params, "arguments"),
            )
          : {}),
      },
      body: data,
      signal: AbortSignal.any([signal, this.host.signal]),
      redirect: "error",
    });
    if (response.status === 404 && this.sessionId) {
      this.host.sessionExpired(
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
        const value = wireObject(await readJson(response, this.limits.message)),
          code = wireMember(value, "error", "code");
        if (
          value?.jsonrpc === "2.0" &&
          value.id === message.id &&
          typeof code === "number" &&
          Number.isInteger(code)
        )
          throw new MCPProtocolError(
            String(wireMember(value, "error", "message")),
            code,
            wireMember(value, "error", "data"),
          );
      } else await response.body?.cancel();
      throw new MCPProtocolError(`MCP HTTP ${response.status}`);
    }
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession && !this.host.modern()) {
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
    this.host.receive(parsed, message.id);
    if (expects)
      invariant(
        parsed.id === message.id || this.host.hasPending(message.id!) === false,
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
        AbortSignal.any([signal, this.host.signal]),
      )) {
        if (event.id !== undefined) cursor = event.id;
        if (event.retry !== undefined) retry = event.retry;
        if (!event.data) continue;
        if (!this.host.modern() && event.id && this.seen.has(event.id))
          continue;
        const message = rpc(JSON.parse(event.data));
        if (target !== undefined && !message.method)
          invariant(message.id === target, "MCP response ID mismatch", 502);
        if (event.id && !this.host.modern()) {
          this.seen.add(event.id);
          if (this.seen.size > 2000)
            this.seen.delete(this.seen.values().next().value!);
        }
        this.host.receive(message, target);
        if (target !== undefined && message.id === target && !message.method)
          return;
      }
      if (target === undefined || !this.host.hasPending(target)) return;
      invariant(
        !this.host.modern(),
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
        signal: AbortSignal.any([signal, this.host.signal]),
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
  async listen(signal: AbortSignal) {
    let cursor: string | undefined,
      retry = 1000;
    while (!signal.aborted && !this.host.closed()) {
      try {
        const response = await fetch(this.options.url!, {
          headers: {
            ...(await this.headers(true)),
            ...(cursor ? { "Last-Event-ID": cursor } : {}),
          },
          signal: AbortSignal.any([signal, this.host.signal]),
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
            this.host.receive(rpc(JSON.parse(event.data)));
          }
        }
      } catch (e) {
        if (signal.aborted || this.host.closed()) return;
        this.host.record("transport/error", { message: errorText(e) });
      }
      await delay(Math.max(100, retry), signal);
    }
  }
  async close(): Promise<void> {
    if (this.sessionId && !this.host.modern()) {
      await fetch(this.options.url!, {
        method: "DELETE",
        headers: await this.headers(),
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
  clearAuthorization(): void {
    this.lastAuthorization = undefined;
  }
}
