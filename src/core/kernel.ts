import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  changeRoutes,
  loadPersistedRoutes,
  type RouteChange,
} from "./kernel/routes.js";
import type {
  Input,
  Mode,
  Project,
  Run,
  Session,
  StoredMessage,
  InboxEntry,
  Autonomy,
  ReasoningEffort,
} from "../contracts.js";
import { activeRunStatuses, terminalStatuses } from "../contracts.js";
import { Store } from "../storage/store.js";
import { Assets } from "../storage/assets.js";
import { Media } from "../media/manager.js";
import { Permissions } from "./permissions.js";
import { MemoryStore } from "../storage/memory.js";
import { ContextManager } from "./context.js";
import { SkillManager } from "../extensions/skills.js";
import { PluginManager } from "../extensions/plugins/manager.js";
import { MCPManager } from "../extensions/mcp/manager.js";
import { AgentManager } from "./agents.js";
import { TeamManager } from "../collaboration/index.js";
import { ModeRegistry } from "../modes/registry.js";
import { decodeSessionSnapshot } from "../sessions/codec.js";
import { SessionMigration } from "../sessions/migration.js";
import { ToolScheduler } from "../runtime/scheduler.js";
import { CostLedger, type CostScope } from "../runtime/cost.js";
import type { BillingProvider } from "../runtime/billing.js";
import { ProcessManager } from "../execution/sessions.js";
import { CommandRunner } from "../execution/process.js";
import { recoverWindowsSandboxes } from "../execution/windows-sandbox.js";
import { RouteRouter, type RouteRouterOptions } from "../providers/text.js";
import { textOf, type Message, type UserMessage } from "../runtime/types.js";
import { ToolRegistry, type KernelIntegration } from "../runtime/registry.js";
import { bindHooks, commandHooks, type RunHooks } from "../runtime/hooks.js";
import { WebClient } from "../web/client.js";
import { Checkpoints } from "../sessions/checkpoints.js";
import { outputParameters, OUTPUT_TOOL } from "../runtime/structured-output.js";
import {
  id,
  now,
  invariant,
  hash,
  errorText,
  within,
  registerSecret,
  RedactionScope,
  abortable,
  closeResources,
} from "./util.js";

import { McpHost } from "./kernel/mcp-host.js";
import { createInputBuilder, inputSchema } from "./kernel/input.js";
import { repairHistory } from "./kernel/history.js";
import { RunLifecycle, type LiveRun } from "./kernel/lifecycle.js";
import { createRunEngine } from "./kernel/engine.js";
import { startProcessAction } from "./kernel/process-action.js";
import {
  loadRunHistory,
  memoryContext,
  memoryWriteProbe,
  runTools,
} from "./kernel/run-setup.js";
import {
  MEMORY_EXTRACTION,
  resumeRun,
  runInstructions,
} from "../prompts/agent.js";
import {
  SecurityAudit,
  type SecurityAuditRequest,
  type SecurityAuditRule,
} from "../security/index.js";

