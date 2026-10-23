import type { Config, Route } from "../core/config.js";
import type { AssistantMessage, ModelRequest, Usage } from "./types.js";
import type { Project } from "../contracts.js";
import { Store } from "../storage/store.js";
import type { EntityPage } from "../storage/entity-query.js";
import { AppError, errorText, id, invariant, now } from "../core/util.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  defaultTextProtocols,
  type TextProtocolRegistry,
} from "../providers/registry.js";
import { nativeWebSearchEnabled } from "../providers/responses-search.js";
import type {
  BillingCharge,
  BillingOutcome,
  BillingProvider,
  BillingTokens,
  BillingDeliveryOptions,
  BillingDeliveryStatus,
  MediaUnits,
} from "./billing.js";

export interface CostScope {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  purpose: string;
}
export interface CostEntry extends CostScope {
  id: string;
  routeId: string;
  model: string;
  pricing?: Route["pricing"];
  adapter: Route["adapter"];
  kind?: Route["kind"];
  /** Host account of the project when the charge was reserved. */
  account?: string;
  units?: MediaUnits;
  /** Delivery to the host billing provider; absent when none is installed. */
  billing?: {
    state: "authorizing" | "authorized" | "recorded" | "failed";
    error?: string;
    deliveryId?: string;
    revision?: number;
  };
  endpoint: string;
  responseId?: string;
  reference?: string;
  status: "reserved" | "settled" | "unknown" | "void";
  reservedMicros: number;
  chargedMicros?: number;
  basis: "provider-usage" | "unpriced" | "reservation" | "operator";
  usage?: Usage;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Token usage alone cannot settle provider-hosted tool charges. */
  requiresReconciliation?: boolean;
}
const micros = (usd: number) => {
  invariant(
    Number.isFinite(usd) && usd >= 0 && usd <= 1e9,
    "Invalid USD amount",
  );
  return Math.ceil(usd * 1e6);
};
/** Provider usage with input excluding cache tokens, per the route's wire protocol. */
export function billingTokens(
  adapter: string,
  u: Usage,
  protocols: TextProtocolRegistry = defaultTextProtocols,
): BillingTokens {
  invariant(
    validUsage(adapter, u, protocols),
    "Invalid provider usage: token counts or inclusive cache totals are inconsistent",
    502,
  );
  return {
    input:
      protocols.find(adapter)?.inputIncludesCache === false
        ? u.input
        : u.input - u.cacheRead - u.cacheWrite,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
  };
}

function validUsage(
  adapter: string,
  usage: Usage,
  protocols: TextProtocolRegistry,
): boolean {
  return (
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    (protocols.find(adapter)?.inputIncludesCache === false ||
      usage.cacheRead <= usage.input - usage.cacheWrite)
  );
}

