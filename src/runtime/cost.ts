import type { Config, Route } from "../config.js";
import type { AssistantMessage, ModelRequest, Usage } from "./types.js";
import { Store } from "../store.js";
import { id, invariant, now } from "../util.js";
import { AsyncLocalStorage } from "node:async_hooks";

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
    for (const e of this.store.list<CostEntry>("cost-ledger"))
      if (e.status === "reserved")
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
    return this.store
      .list<CostEntry>("cost-ledger")
      .filter((e) =>
        Object.entries(filter).every(
          ([k, v]) => v === undefined || e[k as keyof CostScope] === v,
        ),
      );
  }
  summary(filter: Partial<CostScope> = {}) {
    const entries = this.entries(filter);
    const committedMicros = entries.reduce(
      (n, e) =>
        n +
        (e.status === "void"
          ? 0
          : e.status === "settled"
            ? e.chargedMicros || 0
            : e.reservedMicros),
      0,
    );
    return {
      currency: "USD",
      committedMicros,
      committedUsd: committedMicros / 1e6,
      chargedMicros: entries.reduce((n, e) => n + (e.chargedMicros || 0), 0),
      heldMicros: entries.reduce(
        (n, e) =>
          n +
          (["reserved", "unknown"].includes(e.status) ? e.reservedMicros : 0),
        0,
      ),
      unpriced: entries.filter((e) => e.basis === "unpriced").length,
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
        const b = this.config.budgets,
          all = this.entries(),
          day = now().slice(0, 10);
        const limits: [
          string,
          number | undefined,
          (e: CostEntry) => boolean,
        ][] = [
          [
            "run",
            b.maxRunUsd,
            (e) => Boolean(scope.runId) && e.runId === scope.runId,
          ],
          [
            "session",
            b.maxSessionUsd,
            (e) => Boolean(scope.sessionId) && e.sessionId === scope.sessionId,
          ],
          [
            "project",
            b.maxProjectUsd,
            (e) => Boolean(scope.projectId) && e.projectId === scope.projectId,
          ],
          ["day", b.maxDayUsd, (e) => e.createdAt.slice(0, 10) === day],
          ["total", b.maxTotalUsd, () => true],
        ];
        for (const [name, limit, include] of limits) {
          if (
            limit === undefined ||
            (name === "run" && !scope.runId) ||
            (name === "session" && !scope.sessionId) ||
            (name === "project" && !scope.projectId)
          )
            continue;
          const used = all
            .filter(include)
            .reduce(
              (n, e) =>
                n +
                (e.status === "void"
                  ? 0
                  : e.status === "settled"
                    ? e.chargedMicros || 0
                    : e.reservedMicros),
              0,
            );
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
    const bound =
      Math.ceil(
        route.contextWindow * inputRate + output * (p?.outputPerMillion || 0),
      ) + micros(p?.requestUsd || 0);
    const entry = this.reserve(routeId, route, scope, bound);
    try {
      const result = await operation();
      if (result.responseId)
        this.update(entry.id, { responseId: result.responseId });
      this.settleUsage(entry.id, route, result.usage);
      return result;
    } catch (error) {
      const current = this.store.get<CostEntry>("cost-ledger", entry.id);
      if (current.status !== "settled")
        this.update(entry.id, {
          status: (error as any).requestSent === false ? "void" : "unknown",
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
    const settled = this.update(key, {
      status: "settled",
      chargedMicros,
      usage: u,
      basis: "provider-usage",
    });
    if (entry.runId)
      this.store.emit(entry.runId, "cost.settled", {
        entry: settled,
        exceededReservation: chargedMicros > entry.reservedMicros,
      });
    invariant(
      !this.config.budgets.enabled || chargedMicros <= entry.reservedMicros,
      "Provider charge exceeded the configured reservation; no further tools were dispatched",
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
    const chargedMicros = micros(actualUsd);
    const result = this.update(key, {
      status: "settled",
      chargedMicros,
      basis: "provider-usage",
      reference,
    });
    if (entry.runId)
      this.store.emit(entry.runId, "cost.settled", {
        entry: result,
        reference,
        exceededReservation: chargedMicros > entry.reservedMicros,
      });
    invariant(
      !this.config.budgets.enabled || chargedMicros <= entry.reservedMicros,
      "Media charge exceeded the configured maximum",
      402,
      "cost_reservation_exceeded",
    );
    return result;
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