export interface KernelOptions {
  integrations?: KernelIntegration[];
  /** Trusted, in-process audit extensions. Inactive while securityAudit.mode is off. */
  securityAuditRules?: readonly SecurityAuditRule[];
  /** Host billing (for example prepaid credits) consulted before every provider call. */
  billing?: BillingProvider;
}
export class Kernel {
  readonly redaction: RedactionScope;
  readonly modes = new ModeRegistry();
  readonly toolRegistry = new ToolRegistry();
  private runHooks = new Set<RunHooks>();
  readonly integrations: readonly KernelIntegration[];
  private initialization?: Promise<void>;
  private readonly buildInput: ReturnType<typeof createInputBuilder>;
  readonly store: Store;
  readonly assets: Assets;
  readonly migrations: SessionMigration;
  readonly media: Media;
  readonly permissions: Permissions;
  readonly securityAudit: SecurityAudit;
  readonly memory: MemoryStore;
  readonly skills: SkillManager;
  readonly plugins: PluginManager;
  readonly mcp: MCPManager;
  readonly context: ContextManager;
  readonly agents: AgentManager;
  readonly teams: TeamManager;
  readonly scheduler: ToolScheduler;
  readonly costs: CostLedger;
  readonly web: WebClient;
  readonly checkpoints: Checkpoints;
  readonly processes: ProcessManager;
  readonly commands: CommandRunner;
  /** Startup cleanup evidence. Live preserved process owners are never reclaimed. */
  sandboxRecovery: Awaited<ReturnType<typeof recoverWindowsSandboxes>> = [];
  private readonly lifecycle = new RunLifecycle();
  private closeCompletion?: Promise<void>;
  private changingRoutes = false;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private retentionWork?: Promise<{
    events: number;
    summaries: number;
    workContexts: number;
  }>;
  private readonly retentionAbort = new AbortController();
  readonly retentionStatus: { lastError?: string; completedAt?: string } = {};
  /** Register lifecycle hooks for subsequent runs; returns an unregister function. */
  addHooks(hooks: RunHooks) {
    const entry = { ...hooks };
    this.runHooks.add(entry);
    return () => this.runHooks.delete(entry);
  }
  private hooksFor(runId: string, session: Session, root: string) {
    const configured = commandHooks(this.config.hooks);
    return bindHooks(
      {
        runId,
        sessionId: session.id,
        projectId: session.projectId,
        projectRoot: root,
        mode: session.mode,
        routeId: session.routeId,
      },
      [
        ...(configured ? [configured] : []),
        ...this.integrations.flatMap((i) => (i.hooks ? [i.hooks] : [])),
        ...this.runHooks,
      ],
      (event, error) =>
        this.store.emit(runId, "hook.failed", {
          event,
          error: errorText(error),
        }),
    );
  }
  constructor(
    readonly config: Config,
    options: KernelOptions = {},
  ) {
    this.redaction = new RedactionScope(config.redaction);
    this.redaction.bind(this);
    const create = <T extends object>(factory: () => T): T =>
      this.redaction.run(() => this.redaction.bind(factory()));
    this.registerRouteSecrets();
    this.integrations = Object.freeze([...(options.integrations || [])]);
    for (const integration of this.integrations)
      if (integration.tools)
        this.toolRegistry.register(integration.id, integration.tools);
    this.store = create(
      () => new Store(config.dataDir, { exclusiveKernel: true }),
    );
    try {
      this.securityAudit = create(
        () =>
          new SecurityAudit(
            config.securityAudit,
            this.store,
            options.securityAuditRules,
          ),
      );
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.store.recover();
    this.costs = create(
      () => new CostLedger(this.store, config, options.billing),
    );
    this.web = create(() => new WebClient(config.web));
    this.checkpoints = create(
      () => new Checkpoints(this.store, config.dataDir),
    );
    this.costs.recover();
    this.assets = create(() => new Assets(this.store, config));
    this.migrations = create(
      () => new SessionMigration(this.store, this.assets, config),
    );
    this.plugins = create(() => new PluginManager(this.store, config));
    this.skills = create(() => new SkillManager(this.store, config));
    this.buildInput = createInputBuilder(config, this.assets, this.skills);
    this.mcp = create(() => new MCPManager(this.store, config));
    this.media = create(
      () =>
        new Media(this.store, this.assets, config, this.plugins, this.costs),
    );
    this.permissions = create(
      () => new Permissions(this.store, config, this.modes),
    );
    this.mcp.setHost(
      new McpHost(config, this.store, this.permissions, this.costs),
    );
    this.memory = create(() => new MemoryStore(this.store, config, this.costs));
    this.context = create(
      () => new ContextManager(this.store, config, this.costs),
    );
    this.agents = create(() => new AgentManager(this.store));
    this.teams = create(() => new TeamManager(this));
    this.scheduler = create(
      () => new ToolScheduler(config.limits.maxConcurrentTools),
    );
    this.processes = create(() => new ProcessManager(this.store, config));
    this.commands = create(() => new CommandRunner(config));
  }
  // Route credentials never expire once registered; skip values already known.
  private readonly routeSecrets = new Set<string>();
  /** Re-read on each submit so rotated environment values are redacted too. */
  private registerRouteSecrets() {
    const register = (value: string | undefined) => {
      if (!value || this.routeSecrets.has(value)) return;
      registerSecret(value);
      this.routeSecrets.add(value);
    };
    for (const route of Object.values(this.config.routes)) {
      if (route.apiKeyEnv) register(process.env[route.apiKeyEnv]);
      for (const [name, ref] of Object.entries(route.headersEnv))
        if (/authorization|cookie|key|token|secret/i.test(name))
          register(process.env[ref]);
    }
  }
  async init() {
    invariant(!this.lifecycle.closing, "Kernel is closing", 503);
    return (this.initialization ||= this.initialize().catch(async (error) => {
      await this.close().catch(() => undefined);
      throw error;
    }));
  }
  private async initialize() {
    this.migrations.recover();
    this.sandboxRecovery = await recoverWindowsSandboxes(this.config);
    invariant(
      !this.sandboxRecovery.some(
        (entry) => !entry.confirmed && !entry.preservedLiveOwner,
      ),
      "Windows sandbox recovery could not confirm cleanup; inspect sandbox state before restarting",
      503,
      "isolation_cleanup_failed",
    );
    await loadPersistedRoutes(this.config);
    for (const root of [
      ...this.config.workspaceRoots,
      ...this.config.extensions.allowedRoots,
    ])
      await mkdir(root, { recursive: true });
    await this.assets.init();
    for (const integration of this.integrations)
      await integration.install?.(this);
    await this.mcp.init();
    for (const definition of this.store.list<unknown>("mode-profiles"))
      this.modes.put(definition);
    const { eventDays, cacheDays, intervalMs } = this.config.retention;
    if (eventDays || cacheDays) {
      void this.pruneAsync().catch(() => undefined);
      this.retentionTimer = setInterval(() => {
        void this.pruneAsync().catch(() => undefined);
      }, intervalMs).unref();
    }
  }
  private retentionCutoffs() {
    const { eventDays, cacheDays } = this.config.retention,
      before = (days: number) =>
        days
          ? new Date(Date.now() - days * 86_400_000).toISOString()
          : undefined;
    return { events: before(eventDays), caches: before(cacheDays) };
  }
  /** Synchronous compatibility entry for offline maintenance. */
  prune() {
    return this.store.prune(this.retentionCutoffs());
  }
  /** Live maintenance yields between batches and shares one in-flight sweep. */
  pruneAsync() {
    if (this.retentionWork) return this.retentionWork;
    this.retentionWork = this.store
      .pruneAsync(this.retentionCutoffs(), 500, this.retentionAbort.signal)
      .then(
        (result) => {
          delete this.retentionStatus.lastError;
          this.retentionStatus.completedAt = now();
          return result;
        },
        (error: unknown) => {
          this.retentionStatus.lastError = errorText(error);
          throw error;
        },
      )
      .finally(() => {
        this.retentionWork = undefined;
      });
    return this.retentionWork;
  }
  async createProject(
    name: string,
    directory?: string,
    options: { billingAccount?: string } = {},
  ): Promise<Project> {
    invariant(name.trim() && name.length <= 200, "Project name required");
    checkBillingAccount(options.billingAccount);
    const root = await realpath(
      directory ? path.resolve(directory) : this.config.workspaceRoots[0],
    );
    const roots = await Promise.all(
      this.config.workspaceRoots.map((p) => realpath(p)),
    );
    invariant(
      roots.some((p) => within(p, root)),
      "Project must be within a configured workspaceRoot",
      403,
    );
    return this.store.put("projects", {
      id: id("project"),
      name,
      root,
      createdAt: now(),
      ...(options.billingAccount
        ? { billingAccount: options.billingAccount }
        : {}),
    });
  }
  /** Assign the host account charged for later calls in this project; undefined clears it. */
  setProjectBillingAccount(projectId: string, billingAccount?: string) {
    checkBillingAccount(billingAccount);
    return this.store.transaction(() => {
      const { billingAccount: _previous, ...project } =
        this.store.project(projectId);
      return this.store.put<Project>("projects", {
        ...project,
        ...(billingAccount ? { billingAccount } : {}),
      });
    });
  }
  async updateRoutes(change: RouteChange) {
    invariant(
      !this.changingRoutes &&
        !this.lifecycle.occupiedRunCount &&
        !this.store.count("runs", {
          status: activeRunStatuses,
        }) &&
        !this.store.count("jobs", { status: ["running", "queued"] }),
      "Update routes while host is idle",
      409,
    );
    this.changingRoutes = true;
    try {
      return await changeRoutes(this.config, change, (name) =>
        this.agents.list().some((agent) => agent.routeId === name) ||
        this.modes.list().some((mode) => mode.defaultRouteId === name)
          ? "Route is referenced by an agent or mode profile"
          : this.store
                .list<Session>("sessions", { routeId: name })
                .some((s) => !s.archived)
            ? "Route is used by a session; change its route or archive it first"
            : undefined,
      );
    } finally {
      this.changingRoutes = false;
    }
  }
  createSession(
    projectId: string,
    mode: Mode = "chat",
    name = "New session",
    routeId?: string,
    agentId?: string,
  ): Session {
    this.store.project(projectId);
    const definition = agentId ? this.agents.get(agentId) : undefined;
    if (definition) mode = definition.mode;
    const profile = this.modes.get(mode);
    const selected =
      routeId ||
      definition?.routeId ||
      profile.defaultRouteId ||
      this.config.defaultRoutes[mode as "chat" | "code" | "office"] ||
      this.config.defaultRoutes.chat;
    this.textRoute(selected);
    return this.store.put("sessions", {
      id: id("session"),
      projectId,
      name: name.slice(0, 200),
      mode,
      routeId: selected,
      agentId,
      subagentsEnabled: true,
      autonomy: "assist",
      createdAt: now(),
      archived: false,
    });
  }
  updateSession(
    sessionId: string,
    change: {
      mode?: Mode;
      routeId?: string;
      name?: string;
      autonomy?: Autonomy;
      archived?: boolean;
      agentId?: string;
      subagentsEnabled?: boolean;
      reasoningEffort?: ReasoningEffort;
      reasoningBudgetTokens?: number;
      readableSessionIds?: string[];
    },
  ) {
    invariant(
      !this.lifecycle.isBusy(sessionId),
      "Cannot change session while a run is active",
      409,
    );
    const session = this.store.session(sessionId),
      definition = change.agentId ? this.agents.get(change.agentId) : undefined;
    for (const id of change.readableSessionIds || [])
      invariant(
        this.store.session(id).projectId === session.projectId,
        "Referenced session belongs to another project",
        403,
      );
    const mode = change.mode || definition?.mode || session.mode;
    const profile = this.modes.get(mode);
    const routeId =
      change.routeId ||
      definition?.routeId ||
      (change.mode
        ? profile.defaultRouteId ||
          this.config.defaultRoutes[mode as "chat" | "code" | "office"] ||
          this.config.defaultRoutes.chat
        : session.routeId);
    this.textRoute(routeId);
    return this.store.put("sessions", {
      ...session,
      ...change,
      mode,
      routeId,
      name: change.name?.slice(0, 200) || session.name,
    });
  }
  forkSession(sessionId: string, throughMessageId?: string) {
    const history = this.store.transcript(sessionId);
    let end = history.length;
    if (throughMessageId) {
      end = history.findIndex((m) => m.id === throughMessageId) + 1;
      invariant(end > 0, "Message not found", 404);
    }
    return this.forkAt(sessionId, end, history);
  }
  /**
   * Rewind a session to a point in its transcript. Files changed by file_write/file_patch after
   * that point are restored (conflicting external changes are reported, not overwritten, unless
   * force). The conversation is rewound by forking, so the original transcript is preserved.
   */
  async rewind(
    sessionId: string,
    options: {
      throughMessageId?: string;
      beforeMessageId?: string;
      files?: boolean;
      conversation?: boolean;
      force?: boolean;
    },
  ) {
    const session = this.store.session(sessionId);
    invariant(
      !this.lifecycle.isBusy(sessionId),
      "Rewind requires an idle session",
      409,
    );
    invariant(
      Boolean(options.throughMessageId) !== Boolean(options.beforeMessageId),
      "Give exactly one of throughMessageId or beforeMessageId",
      400,
    );
    const history = this.store.transcript(sessionId),
      index = history.findIndex(
        (m) => m.id === (options.throughMessageId || options.beforeMessageId),
      );
    invariant(index >= 0, "Message not found", 404);
    const end = options.throughMessageId ? index + 1 : index;
    const callIds = new Set(
      history
        .slice(end)
        .flatMap((m) =>
          m.message.role === "assistant"
            ? m.message.content.flatMap((p) =>
                p.type === "toolCall" ? [p.id] : [],
              )
            : [],
        ),
    );
    const files =
      options.files === false
        ? undefined
        : await this.checkpoints.revert(
            sessionId,
            this.store.project(session.projectId).root,
            callIds,
            options.force,
          );
    const fork =
      options.conversation === false ? undefined : this.forkAt(sessionId, end);
    return { files, session: fork, rewoundMessages: history.length - end };
  }
  /** `history`, when the caller read it synchronously, spares a second transcript read. */
  private forkAt(sessionId: string, end: number, history?: StoredMessage[]) {
    const source = this.store.session(sessionId);
    invariant(
      !this.lifecycle.isBusy(sessionId),
      "Fork requires an idle session",
      409,
    );
    // Only the retained prefix is read; the rewound suffix never leaves the database.
    history ??= end
      ? this.store.transcriptSlice(sessionId, 0, end).messages
      : [];
    return this.store.transaction(() => {
      const fork = this.createSession(
        source.projectId,
        source.mode,
        source.name + " (fork)",
        source.routeId,
        source.agentId,
      );
      this.store.saveTranscript(fork.id, repairHistory(history.slice(0, end)));
      return this.store.put("sessions", {
        ...fork,
        autonomy: source.autonomy,
        subagentsEnabled: source.subagentsEnabled,
        reasoningEffort: source.reasoningEffort,
        reasoningBudgetTokens: source.reasoningBudgetTokens,
        readableSessionIds: source.readableSessionIds,
        collaboration: source.collaboration,
        parentSessionId: source.parentSessionId,
        delegationDepth: source.delegationDepth,
        teamRootSessionId: source.teamRootSessionId,
        teamMemberId: source.teamMemberId,
        forkedFromSessionId: source.id,
        forkedThroughMessageId: history[end - 1]?.id,
      } satisfies Session);
    });
  }
  async exportMigration(sessionId: string) {
    invariant(
      !this.lifecycle.isBusy(sessionId),
      "Migration requires an idle session",
      409,
    );
    const before = this.store.transcriptVersion(sessionId);
    const result = await this.migrations.export(sessionId);
    invariant(
      !this.lifecycle.isBusy(sessionId) &&
        before === this.store.transcriptVersion(sessionId),
      "Session changed during migration export; retry when idle",
      409,
    );
    return result;
  }
  importMigration(
    projectId: string,
    bundle: unknown,
    key: string,
    routeId?: string,
  ) {
    this.registerRouteSecrets();
    return this.migrations.import(
      projectId,
      bundle,
      key,
      (name, mode) => this.createSession(projectId, mode, name, routeId),
      routeId,
    );
  }
  importSession(projectId: string, input: unknown, routeId?: string) {
    this.registerRouteSecrets();
    const decoded = decodeSessionSnapshot(
      input,
      this.config.limits.maxSessionMessages,
    );
    this.store.project(projectId);
    invariant(
      decoded.session.projectId === projectId,
      "Cross-project import requires a separate asset migration",
      403,
    );
    return this.store.transaction(() => {
      const session = this.createSession(
        projectId,
        decoded.session.mode,
        decoded.session.name + " (import)",
        routeId || decoded.session.routeId,
        decoded.session.agentId,
      );
      this.store.saveTranscript(session.id, decoded.messages);
      return session;
    });
  }
  private textRoute(routeId: string) {
    const r = this.config.routes[routeId];
    invariant(
      r?.enabled && r.kind === "text",
      "Text route absent/disabled",
      503,
    );
    return r;
  }
  submit(
    sessionId: string,
    input: Input,
  ): Promise<{ runId: string; inputId: string }> {
    let snapshot: Input;
    let size: number;
    try {
      snapshot = inputSchema.parse(input);
      size = Buffer.byteLength(JSON.stringify(snapshot));
    } catch (error) {
      return Promise.reject(error);
    }
    return this.lifecycle.enqueue(
      sessionId,
      () => this.submitUnlocked(sessionId, snapshot),
      {
        count: this.config.limits.maxQueuedInputs,
        bytes: this.config.limits.maxQueuedInputBytes,
        size,
      },
    );
  }
  private async checkSecurityAudit(
    request: SecurityAuditRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const record = await this.securityAudit.check(request, signal);
    signal.throwIfAborted();
    if (record && request.stage === "tool")
      this.store.emit(request.runId, "security.audit", {
        auditId: record.id,
        stage: record.stage,
        decision: record.decision,
        findings: record.findings,
      });
    invariant(
      record?.decision !== "deny",
      "请求被安全审计策略拒绝，请联系宿主管理员查看审计记录。",
      403,
      "security_audit_denied",
    );
  }
  private async submitUnlocked(sessionId: string, raw: Input) {
    this.registerRouteSecrets();
    invariant(!this.lifecycle.closing, "Kernel is shutting down", 503);
    invariant(!this.changingRoutes, "Model routes are being updated", 409);
    const input = inputSchema.parse(raw);
    if (input.outputSchema) {
      invariant(
        input.delivery === "start",
        "outputSchema is only accepted when starting a run",
        400,
      );
      outputParameters(input.outputSchema);
    }
    invariant(
      input.text?.trim() || input.assetIds.length,
      "Text or assets required",
    );
    const session = this.store.session(sessionId);
    let recovered: InboxEntry[] = [];
    for (const referencedId of input.contextSessionIds)
      invariant(
        this.store.session(referencedId).projectId === session.projectId,
        "Referenced session belongs to another project",
        403,
      );
    if (input.resumeFromRunId) {
      const source = this.store.run(input.resumeFromRunId);
      invariant(
        source.sessionId === sessionId &&
          terminalStatuses.has(source.status) &&
          source.status !== "completed" &&
          input.delivery === "start",
        "Invalid resume source",
        409,
      );
      recovered = this.store.list<InboxEntry>("inbox", {
        runId: source.id,
        status: "pending",
      });
    }
    invariant(!session.archived, "Session archived", 409);
    const route = this.textRoute(session.routeId);
    let digest: string | undefined;
    if (input.clientMessageId) {
      digest = hash(JSON.stringify(input));
      const previous = this.store.lookupInput(
        sessionId,
        input.clientMessageId,
        digest,
      );
      if (previous) return previous;
    }
    const current = this.lifecycle.current(sessionId);
    invariant(
      input.delivery === "start" ? !current : current?.engine?.isRunning,
      input.delivery === "start"
        ? "Session already running; use steer/enqueue"
        : "No running engine available for queued input",
      409,
    );
    invariant(
      current ||
        this.lifecycle.occupiedRunCount < this.config.limits.maxConcurrentRuns,
      "Concurrent run limit reached",
      429,
    );
    invariant(
      !route.apiKeyEnv || process.env[route.apiKeyEnv],
      `Missing environment variable ${route.apiKeyEnv}`,
      503,
    );
    const preparation = this.lifecycle.prepare(sessionId);
    const preparationSignal = AbortSignal.any([
      preparation.controller.signal,
      AbortSignal.timeout(this.config.limits.maxRunMs),
      ...(current ? [current.controller.signal] : []),
    ]);
    try {
      const inputId = id("input"),
        { message, auditText } = await abortable(
          this.buildInput(
            input,
            session,
            inputId,
            preparationSignal,
            this.securityAudit.enabled,
          ),
          preparationSignal,
        );
      if (this.securityAudit.enabled) {
        const scope = {
          projectId: session.projectId,
          sessionId,
          routeId: session.routeId,
        };
        await this.checkSecurityAudit(
          {
            ...scope,
            stage: "input",
            inputId,
            delivery: input.delivery,
            text: auditText ?? "",
            assetIds: input.assetIds,
          },
          preparationSignal,
        );
        // Pending inputs may have been accepted before the current policy was enabled.
        for (const entry of recovered)
          await this.checkSecurityAudit(
            {
              ...scope,
              stage: "input",
              inputId: entry.id,
              delivery: entry.delivery,
              text: textOf(entry.message),
              assetIds: [],
            },
            preparationSignal,
          );
      }
      invariant(!this.lifecycle.closing, "Kernel shutting down", 503);
      const runId = current?.runId || id("run"),
        result = { runId, inputId };
      if (current)
        invariant(
          this.lifecycle.current(sessionId) === current &&
            current.engine?.isRunning,
          "Run finished while preparing input; submit a new start input",
          409,
        );
      current?.engine?.checkQueueCapacity(message);
      this.store.transaction(() => {
        if (input.contextSessionIds.length)
          this.store.write("sessions", {
            ...this.store.session(sessionId),
            readableSessionIds: [
              ...new Set([
                ...(session.readableSessionIds || []),
                ...input.contextSessionIds,
              ]),
            ].slice(-100),
          });
        if (!current) {
          const time = now();
          this.store.write("runs", {
            id: runId,
            sessionId,
            status: "queued",
            createdAt: time,
            updatedAt: time,
            ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          } satisfies Run);
        }
        this.store.write("inbox", {
          id: inputId,
          runId,
          delivery: input.delivery,
          message,
          status: "pending",
          createdAt: now(),
          skillIds: input.skillIds,
        } satisfies InboxEntry);
        if (input.text?.trim()) this.teams.updateGoal(sessionId, input.text);
        if (input.teamRoleDecision)
          this.teams.recordRoleDecision(sessionId, input.teamRoleDecision);
        if (input.clientMessageId)
          this.store.recordInput(
            sessionId,
            input.clientMessageId,
            digest!,
            result,
          );
      });
      this.store.emit(runId, "input.accepted", {
        inputId,
        delivery: input.delivery,
        text: input.text,
        assetIds: input.assetIds,
        skillIds: input.skillIds,
        clientMessageId: input.clientMessageId,
      });
      if (current)
        current.engine!.enqueue(message, input.delivery as "steer" | "enqueue");
      else
        this.startRun(
          runId,
          this.store.session(sessionId),
          message,
          [
            ...new Set([
              ...input.skillIds,
              ...recovered.flatMap((i) => i.skillIds || []),
            ]),
          ],
          recovered.map((i) => i.message as UserMessage),
        );
      return result;
    } finally {
      preparation.release();
    }
  }
  private startRun(
    runId: string,
    session: Session,
    message: UserMessage,
    skillIds: string[],
    recoveredInputs: UserMessage[] = [],
  ) {
    const live = this.lifecycle.start(session.id, runId);
    const deadline = Date.now() + this.config.limits.maxRunMs;
    const timer = setTimeout(
      () => live.controller.abort(new Error("timeout")),
      this.config.limits.maxRunMs,
    );
    live.done = this.costs.withScope(
      {
        projectId: session.projectId,
        sessionId: session.id,
        runId,
        purpose: "agent",
      },
      async () => {
        try {
          this.store.status(runId, "running");
          const engine = await this.prepareEngine(
            runId,
            session,
            message,
            skillIds,
            recoveredInputs,
            live.controller.signal,
            deadline,
          );
          live.engine = engine;
          if (live.cancelled) engine.abort();
          const running = engine.run(message);
          message = { role: "user", content: "", timestamp: 0 };
          recoveredInputs = [];
          const result = await running;
          if (result.status === "completed" && this.autoExtractsMemory(session))
            await this.extractMemory(
              session,
              runId,
              engine.history,
              live.controller.signal,
            ).catch((error) =>
              this.store.emit(runId, "memory.extraction.failed", {
                error: errorText(error),
              }),
            );
          this.store.status(
            runId,
            live.cancelled ? "cancelled" : result.status,
            result.error,
          );
        } catch (error) {
          this.store.status(
            runId,
            live.cancelled ? "cancelled" : "failed",
            errorText(error),
          );
        } finally {
          clearTimeout(timer);
          await this.settleRun(runId, session, live);
        }
      },
    );
  }
  /** Assemble history, tools, memory and instructions into an engine for one run. */
  private async prepareEngine(
    runId: string,
    session: Session,
    message: UserMessage,
    skillIds: string[],
    recoveredInputs: UserMessage[],
    signal: AbortSignal,
    deadline: number,
  ) {
    const root = this.store.project(session.projectId).root,
      definition = session.agentId
        ? this.agents.get(session.agentId)
        : undefined,
      mode = this.modes.get(session.mode),
      scope = { kernel: this, runId, session, definition, signal };
    const stored = loadRunHistory(
      this.store,
      session.id,
      this.config.limits.maxSessionMessages,
      {
        routeId: session.routeId,
        maxBytes: this.config.limits.maxHistoryBytes,
      },
    );
    const outputSchema = this.store.run(runId).outputSchema;
    const tools = await runTools(scope, mode, outputSchema);
    const contextMessages = await memoryContext(scope, message, tools);
    const selectedSkills = [
      ...new Set([...(definition?.skillIds || []), ...skillIds]),
    ];
    const instructions = runInstructions({
      mode: session.mode,
      autonomy: session.autonomy || "assist",
      root,
      boundary: this.config.execution.boundary,
      modePrompt: await mode.prepare(root, session),
      agentInstructions: definition?.instructions || "",
      systemPrompt: definition?.systemPrompt,
      skillCatalog: this.skills.catalog(),
      skillInstructions: this.skills.instructions(selectedSkills),
      outputTool: outputSchema ? OUTPUT_TOOL : undefined,
    });
    return createRunEngine(
      this,
      {
        runId,
        session,
        definition,
        root,
        signal,
        deadline,
        instructions,
        contextMessages,
        history: stored.map((m) => m.message),
        recoveredInputs,
        tools,
        finishTool: outputSchema ? OUTPUT_TOOL : undefined,
      },
      {
        hooks: this.hooksFor(runId, session, root),
        checkSecurityAudit: (request, signal) =>
          this.checkSecurityAudit(request, signal),
      },
    );
  }

  /** Text provider whose model calls are charged to `scope` in the cost ledger. */
  routerFor(
    scope: CostScope,
    options: Omit<RouteRouterOptions, "billing"> = {},
  ): RouteRouter {
    return this.redaction.bind(
      RouteRouter.create(this.config, {
        ...options,
        billing: { ledger: this.costs, scope },
      }),
    );
  }
  private autoExtractsMemory(session: Session) {
    return (
      this.config.memory.enabled &&
      session.autonomy !== "plan" &&
      this.permissions.evaluate(session, session.routeId, memoryWriteProbe)
        .effect !== "deny" &&
      this.config.memory.autoExtract
    );
  }
  /** Let integrations observe settlement, then release the session and announce completion. */
  private async settleRun(runId: string, session: Session, live: LiveRun) {
    for (const integration of this.integrations)
      try {
        if (integration.settled) {
          const signal = AbortSignal.timeout(
            Math.min(this.config.extensions.timeoutMs, 2000),
          );
          await abortable(
            Promise.resolve(integration.settled(runId, signal)),
            signal,
          );
        }
      } catch (error) {
        this.store.emit(runId, "integration.settlement.failed", {
          integration: integration.id,
          error: errorText(error),
        });
      }
    this.lifecycle.finish(session.id, live);
    this.store.emit(runId, "run.completed", {
      status: this.store.run(runId).status,
      steps: live.engine?.steps || 0,
    });
  }
  private async extractMemory(
    session: Session,
    runId: string,
    messages: Message[],
    signal?: AbortSignal,
  ) {
    const source = messages
      .slice(-12)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role}: ${textOf(m)}`)
      .join("\n")
      .slice(0, 20000);
    const response = await this.routerFor({
      projectId: session.projectId,
      sessionId: session.id,
      runId,
      purpose: "memory-extraction",
    }).complete(
      {
        routeId: this.config.defaultRoutes.compact || session.routeId,
        tools: [],
        maxOutputTokens: 1200,
        messages: [
          {
            role: "system",
            timestamp: Date.now(),
            content: MEMORY_EXTRACTION,
          },
          { role: "user", timestamp: Date.now(), content: source },
        ],
      },
      undefined,
      signal,
    );
    invariant(response.stopReason === "stop", "Memory extraction failed");
    const parsed = JSON.parse(
      textOf(response).replace(/^```json\s*|\s*```$/g, ""),
    );
    const items = z
      .object({
        memories: z
          .array(
            z.object({
              content: z.string().max(2000),
              tags: z.array(z.string()).max(10),
              explicit: z.boolean(),
            }),
          )
          .max(10),
      })
      .parse(parsed);
    for (const fact of items.memories.filter((m) => m.explicit)) {
      signal?.throwIfAborted();
      const proposal = this.memory.propose({
        projectId: session.projectId,
        namespace: session.agentId
          ? this.agents.get(session.agentId).memoryNamespace
          : "default",
        content: fact.content,
        tags: fact.tags,
        source: `run:${runId}`,
      });
      this.store.emit(runId, "memory.proposed", { proposal });
    }
  }
  cancel(runId: string) {
    const control = this.lifecycle.control(runId);
    if (control) {
      control.controller.abort(new Error("cancelled"));
      return { runId, accepted: true };
    }
    const run = this.store.run(runId),
      live = this.lifecycle.current(run.sessionId);
    invariant(
      live && live.runId === runId && !terminalStatuses.has(run.status),
      "Run no longer active",
      409,
    );
    this.teams.cancelChildren(runId);
    this.lifecycle.cancel(live);
    return { runId, accepted: true };
  }
  async resume(runId: string) {
    const run = this.store.run(runId);
    invariant(
      terminalStatuses.has(run.status) && run.status !== "completed",
      "Only interrupted,failed or cancelled runs can resume",
      409,
    );
    return this.submit(run.sessionId, {
      text: resumeRun(runId),
      clientMessageId: `resume:${runId}`,
      resumeFromRunId: runId,
    });
  }
  async wait(runId: string) {
    await this.lifecycle.control(runId)?.done;
    const run = this.store.run(runId),
      live = this.lifecycle.current(run.sessionId);
    if (live?.runId === runId) await live.done;
    return this.store.run(runId);
  }
  async close() {
    if (this.closeCompletion) return this.closeCompletion;
    this.closeCompletion = this.closeOnce();
    return this.closeCompletion;
  }
  private async closeOnce() {
    clearInterval(this.retentionTimer);
    this.retentionAbort.abort(new Error("Kernel shutting down"));
    await this.retentionWork?.catch(() => undefined);
    await this.lifecycle.drain();
    await closeResources(
      [
        this.commands,
        this.plugins,
        this.processes,
        this.media,
        ...this.integrations.map((integration) => ({
          close: () =>
            integration.close &&
            abortable(
              Promise.resolve(integration.close()),
              AbortSignal.timeout(this.config.extensions.timeoutMs),
            ),
        })),
        // Outcomes still in flight are persisted before the store closes.
        { close: () => this.costs.drain() },
        this.mcp,
        this.assets,
        this.store,
      ],
      "Kernel cleanup reported errors; remaining resources were still closed",
    ).finally(() => this.redaction.close());
  }
  /** Client-originated process operations use the same tools, validators and approvals as model calls. */
  processAction(
    sessionId: string,
    action: string,
    args: Record<string, unknown>,
  ) {
    return startProcessAction(
      this,
      this.lifecycle,
      (request, signal) => this.checkSecurityAudit(request, signal),
      sessionId,
      action,
      args,
    );
  }
}

function checkBillingAccount(account: unknown) {
  invariant(
    account === undefined ||
      (typeof account === "string" &&
        account.trim().length > 0 &&
        account.length <= 200),
    "Invalid billing account",
  );
}
