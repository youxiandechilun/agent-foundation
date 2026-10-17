import { type ValidateFunction } from "ajv";
import { compileSchema } from "./json-schema.js";
import {
  id,
  invariant,
  errorText,
  hash,
  now,
  abortable,
  deepFreeze,
  redactJson,
  AppError,
} from "../util.js";
import type { EngineHooks } from "./hooks.js";
import type { ToolEffect, InboxEntry } from "../contracts.js";
import { Store } from "../store.js";
import { normalizedResultDigest } from "./tool-result.js";
import { ToolScheduler } from "./scheduler.js";
import {
  emptyUsage,
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
  private validators = new Map<string, ValidateFunction>();
  private toolCount = 0;
  private repeatedResults = new Map<
    string,
    { digest: string; count: number }
  >();
  private stopReason?: "cancelled" | "timeout";
  steps = 0;
  constructor(readonly options: EngineOptions) {
    const abort = () =>
      this.abort(
        options.signal?.reason?.message === "timeout" ? "timeout" : "cancelled",
      );
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
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
    if (message.role === "user") this.repeatedResults.clear();
    this.history.push(message);
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
    if (message.role === "user") {
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
      let stopContinuations = 0;
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
        const declaredCalls = assistant.content.filter(
          (p) => p.type === "toolCall",
        ).length;
        invariant(
          this.history.length + 1 + declaredCalls <=
            (this.options.maxMessages ?? Infinity),
          "Session budget cannot retain this assistant/tool group",
          413,
        );
        this.commit(assistant, messageId);
        if (
          assistant.stopReason === "error" ||
          assistant.stopReason === "length"
        )
          throw new Error(
            assistant.errorMessage ||
              `Model stopped with ${assistant.stopReason}; incomplete tools were not executed`,
          );
        if (assistant.stopReason === "aborted") {
          this.abort();
          signal.throwIfAborted();
        }
        const calls = assistant.content.filter(
          (c): c is ToolCall => c.type === "toolCall",
        );
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
        if (await this.admitNext(this.steerQueue)) continue;
        if (calls.length) continue;
        if (await this.admitNext(this.followQueue)) continue;
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
    const scheduler = this.options.scheduler || new ToolScheduler(1);
    let index = 0,
      failure: unknown;
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
          failure ||= error;
          if (
            !this.history.some(
              (m) => m.role === "toolResult" && m.toolCallId === call.id,
            )
          )
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
    await Promise.all(
      Array.from(
        { length: Math.min(scheduler.limit + detached, calls.length) },
        worker,
      ),
    );
    if (failure) throw failure;
    this.controller.signal.throwIfAborted();
  }
  private async execute(call: ToolCall, effectiveRoute: string) {
    const { store, runId, publish } = this.options,
      signal = this.controller.signal;
    publish("tool.dispatched", { toolCallId: call.id, name: call.name });
    let result: any;
    let createdEffect = false;
    const effectId = `${runId}:${call.id}`,
      argsHash = hash(JSON.stringify(call.arguments));
    try {
      invariant(
        ++this.toolCount <= this.options.maxToolCalls,
        "Tool call budget exhausted",
        429,
      );
      const tool = this.tools.get(call.name);
      invariant(
        tool,
        `Tool ${call.name} is not allowed for this run`,
        403,
        "tool_denied",
      );
      const validate = this.validators.get(call.name)!;
      invariant(
        validate(call.arguments),
        `Invalid arguments for ${call.name}: ${JSON.stringify(validate.errors)}`,
      );
      const previous = store.find<ToolEffect>("effects", effectId);
      if (previous) {
        await this.options.authorize?.(
          tool,
          call.arguments,
          call.id,
          signal,
          effectiveRoute,
        );
        invariant(
          previous.argsHash === argsHash && previous.tool === call.name,
          "Tool call ID reused with a different tool or arguments",
          409,
        );
        invariant(
          previous.status === "completed",
          "Tool effect outcome unknown or failed; explicit recovery is required",
          409,
        );
        result = previous.result;
      } else {
        store.put("effects", {
          id: effectId,
          runId,
          callId: call.id,
          tool: call.name,
          argsHash,
          status: "prepared",
          createdAt: now(),
          updatedAt: now(),
        } satisfies ToolEffect);
        createdEffect = true;
        publish("tool.requested", {
          toolCallId: call.id,
          name: call.name,
          args: call.arguments,
          risk: tool.risk,
          source: tool.source,
        });
        let args = call.arguments;
        if (this.options.hooks) {
          const decision = await abortable(
            this.options.hooks.preToolUse(call, tool, signal),
            signal,
          );
          if (decision.deny) {
            publish("hook.denied", {
              toolCallId: call.id,
              name: call.name,
              reason: decision.deny,
            });
            throw new AppError(
              403,
              "hook_denied",
              `Denied by PreToolUse hook: ${decision.deny}`,
            );
          }
          if (decision.updatedInput) {
            invariant(
              validate(decision.updatedInput),
              `PreToolUse hook produced invalid arguments for ${call.name}: ${JSON.stringify(validate.errors)}`,
              502,
            );
            // Scheduler locks were taken for the original arguments.
            const resources = tool.scheduling?.resources;
            invariant(
              !resources ||
                JSON.stringify(resources(decision.updatedInput)) ===
                  JSON.stringify(resources(call.arguments)),
              "PreToolUse hook cannot change the resources a tool locks",
              409,
            );
            args = decision.updatedInput;
            publish("tool.input.updated", {
              toolCallId: call.id,
              name: call.name,
              args,
            });
          }
        }
        await this.options.authorize?.(
          tool,
          args,
          call.id,
          signal,
          effectiveRoute,
        );
        signal.throwIfAborted();
        const effect = store.get<ToolEffect>("effects", effectId);
        store.put("effects", {
          ...effect,
          status: "running",
          updatedAt: now(),
        });
        publish("tool.started", { toolCallId: call.id, name: call.name });
        result = await abortable(
          tool.execute(
            call.id,
            args,
            signal,
            (partial) =>
              !signal.aborted &&
              publish(
                "tool.output",
                { toolCallId: call.id, result: partial },
                false,
              ),
            { routeId: effectiveRoute },
          ),
          signal,
        );
        signal.throwIfAborted();
        if (this.options.normalizeResult)
          result = await abortable(
            this.options.normalizeResult(result, signal),
            signal,
          );
        invariant(
          result && Array.isArray(result.content),
          `Tool ${call.name} returned invalid content`,
          502,
        );
        store.put("effects", {
          ...effect,
          status: result.isError ? "failed" : "completed",
          result,
          updatedAt: now(),
        });
        if (this.options.hooks && !result.isError)
          result = await abortable(
            this.options.hooks.postToolUse(
              { ...call, arguments: args },
              result,
              signal,
            ),
            signal,
          );
      }
    } catch (error) {
      result = {
        content: [{ type: "text", text: errorText(error) }],
        isError: true,
      };
      const effect = store.find<ToolEffect>("effects", effectId);
      if (
        createdEffect &&
        effect &&
        ["prepared", "running"].includes(effect.status)
      )
        store.put("effects", {
          ...effect,
          status:
            effect.status === "running" &&
            this.tools.get(call.name)?.risk !== "read"
              ? "unknown"
              : "failed",
          error: errorText(error),
          updatedAt: now(),
        });
    }
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
          result[normalizedResultDigest] ||
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
