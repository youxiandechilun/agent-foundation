import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { invariant } from "./util.js";
import { CAPABILITIES } from "../runtime/types.js";
import { securityAuditSchema } from "../security/config.js";
import {
  defaultTextProtocols,
  type TextProtocolRegistry,
} from "../providers/registry.js";

const endpoint = z
  .string()
  .url()
  .refine(
    (s) => ["http:", "https:"].includes(new URL(s).protocol),
    "HTTP(S) URL required",
  );
const policy = z.enum(["deny", "ask", "allow"]);
export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const hookCommand = z
  .object({
    matcher: z.string().max(500).optional(),
    command: z.string().min(1).max(8000),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
  })
  .strict();
export const routeSchema = z
  .object({
    kind: z.enum(["text", "image", "video", "embedding"]),
    // Media/embedding adapters are fixed; text adapters name a registered TextProtocol.
    adapter: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    model: z.string().min(1),
    baseUrl: endpoint,
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    enabled: z.boolean().default(true),
    acceptsImages: z.boolean().default(false),
    /** Provider-hosted Responses web search; each request still needs network authorization. */
    nativeWebSearch: z.boolean().default(false),
    reasoning: z.boolean().default(false),
    reasoningEffort: reasoningEffortSchema.optional(),
    reasoningBudgetTokens: z.number().int().min(1024).max(1_000_000).optional(),
    supportedReasoningEfforts: z.array(reasoningEffortSchema).min(1).optional(),
    tokenCounterId: z.string().min(1).optional(),
    contextWindow: z.number().int().min(512).default(32_000),
    maxOutputTokens: z.number().int().min(64).default(4096),
    toolAllowlist: z.array(z.string()).default(["*"]),
    mediaRouteAllowlist: z.array(z.string()).default(["*"]),
    capabilityPolicies: z
      .partialRecord(z.enum(CAPABILITIES), policy)
      .default({}),
    fallbackRouteIds: z.array(z.string()).max(5).default([]),
    /** Same-route retries for transient upstream failures before any output streamed. */
    retry: z
      .object({
        maxRetries: z.number().int().min(0).max(10).default(2),
        initialDelayMs: z.number().int().min(0).max(60_000).default(1000),
        maxDelayMs: z.number().int().min(0).max(300_000).default(30_000),
      })
      .strict()
      .optional(),
    /** Anthropic prompt-cache breakpoints on system, tools and recent turns. */
    promptCache: z.boolean().default(true),
    pricing: z
      .object({
        currency: z.literal("USD").default("USD"),
        inputPerMillion: z.number().nonnegative().max(100000).default(0),
        outputPerMillion: z.number().nonnegative().max(100000).default(0),
        cacheReadPerMillion: z.number().nonnegative().max(100000).optional(),
        cacheWritePerMillion: z.number().nonnegative().max(100000).optional(),
        requestUsd: z.number().nonnegative().max(100000).default(0),
        /** Required total reservation for media or hosted-search requests with budgets enabled. */
        maxRequestUsd: z.number().nonnegative().max(100000).optional(),
      })
      .strict()
      .optional(),
    compat: z.record(z.string(), z.unknown()).default({}),
    requestDefaults: z.record(z.string(), z.unknown()).default({}),
    headersEnv: z.record(z.string(), z.string()).default({}),
    submitPath: z.string().default(""),
    pollPath: z.string().default("/{id}"),
    cancelPath: z.string().optional(),
    pollIntervalMs: z.number().int().min(10).max(60_000).default(1500),
    timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
    allowedOutputHosts: z.array(z.string()).default([]),
    mediaAdapterId: z.string().optional(),
    mapping: z
      .object({
        requestTemplate: z.record(z.string(), z.unknown()).optional(),
        id: z.string().default("id"),
        status: z.string().default("status"),
        outputs: z.string().default("output"),
        progress: z.string().default("progress"),
        statuses: z
          .record(
            z.string(),
            z.enum(["queued", "running", "completed", "failed", "cancelled"]),
          )
          .default({}),
      })
      .optional(),
  })
  .strict()
  .refine(
    (r) =>
      !r.nativeWebSearch ||
      (r.kind === "text" && r.adapter === "openai-responses"),
    "Native web search requires a text openai-responses route",
  )
  .refine(
    (r) =>
      r.pricing?.maxRequestUsd === undefined ||
      r.pricing.requestUsd <= r.pricing.maxRequestUsd,
    "Request fee cannot exceed maxRequestUsd",
  );
