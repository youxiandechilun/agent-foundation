import type { Config, Route } from "../core/config.js";
import {
  estimateTokens,
  estimateTextTokens,
} from "../runtime/token-counter.js";
import {
  id,
  invariant,
  errorText,
  redactJsonText,
  registerSecret,
  delay as wait,
} from "../core/util.js";
import {
  sse,
  readJson,
  ProviderError,
  retryAfter,
  TRANSIENT_STATUSES,
} from "./sse.js";
import type { CostLedger, CostScope } from "../runtime/cost.js";
import { isOutputTool } from "../runtime/structured-output.js";
import { applyReasoning, wantsReasoning } from "./reasoning.js";
import {
  ResponsesWebSearch,
  nativeWebSearchEnabled,
  responsesOutputText,
} from "./responses-search.js";
import {
  completionsMessages,
  responsesInput,
  anthropicMessages,
  functionTools,
} from "./serialize.js";
import {
  emptyUsage,
  textOf,
  type AssistantMessage,
  type ModelRequest,
  type ModelDelta,
  type TextProvider,
  type JsonObject,
  type ThinkingPart,
} from "../runtime/types.js";

export function routeHeaders(route: Route): Record<string, string> {
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
    if (route.adapter === "anthropic-messages") headers["x-api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
    registerSecret(key);
  }
  for (const [name, env] of Object.entries(route.headersEnv)) {
    invariant(process.env[env], `Missing environment variable ${env}`, 503);
    headers[name] = process.env[env]!;
    if (/authorization|cookie|key|token|secret/i.test(name))
      registerSecret(headers[name]);
  }
  if (route.adapter === "anthropic-messages")
    headers["anthropic-version"] = "2023-06-01";
  return headers;
}
const parseArgs = (raw: string): JsonObject => {
  const args: unknown = JSON.parse(raw || "{}");
  invariant(
    args && typeof args === "object" && !Array.isArray(args),
    "Tool arguments must be a JSON object",
    502,
  );
  return args as JsonObject;
};
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
      budget = Math.min(
        request.maxOutputTokens || r.maxOutputTokens,
        r.maxOutputTokens,
      );
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      model: r.model,
      provider: this.routeId,
      stopReason: "error",
      timestamp: Date.now(),
      usage: emptyUsage(),
    };
    const calls = new Map<number, { id: string; name: string; json: string }>();
    const thoughts = new Map<number, ThinkingPart>();
    let finished = false,
      started = false;
    let inputUsageSeen = false,
      outputUsageSeen = false,
      requestSent = false;
    const text = async (value: string) => {
      if (!value) return;
      started = true;
      let part = output.content.at(-1);
      if (part?.type !== "text") {
        part = { type: "text", text: "" };
        output.content.push(part);
      }
      part.text += value;
      await delta?.({ type: "text", text: value });
    };
    const thought = async (value: string, index = -1, signature?: string) => {
      if (!value && index < 0) return;
      started ||= Boolean(value);
      let part = thoughts.get(index);
      if (!part) {
        part = { type: "thinking", thinking: "" };
        thoughts.set(index, part);
        output.content.push(part);
      }
      part.thinking += value;
      if (signature) part.signature = signature;
      if (value) await delta?.({ type: "thinking", text: value });
    };
    const usage = (u: any, anthropic = false, terminalUsage = true) => {
      if (!u) return;
      const input = u.input_tokens ?? u.prompt_tokens,
        out = u.output_tokens ?? u.completion_tokens;
      if (input !== undefined) output.usage.input = input;
      if (out !== undefined) output.usage.output = out;
      inputUsageSeen ||= Number.isSafeInteger(input) && input >= 0;
      outputUsageSeen ||= Number.isSafeInteger(out) && out >= 0;
      output.usage.reported =
        inputUsageSeen && outputUsageSeen && (!anthropic || terminalUsage);
      output.usage.cacheRead =
        u.cache_read_input_tokens ??
        u.input_tokens_details?.cached_tokens ??
        u.prompt_tokens_details?.cached_tokens ??
        output.usage.cacheRead;
      output.usage.cacheWrite =
        u.cache_creation_input_tokens ?? output.usage.cacheWrite;
      output.usage.totalTokens =
        u.total_tokens ??
        output.usage.input +
          output.usage.output +
          (anthropic ? output.usage.cacheRead + output.usage.cacheWrite : 0);
    };
    const nativeBlocks = new Map<number, any>();
    const webSearch = new ResponsesWebSearch();
    const nativeWebSearch = nativeWebSearchEnabled(r, request);
    const retainProviderState = () => {
      const search = webSearch.result();
      if (search) {
        const breaks: number[] = [];
        let length = 0;
        for (const part of output.content) {
          if (part.type !== "text") continue;
          if (length) breaks.push(length);
          length += part.text.length;
        }
        output.webSearch = {
          ...search,
          citations: search.citations
            .filter((c) => c.endIndex <= length)
            .map((c) => ({
              ...c,
              startIndex:
                c.startIndex + breaks.filter((b) => b <= c.startIndex).length,
              endIndex:
                c.endIndex +
                breaks.filter(
                  (b) =>
                    b < c.endIndex ||
                    (c.startIndex === c.endIndex && b === c.endIndex),
                ).length,
            })),
        };
      }
      const callIds = new Set(
        output.content.filter((p) => p.type === "toolCall").map((p) => p.id),
      );
      if (r.adapter === "anthropic-messages" || nativeBlocks.size)
        output.providerState = {
          protocol: r.adapter,
          routeId: this.routeId,
          items: [...nativeBlocks]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value)
            .filter(
              (value) =>
                value.type !== "function_call" || callIds.has(value.call_id),
            ),
        };
    };
    const finalizeCalls = () => {
      const seen = new Set<string>();
      for (const [index, c] of calls) {
        invariant(
          c.name && c.id && !seen.has(c.id),
          "Incomplete or duplicate tool call",
          502,
        );
        seen.add(c.id);
        const args = parseArgs(c.json);
        output.content.push({
          type: "toolCall",
          id: c.id,
          name: c.name,
          arguments: args,
        });
        if (nativeBlocks.get(index)?.type === "tool_use")
          nativeBlocks.get(index).input = args;
      }
      if (calls.size && output.stopReason === "stop")
        output.stopReason = "toolUse";
      retainProviderState();
    };
    let body: any, suffix: string;
    if (r.adapter === "openai-completions") {
      suffix = "/chat/completions";
      body = {
        ...r.requestDefaults,
        model: r.model,
        messages: completionsMessages(request.messages, r),
        stream: true,
        [(r.compat.maxTokensField as string) || "max_tokens"]: budget,
      };
      if (request.tools.length) body.tools = functionTools(request.tools);
      if (r.compat.supportsUsageInStreaming !== false)
        body.stream_options = { include_usage: true };
    } else if (r.adapter === "openai-responses") {
      suffix = "/responses";
      body = {
        ...r.requestDefaults,
        model: r.model,
        input: responsesInput(request.messages, this.routeId),
        stream: true,
        store: false,
        max_output_tokens: budget,
        include: [
          "reasoning.encrypted_content",
          ...(nativeWebSearch ? ["web_search_call.action.sources"] : []),
        ],
      };
      const tools = functionTools(request.tools).map((t) => ({
        type: t.type,
        ...t.function,
      }));
      body.tools = [
        ...tools,
        ...(nativeWebSearch ? [{ type: "web_search" }] : []),
      ];
      if (!body.tools.length) delete body.tools;
      if (nativeWebSearch) body.tool_choice ??= "auto";
    } else {
      suffix = "/v1/messages";
      body = {
        ...r.requestDefaults,
        model: r.model,
        system: request.messages
          .filter((m) => m.role === "system")
          .map((m) => textOf(m))
          .join("\n\n"),
        messages: anthropicMessages(request.messages, this.routeId),
        stream: true,
        max_tokens: budget,
      };
      if (request.tools.length)
        body.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      if (r.promptCache !== false) applyCacheBreakpoints(body);
    }
    if (request.toolChoice) {
      invariant(
        request.toolChoice !== "required" ||
          request.tools.length > 0 ||
          nativeWebSearch,
        "Required tool choice needs an available tool",
        403,
      );
      body.tool_choice =
        r.adapter === "anthropic-messages"
          ? {
              type:
                request.toolChoice === "required" ? "any" : request.toolChoice,
            }
          : request.toolChoice;
      invariant(
        !(
          r.adapter === "anthropic-messages" &&
          wantsReasoning(r, request) &&
          request.toolChoice === "required"
        ),
        "Anthropic extended thinking cannot force tool use",
        400,
      );
    }
    applyReasoning(body, r, request, budget);
    const base = r.baseUrl.replace(/\/$/, "");
    if (r.adapter === "anthropic-messages" && base.endsWith("/v1"))
      suffix = "/messages";
    try {
      const headers = routeHeaders(r),
        payload = redactJsonText(body);
      requestSent = true;
      const response = await fetch(base + suffix, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(r.timeoutMs),
        ]),
        redirect: "error",
      });
      if (!response.ok) {
        const error = await readJson(response).catch(() => ({}));
        const code = error.error?.code || error.error?.type;
        const contextOverflow =
          [
            "context_length_exceeded",
            "max_context_length_exceeded",
            "prompt_too_long",
          ].includes(code) ||
          (code === "invalid_request_error" &&
            /prompt is too long|input length exceeds|maximum context length/i.test(
              error.error?.message || "",
            ));
        throw new ProviderError(
          `Provider HTTP ${response.status}: ${errorText(error.error?.message || response.statusText)}`,
          response.status,
          false,
          contextOverflow,
          retryAfter(response.headers),
        );
      }
      const processEvent = async (event: any) => {
        if (r.adapter === "openai-completions") {
          const choice = event.choices?.[0],
            d = choice?.delta || choice?.message;
          if (event.id) output.responseId = event.id;
          if (d) {
            await text(
              typeof d.content === "string"
                ? d.content
                : Array.isArray(d.content)
                  ? d.content.map((p: any) => p.text || "").join("")
                  : "",
            );
            await thought(d.reasoning_content || d.reasoning || "");
            for (const c of d.tool_calls || []) {
              started = true;
              const index = c.index ?? calls.size;
              const call = calls.get(index) || {
                id: c.id || id("call"),
                name: "",
                json: "",
              };
              if (c.id) call.id = c.id;
              if (c.function?.name) call.name += c.function.name;
              if (c.function?.arguments) {
                call.json += c.function.arguments;
                await delta?.({
                  type: "tool-arguments",
                  callId: call.id,
                  text: c.function.arguments,
                });
              }
              calls.set(index, call);
            }
          }
          usage(event.usage);
          if (choice?.finish_reason) {
            finished = true;
            output.stopReason =
              choice.finish_reason === "length"
                ? "length"
                : choice.finish_reason === "content_filter"
                  ? "error"
                  : "stop";
          }
        } else if (r.adapter === "openai-responses") {
          if (webSearch.observe(event)) {
            started = true;
            invariant(
              nativeWebSearch,
              "Provider returned native web search without request authorization",
              502,
            );
          }
          if (event.type === "response.created")
            output.responseId = event.response?.id;
          if (event.type === "response.output_text.delta")
            await text(event.delta);
          if (event.type === "response.reasoning_summary_text.delta")
            await thought(event.delta);
          if (
            event.type === "response.output_item.added" &&
            event.item?.type === "function_call"
          ) {
            started = true;
            calls.set(event.output_index ?? calls.size, {
              id: event.item.call_id,
              name: event.item.name || "",
              json: event.item.arguments || "",
            });
          }
          if (event.type === "response.function_call_arguments.delta") {
            const call = calls.get(event.output_index);
            invariant(
              call && typeof event.delta === "string",
              "Responses argument delta has no declared call",
              502,
            );
            started = true;
            call.json += event.delta;
            await delta?.({
              type: "tool-arguments",
              callId: call.id,
              text: event.delta,
            });
          }
          if (event.type === "response.output_item.done") {
            const item = event.item;
            if (item.type === "function_call") {
              started = true;
              calls.set(event.output_index ?? calls.size, {
                id: item.call_id,
                name: item.name,
                json: item.arguments,
              });
            }
            if (
              nativeWebSearch ||
              ["reasoning", "compaction", "web_search_call"].includes(item.type)
            )
              nativeBlocks.set(event.output_index ?? nativeBlocks.size, item);
          }
          if (
            [
              "response.completed",
              "response.incomplete",
              "response.failed",
            ].includes(event.type)
          ) {
            const result = event.response;
            output.responseId = result?.id || output.responseId;
            usage(result?.usage);
            finished = true;
            output.stopReason =
              event.type === "response.completed"
                ? "stop"
                : event.type === "response.incomplete"
                  ? "length"
                  : "error";
            if (result?.error)
              output.errorMessage = errorText(
                result.error.message || result.error,
              );
            // Compatible endpoints can mix streamed text with terminal-only output parts.
            const terminalText = responsesOutputText(result?.output);
            if (terminalText !== undefined) {
              const received = output.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("");
              invariant(
                terminalText.startsWith(received),
                "Responses terminal text differs from streamed text",
                502,
              );
              await text(terminalText.slice(received.length));
            }
            const callIndices = new Map(
              Array.from(calls, ([index, call]) => [call.id, index]),
            );
            for (const [index, item] of (result?.output || []).entries()) {
              if (
                nativeWebSearch ||
                ["reasoning", "compaction", "web_search_call"].includes(
                  item.type,
                )
              )
                nativeBlocks.set(index, item);
              if (item.type === "function_call") {
                const callIndex = callIndices.get(item.call_id) ?? index;
                invariant(
                  !calls.has(callIndex) ||
                    calls.get(callIndex)?.id === item.call_id,
                  "Conflicting Responses tool call index",
                  502,
                );
                const previous = calls.get(callIndex);
                calls.set(callIndex, {
                  id: item.call_id,
                  name: item.name ?? previous?.name ?? "",
                  json: item.arguments ?? previous?.json ?? "",
                });
                callIndices.set(item.call_id, callIndex);
              }
            }
          }
        } else {
          if (event.type === "message_start") {
            output.responseId = event.message.id;
            usage(event.message.usage, true, false);
          }
          if (event.type === "content_block_start") {
            const b = event.content_block;
            nativeBlocks.set(event.index, structuredClone(b));
            if (b.type === "tool_use") {
              started = true;
              calls.set(event.index, {
                id: b.id,
                name: b.name,
                json: Object.keys(b.input || {}).length
                  ? JSON.stringify(b.input)
                  : "",
              });
            }
            if (b.type === "text" && b.text) await text(b.text);
            if (b.type === "thinking")
              await thought(b.thinking || "", event.index, b.signature);
          }
          if (event.type === "content_block_delta") {
            const d = event.delta;
            const block = nativeBlocks.get(event.index);
            if (block) {
              if (d.type === "text_delta")
                block.text = (block.text || "") + d.text;
              if (d.type === "thinking_delta")
                block.thinking = (block.thinking || "") + d.thinking;
              if (d.type === "signature_delta")
                block.signature = (block.signature || "") + d.signature;
            }
            if (d.type === "text_delta") await text(d.text);
            if (d.type === "thinking_delta")
              await thought(d.thinking, event.index);
            if (d.type === "signature_delta") {
              const p = thoughts.get(event.index);
              if (p) p.signature = (p.signature || "") + d.signature;
            }
            if (d.type === "input_json_delta") {
              const c = calls.get(event.index);
              invariant(c, "Arguments arrived before tool_use", 502);
              c.json += d.partial_json;
              await delta?.({
                type: "tool-arguments",
                callId: c.id,
                text: d.partial_json,
              });
            }
          }
          if (event.type === "message_delta") {
            usage(event.usage, true);
            if (event.delta?.stop_reason) {
              finished = true;
              output.stopReason =
                event.delta.stop_reason === "max_tokens"
                  ? "length"
                  : event.delta.stop_reason === "refusal"
                    ? "error"
                    : "stop";
            }
          }
          if (event.type === "error")
            throw new ProviderError(
              errorText(event.error?.message || "Anthropic streaming error"),
              502,
              started,
            );
        }
      };
      if (response.headers.get("content-type")?.includes("application/json")) {
        const value = await readJson(response);
        if (r.adapter === "openai-responses")
          await processEvent({
            type: `response.${value.status || "completed"}`,
            response: value,
          });
        else if (r.adapter === "anthropic-messages") {
          await processEvent({ type: "message_start", message: value });
          for (const [index, b] of (value.content || []).entries())
            await processEvent({
              type: "content_block_start",
              index,
              content_block: b,
            });
          await processEvent({
            type: "message_delta",
            delta: { stop_reason: value.stop_reason },
            usage: value.usage,
          });
        } else await processEvent(value);
      } else
        for await (const event of sse(response, signal)) {
          if (event.data !== "[DONE]")
            await processEvent(JSON.parse(event.data));
        }
      invariant(
        finished,
        "Provider stream ended without a terminal status",
        502,
      );
      finalizeCalls();
      return output;
    } catch (error) {
      if (r.adapter === "openai-responses") retainProviderState();
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError(errorText(error), 502, started);
      failure.started ||= started;
      Object.assign(failure, {
        requestSent,
        partial: {
          ...output,
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: errorText(error),
        },
      });
      throw failure;
    }
  }
}
export class RouteRouter implements TextProvider {
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
const CACHEABLE = new Set([
  "text",
  "image",
  "tool_use",
  "tool_result",
  "document",
]);
/**
 * Marks Anthropic prompt-cache breakpoints (max 4): tool declarations, the system prompt
 * and the two most recent user turns, so each step re-reads the stable prefix from cache.
 * Blocks are copied, never mutated, because assistant blocks may be replayed provider state.
 */
export function applyCacheBreakpoints(body: {
  system?: unknown;
  tools?: Record<string, unknown>[];
  messages: { role: string; content: Record<string, any>[] }[];
}) {
  const mark = { type: "ephemeral" };
  if (body.tools?.length)
    body.tools[body.tools.length - 1] = {
      ...body.tools.at(-1),
      cache_control: mark,
    };
  if (typeof body.system === "string" && body.system)
    body.system = [{ type: "text", text: body.system, cache_control: mark }];
  let remaining = 2;
  for (let i = body.messages.length - 1; i >= 0 && remaining; i--) {
    const message = body.messages[i];
    if (message.role !== "user") continue;
    const at = message.content.findLastIndex(
      (b) => CACHEABLE.has(b.type) && !(b.type === "text" && !b.text),
    );
    if (at < 0) continue;
    const content = message.content.slice();
    content[at] = { ...content[at], cache_control: mark };
    body.messages[i] = { ...message, content };
    remaining--;
  }
  return body;
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
