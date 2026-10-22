import type { Config } from "../config.js";
import type { Store } from "../../storage/store.js";
import type { Permissions } from "../permissions.js";
import type { CostLedger } from "../../runtime/cost.js";
import type { MCPDeclaration } from "../../extensions/mcp/manager.js";
import type { MCPOrigin } from "../../extensions/mcp/interactions.js";
import {
  decodeSamplingRequest,
  samplingResult,
} from "../../extensions/mcp/sampling.js";
import {
  estimateTokens,
  estimateToolTokens,
} from "../../runtime/token-counter.js";
import { RouteRouter } from "../../providers/text.js";
import type { ToolDefinition } from "../../runtime/types.js";
import { invariant } from "../util.js";

/** MCP client input shares the originating run's policy and cost scope. */
export class McpHost {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly permissions: Permissions,
    private readonly costs: CostLedger,
  ) {}
  authorize(
    serverId: string,
    origin: MCPOrigin,
    kind: "elicitation" | "sampling",
    routeId?: string,
  ) {
    const run = this.store.run(origin.runId),
      session = this.store.session(origin.sessionId);
    invariant(
      run.sessionId === session.id &&
        ["running", "waiting_approval"].includes(run.status),
      "MCP input is no longer attached to an active run",
      403,
    );
    const tool: ToolDefinition = {
      name: origin.toolName,
      description: "MCP client input",
      parameters: { type: "object" },
      risk: "execute",
      capabilities: kind === "sampling" ? ["mcp", "network"] : ["mcp"],
      source: { kind: "mcp", id: serverId },
      execute: async () => ({ content: [] }),
    };
    const current = this.permissions.evaluate(session, origin.routeId, tool);
    invariant(
      current.effect !== "deny",
      "MCP client input denied by current origin policy: " +
        current.reasons.join("; "),
      403,
    );
    if (session.routeId !== origin.routeId) {
      const primary = this.permissions.evaluate(session, session.routeId, tool);
      invariant(
        primary.effect !== "deny",
        "MCP client input denied by primary model policy: " +
          primary.reasons.join("; "),
        403,
      );
    }
    if (routeId) {
      const route = this.config.routes[routeId];
      invariant(
        route?.enabled && route.kind === "text",
        "Text route absent/disabled",
        503,
      );
      const sampling = this.permissions.evaluate(session, routeId, tool);
      invariant(
        sampling.effect !== "deny",
        "MCP sampling route denied by current policy: " +
          sampling.reasons.join("; "),
        403,
      );
    }
  }
  async sample(
    serverId: string,
    origin: MCPOrigin,
    routeId: string,
    params: unknown,
    signal: AbortSignal,
  ) {
    const declaration = this.store.get<MCPDeclaration>("mcps", serverId);
    const decoded = decodeSamplingRequest(
      params,
      declaration.clientFeatures?.sampling,
    );
    const { messages, data, tools } = decoded;
    const session = this.store.session(origin.sessionId);
    const provider = RouteRouter.create(this.config, {
      prepareRoute: async (request) => {
        this.authorize(serverId, origin, "sampling", request.routeId);
        const route = this.config.routes[request.routeId];
        invariant(
          !messages.some(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some((p) => p.type === "image"),
          ) || route.acceptsImages,
          "Sampling route does not accept images",
          400,
        );
        invariant(
          estimateTokens(request.messages) +
            estimateToolTokens(request.tools) +
            (request.maxOutputTokens || 0) <=
            route.contextWindow,
          "Sampling context exceeds model window",
          413,
        );
        invariant(
          data.toolChoice?.mode !== "required" || request.tools.length > 0,
          "Required sampling tools denied by model route",
          403,
        );
        return {
          ...request,
          tools: request.tools.map((t) => ({
            ...t,
            name: decoded.aliasFor(t.name),
          })),
        };
      },
      billing: {
        ledger: this.costs,
        scope: {
          projectId: session.projectId,
          sessionId: session.id,
          runId: origin.runId,
          purpose: "mcp-sampling",
        },
      },
    });
    const result = await provider.complete(
      {
        routeId,
        messages,
        tools,
        maxOutputTokens: data.maxTokens,
        toolChoice: data.toolChoice?.mode,
      },
      undefined,
      signal,
    );
    this.authorize(serverId, origin, "sampling", result.provider);
    signal.throwIfAborted();
    const allowlist = this.config.routes[result.provider].toolAllowlist;
    return samplingResult(
      result,
      decoded,
      tools.filter(
        (t) => allowlist.includes("*") || allowlist.includes(t.name),
      ),
    );
  }
}
