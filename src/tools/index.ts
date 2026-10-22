import type { ToolContext } from "../runtime/registry.js";
import type { ToolDefinition } from "../runtime/types.js";
import { invariant } from "../core/util.js";
import { sessionTools } from "../sessions/tools.js";
import { registerAssets, registerSkills } from "./assets.js";
import { createBuiltinTools } from "./builtin.js";
import { registerDelegation } from "./delegation.js";
import { registerProject } from "./project.js";
import { registerMemory, registerPlan, registerTranscript } from "./state.js";
import { registerWeb } from "./web.js";

export type { ToolContext } from "../runtime/registry.js";

export async function makeTools(ctx: ToolContext): Promise<ToolDefinition[]> {
  const builtins = createBuiltinTools(ctx);
  registerAssets(builtins);
  registerMemory(builtins);
  registerSkills(builtins);
  registerPlan(builtins);
  registerWeb(builtins);
  registerDelegation(builtins);
  registerTranscript(builtins);
  registerProject(builtins);
  const { kernel: k, session, runId } = ctx;
  const own = [...builtins.tools, ...sessionTools(ctx), ...k.teams.tools(ctx)];
  const extensions = [
    ...(await k.mcp.tools(ctx.signal, {
      sessionId: session.id,
      runId,
      routeId: ctx.routeId,
    })),
    ...k.plugins.tools(session.projectId, builtins.root),
    ...(await k.toolRegistry.resolve(ctx)),
  ];
  // Permission rules trust declarations, so extension tools may neither claim the
  // foundation's own source nor shadow another tool's name.
  for (const tool of extensions)
    invariant(
      !isFoundationTool(tool),
      `Extension tool ${tool.name} cannot claim the foundation source`,
      403,
      "tool_source_forged",
    );
  const tools = [...own, ...extensions],
    names = new Set<string>();
  for (const tool of tools) {
    invariant(
      !names.has(tool.name),
      `Duplicate tool name ${tool.name}`,
      409,
      "tool_name_conflict",
    );
    names.add(tool.name);
  }
  const allowed = k.config.routes[ctx.routeId].toolAllowlist;
  return tools.filter((t) => allowed.includes("*") || allowed.includes(t.name));
}

export const isFoundationTool = (tool: ToolDefinition) =>
  tool.source?.kind === "builtin" && tool.source.id === "foundation";
