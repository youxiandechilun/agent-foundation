import { collaborationApi } from "./collaboration.js";
import type { ApiContext, ApiResult } from "./shared.js";
import { configurationRoutes } from "./routes/configuration.js";
import { memoryRoutes } from "./routes/memory.js";
import { extensionRoutes } from "./routes/extensions.js";
import { mcpRoutes } from "./routes/mcp.js";
import { sessionManagementRoutes } from "./routes/session-management.js";

export async function management(
  context: ApiContext,
): Promise<ApiResult | undefined> {
  const collaboration = await collaborationApi(context);
  if (collaboration) return collaboration;
  const { k, method, parts } = context;
  if (parts[0] !== "v1" || parts.length > 4) return;
  const [, key, entity, op] = parts;
  if (key === "storage" && entity === "stats" && !op && method === "GET")
    return { data: await k.store.storageStats(context.signal) };
  switch (key) {
    case "memories":
    case "memory-proposals":
      return memoryRoutes(context);
    case "skills":
    case "plugins":
      return extensionRoutes(context);
    case "mcp":
    case "mcp-interactions":
      return mcpRoutes(context);
    case "sessions":
    case "runs":
    case "migrations":
      return sessionManagementRoutes(context);
  }
  if (key === "jobs" && entity && op === "recover" && method === "POST")
    return { data: k.media.recover(entity), status: 202 };
  if (key === "media-adapters" && !entity && method === "GET")
    return { data: { adapters: k.media.adapters.list() } };
  return configurationRoutes(context);
}
