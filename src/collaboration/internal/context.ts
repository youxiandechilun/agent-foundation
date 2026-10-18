import type { Kernel } from "../../core/kernel.js";
import type { ToolContext } from "../../runtime/registry.js";
import { invariant } from "../../core/util.js";
import type { TeamDefinition } from "../types.js";

/** Resolve fresh persisted membership; a stale tool context grants no access. */
export function resolveTeamContext(kernel: Kernel, context: ToolContext) {
  const caller = kernel.store.session(context.session.id),
    run = kernel.store.run(context.runId);
  invariant(
    run.sessionId === caller.id,
    "Team tool run does not belong to caller",
    403,
  );
  const root = kernel.store.session(caller.teamRootSessionId || caller.id);
  const binding = root.collaboration;
  invariant(
    binding &&
      caller.collaboration?.teamId === binding.teamId &&
      caller.projectId === root.projectId,
    "Team is not bound to this conversation",
    403,
  );
  const team = kernel.store.get<TeamDefinition>("teams", binding.teamId);
  invariant(
    root.mode === team.mode &&
      (!caller.teamMemberId ||
        team.memberAgentIds.includes(caller.teamMemberId)),
    "Team membership or mode changed",
    403,
  );
  return { root, team, binding };
}
