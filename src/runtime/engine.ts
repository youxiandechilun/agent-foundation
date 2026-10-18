import { compileSchema, type SchemaValidator } from "./json-schema.js";
import {
  id,
  invariant,
  errorText,
  hash,
  now,
  abortable,
  deepFreeze,
  redactJson,
} from "../core/util.js";
import type { EngineHooks } from "./hooks.js";
import type { ToolEffect, InboxEntry } from "../contracts.js";
import { Store } from "../storage/store.js";
import { normalizedResultDigest } from "./tool-result.js";
import { ToolScheduler } from "./scheduler.js";
import { ToolExecution } from "./tool-execution.js";
import {
  type Message,
  type UserMessage,
  type ToolDefinition,
  type ToolCall,
  type AssistantMessage,
  type TextProvider,
  textOf,
} from "./types.js";

export interface EngineOptions {
  signal?: AbortSignal;
  runId: string;
  routeId: string;
  modelSettings?: Pick<
    import("./types.js").ModelRequest,
    "reasoningEffort" | "reasoningBudgetTokens"
  >;
  instructions: string;
  contextMessages?: Message[];
  history: Message[];
  recoveredInputs?: UserMessage[];
  tools: ToolDefinition[];
  provider: TextProvider;
  maxSteps: number;
  maxToolCalls: number;
  maxMessages?: number;
  maxRepeatedToolResults?: number;
  scheduler?: ToolScheduler;
  normalizeResult?: (
    result: unknown,
    signal: AbortSignal,
  ) => Promise<import("./types.js").ToolResult>;
  timeoutMs: number;
  /** Context-bound lifecycle hooks; they may restrict or annotate, never authorize. */
  hooks?: EngineHooks;
  /** Upper bound on Stop-hook continuations per run (default 3). */
  maxStopContinuations?: number;
  /** Continue a reply cut off by the output limit (no tool calls) up to this many times (default 0). */
  maxOutputContinuations?: number;
  /** Structured output: a successful call to this tool ends the run; finishing without it is retried, then fails. */
  finishTool?: string;
  store: Store;
  publish: (
    type: string,
    data: Record<string, unknown>,
    durable?: boolean,
  ) => void;
  checkpoint: (message: Message, messageId: string) => void;
  prepare: (messages: Message[], signal: AbortSignal) => Promise<Message[]>;
  authorize?: (
    tool: ToolDefinition,
    args: unknown,
    callId: string,
    signal: AbortSignal,
    effectiveRoute: string,
  ) => Promise<void>;
}
/** Model steps are sequential; explicitly independent tools may execute concurrently. */
export class ExecutionEngine {
  readonly controller = new AbortController();
  readonly history: Message[];
  readonly tools: Map<string, ToolDefinition>;
  isRunning = false;
  private steerQueue: UserMessage[] = [];
  private followQueue: UserMessage[] = [];
  private validators = new Map<string, SchemaValidator>();
  private toolExecution: ToolExecution;
  private batchResults = new Map<string, boolean>();
  private repeatedResults = new Map<
    string,
    { digest: string; count: number }
  >();
  private stopReason?: "cancelled" | "timeout";
  private readonly onParentAbort = () => {
    const reason: unknown = this.options.signal?.reason;
    this.abort(
      reason &&
        typeof reason === "object" &&
        "message" in reason &&
        reason.message === "timeout"
        ? "timeout"
        : "cancelled",
    );
  };
  steps = 0;
  constructor(readonly options: EngineOptions) {
    this.history = options.history.slice();
    this.tools = new Map();
    for (const tool of options.tools) {
      invariant(
        /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) && !this.tools.has(tool.name),
        `Invalid or duplicate tool ${tool.name}`,
      );
      const snapshot = deepFreeze({
        ...tool,
        parameters: structuredClone(tool.parameters),
        capabilities: [...(tool.capabilities || [])],
        source: tool.source ? { ...tool.source } : undefined,
        risk: tool.risk || "execute",
      });
      this.tools.set(tool.name, snapshot);
      this.validators.set(tool.name, compileSchema(snapshot.parameters));
    }
    this.toolExecution = new ToolExecution({
      options,
      tools: this.tools,
      validators: this.validators,
      signal: this.controller.signal,
    });
    this.listenForAbort();
  }
  private listenForAbort(): void {
    if (this.options.signal?.aborted) this.onParentAbort();
    else
      this.options.signal?.addEventListener("abort", this.onParentAbort, {
        once: true,
      });
  }
  enqueue(message: UserMessage, delivery: "steer" | "enqueue") {
    invariant(
      this.isRunning && !this.controller.signal.aborted,
      "Run is not accepting inputs",
      409,
    );
    (delivery === "steer" ? this.steerQueue : this.followQueue).push(message);
  }
  abort(reason: "cancelled" | "timeout" = "cancelled") {
    if (this.controller.signal.aborted) return;
    this.stopReason = reason;
    this.controller.abort(new Error(reason));
  }
  private commit(message: Message, messageId = id("message")) {
    invariant(
      this.history.length < (this.options.maxMessages ?? Infinity),
      "Session message budget exhausted",
      413,
    );
    message = redactJson(message);
    this.options.store.transaction(() => {
      this.options.checkpoint(message, messageId);
      if (message.role === "user") {
        if (message.inputId) {
          const inbox = this.options.store.find<InboxEntry>(
            "inbox",
            message.inputId,
          );
          if (inbox)
            this.options.store.put("inbox", { ...inbox, status: "applied" });
        }
      }
    });
    this.history.push(message);
    if (message.role === "toolResult")
      this.batchResults.set(message.toolCallId, !message.isError);
    if (message.role === "user") {
      this.repeatedResults.clear();
      this.options.publish("input.applied", {
        messageId,
        inputId: message.inputId,
      });
    } else if (message.role === "assistant")
      this.options.publish("assistant.message.committed", {
        messageId,
        message,
        step: this.steps,
      });
  }
  async run(input: UserMessage): Promise<{
    status: "completed" | "failed" | "cancelled";
    error?: string;
    steps: number;
  }> {
    invariant(!this.isRunning, "Engine already running", 409);
    this.listenForAbort();
    this.isRunning = true;
    const signal = this.controller.signal,
      timer = setTimeout(() => this.abort("timeout"), this.options.timeoutMs);
    let stepOpen = false;
    try {
      for (const recovered of this.options.recoveredInputs || [])
        await this.admit(recovered);
      if (!(await this.admit(input)))
        return {
          status: "failed",
          error: `Input blocked by UserPromptSubmit hook: ${this.lastRejection}`,
          steps: this.steps,
        };
      let stopContinuations = 0,
        outputContinuations = 0,
        finishReminders = 0;
      while (this.steps < this.options.maxSteps) {
        signal.throwIfAborted();
        invariant(
          this.history.length < (this.options.maxMessages ?? Infinity),
          "Session message budget exhausted; no further model call was made",
          413,
        );
        this.steps++;
        stepOpen = true;
        this.options.publish("model-step.started", {
          step: this.steps,
          routeId: this.options.routeId,
        });
        const context = await abortable(
          this.options.prepare(
            [
              {
                role: "system",
                content: this.options.instructions,
                timestamp: Date.now(),
              },
              ...(this.options.contextMessages || []),
              ...this.history,
            ],
            signal,
          ),
          signal,
        );
        const messageId = id("message");
        this.options.publish("assistant.message.started", {
          messageId,
          step: this.steps,
        });
        let assistant: AssistantMessage;
        try {
          assistant = await abortable(
            this.options.provider.complete(
              {
                routeId: this.options.routeId,
                ...this.options.modelSettings,
                messages: context,
                tools: [...this.tools.values()],
              },
              async (event) => {
                this.options.publish(
                  event.type === "text"
                    ? "assistant.message.delta"
                    : event.type === "thinking"
                      ? "assistant.reasoning.delta"
                      : "tool.arguments.delta",
                  {
                    messageId,
                    ...(event.type === "tool-arguments"
                      ? { toolCallId: event.callId }
                      : {}),
                    text: event.text,
                  },
                  false,
                );
              },
              signal,
            ),
            signal,
          );
        } catch (error) {
          const partial = (error as { partial?: AssistantMessage }).partial;
          if (partial) this.commit(partial, messageId);
          throw error;
        }
        const calls = assistant.content.filter(
          (part): part is ToolCall => part.type === "toolCall",
        );
        invariant(
          this.history.length + 1 + calls.length <=
            (this.options.maxMessages ?? Infinity),
          "Session budget cannot retain this assistant/tool group",
          413,
        );
        this.commit(assistant, messageId);
        // A plain-text reply cut off by the output limit can safely continue; truncated tool calls cannot.
        const truncated =
          assistant.stopReason === "length" &&
          calls.length === 0 &&
          outputContinuations < (this.options.maxOutputContinuations ?? 0);
        if (
          assistant.stopReason === "error" ||
          (assistant.stopReason === "length" && !truncated)
        )
          throw new Error(
            assistant.errorMessage ||
              `Model stopped with ${assistant.stopReason}; incomplete tools were not executed`,
          );
        if (assistant.stopReason === "aborted") {
          this.abort();
          signal.throwIfAborted();
        }
        // Validate the whole batch before executing any effect from it.
        const callIds = new Set<string>();
        for (const call of calls) {
          invariant(
            !callIds.has(call.id),
            "Duplicate call ID in model response",
            502,
          );
          callIds.add(call.id);
        }
        await this.executeBatch(calls, assistant.provider);
        this.options.publish("model-step.completed", {
          step: this.steps,
          stopReason: assistant.stopReason,
          usage: assistant.usage,
        });
        stepOpen = false;
        const finish = this.options.finishTool;
        if (
          finish &&
          calls.some(
            (c) => c.name === finish && this.batchResults.get(c.id) === true,
          )
        )
          return { status: "completed", steps: this.steps };
        if (await this.admitNext(this.steerQueue)) continue;
        if (calls.length) continue;
        if (truncated) {
          outputContinuations++;
          this.options.publish("model.continued", {
            reason: "length",
            continuation: outputContinuations,
          });
          this.commit({
            role: "user",
            content:
              "<system_notice>Your previous reply hit the output token limit and was cut off. Continue exactly where it stopped, without repeating what was already written.</system_notice>",
            timestamp: Date.now(),
          });
          continue;
        }
        if (await this.admitNext(this.followQueue)) continue;
        if (finish) {
          invariant(
            finishReminders < 2,
            `Run ended without calling ${finish}; no structured output was produced`,
            422,
          );
          finishReminders++;
          this.options.publish("output.reminder", { attempt: finishReminders });
          this.commit({
            role: "user",
            content: `<system_notice>This task requires a structured result. Call ${finish} now with arguments that match its schema.</system_notice>`,
            timestamp: Date.now(),
          });
          continue;
        }
        const hooks = this.options.hooks;
        if (
          hooks &&
          stopContinuations < (this.options.maxStopContinuations ?? 3)
        ) {
          const feedback = await abortable(
            hooks.stop(textOf(assistant), stopContinuations, signal),
            signal,
          );
          if (feedback) {
            stopContinuations++;
            this.options.publish("hook.continued", {
              event: "Stop",
              continuation: stopContinuations,
              reason: feedback,
            });
            this.commit({
              role: "user",
              content: `<hook_feedback source="Stop">
${feedback}
</hook_feedback>`,
              timestamp: Date.now(),
            });
            continue;
          }
        }
        return { status: "completed", steps: this.steps };
      }
      throw new Error(
        `Step limit reached (${this.options.maxSteps}) before task completion`,
      );
    } catch (error) {
      if (stepOpen)
        this.options.publish("model-step.completed", {
          step: this.steps,
          stopReason: signal.aborted ? "aborted" : "error",
          error: errorText(error),
        });
      return {
        status: this.stopReason === "cancelled" ? "cancelled" : "failed",
        error:
          this.stopReason === "timeout"
            ? "Run time limit reached"
            : errorText(error),
        steps: this.steps,
      };
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener("abort", this.onParentAbort);
      this.isRunning = false;
    }
  }
  private lastRejection = "";
  /** Run UserPromptSubmit hooks, then commit; a blocked input is marked rejected, never applied. */
  private async admit(message: UserMessage) {
    const hooks = this.options.hooks,
      signal = this.controller.signal;
    if (hooks) {
      const outcome = await abortable(
        hooks.userPromptSubmit(message, signal),
        signal,
      );
      if (outcome.block) {
        this.lastRejection = outcome.block;
        if (message.inputId) {
          const inbox = this.options.store.find<InboxEntry>(
            "inbox",
            message.inputId,
          );
          if (inbox)
            this.options.store.put("inbox", { ...inbox, status: "rejected" });
        }
        this.options.publish("input.rejected", {
          inputId: message.inputId,
          reason: outcome.block,
        });
        return false;
      }
      message = outcome.message;
    }
    this.commit(message);
    return true;
  }
  private async admitNext(queue: UserMessage[]) {
    while (queue.length) if (await this.admit(queue.shift()!)) return true;
    return false;
  }
  private async executeBatch(calls: ToolCall[], route: string) {
    this.batchResults.clear();
    const scheduler = this.options.scheduler || new ToolScheduler(1);
    let index = 0,
      failure: { error: unknown } | undefined;
    const worker = async () => {
      while (index < calls.length) {
        const call = calls[index++];
        if (failure || this.controller.signal.aborted) {
          this.skip(call, "Skipped because this tool batch was interrupted");
          continue;
        }
        let release: (() => void) | undefined;
        try {
          const tool = this.tools.get(call.name);
          release = tool?.scheduling?.detached
            ? undefined
            : await scheduler.acquire(
                tool,
                call.arguments,
                this.controller.signal,
              );
          if (this.steerQueue.length) {
            this.skip(call);
            continue;
          }
          if (failure || this.controller.signal.aborted) {
            this.skip(call, "Skipped because this tool batch was interrupted");
            continue;
          }
          await this.execute(call, route);
        } catch (error) {
          failure ??= { error };
          if (!this.batchResults.has(call.id))
            this.skip(
              call,
              "Skipped because tool scheduling or execution was interrupted",
            );
        } finally {
          release?.();
        }
      }
    };
    // Detached calls hold no slot, so each gets its own worker on top of the slot bound.
    const detached = calls.filter(
      (c) => this.tools.get(c.name)?.scheduling?.detached,
    ).length;
    const workers = await Promise.allSettled(
      Array.from(
        { length: Math.min(scheduler.limit + detached, calls.length) },
        worker,
      ),
    );
    if (failure) throw failure.error;
    for (const worker of workers)
      if (worker.status === "rejected") throw worker.reason;
    this.controller.signal.throwIfAborted();
  }
  private async execute(call: ToolCall, effectiveRoute: string) {
    this.options.publish("tool.dispatched", {
      toolCallId: call.id,
      name: call.name,
    });
    const { result, argsHash } = await this.toolExecution.execute(
      call,
      effectiveRoute,
    );
    const publish = this.options.publish,
      signal = this.controller.signal;
    this.commit({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      details: result.details,
      isError: Boolean(result.isError),
      timestamp: Date.now(),
    });
    publish("tool.settled", {
      toolCallId: call.id,
      name: call.name,
      result,
      isError: Boolean(result.isError),
    });
    const repeatLimit = this.options.maxRepeatedToolResults || 0;
    if (repeatLimit) {
      const key = `${call.name}:${argsHash}`,
        digest: string =
          (normalizedResultDigest in result &&
          typeof result[normalizedResultDigest] === "string"
            ? result[normalizedResultDigest]
            : undefined) ||
          hash(
            JSON.stringify({
              content: result.content,
              details: result.details,
              isError: result.isError,
            }),
          );
      const previous = this.repeatedResults.get(key),
        count = previous?.digest === digest ? previous.count + 1 : 1;
      this.repeatedResults.set(key, { digest, count });
      if (count >= repeatLimit) {
        publish("tool.loop_detected", {
          tool: call.name,
          repetitions: count,
          argsHash,
        });
        throw new Error(
          `Tool loop stopped after ${count} identical results without new user input`,
        );
      }
    }
    signal.throwIfAborted();
  }
  private skip(
    call: ToolCall,
    reason = "Skipped before execution because newer user steering arrived",
  ) {
    const result = {
      content: [{ type: "text" as const, text: reason }],
      isError: true,
    };
    const effectId = `${this.options.runId}:${call.id}`;
    if (!this.options.store.find("effects", effectId))
      this.options.store.put("effects", {
        id: effectId,
        runId: this.options.runId,
        callId: call.id,
        tool: call.name,
        argsHash: hash(JSON.stringify(call.arguments)),
        status: "skipped",
        result,
        error: reason,
        createdAt: now(),
        updatedAt: now(),
      } satisfies ToolEffect);
    this.commit({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: true,
      timestamp: Date.now(),
    });
    this.options.publish("tool.skipped", {
      toolCallId: call.id,
      name: call.name,
      reason,
    });
    this.options.publish("tool.settled", {
      toolCallId: call.id,
      name: call.name,
      result,
      isError: true,
    });
  }
}
