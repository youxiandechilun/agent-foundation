import type { Route } from "../core/config.js";
import type { Message, ToolDefinition } from "./types.js";
import { invariant } from "../core/util.js";
export const estimateTextTokens = (text: string) =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 2);
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(estimateTokenBytes(messages) / 2);
}
/** Unrounded weight lets context selection combine groups without rounding drift. */
export function estimateTokenBytes(messages: Message[]): number {
  let images = 0;
  const serialized = JSON.stringify(messages, (_key, value) => {
    if (value?.type === "image") {
      images++;
      return { type: "image" };
    }
    return value;
  });
  return Buffer.byteLength(serialized, "utf8") + images * 8192;
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
