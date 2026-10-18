import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/wire-server.js";
import { atomicGroups } from "../src/core/context.js";
import { hash } from "../src/core/util.js";
import { estimateTokens } from "../src/runtime/token-counter.js";
import type { Message } from "../src/runtime/types.js";

function referenceSelection(
  messages: Message[],
  budget: number,
  scale: number,
  count = estimateTokens,
) {
  const first = messages.findIndex((message) => message.role !== "system");
  const head = messages.slice(0, first < 0 ? messages.length : first);
  const groups = atomicGroups(messages.slice(head.length));
  const kept: Message[][] = [];
  let boundary = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (scale < 1 && kept.length >= 2) break;
    if (
      kept.length &&
      count([...head, ...groups[i], ...kept.flat()]) > budget * 0.5
    )
      break;
    kept.unshift(groups[i]);
    boundary = i;
  }
  return { head, kept: kept.flat(), omitted: groups.slice(0, boundary).flat() };
}

test("context selection preserves exact byte rounding, tool groups and non-additive host counters", async () => {
  const x = await setup(() => ({ text: "preserved summary" }));
  try {
    const route = x.config.routes.text;
    route.contextWindow = 12000;
    route.maxOutputTokens = 2000;
    const session = await x.session();
    for (const custom of [false, true]) {
      const count = custom
        ? (messages: Message[]) =>
            estimateTokens(messages) + messages.length ** 2
        : estimateTokens;
      let preparedCounts = 0;
      route.tokenCounterId = custom ? "non-additive" : undefined;
      const unregister = custom
        ? x.kernel.context.counters.register({
            id: "non-additive",
            precision: "exact",
            count: ({ messages }) => {
              if (
                messages.some(
                  (message) =>
                    typeof message.content === "string" &&
                    message.content.startsWith("<continuation_summary"),
                )
              )
                preparedCounts++;
              return count(messages);
            },
          })
        : undefined;
      try {
        for (const scale of [1, 0.8])
          for (const system of [false, true]) {
            const runId = `context-${custom}-${scale}-${system}`;
            const time = new Date().toISOString();
            x.kernel.store.put("runs", {
              id: runId,
              sessionId: session.id,
              status: "running",
              createdAt: time,
              updatedAt: time,
            });
            const messages: Message[] = system
              ? [
                  {
                    role: "system",
                    content: "system instructions",
                    timestamp: 0,
                  },
                ]
              : [];
            for (let i = 0; i < 80; i++)
              messages.push({
                role: "user",
                content: (i % 2 ? "中文😀" : "ascii").repeat(90) + i,
                timestamp: i,
              });
            messages.push(
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "last-tool",
                    name: "read",
                    arguments: {},
                  },
                ],
                timestamp: 90,
                model: "m",
                provider: "p",
                stopReason: "toolUse",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                },
              },
              {
                role: "toolResult",
                toolCallId: "last-tool",
                toolName: "read",
                content: [{ type: "text", text: "result" }],
                isError: false,
                timestamp: 91,
              },
              { role: "user", content: "current request", timestamp: 92 },
            );
            const budget = Math.floor(
              scale *
                Math.min(
                  Math.floor(
                    route.contextWindow * x.config.limits.compactAtRatio,
                  ),
                  route.contextWindow -
                    route.maxOutputTokens -
                    (custom ? 0 : 1800),
                ),
            );
            const expected = referenceSelection(messages, budget, scale, count);
            const digest = hash(JSON.stringify(expected.omitted));
            x.kernel.store.put("summaries", {
              id: `text:${digest}:hierarchical-v2`,
              summary: "preserved summary",
              model: "text",
            });
            const beforeCount = preparedCounts;
            const result = await x.kernel.context.prepare(
              runId,
              "text",
              messages,
              undefined,
              [],
              scale,
            );
            assert.deepEqual(
              result.slice(expected.head.length + 1),
              expected.kept,
            );
            assert.match(JSON.stringify(result), new RegExp(digest));
            if (custom) assert.equal(preparedCounts - beforeCount, 1);
            const saved = x.kernel.store.get<{
              id: string;
              inputTokens: number;
            }>("work-contexts", runId);
            assert.equal(saved.inputTokens, count(result));
          }
      } finally {
        unregister?.();
      }
    }
    assert.equal(
      x.wire.requests.length,
      0,
      "matching summary cache must avoid a provider request",
    );
  } finally {
    await x.close();
  }
});

test("token estimator preserves image cost and one global rounding across message groups", () => {
  const messages: Message[] = [
    { role: "user", content: "odd", timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "image", mimeType: "image/png", data: "a".repeat(1000) },
        { type: "text", text: "中文😀" },
      ],
      timestamp: 2,
    },
  ];
  const serialized = JSON.stringify(messages, (_key, value: unknown) =>
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "image"
      ? { type: "image" }
      : value,
  );
  assert.equal(
    estimateTokens(messages),
    Math.ceil(Buffer.byteLength(serialized) / 2) + 4096,
  );
  assert.equal(estimateTokens([]), 1);
});