/** Default route per purpose; chat, code and office are required text routes. */
const defaultRoutesSchema = z.object({
  chat: z.string().min(1),
  code: z.string().min(1),
  office: z.string().min(1),
  compact: z.string().optional(),
  image: z.string().optional(),
  video: z.string().optional(),
  embedding: z.string().optional(),
});
export type DefaultRouteSlot = keyof z.infer<typeof defaultRoutesSchema>;
export const DEFAULT_ROUTE_SLOTS = Object.keys(
  defaultRoutesSchema.shape,
) as readonly DefaultRouteSlot[];
/** Slots that must always name a route, so they cannot be cleared at runtime. */
export const REQUIRED_ROUTE_SLOTS = DEFAULT_ROUTE_SLOTS.filter(
  (slot) => !defaultRoutesSchema.shape[slot].isOptional(),
);
export const configSchema = z
  .object({
    server: z
      .object({
        host: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(4317),
        tokenEnv: z.string().default("AGENT_API_TOKEN"),
        allowedOrigins: z.array(z.string()).default([]),
      })
      .prefault({}),
    dataDir: z.string().default(".agent-data"),
    workspaceRoots: z.array(z.string()).min(1).default(["workspace"]),
    defaultRoutes: defaultRoutesSchema,
    routes: z.record(z.string(), routeSchema),
    permissions: z
      .object({
        exec: policy.default("ask"),
        media: policy.default("ask"),
        browser: policy.default("ask"),
        computer: policy.default("ask"),
        mcp: policy.default("ask"),
        plugin: policy.default("ask"),
        network: policy.default("ask"),
        node: policy.default("ask"),
        "files.read": policy.default("allow"),
        "files.write": policy.default("allow"),
        "memory.read": policy.default("allow"),
        "memory.write": policy.default("allow"),
        agent: policy.default("allow"),
        approvalTimeoutMs: z.number().int().min(100).default(120_000),
      })
      .prefault({}),
    execution: z
      .object({
        boundary: z
          .enum(["native", "docker", "windows-appcontainer"])
          .default("native"),
        windowsSandbox: z
          .object({
            network: z.enum(["none", "internet"]).default("none"),
            readOnlyRoots: z.array(z.string()).max(32).default([]),
            maxRuntimeBytes: z
              .number()
              .int()
              .min(1024 * 1024)
              .max(1024 * 1024 * 1024)
              .default(256 * 1024 * 1024),
          })
          .strict()
          .prefault({}),
        dockerImage: z.string().default("node:22-bookworm-slim"),
        dockerNetwork: z.boolean().default(false),
        readOnlyRoot: z.boolean().default(true),
        requireIsolation: z.boolean().default(false),
        dockerUser: z
          .string()
          .regex(/^\d{1,10}:\d{1,10}$/)
          .default("65534:65534"),
        memoryMb: z.number().int().min(64).max(65536).default(512),
        cpus: z.number().min(0.1).max(64).default(1),
        pidsLimit: z.number().int().min(8).max(4096).default(128),
        workspaceReadOnly: z.boolean().default(false),
        maxProcesses: z.number().int().min(1).max(100).default(8),
        processLifetimeMs: z
          .number()
          .int()
          .min(100)
          .max(86400000)
          .default(3600000),
        processBufferBytes: z
          .number()
          .int()
          .min(16384)
          .max(16777216)
          .default(262144),
        processTotalOutputBytes: z
          .number()
          .int()
          .min(16384)
          .max(1073741824)
          .default(16777216),
        processShutdown: z.enum(["terminate", "preserve"]).default("terminate"),
        posixPython: z.string().default("python3"),
      })
      .prefault({}),
    budgets: z
      .object({
        enabled: z.boolean().default(false),
        maxRunUsd: z.number().positive().max(1000000).optional(),
        maxSessionUsd: z.number().positive().max(1000000).optional(),
        maxProjectUsd: z.number().positive().max(1000000).optional(),
        maxDayUsd: z.number().positive().max(1000000).optional(),
        maxTotalUsd: z.number().positive().max(1000000).optional(),
      })
      .strict()
      .prefault({}),
    browser: z
      .object({
        enabled: z.boolean().default(true),
        headless: z.boolean().default(false),
        channel: z.enum(["chrome", "msedge", "chromium"]).optional(),
        executablePath: z.string().optional(),
        allowedHosts: z.array(z.string()).default(["*"]),
        allowPrivateNetwork: z.boolean().default(false),
        cdpEndpoints: z.array(endpoint).default([]),
        cdpAllowExistingTabs: z.boolean().default(false),
        maxSessions: z.number().int().min(1).max(64).default(8),
        maxTabs: z.number().int().min(1).max(128).default(32),
        maxConnections: z.number().int().min(1).max(256).default(64),
        maxSnapshotChars: z.number().int().min(1000).max(100000).default(24000),
        maxElements: z.number().int().min(1).max(500).default(120),
        timeoutMs: z.number().int().min(100).default(20_000),
      })
      .prefault({}),
    computer: z
      .object({
        enabled: z.boolean().default(true),
        allowGlobalInput: z.boolean().default(false),
        allowDesktopCapture: z.boolean().default(false),
        allowedProcessIds: z
          .array(z.number().int().positive())
          .max(1000)
          .default([]),
        leaseMs: z.number().int().min(1000).max(600000).default(120000),
        timeoutMs: z.number().int().min(100).max(120000).default(15000),
        maxElements: z.number().int().min(1).max(1000).default(200),
        maxDepth: z.number().int().min(1).max(12).default(6),
        maxQueuedActions: z.number().int().min(1).max(100).default(16),
        maxOutputBytes: z
          .number()
          .int()
          .min(4096)
          .max(4000000)
          .default(1000000),
        maxCapturePixels: z
          .number()
          .int()
          .min(10000)
          .max(64000000)
          .default(16000000),
      })
      .strict()
      .prefault({}),
    office: z
      .object({
        maxConcurrentJobs: z.number().int().min(1).max(8).default(2),
        maxHeapMb: z.number().int().min(64).max(1024).default(256),
        timeoutMs: z.number().int().min(100).max(120000).default(30000),
        maxArchiveBytes: z
          .number()
          .int()
          .min(1024)
          .max(256 * 1024 * 1024)
          .default(64 * 1024 * 1024),
        maxArchiveEntries: z.number().int().min(1).max(10000).default(3000),
        maxCells: z.number().int().min(1).max(1000000).default(200000),
        maxTextChars: z.number().int().min(1000).max(10000000).default(2000000),
        maxPages: z.number().int().min(1).max(10000).default(1000),
      })
      .strict()
      .prefault({}),
    extensions: z
      .object({
        allowedRoots: z.array(z.string()).default(["extensions"]),
        executionBoundary: z
          .enum(["native", "docker", "windows-appcontainer"])
          .default("native"),
        timeoutMs: z.number().int().positive().default(30_000),
        maxHeapMb: z.number().int().min(32).max(2048).default(128),
      })
      .prefault({}),
    /** Built-in web_fetch / web_search. Private networks are blocked unless allowed. */
    web: z
      .object({
        enabled: z.boolean().default(true),
        /** "env" uses HTTPS_PROXY/HTTP_PROXY with NO_PROXY; "none" connects directly. */
        proxy: z.union([z.enum(["env", "none"]), endpoint]).default("env"),
        /** PEM bundle added to the default roots (e.g. a corporate TLS proxy). */
        extraCaFile: z.string().optional(),
        allowedHosts: z.array(z.string()).default(["*"]),
        blockedHosts: z.array(z.string()).default([]),
        allowPrivateNetwork: z.boolean().default(false),
        timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
        maxBytes: z
          .number()
          .int()
          .min(64 * 1024)
          .max(50 * 1024 * 1024)
          .default(5 * 1024 * 1024),
        maxRedirects: z.number().int().min(0).max(10).default(5),
        maxChars: z.number().int().min(1000).max(200_000).default(40_000),
        cacheTtlMs: z.number().int().min(0).max(86_400_000).default(900_000),
        userAgent: z
          .string()
          .min(1)
          .max(300)
          .default(
            "Mozilla/5.0 (compatible; AgentFoundation/0.12; +web_fetch)",
          ),
        search: z
          .object({
            /** "none", a built-in ("tavily" | "brave" | "searxng") or a registered provider ID. */
            provider: z.string().default("none"),
            apiKeyEnv: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .optional(),
            baseUrl: endpoint.optional(),
            maxResults: z.number().int().min(1).max(20).default(8),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    securityAudit: securityAuditSchema.prefault({}),
    /** Credential redaction before storage, events and model requests; see RedactionMode. */
    redaction: z
      .object({
        mode: z.enum(["full", "registered", "off"]).default("full"),
        /** Environment variables treated as credentials in "registered" mode. */
        environment: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
          .max(200)
          .default([]),
      })
      .strict()
      .prefault({}),
    /**
     * Pruning of data that only finished runs reference. 0 keeps it forever (default),
     * so event replay and compaction caches behave exactly as without retention.
     */
    retention: z
      .object({
        /** Delete the event log of runs that finished more than this many days ago. */
        eventDays: z.number().int().min(0).max(36_500).default(0),
        /** Delete unreferenced compaction summaries and run context records older than this. */
        cacheDays: z.number().int().min(0).max(36_500).default(0),
        /** Confirmed terminal device tasks; unknown outcomes always remain. */
        nodeTaskDays: z.number().int().min(0).max(36_500).default(0),
        intervalMs: z
          .number()
          .int()
          .min(60_000)
          .max(7 * 86_400_000)
          .default(3_600_000),
      })
      .strict()
      .prefault({}),
    /** Host-trusted lifecycle hook commands (Claude Code compatible stdin/exit-code protocol). */
    hooks: z
      .object({
        timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
        maxStopContinuations: z.number().int().min(0).max(20).default(3),
        UserPromptSubmit: z.array(hookCommand).max(16).default([]),
        PreToolUse: z.array(hookCommand).max(16).default([]),
        PostToolUse: z.array(hookCommand).max(16).default([]),
        Stop: z.array(hookCommand).max(16).default([]),
      })
      .strict()
      .prefault({}),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        autoExtract: z.boolean().default(false),
        maxEntriesInPrompt: z.number().int().min(0).max(50).default(6),
      })
      .prefault({}),
    limits: z
      .object({
        maxConcurrentJsonRequests: z.number().int().min(1).max(1024).default(8),
        maxInFlightJsonBytes: z
          .number()
          .int()
          .positive()
          .default(256 * 1024 * 1024),
        maxConcurrentSessionExports: z.number().int().min(1).max(64).default(2),
        maxSessionExportBytes: z
          .number()
          .int()
          .positive()
          .default(128 * 1024 * 1024),
        sessionExportTimeoutMs: z
          .number()
          .int()
          .min(100)
          .max(600000)
          .default(60000),
        maxMigrationBytes: z
          .number()
          .int()
          .min(1024)
          .max(512 * 1024 * 1024)
          .default(128 * 1024 * 1024),
        maxUploadBytes: z
          .number()
          .int()
          .positive()
          .default(50 * 1024 * 1024),
        maxInputAssetBytes: z
          .number()
          .int()
          .positive()
          .default(50 * 1024 * 1024),
        maxSteps: z.number().int().min(1).max(500).default(64),
        maxToolCalls: z.number().int().min(1).default(150),
        maxRepeatedToolResults: z
          .number()
          .int()
          .min(0)
          .max(100)
          .refine((n) => n === 0 || n >= 2)
          .default(6),
        maxSearchEntries: z.number().int().min(1).max(100000).default(3000),
        maxRunMs: z.number().int().min(100).default(900_000),
        maxConcurrentRuns: z.number().int().min(1).default(4),
        maxConcurrentTools: z.number().int().min(1).max(64).default(4),
        maxPendingNodeTasks: z.number().int().min(1).max(10000).default(64),
        maxNodeTaskBytes: z
          .number()
          .int()
          .positive()
          .default(8 * 1024 * 1024),
        maxConcurrentMemoryExports: z.number().int().min(1).max(64).default(2),
        maxMemoryExportBytes: z
          .number()
          .int()
          .positive()
          .default(128 * 1024 * 1024),
        memoryExportTimeoutMs: z
          .number()
          .int()
          .min(100)
          .max(600000)
          .default(60000),
        maxConcurrentMemorySearches: z.number().int().min(1).max(64).default(4),
        maxConcurrentMediaJobs: z.number().int().min(1).max(64).default(2),
        maxQueuedMediaJobs: z.number().int().min(0).max(1000).default(16),
        maxMediaQueueBytes: z
          .number()
          .int()
          .positive()
          .default(4 * 1024 * 1024),
        maxConcurrentMigrations: z.number().int().min(1).max(16).default(1),
        maxHistoryBytes: z
          .number()
          .int()
          .positive()
          .default(128 * 1024 * 1024),
        maxQueuedInputs: z.number().int().min(1).max(10000).default(32),
        maxQueuedInputBytes: z
          .number()
          .int()
          .positive()
          .default(16 * 1024 * 1024),
        maxConcurrentUploads: z.number().int().min(1).max(1024).default(4),
        maxConcurrentDownloads: z.number().int().min(1).max(1024).default(8),
        maxInFlightAssetBytes: z
          .number()
          .int()
          .positive()
          .default(100 * 1024 * 1024),
        maxSseSubscribers: z.number().int().min(1).max(10000).default(128),
        maxSseSubscribersPerRun: z.number().int().min(1).max(1000).default(16),
        maxSseBufferBytes: z
          .number()
          .int()
          .positive()
          .default(64 * 1024 * 1024),
        maxSseConnectionBytes: z
          .number()
          .int()
          .positive()
          .default(16 * 1024 * 1024),
        sseDrainTimeoutMs: z.number().int().min(100).max(600000).default(30000),
        maxAttachmentText: z.number().int().min(100).default(20_000),
        compactAtRatio: z.number().min(0.1).max(0.9).default(0.7),
        maxOutputBytes: z.number().int().positive().default(64_000),
        maxSessionMessages: z.number().int().positive().default(20000),
        /** Auto-continue replies cut off by the output limit (0 disables). */
        maxOutputContinuations: z.number().int().min(0).max(20).default(3),
        /** How deep sub-agents may delegate (0 disables agent_delegate; 1 = no nested delegation). */
        maxAgentDepth: z.number().int().min(0).max(5).default(1),
      })
      .prefault({}),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Route = Config["routes"][string];
export function parseConfig(
  input: unknown,
  baseDir = process.cwd(),
  protocols: TextProtocolRegistry = defaultTextProtocols,
): Config {
  const config = configSchema.parse(input);
  config.dataDir = path.resolve(baseDir, config.dataDir);
  config.workspaceRoots = config.workspaceRoots.map((p) =>
    path.resolve(baseDir, p),
  );
  config.extensions.allowedRoots = config.extensions.allowedRoots.map((p) =>
    path.resolve(baseDir, p),
  );
  if (config.web.extraCaFile)
    config.web.extraCaFile = path.resolve(baseDir, config.web.extraCaFile);
  config.execution.windowsSandbox.readOnlyRoots =
    config.execution.windowsSandbox.readOnlyRoots.map((p) =>
      path.resolve(baseDir, p),
    );
  invariant(
    !config.execution.requireIsolation ||
      config.execution.boundary === "windows-appcontainer" ||
      (config.execution.boundary === "docker" &&
        config.execution.readOnlyRoot &&
        config.execution.dockerUser
          .split(":")
          .every((n) => Number(n) > 0 && Number(n) <= 4294967294)),
    "Required isolation needs an explicit OS backend; Docker needs a read-only root and a non-root UID/GID",
  );
  for (const [slot, routeId] of Object.entries(config.defaultRoutes)) {
    if (!routeId) continue;
    const r = config.routes[routeId];
    invariant(r?.enabled, `Default route ${routeId} is absent/disabled`);
    invariant(
      r.kind ===
        (["chat", "code", "office", "compact"].includes(slot) ? "text" : slot),
      `Wrong route kind for ${slot}`,
    );
  }
  for (const [name, r] of Object.entries(config.routes)) {
    invariant(/^[a-zA-Z0-9._-]+$/.test(name), "Invalid route ID");
    invariant(
      r.maxOutputTokens <= r.contextWindow * 0.8,
      `Output budget leaves insufficient input: ${name}`,
    );
    const expected =
      r.adapter === "openai-embeddings"
        ? "embedding"
        : r.adapter === "image-json"
          ? "image"
          : r.adapter === "video-job"
            ? "video"
            : ["media-http", "custom-media"].includes(r.adapter)
              ? r.kind
              : "text";
    invariant(r.kind === expected, `Route adapter kind mismatch: ${name}`);
    invariant(
      r.kind !== "text" || protocols.find(r.adapter),
      `Unknown text protocol ${r.adapter} for route ${name}`,
    );
    if (r.kind === "text")
      for (const key of [
        "model",
        "messages",
        "tools",
        "stream",
        "system",
        "input",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
      ])
        invariant(
          !(key in r.requestDefaults),
          `requestDefaults cannot override ${key}`,
        );
  }
  return config;
}
export async function loadConfig(
  file = "config.json",
  protocols: TextProtocolRegistry = defaultTextProtocols,
) {
  return parseConfig(
    JSON.parse(await readFile(file, "utf8")),
    path.dirname(path.resolve(file)),
    protocols,
  );
}
export function publicConfig(config: Config) {
  return {
    defaultRoutes: config.defaultRoutes,
    routes: Object.entries(config.routes).map(([id, r]) => ({
      id,
      kind: r.kind,
      adapter: r.adapter,
      model: r.model,
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      acceptsImages: r.acceptsImages,
      nativeWebSearch: r.nativeWebSearch,
      reasoning: r.reasoning,
      reasoningEffort: r.reasoningEffort,
      supportedReasoningEfforts: r.supportedReasoningEfforts,
      contextWindow: r.contextWindow,
      maxOutputTokens: r.maxOutputTokens,
      pricing: r.pricing,
      retry: r.retry,
      promptCache: r.promptCache,
      toolAllowlist: r.toolAllowlist,
      mediaRouteAllowlist: r.mediaRouteAllowlist,
      headersEnv: Object.keys(r.headersEnv),
      apiKeyEnv: r.apiKeyEnv,
      credentialConfigured: !r.apiKeyEnv || Boolean(process.env[r.apiKeyEnv]),
    })),
    modes: ["chat", "code", "office"],
    permissions: config.permissions,
    redaction: { mode: config.redaction.mode },
    retention: config.retention,
    securityAudit: {
      mode: config.securityAudit.mode,
      timeoutMs: config.securityAudit.timeoutMs,
      onError: config.securityAudit.onError,
      promptInjection: config.securityAudit.promptInjection,
      textRuleIds: config.securityAudit.textRules.map((rule) => rule.id),
    },
    limits: config.limits,
    execution: config.execution,
    budgets: config.budgets,
    extensions: {
      executionBoundary: config.extensions.executionBoundary,
      timeoutMs: config.extensions.timeoutMs,
      maxHeapMb: config.extensions.maxHeapMb,
    },
    browser: { enabled: config.browser.enabled },
    web: {
      enabled: config.web.enabled,
      search: config.web.search.provider,
    },
  };
}
