import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionEngine } from "../src/runtime/engine.js";
import { Store } from "../src/storage/store.js";
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
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: 1,
    usage: emptyUsage(),
  };
}

for (const runs of [1, 2]) {
  test(`provider array mutations stay request-local across ${runs} run(s)`, async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "foundation-tool-isolation-"),
    );
    const store = new Store(directory);
    t.after(async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    const names = ["read_first", "read_second"];
    const observed: string[][] = [];
    const executed: string[] = [];
    const tools: ToolDefinition[] = names.map((name) => ({
      name,
      description: name,
      parameters: { type: "object" },
      risk: "read",
      execute: async () => {
        executed.push(name);
        return { content: [{ type: "text", text: name }] };
      },
    }));
    let requests = 0;
    const engine = new ExecutionEngine({
      runId: "run_tool_isolation",
      routeId: "text",
      instructions: "test",
      history: [],
      tools,
      provider: {
        async complete(request) {
          observed.push(request.tools.map((tool) => tool.name));
          // Adapters may consume the mutable request array while formatting it.
          const declarations = request.tools.splice(0);
          assert.deepEqual(
            declarations.map((tool) => tool.name),
            names,
          );
          const requestIndex = requests++;
          return requestIndex % 2 === 0
            ? reply([
                {
                  type: "toolCall",
                  id: `call_${requestIndex}`,
                  name: declarations[Math.floor(requestIndex / 2)].name,
                  arguments: {},
                },
              ])
            : reply([{ type: "text", text: "done" }]);
        },
      },
      maxSteps: runs * 2,
      maxToolCalls: runs,
      timeoutMs: 5000,
      store,
      publish() {},
      checkpoint(message, id) {
        store.appendTranscript("session_tool_isolation", {
          id,
          runId: "run_tool_isolation",
          message,
        });
      },
      prepare: async (messages) => messages,
    });
    for (let index = 0; index < runs; index++) {
      const outcome = await engine.run({
        role: "user",
        content: `request ${index}`,
        timestamp: index,
      });
      assert.equal(outcome.status, "completed", outcome.error);
      assert.equal(
        store.get<ToolEffect>("effects", `run_tool_isolation:call_${index * 2}`)
          .status,
        "completed",
      );
    }
    assert.deepEqual(
      observed,
      Array.from({ length: runs * 2 }, () => names),
    );
    assert.deepEqual(executed, names.slice(0, runs));
    assert.equal(
      store
        .transcript("session_tool_isolation")
        .filter((entry) => entry.message.role === "toolResult").length,
      runs,
    );
  });
}
