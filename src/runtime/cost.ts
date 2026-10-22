import type { Config, Route } from "../core/config.js";
import type { AssistantMessage, ModelRequest, Usage } from "./types.js";
import type { Project } from "../contracts.js";
import { Store } from "../storage/store.js";
import type { EntityPage } from "../storage/entity-query.js";
import { AppError, errorText, id, invariant, now } from "../core/util.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { findTextProtocol } from "../providers/registry.js";
import { nativeWebSearchEnabled } from "../providers/responses-search.js";
import { KeyedQueue } from "./keyed-queue.js";
import type {
  BillingCharge,
  BillingOutcome,
  BillingProvider,
  BillingTokens,
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
    state: "authorized" | "recorded" | "failed";
    error?: string;
    deliveryId?: string;
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
export function billingTokens(adapter: string, u: Usage): BillingTokens {
  return {
    input:
      findTextProtocol(adapter)?.inputIncludesCache === false
        ? u.input
        : Math.max(0, u.input - u.cacheRead - u.cacheWrite),
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
  };
}
export class CostLedger {
  private scopes = new AsyncLocalStorage<CostScope>();
  private deliveries = new Set<Promise<void>>();
  private readonly deliveryQueue = new KeyedQueue<string>();
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly billing?: BillingProvider,
  ) {}
  withScope<T>(scope: CostScope, operation: () => T): T {
    return this.scopes.run(scope, operation);
  }
  recover() {
    for (const e of this.store.list<CostEntry>("cost-ledger", {
      status: "reserved",
    }))
      this.update(e.id, {
        status: "unknown",
        error: "Interrupted request; charge requires reconciliation",
      });
    if (!this.billing) return;
    // Outcomes the host has not acknowledged are delivered again after a restart.
    for (const entry of this.store.selectJson<CostEntry>(
      "SELECT body FROM e_cost_ledger WHERE json_extract(body,'$.billing.state') IN ('authorized','failed') AND json_extract(body,'$.status')<>'reserved' ORDER BY seq",
    ))
      this.deliver(entry);
  }
  /** Wait for in-flight outcome deliveries before the store closes. */
  async drain() {
    while (this.deliveries.size) await Promise.all([...this.deliveries]);
  }
  private update(key: string, patch: Partial<CostEntry>) {
    return this.store.put("cost-ledger", {
      ...this.store.get<CostEntry>("cost-ledger", key),
      ...patch,
      updatedAt: now(),
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
        this.deliver(
          this.update(entry.id, {
            status: "unknown",
            requiresReconciliation: true,
            usage: result.usage,
            ...(result.responseId ? { responseId: result.responseId } : {}),
            error: "Provider-hosted web search charges require reconciliation",
          }),
        );
      else this.settleUsage(entry.id, route, result.usage, result.responseId);
      return result;
    } catch (error) {
      const current = this.store.get<CostEntry>("cost-ledger", entry.id);
      if (current.status !== "settled")
        this.deliver(
          this.update(entry.id, {
            status:
              error &&
              typeof error === "object" &&
              "requestSent" in error &&
              error.requestSent === false
                ? "void"
                : "unknown",
            error: "No conclusive terminal usage received",
          }),
        );
      throw error;
    }
  }
  settleUsage(key: string, route: Route, u: Usage, responseId?: string) {
    const entry = this.store.get<CostEntry>("cost-ledger", key),
      p = entry.pricing,
      response = responseId ? { responseId } : {};
    if (!u.reported || !p) {
      const marked = this.update(key, {
        status: "unknown",
        usage: u,
        ...response,
      });
      this.deliver(marked);
      return marked;
    }
    invariant(
      [u.input, u.output, u.cacheRead, u.cacheWrite].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ),
      "Invalid provider usage",
      502,
    );
    const uncached = billingTokens(route.adapter, u).input;
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
    const settled = this.update(entry.id, {
      ...charge,
      status: "settled",
      basis: "provider-usage",
    });
    this.deliver(settled);
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
    const marked = this.update(key, { status: "unknown" });
    this.deliver(marked);
    return marked;
  }
  /**
   * Ask the host billing provider before the call is sent. A refusal voids the
   * reservation and surfaces as `billing_refused`.
   */
  async authorize(
    charge: CostEntry | string,
    signal?: AbortSignal,
  ): Promise<CostEntry> {
    const entry =
      typeof charge === "string"
        ? this.store.get<CostEntry>("cost-ledger", charge)
        : charge;
    if (!this.billing) return entry;
    try {
      await this.billing.authorize(this.charge(entry), signal);
    } catch (error) {
      this.update(entry.id, {
        status: "void",
        error: `Billing refused: ${errorText(error)}`,
      });
      if (signal?.aborted) throw error;
      throw new AppError(
        402,
        "billing_refused",
        `Billing refused: ${errorText(error)}`,
      );
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
    const billing = this.billing;
    if (!billing || !entry.billing || entry.status === "reserved") return;
    const deliveryId = id("billing-delivery");
    this.update(entry.id, { billing: { state: "authorized", deliveryId } });
    const markDelivery = (state: "recorded" | "failed", error?: string) => {
      const current = this.store.get<CostEntry>("cost-ledger", entry.id);
      if (current.billing?.deliveryId === deliveryId)
        this.update(entry.id, {
          billing: { state, deliveryId, ...(error ? { error } : {}) },
        });
    };
    const outcome: BillingOutcome = {
      // Reported usage on an unpriced route is conclusive for the host even though
      // the kernel's own USD ledger still needs reconciliation.
      status:
        entry.status === "unknown" &&
        entry.usage?.reported &&
        !entry.requiresReconciliation
          ? "settled"
          : entry.status,
      ...(entry.usage?.reported
        ? { tokens: billingTokens(entry.adapter, entry.usage) }
        : {}),
      ...(entry.units ? { units: entry.units } : {}),
      ...(entry.chargedMicros === undefined
        ? {}
        : { chargedMicros: entry.chargedMicros }),
      ...(entry.reference === undefined ? {} : { reference: entry.reference }),
    };
    const delivery = this.deliveryQueue
      .run(entry.id, async () => {
        try {
          await billing.record(this.charge(entry), outcome);
          markDelivery("recorded");
        } catch (error) {
          markDelivery("failed", errorText(error));
          if (entry.runId)
            this.store.emit(entry.runId, "billing.record.failed", {
              chargeId: entry.id,
              error: errorText(error),
            });
        }
      })
      // The store may already be closed; redelivery happens on the next start.
      .catch(() => undefined)
      .finally(() => this.deliveries.delete(delivery));
    this.deliveries.add(delivery);
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
      return this.update(key, {
        status: "settled",
        chargedMicros,
        basis: "operator",
        reference,
      });
    });
    if (reconciled.requiresReconciliation) this.deliver(reconciled);
    return reconciled;
  }
}
