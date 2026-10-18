import { Type } from "typebox";
import path from "node:path";
import type { Asset } from "../contracts.js";
import { invariant } from "../core/util.js";
import type { BuiltinTools } from "./builtin.js";

export function registerAssets({
  ctx,
  k,
  runId,
  session,
  add,
}: BuiltinTools): void {
  add(
    "asset_list",
    "List actual assets in this project.",
    Type.Object({}),
    "read",
    ["files.read"],
    async () => k.store.list<Asset>("assets", { projectId: session.projectId }),
  );
  add(
    "asset_read",
    "Extract an uploaded file. Returns supported/truncated flags; unknown formats remain assets.",
    Type.Object({
      assetId: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64000 })),
    }),
    "read",
    ["files.read"],
    async (args) => {
      const offset = args.offset || 0,
        limit = args.limit || 20000,
        result = await k.assets.extract(
          args.assetId,
          session.projectId,
          offset + limit,
        );
      return {
        asset: k.assets.owned(args.assetId, session.projectId),
        ...result,
        text: result.text.slice(offset, offset + limit),
        offset,
      };
    },
  );
  add(
    "media_generate",
    "Create a real image/video job through the selected canonical provider adapter. Returns actual outputs or an explicit failure.",
    Type.Object({
      kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
      prompt: Type.String({ maxLength: 32000 }),
      routeId: Type.Optional(Type.String()),
      operation: Type.Optional(
        Type.Union([
          Type.Literal("generate"),
          Type.Literal("edit"),
          Type.Literal("variation"),
        ]),
      ),
      inputAssets: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    "network",
    ["media"],
    async (args, signal, callId) => {
      const chosen = args.routeId || k.config.defaultRoutes[args.kind],
        allow = k.config.routes[ctx.routeId].mediaRouteAllowlist;
      invariant(
        chosen && (allow.includes("*") || allow.includes(chosen)),
        "Media route denied for this text model",
        403,
      );
      const job = k.media.create({
        projectId: session.projectId,
        sessionId: session.id,
        runId,
        kind: args.kind,
        prompt: args.prompt,
        routeId: chosen,
        idempotencyKey: `${runId}:${callId}`,
        request: {
          operation: args.operation,
          inputAssets: args.inputAssets,
          parameters: args.parameters,
        },
      });
      k.store.emit(runId, "job.created", { job });
      const result = await k.media.wait(job.id, signal);
      invariant(
        result.status === "completed",
        `Media job ${result.id}: ${result.status}; ${result.error || ""}`,
        502,
      );
      return result;
    },
  );
}

export function registerSkills({
  k,
  session,
  add,
  artifact,
}: BuiltinTools): void {
  add(
    "skill_load",
    "Read the actual instructions of an installed enabled skill. Loading does not grant extra permissions.",
    Type.Object({ skillId: Type.String() }),
    "read",
    [],
    async (args) => ({ instructions: k.skills.instructions([args.skillId]) }),
  );
  add(
    "skill_resource_read",
    "Read an installed Skill resource as text or a project asset. Does not execute scripts.",
    Type.Object({
      skillId: Type.String(),
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32000 })),
    }),
    "read",
    ["files.read"],
    async (args) => {
      const r = k.skills.resource(args.skillId, args.path);
      if (r.encoding === "utf8")
        return {
          path: r.path,
          text: r.data.slice(
            args.offset || 0,
            (args.offset || 0) + (args.limit || 16000),
          ),
          truncated: (args.offset || 0) + (args.limit || 16000) < r.data.length,
        };
      const asset = await k.assets.create(
        session.projectId,
        path.basename(r.path),
        Buffer.from(r.data, "base64"),
        "artifact",
      );
      artifact(asset);
      return { asset };
    },
  );
}
