import type { Config, Route } from "../core/config.js";
import type { AssistantMessage, ModelRequest, Usage } from "./types.js";
import { Store } from "../storage/store.js";
import { id, invariant, now } from "../core/util.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { nativeWebSearchEnabled } from "../providers/responses-search.js";

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
}
const micros = (usd: number) => {
  invariant(
    Number.isFinite(usd) && usd >= 0 && usd <= 1e9,
    "Invalid USD amount",
  );
  return Math.ceil(usd * 1e6);
};
export class CostLedger {
  private scopes = new AsyncLocalStorage<CostScope>();
  constructor(
    readonly store: Store,
    readonly config: Config,
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
  summary(filter: Partial<CostScope> = {}) {
    const entries = this.entries(filter);
    let chargedMicros = 0,
      heldMicros = 0,
      committedMicros = 0,
      unpriced = 0;
    for (const entry of entries) {
      const charged = entry.chargedMicros || 0;
      chargedMicros += charged;
      if (entry.status === "reserved" || entry.status === "unknown")
        heldMicros += entry.reservedMicros;
      if (entry.status !== "void")
        committedMicros +=
          entry.status === "settled" ? charged : entry.reservedMicros;
      if (entry.basis === "unpriced") unpriced++;
    }
    return {
      currency: "USD",
      committedMicros,
      committedUsd: committedMicros / 1e6,
      chargedMicros,
      heldMicros,
      unpriced,
      entries,
    };
  }
  reserve(
    routeId: string,
    route: Route,
    scope: CostScope,
    amountMicros: number,
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
        ...scope,
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
    const entry = this.reserve(routeId, route, scope, bound);
    try {
      const result = await operation();
      if (result.responseId)
        this.update(entry.id, { responseId: result.responseId });
      if (nativeSearch)
        this.update(entry.id, {
          status: "unknown",
          usage: result.usage,
          error: "Provider-hosted web search charges require reconciliation",
        });
      else this.settleUsage(entry.id, route, result.usage);
      return result;
    } catch (error) {
      const current = this.store.get<CostEntry>("cost-ledger", entry.id);
      if (current.status !== "settled")
        this.update(entry.id, {
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
  settleUsage(key: string, route: Route, u: Usage) {
    const entry = this.store.get<CostEntry>("cost-ledger", key),
      p = entry.pricing;
    if (!u.reported || !p)
      return this.update(key, { status: "unknown", usage: u });
    invariant(
      [u.input, u.output, u.cacheRead, u.cacheWrite].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ),
      "Invalid provider usage",
      502,
    );
    const uncached =
      route.adapter === "anthropic-messages"
        ? u.input
        : Math.max(0, u.input - u.cacheRead - u.cacheWrite);
    const chargedMicros =
      Math.ceil(
        uncached * p.inputPerMillion +
          u.output * p.outputPerMillion +
          u.cacheRead * (p.cacheReadPerMillion ?? p.inputPerMillion) +
          u.cacheWrite * (p.cacheWritePerMillion ?? p.inputPerMillion),
      ) + micros(p.requestUsd);
    return this.settle(
      entry,
      { chargedMicros, usage: u },
      "Provider charge exceeded the configured reservation; no further tools were dispatched",
    );
  }
  private settle(
    entry: CostEntry,
    charge: Pick<CostEntry, "usage" | "reference"> & { chargedMicros: number },
    exceededMessage: string,
  ) {
    const settled = this.update(entry.id, {
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
  reserveMedia(routeId: string, route: Route, scope: CostScope) {
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
    );
  }
  unknown(key: string) {
    const entry = this.store.get<CostEntry>("cost-ledger", key);
    return entry.status === "settled"
      ? entry
      : this.update(key, { status: "unknown" });
  }
  settleMedia(key: string, actualUsd: number, reference: string) {
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
      { chargedMicros: micros(actualUsd), reference },
      "Media charge exceeded the configured maximum",
    );
  }
  reconcile(key: string, actualUsd: number, reference: string) {
    invariant(
      reference.trim().length >= 3 && reference.length <= 2000,
      "Invoice or reconciliation reference required",
    );
    const chargedMicros = micros(actualUsd);
    return this.store.transaction(() => {
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
  }
}
