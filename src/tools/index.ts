import type { ToolContext } from "../runtime/registry.js";
import type { ToolDefinition } from "../runtime/types.js";
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
  const tools = [
    ...builtins.tools,
    ...sessionTools(ctx),
    ...k.teams.tools(ctx),
    ...(await k.mcp.tools(ctx.signal, {
      sessionId: session.id,
      runId,
      routeId: ctx.routeId,
    })),
    ...k.plugins.tools(session.projectId, builtins.root),
    ...(await k.toolRegistry.resolve(ctx)),
  ];
  const allowed = k.config.routes[ctx.routeId].toolAllowlist;
  return tools.filter((t) => allowed.includes("*") || allowed.includes(t.name));
}
