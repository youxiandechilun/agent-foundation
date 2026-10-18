import { z } from "zod";
import { apiRoutes, input, status } from "../route-table.js";

const acknowledgement = z
  .object({ acknowledgeUnknown: z.boolean().default(false) })
  .strict();
export const mcpRoutes = apiRoutes({
  "GET mcp": ({ k }) => ({ servers: k.mcp.list() }),
  "POST mcp": status(201, async ({ k, json }) => {
    const server = k.mcp.install(await json());
    if (server.enabled) await k.mcp.connect(server.id);
    return k.mcp.get(server.id);
  }),
  "DELETE mcp/:id": async ({ k, id }) => {
    await k.mcp.remove(id);
    return { deleted: true };
  },
  "GET mcp-interactions": ({ k, url }) => ({
    interactions: k.mcp.interactions.list(
      url.searchParams.get("serverId") || undefined,
    ),
  }),
  "POST mcp-interactions/:id/resolve": async ({ k, id, json }) =>
    k.mcp.interactions.resolve(id, await json()),
  "POST mcp/:id/connect": async ({ k, id }) => {
    await k.mcp.connect(id);
    return k.mcp.get(id);
  },
  "POST mcp/:id/disconnect": ({ k, id }) => k.mcp.disconnect(id),
  "GET mcp/:id/auth": ({ k, id }) => k.mcp.authStatus(id),
  "DELETE mcp/:id/auth": ({ k, id }) => k.mcp.authClear(id),
  "POST mcp/:id/auth-begin": ({ k, id }) => k.mcp.authBegin(id),
  "POST mcp/:id/auth-complete": input(
    z.object({ callbackUrl: z.string().url().max(16000) }).strict(),
    ({ k, id }, v) => k.mcp.authComplete(id, v.callbackUrl),
  ),
  "GET mcp/:id/registration": ({ k, id }) => k.mcp.registrationStatus(id),
  "POST mcp/:id/register": ({ k, id }) => k.mcp.registerClient(id),
  "POST mcp/:id/registration-read": input(acknowledgement, ({ k, id }, v) =>
    k.mcp.remoteRegistration(id, "GET", undefined, v.acknowledgeUnknown),
  ),
  "PUT mcp/:id/registration-remote": input(
    z.object({ changes: z.record(z.string(), z.unknown()) }).strict(),
    ({ k, id }, v) => k.mcp.remoteRegistration(id, "PUT", v.changes),
  ),
  "DELETE mcp/:id/registration-remote": ({ k, id }) =>
    k.mcp.remoteRegistration(id, "DELETE"),
  "DELETE mcp/:id/registration": input(acknowledgement, ({ k, id }, v) =>
    k.mcp.resetRegistration(id, v.acknowledgeUnknown),
  ),
  "POST mcp/:id/auth-device": ({ k, id }) => k.mcp.deviceBegin(id),
  "GET mcp/:id/auth-device": ({ k, id }) => k.mcp.deviceStatus(id),
  "DELETE mcp/:id/auth-device": ({ k, id }) => k.mcp.deviceCancel(id),
  "POST mcp/:id/auth-device-poll": ({ k, id }) => k.mcp.devicePoll(id),
  "GET mcp/:id/auth-keys": ({ k, id }) => k.mcp.keyStatus(id),
  "POST mcp/:id/auth-keys-rotate": ({ k, id }) => k.mcp.keyStatus(id, true),
  "GET mcp/:id/tools": async ({ k, id }) => ({
    tools: await k.mcp.catalog(id),
  }),
  "GET mcp/:id/resources": ({ k, id }) => k.mcp.resources(id),
  "POST mcp/:id/read-resource": input(
    z.object({ uri: z.string() }),
    ({ k, id }, v) => k.mcp.readResource(id, v.uri),
  ),
  "GET mcp/:id/prompts": ({ k, id }) => k.mcp.prompts(id),
  "GET mcp/:id/templates": ({ k, id }) => k.mcp.templates(id),
  "GET mcp/:id/notifications": ({ k, id }) => ({
    notifications: k.mcp.notifications(id),
  }),
  "POST mcp/:id/complete": input(
    z
      .object({
        ref: z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("ref/prompt"),
              name: z.string().min(1).max(2000),
            })
            .strict(),
          z
            .object({
              type: z.literal("ref/resource"),
              uri: z.string().min(1).max(8192),
            })
            .strict(),
        ]),
        argument: z
          .object({
            name: z.string().min(1).max(200),
            value: z.string().max(2000),
          })
          .strict(),
        context: z
          .object({ arguments: z.record(z.string(), z.string().max(2000)) })
          .strict()
          .optional(),
      })
      .strict(),
    ({ k, id }, v) => k.mcp.completeArgument(id, v),
  ),
  "PUT mcp/:id/logging": input(
    z
      .object({
        level: z.enum([
          "debug",
          "info",
          "notice",
          "warning",
          "error",
          "critical",
          "alert",
          "emergency",
        ]),
      })
      .strict(),
    ({ k, id }, v) => k.mcp.setLoggingLevel(id, v.level),
  ),
  "PUT mcp/:id/roots": input(
    z
      .object({
        roots: z
          .array(
            z
              .object({
                uri: z.string().url(),
                name: z.string().max(200).optional(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    async ({ k, id }, v) => ({ roots: await k.mcp.roots(id, v.roots) }),
  ),
  "POST mcp/:id/subscribe": input(
    z
      .object({
        toolsListChanged: z.boolean().optional(),
        promptsListChanged: z.boolean().optional(),
        resourcesListChanged: z.boolean().optional(),
        taskIds: z.array(z.string().min(1).max(512)).max(100).optional(),
        resourceSubscriptions: z
          .array(z.string().min(1).max(8192))
          .max(100)
          .optional(),
      })
      .strict(),
    ({ k, id }, v) => k.mcp.subscribe(id, v),
  ),
  "POST mcp/:id/unsubscribe": input(
    z.object({ id: z.string(), uri: z.string().optional() }).strict(),
    ({ k, id }, v) => k.mcp.unsubscribe(id, v.id, v.uri),
  ),
  "GET mcp/:id/tasks": ({ k, id }) => ({ tasks: k.mcp.tasks(id) }),
  "GET mcp/:id/client-tasks": ({ k, id }) => ({
    tasks: k.mcp.receivedTasks(id),
  }),
  "POST mcp/:id/task": input(
    z
      .object({ id: z.string(), action: z.enum(["get", "result", "cancel"]) })
      .strict(),
    ({ k, id }, v) => k.mcp.task(id, v.id, v.action),
  ),
  "POST mcp/:id/get-prompt": input(
    z.object({
      name: z.string(),
      arguments: z.record(z.string(), z.string()).optional(),
    }),
    ({ k, id }, v) => k.mcp.prompt(id, v.name, v.arguments),
  ),
});
