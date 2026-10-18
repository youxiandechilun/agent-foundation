import type { Kernel } from "../../core/kernel.js";
import type { Session } from "../../contracts.js";
import { terminalStatuses } from "../../contracts.js";
import type { ToolContext } from "../../runtime/registry.js";
import { invariant, truncate } from "../../core/util.js";
import {
  roleReviewSchema,
  roleDecisionSchema,
  type TeamBinding,
  type TeamDefinition,
} from "../types.js";
import { teamInstructions } from "../prompts.js";
import { resolveTeamContext } from "./context.js";

/** Role allocation preserves original responsibilities and explicit user decisions. */
export class TeamRoleReview {
  constructor(readonly kernel: Kernel) {}

  /** A model can analyze the roster, but cannot resolve its own missing-role question. */
  reviewRoles(context: ToolContext, input: unknown) {
    const { root, team, binding } = resolveTeamContext(this.kernel, context);
    invariant(
      context.session.id === root.id &&
        !context.session.parentSessionId &&
        !context.session.teamMemberId &&
        root.agentId === team.coordinatorAgentId,
      "Only the coordinating root can review team roles",
      403,
    );
    invariant(
      !terminalStatuses.has(this.kernel.store.run(context.runId).status),
      "Coordinator run is no longer active",
      409,
    );
    const parsed = roleReviewSchema.parse(input);
    if (binding.roleReview?.status === "needs_user") {
      const scopeChange = parsed.scopeChange;
      invariant(
        scopeChange,
        "Missing team responsibilities require the user's explicit choice: add_agents or redistribute. Stop and ask through the coordinator conversation; a model cannot clear this gap itself",
        409,
      );
      invariant(
        binding.revision > binding.roleReview.revision &&
          binding.currentRequest?.includes(scopeChange.userQuote),
        "Scope-change evidence must quote the latest user input accepted after the blocking review",
        409,
      );
      const quote = scopeChange.userQuote;
      invariant(
        /取消|移除|去掉|删除|不再|无需|不用|不需要|不要|暂不|暂停|停止|仅(?:需|要|生成|做)|只(?:需|要|生成|做)|\b(?:cancel|remove|drop|omit|exclude|skip|without|only)\b|\bno longer\b/iu.test(
          quote,
        ) &&
          !/(?:不要|别|不能|不应|并不|没有)(?:再)?(?:取消|移除|去掉|删除|暂停|停止)|\b(?:do not|don't|not)\s+(?:cancel|remove|drop|omit|exclude|skip)\b/iu.test(
            quote,
          ),
        "An ordinary follow-up is not explicit evidence that the user removed the blocked work",
        409,
      );
      const blocked = new Set(
        binding.roleReview.gaps
          .filter((gap) => gap.blocking)
          .map((gap) => gap.responsibility),
      );
      invariant(
        scopeChange.removedResponsibilities.length === blocked.size &&
          new Set(scopeChange.removedResponsibilities).size === blocked.size &&
          scopeChange.removedResponsibilities.every((responsibility) =>
            blocked.has(responsibility),
          ),
        "Scope change must cover exactly the previously blocking responsibilities",
        409,
      );
    } else
      invariant(
        !parsed.scopeChange,
        "Scope-change evidence is only accepted for a pending blocking review",
      );
    const roster = [team.coordinatorAgentId, ...team.memberAgentIds];
    invariant(
      parsed.roles.length === roster.length &&
        new Set(parsed.roles.map((role) => role.agentId)).size ===
          roster.length &&
        parsed.roles.every((role) => roster.includes(role.agentId)),
      "Role review must cover the entire unique team roster, including its coordinator",
    );
    for (const gap of parsed.gaps) {
      const checked = gap.attemptedAssignments.map(
        (attempt) => attempt.agentId,
      );
      invariant(
        new Set(checked).size === checked.length &&
          checked.every((agentId) => roster.includes(agentId)),
        "Gap assignment evidence must use unique agents from the existing roster",
      );
      invariant(
        !gap.blocking || checked.length === roster.length,
        "A blocking gap requires evidence explaining why every existing agent, including the coordinator, cannot take the necessary responsibility",
      );
    }
    const review = {
      status: parsed.gaps.some((gap) => gap.blocking) ? "needs_user" : "ready",
      roles: parsed.roles.map((role) => ({
        ...role,
        declaredResponsibility: this.kernel.agents.get(role.agentId)
          .instructions,
      })),
      gaps: parsed.gaps,
      rationale: parsed.rationale,
      revision: binding.revision,
      ...(binding.roleReview?.decision
        ? { decision: binding.roleReview.decision }
        : {}),
      ...(parsed.scopeChange
        ? {
            scopeChange: {
              ...parsed.scopeChange,
              previousReviewRevision: binding.roleReview?.revision || 0,
            },
          }
        : {}),
    } satisfies NonNullable<TeamBinding["roleReview"]>;
    this.kernel.store.put("sessions", {
      ...root,
      collaboration: { ...binding, roleReview: review },
    });
    this.kernel.store.emit(context.runId, "team.roles.reviewed", {
      status: review.status,
      goalRevision: binding.revision,
      gaps: review.gaps,
    });
    return {
      roleReview: review,
      ...(review.status === "needs_user"
        ? {
            nextAction:
              "Stop dispatching and ask the user whether to add agents (add_agents) or redistribute responsibilities (redistribute). Wait for an explicit host-recorded decision.",
          }
        : {}),
    };
  }

