import { z } from "zod";
import type { Run } from "../../contracts.js";
import { processTools } from "../../execution/tools.js";
import { compileSchema } from "../../runtime/json-schema.js";
import { normalizeToolResult } from "../../runtime/tool-result.js";
import type { SecurityAuditRequest } from "../../security/index.js";
import type { Kernel } from "../kernel.js";
import {
  abortable,
  deepFreeze,
  errorText,
  id,
  invariant,
  now,
} from "../util.js";
import { resolveToolPolicy } from "./authorization.js";
import type { RunLifecycle } from "./lifecycle.js";

/**
 * Start a client-originated process operation as its own control run. It uses the
 * same tools, validators, audit, approvals and scheduler as model tool calls.
 */
export function startProcessAction(
  kernel: Kernel,
  lifecycle: RunLifecycle,
  audit: (request: SecurityAuditRequest, signal: AbortSignal) => Promise<void>,
  sessionId: string,
  action: string,
  args: Record<string, unknown>,
) {
  invariant(!lifecycle.closing, "Kernel is closing", 503);
  invariant(
    lifecycle.controlCount < kernel.config.limits.maxConcurrentRuns,
    "Control run capacity exhausted",
    429,
  );
  const session = kernel.store.session(sessionId);
  invariant(!session.archived, "Session is archived", 409);
  const runId = id("run"),
    tool = processTools({
      kernel,
      session,
      runId,
      routeId: session.routeId,
    }).find((t) => t.name === `exec_${action}`);
  invariant(tool, "Unknown process action");
  const validate = compileSchema(tool.parameters);
  invariant(
    validate(args),
    "Invalid process arguments: " + JSON.stringify(validate.errors),
  );
  args = deepFreeze(structuredClone(args));
  kernel.store.write("runs", {
    id: runId,
    sessionId,
    status: "queued",
    createdAt: now(),
    updatedAt: now(),
  } satisfies Run);
  const controller = new AbortController(),
    signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(kernel.config.limits.maxRunMs),
    ]);
  const done = Promise.resolve().then(async () => {
    kernel.store.status(runId, "running");
    try {
      if (kernel.securityAudit.enabled)
        await audit(
          {
            stage: "tool",
            projectId: session.projectId,
            sessionId,
            routeId: session.routeId,
            runId,
            toolCallId: "control",
            toolName: tool.name,
            arguments: z.record(z.string(), z.json()).parse(args),
          },
          signal,
        );
      const policyTool = await resolveToolPolicy(
        { kernel, session, runId, routeId: session.routeId },
        tool,
        args,
        signal,
        "control",
      );
      const release = await kernel.scheduler.acquire(tool, args, signal);
      let normalized;
      try {
        await kernel.permissions.check(
          runId,
          session.routeId,
          policyTool,
          args,
          "control",
          signal,
        );
        signal.throwIfAborted();
        const result = await abortable(
          tool.execute("control", args, signal),
          signal,
        );
        normalized = await normalizeToolResult(
          result,
          kernel.assets,
          session.projectId,
          kernel.config.limits.maxOutputBytes,
          signal,
        );
      } finally {
        release();
      }
      kernel.store.emit(runId, "process.action.completed", {
        action,
        result: normalized,
      });
      kernel.store.status(runId, "completed");
    } catch (error) {
      kernel.store.status(
        runId,
        controller.signal.aborted ? "cancelled" : "failed",
        errorText(error),
      );
    } finally {
      kernel.store.emit(runId, "run.completed", {
        status: kernel.store.run(runId).status,
      });
      lifecycle.finishControl(runId);
    }
  });
  lifecycle.trackControl(runId, { controller, done });
  return { runId, events: `/v1/runs/${runId}/events` };
}
