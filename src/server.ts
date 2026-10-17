import { streamRunEvents } from "./event-stream.js";
import { VERSION } from "./version.js";
import { modeIdSchema } from "./modes/registry.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import type {
  FoundationEvent,
  Session,
  Project,
  Run,
  Asset,
  Job,
  Approval,
} from "./contracts.js";
import { terminalStatuses } from "./contracts.js";
import { publicConfig } from "./config.js";
import { Kernel } from "./kernel.js";
import { management } from "./management-api.js";
import { AppError, errorText, invariant, registerSecret } from "./util.js";

async function body(req: IncomingMessage, max: number) {
  invariant(
    Number(req.headers["content-length"] || 0) <= max,
    "Request too large",
    413,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    invariant(size <= max, "Request too large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage, max = 8 * 1024 * 1024) {
  const bytes = await body(req, max);
  try {
    return bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    throw new AppError(400, "invalid_json", "Invalid JSON body");
  }
}
function respond(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function cursor(value: string | null | undefined) {
  const n = Number(value || 0);
  invariant(Number.isSafeInteger(n) && n >= 0, "Invalid event cursor");
  return n;
}
export async function apiToken(kernel: Kernel) {
  const configured = process.env[kernel.config.server.tokenEnv];
  if (configured) {
    invariant(
      configured.length >= 16,
      "API token must have at least 16 characters",
    );
    return configured;
  }
  const file = path.join(kernel.config.dataDir, "api-token");
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(kernel.config.dataDir, { recursive: true });
    const token = randomBytes(32).toString("hex");
    await writeFile(file, token, { mode: 0o600, flag: "wx" });
    return token;
  }
}
export async function serve(kernel: Kernel, token?: string) {
  await kernel.init();
  const secret = token || (await apiToken(kernel));
  registerSecret(secret);
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof AppError
          ? error.status
          : error instanceof ZodError
            ? 400
            : 500;
      respond(
        res,
        {
          error: {
            code:
              error instanceof AppError
                ? error.code
                : error instanceof ZodError
                  ? "invalid_request"
                  : "internal_error",
            message:
              error instanceof ZodError
                ? error.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("; ")
                : errorText(error),
          },
        },
        status,
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean),
      method = req.method || "GET";
    const origin = req.headers.origin;
    if (origin) {
      invariant(
        kernel.config.server.allowedOrigins.includes(origin),
        "Origin is not allowed",
        403,
        "origin_denied",
      );
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Last-Event-ID",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      );
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (url.pathname === "/health" && method === "GET") {
      respond(res, { ok: true, version: VERSION, protocol: 1 });
      return;
    }
    if (method === "GET" || method === "HEAD") {
      const metadata = await kernel.mcp.publicMetadata(
        url.pathname,
        method === "GET",
      );
      if (metadata) {
        const headers = {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": metadata.cacheControl,
          ETag: metadata.etag,
          "X-Content-Type-Options": "nosniff",
        };
        if (req.headers["if-none-match"] === metadata.etag) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        res.writeHead(200, headers);
        res.end(
          method === "HEAD" ? undefined : JSON.stringify(metadata.document),
        );
        return;
      }
    }
    for (const integration of kernel.integrations) {
      const handled = await integration.handlePublic?.(kernel, req, url, () =>
        json(req),
      );
      if (handled) {
        respond(res, handled.data, handled.status);
        return;
      }
    }
    const given = Buffer.from(
      req.headers.authorization?.replace(/^Bearer /, "") || "",
    );
    const expected = Buffer.from(secret);
    invariant(
      given.length === expected.length && timingSafeEqual(given, expected),
      "Bearer token required",
      401,
      "unauthorized",
    );
    invariant(parts[0] === "v1", "Unknown API version", 404);
    const { store } = kernel;
    if (url.pathname === "/v1/config" && method === "GET") {
      respond(res, publicConfig(kernel.config));
      return;
    }
    for (const integration of kernel.integrations) {
      const handled = await integration.handle?.(kernel, req, url, () =>
        json(req),
      );
      if (handled) {
        respond(res, handled.data, handled.status);
        return;
      }
    }
    const extra = await management(kernel, req, url, () =>
      json(
        req,
        url.pathname === "/v1/migrations/import"
          ? Math.ceil(kernel.config.limits.maxMigrationBytes * 1.4) +
              9 * 1024 * 1024
          : 8 * 1024 * 1024,
      ),
    );
    if (extra) {
      respond(res, extra.data, extra.status);
      return;
    }
    if (parts[1] === "projects" && parts.length === 2) {
      if (method === "GET") {
        respond(res, { projects: store.list<Project>("projects") });
        return;
      }
      if (method === "POST") {
        const p = z
          .object({
            name: z.string().min(1).max(200),
            directory: z.string().optional(),
          })
          .strict()
          .parse(await json(req));
        respond(res, await kernel.createProject(p.name, p.directory), 201);
        return;
      }
    }
    if (parts[1] === "sessions" && parts.length === 2) {
      if (method === "GET") {
        respond(res, {
          sessions: store
            .list<Session>("sessions")
            .filter(
              (s) =>
                !url.searchParams.get("projectId") ||
                s.projectId === url.searchParams.get("projectId"),
            ),
        });
        return;
      }
      if (method === "POST") {
        const p = z
          .object({
            projectId: z.string(),
            mode: modeIdSchema.default("chat"),
            name: z.string().optional(),
            routeId: z.string().optional(),
            agentId: z.string().optional(),
          })
          .strict()
          .parse(await json(req));
        respond(
          res,
          kernel.createSession(
            p.projectId,
            p.mode,
            p.name,
            p.routeId,
            p.agentId,
          ),
          201,
        );
        return;
      }
    }
    if (parts[1] === "sessions" && parts[2]) {
      const session = store.session(parts[2]);
      if (parts.length === 3 && method === "GET") {
        respond(res, {
          session,
          ...store.transcriptPage(
            session.id,
            cursor(url.searchParams.get("after")),
            Number(url.searchParams.get("limit") || 100),
          ),
          runs: store
            .list<Run>("runs")
            .filter((r) => r.sessionId === session.id),
        });
        return;
      }
      if (parts.length === 3 && method === "PATCH") {
        const p = z
          .object({
            mode: modeIdSchema.optional(),
            routeId: z.string().optional(),
            name: z.string().max(200).optional(),
            autonomy: z.enum(["plan", "assist", "autonomous"]).optional(),
            archived: z.boolean().optional(),
            agentId: z.string().optional(),
          })
          .strict()
          .parse(await json(req));
        respond(res, kernel.updateSession(session.id, p));
        return;
      }
      if (parts[3] === "inputs" && parts.length === 4 && method === "POST") {
        const result = await kernel.submit(session.id, await json(req));
        respond(
          res,
          { ...result, events: `/v1/runs/${result.runId}/events` },
          202,
        );
        return;
      }
    }
    if (parts[1] === "runs" && parts[2]) {
      const run = store.run(parts[2]);
      if (parts.length === 3 && method === "GET") {
        respond(res, run);
        return;
      }
      if (parts[3] === "cancel" && method === "POST") {
        respond(res, kernel.cancel(run.id), 202);
        return;
      }
      if (parts[3] === "events" && method === "GET") {
        const after = cursor(
          url.searchParams.get("after") ||
            req.headers["last-event-id"]?.toString(),
        );
        if (url.searchParams.get("format") === "json") {
          const events = store.replay(run.id, after);
          respond(res, {
            events,
            cursor: events.at(-1)?.seq || after,
            status: store.run(run.id).status,
          });
          return;
        }
        await streamRunEvents(store, run.id, after, res);
        return;
      }
    }
    if (parts[1] === "assets") {
      if (parts.length === 2 && method === "POST") {
        const projectId = url.searchParams.get("projectId"),
          name = url.searchParams.get("name");
        invariant(
          projectId && name,
          "projectId and name query parameters required",
        );
        store.project(projectId);
        const asset = await kernel.assets.create(
          projectId,
          name,
          await body(req, kernel.config.limits.maxUploadBytes),
        );
        respond(
          res,
          { ...asset, download: `/v1/assets/${asset.id}/content` },
          201,
        );
        return;
      }
      if (parts.length === 2 && method === "GET") {
        respond(res, {
          assets: store
            .list<Asset>("assets")
            .filter(
              (a) =>
                !url.searchParams.get("projectId") ||
                a.projectId === url.searchParams.get("projectId"),
            ),
        });
        return;
      }
      if (parts[2] && method === "GET") {
        const asset = store.asset(parts[2]);
        if (parts[3] === "content") {
          const bytes = await kernel.assets.read(asset.id, asset.projectId);
          res.writeHead(200, {
            "Content-Type": asset.mime,
            "Content-Length": asset.size,
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
          });
          res.end(bytes);
          return;
        }
        respond(res, asset);
        return;
      }
    }
    if (
      parts[1] === "approvals" &&
      parts[2] &&
      parts[3] === "resolve" &&
      method === "POST"
    ) {
      const p = z
        .object({ allow: z.boolean() })
        .strict()
        .parse(await json(req));
      kernel.permissions.resolve(parts[2], p.allow);
      respond(res, store.approval(parts[2]));
      return;
    }
    if (url.pathname === "/v1/approvals" && method === "GET") {
      respond(res, {
        approvals: store
          .list<Approval>("approvals")
          .filter((a) => a.status === "pending"),
      });
      return;
    }
    if (parts[1] === "jobs") {
      if (parts.length === 2 && method === "GET") {
        respond(res, { jobs: store.list<Job>("jobs") });
        return;
      }
      if (parts.length === 2 && method === "POST") {
        const p = z
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
          .strict()
          .parse(await json(req));
        // Authenticated direct submissions are explicit human/API requests. Agent tool submissions use Permissions.
        invariant(
          kernel.config.permissions.media !== "deny",
          "Media disabled",
          403,
        );
        const selectedRoute = p.routeId || kernel.config.defaultRoutes[p.kind];
        invariant(
          !selectedRoute ||
            kernel.config.routes[selectedRoute]?.adapter !== "custom-media" ||
            kernel.config.permissions.plugin !== "deny",
          "Plugin media adapters disabled",
          403,
        );
        respond(res, kernel.media.create(p), 202);
        return;
      }
      if (parts[2] && method === "GET") {
        respond(res, store.job(parts[2]));
        return;
      }
      if (parts[2] && parts[3] === "cancel" && method === "POST") {
        respond(res, await kernel.media.cancel(parts[2]), 202);
        return;
      }
    }
    throw new AppError(404, "not_found", "Endpoint not found");
  }
  server.on("upgrade", (req, socket, head) => {
    for (const integration of kernel.integrations)
      if (integration.upgrade?.(req, socket, head)) return;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      kernel.config.server.port,
      kernel.config.server.host,
      resolve,
    );
  });
  const address = server.address() as { port: number };
  return {
    url: `http://${kernel.config.server.host}:${address.port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await kernel.close();
    },
  };
}
