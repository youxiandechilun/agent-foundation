import { hash, now, invariant } from "./util.js";
import { Store } from "../storage/store.js";
import type { Config } from "./config.js";
import { RouteRouter } from "../providers/text.js";
import { contextSummary } from "../prompts/agent.js";
import type { CostLedger } from "../runtime/cost.js";
import { textOf, type Message } from "../runtime/types.js";
import type { ToolDefinition } from "../runtime/types.js";
import {
  TokenCounterRegistry,
  estimateTextTokens,
  estimateTokens,
  estimateTokenBytes,
} from "../runtime/token-counter.js";
export {
  estimateTextTokens,
  estimateTokens,
} from "../runtime/token-counter.js";

// Deliberately conservative heuristic, not a vendor tokenizer. UTF-8 weight avoids undercounting CJK as half a token per character.
function chunks(text: string, tokenBudget: number): string[] {
  const result: string[] = [],
    byteBudget = tokenBudget * 2;
  let start = 0,
    offset = 0,
    bytes = 0;
  while (offset < text.length) {
    const point = text.codePointAt(offset)!,
      width = point > 0xffff ? 2 : 1;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : width === 2 ? 4 : 3;
    if (bytes + size > byteBudget && offset > start) {
      result.push(text.slice(start, offset));
      start = offset;
      bytes = 0;
    }
    bytes += size;
    offset += width;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}
export function atomicGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const m of messages) {
    if (m.role === "toolResult" && groups.at(-1)?.[0].role === "assistant")
      groups.at(-1)!.push(m);
    else groups.push([m]);
  }
  return groups;
}
export class ContextManager {
  readonly counters = new TokenCounterRegistry();
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly costs?: CostLedger,
  ) {}
  async prepare(
    runId: string,
    routeId: string,
    messages: Message[],
    signal?: AbortSignal,
    reservedToolTokens: number | ToolDefinition[] = 0,
    budgetScale = 1,
  ): Promise<Message[]> {
    invariant(
      budgetScale >= 0.2 && budgetScale <= 1,
      "Invalid context budget scale",
    );
    const route = this.config.routes[routeId],
      tools = Array.isArray(reservedToolTokens) ? reservedToolTokens : [],
      counter = route.tokenCounterId
        ? this.counters.get(route.tokenCounterId)
        : undefined;
    invariant(
      !route.tokenCounterId || counter,
      `Token counter ${route.tokenCounterId} is not registered`,
      503,
    );
    const count = async (messages: Message[]) => {
      signal?.throwIfAborted();
      const value = counter
        ? await counter.count({ routeId, route, messages, tools })
        : estimateTokens(messages);
      signal?.throwIfAborted();
      invariant(
        Number.isSafeInteger(value) && value >= 0,
        "Token counter returned an invalid value",
        502,
      );
      return value;
    };
    const toolReserve = counter
      ? 0
      : Math.max(
          1800,
          typeof reservedToolTokens === "number"
            ? reservedToolTokens
            : estimateTextTokens(
                JSON.stringify(
                  tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                ),
              ),
        );
    const budget = Math.floor(
      budgetScale *
        Math.min(
          Math.floor(route.contextWindow * this.config.limits.compactAtRatio),
          route.contextWindow - route.maxOutputTokens - toolReserve,
        ),
    );
    const before = await count(messages);
    const workContext = {
      id: runId,
      runId,
      routeId,
      inputTokens: before,
      budget,
      outputReserve: route.maxOutputTokens,
      toolReserve,
      counter: counter?.id || "utf8-weighted",
      precision: counter?.precision || "estimate",
      compacted: false,
      updatedAt: now(),
    };
    this.store.write("work-contexts", workContext);
    if (before <= budget && budgetScale === 1) return messages;
    invariant(
      budget > 1000,
      "Context budget too small for instructions and tools",
    );
    const firstUser = messages.findIndex(
      (message) => message.role !== "system",
    );
    const head = messages.slice(0, firstUser < 0 ? messages.length : firstUser),
      groups = atomicGroups(messages.slice(head.length));
    let boundary = groups.length;
    // Array brackets and commas contribute to the estimate. Each nonempty group
    // adds its serialized weight minus one bracket; no retained prefix is rescanned.
    let retainedBytes = !counter && head.length ? estimateTokenBytes(head) : 1;
    for (let i = groups.length - 1; i >= 0; i--) {
      signal?.throwIfAborted();
      const retainedGroups = groups.length - boundary;
      if (budgetScale < 1 && retainedGroups >= 2) break;
      let tokens: number;
      if (counter) {
        // Host tokenizers may be non-additive; preserve whole-request counting.
        tokens = retainedGroups
          ? await count([...head, ...groups.slice(i).flat()])
          : 0;
      } else {
        retainedBytes += estimateTokenBytes(groups[i]) - 1;
        tokens = Math.ceil(retainedBytes / 2);
      }
      if (retainedGroups && tokens > budget * 0.5) break;
      boundary = i;
    }
    const omitted = groups.slice(0, boundary).flat(),
      kept = groups.slice(boundary).flat();
    invariant(
      omitted.length > 0,
      "context_limit: latest request/tool group exceeds the model input budget",
    );
    const summaryBudget = budget - (await count([...head, ...kept])) - 350;
    invariant(
      summaryBudget >= 256,
      "context_limit: no room for a continuation summary",
    );
    const digest = hash(JSON.stringify(omitted)),
      cacheId = `${routeId}:${digest}:hierarchical-v2`;
    const cached = this.store.find<{
      id: string;
      summary: string;
      model: string;
    }>("summaries", cacheId);
    const useCached = Boolean(
      cached && estimateTextTokens(cached.summary) <= summaryBudget,
    );
    let summary: string;
    if (useCached) summary = cached!.summary;
    else {
      const compactRoute = this.config.defaultRoutes.compact || routeId,
        compact = this.config.routes[compactRoute];
      const outputBudget = Math.min(
        1800,
        compact.maxOutputTokens,
        Math.floor(summaryBudget / 3),
        Math.floor((compact.contextWindow - 1200) / 4),
      );
      const inputBudget = compact.contextWindow - outputBudget - 1200;
      invariant(
        outputBudget >= 64 && inputBudget >= 256,
        "Compaction route context is too small",
      );
      let calls = 0;
      const summarize = async (source: string, consolidate: boolean) => {
        signal?.throwIfAborted();
        invariant(++calls <= 64, "Context summarization call budget exhausted");
        const session = this.costs
          ? this.store.session(this.store.run(runId).sessionId)
          : undefined;
        const response = await new RouteRouter(
          this.config,
          undefined,
          undefined,
          undefined,
          this.costs
            ? {
                ledger: this.costs,
                scope: {
                  projectId: session!.projectId,
                  sessionId: session!.id,
                  runId,
                  purpose: "compaction",
                },
              }
            : undefined,
        ).complete(
          {
            routeId: compactRoute,
            tools: [],
            maxOutputTokens: outputBudget,
            messages: [
              {
                role: "system",
                timestamp: Date.now(),
                content: contextSummary(consolidate, outputBudget),
              },
              { role: "user", timestamp: Date.now(), content: source },
            ],
          },
          undefined,
          signal,
        );
        invariant(
          response.stopReason === "stop" && textOf(response).trim(),
          "Context summary model failed",
        );
        return textOf(response);
      };
      const source = omitted
        .map(
          (m) =>
            `${m.role}${m.role === "toolResult" ? `(${m.toolName})` : ""}: ${textOf(m)}${
              m.role === "assistant"
                ? "\n" +
                  m.content
                    .filter((p) => p.type === "toolCall")
                    .map((p) => JSON.stringify(p))
                    .join("\n")
                : ""
            }`,
        )
        .join("\n");
      let parts: string[] = [];
      for (const chunk of chunks(source, inputBudget))
        parts.push(await summarize(chunk, false));
      summary = parts.join("\n\n");
      // Every reduction processes every segment. No prefix slicing of the joined summaries.
      for (
        let level = 0;
        estimateTextTokens(summary) > summaryBudget;
        level++
      ) {
        invariant(
          level < 6,
          "context_limit: model summaries did not shrink enough",
        );
        const previousSize = estimateTextTokens(summary);
        parts = [];
        for (const chunk of chunks(summary, inputBudget))
          parts.push(await summarize(chunk, true));
        summary = parts.join("\n\n");
        invariant(
          estimateTextTokens(summary) < previousSize,
          "context_limit: summary model did not reduce content",
        );
      }
      this.store.put("summaries", {
        id: cacheId,
        summary,
        model: compactRoute,
        sourceHash: digest,
        omittedMessages: omitted.length,
        createdAt: now(),
      });
    }
    const prepared: Message[] = [
      ...head,
      {
        role: "user",
        timestamp: Date.now(),
        content: `<continuation_summary source_hash="${digest}">\n${summary}\n</continuation_summary>\nFull original messages remain in session storage; inspect them if needed.`,
      },
      ...kept,
    ];
    const after = await count(prepared);
    invariant(
      after <= budget,
      "context_limit: summary and recent messages exceed context budget",
    );
    this.store.emit(runId, "context.compacted", {
      trigger: budgetScale < 1 ? "provider-context-overflow" : "budget",
      strategy: "model-summary",
      sourceHash: digest,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      omittedMessages: omitted.length,
      retainedOriginal: true,
      cached: useCached,
    });
    this.store.write("work-contexts", {
      ...workContext,
      inputTokens: after,
      compacted: true,
      sourceHash: digest,
      updatedAt: now(),
    });
    return prepared;
  }
}
