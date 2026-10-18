import type { Approval, PolicyRule, Session } from "../contracts.js";
import { isOutputTool } from "../runtime/structured-output.js";
import type { Capability, ToolDefinition } from "../runtime/types.js";
import type { Config } from "./config.js";
import { Store } from "../storage/store.js";
import { id, hash, invariant } from "./util.js";
import type { ModeRegistry } from "../modes/registry.js";
import { CAPABILITIES } from "../runtime/types.js";
import type { TeamTask } from "../collaboration/types.js";
import { normalizeScopes } from "../collaboration/scopes.js";
import type { MCPDeclaration } from "../extensions/mcp/manager.js";

const levels = { deny: 0, ask: 1, allow: 2 } as const;
type Decision = { effect: keyof typeof levels; reasons: string[] };
function combine(decisions: Decision[]): Decision {
  return {
    effect: decisions.reduce((a, b) =>
      levels[a.effect] <= levels[b.effect] ? a : b,
    ).effect,
    reasons: decisions.flatMap((decision) => decision.reasons),
  };
}
const researchOnly = (tool: ToolDefinition) =>
  ["read", "network"].includes(tool.risk || "execute") &&
  !(tool.capabilities || []).some(
    (cap) => !["files.read", "memory.read", "network", "browser"].includes(cap),
  );

