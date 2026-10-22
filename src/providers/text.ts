import type { Config, Route } from "../core/config.js";
import {
  estimateTokens,
  estimateTextTokens,
} from "../runtime/token-counter.js";
import {
  invariant,
  errorText,
  redactJsonText,
  registerSecret,
  delay as wait,
} from "../core/util.js";
import { wireMember } from "../core/wire.js";
import {
  sse,
  readJson,
  ProviderError,
  retryAfter,
  TRANSIENT_STATUSES,
} from "./sse.js";
import type { CostLedger, CostScope } from "../runtime/cost.js";
import { isOutputTool } from "../runtime/structured-output.js";
import { applyReasoning } from "./reasoning.js";
import { ResponseBuilder } from "./protocol.js";
import { findTextProtocol, textProtocol } from "./registry.js";
import { nativeWebSearchEnabled } from "./responses-search.js";
import type {
  AssistantMessage,
  ModelRequest,
  ModelDelta,
  TextProvider,
} from "../runtime/types.js";

export { applyCacheBreakpoints } from "./protocols/anthropic-messages.js";

export function routeHeaders(route: Route): Record<string, string> {
  const protocol = findTextProtocol(route.adapter);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  };
  if (route.apiKeyEnv) {
    const key = process.env[route.apiKeyEnv];
    invariant(
      key,
      `Missing environment variable ${route.apiKeyEnv}`,
      503,
      "credentials_missing",
    );
    Object.assign(
      headers,
      protocol?.credentials
        ? protocol.credentials(key)
        : { Authorization: `Bearer ${key}` },
    );
    registerSecret(key);
  }
  for (const [name, env] of Object.entries(route.headersEnv)) {
    invariant(process.env[env], `Missing environment variable ${env}`, 503);
    headers[name] = process.env[env]!;
    if (/authorization|cookie|key|token|secret/i.test(name))
      registerSecret(headers[name]);
  }
  return Object.assign(headers, protocol?.headers);
}
export class HttpTextProvider implements TextProvider {
  constructor(
    readonly routeId: string,
    readonly route: Route,
  ) {
    invariant(route.kind === "text", "Not a text route");
  }
  async complete(
    request: ModelRequest,
    delta?: (event: ModelDelta) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<AssistantMessage> {
    const r = this.route,
      protocol = textProtocol(r.adapter),
      input = {
        request,
        route: r,
        routeId: this.routeId,
        budget: Math.min(
          request.maxOutputTokens || r.maxOutputTokens,
          r.maxOutputTokens,
        ),
      };
    const response = new ResponseBuilder(
      protocol.id,
      this.routeId,
      r.model,
      delta,
      nativeWebSearchEnabled(r, request),
    );
    let requestSent = false;
    const body = protocol.body(input);
    if (request.toolChoice) {
      invariant(
        request.toolChoice !== "required" ||
          request.tools.length > 0 ||
          response.nativeWebSearch,
        "Required tool choice needs an available tool",
        403,
      );
      body.tool_choice = protocol.toolChoice
        ? protocol.toolChoice(request.toolChoice, input)
        : request.toolChoice;
    }
    applyReasoning(body, r, request, input.budget);
    try {
      const headers = routeHeaders(r),
        payload = redactJsonText(body);
      requestSent = true;
      const reply = await fetch(protocol.url(r.baseUrl.replace(/\/$/, "")), {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(r.timeoutMs),
        ]),
        redirect: "error",
      });
      if (!reply.ok) {
        const error = await readJson(reply).catch(() => ({}));
        const code =
            wireMember(error, "error", "code") ||
            wireMember(error, "error", "type"),
          detail = wireMember(error, "error", "message");
        const contextOverflow =
          (
            [
              "context_length_exceeded",
              "max_context_length_exceeded",
              "prompt_too_long",
            ] as unknown[]
          ).includes(code) ||
          (code === "invalid_request_error" &&
            /prompt is too long|input length exceeds|maximum context length/i.test(
              String(detail || ""),
            ));
        throw new ProviderError(
          `Provider HTTP ${reply.status}: ${errorText(detail || reply.statusText)}`,
          reply.status,
          false,
          contextOverflow,
          retryAfter(reply.headers),
        );
      }
      if (reply.headers.get("content-type")?.includes("application/json")) {
        const value = await readJson(reply);
        for (const event of protocol.jsonEvents
          ? protocol.jsonEvents(value)
          : [value])
          await protocol.event(event, response);
      } else
        for await (const event of sse(reply, signal)) {
          if (event.data !== "[DONE]")
            await protocol.event(JSON.parse(event.data), response);
        }
      invariant(
        response.finished,
        "Provider stream ended without a terminal status",
        502,
      );
      response.finalizeCalls();
      protocol.finalize?.(response);
      return response.output;
    } catch (error) {
      if (protocol.id === "openai-responses") response.retainResponsesState();
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError(errorText(error), 502, response.started);
      failure.started ||= response.started;
      Object.assign(failure, {
        requestSent,
        partial: {
          ...response.output,
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: errorText(error),
        },
      });
      throw failure;
    }
  }
}
/** Named form of the RouteRouter constructor arguments, for RouteRouter.create. */
export interface RouteRouterOptions {
  onRoute?: (routeId: string, fallback: boolean) => void;
  prepareRoute?: (
    request: ModelRequest,
    signal?: AbortSignal,
  ) => Promise<ModelRequest>;
  repairContext?: (
    request: ModelRequest,
    signal?: AbortSignal,
  ) => Promise<ModelRequest>;
  billing?: { ledger: CostLedger; scope: CostScope };
  onRetry?: (notice: RetryNotice) => void;
  beforeRequest?: (
    request: ModelRequest,
    signal?: AbortSignal,
  ) => Promise<ModelRequest>;
}
export class RouteRouter implements TextProvider {
  /** Prefer this to the positional constructor, which is kept for compatibility. */
  static create(config: Config, options: RouteRouterOptions = {}) {
    return new RouteRouter(
      config,
      options.onRoute,
      options.prepareRoute,
      options.repairContext,
      options.billing,
      options.onRetry,
      options.beforeRequest,
    );
  }
  constructor(
    readonly config: Config,
    readonly onRoute?: (routeId: string, fallback: boolean) => void,
    readonly prepareRoute?: (
      request: ModelRequest,
      signal?: AbortSignal,
    ) => Promise<ModelRequest>,
    readonly repairContext?: (
      request: ModelRequest,
      signal?: AbortSignal,
    ) => Promise<ModelRequest>,
    readonly billing?: { ledger: CostLedger; scope: CostScope },
    readonly onRetry?: (notice: RetryNotice) => void,
    readonly beforeRequest?: (
      request: ModelRequest,
      signal?: AbortSignal,
    ) => Promise<ModelRequest>,
  ) {}
  async complete(
    request: ModelRequest,
    delta?: (event: ModelDelta) => void | Promise<void>,
    signal?: AbortSignal,
  ) {
    const primary = this.config.routes[request.routeId];
    invariant(
      primary?.enabled && primary.kind === "text",
      "Text route unavailable",
      503,
    );
    let last: unknown;
    const chain = [request.routeId, ...primary.fallbackRouteIds].filter(
      (id) =>
        this.config.routes[id]?.enabled &&
        this.config.routes[id].kind === "text",
    );
    for (const [index, routeId] of chain.entries()) {
      const route = this.config.routes[routeId];
      const tools = request.tools.filter(
        (t) =>
          isOutputTool(t) ||
          route.toolAllowlist.includes("*") ||
          route.toolAllowlist.includes(t.name),
      );
      try {
        this.onRoute?.(routeId, index > 0);
        const effective = this.prepareRoute
          ? await this.prepareRoute({ ...request, routeId, tools }, signal)
          : { ...request, routeId, tools };
        if (index > 0 && !this.prepareRoute) {
          const toolTokens = tools.length
            ? estimateTextTokens(
                JSON.stringify(
                  tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                ),
              )
            : 0;
          invariant(
            estimateTokens(effective.messages) +
              toolTokens +
              Math.min(
                request.maxOutputTokens || route.maxOutputTokens,
                route.maxOutputTokens,
              ) <=
              route.contextWindow,
            "context_limit: fallback model cannot accept this context",
            413,
          );
        }
        const provider = new HttpTextProvider(routeId, route);
        const complete = async (request: ModelRequest) => {
          const req = this.beforeRequest
            ? await this.beforeRequest(request, signal)
            : request;
          signal?.throwIfAborted();
          return this.billing
            ? this.billing.ledger.text(
                routeId,
                route,
                req,
                this.billing.scope,
                () => provider.complete(req, delta, signal),
                signal,
              )
            : provider.complete(req, delta, signal);
        };
        const attempt = async () => {
          try {
            return await complete(effective);
          } catch (error) {
            if (
              !(error instanceof ProviderError) ||
              !error.contextOverflow ||
              error.started ||
              signal?.aborted ||
              !this.repairContext
            )
              throw error;
            // Exactly one retry after explicit context repair, with no already-visible output or tool effect.
            const repaired = await this.repairContext(effective, signal);
            return await complete(repaired);
          }
        };
        // Fallback routes absorb transient failures first; the last route in the chain retries in place.
        const lastInChain = index === chain.length - 1;
        const policy = { ...DEFAULT_RETRY, ...route.retry };
        for (let retry = 0; ; retry++) {
          try {
            return await attempt();
          } catch (error) {
            const delay = retryDelay(error, retry, policy);
            if (!lastInChain || signal?.aborted || delay === undefined)
              throw error;
            this.onRetry?.({
              routeId,
              attempt: retry + 1,
              maxRetries: policy.maxRetries,
              delayMs: delay,
              status: (error as ProviderError).upstreamStatus,
              error: errorText(error),
            });
            await wait(delay, signal);
          }
        }
      } catch (error) {
        last = error;
        if (!isTransient(error) || signal?.aborted) throw error;
      }
    }
    throw last || new ProviderError("No available text provider");
  }
}
export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
};
export interface RetryNotice {
  routeId: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status: number;
  error: string;
}
const isTransient = (error: unknown): error is ProviderError =>
  error instanceof ProviderError &&
  !error.started &&
  !error.contextOverflow &&
  TRANSIENT_STATUSES.has(error.upstreamStatus);
/**
 * Delay before the next attempt, or undefined when the error must surface.
 * Exponential backoff with ±25% jitter; a server Retry-After wins but is never exceeded silently.
 */
export function retryDelay(
  error: unknown,
  retry: number,
  policy: RetryPolicy,
  random = Math.random,
) {
  if (!isTransient(error) || retry >= policy.maxRetries) return undefined;
  if (error.retryAfterMs !== undefined)
    return error.retryAfterMs <= policy.maxDelayMs
      ? error.retryAfterMs
      : undefined;
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** retry);
  return Math.round(base * (0.75 + random() * 0.5));
}
