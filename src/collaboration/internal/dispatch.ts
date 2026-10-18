import type { Kernel } from "../../core/kernel.js";
import type { Session } from "../../contracts.js";
import { terminalStatuses } from "../../contracts.js";
import type { ToolContext } from "../../runtime/registry.js";
import { abortable, errorText, id, invariant, now } from "../../core/util.js";
import { dispatchSchema, type TeamTask } from "../types.js";
import { normalizeScopes, scopesOverlap, workspaceKey } from "../scopes.js";
import { taskPrompt } from "../prompts.js";
import { resolveTeamContext } from "./context.js";
import { activeTask, type TeamTasks } from "./tasks.js";

/** Atomically reserve work, start member runs and observe their completion. */
export class TeamDispatcher {
  constructor(
    readonly kernel: Kernel,
    private readonly tasks: TeamTasks,
  ) {}

  async dispatch(
    context: ToolContext,
    input: unknown,
    signal?: AbortSignal,
    callId = "direct",
  ) {
    signal?.throwIfAborted();
    context.signal?.throwIfAborted();
    const { root, team, binding } = resolveTeamContext(this.kernel, context);
    invariant(
      context.session.id === root.id &&
        !context.session.parentSessionId &&
        !context.session.teamMemberId,
      "Only the coordinating root can dispatch team work",
      403,
    );
    invariant(
      root.agentId === team.coordinatorAgentId,
      "Session agent is not this team's coordinator",
      403,
    );
    invariant(
      !terminalStatuses.has(this.kernel.store.run(context.runId).status),
      "Coordinator run is no longer active",
      409,
    );
    invariant(
      binding.roleReview?.status === "ready",
      "Complete the whole-team responsibility review with team_review_roles before dispatching. Blocking gaps require an explicit user decision",
      409,
    );
    invariant(
      binding.roleReview.roles.length === team.memberAgentIds.length + 1 &&
        binding.roleReview.roles.every(
          (role) =>
            [team.coordinatorAgentId, ...team.memberAgentIds].includes(
              role.agentId,
            ) &&
            this.kernel.agents.get(role.agentId).instructions ===
              role.declaredResponsibility,
        ),
      "Team responsibilities changed; review the current roster again before dispatching",
      409,
    );
    const args = dispatchSchema.parse(input),
      scope = normalizeScopes(args.scope);
    invariant(
      team.memberAgentIds.includes(args.agentId),
      "Agent is not a registered member of this team",
      403,
    );
    invariant(
      binding.kind !== "brainstorm" || scope.length === 0,
      "Brainstorm assignments must have an empty write scope",
      403,
    );
    const member = this.kernel.agents.get(args.agentId);
    const reviewedRole = binding.roleReview.roles.find(
      (role) => role.agentId === member.id,
    );
    invariant(
      reviewedRole,
      "Member is missing from the reviewed team responsibilities",
      409,
    );
    invariant(
      member.mode === root.mode,
      "Team member mode differs from its coordinator",
      403,
    );
    const rootKey = workspaceKey(
      this.kernel.store.project(root.projectId).root,
    );
    const task = this.kernel.store.transaction(() => {
      const all = this.kernel.store
        .list<TeamTask>("team-tasks", { workspaceRoot: rootKey })
        .filter(activeTask)
        .map((entry) => this.tasks.refresh(entry));
      invariant(
        this.kernel.store.count("team-tasks", { rootRunId: context.runId }) <
          binding.maxTurns,
        "Team dispatch turn limit reached for this coordinator run",
        409,
      );
      const active = all.filter(
        (entry) => activeTask(entry) && entry.workspaceRoot === rootKey,
      );
      invariant(
        !active.some((entry) => entry.memberAgentId === member.id),
        "Team member already has an active task in this workspace",
        409,
      );
      const conflict = active.find((entry) =>
        scopesOverlap(entry.scope, scope),
      );
      invariant(
        !conflict,
        `Write scope overlaps active team task ${conflict?.id || ""}; wait for it to finish`,
        409,
      );
      const previous = this.kernel.store
        .list<Session>("sessions")
        .find(
          (session) =>
            session.teamRootSessionId === root.id &&
            session.teamMemberId === member.id &&
            session.collaboration?.teamId === team.id &&
            !session.archived,
        );
      const created = previous
        ? this.kernel.updateSession(previous.id, {
            agentId: member.id,
            routeId: member.routeId || root.routeId,
          })
        : this.kernel.createSession(
            root.projectId,
            root.mode,
            `Team ${team.name}: ${member.name}`,
            member.routeId || root.routeId,
            member.id,
          );
      const child = this.kernel.store.put("sessions", {
        ...created,
        autonomy: root.autonomy || "assist",
        parentSessionId: root.id,
        delegationDepth: 1,
        teamRootSessionId: root.id,
        teamMemberId: member.id,
        collaboration: structuredClone(binding),
        subagentsEnabled: false,
        readableSessionIds: root.readableSessionIds
          ? [...root.readableSessionIds]
          : undefined,
      } satisfies Session);
      const time = now();
      return this.kernel.store.put("team-tasks", {
        id: id("team-task"),
        teamId: team.id,
        projectId: root.projectId,
        workspaceRoot: rootKey,
        rootSessionId: root.id,
        rootRunId: context.runId,
        memberAgentId: member.id,
        sessionId: child.id,
        binding: structuredClone(binding),
        prompt: args.prompt,
        declaredResponsibility: member.instructions,
        optimizedResponsibility: reviewedRole.optimizedResponsibility,
        refinedResponsibility: args.refinedResponsibility || args.prompt,
        scope,
        deliverable: args.deliverable,
        status: "preparing",
        createdAt: time,
        updatedAt: time,
      } satisfies TeamTask);
    });
    let childRunId: string | undefined;
    const stop = () => {
      if (childRunId) this.tasks.cancelRun(childRunId);
    };
    const cancellation = [context.signal, signal].filter(
      (entry): entry is AbortSignal => Boolean(entry),
    );
    const combined = cancellation.length
      ? AbortSignal.any(cancellation)
      : undefined;
    combined?.addEventListener("abort", stop, { once: true });
    try {
      combined?.throwIfAborted();
      const submitted = await this.kernel.submit(task.sessionId, {
        text: taskPrompt(task),
        clientMessageId: `team:${task.id}`,
      });
      childRunId = submitted.runId;
      const started: TeamTask = {
        ...task,
        runId: childRunId,
        status: this.kernel.store.run(childRunId).status,
        updatedAt: now(),
      };
      this.kernel.store.put("team-tasks", started);
      this.kernel.store.emit(context.runId, "team.task.started", {
        taskId: task.id,
        toolCallId: callId,
        memberAgentId: member.id,
        sessionId: task.sessionId,
        runId: childRunId,
        goalRevision: binding.revision,
        scope,
      });
      if (combined?.aborted) stop();
      const settled = this.kernel
        .wait(childRunId)
        .then(() => {
          const finished = this.tasks.refresh(
            this.kernel.store.get<TeamTask>("team-tasks", task.id),
          );
          this.kernel.store.emit(context.runId, "team.task.completed", {
            taskId: task.id,
            runId: childRunId,
            status: finished.status,
            goalRevision: binding.revision,
          });
          return this.tasks.report(finished, root.id);
        })
        .finally(() => combined?.removeEventListener("abort", stop));
      // Background tasks remain observed without retaining a scheduler execution slot.
      void settled.catch(() => undefined);
      if (!args.wait) return this.tasks.report(started, root.id);
      return combined ? await abortable(settled, combined) : await settled;
    } catch (error) {
      if (!childRunId)
        this.kernel.store.put("team-tasks", {
          ...task,
          status: combined?.aborted ? "cancelled" : "failed",
          error: errorText(error),
          updatedAt: now(),
        } satisfies TeamTask);
      combined?.removeEventListener("abort", stop);
      throw error;
    }
  }
}
