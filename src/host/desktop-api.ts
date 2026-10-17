import type { IncomingMessage } from "node:http";
import type { DesktopKernel } from "./desktop.js";
import { invariant } from "../util.js";
import { z } from "zod";
import { id } from "../util.js";
export async function desktopManagement(
  k: DesktopKernel,
  req: IncomingMessage,
  url: URL,
  json: () => Promise<any>,
  signal?: AbortSignal,
) {
  const p = url.pathname.split("/").filter(Boolean),
    method = req.method,
    key = p[1],
    entity = p[2],
    op = p[3];
  if (key === "browser") {
    if (!entity && method === "GET")
      return {
        data: {
          browsers: k.browser.list(
            url.searchParams.get("projectId") || undefined,
          ),
        },
      };
    if (!entity && method === "POST") {
      const v = z
        .object({
          projectId: z.string(),
          owner: z.string().max(200).default("direct-user"),
          url: z.string().optional(),
          cdpEndpoint: z.string().optional(),
        })
        .strict()
        .parse(await json());
      invariant(
        k.config.permissions.browser !== "deny",
        "Browser disabled",
        403,
      );
      return {
        data: await k.browser.open(
          v.projectId,
          v.owner || "direct-user",
          v.url,
          v.cdpEndpoint,
          signal,
        ),
        status: 201,
      };
    }
    if (entity && op === "action" && method === "POST") {
      const v = z
        .object({ projectId: z.string(), owner: z.string().optional() })
        .passthrough()
        .parse(await json());
      invariant(
        k.config.permissions.browser !== "deny",
        "Browser disabled",
        403,
      );
      const { projectId, owner, ...action } = v;
      return {
        data: await k.browser.action(entity, projectId, action, signal, owner),
      };
    }
    if (entity && method === "DELETE") {
      const v = await json();
      return { data: await k.browser.closeSession(entity, v.projectId) };
    }
  }
  if (key === "computer") {
    if (method === "GET") return { data: k.computer.status() };
    if (entity === "action" && method === "POST") {
      const {
        projectId,
        runId = id("operator"),
        ...v
      } = z
        .object({
          projectId: z.string(),
          runId: z.string().max(200).optional(),
        })
        .passthrough()
        .parse(await json());
      invariant(
        k.config.permissions.computer !== "deny",
        "Computer disabled",
        403,
      );
      k.store.project(projectId);
      const stop = new AbortController();
      const abort = () => stop.abort(new Error("Computer API request aborted"));
      req.once("aborted", abort);
      try {
        return {
          data: await k.computer.action(
            runId,
            projectId,
            v,
            AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]),
          ),
        };
      } finally {
        req.removeListener("aborted", abort);
        k.computer.release(runId, projectId);
      }
    }
    if (entity === "release" && method === "POST") {
      const v = await json();
      k.computer.release(
        z.string().parse(v.runId),
        z.string().parse(v.projectId),
      );
      return { data: k.computer.status() };
    }
    if (entity === "stop" && method === "POST")
      return { data: await k.computer.emergencyStop() };
    if (entity === "resume" && method === "POST")
      return { data: k.computer.resume() };
  }
  if (key === "nodes") {
    if (!entity && method === "GET")
      return {
        data: {
          nodes: k.nodes.list(url.searchParams.get("projectId") || undefined),
        },
      };
    if (entity === "pair" && method === "POST")
      return { data: k.nodes.pair(await json()), status: 201 };
    if (entity && op === "call" && method === "POST") {
      const v = await json();
      invariant(k.config.permissions.node !== "deny", "Node disabled", 403);
      return {
        data: await k.nodes.call(
          v.projectId,
          entity,
          v.capability,
          v.args,
          v.timeoutMs,
        ),
      };
    }
    if (entity && method === "DELETE") {
      k.nodes.revoke(entity);
      return { data: { revoked: true } };
    }
  }
}
