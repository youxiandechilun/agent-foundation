import type { Route } from "../core/config.js";
import { invariant } from "../core/util.js";
import { usagePayload, type NativeBlock } from "./protocols/wire.js";
import { ResponsesWebSearch, responsesOutputText } from "./responses-search.js";
import type { WireObject } from "../core/wire.js";
import type { ReasoningEffort } from "../contracts.js";
import {
  emptyUsage,
  type AssistantMessage,
  type JsonObject,
  type ModelDelta,
  type ModelRequest,
  type ThinkingPart,
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
  /**
   * Whether reported input tokens include cache reads and writes. Defaults to true;
   * protocols that report them separately (Anthropic) set false.
   */
  inputIncludesCache?: boolean;
  /** Fixed protocol headers such as an API version. */
  headers?: Readonly<Record<string, string>>;
  body(input: ProtocolRequest): Record<string, unknown>;
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
  event(event: unknown, response: ResponseBuilder): Promise<void>;
  /** Events equivalent to a non-streaming JSON response. Defaults to `[value]`. */
  jsonEvents?(value: unknown): unknown[];
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

/** Parsed JSON text is always JSON; the guard rejects non-object arguments. */
export const parseArgs = (raw: string): JsonObject => {
  const args: unknown = JSON.parse(raw || "{}");
  invariant(
    args && typeof args === "object" && !Array.isArray(args),
    "Tool arguments must be a JSON object",
    502,
  );
  return args as JsonObject;
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
  readonly nativeBlocks: Map<number, NativeBlock> = new Map();
  readonly responseItems = new Map<number, WireObject & { type: string }>();
  readonly webSearch = new ResponsesWebSearch();
  private readonly thoughts = new Map<number, ThinkingPart>();
  started = false;
  finished = false;
  private inputUsageSeen = false;
  private outputUsageSeen = false;
  constructor(
    readonly protocol: string,
    readonly routeId: string,
    model: string,
    private readonly delta?: (event: ModelDelta) => void | Promise<void>,
    readonly nativeWebSearch = false,
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
  async thought(value: string, index = -1, signature?: string) {
    if (!value && index < 0) return;
    this.started ||= Boolean(value);
    let part = this.thoughts.get(index);
    if (!part) {
      part = { type: "thinking", thinking: "" };
      this.thoughts.set(index, part);
      this.output.content.push(part);
    }
    part.thinking += value;
    if (signature) part.signature = signature;
    if (value) await this.delta?.({ type: "thinking", text: value });
  }
  appendSignature(index: number, signature: string) {
    const part = this.thoughts.get(index);
    if (part) part.signature = (part.signature || "") + signature;
  }
  async toolArguments(callId: string, text: string) {
    await this.delta?.({ type: "tool-arguments", callId, text });
  }
  /**
   * Record provider usage. `cacheSeparate` counts cache tokens outside input (Anthropic);
   * `terminal` is false for usage that a later event will complete.
   */
  usage(value: unknown, cacheSeparate = false, terminal = true) {
    if (value == null) return;
    const u = usagePayload.parse(value);
    const usage = this.output.usage;
    const input = u.input_tokens ?? u.prompt_tokens,
      out = u.output_tokens ?? u.completion_tokens;
    if (input !== undefined) usage.input = input;
    if (out !== undefined) usage.output = out;
    this.inputUsageSeen ||= input !== undefined;
    this.outputUsageSeen ||= out !== undefined;
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
  /** Preserve completed native items on success and interrupted Responses streams. */
  retainResponsesState() {
    const search = this.webSearch.result();
    if (search) {
      const breaks: number[] = [];
      let length = 0;
      for (const part of this.output.content) {
        if (part.type !== "text") continue;
        if (length) breaks.push(length);
        length += part.text.length;
      }
      this.output.webSearch = {
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
    if (this.responseItems.size) {
      const calls = new Set(
        this.output.content
          .filter((p) => p.type === "toolCall")
          .map((p) => p.id),
      );
      const items = [...this.responseItems]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value);
      const text = this.output.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      // A completed message can precede text from an interrupted later item.
      // Replay all semantic text once when native messages cover only a prefix.
      const nativeTextComplete = (responsesOutputText(items) ?? "").startsWith(
        text,
      );
      this.output.providerState = {
        protocol: this.protocol,
        routeId: this.routeId,
        items: items.filter(
          (value) =>
            (value.type !== "message" || nativeTextComplete) &&
            (value.type !== "function_call" ||
              (typeof value.call_id === "string" && calls.has(value.call_id))),
        ),
      };
    }
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
