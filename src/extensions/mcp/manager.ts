import {
  MCPClient,
  MCP_MODERN_VERSION,
  type MCPClientOptions,
  type MCPNotificationFilter,
  type MCPRequestOptions,
} from "./client.js";
import {
  MCPInteractions,
  validateElicitation,
  type MCPOrigin,
} from "./interactions.js";
import { MCPOAuth, oauthSchema } from "./auth/oauth.js";
import { decodeSamplingRequest } from "./sampling.js";
import { collectCatalog } from "./catalog.js";
import { wireMember, wireObject, type WireObject } from "./protocol.js";
import { taskStatuses, validateTask } from "./tasks/context.js";
import type { MCPReceivedTask } from "./tasks/receiver.js";

/** Persisted record of a remote MCP task this host started or observed. */
interface MCPTaskRecord extends WireObject {
  id: string;
  serverId: string;
  remoteId: string;
  status?: unknown;
  protocol?: unknown;
  serverBinding?: unknown;
}
/** Persisted client-side task the host ran for a server. */
type MCPClientTaskRecord = MCPReceivedTask & {
  serverId?: string;
  serverBinding?: string;
};
import {
  clientMetadataDocument,
  clientMetadataURL,
} from "./auth/client-metadata.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  prepareExtensionHost,
  reviewedWorkspace,
} from "../../execution/extension-host.js";
import { z } from "zod";
import { Store } from "../../storage/store.js";
import type { Config } from "../../core/config.js";
import type { ToolDefinition, ToolResult } from "../../runtime/types.js";
import {
  invariant,
  errorText,
  hash,
  now,
  registerSecret,
  delay,
  id,
  within,
  abortable,
} from "../../core/util.js";

const declaration = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    name: z.string().max(100),
    transport: z.enum(["stdio", "http"]),
    protocol: z.enum(["legacy", "modern", "auto"]).default("auto"),
    oauth: oauthSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    envRefs: z.record(z.string(), z.string()).default({}),
    isolation: z
      .object({
        boundary: z.enum(["native", "docker", "windows-appcontainer"]),
        workspaceRoot: z.string().optional(),
        readOnly: z.boolean().default(true),
        network: z.boolean().default(false),
      })
      .strict()
      .optional(),
    headerEnvRefs: z.record(z.string(), z.string()).default({}),
    clientFeatures: z
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
          .max(100)
          .optional(),
        elicitation: z.boolean().default(false),
        taskExtension: z.boolean().default(false),
        tasks: z
          .object({
            sampling: z.boolean().default(false),
            elicitation: z.boolean().default(false),
            maxTasks: z.number().int().min(1).max(128).default(32),
            maxTtlMs: z.number().int().min(100).max(3600000).default(300000),
            pollIntervalMs: z.number().int().min(10).max(60000).default(100),
            pageSize: z.number().int().min(1).max(100).default(20),
          })
          .strict()
          .optional(),
        sampling: z
          .object({
            routeId: z.string().min(1),
            maxTokens: z.number().int().min(1).max(32768).default(1024),
            maxRequestsPerCall: z.number().int().min(1).max(32).default(4),
            tools: z.boolean().default(false),
            maxTools: z.number().int().min(1).max(64).default(32),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().default(false),
    toolAllowlist: z.array(z.string()).default(["*"]),
    timeoutMs: z.number().int().min(100).max(300000).default(30000),
    maxMessageBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024),
  })
  .strict();
