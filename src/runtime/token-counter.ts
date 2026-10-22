import type { Route } from "../core/config.js";
import type { Message, ToolDefinition } from "./types.js";
import { invariant } from "../core/util.js";
export const estimateTextTokens = (text: string) =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 2);
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(estimateTokenBytes(messages) / 2);
}
// History messages are never mutated once committed, so each is serialized once
// for estimation rather than once per model step.
const messageBytes = new WeakMap<Message, number>();
function messageWeight(message: Message): number {
  let bytes = messageBytes.get(message);
  if (bytes === undefined) {
    let images = 0;
    const serialized = JSON.stringify(message, (_key, value) => {
      if (value?.type === "image") {
        images++;
        return { type: "image" };
      }
      return value;
    });
    bytes = Buffer.byteLength(serialized, "utf8") + images * 8192;
    messageBytes.set(message, bytes);
  }
  return bytes;
}
/**
 * Unrounded weight lets context selection combine groups without rounding drift.
 * Equals the UTF-8 length of the serialized array: brackets, commas and elements.
 */
export function estimateTokenBytes(messages: Message[]): number {
  let bytes = 1;
  for (const message of messages) bytes += messageWeight(message) + 1;
  return messages.length ? bytes : 2;
}
// Tool definitions are snapshots that do not change during a run; weigh each once.
const toolBytes = new WeakMap<ToolDefinition, number>();
/** UTF-8 length of JSON.stringify of the tools' name, description and parameters. */
function toolListBytes(tools: readonly ToolDefinition[]): number {
  let bytes = tools.length ? 1 + tools.length : 2;
  for (const tool of tools) {
    let weight = toolBytes.get(tool);
    if (weight === undefined) {
      weight = Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
        "utf8",
      );
      toolBytes.set(tool, weight);
    }
    bytes += weight;
  }
  return bytes;
}
/** Estimated tokens of the tools' name, description and parameters as JSON. */
export function estimateToolTokens(tools: readonly ToolDefinition[]): number {
  return Math.ceil(toolListBytes(tools) / 2);
}
export interface TokenCounter {
  id: string;
  precision: "exact" | "estimate";
  count: (request: {
    routeId: string;
    route: Route;
    messages: Message[];
    tools: ToolDefinition[];
  }) => number | Promise<number>;
}
export class TokenCounterRegistry {
  private entries = new Map<string, TokenCounter>();
  register(counter: TokenCounter) {
    invariant(
      counter.id.length > 0 && !this.entries.has(counter.id),
      "Duplicate token counter ID",
    );
    this.entries.set(counter.id, counter);
    return () =>
      this.entries.get(counter.id) === counter &&
      this.entries.delete(counter.id);
  }
  get(id: string) {
    return this.entries.get(id);
  }
  list() {
    return [...this.entries.values()].map((c) => ({
      id: c.id,
      precision: c.precision,
    }));
  }
}
