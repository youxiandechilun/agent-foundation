import { VERSION } from "../version.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { publicConfig } from "../core/config.js";
import { Kernel } from "../core/kernel.js";
import { management } from "./management.js";
import {
  AppError,
  errorText,
  invariant,
  registerSecret,
} from "../core/util.js";
import {
  json,
  respond,
  respondJsonStream,
  respondChunkStream,
  JsonStreamResponse,
  requestSignal,
  type HttpContext,
} from "./shared.js";
import { sessionRoutes } from "./routes/sessions.js";
import { resourceRoutes } from "./routes/resources.js";
import { listenHttp } from "../transport/http-listener.js";

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
  kernel.redaction.run(() => registerSecret(secret));
  const expected = Buffer.from(secret);
  const server = http.createServer((req, res) => {
    void kernel.redaction.run(() =>
      handle(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          // A failed partial stream must not acquire a normal completion marker
          // after pipeline has destroyed it (notably after the close event).
          if (!res.destroyed) res.destroy();
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
      }),
    );
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
    invariant(
      given.length === expected.length && timingSafeEqual(given, expected),
      "Bearer token required",
      401,
      "unauthorized",
    );
    invariant(parts[0] === "v1", "Unknown API version", 404);
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
    const context: HttpContext = {
      k: kernel,
      req,
      res,
      url,
      parts,
      method,
      json: () =>
        json(
          req,
          url.pathname === "/v1/migrations/import"
            ? Math.ceil(kernel.config.limits.maxMigrationBytes * 1.4) +
                9 * 1024 * 1024
            : 8 * 1024 * 1024,
        ),
    };
    const isMigration =
      url.pathname === "/v1/migrations/import" ||
      (method === "GET" &&
        parts.length === 4 &&
        parts[1] === "sessions" &&
        parts[3] === "migration");
    const releaseTransfer = isMigration
      ? kernel.migrations.reserveTransfer()
      : undefined;
    const transferSignal = requestSignal(req, res);
    context.signal = transferSignal.signal;
    try {
      for (const route of [management, sessionRoutes, resourceRoutes]) {
        const result = await route(context);
        if (result === undefined) continue;
        if (result !== true) {
          if (result.data instanceof JsonStreamResponse)
            await respondChunkStream(req, res, result.data, result.status);
          else if (isMigration)
            await respondJsonStream(req, res, result.data, result.status);
          else respond(res, result.data, result.status);
        }
        return;
      }
      throw new AppError(404, "not_found", "Endpoint not found");
    } finally {
      transferSignal.close();
      releaseTransfer?.();
    }
  }
  server.on("upgrade", (req, socket, head) => {
    kernel.redaction.run(() => {
      for (const integration of kernel.integrations)
        if (integration.upgrade?.(req, socket, head)) return;
      socket.destroy();
    });
  });
  const address = await listenHttp(server, kernel.config.server);
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