/** Pure validation shared by standalone ledgers and Kernel's preflight. */
export function billingDeliveryOptions(
  options: BillingDeliveryOptions = {},
): Required<BillingDeliveryOptions> {
  const validated = {
    concurrency: options.concurrency ?? 8,
    timeoutMs: options.timeoutMs ?? 30000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5000,
  };
  for (const [name, value] of Object.entries(validated))
    invariant(
      Number.isSafeInteger(value) &&
        value > 0 &&
        value <= (name === "concurrency" ? 128 : 3600000),
      "Invalid billing delivery option",
    );
  return validated;
}
export class CostLedger {
  private scopes = new AsyncLocalStorage<CostScope>();
  private readonly deliveries = new Map<
    string,
    {
      done: Promise<void>;
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly deliveryOptions: Required<BillingDeliveryOptions>;
  private pumpScheduled = false;
  private closed = false;
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly billing?: BillingProvider,
    deliveryOptions: BillingDeliveryOptions = {},
    readonly protocols: TextProtocolRegistry = defaultTextProtocols,
  ) {
    this.deliveryOptions = billingDeliveryOptions(deliveryOptions);
  }
  withScope<T>(scope: CostScope, operation: () => T): T {
    return this.scopes.run(scope, operation);
  }
  recover() {
    this.store.transaction(() => {
      // An incomplete authorization cannot have submitted a provider request.
      this.store
        .prepare(
          "UPDATE e_cost_ledger SET body=json_set(body,'$.status','void','$.billing.state','authorized','$.error','Host authorization was interrupted; provider request was not submitted','$.updatedAt',?) WHERE json_extract(body,'$.billing.state')='authorizing'",
        )
        .run(now());
      this.store
        .prepare(
          "UPDATE e_cost_ledger SET body=json_set(body,'$.status','unknown','$.error','Interrupted request; charge requires reconciliation','$.updatedAt',?) WHERE json_extract(body,'$.status')='reserved'",
        )
        .run(now());
      if (!this.billing) return;
      // Upgrade legacy pending deliveries once; restarts keep the same revision.
      this.store
        .prepare(
          "UPDATE e_cost_ledger SET body=json_set(body,'$.billing.revision',COALESCE(json_extract(body,'$.billing.revision'),1),'$.billing.deliveryId',COALESCE(json_extract(body,'$.billing.deliveryId'),lower(hex(randomblob(16))))) WHERE json_extract(body,'$.billing.state') IN ('authorized','failed') AND json_extract(body,'$.status')<>'reserved'",
        )
        .run();
      // Rebuild durable work in SQL; a backlog never becomes an array of JS records.
      this.store
        .prepare(
          "INSERT INTO billing_deliveries(charge_id,delivery_id) SELECT id,json_extract(body,'$.billing.deliveryId') FROM e_cost_ledger WHERE json_extract(body,'$.billing.state') IN ('authorized','failed') AND json_extract(body,'$.status')<>'reserved' ORDER BY seq ON CONFLICT(charge_id) DO NOTHING",
        )
        .run();
    });
    this.scheduleDeliveries();
  }
  /** Query delivery acknowledgement, independently of financial reconciliation. */
  deliveryStatus(): BillingDeliveryStatus {
    const counts = this.store
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN json_extract(body,'$.billing.state') IN ('authorizing','authorized') THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN json_extract(body,'$.billing.state')='failed' THEN 1 ELSE 0 END),0) AS failed FROM e_cost_ledger",
      )
      .get() as { pending: number; failed: number };
    return { ...counts, active: this.deliveries.size };
  }
  /** Wait up to the deadline and return acknowledgement counts; failed work retries on recovery. */
  async drain(
    timeoutMs = this.deliveryOptions.shutdownTimeoutMs,
  ): Promise<BillingDeliveryStatus> {
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 3600000,
      "Invalid billing drain timeout",
    );
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && !this.store.isClosed) {
      this.pumpDeliveries();
      if (!this.deliveries.size || Date.now() >= deadline)
        return this.deliveryStatus();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(
            [...this.deliveries.values()].map((item) => item.done),
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return this.deliveryStatus();
  }
  /** Stop scheduling before the store closes; callbacks that ignore abort cannot delay shutdown. */
  async close() {
    if (this.closed) return;
    await this.drain();
    this.closed = true;
    for (const delivery of this.deliveries.values()) {
      clearTimeout(delivery.timer);
      delivery.controller.abort(new Error("Billing delivery is closing"));
    }
  }
  private update(key: string, patch: Partial<CostEntry>) {
    return this.store.put("cost-ledger", {
      ...this.store.get<CostEntry>("cost-ledger", key),
      ...patch,
      updatedAt: now(),
    });
  }
  /** Commit an outcome and its outbox revision together, including reconciliation. */
  private updateOutcome(key: string, patch: Partial<CostEntry>): CostEntry {
    return this.store.transaction(() => {
      this.deliver(this.update(key, patch));
      return this.store.get<CostEntry>("cost-ledger", key);
    });
  }
  entries(filter: Partial<CostScope> = {}) {
    return this.store.list<CostEntry>("cost-ledger", filter);
  }
  /**
   * Totals are aggregated in SQLite over every matching entry; only one page of
   * entries (oldest first, 1000 by default) is materialized.
   */
  summary(filter: Partial<CostScope> = {}, page: EntityPage = {}) {
    const totals = this.store.costTotals(filter);
    const entries = this.store.list<CostEntry>("cost-ledger", filter, {
      limit: 1000,
      ...page,
    });
    return {
      currency: "USD",
      committedMicros: totals.committedMicros,
      committedUsd: totals.committedMicros / 1e6,
      chargedMicros: totals.chargedMicros,
      heldMicros: totals.heldMicros,
      unpriced: totals.unpriced,
      entryCount: totals.count,
      entries,
    };
  }
  reserve(
    routeId: string,
    route: Route,
    scope: CostScope,
    amountMicros: number,
    units?: MediaUnits,
  ) {
    const inherited = this.scopes.getStore();
    invariant(
      !inherited?.projectId ||
        !scope.projectId ||
        inherited.projectId === scope.projectId,
      "Cost operation changed project scope",
      403,
    );
    scope = {
      ...inherited,
      ...Object.fromEntries(
        Object.entries(scope).filter(([, v]) => v !== undefined),
      ),
    } as CostScope;
    invariant(
      Number.isSafeInteger(amountMicros) && amountMicros >= 0,
      "Invalid reservation",
    );
    if (scope.runId) {
      const session = this.store.session(this.store.run(scope.runId).sessionId);
      invariant(
        scope.sessionId === session.id && scope.projectId === session.projectId,
        "Cost scope does not match run",
        403,
      );
    }
    if (scope.sessionId)
      invariant(
        this.store.session(scope.sessionId).projectId === scope.projectId,
        "Cost project mismatch",
        403,
      );
    return this.store.transaction(() => {
      if (this.config.budgets.enabled) {
        invariant(
          route.pricing,
          `Pricing required for route ${routeId}`,
          402,
          "pricing_required",
        );
        const b = this.config.budgets;
        const limits = [
          {
            name: "run",
            limit: scope.runId ? b.maxRunUsd : undefined,
            filter: { runId: scope.runId },
          },
          {
            name: "session",
            limit: scope.sessionId ? b.maxSessionUsd : undefined,
            filter: { sessionId: scope.sessionId },
          },
          {
            name: "project",
            limit: scope.projectId ? b.maxProjectUsd : undefined,
            filter: { projectId: scope.projectId },
          },
          { name: "day", limit: b.maxDayUsd, day: now().slice(0, 10) },
          { name: "total", limit: b.maxTotalUsd },
        ];
        for (const { name, limit, filter, day } of limits) {
          if (limit === undefined) continue;
          const used = this.store.committedCost(filter, day);
          invariant(
            used + amountMicros <= micros(limit),
            `${name} cost budget exhausted`,
            402,
            "cost_budget_exhausted",
          );
        }
      }
      const entry: CostEntry = {
        id: id("charge"),
        routeId,
        model: route.model,
        adapter: route.adapter,
        endpoint: route.baseUrl,
        kind: route.kind,
        ...scope,
        ...(scope.projectId
          ? {
              account: this.store.find<Project>("projects", scope.projectId)
                ?.billingAccount,
            }
          : {}),
        ...(units ? { units } : {}),
        pricing: route.pricing ? structuredClone(route.pricing) : undefined,
        status: "reserved",
        reservedMicros: amountMicros,
        basis: route.pricing ? "reservation" : "unpriced",
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.put("cost-ledger", entry);
      if (scope.runId) this.store.emit(scope.runId, "cost.reserved", { entry });
      return entry;
    });
  }
  async text(
    routeId: string,
    route: Route,
    request: ModelRequest,
    scope: CostScope,
    operation: () => Promise<AssistantMessage>,
    signal?: AbortSignal,
  ) {
    const p = route.pricing,
      nativeSearch = nativeWebSearchEnabled(route, request),
      output = Math.min(
        request.maxOutputTokens || route.maxOutputTokens,
        route.maxOutputTokens,
      );
    // Reserve the model's maximum input window; an estimated tokenizer is not a hard financial bound.
    const inputRate = Math.max(
      p?.inputPerMillion || 0,
      p?.cacheReadPerMillion ?? p?.inputPerMillion ?? 0,
      p?.cacheWritePerMillion ?? p?.inputPerMillion ?? 0,
    );
    const tokenBound =
      Math.ceil(
        route.contextWindow * inputRate + output * (p?.outputPerMillion || 0),
      ) + micros(p?.requestUsd || 0);
    invariant(
      !nativeSearch ||
        !this.config.budgets.enabled ||
        p?.maxRequestUsd !== undefined,
      "Native web search maxRequestUsd is required with cost budgets",
      402,
      "pricing_required",
    );
    const bound = nativeSearch
      ? Math.max(tokenBound, micros(p?.maxRequestUsd || 0))
      : tokenBound;
    const reservation = this.reserve(routeId, route, scope, bound);
    // Keep this requirement durable before the provider can start a billed effect.
    const entry = await this.authorize(
      nativeSearch
        ? this.update(reservation.id, { requiresReconciliation: true })
        : reservation,
      signal,
    );
    try {
      const result = await operation();
      if (nativeSearch)
        this.updateOutcome(entry.id, {
          status: "unknown",
          requiresReconciliation: true,
          usage: result.usage,
          ...(result.responseId ? { responseId: result.responseId } : {}),
          error: "Provider-hosted web search charges require reconciliation",
        });
      else this.settleUsage(entry.id, route, result.usage, result.responseId);
      return result;
    } catch (error) {
      const current = this.store.get<CostEntry>("cost-ledger", entry.id);
      if (current.status !== "settled")
        this.updateOutcome(entry.id, {
          status:
            error &&
            typeof error === "object" &&
            "requestSent" in error &&
            error.requestSent === false
              ? "void"
              : "unknown",
          error: "No conclusive terminal usage received",
        });
      throw error;
    }
  }
  settleUsage(key: string, _route: Route, u: Usage, responseId?: string) {
    const entry = this.store.get<CostEntry>("cost-ledger", key),
      p = entry.pricing,
      response = responseId ? { responseId } : {};
    if (u.reported && !validUsage(entry.adapter, u, this.protocols))
      return this.updateOutcome(key, {
        status: "unknown",
        usage: u,
        ...response,
        requiresReconciliation: true,
        error:
          "Invalid provider usage: token counts or inclusive cache totals are inconsistent",
      });
    if (!u.reported || !p) {
      return this.updateOutcome(key, {
        status: "unknown",
        usage: u,
        ...response,
      });
    }
    const uncached = billingTokens(entry.adapter, u, this.protocols).input;
    const chargedMicros =
      Math.ceil(
        uncached * p.inputPerMillion +
          u.output * p.outputPerMillion +
          u.cacheRead * (p.cacheReadPerMillion ?? p.inputPerMillion) +
          u.cacheWrite * (p.cacheWritePerMillion ?? p.inputPerMillion),
      ) + micros(p.requestUsd);
    return this.settle(
      entry,
      { chargedMicros, usage: u, ...response },
      "Provider charge exceeded the configured reservation; no further tools were dispatched",
    );
  }
  private settle(
    entry: CostEntry,
    charge: Pick<CostEntry, "usage" | "reference" | "units" | "responseId"> & {
      chargedMicros: number;
    },
    exceededMessage: string,
  ) {
    const settled = this.updateOutcome(entry.id, {
      ...charge,
      status: "settled",
      basis: "provider-usage",
    });
    if (entry.runId)
      this.store.emit(entry.runId, "cost.settled", {
        entry: settled,
        ...(charge.reference === undefined
          ? {}
          : { reference: charge.reference }),
        exceededReservation: charge.chargedMicros > entry.reservedMicros,
      });
    invariant(
      !this.config.budgets.enabled ||
        charge.chargedMicros <= entry.reservedMicros,
      exceededMessage,
      402,
      "cost_reservation_exceeded",
    );
    return settled;
  }
  reserveMedia(
    routeId: string,
    route: Route,
    scope: CostScope,
    units?: MediaUnits,
  ) {
    invariant(
      !this.config.budgets.enabled ||
        route.pricing?.maxRequestUsd !== undefined,
      "Media maxRequestUsd is required with cost budgets",
      402,
      "pricing_required",
    );
    return this.reserve(
      routeId,
      route,
      scope,
      micros(route.pricing?.maxRequestUsd ?? route.pricing?.requestUsd ?? 0),
      units,
    );
  }
  unknown(key: string) {
    const entry = this.store.get<CostEntry>("cost-ledger", key);
    // Settled and refused (void) charges keep their conclusive outcome.
    if (entry.status === "settled" || entry.status === "void") return entry;
    return this.updateOutcome(key, { status: "unknown" });
  }
  /** Only cancel a queued reservation before host authorization/provider submission. */
  voidUnsubmitted(
    key: string,
    reason = "Queued request cancelled before submission",
  ) {
    const entry = this.store.get<CostEntry>("cost-ledger", key);
    invariant(
      entry.status === "reserved" && !entry.billing,
      "Cannot void an authorized or submitted charge",
      409,
    );
    return this.update(key, { status: "void", error: reason });
  }
  /**
   * Ask the host before submission. Any failed authorization durably reports
   * void, including an ambiguous transport error after the host reserved funds.
   */
  async authorize(
    charge: CostEntry | string,
    signal?: AbortSignal,
  ): Promise<CostEntry> {
    signal?.throwIfAborted();
    invariant(
      !this.closed && !this.store.isClosed,
      "Billing delivery is closed",
      503,
    );
    const entry = this.store.get<CostEntry>(
      "cost-ledger",
      typeof charge === "string" ? charge : charge.id,
    );
    invariant(
      entry.status === "reserved" && !entry.billing,
      "Charge authorization was already attempted or the charge is terminal",
      409,
    );
    if (!this.billing) return entry;
    this.update(entry.id, { billing: { state: "authorizing" } });
    const voidAuthorization = (reason: string) =>
      this.updateOutcome(entry.id, {
        status: "void",
        billing: { state: "authorized" },
        error: reason,
      });
    try {
      await this.billing.authorize(this.charge(entry), signal);
    } catch (error) {
      // The callback may ignore cancellation and settle after its owner/store closes.
      if (this.closed || this.store.isClosed) throw error;
      if (signal?.aborted) {
        voidAuthorization(
          "Host authorization was interrupted; provider request was not submitted",
        );
        signal.throwIfAborted();
      }
      voidAuthorization(`Billing refused: ${errorText(error)}`);
      throw new AppError(
        402,
        "billing_refused",
        `Billing refused: ${errorText(error)}`,
      );
    }
    if (this.closed || this.store.isClosed) {
      signal?.throwIfAborted();
      throw new AppError(503, "billing_closed", "Billing delivery is closed");
    }
    if (signal?.aborted) {
      voidAuthorization(
        "Host authorization was interrupted; provider request was not submitted",
      );
      signal.throwIfAborted();
    }
    return this.update(entry.id, { billing: { state: "authorized" } });
  }
  private charge(entry: CostEntry): BillingCharge {
    return {
      id: entry.id,
      ...(entry.account === undefined ? {} : { account: entry.account }),
      purpose: entry.purpose,
      ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      routeId: entry.routeId,
      kind: entry.kind ?? "text",
      model: entry.model,
      adapter: entry.adapter,
      reservedMicros: entry.reservedMicros,
      ...(entry.units ? { units: entry.units } : {}),
    };
  }
  /** Report a final outcome to the host; failures stay marked for redelivery on restart. */
  private deliver(entry: CostEntry) {
    if (
      !this.billing ||
      !entry.billing ||
      entry.status === "reserved" ||
      entry.billing.state === "authorizing"
    )
      return;
    const deliveryId = id("billing-delivery");
    this.store.transaction(() => {
      const current = this.store.get<CostEntry>("cost-ledger", entry.id);
      const revision = (current.billing?.revision ?? 0) + 1;
      invariant(Number.isSafeInteger(revision), "Billing revision overflow");
      this.update(entry.id, {
        billing: { state: "authorized", deliveryId, revision },
      });
      this.store
        .prepare(
          "INSERT INTO billing_deliveries(charge_id,delivery_id) VALUES(?,?) ON CONFLICT(charge_id) DO UPDATE SET delivery_id=excluded.delivery_id",
        )
        .run(entry.id, deliveryId);
    });
    this.scheduleDeliveries();
  }
  private scheduleDeliveries() {
    if (
      this.closed ||
      this.store.isClosed ||
      this.pumpScheduled ||
      !this.billing
    )
      return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pumpDeliveries();
    });
  }
  private pumpDeliveries() {
    if (this.closed || this.store.isClosed || !this.billing) return;
    const available = this.deliveryOptions.concurrency - this.deliveries.size;
    if (available <= 0) return;
    const active = [...this.deliveries.keys()];
    const rows = this.store
      .prepare(
        `SELECT charge_id,delivery_id FROM billing_deliveries${active.length ? ` WHERE charge_id NOT IN (${active.map(() => "?").join(",")})` : ""} ORDER BY seq LIMIT ?`,
      )
      .all(...active, available) as {
      charge_id: string;
      delivery_id: string;
    }[];
    for (const row of rows) {
      const entry = this.store.find<CostEntry>("cost-ledger", row.charge_id);
      if (!entry?.billing || entry.status === "reserved") {
        this.store
          .prepare(
            "DELETE FROM billing_deliveries WHERE charge_id=? AND delivery_id=?",
          )
          .run(row.charge_id, row.delivery_id);
        this.scheduleDeliveries();
        continue;
      }
      this.startDelivery(entry, row.delivery_id);
    }
  }
  private startDelivery(entry: CostEntry, deliveryId: string) {
    const revision = entry.billing?.revision ?? 1;
    this.update(entry.id, {
      billing: { state: "authorized", deliveryId, revision },
    });
    const markDelivery = (state: "recorded" | "failed", error?: string) => {
      if (this.closed || this.store.isClosed) return;
      const current = this.store.find<CostEntry>("cost-ledger", entry.id);
      if (current?.billing?.deliveryId === deliveryId)
        this.update(entry.id, {
          billing: { state, deliveryId, revision, ...(error ? { error } : {}) },
        });
    };
    const hasValidUsage = Boolean(
      entry.usage?.reported &&
      validUsage(entry.adapter, entry.usage, this.protocols),
    );
    const outcome: BillingOutcome = {
      revision,
      // Reported usage on an unpriced route is conclusive for the host even though
      // the kernel's own USD ledger still needs reconciliation.
      status:
        entry.status === "unknown" &&
        hasValidUsage &&
        !entry.requiresReconciliation
          ? "settled"
          : (entry.status as BillingOutcome["status"]),
      ...(hasValidUsage && entry.usage
        ? { tokens: billingTokens(entry.adapter, entry.usage, this.protocols) }
        : {}),
      ...(entry.units ? { units: entry.units } : {}),
      ...(entry.chargedMicros === undefined
        ? {}
        : { chargedMicros: entry.chargedMicros }),
      ...(entry.reference === undefined ? {} : { reference: entry.reference }),
      ...(entry.responseId === undefined
        ? {}
        : { responseId: entry.responseId }),
      ...(entry.status !== "settled" && entry.error
        ? { reason: entry.error }
        : {}),
    };
    const controller = new AbortController();
    let timedOut = false;
    const fail = (error: unknown) => {
      if (this.closed || this.store.isClosed) return;
      markDelivery("failed", errorText(error));
      if (entry.runId)
        this.store.emit(entry.runId, "billing.record.failed", {
          chargeId: entry.id,
          error: errorText(error),
        });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const error = new Error("Billing delivery timed out");
      controller.abort(error);
      try {
        fail(error);
      } catch {
        // A failed audit/storage callback must not escape a timer. Durable work remains.
      }
      // Keep an uncooperative callback in its slot and preserve same-charge ordering.
      // Releasing the slot here would allow unlimited timed-out callbacks to pile up.
    }, this.deliveryOptions.timeoutMs);
    timer.unref();
    const done = Promise.resolve()
      .then(async () => {
        try {
          await this.billing!.record(
            this.charge(entry),
            outcome,
            controller.signal,
          );
          if (!timedOut) markDelivery("recorded");
        } catch (error) {
          if (!timedOut) fail(error);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        this.deliveries.delete(entry.id);
        if (!this.closed && !this.store.isClosed) {
          this.store
            .prepare(
              "DELETE FROM billing_deliveries WHERE charge_id=? AND delivery_id=?",
            )
            .run(entry.id, deliveryId);
          this.scheduleDeliveries();
        }
      })
      .catch(() => undefined);
    this.deliveries.set(entry.id, { done, controller, timer });
  }
  settleMedia(
    key: string,
    actualUsd: number,
    reference: string,
    units?: MediaUnits,
  ) {
    const entry = this.store.get<CostEntry>("cost-ledger", key);
    if (entry.basis === "operator") return entry;
    invariant(
      typeof reference === "string" &&
        reference.length > 0 &&
        reference.length <= 2000,
      "Invalid media billing reference",
    );
    return this.settle(
      entry,
      {
        chargedMicros: micros(actualUsd),
        reference,
        ...(units ? { units } : {}),
      },
      "Media charge exceeded the configured maximum",
    );
  }
  reconcile(key: string, actualUsd: number, reference: string) {
    invariant(
      reference.trim().length >= 3 && reference.length <= 2000,
      "Invoice or reconciliation reference required",
    );
    const chargedMicros = micros(actualUsd);
    const reconciled = this.store.transaction(() => {
      const previous = this.store.get<CostEntry>("cost-ledger", key);
      invariant(
        previous.status !== "reserved",
        "Cannot reconcile an in-flight request",
        409,
      );
      this.store.put("cost-adjustments", {
        id: id("adjustment"),
        chargeId: key,
        previous,
        chargedMicros,
        reference,
        createdAt: now(),
      });
      return this.updateOutcome(key, {
        status: "settled",
        chargedMicros,
        basis: "operator",
        reference,
        error: undefined,
      });
    });
    return reconciled;
  }
}
