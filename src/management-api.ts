import type { IncomingMessage } from "node:http";
import { VERSION } from "./version.js";
import {
  MCP_MODERN_VERSION,
  MCP_PROTOCOL_VERSIONS,
} from "./extensions/mcp-client.js";
import { z } from "zod";
import type { Kernel } from "./kernel.js";
import { routeSchema, parseConfig } from "./config.js";
import { invariant, atomicWrite } from "./util.js";
import path from "node:path";
import type { ToolEffect } from "./contracts.js";
import { modeDefinitionSchema, modeIdSchema } from "./modes/registry.js";

export async function management(
  k: Kernel,
  req: IncomingMessage,
  url: URL,
  json: () => Promise<any>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const p = url.pathname.split("/").filter(Boolean),
    method = req.method;
  if (p[0] !== "v1") return;
  const key = p[1],
    entity = p[2],
    op = p[3];
  if (
    key === "sessions" &&
    entity &&
    op === "process-actions" &&
    method === "POST"
  ) {
    const v = z
      .object({
        action: z.enum(["start", "read", "write", "resize", "stop", "list"]),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .strict()
      .parse(await json());
    return {
      data: k.processAction(entity, v.action, v.arguments),
      status: 202,
    };
  }
  if (key === "costs") {
    if (!entity && method === "GET")
      return {
        data: {
          budgets: k.config.budgets,
          ...k.costs.summary({
            projectId: url.searchParams.get("projectId") || undefined,
            sessionId: url.searchParams.get("sessionId") || undefined,
            runId: url.searchParams.get("runId") || undefined,
          }),
        },
      };
    if (entity && op === "reconcile" && method === "POST") {
      const v = z
        .object({
          actualUsd: z.number().nonnegative().max(1e9),
          reference: z.string().min(3).max(2000),
        })
        .strict()
        .parse(await json());
      return { data: k.costs.reconcile(entity, v.actualUsd, v.reference) };
    }
  }
  if (key === "execution" && entity === "probe" && method === "POST")
    return {
      data: await k.commands.probe(k.config.workspaceRoots[0]),
    };
  if (key === "capabilities" && method === "GET")
    return {
      data: {
        version: VERSION,
        runtime: "foundation-owned",
        deployment: {
          mode: "single-user",
          embedded: true,
          accounts: false,
          multiTenant: false,
          managementAuthorization: "host-token",
          oauthPurpose: "optional-external-mcp-authorization",
        },
        textProtocols: [
          "openai-completions",
          "openai-responses",
          "anthropic-messages",
        ],
        mediaAdapters: k.media.adapters.list(),
        modes: k.modes.list(),
        transports: ["http-json", "sse"],
        toolPacks: k.toolRegistry.list(),
        integrations: k.integrations.map((i) => i.id),
        execution: k.config.execution,
        executionSupport: {
          selectedBoundary: k.config.execution.boundary,
          extensionBoundary: k.config.extensions.executionBoundary,
          dockerOptional: true,
          requiresRuntimeProbe: k.config.execution.boundary !== "native",
          windowsAppContainer: {
            platformSupported: process.platform === "win32",
            persistentPipes: true,
            pty: false,
            networkModes: ["none", "internet"],
            nodeSubprocessPipes:
              Number(process.versions.uv.split(".")[0]) > 1 ||
              Number(process.versions.uv.split(".")[1]) >= 53
                ? "native-runtime-probe-required"
                : "unsupported-use-inherited-or-file-stdio",
          },
          startupRecovery: k.sandboxRecovery,
        },
        scheduler: k.scheduler.state,
        processControl: true,
        budgets: k.config.budgets,

        memory: {
          fullText: true,
          semantic: Boolean(k.config.defaultRoutes.embedding),
          automaticExtraction: k.config.memory.autoExtract,
        },
        extensions: {
          skills: true,
          plugins: true,
          mcp: ["stdio", "streamable-http"],
          mcpProtocolVersions: [MCP_MODERN_VERSION, ...MCP_PROTOCOL_VERSIONS],
          mcpClientInputs: [
            "roots",
            "elicitation-form",
            "elicitation-url",
            "sampling-with-consent",
          ],
          mcpOAuth: "pre-registered-pkce",
          mcpOAuthOptional: true,
          mcpOAuthConfigured: k.mcp
            .list()
            .some((server) => Boolean(server.oauth)),
          sourcePluginIsolation: [
            "native",
            "docker-optional",
            "windows-appcontainer-optional",
          ],
          portableSessionAssets: "foundation-migration-v1",
        },
      },
    };
  if (key === "routes") {
    if (!entity && method === "GET")
      return {
        data: {
          routes: Object.entries(k.config.routes).map(([id, r]) => ({
            id,
            kind: r.kind,
            adapter: r.adapter,
            model: r.model,
            baseUrl: r.baseUrl,
            pricing: r.pricing,
            enabled: r.enabled,
            apiKeyEnv: r.apiKeyEnv,
          })),
        },
      };
    if (entity && method === "PUT") {
      const route = routeSchema.parse(await json());
      await k.updateRoutes({ set: { [entity]: route } });
      return { data: { id: entity, route } };
    }
    if (!entity && method === "PATCH") {
      const v = z
        .object({
          set: z.record(z.string(), routeSchema).optional(),
          remove: z.array(z.string()).optional(),
          defaultRoutes: z
            .record(z.string(), z.string().min(1).nullable())
            .optional(),
        })
        .strict()
        .parse(await json());
      return { data: await k.updateRoutes(v) };
    }
    if (entity && method === "DELETE")
      return { data: await k.updateRoutes({ remove: [entity] }) };
  }
  if (key === "modes") {
    if (!entity && method === "GET") return { data: { modes: k.modes.list() } };
    if (method === "POST" && !entity) {
      invariant(
        !k.store
          .list<any>("runs")
          .some((r) =>
            ["running", "queued", "waiting_approval"].includes(r.status),
          ),
        "Change modes while host is idle",
        409,
      );
      const definition = modeDefinitionSchema.parse(await json());
      if (definition.defaultRouteId)
        invariant(
          k.config.routes[definition.defaultRouteId]?.kind === "text",
          "Mode default route is not a text route",
        );
      k.modes.put(definition);
      k.store.put("mode-profiles", definition);
      return { data: definition, status: 201 };
    }
    if (entity && method === "DELETE") {
      invariant(
        !k.store
          .list<any>("sessions")
          .some((s) => !s.archived && s.mode === entity),
        "Mode is used by a session",
        409,
      );
      k.modes.remove(entity);
      k.store.remove("mode-profiles", entity);
      return { data: { deleted: true } };
    }
  }

  if (key === "memories") {
    if (
      entity &&
      !op &&
      method === "GET" &&
      !["export", "import", "merge", "prune", "semantic-search"].includes(
        entity,
      )
    ) {
      const memory = k.store.get<any>("memories", entity);
      return { data: k.memory.get(entity, memory.projectId) };
    }
    if (entity === "import" && method === "POST") {
      const v = z
        .object({
          projectId: z.string(),
          entries: z.array(z.unknown()).max(10000),
        })
        .strict()
        .parse(await json());
      return { data: { memories: k.memory.import(v.projectId, v.entries) } };
    }
    if (entity === "merge" && method === "POST") {
      const v = z
        .object({
          projectId: z.string(),
          ids: z.array(z.string()).min(2).max(100),
          content: z.string().min(1).max(32000),
        })
        .strict()
        .parse(await json());
      return { data: k.memory.merge(v.projectId, v.ids, v.content) };
    }
    if (entity === "prune" && method === "POST") {
      const v = z
        .object({ projectId: z.string() })
        .strict()
        .parse(await json());
      return { data: k.memory.pruneExpired(v.projectId) };
    }
    if (entity === "export" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      invariant(projectId, "projectId required");
      return {
        data: {
          format: "foundation-memory-v1",
          memories: k.memory.list(
            projectId,
            url.searchParams.get("namespace") || undefined,
          ),
        },
      };
    }
    if (entity && op === "history" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      invariant(projectId, "projectId required");
      return { data: { revisions: k.memory.history(entity, projectId) } };
    }
    if (!entity && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      invariant(projectId, "projectId required");
      const query = url.searchParams.get("q");
      return {
        data: {
          memories: query
            ? k.memory.search(
                projectId,
                query,
                Number(url.searchParams.get("limit") || 8),
                url.searchParams.get("namespace") || undefined,
              )
            : k.memory.list(
                projectId,
                url.searchParams.get("namespace") || undefined,
              ),
        },
      };
    }
    if (!entity && method === "POST")
      return { data: k.memory.put(await json()), status: 201 };
    if (entity === "semantic-search" && method === "POST") {
      const q = await json();
      return {
        data: {
          memories: await k.memory.semanticSearch(
            q.projectId,
            q.query,
            q.limit,
            q.namespace,
          ),
        },
      };
    }
    if (entity && method === "DELETE") {
      const m = k.store.get<any>("memories", entity);
      k.memory.remove(entity, m.projectId);
      return { data: { deleted: true } };
    }
    if (entity && op === "embed" && method === "POST")
      return { data: await k.memory.embed(entity) };
  }
  if (key === "memory-proposals") {
    if (!entity && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      invariant(projectId, "projectId required");
      return { data: { proposals: k.memory.proposals(projectId) } };
    }
    if (entity && op === "resolve" && method === "POST") {
      const v = z
        .object({ allow: z.boolean() })
        .strict()
        .parse(await json());
      invariant(
        !v.allow || k.config.permissions["memory.write"] !== "deny",
        "Memory writes disabled",
        403,
      );
      return { data: k.memory.resolve(entity, v.allow) };
    }
  }
  if (key === "skills") {
    if (entity && op === "export" && method === "GET")
      return { data: k.skills.export(entity) };
    if (entity && op === "resource" && method === "GET") {
      const name = url.searchParams.get("path");
      invariant(name, "resource path required");
      return { data: k.skills.resource(entity, name) };
    }
    if (entity && method === "GET") return { data: k.skills.get(entity) };
    if (!entity && method === "GET")
      return { data: { skills: k.skills.list() } };
    if (!entity && method === "POST") {
      const v = z
        .object({
          source: z.string().optional(),
          directory: z.string().optional(),
          resources: z
            .record(
              z.string(),
              z.union([
                z.string(),
                z
                  .object({
                    encoding: z.enum(["utf8", "base64"]),
                    data: z.string(),
                  })
                  .strict(),
              ]),
            )
            .optional(),
        })
        .strict()
        .parse(await json());
      invariant(
        Boolean(v.directory) !== Boolean(v.source),
        "Provide source or directory",
      );
      return {
        data: v.directory
          ? await k.skills.installDirectory(v.directory)
          : k.skills.install(v.source!, v.resources),
        status: 201,
      };
    }
    if (entity && method === "PATCH") {
      const v = z
        .object({ enabled: z.boolean() })
        .strict()
        .parse(await json());
      return { data: k.skills.enable(entity, v.enabled) };
    }
    if (entity && method === "DELETE") {
      k.skills.remove(entity);
      return { data: { deleted: true } };
    }
  }
  if (key === "plugins") {
    if (entity && op === "export" && method === "GET")
      return { data: await k.plugins.export(entity) };
    if (entity && op === "verify" && method === "POST")
      return { data: await k.plugins.verify(entity) };
    if (!entity && method === "GET")
      return { data: { plugins: k.plugins.list() } };
    if (!entity && method === "POST") {
      const v = await json();
      return {
        data: v.directory
          ? await k.plugins.installDirectory(v.directory)
          : await k.plugins.install(v.manifest, v.files),
        status: 201,
      };
    }
    if (entity && method === "PATCH") {
      const v = z
        .object({ enabled: z.boolean(), trustedHash: z.string().optional() })
        .strict()
        .parse(await json());
      return { data: k.plugins.enable(entity, v.enabled, v.trustedHash) };
    }
    if (entity && method === "DELETE") {
      k.plugins.remove(entity);
      return { data: { deleted: true } };
    }
  }
  if (key === "mcp-interactions") {
    if (!entity && method === "GET")
      return {
        data: {
          interactions: k.mcp.interactions.list(
            url.searchParams.get("serverId") || undefined,
          ),
        },
      };
    if (entity && op === "resolve" && method === "POST")
      return { data: k.mcp.interactions.resolve(entity, await json()) };
  }
  if (key === "mcp") {
    if (!entity && method === "GET") return { data: { servers: k.mcp.list() } };
    if (!entity && method === "POST") {
      const input = await json(),
        d = k.mcp.install(input);
      if (d.enabled) await k.mcp.connect(d.id);
      return { data: k.mcp.list().find((s) => s.id === d.id), status: 201 };
    }
    if (entity && op === "connect" && method === "POST") {
      await k.mcp.connect(entity);
      return { data: k.mcp.list().find((s) => s.id === entity) };
    }
    if (entity && op === "auth" && method === "GET")
      return { data: await k.mcp.authStatus(entity) };
    if (entity && op === "registration" && method === "GET")
      return { data: await k.mcp.registrationStatus(entity) };
    if (entity && op === "register" && method === "POST")
      return { data: await k.mcp.registerClient(entity) };
    if (entity && op === "registration-read" && method === "POST") {
      const v = z
        .object({ acknowledgeUnknown: z.boolean().default(false) })
        .strict()
        .parse(await json());
      return {
        data: await k.mcp.remoteRegistration(
          entity,
          "GET",
          undefined,
          v.acknowledgeUnknown,
        ),
      };
    }
    if (entity && op === "registration-remote" && method === "PUT") {
      const v = z
        .object({ changes: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(await json());
      return { data: await k.mcp.remoteRegistration(entity, "PUT", v.changes) };
    }
    if (entity && op === "registration-remote" && method === "DELETE")
      return { data: await k.mcp.remoteRegistration(entity, "DELETE") };
    if (entity && op === "auth-device" && method === "POST")
      return { data: await k.mcp.deviceBegin(entity) };
    if (entity && op === "auth-device" && method === "GET")
      return { data: await k.mcp.deviceStatus(entity) };
    if (entity && op === "auth-device" && method === "DELETE")
      return { data: k.mcp.deviceCancel(entity) };
    if (entity && op === "auth-device-poll" && method === "POST")
      return { data: await k.mcp.devicePoll(entity) };
    if (entity && op === "auth-keys" && method === "GET")
      return { data: await k.mcp.keyStatus(entity) };
    if (entity && op === "auth-keys-rotate" && method === "POST")
      return { data: await k.mcp.keyStatus(entity, true) };
    if (entity && op === "registration" && method === "DELETE") {
      const input = z
        .object({ acknowledgeUnknown: z.boolean().default(false) })
        .strict()
        .parse(await json());
      return {
        data: await k.mcp.resetRegistration(entity, input.acknowledgeUnknown),
      };
    }
    if (entity && op === "auth-begin" && method === "POST")
      return { data: await k.mcp.authBegin(entity) };
    if (entity && op === "auth-complete" && method === "POST") {
      const v = z
        .object({ callbackUrl: z.string().url().max(16000) })
        .strict()
        .parse(await json());
      return { data: await k.mcp.authComplete(entity, v.callbackUrl) };
    }
    if (entity && op === "auth" && method === "DELETE")
      return { data: await k.mcp.authClear(entity) };
    if (entity && op === "disconnect" && method === "POST")
      return { data: await k.mcp.disconnect(entity) };
    if (entity && op === "tools" && method === "GET")
      return { data: { tools: await k.mcp.catalog(entity) } };
    if (entity && op === "resources" && method === "GET")
      return { data: await k.mcp.resources(entity) };
    if (entity && op === "read-resource" && method === "POST") {
      const v = await json();
      return { data: await k.mcp.readResource(entity, v.uri) };
    }
    if (entity && op === "prompts" && method === "GET")
      return { data: await k.mcp.prompts(entity) };
    if (entity && op === "templates" && method === "GET")
      return { data: await k.mcp.templates(entity) };
    if (entity && op === "notifications" && method === "GET")
      return { data: { notifications: k.mcp.notifications(entity) } };
    if (entity && op === "complete" && method === "POST") {
      const v = z
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
        .strict()
        .parse(await json());
      return { data: await k.mcp.completeArgument(entity, v) };
    }
    if (entity && op === "logging" && method === "PUT") {
      const v = z
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
        .strict()
        .parse(await json());
      return { data: await k.mcp.setLoggingLevel(entity, v.level) };
    }
    if (entity && op === "roots" && method === "PUT") {
      const v = z
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
        .strict()
        .parse(await json());
      return { data: { roots: await k.mcp.roots(entity, v.roots) } };
    }
    if (entity && op === "subscribe" && method === "POST") {
      const v = z
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
        .strict()
        .parse(await json());
      return { data: await k.mcp.subscribe(entity, v) };
    }
    if (entity && op === "unsubscribe" && method === "POST") {
      const v = z
        .object({ id: z.string(), uri: z.string().optional() })
        .strict()
        .parse(await json());
      return { data: await k.mcp.unsubscribe(entity, v.id, v.uri) };
    }
    if (entity && op === "tasks" && method === "GET")
      return { data: { tasks: k.mcp.tasks(entity) } };
    if (entity && op === "client-tasks" && method === "GET")
      return { data: { tasks: k.mcp.receivedTasks(entity) } };
    if (entity && op === "task" && method === "POST") {
      const v = z
        .object({ id: z.string(), action: z.enum(["get", "result", "cancel"]) })
        .strict()
        .parse(await json());
      return { data: await k.mcp.task(entity, v.id, v.action) };
    }
    if (entity && op === "get-prompt" && method === "POST") {
      const v = await json();
      return { data: await k.mcp.prompt(entity, v.name, v.arguments) };
    }
    if (entity && method === "DELETE") {
      await k.mcp.remove(entity);
      return { data: { deleted: true } };
    }
  }
  if (key === "policies") {
    if (!entity && method === "GET")
      return { data: { rules: k.store.list("policies") } };
    if (!entity && method === "POST") {
      const rule = z
        .object({
          id: z.string().min(1),
          effect: z.enum(["allow", "ask", "deny"]),
          capabilities: z.array(
            z.enum([
              "files.read",
              "files.write",
              "exec",
              "media",
              "browser",
              "computer",
              "mcp",
              "plugin",
              "memory.read",
              "memory.write",
              "network",
              "node",
            ]),
          ),
          tools: z.array(z.string()).optional(),
          projectId: z.string().optional(),
          routeId: z.string().optional(),
          mode: modeIdSchema.optional(),
          pluginId: z.string().optional(),
          expiresAt: z.string().datetime().optional(),
        })
        .strict()
        .parse(await json());
      return { data: k.store.put("policies", rule), status: 201 };
    }
    if (entity && method === "DELETE") {
      k.store.remove("policies", entity);
      return { data: { deleted: true } };
    }
  }
  if (key === "agents") {
    if (!entity && method === "GET")
      return { data: { agents: k.agents.list() } };
    if (!entity && method === "POST")
      return { data: k.agents.put(await json()), status: 201 };
    if (entity && op === "start" && method === "POST") {
      const v = await json(),
        d = k.agents.get(entity),
        session = k.createSession(
          v.projectId,
          d.mode,
          v.name || d.name,
          d.routeId,
          d.id,
        );
      return {
        data: {
          session,
          ...(await k.submit(session.id, {
            text: v.text,
            assetIds: v.assetIds,
            skillIds: v.skillIds,
          })),
        },
        status: 202,
      };
    }
    if (entity && method === "GET") return { data: k.agents.get(entity) };
    if (entity && method === "DELETE") {
      k.agents.remove(entity);
      return { data: { deleted: true } };
    }
  }
  if (key === "sessions" && entity && op === "migration" && method === "GET")
    return { data: await k.exportMigration(entity) };
  if (key === "migrations" && entity === "import" && method === "POST") {
    const v = z
      .object({
        projectId: z.string(),
        bundle: z.unknown(),
        key: z.string().min(1).max(180),
        routeId: z.string().optional(),
      })
      .strict()
      .parse(await json());
    return {
      data: k.importMigration(v.projectId, v.bundle, v.key, v.routeId),
      status: 201,
    };
  }
  if (key === "migrations" && !entity && method === "GET") {
    const projectId = url.searchParams.get("projectId");
    invariant(projectId, "projectId required");
    k.store.project(projectId);
    return {
      data: {
        migrations: k.store
          .list<any>("session-migrations")
          .filter((r) => r.projectId === projectId),
      },
    };
  }
  if (key === "sessions" && entity === "import" && !op && method === "POST") {
    const v = z
      .object({
        projectId: z.string(),
        snapshot: z.unknown(),
        routeId: z.string().optional(),
      })
      .strict()
      .parse(await json());
    return {
      data: k.importSession(v.projectId, v.snapshot, v.routeId),
      status: 201,
    };
  }
  if (key === "sessions" && entity && op === "fork" && method === "POST") {
    const v = await json();
    return { data: k.forkSession(entity, v.throughMessageId), status: 201 };
  }
  if (key === "sessions" && entity && op === "export" && method === "GET")
    return {
      data: {
        session: k.store.session(entity),
        messages: k.store.transcript(entity),
        format: "foundation-session-v1",
      },
    };
  if (key === "runs" && entity) {
    if (op === "context" && method === "GET") {
      k.store.run(entity);
      return {
        data: k.store.find("work-contexts", entity) || {
          status: "not-prepared",
        },
      };
    }
    if (op === "resume" && method === "POST")
      return { data: await k.resume(entity), status: 202 };
    if (op === "effects" && method === "GET")
      return {
        data: {
          effects: k.store
            .list<ToolEffect>("effects")
            .filter((e) => e.runId === entity),
        },
      };
    if (op === "inbox" && method === "GET")
      return {
        data: {
          inputs: k.store.list<any>("inbox").filter((e) => e.runId === entity),
        },
      };
    if (op === "plan" && method === "GET")
      return { data: k.store.find("work-plans", entity) || { steps: [] } };
  }
  if (key === "jobs" && entity && op === "recover" && method === "POST")
    return { data: k.media.recover(entity), status: 202 };
  if (key === "media-adapters" && method === "GET")
    return { data: { adapters: k.media.adapters.list() } };
}
