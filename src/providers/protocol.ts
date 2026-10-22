import type { Route } from "../core/config.js";
import { invariant } from "../core/util.js";
import type { ReasoningEffort } from "../contracts.js";
import {
  emptyUsage,
  type AssistantMessage,
  type ModelDelta,
  type ModelRequest,
} from "../runtime/types.js";

export interface ProtocolRequest {
  request: ModelRequest;
  route: Route;
  routeId: string;
  /** Output token budget already capped by the route. */
  budget: number;
}

export interface ReasoningSettings {
  effort?: ReasoningEffort;
  budget?: number;
  outputBudget: number;
}

/**
 * Wire protocol for a text route. HttpTextProvider owns transport, retries of a failed
 * request and error shaping; a protocol only maps requests and response events.
 */
export interface TextProtocol {
  /** Value of `route.adapter` that selects this protocol. */
  readonly id: string;
  /** Request URL for the route's base URL (without trailing slash). */
  url(baseUrl: string): string;
  /** Credential headers for the route key. Defaults to `Authorization: Bearer`. */
  credentials?(key: string): Record<string, string>;
  /** Fixed protocol headers such as an API version. */
  headers?: Readonly<Record<string, string>>;
  body(input: ProtocolRequest): Record<string, any>;
  /** Wire form of an explicit tool choice. Defaults to the choice itself. */
  toolChoice?(
    choice: NonNullable<ModelRequest["toolChoice"]>,
    input: ProtocolRequest,
  ): unknown;
  /** Applied after host-configured reasoning fields are cleared for effort "none". */
  disableReasoning?(body: Record<string, unknown>, route: Route): void;
  enableReasoning?(
    body: Record<string, unknown>,
    route: Route,
    settings: ReasoningSettings,
  ): void;
  /** Apply one streamed event (or one synthesized from a JSON response). */
  event(event: any, response: ResponseBuilder): Promise<void>;
  /** Events equivalent to a non-streaming JSON response. Defaults to `[value]`. */
  jsonEvents?(value: any): any[];
  /** Runs after tool calls are appended to the message. */
  finalize?(response: ResponseBuilder): void;
}

export function wantsReasoning(route: Route, request: ModelRequest): boolean {
  const effort = request.reasoningEffort ?? route.reasoningEffort;
  return (
    effort !== "none" &&
    Boolean(
      effort ||
      request.reasoningBudgetTokens ||
      route.reasoningBudgetTokens ||
      route.reasoning,
    )
  );
}

export const parseArgs = (raw: string): Record<string, any> => {
  const args = JSON.parse(raw || "{}");
  invariant(
    args && typeof args === "object" && !Array.isArray(args),
    "Tool arguments must be a JSON object",
    502,
  );
  return args;
};

export interface PendingCall {
  id: string;
  name: string;
  json: string;
}

/** Accumulates one assistant message from protocol events and forwards visible deltas. */
export class ResponseBuilder {
  readonly output: AssistantMessage;
  readonly calls = new Map<number, PendingCall>();
  /** Protocol-native blocks retained for replay, keyed by stream index. */
  readonly nativeBlocks = new Map<number, any>();
  started = false;
  finished = false;
  private inputUsageSeen = false;
  private outputUsageSeen = false;
  constructor(
    readonly protocol: string,
    readonly routeId: string,
    model: string,
    private readonly delta?: (event: ModelDelta) => void | Promise<void>,
  ) {
    this.output = {
      role: "assistant",
      content: [],
      model,
      provider: routeId,
      stopReason: "error",
      timestamp: Date.now(),
      usage: emptyUsage(),
    };
  }
  async text(value: string) {
    if (!value) return;
    this.started = true;
    let part = this.output.content.at(-1);
    if (part?.type !== "text") {
      part = { type: "text", text: "" };
      this.output.content.push(part);
    }
    part.text += value;
    await this.delta?.({ type: "text", text: value });
  }
  async thought(value: string) {
    if (!value) return;
    this.started = true;
    let part = this.output.content.find((p) => p.type === "thinking");
    if (part?.type !== "thinking") {
      part = { type: "thinking", thinking: "" };
      this.output.content.push(part);
    }
    part.thinking += value;
    await this.delta?.({ type: "thinking", text: value });
  }
  async toolArguments(callId: string, text: string) {
    await this.delta?.({ type: "tool-arguments", callId, text });
  }
  /**
   * Record provider usage. `cacheSeparate` counts cache tokens outside input (Anthropic);
   * `terminal` is false for usage that a later event will complete.
   */
  usage(u: any, cacheSeparate = false, terminal = true) {
    if (!u) return;
    const usage = this.output.usage;
    const input = u.input_tokens ?? u.prompt_tokens,
      out = u.output_tokens ?? u.completion_tokens;
    if (input !== undefined) usage.input = input;
    if (out !== undefined) usage.output = out;
    this.inputUsageSeen ||= Number.isSafeInteger(input) && input >= 0;
    this.outputUsageSeen ||= Number.isSafeInteger(out) && out >= 0;
    usage.reported =
      this.inputUsageSeen &&
      this.outputUsageSeen &&
      (!cacheSeparate || terminal);
    usage.cacheRead =
      u.cache_read_input_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      usage.cacheRead;
    usage.cacheWrite = u.cache_creation_input_tokens ?? usage.cacheWrite;
    usage.totalTokens =
      u.total_tokens ??
      usage.input +
        usage.output +
        (cacheSeparate ? usage.cacheRead + usage.cacheWrite : 0);
  }
  finish(stopReason: AssistantMessage["stopReason"]) {
    this.finished = true;
    this.output.stopReason = stopReason;
  }
  /** Replay state for this route, created on first use. */
  providerState() {
    return (this.output.providerState ||= {
      protocol: this.protocol,
      routeId: this.routeId,
      items: [],
    });
  }
  /** Append completed tool calls in stream order; rejects incomplete or duplicate calls. */
  finalizeCalls() {
    const seen = new Set<string>();
    for (const c of this.calls.values()) {
      invariant(
        c.name && c.id && !seen.has(c.id),
        "Incomplete or duplicate tool call",
        502,
      );
      seen.add(c.id);
      this.output.content.push({
        type: "toolCall",
        id: c.id,
        name: c.name,
        arguments: parseArgs(c.json),
      });
    }
    if (this.calls.size && this.output.stopReason === "stop")
      this.output.stopReason = "toolUse";
  }
}
