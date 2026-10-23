import type { Kernel } from "../kernel.js";
import type {
  AgentDefinition,
  Session,
  StoredMessage,
} from "../../contracts.js";
import type { Store } from "../../storage/store.js";
import type { WorkMode } from "../../modes/index.js";
import {
  textOf,
  type Message,
  type ToolDefinition,
  type UserMessage,
} from "../../runtime/types.js";
import { makeTools } from "../../tools/index.js";
import { structuredOutputTool } from "../../runtime/structured-output.js";
import { retrievedMemory } from "../../prompts/agent.js";
import { errorText, invariant } from "../util.js";
import { repairHistory } from "./history.js";

export interface RunScope {
  kernel: Kernel;
  runId: string;
  session: Session;
  definition?: AgentDefinition;
  signal: AbortSignal;
}

/** Load the transcript, persisting repairs for tool calls a stopped host left unanswered. */
export function loadRunHistory(
  store: Store,
  sessionId: string,
  maxMessages: number,
  options: { routeId?: string; maxBytes?: number } = {},
): StoredMessage[] {
  invariant(
    store.transcriptCount(sessionId) < maxMessages,
    "Session message limit reached; fork or export it first",
    413,
  );
  const checkpoint = options.routeId
    ? store.historyCheckpoint(sessionId, options.routeId)
    : undefined;
  const original = store.transcriptWindow(
    sessionId,
    checkpoint?.throughSeq,
    options.maxBytes,
  );
  let stored = repairHistory(original);
  if (
    stored.length !== original.length ||
    stored.some((m, i) => m.id !== original[i]?.id)
  ) {
    store.saveTranscript(sessionId, stored, checkpoint?.throughSeq);
    stored = store.transcriptWindow(
      sessionId,
      checkpoint?.throughSeq,
      options.maxBytes,
    );
  }
  invariant(
    store.transcriptCount(sessionId) < maxMessages,
    "Session message limit reached; fork or export it first",
    413,
  );
  return checkpoint
    ? [
        {
          id: "context-summary",
          runId: "context-summary",
          message: checkpoint.summary,
        },
        ...stored,
      ]
    : stored;
}

/** Tools this run may offer: mode and agent filters, plus the structured-result tool. */
export async function runTools(
  { kernel, runId, session, definition, signal }: RunScope,
  mode: WorkMode,
  outputSchema: unknown,
): Promise<ToolDefinition[]> {
  const tools = (
    await makeTools({
      kernel,
      runId,
      session,
      routeId: session.routeId,
      signal,
    })
  ).filter(
    (t) =>
      mode.accepts(t) &&
      (!definition ||
        definition.toolAllowlist.includes("*") ||
        definition.toolAllowlist.includes(t.name)),
  );
  if (outputSchema)
    tools.push(
      structuredOutputTool(outputSchema, (output) => {
        kernel.store.write("runs", { ...kernel.store.run(runId), output });
        kernel.store.emit(runId, "run.output", { output });
      }),
    );
  return tools;
}

/** Whether the session may read memory through any tool this run offers. */
export function readsMemory(
  kernel: Kernel,
  session: Session,
  tools: readonly ToolDefinition[],
): boolean {
  return tools.some(
    (t) =>
      t.capabilities?.includes("memory.read") &&
      kernel.permissions.evaluate(session, session.routeId, t).effect ===
        "allow",
  );
}

/** Retrieved memory as context messages, trimmed to a share of the route's context window. */
export async function memoryContext(
  { kernel, runId, session, definition, signal }: RunScope,
  message: UserMessage,
  tools: readonly ToolDefinition[],
): Promise<Message[]> {
  const { config } = kernel;
  if (
    !config.memory.enabled ||
    config.memory.maxEntriesInPrompt <= 0 ||
    !readsMemory(kernel, session, tools)
  )
    return [];
  const memories = await kernel.memory.retrieve(
    session.projectId,
    textOf(message),
    config.memory.maxEntriesInPrompt,
    definition?.memoryNamespace,
    signal,
    (error) =>
      kernel.store.emit(runId, "memory.retrieval.degraded", {
        strategy: "lexical",
        error: errorText(error),
      }),
  );
  if (!memories.length) return [];
  const budget = Math.floor(
    Math.min(24000, config.routes[session.routeId].contextWindow * 0.2) /
      memories.length,
  );
  const entries = memories.map((memory) => {
    const bytes = Buffer.from(memory.content);
    return {
      id: memory.id,
      content: bytes.subarray(0, budget).toString("utf8").replace(/�$/u, ""),
      truncated: bytes.length > budget,
      readFullWith: "memory_read",
    };
  });
  return [
    {
      role: "system",
      timestamp: Date.now(),
      requiredCapabilities: ["memory.read"],
      content: retrievedMemory(entries),
    },
  ];
}

/** Probe used to ask whether automatic memory proposals are permitted for a session. */
export const memoryWriteProbe: ToolDefinition = {
  name: "memory_save",
  description: "Propose explicit memory",
  parameters: {},
  risk: "write",
  capabilities: ["memory.write"],
  execute: async () => ({ content: [] }),
};
