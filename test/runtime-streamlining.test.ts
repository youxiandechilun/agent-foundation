import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicMessages } from "../src/providers/serialize.js";
import { RouteRouter } from "../src/providers/text.js";
import { emptyUsage, type AssistantMessage } from "../src/runtime/types.js";
import type { CostEntry } from "../src/runtime/cost.js";
import { setup } from "./support/wire-server.js";

const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: "test",
  provider: "text",
  stopReason: "stop",
  timestamp: 1,
  usage: emptyUsage(),
});

test("merging consecutive native assistant messages never alters replay state", () => {
  const first = assistant("first");
  first.providerState = {
    protocol: "anthropic-messages",
    routeId: "text",
    items: [{ type: "redacted_thinking", data: "opaque" }],
  };
  Object.freeze(first.providerState.items);
  const messages = [first, assistant("second"), assistant("third")];
  const expected = [
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "second" },
        { type: "text", text: "third" },
      ],
    },
  ];
  assert.deepEqual(anthropicMessages(messages, "text"), expected);
  assert.deepEqual(anthropicMessages(messages, "text"), expected);
  assert.equal(first.providerState.items.length, 1);
  assert.deepEqual(anthropicMessages(messages, "other")[0].content, [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
    { type: "text", text: "third" },
  ]);
});

test("an enabled non-text fallback does not suppress retries of the final text route", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { status: 503, error: { message: "temporary failure" } }
      : { text: "recovered" },
  );
  try {
    x.config.routes.text.retry = {
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 1,
    };
    x.config.routes.image = {
      ...x.config.routes.text,
      kind: "image",
      adapter: "image-json",
    };
    x.config.routes.text.fallbackRouteIds = ["image"];
    const retries: number[] = [];
    const router = new RouteRouter(
      x.config,
      undefined,
      undefined,
      undefined,
      undefined,
      (notice) => retries.push(notice.attempt),
    );
    const result = await router.complete({
      routeId: "text",
      messages: [],
      tools: [],
    });
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(retries, [1]);
    assert.equal(x.wire.requests.length, 2);
  } finally {
    await x.close();
  }
});

test("cost totals retain settled, held, void and unpriced semantics in mixed ledgers", async () => {
  const x = await setup();
  try {
    for (const [index, status] of (
      ["settled", "reserved", "unknown", "void"] as const
    ).entries()) {
      const entry = x.kernel.costs.reserve(
        "text",
        x.config.routes.text,
        { purpose: "aggregate" },
        100 * (index + 1),
      );
      x.kernel.store.put("cost-ledger", {
        ...entry,
        status,
        chargedMicros: index + 10,
      } satisfies CostEntry);
    }
    const summary = x.kernel.costs.summary({ purpose: "aggregate" });
    assert.equal(summary.chargedMicros, 46);
    assert.equal(summary.heldMicros, 500);
    assert.equal(summary.committedMicros, 510);
    assert.equal(summary.committedUsd, 0.00051);
    assert.equal(summary.unpriced, 4);
    assert.equal(summary.entries.length, 4);
    assert.equal(
      x.kernel.costs.summary({ purpose: "absent" }).committedMicros,
      0,
    );
  } finally {
    await x.close();
  }
});

test("hierarchical compaction preserves mixed UTF-8 text and bounds each request", async () => {
  const x = await setup(() => ({ text: "preserved facts" }));
  try {
    x.config.routes.text.contextWindow = 5000;
    x.config.routes.text.maxOutputTokens = 256;
    const session = await x.session();
    x.kernel.store.put("runs", {
      id: "utf8-chunks",
      sessionId: session.id,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const source = "ascii é 中文 😀 \ud800 \udc00 end ".repeat(1600);
    await x.kernel.context.prepare("utf8-chunks", "text", [
      { role: "user", content: source, timestamp: 1 },
      { role: "user", content: "continue", timestamp: 2 },
    ]);
    const chunks: string[] = x.wire.requests.map((request) => {
      const content: unknown = request.body.messages[1].content[0].text;
      assert.equal(typeof content, "string");
      return String(content);
    });
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), "user: " + source);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, "utf8") <= 2 * (5000 - 256 - 1200));
      assert.ok(!chunk.endsWith("\ud83d") && !chunk.startsWith("\ude00"));
    }
  } finally {
    await x.close();
  }
});
