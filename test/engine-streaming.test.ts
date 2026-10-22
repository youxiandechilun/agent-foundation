import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionEngine } from "../src/runtime/engine.js";
import { Store } from "../src/storage/store.js";
import { emptyUsage, type Message } from "../src/runtime/types.js";

test("streamed deltas are coalesced in order and commits reuse one serialization", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foundation-stream-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const published: {
    type: string;
    data: Record<string, unknown>;
    durable?: boolean;
    text?: string;
  }[] = [];
  const systems: Message[] = [];
  const checkpoints: { message: Message; text: string }[] = [];
  let step = 0;
  const engine = new ExecutionEngine({
    runId: "run",
    routeId: "text",
    instructions: "test",
    history: [],
    tools: [
      {
        name: "noop",
        description: "noop",
        parameters: { type: "object" },
        risk: "read",
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
    provider: {
      async complete(_request, delta) {
        step++;
        for (const text of ["Hel", "lo", " world"])
          await delta?.({ type: "text", text });
        await delta?.({ type: "thinking", text: "hmm" });
        await delta?.({ type: "text", text: "!" });
        if (step === 1)
          for (const text of ['{"a"', ":1}"])
            await delta?.({ type: "tool-arguments", callId: "call", text });
        return {
          role: "assistant",
          content:
            step === 1
              ? [{ type: "toolCall", id: "call", name: "noop", arguments: {} }]
              : [{ type: "text", text: "Hello world!" }],
          model: "test",
          provider: "text",
          stopReason: step === 1 ? "toolUse" : "stop",
          timestamp: 1,
          usage: emptyUsage(),
        };
      },
    },
    maxSteps: 4,
    maxToolCalls: 4,
    timeoutMs: 5000,
    store,
    publish(type, data, durable, text) {
      published.push({ type, data, durable, text });
    },
    checkpoint(message, _id, text) {
      checkpoints.push({ message, text });
    },
    prepare: async (messages) => {
      systems.push(messages[0]);
      return messages;
    },
  });
  const outcome = await engine.run({
    role: "user",
    content: "hi",
    timestamp: 1,
  });
  assert.equal(outcome.status, "completed", outcome.error);

  const deltas = published
    .filter((event) => event.type.endsWith(".delta"))
    .map((event) => [event.type, event.data.text, event.data.toolCallId]);
  // Consecutive deltas of one kind merge; a different kind flushes first.
  assert.deepEqual(deltas.slice(0, 4), [
    ["assistant.message.delta", "Hello world", undefined],
    ["assistant.reasoning.delta", "hmm", undefined],
    ["assistant.message.delta", "!", undefined],
    ["tool.arguments.delta", '{"a":1}', "call"],
  ]);
  for (const event of published.filter((e) => e.type.endsWith(".delta")))
    assert.equal(event.durable, false);

  // Every checkpoint carries the exact JSON of the committed message.
  for (const { message, text } of checkpoints)
    assert.equal(text, JSON.stringify(message));
  const committed = published.filter(
    (event) => event.type === "assistant.message.committed",
  );
  assert.equal(committed.length, 2);
  for (const event of committed)
    assert.deepEqual(JSON.parse(event.text!), event.data);

  // One system message object for the whole run keeps its token estimate cached.
  assert.equal(systems.length, 2);
  assert.equal(systems[0], systems[1]);
});
