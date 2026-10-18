import { spawn } from "node:child_process";
import { terminateProcessTree } from "../execution/lifecycle.js";
import { abortable, errorText, redactSecrets } from "../core/util.js";
import { textOf } from "./types.js";
import type {
  JsonObject,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UserMessage,
} from "./types.js";

/**
 * Lifecycle hooks. They can only restrict or annotate a run: a hook may block a prompt,
 * deny or rewrite a tool call (which is then re-validated and still authorized normally),
 * annotate results and request continuation at Stop. Hooks never grant permissions.
 */
export interface HookContext {
  runId: string;
  sessionId: string;
  projectId: string;
  projectRoot: string;
  mode: string;
  routeId: string;
}
export interface PromptHookResult {
  /** Reject this input; it is not added to the transcript. */
  block?: string;
  /** Appended to the user message as tagged context. */
  additionalContext?: string;
}
export interface PreToolHookResult {
  deny?: string;
  /** Replacement arguments; re-validated against the tool schema. */
  updatedInput?: JsonObject;
}
export interface PostToolHookResult {
  additionalContext?: string;
}
export interface StopHookResult {
  /** Feedback sent back to the model instead of finishing the run. */
  continue?: string;
}
export interface RunHooks {
  userPromptSubmit?(
    context: HookContext,
    input: { text: string },
    signal: AbortSignal,
  ): Promise<PromptHookResult | void> | PromptHookResult | void;
  preToolUse?(
    context: HookContext,
    call: { id: string; name: string; arguments: JsonObject },
    tool: ToolDefinition,
    signal: AbortSignal,
  ): Promise<PreToolHookResult | void> | PreToolHookResult | void;
  postToolUse?(
    context: HookContext,
    call: { id: string; name: string; arguments: JsonObject },
    result: ToolResult,
    signal: AbortSignal,
  ): Promise<PostToolHookResult | void> | PostToolHookResult | void;
  stop?(
    context: HookContext,
    input: { lastMessage: string; continuations: number },
    signal: AbortSignal,
  ): Promise<StopHookResult | void> | StopHookResult | void;
}
/** Context-bound hooks consumed by the execution engine. */
export interface EngineHooks {
  userPromptSubmit(
    message: UserMessage,
    signal: AbortSignal,
  ): Promise<{ message: UserMessage; block?: string }>;
  preToolUse(
    call: ToolCall,
    tool: ToolDefinition,
    signal: AbortSignal,
  ): Promise<PreToolHookResult>;
  postToolUse(
    call: ToolCall,
    result: ToolResult,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  stop(
    lastMessage: string,
    continuations: number,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
const tagged = (source: string, text: string) =>
  `<hook_context source="${source}">\n${text}\n</hook_context>`;
/**
 * Compose hooks in registration order. A pre-tool hook that throws fails closed (denies);
 * other failing hooks are reported and skipped so observability hooks cannot break a run.
 */
export function bindHooks(
  context: HookContext,
  hooks: RunHooks[],
  onError: (event: string, error: unknown) => void,
): EngineHooks | undefined {
  if (!hooks.length) return undefined;
  const settle = async <T>(
    event: string,
    signal: AbortSignal,
    work: () => Promise<T> | T,
  ): Promise<T | undefined> => {
    signal.throwIfAborted();
    try {
      const result = await abortable(Promise.resolve(work()), signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      onError(event, error);
      return undefined;
    }
  };
  return {
    async userPromptSubmit(message, signal) {
      const context_: string[] = [];
      const text = textOf(message);
      for (const hook of hooks) {
        if (!hook.userPromptSubmit) continue;
        const result = await settle("UserPromptSubmit", signal, () =>
          hook.userPromptSubmit!(context, { text }, signal),
        );
        if (result?.block) return { message, block: result.block };
        if (result?.additionalContext) context_.push(result.additionalContext);
      }
      if (!context_.length) return { message };
      const parts =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      return {
        message: {
          ...message,
          content: [
            ...parts,
            {
              type: "text",
              text: tagged("UserPromptSubmit", context_.join("\n")),
            },
          ],
        },
      };
    },
    async preToolUse(call, tool, signal) {
      let args = call.arguments,
        updated = false;
      for (const hook of hooks) {
        if (!hook.preToolUse) continue;
        signal.throwIfAborted();
        let result: PreToolHookResult | void;
        try {
          result = await abortable(
            Promise.resolve(
              hook.preToolUse(
                context,
                {
                  id: call.id,
                  name: call.name,
                  arguments: structuredClone(args),
                },
                tool,
                signal,
              ),
            ),
            signal,
          );
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          onError("PreToolUse", error);
          return { deny: `PreToolUse hook failed: ${errorText(error)}` };
        }
        if (result?.deny) return { deny: result.deny };
        if (result?.updatedInput) {
          args = result.updatedInput;
          updated = true;
        }
      }
      return updated ? { updatedInput: args } : {};
    },
    async postToolUse(call, result, signal) {
      const notes: string[] = [];
      for (const hook of hooks) {
        if (!hook.postToolUse) continue;
        const output = await settle("PostToolUse", signal, () =>
          hook.postToolUse!(
            context,
            { id: call.id, name: call.name, arguments: call.arguments },
            result,
            signal,
          ),
        );
        if (output?.additionalContext) notes.push(output.additionalContext);
      }
      return notes.length
        ? {
            ...result,
            content: [
              ...result.content,
              { type: "text", text: tagged("PostToolUse", notes.join("\n")) },
            ],
          }
        : result;
    },
    async stop(lastMessage, continuations, signal) {
      for (const hook of hooks) {
        if (!hook.stop) continue;
        const output = await settle("Stop", signal, () =>
          hook.stop!(context, { lastMessage, continuations }, signal),
        );
        if (output?.continue) return output.continue;
      }
      return undefined;
    },
  };
}

export interface CommandHook {
  /** Regular expression matched against the full tool name; "*" or "" matches every tool. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}
export interface CommandHookConfig {
  timeoutMs: number;
  UserPromptSubmit: CommandHook[];
  PreToolUse: CommandHook[];
  PostToolUse: CommandHook[];
  Stop: CommandHook[];
}
interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  json?: Record<string, any>;
}
const MAX_HOOK_OUTPUT = 64 * 1024;
/**
 * Run one host-configured hook command (Claude Code compatible protocol):
 * JSON event on stdin; exit 0 = proceed (stdout may carry a JSON decision);
 * exit 2 = block with stderr as the reason; other exits are non-blocking errors.
 */
export function runHookCommand(
  hook: CommandHook,
  cwd: string,
  input: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(hook.command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENT_PROJECT_DIR: cwd },
    });
    let stdout = "",
      stderr = "",
      done = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        void terminateProcessTree(child);
        return reject(error);
      }
      let json: Record<string, any> | undefined;
      const trimmed = stdout.trim();
      if (code === 0 && trimmed.startsWith("{"))
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = undefined;
        }
      resolve({
        code,
        stdout: redactSecrets(trimmed),
        stderr: redactSecrets(stderr.trim()),
        json,
      });
    };
    const timer = setTimeout(
      () => finish(new Error(`Hook timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const abort = () => finish(new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_HOOK_OUTPUT)
        stdout += chunk.toString("utf8").slice(0, MAX_HOOK_OUTPUT);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_HOOK_OUTPUT)
        stderr += chunk.toString("utf8").slice(0, MAX_HOOK_OUTPUT);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
const matches = (hook: CommandHook, tool: string) => {
  if (!hook.matcher || hook.matcher === "*") return true;
  try {
    return new RegExp(`^(?:${hook.matcher})$`).test(tool);
  } catch {
    return false;
  }
};
const blockReason = (outcome: CommandOutcome, fallback: string) =>
  outcome.stderr || outcome.stdout || fallback;
/** Adapts config-declared shell commands to RunHooks. */
export function commandHooks(config: CommandHookConfig): RunHooks | undefined {
  const any =
    config.UserPromptSubmit.length ||
    config.PreToolUse.length ||
    config.PostToolUse.length ||
    config.Stop.length;
  if (!any) return undefined;
  const base = (context: HookContext, event: string) => ({
    hook_event_name: event,
    run_id: context.runId,
    session_id: context.sessionId,
    project_id: context.projectId,
    cwd: context.projectRoot,
    mode: context.mode,
    route_id: context.routeId,
  });
  const run = async (
    hook: CommandHook,
    context: HookContext,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const outcome = await runHookCommand(
      hook,
      context.projectRoot,
      input,
      hook.timeoutMs ?? config.timeoutMs,
      signal,
    );
    if (outcome.code !== 0 && outcome.code !== 2)
      throw new Error(
        `Hook exited with ${outcome.code}: ${outcome.stderr.slice(0, 2000)}`,
      );
    return outcome;
  };
  return {
    async userPromptSubmit(context, input, signal) {
      const notes: string[] = [];
      for (const hook of config.UserPromptSubmit) {
        const outcome = await run(
          hook,
          context,
          { ...base(context, "UserPromptSubmit"), prompt: input.text },
          signal,
        );
        if (outcome.code === 2)
          return { block: blockReason(outcome, "Blocked by hook") };
        if (outcome.json?.decision === "block")
          return { block: String(outcome.json.reason || "Blocked by hook") };
        const extra = outcome.json
          ? (outcome.json.hookSpecificOutput?.additionalContext ??
            outcome.json.additionalContext)
          : outcome.stdout;
        if (extra) notes.push(String(extra));
      }
      return notes.length ? { additionalContext: notes.join("\n") } : {};
    },
    async preToolUse(context, call, _tool, signal) {
      let args = call.arguments,
        updated = false;
      for (const hook of config.PreToolUse) {
        if (!matches(hook, call.name)) continue;
        const outcome = await run(
          hook,
          context,
          {
            ...base(context, "PreToolUse"),
            tool_name: call.name,
            tool_use_id: call.id,
            tool_input: args,
          },
          signal,
        );
        if (outcome.code === 2)
          return { deny: blockReason(outcome, "Denied by hook") };
        const specific = outcome.json?.hookSpecificOutput || {};
        if (
          specific.permissionDecision === "deny" ||
          outcome.json?.decision === "block"
        )
          return {
            deny: String(
              specific.permissionDecisionReason ||
                outcome.json?.reason ||
                "Denied by hook",
            ),
          };
        const next = specific.updatedInput ?? outcome.json?.updatedInput;
        if (next && typeof next === "object" && !Array.isArray(next)) {
          args = next;
          updated = true;
        }
      }
      return updated ? { updatedInput: args } : {};
    },
    async postToolUse(context, call, result, signal) {
      const notes: string[] = [];
      for (const hook of config.PostToolUse) {
        if (!matches(hook, call.name)) continue;
        const outcome = await run(
          hook,
          context,
          {
            ...base(context, "PostToolUse"),
            tool_name: call.name,
            tool_use_id: call.id,
            tool_input: call.arguments,
            tool_response: {
              content: result.content.filter((p) => p.type === "text"),
              isError: Boolean(result.isError),
            },
          },
          signal,
        );
        const note =
          outcome.code === 2
            ? blockReason(outcome, "")
            : outcome.json?.decision === "block"
              ? outcome.json.reason
              : (outcome.json?.hookSpecificOutput?.additionalContext ??
                outcome.json?.additionalContext);
        if (note) notes.push(String(note));
      }
      return notes.length ? { additionalContext: notes.join("\n") } : {};
    },
    async stop(context, input, signal) {
      for (const hook of config.Stop) {
        const outcome = await run(
          hook,
          context,
          {
            ...base(context, "Stop"),
            last_assistant_message: input.lastMessage,
            stop_hook_active: input.continuations > 0,
          },
          signal,
        );
        if (outcome.code === 2)
          return { continue: blockReason(outcome, "Continue the task") };
        if (outcome.json?.decision === "block")
          return { continue: String(outcome.json.reason || "Continue") };
      }
      return {};
    },
  };
}
