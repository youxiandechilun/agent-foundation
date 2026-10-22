import { z } from "zod";
import { modeIdSchema } from "../modes/registry.js";
import type { AgentDefinition } from "../contracts.js";
import { Store } from "../storage/store.js";
import { invariant } from "./util.js";
import { reasoningEffortSchema } from "./config.js";

export const agentDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: z.string().min(1).max(120),
    instructions: z.string().max(40000),
    /** Replaces the kernel's default persona and work rules; safety rules remain. */
    systemPrompt: z.string().min(1).max(40000).optional(),
    mode: modeIdSchema,
    routeId: z.string().optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    reasoningBudgetTokens: z.number().int().min(1024).max(1_000_000).optional(),
    skillIds: z.array(z.string()).default([]),
    toolAllowlist: z.array(z.string()).default(["*"]),
    maxSteps: z.number().int().min(1).max(500).default(64),
    memoryNamespace: z.string().default("default"),
  })
  .strict();
export class AgentManager {
  constructor(readonly store: Store) {}
  list() {
    return this.store.list<AgentDefinition>("agents");
  }
  put(input: unknown) {
    return this.store.put("agents", agentDefinitionSchema.parse(input));
  }
  get(id: string) {
    return this.store.get<AgentDefinition>("agents", id);
  }
  remove(id: string) {
    this.get(id);
    invariant(
      !this.store
        .list<import("../collaboration/types.js").TeamDefinition>("teams")
        .some(
          (team) =>
            team.coordinatorAgentId === id || team.memberAgentIds.includes(id),
        ),
      "Agent belongs to a team",
      409,
    );
    this.store.remove("agents", id);
  }
}
