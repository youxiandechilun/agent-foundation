import type { MediaRequest } from "../contracts.js";
import { invariant } from "../core/util.js";

/** Billable media quantity, from the normalized request or the adapter's report. */
export interface MediaUnits {
  kind: "image" | "video";
  count: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/** Token counts with input excluding cache tokens, whatever the wire protocol reports. */
export interface BillingTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One provider call the kernel is about to make or has made. */
export interface BillingCharge {
  /** Stable cost-ledger entry ID; use it as the idempotency key. */
  id: string;
  /** Host-assigned account of the project, if any. */
  account?: string;
  purpose: string;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  routeId: string;
  kind: "text" | "image" | "video" | "embedding";
  model: string;
  adapter: string;
  /** Kernel upper bound in USD micros from route pricing; 0 when the route is unpriced. */
  reservedMicros: number;
  /** Media estimate taken from the normalized request. */
  units?: MediaUnits;
}

export interface BillingOutcome {
  /** settled: the provider reported usage; void: nothing was sent; unknown: the outcome is unclear. */
  status: "settled" | "void" | "unknown";
  tokens?: BillingTokens;
  units?: MediaUnits;
  /** Kernel price in USD micros when the route is priced. */
  chargedMicros?: number;
  reference?: string;
}

/**
 * Host billing, such as prepaid credits. `authorize` runs before every model,
 * embedding and media call and may throw to refuse it. `record` reports the final
 * outcome; it can repeat for one charge with the latest values and after a
 * restart, so apply it idempotently by `charge.id`.
 */
export interface BillingProvider {
  authorize(charge: BillingCharge, signal?: AbortSignal): void | Promise<void>;
  record(charge: BillingCharge, outcome: BillingOutcome): void | Promise<void>;
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Units implied by a normalized media request; count defaults to one output. */
export function requestUnits(request: MediaRequest): MediaUnits {
  const p = request.parameters;
  return {
    kind: request.kind,
    count:
      Number.isSafeInteger(p.count) && (p.count as number) > 0
        ? (p.count as number)
        : 1,
    ...(positive(p.width) ? { width: p.width } : {}),
    ...(positive(p.height) ? { height: p.height } : {}),
    ...(positive(p.durationSeconds)
      ? { durationSeconds: p.durationSeconds }
      : {}),
  };
}

/** Validate units reported by an adapter or plugin before they reach billing. */
export function checkUnits(
  units: unknown,
  kind: MediaUnits["kind"],
): MediaUnits {
  const u = units as Partial<MediaUnits> | null;
  invariant(
    u !== null &&
      typeof u === "object" &&
      u.kind === kind &&
      Number.isSafeInteger(u.count) &&
      u.count! > 0 &&
      u.count! <= 10000 &&
      (["width", "height", "durationSeconds"] as const).every(
        (key) => u[key] === undefined || positive(u[key]),
      ),
    "Invalid media billing units",
    502,
  );
  return {
    kind,
    count: u.count!,
    ...(u.width === undefined ? {} : { width: u.width }),
    ...(u.height === undefined ? {} : { height: u.height }),
    ...(u.durationSeconds === undefined
      ? {}
      : { durationSeconds: u.durationSeconds }),
  };
}
