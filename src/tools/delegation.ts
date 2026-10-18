import { Type } from "typebox";
import { terminalStatuses } from "../contracts.js";
import { delay, invariant, truncate } from "../core/util.js";
import { textOf } from "../runtime/types.js";
import type { BuiltinTools } from "./builtin.js";

export function registerDelegation({
  ctx,
  k,
  session,
  runId,
  add,
}: BuiltinTools): void {
  const depth = session.delegationDepth || 0;
  if (
    !session.collaboration &&
    session.subagentsEnabled !== false &&
    depth < k.config.limits.maxAgentDepth
  ) {
    const catalog = k.agents
      .list()
      .filter((a) => a.mode === session.mode)
      .slice(0, 20)
      .map((a) => `${a.id}: ${a.name}`);
    const report = (childSessionId: string, childRunId: string) => {
      const run = k.store.run(childRunId);
      const last = k.store.lastAssistant(childSessionId, childRunId)?.message;
      return {
        sessionId: childSessionId,
        runId: childRunId,
        status: run.status,
        ...(run.error ? { error: run.error } : {}),
        ...(run.output !== undefined ? { output: run.output } : {}),
        result: last ? textOf(last) : "",
      };
    };
    const cancelChild = (childRunId: string) => () => {
      try {
        k.cancel(childRunId);
      } catch {
        // Already finished.
      }
    };
    const delegate = add(
      "agent_delegate",
      `Delegate a self-contained subtask to a sub-agent with its own fresh context, in this project and mode, with the same permissions. Give it a complete brief: it cannot see this conversation. By default waits and returns its final answer; several delegations in one step run in parallel. With background=true it returns immediately; collect the answer later with agent_result.${catalog.length ? ` Agent definitions: ${catalog.join("; ")}.` : ""}`,
      Type.Object({
        description: Type.String({ minLength: 1, maxLength: 120 }),
        prompt: Type.String({ minLength: 1, maxLength: 40000 }),
        agentId: Type.Optional(Type.String({ maxLength: 80 })),
        background: Type.Optional(Type.Boolean()),
      }),
      "read",
      [],
      async (args, signal, callId) => {
        const definition = args.agentId
          ? k.agents.get(args.agentId)
          : undefined;
        invariant(
          !definition || definition.mode === session.mode,
          `Agent ${args.agentId} runs in ${definition?.mode} mode; sub-agents must use the parent's mode (${session.mode})`,
          403,
        );
        const created = k.createSession(
          session.projectId,
          session.mode,
          `Sub-agent: ${args.description}`,
          session.routeId,
          definition?.id || session.agentId,
        );
        const child = k.store.put("sessions", {
          ...created,
          autonomy: session.autonomy || "assist",
          parentSessionId: session.id,
          delegationDepth: depth + 1,
          subagentsEnabled: session.subagentsEnabled,
          reasoningEffort:
            session.reasoningEffort ||
            (session.agentId
              ? k.agents.get(session.agentId).reasoningEffort
              : undefined),
          reasoningBudgetTokens:
            session.reasoningBudgetTokens ??
            (session.agentId
              ? k.agents.get(session.agentId).reasoningBudgetTokens
              : undefined),
          readableSessionIds: k.store.session(session.id).readableSessionIds,
          collaboration: session.collaboration,
          teamRootSessionId: session.teamRootSessionId,
        });
        const { runId: childRunId } = await k.submit(child.id, {
          text: args.prompt,
        });
        k.store.emit(runId, "subagent.started", {
          toolCallId: callId,
          sessionId: child.id,
          runId: childRunId,
          agentId: definition?.id,
          description: args.description,
          background: Boolean(args.background),
        });
        if (args.background) {
          // Background work outlives this tool call but not a cancelled or timed-out parent run.
          ctx.signal?.addEventListener("abort", cancelChild(childRunId), {
            once: true,
          });
          return {
            sessionId: child.id,
            runId: childRunId,
            status: "running",
            background: true,
            note: "Running in the background. Call agent_result with this runId to check on it or wait for it.",
          };
        }
        const stop = cancelChild(childRunId);
        signal?.addEventListener("abort", stop, { once: true });
        try {
          await k.wait(childRunId);
          const result = report(child.id, childRunId);
          k.store.emit(runId, "subagent.completed", {
            toolCallId: callId,
            sessionId: child.id,
            runId: childRunId,
            status: result.status,
          });
          invariant(
            result.status === "completed",
            `Sub-agent ${result.status}: ${result.error || "no error detail"}${result.result ? `\nLast output:\n${truncate(result.result, 4000)}` : ""}`,
            502,
          );
          return result;
        } finally {
          signal?.removeEventListener("abort", stop);
        }
      },
    );
    // Waiting on the child must not occupy a scheduler slot its own tools need.
    delegate.scheduling = { parallelSafe: true, detached: true };
    const result = add(
      "agent_result",
      "Check a sub-agent started by agent_delegate (including background ones from earlier runs of this session). Optionally wait up to waitMs for it to finish. Returns status and, when finished, its final answer.",
      Type.Object({
        runId: Type.String({ minLength: 1, maxLength: 200 }),
        waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
      }),
      "read",
      [],
      async (args, signal) => {
        const run = k.store.run(args.runId),
          child = k.store.session(run.sessionId);
        invariant(
          child.parentSessionId === session.id,
          "That run is not a sub-agent of this session",
          403,
        );
        if (args.waitMs && !terminalStatuses.has(run.status))
          await Promise.race([
            k.wait(run.id),
            delay(args.waitMs, signal).catch(() => undefined),
          ]);
        signal?.throwIfAborted();
        return report(child.id, run.id);
      },
    );
    result.scheduling = { parallelSafe: true, detached: true };
  }
}
