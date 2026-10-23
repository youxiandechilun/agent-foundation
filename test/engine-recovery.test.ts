import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.js";
import { ExecutionEngine } from "../src/runtime/engine.js";
import {
  emptyUsage,
  type AssistantMessage,
  type ToolDefinition,
} from "../src/runtime/types.js";
import type { ToolEffect } from "../src/contracts.js";

function reply(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: "test",
    provider: "text",
    stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
    usage: emptyUsage(),
  };
}
async function harness<A>(
  tool: ToolDefinition<A>,
  complete: () => Promise<AssistantMessage>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-effects-"));
  const store = new Store(root),
    events: { type: string; data: any }[] = [];
  const engine = new ExecutionEngine({
    runId: "run_effects",
    routeId: "text",
    instructions: "test",
    history: [],
    tools: [tool],
    provider: { complete },
    maxSteps: 6,
    maxToolCalls: 6,
    timeoutMs: 5000,
    store,
    publish(type, data) {
      events.push({ type, data });
    },
    checkpoint() {},
    prepare: async (m) => m,
  });
  return { root, store, engine, events };
}
test("conflicting duplicate tool IDs preserve the completed audit record and never repeat the file effect", async () => {
  let turn = 0,
    count = 0,
    target = "";
  const x = await harness(
    {
      name: "persist",
      description: "test file effect",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      risk: "write",
      async execute(_id, args: { value: string }) {
        count++;
        await writeFile(target, args.value);
        return { content: [{ type: "text", text: "persisted" }] };
      },
    },
    async () =>
      ++turn <= 2
        ? reply([
            {
              type: "toolCall",
              id: "same",
              name: "persist",
              arguments: { value: turn === 1 ? "original" : "conflict" },
            },
          ])
        : reply([{ type: "text", text: "done" }]),
  );
  try {
    target = path.join(x.root, "actual.txt");
    const result = await x.engine.run({
      role: "user",
      content: "persist",
      timestamp: Date.now(),
    });
    assert.equal(result.status, "completed");
    assert.equal(count, 1);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.equal(
      x.store.get<ToolEffect>("effects", "run_effects:same").status,
      "completed",
    );
    assert.ok(
      x.events.some((e) => e.type === "tool.settled" && e.data.isError),
    );
  } finally {
    x.store.close();
  }
});
test("partial write followed by transport failure stays unknown and both opened model steps settle", async () => {
  let turn = 0,
    target = "";
  const x = await harness(
    {
      name: "partial_write",
      description: "partial file effect",
      parameters: { type: "object" },
      risk: "write",
      async execute() {
        await writeFile(target, "written before lost acknowledgement");
        throw new Error("acknowledgement lost");
      },
    },
    async () => {
      if (++turn === 1)
        return reply([
          {
            type: "toolCall",
            id: "uncertain",
            name: "partial_write",
            arguments: {},
          },
        ]);
      throw new Error("transport failed");
    },
  );
  try {
    target = path.join(x.root, "partial.txt");
    const result = await x.engine.run({
      role: "user",
      content: "write",
      timestamp: Date.now(),
    });
    assert.equal(result.status, "failed");
    assert.match(await readFile(target, "utf8"), /written before/);
    assert.equal(
      x.store.get<ToolEffect>("effects", "run_effects:uncertain").status,
      "unknown",
    );
    assert.equal(
      x.events.filter((e) => e.type === "model-step.started").length,
      2,
    );
    assert.equal(
      x.events.filter((e) => e.type === "model-step.completed").length,
      2,
    );
    assert.equal(x.events.at(-1)?.data.stopReason, "error");
  } finally {
    x.store.close();
  }
});
