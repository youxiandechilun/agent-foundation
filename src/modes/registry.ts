import { z } from "zod";
import { workModes, type WorkMode } from "./index.js";
import type { Capability } from "../runtime/types.js";
import { CAPABILITIES } from "../runtime/types.js";
import { invariant } from "../core/util.js";
export const modeIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const modeDefinitionSchema = z
  .object({
    id: modeIdSchema,
    description: z.string().max(2000),
    instructions: z.string().max(40000),
    defaultRouteId: z.string().optional(),
    toolAllowlist: z.array(z.string()).default(["*"]),
    capabilityPolicies: z
      .partialRecord(z.enum(CAPABILITIES), z.enum(["allow", "ask", "deny"]))
      .default({}),
  })
  .strict();
export type ModeDefinition = z.infer<typeof modeDefinitionSchema>;
export class ModeRegistry {
  private entries = new Map<string, WorkMode>(Object.entries(workModes));
  private definitions = new Map<string, ModeDefinition>();
  get(id: string) {
    const mode = this.entries.get(id);
    invariant(mode, `Unknown mode ${id}`, 400);
    return mode;
  }
  list() {
    return [...this.entries.values()].map((mode) => ({
      id: mode.id,
      description: mode.description,
      toolGroups: mode.toolGroups,
      defaultRouteId: mode.defaultRouteId,
      capabilityPolicies: mode.capabilityPolicies,
      custom: this.definitions.has(mode.id),
    }));
  }
  put(input: unknown) {
    const definition = modeDefinitionSchema.parse(input);
    invariant(
      !Object.hasOwn(workModes, definition.id),
      "Built-in modes cannot be replaced",
    );
    this.definitions.set(definition.id, definition);
    this.entries.set(definition.id, {
      id: definition.id,
      description: definition.description,
      defaultRouteId: definition.defaultRouteId,
      toolGroups: ["custom"],
      capabilityPolicies: definition.capabilityPolicies as Partial<
        Record<Capability, "allow" | "ask" | "deny">
      >,
      prepare: async () => definition.instructions,
      accepts: (tool) =>
        definition.toolAllowlist.includes("*") ||
        definition.toolAllowlist.includes(tool.name),
    });
    return definition;
  }
  remove(id: string) {
    invariant(this.definitions.has(id), "Custom mode not found", 404);
    this.entries.delete(id);
    this.definitions.delete(id);
  }
}
