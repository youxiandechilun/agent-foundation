import type { Static, TSchema } from "typebox";
import type { Asset } from "../contracts.js";
import type { ToolContext } from "../runtime/registry.js";
import type {
  Capability,
  Risk,
  ToolDefinition,
  ToolResult,
} from "../runtime/types.js";
import { truncate } from "../core/util.js";

function resultAssetId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return;
  const asset = "asset" in result ? result.asset : undefined;
  const nested =
    asset && typeof asset === "object" && "id" in asset ? asset.id : undefined;
  const id = nested || ("assetId" in result ? result.assetId : undefined);
  return typeof id === "string" ? id : undefined;
}

export function createBuiltinTools(
  ctx: ToolContext,
  options: { filesystemScheduling?: boolean } = {},
) {
  const { kernel: k, runId, session } = ctx;
  const root = k.store.project(session.projectId).root;
  const tools: ToolDefinition[] = [];
  const add = <S extends TSchema>(
    name: string,
    description: string,
    parameters: S,
    risk: Risk,
    capabilities: Capability[],
    execute: (
      args: Static<S>,
      signal: AbortSignal | undefined,
      callId: string,
    ) => Promise<unknown>,
  ): ToolDefinition<Static<S>> => {
    const tool: ToolDefinition<Static<S>> = {
      name,
      description,
      parameters,
      risk,
      capabilities,
      source: { kind: "builtin", id: "foundation" },
      ...(options.filesystemScheduling === false
        ? {}
        : {
            scheduling:
              risk === "read" &&
              [
                "file_list",
                "file_read",
                "file_search",
                "file_glob",
                "asset_list",
                "asset_read",
              ].includes(name)
                ? {
                    parallelSafe: true,
                    resources: () => [
                      { key: `filesystem:${root}`, access: "read" as const },
                    ],
                  }
                : undefined,
          }),
      execute: async (callId, args, signal) => {
        signal?.throwIfAborted();
        const result = await execute(args, signal, callId);
        const response: ToolResult = {
          content: [
            {
              type: "text",
              text: truncate(
                JSON.stringify(result),
                k.config.limits.maxOutputBytes,
              ),
            },
          ],
          details: result,
        };
        const assetId = resultAssetId(result);
        if (assetId && k.config.routes[ctx.routeId].acceptsImages) {
          const asset = k.assets.owned(assetId, session.projectId);
          if (
            ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              asset.mime,
            ) &&
            asset.size <= 5 * 1024 * 1024
          )
            response.content.push({
              type: "image",
              mimeType: asset.mime,
              data: (await k.assets.read(asset.id, session.projectId)).toString(
                "base64",
              ),
            });
        }
        return response;
      },
    };
    tools.push(tool);
    return tool;
  };
  const artifact = (asset: Asset) => {
    k.store.emit(runId, "artifact.created", {
      asset,
      download: `/v1/assets/${asset.id}/content`,
    });
    return { assetId: asset.id, name: asset.name, bytes: asset.size };
  };
  return { ctx, k, runId, session, root, tools, add, artifact };
}

export type BuiltinTools = ReturnType<typeof createBuiltinTools>;
