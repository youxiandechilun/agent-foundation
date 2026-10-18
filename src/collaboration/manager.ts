import type { Kernel } from "../core/kernel.js";
import type { Session } from "../contracts.js";
import type { ToolContext } from "../runtime/registry.js";
import type { ToolDefinition } from "../runtime/types.js";
import { TeamCatalog } from "./internal/catalog.js";
import { TeamRoleReview } from "./internal/role-review.js";
import { TeamTasks } from "./internal/tasks.js";
import { TeamDispatcher } from "./internal/dispatch.js";
import { createTeamTools } from "./internal/tool-definitions.js";
import type { TeamDefinition } from "./types.js";

/** Stable collaboration API; specialized services own each state transition. */
export class TeamManager {
  private readonly catalog: TeamCatalog;
  private readonly roles: TeamRoleReview;
  private readonly tasks: TeamTasks;
  private readonly dispatcher: TeamDispatcher;

  constructor(readonly kernel: Kernel) {
    this.tasks = new TeamTasks(kernel);
    this.catalog = new TeamCatalog(kernel, this.tasks);
    this.roles = new TeamRoleReview(kernel);
    this.dispatcher = new TeamDispatcher(kernel, this.tasks);
  }

  list(): TeamDefinition[] {
    return this.catalog.list();
  }

  get(teamId: string): TeamDefinition {
    return this.catalog.get(teamId);
  }

  put(input: unknown): TeamDefinition {
    return this.catalog.put(input);
  }

  remove(teamId: string): void {
    this.catalog.remove(teamId);
  }

  configure(sessionId: string, input: unknown | null): Session {
    return this.catalog.configure(sessionId, input);
  }

  updateGoal(sessionId: string, text: string): void {
    this.catalog.updateGoal(sessionId, text);
  }

  reviewRoles(context: ToolContext, input: unknown) {
    return this.roles.reviewRoles(context, input);
  }

  resolveRoleReview(sessionId: string, input: unknown): Session {
    return this.roles.resolveRoleReview(sessionId, input);
  }

  recordRoleDecision(
    sessionId: string,
    decision: "redistribute" | "add_agents",
  ): Session {
    return this.roles.recordRoleDecision(sessionId, decision);
  }

  instructions(session: Session): string {
    return this.roles.instructions(session);
  }

  tools(context: ToolContext): ToolDefinition[] {
    return createTeamTools(this, context);
  }

  async dispatch(
    context: ToolContext,
    input: unknown,
    signal?: AbortSignal,
    callId = "direct",
  ) {
    return this.dispatcher.dispatch(context, input, signal, callId);
  }

  async status(context: ToolContext, input: unknown, signal?: AbortSignal) {
    return this.tasks.status(context, input, signal);
  }

  read(context: ToolContext, input: unknown) {
    return this.tasks.read(context, input);
  }

  cancelChildren(rootRunId: string): void {
    this.tasks.cancelChildren(rootRunId);
  }
}
