import { z } from "zod";
import type { Asset, Job, Approval } from "../../contracts.js";
import { invariant } from "../../core/util.js";
import { body, type HttpContext, type HttpResult } from "../shared.js";
import { apiRoutes, input, status } from "../route-table.js";

const routes = apiRoutes({
  "GET assets": ({ k, url }) => ({
    assets: k.store.list<Asset>("assets", {
      projectId: url.searchParams.get("projectId") || undefined,
    }),
  }),
  "GET assets/:id": ({ k, id }) => k.store.asset(id),
  "POST approvals/:id/resolve": input(
    z.object({ allow: z.boolean() }).strict(),
    ({ k, id }, value) => {
      k.permissions.resolve(id, value.allow);
      return k.store.approval(id);
    },
  ),
  "GET approvals": ({ k, url }) => {
    invariant(
      url.pathname === "/v1/approvals",
      "Endpoint not found",
      404,
      "not_found",
    );
    return {
      approvals: k.store.list<Approval>("approvals", { status: "pending" }),
    };
  },
  "GET jobs": ({ k }) => ({ jobs: k.store.list<Job>("jobs") }),
  "POST jobs": status(
    202,
    input(
      z
        .object({
          projectId: z.string(),
          kind: z.enum(["image", "video"]),
          prompt: z.string().min(1).max(8000),
          routeId: z.string().optional(),
          idempotencyKey: z.string().min(1).max(200),
          request: z
            .object({
              schemaVersion: z.literal(1).optional(),
              kind: z.enum(["image", "video"]).optional(),
              operation: z.enum(["generate", "edit", "variation"]).optional(),
              prompt: z.string().optional(),
              inputAssets: z.array(z.string()).max(16).optional(),
              parameters: z.record(z.string(), z.unknown()).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      ({ k }, value) => {
        // Authenticated direct submissions are explicit human/API requests. Agent tools use Permissions.
        invariant(k.config.permissions.media !== "deny", "Media disabled", 403);
        const route = value.routeId || k.config.defaultRoutes[value.kind];
        invariant(
          !route ||
            k.config.routes[route]?.adapter !== "custom-media" ||
            k.config.permissions.plugin !== "deny",
          "Plugin media adapters disabled",
          403,
        );
        return k.media.create(value);
      },
    ),
  ),
  "GET jobs/:id": ({ k, id }) => k.store.job(id),
  "POST jobs/:id/cancel": status(202, ({ k, id }) => k.media.cancel(id)),
});

export async function resourceRoutes(
  context: HttpContext,
): Promise<HttpResult> {
  const { k, req, res, url, parts, method } = context;
  if (parts[0] !== "v1" || parts[1] !== "assets") return routes(context);
  if (parts.length === 2 && method === "POST") {
    const projectId = url.searchParams.get("projectId"),
      name = url.searchParams.get("name");
    invariant(
      projectId && name,
      "projectId and name query parameters required",
    );
    k.store.project(projectId);
    const asset = await k.assets.create(
      projectId,
      name,
      await body(req, k.config.limits.maxUploadBytes),
    );
    return {
      data: { ...asset, download: `/v1/assets/${asset.id}/content` },
      status: 201,
    };
  }
  if (parts.length === 4 && parts[3] === "content" && method === "GET") {
    const asset = k.store.asset(parts[2]);
    const bytes = await k.assets.read(asset.id, asset.projectId);
    res.writeHead(200, {
      "Content-Type": asset.mime,
      "Content-Length": asset.size,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    });
    res.end(bytes);
    return true;
  }
  return routes(context);
}
