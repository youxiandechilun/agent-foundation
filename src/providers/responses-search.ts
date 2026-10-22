import type {
  ModelRequest,
  NativeWebSearchCall,
  NativeWebSearchResult,
  WebCitation,
} from "../runtime/types.js";
import type { Route } from "../core/config.js";

export const nativeWebSearchEnabled = (route: Route, request: ModelRequest) =>
  route.adapter === "openai-responses" &&
  route.nativeWebSearch &&
  request.nativeWebSearch === true &&
  request.toolChoice !== "none" &&
  (route.toolAllowlist.includes("*") ||
    route.toolAllowlist.includes("web_search"));

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function responsesOutputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return;
  const parts: string[] = [];
  for (const entry of value) {
    const item = object(entry);
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const entry of item.content) {
      const part = object(entry);
      if (part?.type === "output_text" && typeof part.text === "string")
        parts.push(part.text);
    }
  }
  return parts.length ? parts.join("") : undefined;
}
const index = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
const webUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
function citation(value: unknown): WebCitation | undefined {
  const a = object(value);
  if (
    a?.type !== "url_citation" ||
    !webUrl(a.url) ||
    typeof a.title !== "string" ||
    typeof a.start_index !== "number" ||
    !Number.isSafeInteger(a.start_index) ||
    typeof a.end_index !== "number" ||
    !Number.isSafeInteger(a.end_index) ||
    a.start_index < 0 ||
    a.end_index < a.start_index
  )
    return;
  return {
    url: a.url,
    title: a.title,
    startIndex: a.start_index,
    endIndex: a.end_index,
  };
}

interface SearchText {
  length: number;
  citations: Map<number, WebCitation>;
}
/** Normalizes JSON and SSE metadata once; repeated terminal items replace streamed snapshots. */
export class ResponsesWebSearch {
  private calls = new Map<number, NativeWebSearchCall>();
  private texts = new Map<number, Map<number, SearchText>>();
  private text(outputIndex: number, contentIndex: number) {
    let parts = this.texts.get(outputIndex);
    if (!parts) this.texts.set(outputIndex, (parts = new Map()));
    let part = parts.get(contentIndex);
    if (!part)
      parts.set(contentIndex, (part = { length: 0, citations: new Map() }));
    return part;
  }
  private item(value: unknown, outputIndex: number): boolean {
    const item = object(value);
    if (item?.type === "web_search_call" && typeof item.id === "string") {
      const call: NativeWebSearchCall = { id: item.id };
      if (typeof item.status === "string") call.status = item.status;
      const action = object(item.action);
      if (typeof action?.type === "string") {
        call.action = { type: action.type };
        if (typeof action.query === "string") call.action.query = action.query;
        if (
          Array.isArray(action.queries) &&
          action.queries.every((q): q is string => typeof q === "string")
        )
          call.action.queries = action.queries;
        if (webUrl(action.url)) call.action.url = action.url;
        if (Array.isArray(action.sources))
          call.action.sources = action.sources.flatMap((value) => {
            const source = object(value);
            return webUrl(source?.url)
              ? [
                  {
                    url: source.url,
                    ...(typeof source.title === "string"
                      ? { title: source.title }
                      : {}),
                  },
                ]
              : [];
          });
      }
      this.calls.set(outputIndex, call);
      return true;
    }
    if (item?.type === "message" && Array.isArray(item.content))
      for (const [contentIndex, value] of item.content.entries()) {
        const content = object(value);
        if (content?.type !== "output_text" || typeof content.text !== "string")
          continue;
        const part = this.text(outputIndex, contentIndex);
        part.length = content.text.length;
        if (Array.isArray(content.annotations)) {
          part.citations.clear();
          for (const [i, value] of content.annotations.entries()) {
            const a = citation(value);
            if (a) part.citations.set(i, a);
          }
        }
      }
    return item?.type === "web_search_call";
  }
  observe(value: unknown): boolean {
    const event = object(value);
    if (!event || typeof event.type !== "string") return false;
    const outputIndex = index(event.output_index),
      contentIndex = index(event.content_index);
    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    )
      this.text(outputIndex, contentIndex).length += event.delta.length;
    if (
      event.type === "response.output_text.done" &&
      typeof event.text === "string"
    )
      this.text(outputIndex, contentIndex).length = event.text.length;
    if (event.type === "response.output_text.annotation.added") {
      const a = citation(event.annotation);
      if (a)
        this.text(outputIndex, contentIndex).citations.set(
          index(event.annotation_index),
          a,
        );
    }
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    )
      return this.item(event.item, outputIndex);
    if (event.type.startsWith("response.web_search_call.")) {
      if (typeof event.item_id === "string") {
        const previous = this.calls.get(outputIndex);
        this.calls.set(outputIndex, {
          ...previous,
          id: event.item_id,
          status: event.type.slice("response.web_search_call.".length),
        });
      }
      return true;
    }
    const response = object(event.response);
    let searched = false;
    if (
      ["response.completed", "response.incomplete", "response.failed"].includes(
        event.type,
      ) &&
      Array.isArray(response?.output)
    ) {
      const messageIndices = new Set(
        response.output.flatMap((item, i) =>
          object(item)?.type === "message" ? [i] : [],
        ),
      );
      if (messageIndices.size)
        for (const i of this.texts.keys())
          if (!messageIndices.has(i)) this.texts.delete(i);
      for (const [i, item] of response.output.entries())
        searched = this.item(item, i) || searched;
    }
    return searched;
  }
  result(): NativeWebSearchResult | undefined {
    const citations: WebCitation[] = [];
    let offset = 0;
    for (const [, parts] of [...this.texts].sort(([a], [b]) => a - b))
      for (const [, part] of [...parts].sort(([a], [b]) => a - b)) {
        for (const [, a] of [...part.citations].sort(([a], [b]) => a - b))
          if (a.endIndex <= part.length)
            citations.push({
              ...a,
              startIndex: offset + a.startIndex,
              endIndex: offset + a.endIndex,
            });
        offset += part.length;
      }
    const calls = [
      ...new Map(
        [...this.calls].sort(([a], [b]) => a - b).map(([, c]) => [c.id, c]),
      ).values(),
    ];
    return calls.length || citations.length ? { calls, citations } : undefined;
  }
}
