import type { Session } from "../../contracts.js";
import type {
  JsonObject,
  ModelRequest,
  ToolDefinition,
} from "../../runtime/types.js";
import type { Config } from "../config.js";
import type { Permissions } from "../permissions.js";
import { AppError, id } from "../util.js";

const search: ToolDefinition = {
  name: "web_search",
  description: "Allow this model request to use provider-hosted web search",
  parameters: {},
  risk: "network",
  capabilities: ["network"],
  source: { kind: "builtin", id: "foundation" },
  execute: async () => ({ content: [] }),
};

/** Hosted tools execute upstream, so authorization must precede every HTTP attempt. */
export async function nativeWebSearchRequest(
  config: Config,
  permissions: Permissions,
  session: Session,
  request: ModelRequest,
  signal: AbortSignal,
  authorize: (
    tool: ToolDefinition,
    args: JsonObject,
    callId: string,
    signal: AbortSignal,
    routeId: string,
  ) => Promise<void>,
  disabled: (reason: string) => void,
): Promise<ModelRequest> {
  const route = config.routes[request.routeId];
  const withoutSearch = { ...request, nativeWebSearch: false };
  if (
    !route.nativeWebSearch ||
    route.adapter !== "openai-responses" ||
    request.toolChoice === "none"
  )
    return withoutSearch;
  signal.throwIfAborted();
  if (
    [session.routeId, request.routeId].some(
      (routeId) =>
        permissions.evaluate(session, routeId, search).effect === "deny",
    )
  ) {
    disabled("permission_denied");
    return withoutSearch;
  }
  try {
    await authorize(
      search,
      { native: true, routeId: request.routeId, model: route.model },
      id("native-search"),
      signal,
      request.routeId,
    );
    signal.throwIfAborted();
    return { ...request, nativeWebSearch: true };
  } catch (error) {
    signal.throwIfAborted();
    if (
      !(error instanceof AppError) ||
      !["permission_denied", "permission_revoked", "approval_denied"].includes(
        error.code,
      )
    )
      throw error;
    disabled(error.code);
    return withoutSearch;
  }
}