export type MCPDeclaration = z.infer<typeof declaration> & {
  status?: string;
  error?: string;
};
export class MCPManager {
  readonly interactions: MCPInteractions;
  private oauthDriver?: MCPOAuth;
  get oauth(): MCPOAuth | undefined {
    if (
      !this.oauthDriver &&
      this.config &&
      this.store.list<MCPDeclaration>("mcps").some((server) => server.oauth)
    )
      this.oauthDriver = new MCPOAuth(this.config);
    return this.oauthDriver;
  }
  private host?: {
    authorize: (
      serverId: string,
      origin: MCPOrigin,
      kind: "elicitation" | "sampling",
      routeId?: string,
    ) => void;
    sample: (
      serverId: string,
      origin: MCPOrigin,
      routeId: string,
      params: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>;
  };
  private subscriptions = new Map<
    string,
    {
      serverId: string;
      filter: MCPNotificationFilter;
      handle: ReturnType<MCPClient["listenNotifications"]>;
    }
  >();
  private clients = new Map<string, MCPClient>();
  private opening = new Map<string, MCPClient>();
  private closing = false;
  private removing = new Set<string>();
  private disconnecting = new Set<string>();
  private catalogVersions = new Map<string, number>();
  private connecting = new Map<string, Promise<void>>();
  private catalogs = new Map<
    string,
    {
      connection: MCPClient;
      version: number | undefined;
      controller: AbortController;
      callers: number;
      promise: ReturnType<MCPClient["toolCatalog"]>;
    }
  >();
  constructor(
    readonly store: Store,
    readonly config?: Config,
  ) {
    this.interactions = new MCPInteractions(store);
    for (const task of store.list<MCPClientTaskRecord>("mcp-client-tasks"))
      if (["working", "input_required"].includes(task.status))
        store.put("mcp-client-tasks", {
          ...task,
          status: "failed",
          statusMessage: "Host restarted; client task execution interrupted",
          error: {
            code: -32603,
            message: "Host restarted; client task execution interrupted",
          },
          lastUpdatedAt: now(),
        });
    for (const task of store.list<MCPTaskRecord>("mcp-tasks"))
      if (task.status === "working" || task.status === "input_required")
        store.put("mcp-tasks", {
          ...task,
          status: "unknown",
          error:
            "Host restarted; inspect the persisted remote task before resubmission",
          updatedAt: now(),
        });
  }
  private oauthTarget(serverId: string) {
    invariant(
      !this.closing && !this.removing.has(serverId),
      "MCP OAuth host is closing or the server is being removed",
      409,
    );
    const d = this.store.get<MCPDeclaration>("mcps", serverId);
    invariant(
      this.oauth && d.transport === "http" && d.url && d.oauth,
      "MCP OAuth is not configured",
      400,
    );
    return { id: d.id, url: d.url, oauth: d.oauth };
  }
  authStatus(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.status(target);
  }
  authBegin(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.begin(target);
  }
  authComplete(serverId: string, url: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.complete(target, url);
  }
  registrationStatus(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.registrationStatus(target);
  }
  async publicMetadata(pathname: string, published = true) {
    for (const server of this.store.list<MCPDeclaration>("mcps")) {
      const metadata = server.oauth?.clientMetadata;
      if (
        metadata?.publish &&
        clientMetadataURL(metadata.clientId).pathname === pathname
      )
        return this.oauth!.publicMetadata(
          metadata,
          server.oauth!.redirectUri,
          published,
        );
    }
  }
  registerClient(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.register(target);
  }
  deviceBegin(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.deviceBegin(target);
  }
  deviceStatus(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.deviceStatus(target);
  }
  devicePoll(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.devicePoll(target);
  }
  deviceCancel(serverId: string) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.deviceCancel(target);
  }
  keyStatus(serverId: string, stage = false) {
    const target = this.oauthTarget(serverId);
    return this.oauth!.keyStatus(target, stage);
  }
  async remoteRegistration(
    serverId: string,
    method: "GET" | "PUT" | "DELETE",
    changes?: Record<string, unknown>,
    acknowledgeUnknown = false,
  ) {
    const target = this.oauthTarget(serverId);
    await this.disconnect(serverId);
    return this.oauth!.remoteRegistration(
      target,
      method,
      changes,
      acknowledgeUnknown,
    );
  }
  async resetRegistration(serverId: string, acknowledgeUnknown = false) {
    const target = this.oauthTarget(serverId);
    await this.disconnect(serverId);
    return this.oauth!.resetRegistration(target, acknowledgeUnknown);
  }
  async authClear(serverId: string) {
    this.oauthTarget(serverId);
    await this.disconnect(serverId);
    await this.oauth!.clear(serverId);
    return { authorized: false };
  }
  setHost(host: NonNullable<MCPManager["host"]>) {
    this.host = host;
  }
  private serverBinding(d: MCPDeclaration) {
    return hash(
      JSON.stringify({
        transport: d.transport,
        url: d.url,
        command: d.command,
        args: d.args,
        envRefs: d.envRefs,
        headerEnvRefs: d.headerEnvRefs,
        oauth: d.oauth,
      }),
    );
  }
  receivedTasks(serverId: string) {
    this.store.get("mcps", serverId);
    return this.store
      .list<MCPClientTaskRecord>("mcp-client-tasks")
      .filter((t) => t.serverId === serverId);
  }
  private taskOptions(
    d: MCPDeclaration,
  ): Pick<MCPClientOptions, "receiverTasks" | "taskExtension" | "onTask"> {
    const localIds = new Map<string, string>(),
      serverBinding = this.serverBinding(d);
    return {
      ...(d.clientFeatures?.tasks
        ? {
            receiverTasks: {
              ...d.clientFeatures.tasks,
              persist: (task) =>
                this.store.put("mcp-client-tasks", {
                  ...task,
                  serverId: d.id,
                  serverBinding,
                }),
            },
          }
        : {}),
      taskExtension: d.clientFeatures?.taskExtension === true,
      onTask: (event) => {
        const key =
          event.kind === "created"
            ? id("mcp-task")
            : localIds.get(event.task.taskId);
        if (!key) return;
        if (event.kind === "created") localIds.set(event.task.taskId, key);
        const previous = this.store.find<MCPTaskRecord>("mcp-tasks", key);
        this.store.put("mcp-tasks", {
          ...previous,
          id: key,
          serverId: d.id,
          serverBinding,
          protocol: "modern",
          remoteId: event.task.taskId,
          status:
            event.kind === "unknown"
              ? "unknown"
              : event.kind === "created" &&
                  ["completed", "failed", "cancelled"].includes(
                    event.task.status,
                  )
                ? "working"
                : event.task.status,
          remoteStatus: event.task.status,
          origin: event.context.localContext,
          toolName: event.context.params.name,
          task: event.task,
          createdAt: previous?.createdAt || now(),
          updatedAt: now(),
          ...(event.error ? { error: event.error } : { error: undefined }),
        });
      },
    };
  }
  private handlers(d: MCPDeclaration): MCPClientOptions["handlers"] {
    const handlers: NonNullable<MCPClientOptions["handlers"]> = {};
    if (d.clientFeatures?.roots)
      handlers["roots/list"] = async () => {
        invariant(this.config, "Roots require host path configuration", 403);
        const current = this.store.get<MCPDeclaration>("mcps", d.id),
          roots = [];
        for (const root of current.clientFeatures?.roots || []) {
          invariant(
            new URL(root.uri).protocol === "file:",
            "MCP roots must use file URIs",
          );
          const actual = await reviewedWorkspace(
            this.config,
            fileURLToPath(root.uri),
          );
          let uri = pathToFileURL(actual).href;
          const boundary =
            current.isolation?.boundary ||
            this.config.extensions.executionBoundary;
          if (boundary !== "native" && current.transport === "stdio") {
            invariant(
              current.isolation?.workspaceRoot,
              "Isolated roots require an explicit workspace mount",
              403,
            );
            const mounted = await reviewedWorkspace(
              this.config,
              current.isolation.workspaceRoot,
            );
            invariant(
              within(mounted, actual),
              "Root is outside isolated MCP workspace",
              403,
            );
            const relative = path
              .relative(mounted, actual)
              .replaceAll("\\", "/");
            if (boundary === "docker")
              uri =
                "file:///workspace" +
                (relative
                  ? "/" + relative.split("/").map(encodeURIComponent).join("/")
                  : "");
          }
          roots.push({ uri, ...(root.name ? { name: root.name } : {}) });
        }
        return { roots };
      };
    if (d.clientFeatures?.elicitation)
      handlers["elicitation/create"] = async (params, context) => {
        this.client(d.id);
        validateElicitation(params);
        const origin = context.localContext as MCPOrigin | undefined;
        if (origin) {
          invariant(this.host, "MCP input host missing", 503);
          this.host.authorize(d.id, origin, "elicitation");
        }
        context.setTaskStatus?.("input_required");
        const reply = await this.interactions.ask(
          d.id,
          "elicitation",
          params,
          context.signal,
          origin,
        );
        context.setTaskStatus?.("working");
        this.client(d.id);
        if (origin) this.host!.authorize(d.id, origin, "elicitation");
        return reply;
      };
    if (d.clientFeatures?.sampling)
      handlers["sampling/createMessage"] = async (params, context) => {
        this.client(d.id);
        const origin = context.localContext as MCPOrigin | undefined,
          limits = d.clientFeatures!.sampling!;
        invariant(
          origin && this.host,
          "Sampling requires an authorized originating Agent tool call",
          403,
        );
        const maxTokens = wireMember(params, "maxTokens");
        invariant(
          typeof maxTokens === "number" &&
            Number.isSafeInteger(maxTokens) &&
            maxTokens > 0 &&
            maxTokens <= limits.maxTokens,
          "Sampling token limit exceeded",
          403,
        );
        decodeSamplingRequest(params, limits);
        invariant(
          (origin.samplingRemaining || 0) > 0,
          "Sampling request limit exceeded",
          429,
        );
        origin.samplingRemaining!--;
        this.host.authorize(d.id, origin, "sampling", limits.routeId);
        context.setTaskStatus?.("input_required");
        const consent = await this.interactions.ask(
          d.id,
          "sampling",
          params,
          context.signal,
          origin,
        );
        context.setTaskStatus?.("working");
        invariant(consent.action === "accept", "Sampling declined", 403);
        this.client(d.id);
        this.host.authorize(d.id, origin, "sampling", limits.routeId);
        return await this.host.sample(
          d.id,
          origin,
          limits.routeId,
          params,
          context.signal,
        );
      };
    return handlers;
  }
  install(input: unknown) {
    invariant(!this.closing, "MCP host is closing", 409);
    const d = declaration.parse(input);
    invariant(!this.removing.has(d.id), "MCP server is being removed", 409);
    const prior = this.store.find<MCPDeclaration>("mcps", d.id)?.oauth
      ?.clientMetadata;
    const next = d.oauth?.clientMetadata;
    if (prior && next && prior.clientId === next.clientId) {
      const oldManaged =
        prior.authentication.method === "private_key_jwt" &&
        !!prior.authentication.managed;
      const newManaged =
        next.authentication.method === "private_key_jwt" &&
        !!next.authentication.managed;
      invariant(
        !(oldManaged || newManaged) ||
          (oldManaged &&
            newManaged &&
            prior.authentication.method === "private_key_jwt" &&
            next.authentication.method === "private_key_jwt" &&
            prior.authentication.alg === next.authentication.alg),
        "Changing managed key source or algorithm requires a new client metadata identity",
        409,
      );
    }
    invariant(
      !this.clients.has(d.id) && !this.connecting.has(d.id),
      "Disconnect MCP before replacing its declaration",
      409,
    );
    invariant(
      d.transport === "stdio" ? d.command : d.url,
      "Transport needs command or URL",
    );
    invariant(
      !d.clientFeatures?.tasks?.sampling || d.clientFeatures.sampling,
      "Client sampling tasks require sampling to be enabled",
    );
    invariant(
      !d.clientFeatures?.tasks?.elicitation || d.clientFeatures.elicitation,
      "Client elicitation tasks require elicitation to be enabled",
    );
    if (d.oauth?.clientMetadata) {
      const metadata = d.oauth.clientMetadata,
        document = clientMetadataDocument(
          metadata,
          d.oauth.redirectUri,
          metadata.authentication.method === "private_key_jwt" &&
            metadata.authentication.managed
            ? []
            : undefined,
        ),
        metadataPath = clientMetadataURL(metadata.clientId).pathname;
      invariant(
        !metadata.publish ||
          (!metadataPath.startsWith("/v1/") &&
            metadataPath !== "/v1" &&
            metadataPath !== "/health"),
        "Client metadata publication path conflicts with a reserved API path",
      );
      for (const existing of this.store.list<MCPDeclaration>("mcps"))
        if (
          existing.id !== d.id &&
          metadata.publish &&
          existing.oauth?.clientMetadata?.publish &&
          clientMetadataURL(existing.oauth.clientMetadata.clientId).pathname ===
            metadataPath
        )
          invariant(
            JSON.stringify(
              clientMetadataDocument(
                existing.oauth.clientMetadata,
                existing.oauth.redirectUri,
                existing.oauth.clientMetadata.authentication.method ===
                  "private_key_jwt" &&
                  existing.oauth.clientMetadata.authentication.managed
                  ? []
                  : undefined,
              ),
            ) === JSON.stringify(document) &&
              JSON.stringify(existing.oauth.clientMetadata.authentication) ===
                JSON.stringify(metadata.authentication),
            "Conflicting public client metadata document path",
            409,
          );
    }
    if (d.url)
      invariant(
        ["http:", "https:"].includes(new URL(d.url).protocol),
        "MCP requires HTTP(S)",
      );
    for (const root of d.clientFeatures?.roots || [])
      invariant(
        new URL(root.uri).protocol === "file:",
        "MCP roots must be file URIs",
      );
    invariant(
      !d.oauth ||
        (d.transport === "http" &&
          !Object.keys(d.headerEnvRefs).some(
            (key) => key.toLowerCase() === "authorization",
          )),
      "OAuth needs HTTP and cannot be combined with a manual Authorization header",
    );
    this.oauth?.invalidate(d.id);
    const installed = this.store.put("mcps", { ...d, status: "disconnected" });
    this.syncKeyConfigurations();
    return installed;
  }
  private syncKeyConfigurations() {
    this.oauth?.keys.setConfigurations(
      this.store.list<MCPDeclaration>("mcps").flatMap((d) => {
        const metadata = d.oauth?.clientMetadata;
        return metadata?.authentication.method === "private_key_jwt" &&
          metadata.authentication.managed
          ? [metadata]
          : [];
      }),
    );
  }
  list() {
    return this.store.list<MCPDeclaration>("mcps").map((d) => this.describe(d));
  }
  get(serverId: string) {
    return this.describe(this.store.get<MCPDeclaration>("mcps", serverId));
  }
  private describe(d: MCPDeclaration) {
    return {
      ...d,
      connected: this.clients.get(d.id)?.connected || false,
      protocolVersion: this.clients.get(d.id)?.protocolVersion,
      serverCapabilities: this.clients.get(d.id)?.capabilities,
      executionBoundary:
        d.transport === "http"
          ? "external-service"
          : d.isolation?.boundary ||
            this.config?.extensions.executionBoundary ||
            "native",
      isolationEnforcement:
        d.transport === "http"
          ? "external-service-policy"
          : (d.isolation?.boundary ||
                this.config?.extensions.executionBoundary) === "docker"
            ? "container-configured"
            : (d.isolation?.boundary ||
                  this.config?.extensions.executionBoundary) ===
                "windows-appcontainer"
              ? "appcontainer-configured"
              : "none-native-trusted",
    };
  }
  async connect(serverId: string) {
    invariant(!this.closing, "MCP manager is closing", 503);
    invariant(
      !this.disconnecting.has(serverId),
      "MCP server is disconnecting",
      409,
    );
    const existing = this.connecting.get(serverId);
    if (existing) return existing;
    const pending = this.connectUnlocked(serverId);
    this.connecting.set(serverId, pending);
    try {
      await pending;
    } finally {
      this.connecting.delete(serverId);
    }
  }
  private async connectUnlocked(serverId: string) {
    const d = this.store.get<MCPDeclaration>("mcps", serverId);
    invariant(
      !this.config?.execution.requireIsolation ||
        d.transport !== "stdio" ||
        (d.isolation?.boundary || this.config.extensions.executionBoundary) !==
          "native",
      "MCP stdio requires a selected isolated host under the current policy",
      403,
      "isolation_required",
    );
    if (this.clients.get(serverId)?.connected) return;
    await this.clients.get(serverId)?.close();
    this.clients.delete(serverId);
    invariant(!this.closing, "MCP manager is closing", 503);
    invariant(
      !this.disconnecting.has(serverId),
      "MCP server disconnected during initialization",
      409,
    );
    let client: MCPClient | undefined;
    try {
      if (d.transport === "stdio") {
        const env: Record<string, string> = {};
        for (const key of [
          "PATH",
          "Path",
          "PATHEXT",
          "SystemRoot",
          "WINDIR",
          "TEMP",
          "TMP",
          "HOME",
          "USERPROFILE",
        ])
          if (process.env[key]) env[key] = process.env[key]!;
        for (const [name, ref] of Object.entries(d.envRefs)) {
          invariant(
            process.env[ref],
            `Missing environment variable ${ref}`,
            503,
          );
          env[name] = process.env[ref]!;
          if (/key|token|secret|password|auth|credential/i.test(name))
            registerSecret(env[name]);
        }
        let command = d.command!,
          args = d.args,
          cwd: string | undefined,
          ownerMonitored = false,
          cleanup: (() => Promise<void>) | undefined;
        let childEnv = env;
        const boundary =
          d.isolation?.boundary ||
          this.config?.extensions.executionBoundary ||
          "native";
        if (d.isolation?.workspaceRoot) {
          invariant(
            this.config,
            "Host config required to authorize MCP workspace",
            403,
          );
          cwd = await reviewedWorkspace(this.config, d.isolation.workspaceRoot);
        }
        if (boundary !== "native") {
          invariant(
            this.config,
            "MCP execution isolation needs host configuration",
            503,
          );
          if (!cwd) {
            cwd = path.join(this.config.dataDir, "mcp-workspaces", d.id);
            await mkdir(cwd, { recursive: true });
          }
          const host = await prepareExtensionHost(
            this.config,
            {
              command,
              args,
              cwd,
              mounts: [
                {
                  source: cwd,
                  target: "/workspace",
                  readOnly:
                    this.config.execution.workspaceReadOnly ||
                    d.isolation?.readOnly !== false,
                },
              ],
              workdir: "/workspace",
              env: Object.fromEntries(
                Object.keys(d.envRefs).map((name) => [name, env[name]]),
              ),
              network: d.isolation?.network === true,
            },
            boundary,
          );
          command = host.command;
          args = host.args;
          cwd = host.cwd;
          childEnv = host.env as Record<string, string>;
          cleanup = host.cleanup;
          ownerMonitored = host.ownerMonitored === true;
        }
        client = new MCPClient({
          ...this.taskOptions(d),
          protocol: d.protocol,
          samplingTools: d.clientFeatures?.sampling?.tools === true,
          handlers: this.handlers(d),
          transport: "stdio",
          command,
          args,
          env: childEnv,
          cwd,
          cleanup,
          ownerMonitored,
          timeoutMs: d.timeoutMs,
          maxMessageBytes: d.maxMessageBytes,
        });
      } else {
        const headers: Record<string, string> = {};
        for (const [name, ref] of Object.entries(d.headerEnvRefs)) {
          invariant(
            process.env[ref],
            `Missing environment variable ${ref}`,
            503,
          );
          headers[name] = process.env[ref]!;
          if (/authorization|cookie|key|token|secret/i.test(name))
            registerSecret(headers[name]);
        }
        client = new MCPClient({
          ...this.taskOptions(d),
          protocol: d.protocol,
          samplingTools: d.clientFeatures?.sampling?.tools === true,
          handlers: this.handlers(d),
          transport: "http",
          ...(d.oauth
            ? {
                authorization: () =>
                  this.oauth!.authorization(this.oauthTarget(d.id)),
                onAuthChallenge: (header: string) =>
                  this.oauth!.noteChallenge(this.oauthTarget(d.id), header),
              }
            : {}),
          url: d.url!,
          headers,
          timeoutMs: d.timeoutMs,
          maxMessageBytes: d.maxMessageBytes,
        });
      }
      this.opening.set(serverId, client);
      await client.connect();
      invariant(!this.closing, "MCP manager is closing", 503);
      invariant(
        !this.disconnecting.has(serverId),
        "MCP server disconnected during initialization",
        409,
      );
      this.clients.set(serverId, client);
      this.catalogVersions.set(
        serverId,
        (this.catalogVersions.get(serverId) || 0) + 1,
      );
      client.onnotification = (method) => {
        if (method === "notifications/tools/list_changed")
          this.catalogVersions.set(
            serverId,
            (this.catalogVersions.get(serverId) || 0) + 1,
          );
      };
      this.store.put("mcps", {
        ...d,
        enabled: true,
        status: "connected",
        error: undefined,
      });
      client.onclose = (cleanupError) => {
        if (this.clients.get(serverId) !== client) return;
        this.clients.delete(serverId);
        const current = this.store.find<MCPDeclaration>("mcps", serverId);
        if (current)
          this.store.put("mcps", {
            ...current,
            status: cleanupError ? "error" : "disconnected",
            ...(cleanupError ? { error: errorText(cleanupError) } : {}),
          });
      };
      if (
        client.protocolVersion === MCP_MODERN_VERSION &&
        (client.capabilities.tools?.listChanged ||
          client.capabilities.resources?.listChanged ||
          client.capabilities.prompts?.listChanged)
      )
        await this.subscribe(serverId, {
          ...(client.capabilities.tools?.listChanged
            ? { toolsListChanged: true }
            : {}),
          ...(client.capabilities.resources?.listChanged
            ? { resourcesListChanged: true }
            : {}),
          ...(client.capabilities.prompts?.listChanged
            ? { promptsListChanged: true }
            : {}),
        });
    } catch (error) {
      await client?.close().catch(() => undefined);
      this.store.put("mcps", {
        ...d,
        status: "error",
        error: errorText(error),
      });
      throw error;
    } finally {
      this.opening.delete(serverId);
    }
  }
  async disconnect(serverId: string) {
    this.disconnecting.add(serverId);
    this.catalogVersions.set(
      serverId,
      (this.catalogVersions.get(serverId) || 0) + 1,
    );
    try {
      const closed = await Promise.allSettled([
        this.clients.get(serverId)?.close(),
        this.opening.get(serverId)?.close(),
      ]);
      await this.connecting.get(serverId)?.catch(() => undefined);
      this.clients.delete(serverId);
      const d = this.store.get<MCPDeclaration>("mcps", serverId);
      const failures = closed.filter((result) => result.status === "rejected");
      if (failures.length) {
        const error = failures
          .map((result) => errorText(result.reason))
          .join("; ");
        this.store.put("mcps", {
          ...d,
          enabled: false,
          status: "error",
          error,
        });
        throw new Error(error);
      }
      return this.store.put("mcps", {
        ...d,
        enabled: false,
        status: "disconnected",
      });
    } finally {
      this.disconnecting.delete(serverId);
    }
  }
  async remove(serverId: string) {
    invariant(
      !this.removing.has(serverId),
      "MCP server is already being removed",
      409,
    );
    this.oauth?.invalidate(serverId);
    this.removing.add(serverId);
    try {
      await this.disconnect(serverId);
      await this.oauth?.clear(serverId);
      this.store.remove("mcps", serverId);
      this.syncKeyConfigurations();
    } finally {
      this.removing.delete(serverId);
    }
  }
  private client(serverId: string) {
    const client = this.clients.get(serverId);
    invariant(
      client?.connected && !this.disconnecting.has(serverId),
      `MCP ${serverId} not connected`,
      503,
    );
    return client;
  }
  async catalog(serverId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const connection = this.client(serverId),
      version = this.catalogVersions.get(serverId);
    let pending = this.catalogs.get(serverId);
    if (
      !pending ||
      pending.connection !== connection ||
      pending.version !== version
    ) {
      // A superseded page must not overwrite schemas from the new catalog.
      pending?.controller.abort();
      const controller = new AbortController();
      pending = {
        connection,
        version,
        controller,
        callers: 0,
        promise: connection.toolCatalog({
          signal: controller.signal,
          validate: () =>
            invariant(
              this.client(serverId) === connection &&
                this.catalogVersions.get(serverId) === version,
              "MCP catalog changed during listing; resolve again",
              409,
            ),
        }),
      };
      this.catalogs.set(serverId, pending);
      const current = pending;
      void current.promise
        .finally(() => {
          if (this.catalogs.get(serverId) === current)
            this.catalogs.delete(serverId);
        })
        .catch(() => undefined);
    }
    pending.callers++;
    try {
      const result = await (signal
        ? abortable(pending.promise, signal)
        : pending.promise);
      invariant(
        this.client(serverId) === connection &&
          this.catalogVersions.get(serverId) === version,
        "MCP catalog changed during listing; resolve again",
        409,
      );
      return structuredClone(result.tools);
    } finally {
      if (--pending.callers === 0) {
        if (this.catalogs.get(serverId) === pending)
          this.catalogs.delete(serverId);
        pending.controller.abort();
      }
    }
  }
  async tools(
    signal?: AbortSignal,
    origin?: Omit<MCPOrigin, "toolName">,
  ): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    const servers = this.list().filter((d) => d.enabled && d.connected);
    // Independent servers may fetch catalogs concurrently; bound fan-out and retain declaration order.
    for (let offset = 0; offset < servers.length; offset += 4) {
      const batch = servers.slice(offset, offset + 4);
      const definitions = await Promise.all(
        batch.map(async (d) => {
          const serverTools: ToolDefinition[] = [];
          for (const item of await this.catalog(d.id, signal)) {
            const connection = this.client(d.id),
              version = this.catalogVersions.get(d.id);
            if (
              !d.toolAllowlist.includes("*") &&
              !d.toolAllowlist.includes(item.name)
            )
              continue;
            const original = `mcp_${d.id}_${item.name}`;
            const prefix = original.replace(/[^a-zA-Z0-9_-]/g, "_");
            const name =
              prefix.length <= 64 && prefix === original
                ? prefix
                : `${prefix.slice(0, 50)}_${hash(d.id + "\0" + item.name).slice(0, 12)}`;
            serverTools.push({
              name,
              description: item.description || item.name,
              parameters: item.inputSchema,
              // Remote annotations are display hints, never a host permission grant.
              risk: "execute",
              capabilities: ["mcp"],
              source: { kind: "mcp", id: d.id },
              execute: async (_callId, args, signal, update, execution) => {
                const current = this.store.find<MCPDeclaration>("mcps", d.id);
                invariant(
                  current?.enabled &&
                    !this.disconnecting.has(d.id) &&
                    this.clients.get(d.id) === connection &&
                    connection.connected &&
                    this.catalogVersions.get(d.id) === version &&
                    (current.toolAllowlist.includes("*") ||
                      current.toolAllowlist.includes(item.name)),
                  "MCP tool revoked, disconnected, or catalog changed; resolve tools again",
                  403,
                );
                const options: MCPRequestOptions = {
                  signal,
                  timeout: d.timeoutMs,
                  localContext: origin
                    ? {
                        ...origin,
                        routeId: execution?.routeId || origin.routeId,
                        toolName: name,
                        samplingRemaining:
                          d.clientFeatures?.sampling?.maxRequestsPerCall || 0,
                      }
                    : undefined,
                  progress: (progress) =>
                    update?.({
                      content: [
                        { type: "text", text: JSON.stringify(progress) },
                      ],
                      details: { progress },
                    }),
                };
                const value =
                  connection.protocolVersion !== MCP_MODERN_VERSION &&
                  item.execution?.taskSupport === "required"
                    ? await this.callTask(
                        d.id,
                        connection,
                        { name: item.name, arguments: args },
                        options,
                      )
                    : await connection.callTool(
                        { name: item.name, arguments: args },
                        options,
                      );
                // Part fields pass through unchanged; normalizeToolResult validates
                // every part before it reaches context or storage.
                const content = value.content.map((item) => {
                  const p = wireObject(item) ?? {};
                  return p.type === "text"
                    ? { type: "text", text: p.text }
                    : p.type === "image"
                      ? { type: "image", data: p.data, mimeType: p.mimeType }
                      : { type: "text", text: JSON.stringify(item) };
                }) as ToolResult["content"];
                return {
                  content,
                  details: value.structuredContent,
                  isError: Boolean(value.isError),
                };
              },
            });
          }
          return serverTools;
        }),
      );
      tools.push(...definitions.flat());
    }
    return tools;
  }
  private async pages(
    serverId: string,
    method: "listResources" | "listPrompts" | "listResourceTemplates",
    field: "resources" | "prompts" | "resourceTemplates",
    signal?: AbortSignal,
  ) {
    const connection = this.client(serverId);
    const output = await collectCatalog(
      async (cursor) => {
        const result = await connection[method]({ cursor }, { signal });
        const items = result[field];
        invariant(Array.isArray(items), "Invalid MCP catalog", 502);
        return { items, nextCursor: result.nextCursor };
      },
      () =>
        invariant(
          this.client(serverId) === connection,
          "MCP catalog changed during listing; resolve again",
          409,
        ),
    );
    return { [field]: output };
  }
  async resources(serverId: string) {
    return this.pages(serverId, "listResources", "resources");
  }
  async roots(
    serverId: string,
    roots: NonNullable<NonNullable<MCPDeclaration["clientFeatures"]>["roots"]>,
  ) {
    const current = this.store.get<MCPDeclaration>("mcps", serverId);
    invariant(
      current.clientFeatures?.roots,
      "Enable roots and reconnect before updating them",
      409,
    );
    const { status: _, error: __, ...input } = current;
    const parsed = declaration.parse(input);
    parsed.clientFeatures!.roots = roots;
    const checked = declaration.parse(parsed);
    for (const root of checked.clientFeatures!.roots!) {
      invariant(
        this.config && new URL(root.uri).protocol === "file:",
        "Invalid MCP root",
      );
      await reviewedWorkspace(this.config, fileURLToPath(root.uri));
    }
    this.store.put("mcps", {
      ...current,
      clientFeatures: checked.clientFeatures,
    });
    await this.client(serverId).setRootsChanged();
    return checked.clientFeatures!.roots;
  }
  async subscribe(serverId: string, filter: MCPNotificationFilter) {
    const client = this.client(serverId);
    if (filter.taskIds)
      for (const remoteId of filter.taskIds)
        invariant(
          this.tasks(serverId).some(
            (t) =>
              t.remoteId === remoteId &&
              t.protocol === "modern" &&
              (!t.serverBinding ||
                t.serverBinding ===
                  this.serverBinding(
                    this.store.get<MCPDeclaration>("mcps", serverId),
                  )),
          ),
          "Task subscription must belong to this MCP server configuration",
          403,
        );
    if (client.protocolVersion !== MCP_MODERN_VERSION) {
      invariant(
        !filter.toolsListChanged &&
          !filter.promptsListChanged &&
          !filter.resourcesListChanged,
        "Legacy list-change notifications are connection scoped",
      );
      for (const uri of filter.resourceSubscriptions || [])
        await client.subscribeResource(uri);
      return { id: "legacy", notifications: filter };
    }
    const subscriptionId = id("mcp-subscription"),
      handle = client.listenNotifications(filter);
    this.subscriptions.set(subscriptionId, { serverId, filter, handle });
    void handle.completion
      .finally(() => this.subscriptions.delete(subscriptionId))
      .catch(() => undefined);
    try {
      return { id: subscriptionId, notifications: await handle.ready };
    } catch (error) {
      handle.close();
      throw error;
    }
  }
  async unsubscribe(serverId: string, subscriptionId: string, uri?: string) {
    if (subscriptionId === "legacy") {
      invariant(uri, "Resource URI required");
      return this.client(serverId).unsubscribeResource(uri);
    }
    const subscription = this.subscriptions.get(subscriptionId);
    invariant(
      subscription?.serverId === serverId,
      "Subscription does not belong to MCP server",
      404,
    );
    subscription.handle.close();
    await subscription.handle.completion.catch(() => undefined);
    return { closed: true };
  }
  private async callTask(
    serverId: string,
    connection: MCPClient,
    params: { name: string; arguments: unknown },
    options: MCPRequestOptions,
  ) {
    const output = connection.toolOutputValidator(params.name);
    const deadline = Date.now() + (options.timeout || 30000);
    const remaining = () => {
      invariant(Date.now() < deadline, "MCP task polling timed out", 504);
      return Math.max(1, deadline - Date.now());
    };
    const created = await connection.createToolTask(params, {
      ...options,
      taskDeadline: deadline,
    });
    let record: MCPTaskRecord = {
      id: id("mcp-task"),
      serverId,
      remoteId: created.taskId,
      serverBinding: this.serverBinding(
        this.store.get<MCPDeclaration>("mcps", serverId),
      ),
      status: created.status,
      origin: options.localContext,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.put("mcp-tasks", record);
    try {
      while (true) {
        invariant(
          this.client(serverId) === connection,
          "MCP task connection changed",
          409,
        );
        // Same checks as before: matching ID and a known status.
        const task = validateTask(
          await connection.taskGet(created.taskId, options.signal, remaining()),
          created.taskId,
        );
        record = { ...record, status: task.status, updatedAt: now() };
        this.store.put("mcp-tasks", record);
        if (
          ["input_required", "completed", "failed", "cancelled"].includes(
            task.status,
          )
        ) {
          const result = connection.validateToolResult(
            params.name,
            await connection.taskResult(
              created.taskId,
              options.signal,
              remaining(),
            ),
            output,
          );
          if (task.status === "input_required") {
            const final = validateTask(
              await connection.taskGet(
                created.taskId,
                options.signal,
                remaining(),
              ),
              created.taskId,
            );
            invariant(
              ["completed", "failed", "cancelled"].includes(final.status),
              "MCP task returned result before reaching a terminal state",
              502,
            );
            record = { ...record, status: final.status, updatedAt: now() };
            this.store.put("mcp-tasks", record);
          }
          return result;
        }
        invariant(Date.now() < deadline, "MCP task polling timed out", 504);
        await delay(
          Math.min(
            Math.max(
              25,
              typeof task.pollInterval === "number" && task.pollInterval
                ? task.pollInterval
                : 100,
            ),
            1000,
            Math.max(1, deadline - Date.now()),
          ),
          options.signal,
        );
      }
    } catch (error) {
      connection.releaseTaskContext(created.taskId);
      if (options.signal?.aborted)
        await connection
          .taskCancel(created.taskId, undefined, 1500)
          .catch(() => undefined);
      this.store.put("mcp-tasks", {
        ...record,
        status: "unknown",
        error: errorText(error),
        updatedAt: now(),
      });
      throw error;
    } finally {
      connection.releaseTaskContext(created.taskId);
    }
  }
  tasks(serverId: string) {
    this.store.get("mcps", serverId);
    return this.store
      .list<MCPTaskRecord>("mcp-tasks")
      .filter((t) => t.serverId === serverId);
  }
  async task(
    serverId: string,
    key: string,
    action: "get" | "result" | "cancel",
  ) {
    const record = this.store.get<MCPTaskRecord>("mcp-tasks", key);
    invariant(record.serverId === serverId, "MCP task server mismatch", 403);
    invariant(
      !record.serverBinding ||
        record.serverBinding ===
          this.serverBinding(this.store.get<MCPDeclaration>("mcps", serverId)),
      "MCP task belongs to a different server configuration",
      403,
    );
    const client = this.client(serverId);
    invariant(
      (record.protocol === "modern") ===
        (client.protocolVersion === MCP_MODERN_VERSION),
      "Reconnect with the original task protocol",
      409,
    );
    const result = await (action === "get"
      ? client.taskGet(record.remoteId)
      : action === "result"
        ? client.taskResult(record.remoteId)
        : client.taskCancel(record.remoteId));
    if (record.protocol === "modern") {
      invariant(
        client.protocolVersion === MCP_MODERN_VERSION,
        "Reconnect with the original task protocol",
        409,
      );
      if (action === "cancel")
        this.store.put("mcp-tasks", {
          ...record,
          status: "unknown",
          cancelRequested: true,
          updatedAt: now(),
        });
      else if (action === "get")
        this.store.put("mcp-tasks", {
          ...record,
          status: result.status,
          remoteStatus: result.status,
          task: result,
          updatedAt: now(),
        });
    } else if (action !== "result") {
      invariant(
        result.taskId === record.remoteId &&
          (taskStatuses as readonly unknown[]).includes(result.status),
        "Invalid remote task inspection",
        502,
      );
      this.store.put("mcp-tasks", {
        ...record,
        status: result.status,
        updatedAt: now(),
      });
    }
    return result;
  }
  async readResource(serverId: string, uri: string, signal?: AbortSignal) {
    return this.client(serverId).readResource({ uri }, { signal });
  }
  async prompts(serverId: string) {
    return this.pages(serverId, "listPrompts", "prompts");
  }
  async templates(serverId: string) {
    return this.pages(serverId, "listResourceTemplates", "resourceTemplates");
  }
  notifications(serverId: string) {
    return this.client(serverId).notifications();
  }
  completeArgument(
    serverId: string,
    params: Parameters<MCPClient["completeArgument"]>[0],
    signal?: AbortSignal,
  ) {
    return this.client(serverId).completeArgument(params, signal);
  }
  setLoggingLevel(
    serverId: string,
    level: Parameters<MCPClient["setLoggingLevel"]>[0],
  ) {
    return this.client(serverId).setLoggingLevel(level);
  }
  async prompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ) {
    return this.client(serverId).getPrompt(
      { name, arguments: args },
      { signal },
    );
  }
  async init() {
    this.syncKeyConfigurations();
    for (const d of this.list()) {
      const metadata = d.oauth?.clientMetadata;
      if (
        metadata?.authentication.method === "private_key_jwt" &&
        metadata.authentication.managed
      )
        await this.oauth!.keys.prepare(metadata);
    }
    for (const d of this.list().filter((d) => d.enabled))
      await this.connect(d.id).catch(() => undefined);
  }
  async close() {
    this.closing = true;
    this.interactions.close();
    this.oauth?.close();
    for (const sub of this.subscriptions.values()) sub.handle.close();
    this.subscriptions.clear();
    const closed = await Promise.allSettled(
      [...new Set([...this.clients.values(), ...this.opening.values()])].map(
        (c) => c.close(),
      ),
    );
    await Promise.allSettled([...this.connecting.values()]);
    this.clients.clear();
    const failures = closed.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "MCP execution cleanup unconfirmed",
      );
  }
}
