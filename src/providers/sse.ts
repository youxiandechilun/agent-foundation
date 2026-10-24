import { AppError, errorText, invariant } from "../core/util.js";
import { wireMember } from "../core/wire.js";
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
  try {
    yield* decodeEventStream(response.body, {
      signal,
      maxBytes: 32 * 1024 * 1024,
      maxFrameChars: 2 * 1024 * 1024,
      error: (message) =>
        new ProviderError(message, 502, false, false, undefined, {
          reason: "protocol",
        }),
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(errorText(error), 502, false, false, undefined, {
      reason: signal?.aborted ? "cancelled" : "stream_interrupted",
    });
  }
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
/** Only transport failures can resume a model step after partial output. */
export type ProviderFailureReason =
  | "http"
  | "network"
  | "timeout"
  | "stream_interrupted"
  | "protocol"
  | "consumer"
  | "cancelled";
export interface ProviderErrorOptions {
  reason?: ProviderFailureReason;
  /** Provider-hosted tools may already have caused a billed remote effect. */
  nativeActivity?: boolean;
  /** Explicit semantic rejection (for example exhausted credit), never retried. */
  retryable?: boolean;
}
export class ProviderError extends AppError {
  partial?: AssistantMessage;
  requestSent?: boolean;
  reason: ProviderFailureReason;
  nativeActivity: boolean;
  retryable: boolean;
  constructor(
    message: string,
    public upstreamStatus = 502,
    public started = false,
    public contextOverflow = false,
    /** Server-requested delay from Retry-After / retry-after-ms, when present. */
    public retryAfterMs?: number,
    options: ProviderErrorOptions = {},
  ) {
    super(502, "provider_error", message);
    this.reason = options.reason ?? "http";
    this.nativeActivity = options.nativeActivity ?? false;
    this.retryable =
      options.retryable ??
      !["protocol", "consumer", "cancelled"].includes(this.reason);
  }
}
export type RecoverableProviderError = ProviderError & {
  reason: "network" | "timeout" | "stream_interrupted";
};
/** This never authorizes replaying tools or retrying an entire user run. */
export function canRecoverProviderError(
  error: unknown,
): error is RecoverableProviderError {
  return (
    error instanceof ProviderError &&
    error.retryable &&
    !error.contextOverflow &&
    !error.nativeActivity &&
    error.partial?.stopReason !== "aborted" &&
    !error.partial?.webSearch?.calls.length &&
    ["network", "timeout", "stream_interrupted"].includes(error.reason)
  );
}
const exhaustedQuotaCodes = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "billing_not_active",
  "insufficient_balance",
  "credit_balance_too_low",
]);
function providerErrorCodes(value: unknown): string[] {
  return [wireMember(value, "code"), wireMember(value, "type")].filter(
    (code): code is string => typeof code === "string",
  );
}
/** Structured provider codes only; error prose must not control retries. */
export function exhaustedProviderQuota(value: unknown): boolean {
  return providerErrorCodes(value).some((code) =>
    exhaustedQuotaCodes.has(code),
  );
}
const permanentStreamCodes = new Set([
  ...exhaustedQuotaCodes,
  "invalid_request_error",
  "invalid_request",
  "invalid_argument",
  "authentication_error",
  "invalid_api_key",
  "permission_error",
  "permission_denied",
  "insufficient_permissions",
  "access_denied",
  "model_not_found",
  "not_found_error",
  "unsupported_parameter",
  "context_length_exceeded",
  "max_context_length_exceeded",
  "prompt_too_long",
  "content_policy_violation",
  "content_filter",
  "request_too_large",
  "account_deactivated",
  "account_disabled",
  "billing_error",
  "payment_required",
]);
const transientStreamStatuses = new Map([
  ["server_error", 503],
  ["internal_server_error", 503],
  ["api_error", 503],
  ["overloaded_error", 529],
  ["rate_limit_error", 429],
  ["rate_limit_exceeded", 429],
  ["service_unavailable", 503],
]);
/** Explicit semantic stream failures never masquerade as a truncated transport. */
export function providerStreamError(
  value: unknown,
  started: boolean,
): ProviderError {
  const codes = providerErrorCodes(value);
  const permanent = codes.some((code) => permanentStreamCodes.has(code));
  const status = permanent
    ? exhaustedProviderQuota(value)
      ? 402
      : 400
    : codes
        .map((code) => transientStreamStatuses.get(code))
        .find((code) => code !== undefined);
  const detail = wireMember(value, "message");
  return new ProviderError(
    typeof detail === "string" ? errorText(detail) : "Provider streaming error",
    status ?? 502,
    started,
    codes.some((code) =>
      [
        "context_length_exceeded",
        "max_context_length_exceeded",
        "prompt_too_long",
      ].includes(code),
    ),
    undefined,
    {
      reason: status === undefined ? "protocol" : "http",
      retryable: !permanent && status !== undefined,
    },
  );
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
