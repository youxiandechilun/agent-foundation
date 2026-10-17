import { z } from "zod";
import { modeIdSchema } from "./modes/registry.js";
import type { AgentDefinition } from "./contracts.js";
import { Store } from "./store.js";
import { invariant } from "./util.js";

export const agentDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: z.string().min(1).max(120),
    instructions: z.string().max(40000),
    mode: modeIdSchema,
    routeId: z.string().optional(),
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
    this.store.remove("agents", id);
  }
}
