import { Type } from "typebox";
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Kernel } from "./kernel.js";
import type { Session } from "./contracts.js";
import type {
  ToolDefinition,
  Risk,
  Capability,
  ToolResult,
} from "./runtime/types.js";
import { processTools } from "./execution/tools.js";
import { executionCapabilities } from "./execution/process.js";
import { atomicWrite, safePath, invariant, truncate, now } from "./util.js";

export interface ToolContext {
  signal?: AbortSignal;
  kernel: Kernel;
  runId: string;
  session: Session;
  routeId: string;
}
const cell = Type.Union([
  Type.String({ maxLength: 10000 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export async function makeTools(ctx: ToolContext): Promise<ToolDefinition[]> {
  const { kernel: k, runId, session } = ctx,
    root = k.store.project(session.projectId).root,
    tools: ToolDefinition[] = [],
    runner = k.commands;
  const add = (
    name: string,
    description: string,
    parameters: any,
    risk: Risk,
    capabilities: Capability[],
    execute: (
      args: any,
      signal: AbortSignal | undefined,
      callId: string,
    ) => Promise<any>,
  ) =>
    tools.push({
      name,
      description,
      parameters,
      risk,
      capabilities,
      source: { kind: "builtin", id: "foundation" },
      scheduling:
        risk === "read" &&
        [
          "file_list",
          "file_read",
          "file_search",
          "asset_list",
          "asset_read",
        ].includes(name)
          ? {
              parallelSafe: true,
              resources: () => [{ key: `filesystem:${root}`, access: "read" }],
            }
          : undefined,
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
        const assetId = result?.asset?.id || result?.assetId;
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
    });
  const artifact = (asset: any) => {
    k.store.emit(runId, "artifact.created", {
      asset,
      download: `/v1/assets/${asset.id}/content`,
    });
    return { assetId: asset.id, name: asset.name, bytes: asset.size };
  };
  add(
    "asset_list",
    "List actual assets in this project.",
    Type.Object({}),
    "read",
    ["files.read"],
    async () =>
      k.store
        .list<any>("assets")
        .filter((a) => a.projectId === session.projectId),
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
      const chosen =
          args.routeId ||
          k.config.defaultRoutes[args.kind as "image" | "video"],
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
  add(
    "memory_search",
    "Search actual persistent project memory by keywords or configured semantic embeddings.",
    Type.Object({
      query: Type.String(),
      namespace: Type.Optional(Type.String()),
      semantic: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    "read",
    ["memory.read"],
    async (args, signal) =>
      args.semantic
        ? k.memory.semanticSearch(
            session.projectId,
            args.query,
            args.limit,
            args.namespace,
            signal,
          )
        : k.memory.search(
            session.projectId,
            args.query,
            args.limit,
            args.namespace,
          ),
  );
  add(
    "memory_read",
    "Read a complete non-expired project memory by its actual ID.",
    Type.Object({ id: Type.String() }),
    "read",
    ["memory.read"],
    async (args) => k.memory.get(args.id, session.projectId),
  );
  add(
    "memory_save",
    "Save an explicit durable user fact/preference. Do not store credentials or inferred facts.",
    Type.Object({
      content: Type.String({ maxLength: 32000 }),
      tags: Type.Optional(Type.Array(Type.String())),
      namespace: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    }),
    "write",
    ["memory.write"],
    async (args) =>
      k.memory.put({
        ...args,
        projectId: session.projectId,
        source: `run:${runId}`,
      }),
  );
  add(
    "memory_delete",
    "Delete a specific project memory.",
    Type.Object({ id: Type.String() }),
    "write",
    ["memory.write"],
    async (args) => {
      k.memory.remove(args.id, session.projectId);
      return { deleted: true };
    },
  );
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
  add(
    "plan_update",
    "Persist a work plan and actual progress for the current run.",
    Type.Object({
      steps: Type.Array(
        Type.Object({
          title: Type.String({ maxLength: 300 }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("blocked"),
          ]),
        }),
        { maxItems: 50 },
      ),
    }),
    "write",
    [],
    async (args) => {
      const plan = k.store.put("work-plans", {
        id: runId,
        steps: args.steps,
        updatedAt: now(),
      });
      k.store.emit(runId, "plan.updated", { plan });
      return plan;
    },
  );
  add(
    "transcript_read",
    "Read earlier canonical session messages to recover details omitted from model context.",
    Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    "read",
    ["files.read"],
    async (args) => ({
      messages: k.store
        .transcript(session.id)
        .slice(args.offset || 0, (args.offset || 0) + (args.limit || 10)),
    }),
  );
  add(
    "file_list",
    "List entries under the project root.",
    Type.Object({ path: Type.Optional(Type.String()) }),
    "read",
    ["files.read"],
    async (args) => {
      const entries = await readdir(await safePath(root, args.path || ""), {
        withFileTypes: true,
      });
      return {
        entries: entries.slice(0, 1000).map((e) => ({
          name: e.name,
          kind: e.isSymbolicLink()
            ? "link"
            : e.isDirectory()
              ? "directory"
              : "file",
        })),
        truncated: entries.length > 1000,
      };
    },
  );
  add(
    "file_read",
    "Read a character range of an actual UTF-8 project file.",
    Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64000 })),
    }),
    "read",
    ["files.read"],
    async (args) => {
      const target = await safePath(root, args.path);
      invariant(
        (await stat(target)).size <= 4 * 1024 * 1024,
        "Use asset ingestion for files above 4 MiB",
      );
      const text = await readFile(target, "utf8");
      invariant(!text.includes("\0"), "Binary file");
      const offset = args.offset || 0,
        limit = args.limit || 20000;
      return {
        path: args.path,
        text: text.slice(offset, offset + limit),
        totalCharacters: text.length,
        truncated: text.length > offset + limit,
      };
    },
  );
  const write = async (relative: string, content: string) => {
    const file = await safePath(root, relative, true);
    await mkdir(path.dirname(file), { recursive: true });
    await safePath(root, relative, true);
    await atomicWrite(file, content);
    const a = await k.assets.create(
      session.projectId,
      path.basename(file),
      Buffer.from(content),
      "artifact",
    );
    return { path: relative, ...artifact(a) };
  };
  add(
    "file_write",
    "Atomically write UTF-8 source/content within the project. Replaces existing contents.",
    Type.Object({
      path: Type.String(),
      content: Type.String({ maxLength: 1000000 }),
    }),
    "write",
    ["files.write"],
    async (args) => write(args.path, args.content),
  );
  add(
    "file_patch",
    "Replace exactly one matching text segment. Ambiguous or missing matches fail without writing.",
    Type.Object({
      path: Type.String(),
      oldText: Type.String({ minLength: 1, maxLength: 200000 }),
      newText: Type.String({ maxLength: 200000 }),
    }),
    "write",
    ["files.write"],
    async (args) => {
      const file = await safePath(root, args.path);
      invariant((await stat(file)).size <= 4 * 1024 * 1024, "File too large");
      const text = await readFile(file, "utf8");
      invariant(
        text.split(args.oldText).length === 2,
        "oldText must match exactly once",
      );
      return write(args.path, text.replace(args.oldText, args.newText));
    },
  );
  add(
    "file_search",
    "Search project text files with literal text. Bounded traversal skips links, .git and node_modules.",
    Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1000 }),
      path: Type.Optional(Type.String()),
    }),
    "read",
    ["files.read"],
    async (args, signal) => {
      const matches: any[] = [];
      let visited = 0;
      const walk = async (relative: string) => {
        signal?.throwIfAborted();
        if (
          visited >= k.config.limits.maxSearchEntries ||
          matches.length >= 200
        )
          return;
        const dir = await safePath(root, relative);
        for (const e of await readdir(dir, { withFileTypes: true })) {
          signal?.throwIfAborted();
          if (
            visited >= k.config.limits.maxSearchEntries ||
            matches.length >= 200
          )
            break;
          visited++;
          if (
            e.isSymbolicLink() ||
            ["node_modules", ".git", ".agent-data"].includes(e.name)
          )
            continue;
          const child = path.join(relative, e.name);
          if (e.isDirectory()) await walk(child);
          else {
            const file = await safePath(root, child);
            if ((await stat(file)).size > 500000) continue;
            const text = await readFile(file, { encoding: "utf8", signal });
            if (text.includes("\0")) continue;
            text.split(/\r?\n/).forEach((line, index) => {
              if (line.includes(args.query) && matches.length < 200)
                matches.push({
                  path: child,
                  line: index + 1,
                  text: line.slice(0, 600),
                });
            });
          }
        }
      };
      await walk(args.path || "");
      return {
        matches,
        visited,
        truncated:
          visited >= k.config.limits.maxSearchEntries || matches.length >= 200,
      };
    },
  );
  add(
    "exec_run",
    "Run an actual process with argv through the configured native, optional Docker or Windows AppContainer backend. Native execution has the host user's permissions.",
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 2000 }),
      args: Type.Array(Type.String({ maxLength: 10000 }), { maxItems: 100 }),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000 })),
    }),
    "execute",
    executionCapabilities(k.config),
    async (args, signal, callId) => {
      const result = await runner.run(
        {
          command: args.command,
          args: args.args,
          cwd: await safePath(root, args.cwd || ""),
          timeoutMs: args.timeoutMs || 60000,
        },
        root,
        signal,
        (text, stream) =>
          k.store.emit(
            runId,
            "tool.output",
            { toolCallId: callId, text, stream },
            false,
          ),
      );
      invariant(
        result.exitCode === 0,
        `Command exited ${result.exitCode}\n${result.stderr}\n${result.stdout}`,
        422,
        "command_failed",
      );
      return result;
    },
  );
  tools.push(...processTools(ctx));
  add(
    "git_inspect",
    "Inspect Git status/diff. Git can invoke repository-configured helpers, so this requires exec permission even for inspection.",
    Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("diff")]),
      staged: Type.Optional(Type.Boolean()),
    }),
    "execute",
    ["files.read", ...executionCapabilities(k.config)],
    async (args, signal) => {
      const command =
        args.action === "status"
          ? ["status", "--short", "--", "."]
          : [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...(args.staged ? ["--cached"] : []),
              "--",
              ".",
            ];
      const result = await runner.run(
        {
          command: "git",
          args: [
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            ...command,
          ],
          cwd: root,
          timeoutMs: 15000,
        },
        root,
        signal,
      );
      invariant(result.exitCode === 0, result.stderr);
      return result;
    },
  );
  tools.push(
    ...(await k.mcp.tools(ctx.signal, {
      sessionId: session.id,
      runId,
      routeId: ctx.routeId,
    })),
    ...k.plugins.tools(session.projectId, root),
    ...(await k.toolRegistry.resolve(ctx)),
  );
  const allowed = k.config.routes[ctx.routeId].toolAllowlist;
  return tools.filter((t) => allowed.includes("*") || allowed.includes(t.name));
}
