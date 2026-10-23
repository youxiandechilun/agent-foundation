import type { SchemaValidator } from "./json-schema.js";
import type { ToolEffect } from "../contracts.js";
import {
  AppError,
  abortable,
  errorText,
  hash,
  invariant,
  now,
} from "../core/util.js";
import type { EngineOptions } from "./engine.js";
import type { ToolCall, ToolDefinition, ToolResult } from "./types.js";

interface ToolExecutionContext {
  options: Pick<
    EngineOptions,
    | "store"
    | "runId"
    | "publish"
    | "maxToolCalls"
    | "authorize"
    | "hooks"
    | "normalizeResult"
  >;
  tools: ReadonlyMap<string, ToolDefinition>;
  validators: ReadonlyMap<string, SchemaValidator>;
  signal: AbortSignal;
}

function isToolResult(value: unknown): value is ToolResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("content" in value) ||
    !Array.isArray(value.content)
  )
    return false;
  if (
    "isError" in value &&
    value.isError !== undefined &&
    typeof value.isError !== "boolean"
  )
    return false;
  if (
    "artifacts" in value &&
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      !value.artifacts.every((id: unknown) => typeof id === "string"))
  )
    return false;
  return value.content.every((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part)) return false;
    if (part.type === "text")
      return "text" in part && typeof part.text === "string";
    return (
      part.type === "image" &&
      "data" in part &&
      typeof part.data === "string" &&
      "mimeType" in part &&
      typeof part.mimeType === "string"
    );
  });
}

/** Authorizes, validates and records effects independently of conversation bookkeeping. */
export class ToolExecution {
  private toolCount = 0;
  constructor(private readonly context: ToolExecutionContext) {}

  async execute(
    call: ToolCall,
    effectiveRoute: string,
    retain?: (operation: Promise<unknown>) => void,
  ): Promise<{ result: ToolResult; argsHash: string }> {
    const { options, tools, validators, signal } = this.context;
    const { store, runId, publish } = options;
    let result: ToolResult;
    let createdEffect = false;
    let effect: ToolEffect | undefined;
    const effectId = `${runId}:${call.id}`,
      argsHash = hash(JSON.stringify(call.arguments));
    // Cancellation ends the run's wait, not the actual host operation. Its
    // scheduler lease must survive until the returned promise really settles.
    const wait = <T>(operation: Promise<T>): Promise<T> => {
      retain?.(operation);
      return abortable(operation, signal);
    };
    try {
      invariant(
        ++this.toolCount <= options.maxToolCalls,
        "Tool call budget exhausted",
        429,
      );
      const tool = tools.get(call.name);
      invariant(
        tool,
        `Tool ${call.name} is not allowed for this run`,
        403,
        "tool_denied",
      );
      const validate = validators.get(call.name);
      invariant(validate, `Missing validator for ${call.name}`, 500);
      invariant(
        validate(call.arguments),
        `Invalid arguments for ${call.name}: ${JSON.stringify(validate.errors)}`,
      );
      const authorize = (args: ToolCall["arguments"]) =>
        options.authorize &&
        wait(options.authorize(tool, args, call.id, signal, effectiveRoute));
      const previous = store.find<ToolEffect>("effects", effectId);
      if (previous) {
        await authorize(call.arguments);
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
        invariant(
          isToolResult(previous.result),
          "Stored tool result is invalid",
          502,
        );
        result = previous.result;
      } else {
        effect = store.put("effects", {
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
        if (options.hooks) {
          const decision = await wait(
            options.hooks.preToolUse(call, tool, signal),
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
        await authorize(args);
        signal.throwIfAborted();
        effect = store.put("effects", {
          ...effect!,
          status: "running",
          updatedAt: now(),
        } satisfies ToolEffect);
        publish("tool.started", { toolCallId: call.id, name: call.name });
        result = await wait(
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
        );
        signal.throwIfAborted();
        if (options.normalizeResult)
          result = await wait(options.normalizeResult(result, signal));
        invariant(
          isToolResult(result),
          `Tool ${call.name} returned invalid content`,
          502,
        );
        effect = store.put("effects", {
          ...effect!,
          status: result.isError ? "failed" : "completed",
          result,
          updatedAt: now(),
        } satisfies ToolEffect);
        if (options.hooks && !result.isError)
          result = await wait(
            options.hooks.postToolUse(
              { ...call, arguments: args },
              result,
              signal,
            ),
          );
        invariant(
          isToolResult(result),
          `Tool ${call.name} returned invalid hook content`,
          502,
        );
      }
    } catch (error) {
      result = {
        content: [{ type: "text", text: errorText(error) }],
        isError: true,
      };
      if (
        createdEffect &&
        effect &&
        ["prepared", "running"].includes(effect.status)
      )
        store.write("effects", {
          ...effect,
          status:
            effect.status === "running" && tools.get(call.name)?.risk !== "read"
              ? "unknown"
              : "failed",
          error: errorText(error),
          updatedAt: now(),
        });
    }
    return { result, argsHash };
  }
}
