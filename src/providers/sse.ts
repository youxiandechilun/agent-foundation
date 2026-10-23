import { AppError, invariant } from "../core/util.js";
import { decodeEventStream } from "../transport/sse.js";
import type { ServerEvent } from "../transport/sse.js";
import type { AssistantMessage } from "../runtime/types.js";
export type { ServerEvent } from "../transport/sse.js";

/** Incremental SSE decoder: CRLF, split UTF-8, multi-line data and bounded frames. */
export async function* sse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ServerEvent> {
  invariant(response.body, "Provider returned no response body", 502);
  yield* decodeEventStream(response.body, {
    signal,
    maxBytes: 32 * 1024 * 1024,
    maxFrameChars: 2 * 1024 * 1024,
    error: (message) => new AppError(502, "invalid_request", message),
  });
}
export async function readJson(
  response: Response,
  max = 8 * 1024 * 1024,
): Promise<unknown> {
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
  partial?: AssistantMessage;
  requestSent?: boolean;
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
