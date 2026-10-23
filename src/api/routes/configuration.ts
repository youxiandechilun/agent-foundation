import { z } from "zod";
import { VERSION } from "../../version.js";
import {
  MCP_MODERN_VERSION,
  MCP_PROTOCOL_VERSIONS,
} from "../../extensions/mcp/client.js";
import { routeSchema } from "../../core/config.js";
import { invariant } from "../../core/util.js";
import { modeDefinitionSchema, modeIdSchema } from "../../modes/registry.js";
import { CAPABILITIES } from "../../runtime/types.js";
import { activeRunStatuses, type Session } from "../../contracts.js";
import { apiRoutes, input, status } from "../route-table.js";

export const configurationRoutes = apiRoutes({
  "GET costs": ({ k, url }) => ({
    budgets: k.config.budgets,
    ...k.costs.summary(
      {
        projectId: url.searchParams.get("projectId") || undefined,
        sessionId: url.searchParams.get("sessionId") || undefined,
        runId: url.searchParams.get("runId") || undefined,
      },
      {
        limit: Number(url.searchParams.get("limit") || 1000),
        offset: Number(url.searchParams.get("offset") || 0),
      },
    ),
  }),
  "POST costs/:id/reconcile": input(
    z
      .object({
        actualUsd: z.number().nonnegative().max(1e9),
        reference: z.string().min(3).max(2000),
      })
      .strict(),
    ({ k, id }, value) =>
      k.costs.reconcile(id, value.actualUsd, value.reference),
  ),
  "POST execution/probe": ({ k }) =>
    k.commands.probe(k.config.workspaceRoots[0]),
  "GET capabilities": ({ k }) => ({
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
    textProtocols: k.textProtocols.ids(),
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

    securityAudit: {
      mode: k.config.securityAudit.mode,
      stages: ["input", "tool"],
      records: "session-security-audits",
    },
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
      mcpOAuthConfigured: k.mcp.list().some((server) => Boolean(server.oauth)),
      sourcePluginIsolation: [
        "native",
        "docker-optional",
        "windows-appcontainer-optional",
      ],
      portableSessionAssets: "foundation-migration-v1",
    },
  }),
  "GET routes": ({ k }) => ({
    routes: Object.entries(k.config.routes).map(([id, route]) => ({
      id,
      kind: route.kind,
      adapter: route.adapter,
      model: route.model,
      baseUrl: route.baseUrl,
      pricing: route.pricing,
      enabled: route.enabled,
      acceptsImages: route.acceptsImages,
      nativeWebSearch: route.nativeWebSearch,
      reasoning: route.reasoning,
      reasoningEffort: route.reasoningEffort,
      supportedReasoningEfforts: route.supportedReasoningEfforts,
      apiKeyEnv: route.apiKeyEnv,
    })),
  }),
  "PUT routes/:id": input(routeSchema, async ({ k, id }, route) => {
    await k.updateRoutes({ set: { [id]: route } });
    return { id, route };
  }),
  "PATCH routes": input(
    z
      .object({
        set: z.record(z.string(), routeSchema).optional(),
        remove: z.array(z.string()).optional(),
        defaultRoutes: z
          .record(z.string(), z.string().min(1).nullable())
          .optional(),
      })
      .strict(),
    ({ k }, value) => k.updateRoutes(value),
  ),
  "DELETE routes/:id": ({ k, id }) => k.updateRoutes({ remove: [id] }),
  "GET modes": ({ k }) => ({ modes: k.modes.list() }),
  "POST modes": status(201, async ({ k, json }) => {
    invariant(
      !k.store.count("runs", {
        status: activeRunStatuses,
      }),
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
    return definition;
  }),
  "DELETE modes/:id": ({ k, id }) => {
    invariant(
      !k.store.list<Session>("sessions", { mode: id }).some((s) => !s.archived),
      "Mode is used by a session",
      409,
    );
    k.modes.remove(id);
    k.store.remove("mode-profiles", id);
    return { deleted: true };
  },
  "GET policies": ({ k }) => ({ rules: k.store.list("policies") }),
  "POST policies": status(
    201,
    input(
      z
        .object({
          id: z.string().min(1),
          effect: z.enum(["allow", "ask", "deny"]),
          capabilities: z.array(z.enum(CAPABILITIES)),
          tools: z.array(z.string()).optional(),
          projectId: z.string().optional(),
          routeId: z.string().optional(),
          mode: modeIdSchema.optional(),
          pluginId: z.string().optional(),
          expiresAt: z.string().datetime().optional(),
        })
        .strict(),
      ({ k }, rule) => k.store.put("policies", rule),
    ),
  ),
  "DELETE policies/:id": ({ k, id }) => {
    k.store.remove("policies", id);
    return { deleted: true };
  },
  "GET agents": ({ k }) => ({ agents: k.agents.list() }),
  "POST agents": status(201, async ({ k, json }) => k.agents.put(await json())),
  "GET agents/:id": ({ k, id }) => k.agents.get(id),
  "DELETE agents/:id": ({ k, id }) => {
    k.agents.remove(id);
    return { deleted: true };
  },
  "POST agents/:id/start": status(202, async ({ k, id, json }) => {
    const value = await json(),
      definition = k.agents.get(id);
    const session = k.createSession(
      value.projectId,
      definition.mode,
      value.name || definition.name,
      definition.routeId,
      definition.id,
    );
    return {
      session,
      ...(await k.submit(session.id, {
        text: value.text,
        assetIds: value.assetIds,
        skillIds: value.skillIds,
      })),
    };
  }),
});
