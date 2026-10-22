import { errorText, invariant } from "../../core/util.js";
import { wireMember, wireObject } from "../../core/wire.js";
import { anthropicEvent, anthropicJson } from "./wire.js";
import { textOf } from "../../runtime/types.js";
import { ProviderError } from "../sse.js";
import { anthropicMessages as serializeMessages } from "../serialize.js";
import { parseArgs, wantsReasoning, type TextProtocol } from "../protocol.js";

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
interface AnthropicBody extends Record<string, unknown> {
  system?: unknown;
  tools?: Record<string, unknown>[];
  messages: { role: string; content: unknown[] }[];
}
export function applyCacheBreakpoints(body: AnthropicBody) {
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
    const at = message.content.findLastIndex((b) => {
      const type = wireMember(b, "type");
      return (
        typeof type === "string" &&
        CACHEABLE.has(type) &&
        !(type === "text" && !wireMember(b, "text"))
      );
    });
    if (at < 0) continue;
    const content = message.content.slice();
    content[at] = { ...wireObject(content[at]), cache_control: mark };
    body.messages[i] = { ...message, content };
    remaining--;
  }
  return body;
}

export const anthropicMessages: TextProtocol = {
  id: "anthropic-messages",
  url: (base) => base + (base.endsWith("/v1") ? "/messages" : "/v1/messages"),
  credentials: (key) => ({ "x-api-key": key }),
  headers: { "anthropic-version": "2023-06-01" },
  inputIncludesCache: false,
  body({ request, route, routeId, budget }) {
    const body: AnthropicBody = {
      ...route.requestDefaults,
      model: route.model,
      system: request.messages
        .filter((m) => m.role === "system")
        .map((m) => textOf(m))
        .join("\n\n"),
      messages: serializeMessages(request.messages, routeId),
      stream: true,
      max_tokens: budget,
    };
    if (request.tools.length)
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    if (route.promptCache !== false) applyCacheBreakpoints(body);
    return body;
  },
  toolChoice(choice, { request, route }) {
    invariant(
      !(wantsReasoning(route, request) && choice === "required"),
      "Anthropic extended thinking cannot force tool use",
      400,
    );
    return { type: choice === "required" ? "any" : choice };
  },
  disableReasoning(body) {
    body.thinking = { type: "disabled" };
  },
  enableReasoning(body, route, { effort, budget, outputBudget }) {
    if (route.compat.adaptiveThinking === true) {
      invariant(
        !effort || ["low", "medium", "high", "max"].includes(effort),
        "Adaptive thinking accepts low, medium, high or max on this adapter",
        400,
      );
      invariant(
        !budget,
        "Adaptive thinking uses effort instead of a token budget",
        400,
      );
      body.thinking = { type: "adaptive" };
      if (effort) {
        const previous =
          typeof body.output_config === "object" && body.output_config !== null
            ? body.output_config
            : {};
        body.output_config = { ...previous, effort };
      }
      return;
    }
    invariant(
      !effort,
      "This Anthropic route requires reasoningBudgetTokens; enable compat.adaptiveThinking only for a supporting model",
      400,
    );
    invariant(
      outputBudget >= 1280,
      "Anthropic reasoning requires at least 1280 output tokens",
      400,
    );
    invariant(
      !budget || budget < outputBudget,
      "Thinking token budget must be smaller than maxOutputTokens",
      400,
    );
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    else
      body.thinking ??= {
        type: "enabled",
        budget_tokens: Math.min(2048, outputBudget - 256),
      };
  },
  async event(value, response) {
    if (
      ![
        "message_start",
        "content_block_start",
        "content_block_delta",
        "message_delta",
        "error",
      ].includes(String(wireMember(value, "type")))
    )
      return;
    const event = anthropicEvent.parse(value);
    const { output, calls, nativeBlocks } = response;
    if (event.type === "message_start") {
      output.responseId = event.message.id;
      response.usage(event.message.usage, true, false);
    }
    if (event.type === "content_block_start") {
      const b = event.content_block;
      nativeBlocks.set(event.index, structuredClone(b));
      if (b.type === "tool_use") {
        invariant(b.id && b.name, "Incomplete Anthropic tool-use block", 502);
        response.started = true;
        calls.set(event.index, {
          id: b.id,
          name: b.name,
          json: Object.keys(b.input || {}).length
            ? JSON.stringify(b.input)
            : "",
        });
      }
      if (b.type === "text" && b.text) await response.text(b.text);
      if (b.type === "thinking") {
        response.providerState();
        await response.thought(b.thinking || "");
      }
    }
    if (event.type === "content_block_delta") {
      const d = event.delta;
      const block = nativeBlocks.get(event.index);
      if (block) {
        if (d.type === "text_delta")
          block.text = (block.text || "") + (d.text || "");
        if (d.type === "thinking_delta")
          block.thinking = (block.thinking || "") + (d.thinking || "");
        if (d.type === "signature_delta")
          block.signature = (block.signature || "") + (d.signature || "");
      }
      if (d.type === "text_delta") {
        invariant(
          typeof d.text === "string",
          "Invalid Anthropic text delta",
          502,
        );
        await response.text(d.text);
      }
      if (d.type === "thinking_delta") {
        invariant(
          typeof d.thinking === "string",
          "Invalid Anthropic thinking delta",
          502,
        );
        await response.thought(d.thinking);
      }
      if (d.type === "signature_delta") {
        const p = output.content.find((p) => p.type === "thinking");
        if (p?.type === "thinking")
          p.signature = (p.signature || "") + (d.signature || "");
      }
      if (d.type === "input_json_delta") {
        const c = calls.get(event.index);
        invariant(c, "Arguments arrived before tool_use", 502);
        invariant(
          typeof d.partial_json === "string",
          "Invalid Anthropic argument delta",
          502,
        );
        c.json += d.partial_json;
        await response.toolArguments(c.id, d.partial_json);
      }
    }
    if (event.type === "message_delta") {
      response.usage(event.usage, true);
      if (event.delta?.stop_reason)
        response.finish(
          event.delta.stop_reason === "max_tokens"
            ? "length"
            : event.delta.stop_reason === "refusal"
              ? "error"
              : "stop",
        );
    }
    if (event.type === "error")
      throw new ProviderError(
        errorText(
          wireMember(event.error, "message") || "Anthropic streaming error",
        ),
        502,
        response.started,
      );
  },
  jsonEvents(input) {
    const value = anthropicJson.parse(input);
    return [
      { type: "message_start", message: value },
      ...(value.content || []).map((b: unknown, index: number) => ({
        type: "content_block_start",
        index,
        content_block: b,
      })),
      {
        type: "message_delta",
        delta: { stop_reason: value.stop_reason },
        usage: value.usage,
      },
    ];
  },
  finalize(response) {
    for (const [index, c] of response.calls) {
      const block = response.nativeBlocks.get(index);
      if (block?.type === "tool_use") block.input = parseArgs(c.json);
    }
    response.output.providerState = {
      protocol: response.protocol,
      routeId: response.routeId,
      items: [...response.nativeBlocks]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value),
    };
  },
};
