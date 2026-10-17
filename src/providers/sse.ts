import { AppError, invariant } from "../util.js";

export interface ServerEvent {
  event?: string;
  data: string;
  id?: string;
}
/** Incremental SSE decoder: CRLF, split UTF-8, multi-line data and bounded frames. */
export async function* sse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ServerEvent> {
  invariant(response.body, "Provider returned no response body", 502);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    total = 0;
  const parse = (frame: string): ServerEvent => {
    const result: ServerEvent = { data: "" };
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon),
        value = line.slice(colon + 1).replace(/^ /, "");
      if (key === "data") data.push(value);
      else if (key === "event") result.event = value;
      else if (key === "id") result.id = value;
    }
    result.data = data.join("\n");
    return result;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      total += value.byteLength;
      invariant(
        total <= 32 * 1024 * 1024,
        "Provider stream exceeds 32 MiB",
        502,
      );
      buffer += decoder.decode(value, { stream: true });
      // Normalize only complete CRLF pairs; retain a trailing CR until the next chunk.
      buffer = buffer.replaceAll("\r\n", "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        invariant(
          frame.length <= 2 * 1024 * 1024,
          "SSE frame exceeds limit",
          502,
        );
        const event = parse(frame);
        if (event.data) yield event;
      }
      invariant(
        buffer.length <= 2 * 1024 * 1024,
        "Incomplete SSE frame exceeds limit",
        502,
      );
    }
    if (buffer.trim()) {
      const event = parse(buffer);
      if (event.data) yield event;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function readJson(
  response: Response,
  max = 8 * 1024 * 1024,
): Promise<any> {
  invariant(response.body, "Response body is missing", 502);
  const reader = response.body.getReader();
  let size = 0;
  const parts: Buffer[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      invariant(size <= max, "JSON response exceeds limit", 502);
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export class ProviderError extends AppError {
  constructor(
    message: string,
    public upstreamStatus = 502,
    public started = false,
    public contextOverflow = false,
    /** Server-requested delay from Retry-After / retry-after-ms, when present. */
    public retryAfterMs?: number,
  ) {
    super(502, "provider_error", message);
  }
}
/** Upstream statuses that are worth retrying when no output was streamed yet. */
export const TRANSIENT_STATUSES = new Set([
  408, 409, 429, 500, 502, 503, 504, 529,
]);
/** Parses retry-after-ms, then Retry-After (delta seconds or HTTP date). */
export function retryAfter(headers: Headers, at = Date.now()) {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") && Number.isFinite(ms) && ms >= 0)
    return ms;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - at);
}
