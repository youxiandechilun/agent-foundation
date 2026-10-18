import type { Kernel } from "../../core/kernel.js";
import type { Run } from "../../contracts.js";
import { terminalStatuses } from "../../contracts.js";
import type { ToolContext } from "../../runtime/registry.js";
import { textOf } from "../../runtime/types.js";
import { abortable, invariant, now, truncate } from "../../core/util.js";
import { readSchema, statusSchema, type TeamTask } from "../types.js";
import { compactTeamContract } from "../prompts.js";
import { resolveTeamContext } from "./context.js";

export const activeTask = (task: TeamTask) =>
  task.status === "preparing" || !terminalStatuses.has(task.status);

/** Durable member-run status, cancellation and bounded result projections. */
export class TeamTasks {
  constructor(readonly kernel: Kernel) {
    for (const task of this.kernel.store.list<TeamTask>("team-tasks")) {
      if (task.status === "preparing" && !task.runId)
        this.kernel.store.put("team-tasks", {
          ...task,
          status: "interrupted",
          error:
            "Host restarted before member run was recorded; inspect the member session before retrying",
          updatedAt: now(),
        } satisfies TeamTask);
      else this.refresh(task);
    }
  }

  async status(context: ToolContext, input: unknown, signal?: AbortSignal) {
    const { root, team } = resolveTeamContext(this.kernel, context),
      args = statusSchema.parse(input);
    if (args.taskId) {
      const task = this.kernel.store.get<TeamTask>("team-tasks", args.taskId);
      invariant(
        task.rootSessionId === root.id && task.teamId === team.id,
        "Task belongs to another team conversation",
        403,
      );
      if (args.waitMs && task.runId && activeTask(this.refresh(task))) {
        const timer = new AbortController();
        const timeout = setTimeout(() => timer.abort(), args.waitMs);
        const combined = AbortSignal.any([
          timer.signal,
          ...(signal ? [signal] : []),
        ]);
        try {
          await abortable(this.kernel.wait(task.runId), combined);
        } catch (error) {
          if (!timer.signal.aborted || signal?.aborted) throw error;
        } finally {
          clearTimeout(timeout);
        }
      }
      signal?.throwIfAborted();
      return { task: this.report(this.refresh(task), root.id) };
    }
    invariant(!args.waitMs, "taskId is required when waiting for team status");
    const filter = { rootSessionId: root.id, teamId: team.id },
      total = this.kernel.store.count("team-tasks", filter),
      visible = this.kernel.store
        .list<TeamTask>("team-tasks", filter, { descending: true, limit: 40 })
        .reverse()
        .map((task) => this.refresh(task));
    const resultBudget = Math.max(
      120,
      Math.min(
        2000,
        Math.floor(
          this.kernel.config.limits.maxOutputBytes /
            Math.max(1, visible.length * 4),
        ),
      ),
    );
    return {
      teamId: team.id,
      rootSessionId: root.id,
      goalRevision: root.collaboration?.revision,
      total,
      hasMore: visible.length < total,
      tasks: visible.map((task) => this.summary(task, root.id, resultBudget)),
    };
  }

  read(context: ToolContext, input: unknown) {
    const { root, team } = resolveTeamContext(this.kernel, context),
      args = readSchema.parse(input);
    const target = this.kernel.store.session(args.sessionId);
    invariant(
      target.projectId === root.projectId &&
        target.collaboration?.teamId === team.id &&
        (target.id === root.id || target.teamRootSessionId === root.id),
      "Session belongs to another team conversation",
      403,
    );
    return {
      sessionId: target.id,
      untrusted: true,
      ...this.kernel.store.transcriptSlice(target.id, args.offset, args.limit),
    };
  }

  cancelChildren(rootRunId: string): void {
    for (const task of this.kernel.store.list<TeamTask>("team-tasks", {
      rootRunId,
    }))
      if (task.runId && activeTask(this.refresh(task)))
        this.cancelRun(task.runId);
  }

  cancelRun(runId: string): void {
    try {
      this.kernel.cancel(runId);
    } catch {
      /* A completed child needs no cancellation. */
    }
  }
  refresh(task: TeamTask): TeamTask {
    if (!task.runId) return task;
    const run = this.kernel.store.run(task.runId);
    if (task.status === run.status && task.error === run.error) return task;
    return this.kernel.store.put("team-tasks", {
      ...task,
      status: run.status,
      error: run.error,
      updatedAt: now(),
    });
  }
  forRoot(rootSessionId: string): TeamTask[] {
    return this.kernel.store
      .list<TeamTask>("team-tasks", { rootSessionId })
      .map((task) => this.refresh(task));
  }
  report(task: TeamTask, rootSessionId: string) {
    const root = this.kernel.store.session(rootSessionId);
    const run: Run | undefined = task.runId
      ? this.kernel.store.run(task.runId)
      : undefined;
    const last = task.runId
      ? this.kernel.store.lastAssistant(task.sessionId, task.runId)?.message
      : undefined;
    const { binding, prompt, ...snapshot } = task;
    void prompt;
    const result = last ? textOf(last) : "";
    const limit = Math.max(
      1000,
      Math.min(12000, Math.floor(this.kernel.config.limits.maxOutputBytes / 2)),
    );
    return {
      ...snapshot,
      goalRevision: binding.revision,
      contract: compactTeamContract(binding),
      stale: task.binding.revision !== root.collaboration?.revision,
      result: truncate(result, limit),
      resultTruncated: result.length > limit,
      ...(run?.output !== undefined ? { output: run.output } : {}),
    };
  }
  private summary(task: TeamTask, rootSessionId: string, resultBudget: number) {
    const report = this.report(task, rootSessionId);
    return {
      id: report.id,
      memberAgentId: report.memberAgentId,
      sessionId: report.sessionId,
      runId: report.runId,
      rootRunId: report.rootRunId,
      status: report.status,
      goalRevision: report.goalRevision,
      stale: report.stale,
      scope: report.scope,
      deliverable: truncate(report.deliverable, 600),
      refinedResponsibility: truncate(report.refinedResponsibility, 400),
      result: truncate(report.result, resultBudget),
      resultTruncated:
        report.resultTruncated || report.result.length > resultBudget,
      ...(report.error ? { error: truncate(report.error, 1000) } : {}),
    };
  }
}