export class Permissions {
  private waiting = new Map<string, (allow: boolean) => void>();
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly modes?: ModeRegistry,
  ) {}
  evaluate(session: Session, routeId: string, tool: ToolDefinition) {
    // Reuse only within this synchronous decision; later checks see policy revocation.
    const policies = this.store.list<PolicyRule>("policies");
    const decisions = [this.evaluateOne(session, routeId, tool, policies)];
    const visited = new Set([session.id]);
    let ancestor = session;
    while (ancestor.parentSessionId) {
      const parent = this.store.find<Session>(
        "sessions",
        ancestor.parentSessionId,
      );
      if (
        !parent ||
        visited.has(parent.id) ||
        parent.projectId !== session.projectId
      )
        return {
          effect: "deny" as const,
          reasons: ["Invalid delegation ancestry"],
        };
      visited.add(parent.id);
      decisions.push(this.evaluateOne(parent, parent.routeId, tool, policies));
      ancestor = parent;
    }
    return combine(decisions);
  }
  private evaluateOne(
    session: Session,
    routeId: string,
    tool: ToolDefinition,
    policies: PolicyRule[],
  ): Decision {
    if (session.collaboration && tool.name === "agent_delegate")
      return {
        effect: "deny" as const,
        reasons: ["Team sessions must use reviewed team_dispatch assignments"],
      };
    if (
      session.collaboration?.roleReview?.status === "needs_user" &&
      (tool.name === "agent_delegate" || !researchOnly(tool))
    )
      return {
        effect: "deny" as const,
        reasons: ["Team requires a user decision before further execution"],
      };
    if (session.teamMemberId) {
      const [task] = this.store.list<TeamTask>(
        "team-tasks",
        { sessionId: session.id },
        { descending: true, limit: 1 },
      );
      if ((!task || !task.scope.length) && !researchOnly(tool))
        return {
          effect: "deny" as const,
          reasons: ["Team assignment has no write scope"],
        };
    }
    if (session.collaboration?.kind === "brainstorm" && !researchOnly(tool))
      return {
        effect: "deny" as const,
        reasons: ["Brainstorm permits research and discussion only"],
      };
    const mcp =
      tool.source?.kind === "mcp" && this.config.execution.requireIsolation
        ? this.store.find<MCPDeclaration>("mcps", tool.source.id)
        : undefined;
    if (
      this.config.execution.requireIsolation &&
      ((tool.source?.kind === "plugin" &&
        this.config.extensions.executionBoundary === "native") ||
        (tool.source?.kind === "mcp" &&
          mcp?.transport === "stdio" &&
          (mcp.isolation?.boundary ||
            this.config.extensions.executionBoundary) === "native"))
    )
      return {
        effect: "deny" as const,
        reasons: [
          "Native extension execution is prohibited by required isolation",
        ],
      };
    if (
      !Array.isArray(tool.capabilities || []) ||
      !(tool.capabilities || []).every((cap) => CAPABILITIES.includes(cap)) ||
      !["read", "write", "execute", "network", "control"].includes(
        tool.risk || "execute",
      )
    )
      return {
        effect: "deny" as const,
        reasons: ["Invalid tool security declaration"],
      };
    const resultTool = isOutputTool(tool);
    if (
      !resultTool &&
      this.modes &&
      !this.modes.get(session.mode).accepts(tool)
    )
      return {
        effect: "deny" as const,
        reasons: ["Mode does not allow this tool"],
      };
    if (session.agentId && !resultTool) {
      const agent = this.store.get<import("../contracts.js").AgentDefinition>(
        "agents",
        session.agentId,
      );
      if (
        !agent.toolAllowlist.includes("*") &&
        !agent.toolAllowlist.includes(tool.name)
      )
        return {
          effect: "deny" as const,
          reasons: ["Agent definition does not allow this tool"],
        };
    }
    if (
      session.autonomy === "plan" &&
      !(
        tool.name === "plan_update" &&
        tool.source?.kind === "builtin" &&
        tool.source.id === "foundation" &&
        !tool.capabilities?.length
      ) &&
      (tool.risk !== "read" ||
        tool.capabilities?.some((cap) =>
          [
            "files.write",
            "memory.write",
            "exec",
            "media",
            "computer",
            "mcp",
            "plugin",
            "node",
          ].includes(cap),
        ) ||
        ["mcp", "plugin", "device"].includes(tool.source?.kind || ""))
    )
      return {
        effect: "deny" as const,
        reasons: ["Planning mode permits read tools only"],
      };
    const route = this.config.routes[routeId];
    if (
      !route?.enabled ||
      !(
        resultTool ||
        route.toolAllowlist.includes("*") ||
        route.toolAllowlist.includes(tool.name)
      )
    )
      return {
        effect: "deny" as const,
        reasons: ["Effective model route does not allow this tool"],
      };
    let level = 2;
    const reasons: string[] = [];
    for (const cap of tool.capabilities || []) {
      const host = this.config.permissions[cap];
      if (!Object.hasOwn(levels, host))
        return {
          effect: "deny" as const,
          reasons: ["Missing host capability policy"],
        };
      level = Math.min(level, levels[host]);
      reasons.push(`host:${cap}=${host}`);
      const mode = this.modes?.get(session.mode).capabilityPolicies?.[cap];
      if (mode) {
        level = Math.min(level, levels[mode]);
        reasons.push(`mode:${cap}=${mode}`);
      }
      const model = route.capabilityPolicies[cap];
      if (model) {
        level = Math.min(level, levels[model]);
        reasons.push(`model:${cap}=${model}`);
      }
      for (const rule of policies) {
        if (
          !rule.capabilities.includes(cap) ||
          (rule.projectId && rule.projectId !== session.projectId) ||
          (rule.routeId && rule.routeId !== routeId) ||
          (rule.mode && rule.mode !== session.mode) ||
          (rule.pluginId && rule.pluginId !== tool.source?.id) ||
          (rule.tools && !rule.tools.includes(tool.name)) ||
          (rule.expiresAt && Date.parse(rule.expiresAt) <= Date.now())
        )
          continue;
        level = Math.min(level, levels[rule.effect]);
        reasons.push(`rule:${rule.id}=${rule.effect}`);
      }
    }
    if (
      session.autonomy === "assist" &&
      ["execute", "control"].includes(tool.risk || "execute")
    )
      level = Math.min(level, 1);
    return { effect: (["deny", "ask", "allow"] as const)[level], reasons };
  }
  async check(
    runId: string,
    routeId: string,
    tool: ToolDefinition,
    args: unknown,
    callId: string,
    signal?: AbortSignal,
  ) {
    const run = this.store.run(runId),
      session = this.store.session(run.sessionId);
    if (
      session.teamMemberId &&
      tool.source?.kind === "builtin" &&
      ["file_write", "file_patch"].includes(tool.name)
    ) {
      const [task] = this.store.list<TeamTask>(
        "team-tasks",
        { runId },
        { limit: 1 },
      );
      const path =
        typeof args === "object" && args !== null && "path" in args
          ? args.path
          : undefined;
      invariant(
        task && typeof path === "string",
        "Team file operation has no current assignment",
        403,
      );
      const [target] = normalizeScopes([path]);
      invariant(
        task.scope.some(
          (scope) =>
            scope === "." || target === scope || target.startsWith(scope + "/"),
        ),
        "File is outside this member's declared write scope",
        403,
      );
    }
    const argsHash = hash(JSON.stringify(args));
    const decisions = [this.evaluate(session, routeId, tool)];
    if (routeId !== session.routeId)
      decisions.push(this.evaluate(session, session.routeId, tool));
    const decision = combine(decisions);
    invariant(
      decision.effect !== "deny",
      `Tool ${tool.name} denied: ${decision.reasons.join(", ")}`,
      403,
      "permission_denied",
    );
    signal?.throwIfAborted();
    if (decision.effect === "allow") return;
    const root = this.store.project(session.projectId).root;
    const approvedArgs = {
      ...(args as Record<string, unknown>),
      projectRoot: root,
      executionBoundary: this.config.execution.boundary,
    };
    const approval: Approval = {
      id: id("approval"),
      runId,
      tool: tool.name,
      args: approvedArgs,
      fingerprint: hash(
        JSON.stringify({
          runId,
          sessionId: session.id,
          routeId,
          callId,
          tool: tool.name,
          args: approvedArgs,
        }),
      ),
      status: "pending",
      expiresAt: new Date(
        Date.now() + this.config.permissions.approvalTimeoutMs,
      ).toISOString(),
    };
    this.store.put("approvals", approval);
    this.store.status(runId, "waiting_approval");
    const allowed = await new Promise<boolean>((resolve) => {
      const finish = (allow: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiting.delete(approval.id);
        resolve(allow);
      };
      const abort = () => {
        this.expire(approval.id);
        finish(false);
      };
      const timer = setTimeout(
        abort,
        this.config.permissions.approvalTimeoutMs,
      );
      this.waiting.set(approval.id, finish);
      signal?.addEventListener("abort", abort, { once: true });
      this.store.emit(runId, "approval.requested", {
        approval,
        reasons: decision.reasons,
        capabilities: tool.capabilities,
        risk: tool.risk,
        executionBoundary:
          this.config.execution.boundary === "native"
            ? "native-host-no-os-sandbox"
            : "docker-container",
      });
    });
    if (
      this.store.run(runId).status === "waiting_approval" &&
      !this.store.list<Approval>(
        "approvals",
        { runId, status: "pending" },
        { limit: 1 },
      ).length
    )
      this.store.status(runId, "running");
    invariant(
      allowed && !signal?.aborted,
      "Approval denied, expired or cancelled",
      403,
      "approval_denied",
    );
    invariant(
      hash(JSON.stringify(args)) === argsHash,
      "Approved arguments changed while waiting",
      409,
      "approval_changed",
    );
    const current = this.store.session(session.id);
    invariant(
      this.evaluate(current, routeId, tool).effect !== "deny" &&
        this.evaluate(current, current.routeId, tool).effect !== "deny",
      "Permission was revoked while approval was pending",
      403,
      "permission_revoked",
    );
  }
  async authorize(
    runId: string,
    routeId: string,
    name: string,
    args: unknown,
    capability: Capability,
    signal?: AbortSignal,
  ) {
    return this.check(
      runId,
      routeId,
      {
        name,
        description: "",
        parameters: {},
        capabilities: [capability],
        risk: capability === "exec" ? "execute" : "network",
        execute: async () => ({ content: [] }),
      },
      args,
      id("approval-call"),
      signal,
    );
  }
  resolve(approvalId: string, allow: boolean) {
    const approval = this.store.approval(approvalId);
    invariant(
      approval.status === "pending" && this.waiting.has(approvalId),
      "Approval is no longer pending",
      409,
    );
    invariant(
      Date.parse(approval.expiresAt) > Date.now(),
      "Approval expired",
      409,
    );
    this.store.put("approvals", {
      ...approval,
      status: allow ? "approved" : "denied",
    });
    this.store.emit(approval.runId, "approval.resolved", {
      approvalId,
      allow,
      fingerprint: approval.fingerprint,
    });
    this.waiting.get(approvalId)!(allow);
  }
  private expire(approvalId: string) {
    const approval = this.store.approval(approvalId);
    if (approval.status === "pending") {
      this.store.put("approvals", { ...approval, status: "expired" });
      this.store.emit(approval.runId, "approval.resolved", {
        approvalId,
        allow: false,
        reason: "expired-or-cancelled",
      });
    }
  }
}