  resolveRoleReview(sessionId: string, input: unknown): Session {
    return this.recordRoleDecision(
      sessionId,
      roleDecisionSchema.parse(input).decision,
    );
  }

  /** Host-only API/input operation. It is deliberately not exposed as a model tool. */
  recordRoleDecision(
    sessionId: string,
    decision: "redistribute" | "add_agents",
  ): Session {
    const parsed = roleDecisionSchema.parse({ decision });
    const root = this.kernel.store.session(sessionId),
      binding = root.collaboration;
    invariant(
      !root.parentSessionId &&
        !root.teamMemberId &&
        binding?.roleReview?.status === "needs_user",
      "No unresolved team responsibility question is awaiting a user decision",
      409,
    );
    return this.kernel.store.put("sessions", {
      ...root,
      collaboration: {
        ...binding,
        roleReview: {
          ...binding.roleReview,
          decision: parsed.decision,
          status:
            parsed.decision === "redistribute"
              ? "awaiting_review"
              : "needs_user",
        },
      },
    });
  }

  instructions(session: Session): string {
    if (!session.collaboration) return "";
    const team = this.kernel.store.get<TeamDefinition>(
      "teams",
      session.collaboration.teamId,
    );
    const roster = [team.coordinatorAgentId, ...team.memberAgentIds];
    const review = session.collaboration.roleReview;
    const reviewedRole = review?.roles.find(
      (role) =>
        role.agentId === (session.teamMemberId || team.coordinatorAgentId),
    );
    const ownRole = reviewedRole
      ? `Reviewed responsibility for your role: ${reviewedRole.optimizedResponsibility}\nPreserve the user's original responsibility and all stated constraints.\n`
      : "";
    if (session.teamMemberId)
      return (
        teamInstructions(team, session.collaboration, session.teamMemberId) +
        ownRole
      );
    const ready =
      review?.status === "ready" &&
      review.roles.length === roster.length &&
      review.roles.every(
        (role) =>
          roster.includes(role.agentId) &&
          this.kernel.agents.get(role.agentId).instructions ===
            role.declaredResponsibility,
      );
    const summaryBudget = Math.min(3000, Math.floor(18000 / roster.length));
    const catalog = roster.map((agentId) => {
      const agent = this.kernel.agents.get(agentId);
      const optimized = ready
        ? review.roles.find((role) => role.agentId === agentId)
            ?.optimizedResponsibility
        : undefined;
      return {
        id: agent.id,
        name: agent.name,
        routeId: agent.routeId,
        responsibility: truncate(
          optimized || agent.instructions,
          summaryBudget,
        ),
      };
    });
    return (
      teamInstructions(team, session.collaboration, session.teamMemberId) +
      `Agent responsibility summaries (${ready ? "reviewed allocation" : "original user responsibilities"}):\n${JSON.stringify(catalog)}\n${ownRole}`
    );
  }
}
