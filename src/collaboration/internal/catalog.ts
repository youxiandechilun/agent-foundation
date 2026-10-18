import type { Kernel } from "../../core/kernel.js";
import type { Run, Session } from "../../contracts.js";
import { terminalStatuses } from "../../contracts.js";
import { invariant } from "../../core/util.js";
import {
  teamBindingInputSchema,
  teamDefinitionSchema,
  type TeamBinding,
  type TeamDefinition,
  type TeamTask,
} from "../types.js";
import { activeTask, type TeamTasks } from "./tasks.js";

/** Persisted team definitions and root-conversation bindings. */
export class TeamCatalog {
  constructor(
    readonly kernel: Kernel,
    private readonly tasks: TeamTasks,
  ) {}

  list(): TeamDefinition[] {
    return this.kernel.store.list<TeamDefinition>("teams");
  }
  get(teamId: string): TeamDefinition {
    return this.kernel.store.get<TeamDefinition>("teams", teamId);
  }
  put(input: unknown): TeamDefinition {
    const team = teamDefinitionSchema.parse(input);
    this.validateTeam(team);
    this.assertTeamIdle(team.id);
    return this.kernel.store.put("teams", team);
  }
  remove(teamId: string): void {
    this.get(teamId);
    this.assertTeamIdle(teamId);
    invariant(
      !this.kernel.store
        .list<Session>("sessions")
        .some(
          (session) =>
            !session.teamMemberId && session.collaboration?.teamId === teamId,
        ),
      "Unbind coordinator sessions before removing their team",
      409,
    );
    this.kernel.store.remove("teams", teamId);
  }

  configure(sessionId: string, input: unknown | null): Session {
    const session = this.kernel.store.session(sessionId);
    invariant(
      !session.parentSessionId && !session.teamMemberId,
      "Only a root session can configure a team",
      403,
    );
    invariant(
      !this.tasks.forRoot(sessionId).some(activeTask),
      "Wait for active team tasks before reconfiguring",
      409,
    );
    if (input === null) {
      const current = this.kernel.updateSession(sessionId, {});
      const { collaboration: removed, ...unbound } = current;
      void removed;
      return this.kernel.store.put("sessions", unbound);
    }
    const parsed = teamBindingInputSchema.parse(input),
      team = this.get(parsed.teamId);
    this.validateTeam(team);
    invariant(
      team.mode === session.mode,
      "Team and session must use the same code or office mode",
      403,
    );
    const coordinator = this.kernel.agents.get(team.coordinatorAgentId);
    const current = this.kernel.updateSession(sessionId, {
      agentId: coordinator.id,
      routeId: coordinator.routeId || session.routeId,
    });
    const binding: TeamBinding = {
      ...parsed,
      revision: (session.collaboration?.revision || 0) + 1,
    };
    return this.kernel.store.put("sessions", {
      ...current,
      collaboration: binding,
    });
  }

  /** Called atomically with each accepted, non-duplicate coordinator input. */
  updateGoal(sessionId: string, text: string): void {
    const session = this.kernel.store.session(sessionId);
    if (
      !session.collaboration ||
      session.parentSessionId ||
      session.teamMemberId
    )
      return;
    invariant(text.length <= 100000, "Team request exceeds input limit");
    this.kernel.store.put("sessions", {
      ...session,
      collaboration: {
        ...session.collaboration,
        currentRequest: text,
        revision: session.collaboration.revision + 1,
      },
    });
  }

  private validateTeam(team: TeamDefinition): void {
    for (const agentId of [team.coordinatorAgentId, ...team.memberAgentIds]) {
      const agent = this.kernel.agents.get(agentId);
      invariant(
        agent.mode === team.mode,
        `Agent ${agentId} must use team mode ${team.mode}`,
        403,
      );
      if (agent.routeId)
        invariant(
          this.kernel.config.routes[agent.routeId]?.kind === "text",
          `Agent ${agentId} requires a configured text route`,
        );
    }
  }

  private assertTeamIdle(teamId: string): void {
    const sessions = this.kernel.store
      .list<Session>("sessions")
      .filter((session) => session.collaboration?.teamId === teamId);
    const ids = new Set(sessions.map((session) => session.id));
    invariant(
      !this.kernel.store
        .list<Run>("runs")
        .some(
          (run) => ids.has(run.sessionId) && !terminalStatuses.has(run.status),
        ),
      "Wait for active team runs before editing the team",
      409,
    );
    invariant(
      !this.kernel.store
        .list<TeamTask>("team-tasks")
        .map((task) => this.tasks.refresh(task))
        .some((task) => task.teamId === teamId && activeTask(task)),
      "Wait for active team tasks before editing the team",
      409,
    );
  }
}
