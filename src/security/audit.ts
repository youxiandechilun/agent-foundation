import { z } from "zod";
import { id, invariant, now } from "../core/util.js";
import type { Store } from "../storage/store.js";
import {
  auditIdentifier,
  auditStages,
  securityAuditSchema,
  type SecurityAuditConfig,
} from "./config.js";
import { builtInAuditRules } from "./rules.js";
import type {
  SecurityAuditFinding,
  SecurityAuditRecord,
  SecurityAuditRequest,
  SecurityAuditRule,
} from "./types.js";

const findingsSchema = z
  .array(
    z
      .object({
        code: auditIdentifier,
        severity: z.enum(["low", "medium", "high"]),
        action: z.enum(["flag", "deny"]),
      })
      .strict(),
  )
  .max(32);
type Outcome =
  | { findings: SecurityAuditFinding[] }
  | { failure: "error" | "invalid_result" | "timeout" };

function readFindings(value: unknown): Outcome {
  try {
    if (Array.isArray(value) && value.length <= 32) {
      const result = findingsSchema.safeParse(value);
      if (result.success) return { findings: result.data };
    }
  } catch {
    // Accessors or proxies returned by extensions are invalid data, never diagnostic text.
  }
  return { failure: "invalid_result" };
}

function snapshot(request: SecurityAuditRequest): SecurityAuditRequest {
  const copy = structuredClone(request),
    pending: object[] = [copy];
  while (pending.length) {
    const value = pending.pop()!;
    Object.freeze(value);
    for (const child of Object.values(value))
      if (child && typeof child === "object" && !Object.isFrozen(child))
        pending.push(child);
  }
  return copy;
}

export class SecurityAudit {
  readonly enabled: boolean;
  private readonly config: SecurityAuditConfig;
  private readonly rules = new Map<string, SecurityAuditRule>();

  constructor(
    config: SecurityAuditConfig,
    private readonly store: Store,
    rules: readonly SecurityAuditRule[] = [],
  ) {
    this.config = securityAuditSchema.parse(config);
    this.enabled = this.config.mode !== "off";
    for (const rule of builtInAuditRules(this.config)) this.add(rule);
    for (const rule of rules) this.register(rule);
  }

  private add(rule: SecurityAuditRule): SecurityAuditRule {
    const ruleId = auditIdentifier.parse(rule.id),
      stages = auditStages.parse(rule.stages);
    invariant(typeof rule.evaluate === "function", "审计规则缺少检查函数");
    invariant(!this.rules.has(ruleId), "审计规则标识重复");
    invariant(this.rules.size < 64, "审计规则数量不能超过 64");
    const saved = Object.freeze({
      id: ruleId,
      stages: Object.freeze(stages),
      evaluate: rule.evaluate.bind(rule),
    });
    this.rules.set(ruleId, saved);
    return saved;
  }

  register(rule: SecurityAuditRule): () => void {
    invariant(!rule.id.startsWith("builtin."), "内置审计规则标识不可注册");
    const saved = this.add(rule);
    return () => {
      if (this.rules.get(saved.id) === saved) this.rules.delete(saved.id);
    };
  }

  async check(
    request: SecurityAuditRequest,
    signal?: AbortSignal,
  ): Promise<SecurityAuditRecord | undefined> {
    if (!this.enabled) return;
    signal?.throwIfAborted();
    const started = performance.now(),
      deadline = started + this.config.timeoutMs;
    const input = snapshot(request),
      session = this.store.session(input.sessionId);
    invariant(
      session.projectId === input.projectId,
      "审计请求不属于当前项目",
      403,
      "project_mismatch",
    );
    const rules = [...this.rules.values()].filter((rule) =>
      rule.stages.includes(input.stage),
    );
    const controller = new AbortController(),
      outcomes = new Map<string, Outcome>();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      signal?.throwIfAborted();
      const interrupted = new Promise<void>((resolve) => {
        abort = () => {
          controller.abort(signal?.reason);
          resolve();
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () => {
            controller.abort();
            resolve();
          },
          Math.max(0, deadline - performance.now()),
        );
      });
      const work = Promise.all(
        rules.map(async (rule) => {
          let outcome: Outcome;
          try {
            controller.signal.throwIfAborted();
            if (performance.now() >= deadline) {
              outcomes.set(rule.id, { failure: "timeout" });
              return;
            }
            const value = await rule.evaluate(input, controller.signal);
            if (!active) return;
            outcome = readFindings(value);
          } catch {
            outcome = { failure: "error" };
          }
          // Late completions can neither alter a recorded result nor write another record.
          if (active)
            outcomes.set(
              rule.id,
              performance.now() >= deadline ? { failure: "timeout" } : outcome,
            );
        }),
      );
      await Promise.race([work, interrupted]);
      signal?.throwIfAborted();
      if (performance.now() >= deadline) controller.abort();
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const findings: SecurityAuditRecord["findings"] = [],
      failures: SecurityAuditRecord["failures"] = [];
    for (const rule of rules) {
      const outcome = outcomes.get(rule.id) ?? { failure: "timeout" };
      if ("failure" in outcome)
        failures.push({ ruleId: rule.id, kind: outcome.failure });
      else
        findings.push(
          ...outcome.findings.map((finding) => ({
            ruleId: rule.id,
            ...finding,
          })),
        );
    }
    if (
      performance.now() >= deadline &&
      !failures.some((failure) => failure.kind === "timeout")
    )
      failures.push({ ruleId: "builtin.audit", kind: "timeout" });
    const deny =
      findings.some((finding) => finding.action === "deny") ||
      (failures.length > 0 && this.config.onError === "deny");
    const record: SecurityAuditRecord = {
      id: id("audit"),
      createdAt: now(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      routeId: input.routeId,
      stage: input.stage,
      ...(input.stage === "input"
        ? { inputId: input.inputId }
        : {
            runId: input.runId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          }),
      mode: this.config.mode === "audit" ? "audit" : "enforce",
      decision: this.config.mode === "enforce" && deny ? "deny" : "allow",
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      findings,
      failures,
    };
    signal?.throwIfAborted();
    return this.store.put("security-audits", record);
  }

  list(
    sessionId: string,
    page: { limit?: number; offset?: number } = {},
  ): {
    records: SecurityAuditRecord[];
    total: number;
    limit: number;
    offset: number;
  } {
    const { limit = 100, offset = 0 } = page;
    invariant(
      Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 200 &&
        Number.isSafeInteger(offset) &&
        offset >= 0,
      "审计分页参数无效",
    );
    const session = this.store.session(sessionId),
      filter = { sessionId, projectId: session.projectId };
    return {
      records: this.store.list<SecurityAuditRecord>("security-audits", filter, {
        limit,
        offset,
        descending: true,
      }),
      total: this.store.count("security-audits", filter),
      limit,
      offset,
    };
  }
}
