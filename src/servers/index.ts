import { z } from "zod";
import type { Kernel } from "../core/kernel.js";
import type { KernelIntegration } from "../runtime/registry.js";
import { invariant } from "../core/util.js";
import { ServerManager } from "./manager.js";
import { serverTools } from "./tools.js";
import { serverIdSchema, type ServerIntegrationOptions } from "./types.js";

export { ServerManager } from "./manager.js";
export { hostFingerprint } from "./ssh.js";
export {
  serverInputSchema,
  serverProfileSchema,
  credentialsSchema,
  serverFactSchema,
} from "./types.js";
export type {
  ServerProfile,
  ServerInput,
  ServerFact,
  ServerCredentials,
  ServerIntegrationOptions,
  CommandEvidence,
} from "./types.js";

/** Opt-in host integration. Merely importing this entry point never loads ssh2. */
export function serverIntegration(
  options: ServerIntegrationOptions = {},
): KernelIntegration {
  let manager: ServerManager | undefined, owner: Kernel | undefined;
  const get = (kernel: Kernel): ServerManager => {
    invariant(
      !owner || owner === kernel,
      "A server integration instance belongs to one kernel",
      409,
    );
    if (!manager) {
      owner = kernel;
      manager = new ServerManager(kernel.store, kernel.config.dataDir, options);
    }
    return manager;
  };
  return {
    id: "servers",
    install: (kernel) => {
      get(kernel);
    },
    tools: (context) => serverTools(context, get(context.kernel)),
    handle: async (kernel, request, url, json) => {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1" || parts[1] !== "servers") return;
      const service = get(kernel),
        method = request.method,
        serverId = parts[2],
        operation = parts[3];
      invariant(parts.length <= 4, "Server endpoint not found", 404);
      if (!serverId) {
        if (method === "GET")
          return {
            data: {
              servers: service.list(
                url.searchParams.get("projectId") ?? undefined,
              ),
            },
          };
        if (method === "POST")
          return { data: service.create(await json()), status: 201 };
      } else if (
        serverId === "probe" &&
        parts.length === 3 &&
        method === "POST"
      ) {
        return { data: await service.probe(await json()) };
      } else {
        serverIdSchema.parse(serverId);
        if (!operation) {
          if (method === "GET")
            return {
              data: service.read(
                serverId,
                url.searchParams.get("projectId") ?? undefined,
              ),
            };
          if (method === "PUT")
            return { data: await service.update(serverId, await json()) };
          if (method === "DELETE")
            return { data: await service.remove(serverId) };
        }
        if (operation === "credentials") {
          if (method === "PUT")
            return {
              data: await service.setCredentials(serverId, await json()),
            };
          if (method === "DELETE")
            return { data: await service.deleteCredentials(serverId) };
        }
        if (operation === "facts") {
          if (method === "GET")
            return {
              data: {
                facts: service.read(
                  serverId,
                  url.searchParams.get("projectId") ?? undefined,
                ).facts,
              },
            };
          if (method === "POST") {
            const value = z
              .object({
                projectId: z.string().min(1),
                text: z.string().min(1).max(12000),
              })
              .strict()
              .parse(await json());
            return {
              data: await service.remember(
                serverId,
                value.projectId,
                value.text,
                "user",
              ),
              status: 201,
            };
          }
        }
      }
      invariant(false, "Server endpoint or method not found", 404, "not_found");
    },
    close: (kernel) => {
      if (kernel && owner && kernel !== owner) return;
      manager?.close();
    },
  };
}
