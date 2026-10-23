import type { Kernel } from "../kernel.js";
import type { Session, AgentDefinition } from "../../contracts.js";
import type {
  Message,
  UserMessage,
  ToolDefinition,
  JsonObject,
} from "../../runtime/types.js";
import type { EngineHooks } from "../../runtime/hooks.js";
import type { SecurityAuditRequest } from "../../security/index.js";
import { ExecutionEngine } from "../../runtime/engine.js";
import { normalizeToolResult } from "../../runtime/tool-result.js";
import { nativeWebSearchRequest } from "./native-web-search.js";
import { filterModelContext, resolveToolPolicy } from "./authorization.js";

export type EngineSetup = {
  runId: string;
  session: Session;
  definition?: AgentDefinition;
  root: string;
  signal: AbortSignal;
  deadline: number;
  instructions: string;
  contextMessages: Message[];
  history: Message[];
  recoveredInputs: UserMessage[];
  tools: ToolDefinition[];
  finishTool?: string;
};

/** Assemble one run from explicit inputs; lifecycle state remains owned by Kernel. */
export function createRunEngine(
  kernel: Kernel,
  setup: EngineSetup,
  options: {
    hooks: EngineHooks | undefined;
    checkSecurityAudit: (
      request: SecurityAuditRequest,
      signal: AbortSignal,
    ) => Promise<void>;
  },
) {
  const { runId, session, definition, tools } = setup;
  let extended: { source: Message; team: string; message: Message } | undefined;
  const filter = (
      routeId: string,
      messages: Message[],
      toolList: ToolDefinition[],
      current: Session = session,
    ) =>
      filterModelContext(
        kernel.permissions,
        current,
        routeId,
        messages,
        toolList,
      ),
    prepareFor = (
      routeId: string,
      messages: Message[],
      toolList: ToolDefinition[],
      signal: AbortSignal | undefined,
      scale = 1,
    ) =>
      kernel.context.prepare(
        runId,
        routeId,
        filter(routeId, messages, toolList),
        signal,
        toolList,
        scale,
      );
  // Reuse the extended system message while its inputs are unchanged, so the
  // token estimate cached on that object stays valid across model steps.
  function withTeamInstructions(entry: Message, team: string): Message {
    if (extended?.source !== entry || extended.team !== team)
      extended = {
        source: entry,
        team,
        message: { ...entry, content: entry.content + team } as Message,
      };
    return extended.message;
  }
  const authorize = async (
    tool: ToolDefinition,
    args: JsonObject,
    callId: string,
    signal: AbortSignal,
    effectiveRoute: string,
  ) => {
    const current = kernel.store.session(session.id);
    if (kernel.securityAudit.enabled)
      await options.checkSecurityAudit(
        {
          stage: "tool",
          projectId: current.projectId,
          sessionId: current.id,
          routeId: effectiveRoute,
          runId,
          toolCallId: callId,
          toolName: tool.name,
          arguments: args,
        },
        signal,
      );
    const policyTool = await resolveToolPolicy(
      { kernel, runId, session: current, routeId: effectiveRoute },
      tool,
      args,
      signal,
    );
    return kernel.permissions.check(
      runId,
      effectiveRoute,
      policyTool,
      args,
      callId,
      signal,
    );
  };
  const engine = new ExecutionEngine({
    signal: setup.signal,
    runId,
    routeId: session.routeId,
    modelSettings: {
      reasoningEffort: session.reasoningEffort ?? definition?.reasoningEffort,
      reasoningBudgetTokens:
        session.reasoningBudgetTokens ?? definition?.reasoningBudgetTokens,
    },
    instructions: setup.instructions,
    contextMessages: setup.contextMessages,
    history: setup.history,
    historyMessageCount: kernel.store.transcriptCount(session.id),
    compactHistory: true,
    maxHistoryBytes: kernel.config.limits.maxHistoryBytes,
    maxQueuedInputs: kernel.config.limits.maxQueuedInputs,
    maxQueuedInputBytes: kernel.config.limits.maxQueuedInputBytes,
    recoveredInputs: setup.recoveredInputs,
    tools,
    provider: kernel.routerFor(
      {
        projectId: session.projectId,
        sessionId: session.id,
        runId,
        purpose: "agent",
      },
      {
        onRoute: (routeId, fallback) =>
          kernel.store.emit(runId, "model.route.selected", {
            routeId,
            fallback,
          }),
        prepareRoute: async (request, signal) =>
          request.routeId === session.routeId
            ? {
                ...request,
                messages: filter(
                  request.routeId,
                  request.messages,
                  request.tools,
                ),
              }
            : {
                ...request,
                messages: await prepareFor(
                  request.routeId,
                  request.messages,
                  request.tools,
                  signal,
                ),
              },
        repairContext: async (request, signal) => ({
          ...request,
          messages: await prepareFor(
            request.routeId,
            request.messages,
            request.tools,
            signal,
            0.5,
          ),
        }),
        onRetry: (notice) =>
          kernel.store.emit(runId, "model.retry", { ...notice }),
        beforeRequest: (request, signal) =>
          nativeWebSearchRequest(
            kernel.config,
            kernel.permissions,
            kernel.store.session(session.id),
            request,
            signal || setup.signal,
            authorize,
            (reason) =>
              kernel.store.emit(runId, "model.native-web-search.disabled", {
                routeId: request.routeId,
                reason,
              }),
          ),
      },
    ),
    maxSteps: Math.min(
      definition?.maxSteps || kernel.config.limits.maxSteps,
      kernel.config.limits.maxSteps,
    ),
    maxToolCalls: kernel.config.limits.maxToolCalls,
    scheduler: kernel.scheduler,
    maxRepeatedToolResults: kernel.config.limits.maxRepeatedToolResults,
    maxOutputContinuations: kernel.config.limits.maxOutputContinuations,
    finishTool: setup.finishTool,
    hooks: options.hooks,
    maxStopContinuations: kernel.config.hooks.maxStopContinuations,
    maxMessages: kernel.config.limits.maxSessionMessages,
    normalizeResult: (result, signal) =>
      normalizeToolResult(
        result,
        kernel.assets,
        session.projectId,
        kernel.config.limits.maxOutputBytes,
        signal,
      ),
    timeoutMs: Math.max(1, setup.deadline - Date.now()),
    store: kernel.store,
    publish: (type, data, durable = true, redactedText) => {
      durable
        ? kernel.store.emit(runId, type, data, true, redactedText)
        : kernel.store.emitEphemeral(runId, type, data);
    },
    checkpoint: (item, messageId, messageText) => {
      kernel.store.appendTranscript(
        session.id,
        { id: messageId, runId, message: item },
        messageText,
      );
    },
    prepare: (messages, signal) => {
      const current = kernel.store.session(session.id);
      return kernel.context.prepare(
        runId,
        session.routeId,
        filter(
          session.routeId,
          messages.map((entry, index) =>
            index === 0 && entry.role === "system"
              ? withTeamInstructions(entry, kernel.teams.instructions(current))
              : entry,
          ),
          tools,
          current,
        ),
        signal,
        tools,
      );
    },
    authorize,
  });
  // Runtime callbacks retain setup; release construction-only message arrays.
  setup.history = [];
  setup.recoveredInputs = [];
  setup.contextMessages = [];
  return engine;
}
