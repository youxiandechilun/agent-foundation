import { invariant, errorText, delay } from "../../../core/util.js";
import {
  MCPProtocolError,
  wireMember,
  wireObject,
  type MCPRequestContext,
  type MCPRequestOptions,
  type MCPToolResult,
  type WireObject,
} from "../protocol.js";
import {
  taskTerminal,
  taskFingerprint,
  type ModernMCPTasks,
  type ModernTask,
} from "../tasks/modern.js";

interface ModernTaskHost {
  tasks: ModernMCPTasks;
  signal: AbortSignal;
  maxInputRounds?: number;
  get: (
    taskId: string,
    signal: AbortSignal,
    timeout: number,
  ) => Promise<ModernTask>;
  update: (
    taskId: string,
    responses: WireObject,
    signal: AbortSignal,
    timeout: number,
  ) => Promise<unknown>;
  cancel: (
    taskId: string,
    signal: AbortSignal | undefined,
    timeout: number,
  ) => Promise<unknown>;
  handleInput: (
    method: string,
    params: unknown,
    context: MCPRequestContext,
  ) => Promise<unknown>;
  validateResult: (name: string, value: unknown) => MCPToolResult;
}
export function modernTaskResult(
  task: ModernTask,
): NonNullable<ModernTask["result"]> {
  if (task.status === "failed")
    throw new MCPProtocolError(
      task.error?.message ?? "Remote modern task failed",
      task.error?.code,
      task.error?.data,
    );
  if (task.status === "cancelled")
    throw new MCPProtocolError("Remote modern task was cancelled", "cancelled");
  invariant(
    task.status === "completed" && task.result,
    "Modern task is not completed",
    409,
  );
  return task.result;
}
export async function waitModernTask(
  taskId: string,
  host: ModernTaskHost,
  options?: MCPRequestOptions,
) {
  const entry = host.tasks.get(taskId);
  invariant(entry, "Modern task origin is missing", 403);
  const deadline = () =>
    entry.task.ttlMs === null
      ? entry.deadline
      : Math.min(
          entry.deadline,
          Date.parse(entry.task.createdAt) + entry.task.ttlMs,
        );
  const remaining = () => {
    const time = deadline();
    invariant(time > Date.now(), "Modern task deadline or TTL exceeded", 504);
    return Math.max(1, time - Date.now());
  };
  try {
    main: while (true) {
      const signal = AbortSignal.any([
        host.signal,
        entry.controller.signal,
        AbortSignal.timeout(remaining()),
        ...(options?.signal ? [options.signal] : []),
      ]);
      signal.throwIfAborted();
      const task = await host.get(taskId, signal, remaining());
      if (taskTerminal(task.status)) {
        const result = modernTaskResult(task);
        try {
          return host.validateResult(String(entry.context.params.name), result);
        } catch (error) {
          host.tasks.unknown(taskId, errorText(error));
          throw error;
        }
      }
      if (task.status === "input_required") {
        const responses: Record<string, unknown> = Object.create(null),
          inputController = new AbortController();
        entry.inputController = inputController;
        try {
          for (const [key, request] of Object.entries(task.inputRequests!)) {
            const method = wireMember(request, "method"),
              params = wireObject(wireMember(request, "params"));
            invariant(
              key.length > 0 &&
                key.length <= 512 &&
                typeof method === "string" &&
                params,
              "Invalid modern task input request",
              502,
            );
            invariant(
              params.task === undefined,
              "Modern extension does not support task-augmented client input",
              502,
            );
            const fingerprint = taskFingerprint(request),
              known = entry.inputs.get(key);
            if (known) {
              invariant(
                known.fingerprint === fingerprint,
                "Modern task reused an input key with different content",
                502,
              );
              continue;
            }
            if (!Object.keys(responses).length)
              invariant(
                entry.rounds < (host.maxInputRounds || 8),
                "Modern task input round limit exceeded",
                502,
              );
            invariant(
              entry.inputs.size < 128,
              "Modern task input capacity exceeded",
              429,
            );
            entry.inputs.set(key, { fingerprint, answered: false });
            const value = await host.handleInput(method, params, {
              ...entry.context,
              requestId: key,
              signal: AbortSignal.any([signal, inputController.signal]),
            });
            signal.throwIfAborted();
            inputController.signal.throwIfAborted();
            responses[key] = value;
          }
        } catch (e) {
          if (
            taskTerminal(entry.task.status) &&
            !entry.controller.signal.aborted &&
            !host.signal.aborted
          )
            continue main;
          throw e;
        } finally {
          entry.inputController = undefined;
        }
        if (Object.keys(responses).length) {
          entry.rounds++;
          await host.update(taskId, responses, signal, remaining());
          for (const key of Object.keys(responses))
            entry.inputs.get(key)!.answered = true;
        }
      }
      await delay(Math.min(task.pollIntervalMs ?? 100, remaining()), signal);
    }
  } catch (e) {
    const expired = Date.now() >= deadline();
    const failure =
      expired && !options?.signal?.aborted
        ? new MCPProtocolError(
            "Modern task deadline or TTL exceeded",
            "timeout",
          )
        : e;
    if (!entry.finalValidated) {
      const cancel =
        expired ||
        options?.signal?.aborted ||
        entry.controller.signal.aborted ||
        /deadline|TTL|timed out/i.test(errorText(e));
      host.tasks.unknown(taskId, errorText(failure));
      if (cancel)
        await host.cancel(taskId, undefined, 1500).catch(() => undefined);
    }
    throw failure;
  } finally {
    host.tasks.release(taskId);
  }
}
