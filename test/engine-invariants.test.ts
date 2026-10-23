import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Store } from "../src/storage/store.js";
import { ExecutionEngine, type EngineOptions } from "../src/runtime/engine.js";
import { ToolScheduler } from "../src/runtime/scheduler.js";
import { hash, now } from "../src/core/util.js";
import {
  emptyUsage,
  type AssistantMessage,
  type Message,
  type ToolDefinition,
} from "../src/runtime/types.js";
import type { InboxEntry, ToolEffect } from "../src/contracts.js";

const input = { role: "user" as const, content: "continue", timestamp: 1 };
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
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
function tool(
  name: string,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object" },
    risk: "read",
    scheduling: { parallelSafe: true },
    execute,
  };
}
async function harness(
  t: TestContext,
  overrides: Partial<Omit<EngineOptions, "store">> = {},
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "foundation-runtime-invariants-"),
  );
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const engine = new ExecutionEngine({
    runId: "run_invariants",
    routeId: "text",
    instructions: "test",
    history: [],
    tools: [],
    provider: { complete: async () => reply([{ type: "text", text: "done" }]) },
    maxSteps: 6,
    maxToolCalls: 8,
    timeoutMs: 5000,
    store,
    checkpoint(message, id) {
      store.appendTranscript("session_invariants", {
        id,
        runId: "run_invariants",
        message,
      });
    },
    prepare: async (messages) => messages,
    publish(type, data) {
      events.push({ type, data });
    },
    ...overrides,
  });
  return { engine, store, events };
}

test("compaction retains one copy of context across tool turns and keeps durable message limits", async (t) => {
  const history: Message[] = Array.from({ length: 8 }, (_, timestamp) => ({
    role: "user",
    content: `old-${timestamp}`,
    timestamp,
  }));
  let prepares = 0,
    calls = 0;
  const x = await harness(t, {
    history,
    compactHistory: true,
    maxMessages: 12,
    contextMessages: [
      { role: "user", content: "retrieved context", timestamp: 0 },
      { role: "system", content: "memory policy", timestamp: 0 },
    ],
    tools: [tool("continue", async () => ({ content: [] }))],
    prepare: async (messages) => {
      assert.equal(
        messages.filter((message) => message.content === "retrieved context")
          .length,
        1,
      );
      assert.equal(
        messages.filter((message) => message.content === "memory policy")
          .length,
        1,
      );
      return ++prepares === 1
        ? [
            ...messages.filter((message) => !history.includes(message)),
            { role: "user", content: "summary", timestamp: 1 },
          ]
        : messages;
    },
    provider: {
      complete: async () =>
        ++calls === 1
          ? reply([
              { type: "toolCall", id: "next", name: "continue", arguments: {} },
            ])
          : reply([{ type: "text", text: "done" }]),
    },
  });
  const result = await x.engine.run(input);
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.equal(prepares, 2);
  assert.equal(
    x.engine.history.some((message) => history.includes(message)),
    false,
  );
  assert.equal(x.store.transcriptCount("session_invariants"), 4);
  const exhausted = await x.engine.run(input);
  assert.equal(exhausted.status, "failed");
  assert.match(exhausted.error ?? "", /message budget/);
  assert.equal(calls, 2);
});

test("history byte limits reject oversized initial and prepared contexts before a model request", async (t) => {
  const oversized: Message = {
    role: "user",
    content: "x".repeat(4096),
    timestamp: 0,
  };
  await assert.rejects(
    harness(t, { history: [oversized], maxHistoryBytes: 1024 }),
    /history byte budget/,
  );
  let calls = 0;
  const x = await harness(t, {
    compactHistory: true,
    maxHistoryBytes: 1024,
    prepare: async (messages) => [...messages, oversized],
    provider: {
      complete: async () => {
        calls++;
        return reply([{ type: "text", text: "unexpected" }]);
      },
    },
  });
  const result = await x.engine.run(input);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /history byte budget/);
  assert.equal(calls, 0);
});

test("a failed checkpoint rolls back durable input and leaves no phantom in-memory message", async (t) => {
  const x = await harness(t);
  const message = { ...input, inputId: "input_failed" };
  x.store.put("inbox", {
    id: message.inputId,
    runId: "run_invariants",
    delivery: "start",
    message,
    status: "pending",
    createdAt: now(),
  } satisfies InboxEntry);
  x.engine.options.checkpoint = (message, id, _text) => {
    x.store.appendTranscript("session_invariants", {
      id,
      runId: "run_invariants",
      message,
    });
    throw new Error("checkpoint write failed");
  };
  const outcome = await x.engine.run(message);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /checkpoint write failed/);
  assert.deepEqual(x.engine.history, []);
  assert.deepEqual(x.store.transcript("session_invariants"), []);
  assert.equal(
    x.store.get<InboxEntry>("inbox", message.inputId).status,
    "pending",
  );
  assert.equal(
    x.events.some((event) => event.type === "input.applied"),
    false,
  );
});

test("parent abort listeners are released after every run and restored if the engine runs again", async (t) => {
  const parent = new AbortController();
  const x = await harness(t, { signal: parent.signal });
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  assert.equal((await x.engine.run(input)).status, "completed");
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.equal((await x.engine.run(input)).status, "completed");
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  parent.abort(new Error("cancelled"));
  assert.equal(x.engine.controller.signal.aborted, false);
  assert.equal((await x.engine.run(input)).status, "cancelled");
});

test("a historical successful finish call cannot hide a currently denied call with the same ID", async (t) => {
  let requests = 0,
    executed = 0;
  const x = await harness(t, {
    history: [
      {
        role: "toolResult",
        toolCallId: "reused",
        toolName: "finish",
        content: [],
        isError: false,
        timestamp: 0,
      },
    ],
    finishTool: "finish",
    tools: [
      tool("finish", async () => {
        executed++;
        return { content: [] };
      }),
    ],
    authorize: async (_tool, _args, id) => {
      if (id === "reused") throw new Error("permission denied");
    },
    provider: {
      complete: async () =>
        reply([
          {
            type: "toolCall",
            name: "finish",
            id: ++requests === 1 ? "reused" : "fresh",
            arguments: {},
          },
        ]),
    },
  });
  assert.equal((await x.engine.run(input)).status, "completed");
  assert.equal(requests, 2);
  assert.equal(executed, 1);
  assert.equal(
    x.store.get<ToolEffect>("effects", "run_invariants:reused").status,
    "failed",
  );
  assert.equal(
    x.store.get<ToolEffect>("effects", "run_invariants:fresh").status,
    "completed",
  );
});

test("a corrupted stored result is reported without replaying or overwriting the completed effect", async (t) => {
  let requests = 0,
    executed = 0,
    authorized = 0;
  const x = await harness(t, {
    tools: [
      tool("persist", async () => {
        executed++;
        return { content: [] };
      }),
    ],
    authorize: async () => {
      authorized++;
    },
    provider: {
      complete: async () =>
        ++requests === 1
          ? reply([
              {
                type: "toolCall",
                name: "persist",
                id: "stored",
                arguments: {},
              },
            ])
          : reply([{ type: "text", text: "reported" }]),
    },
  });
  const effect: ToolEffect = {
    id: "run_invariants:stored",
    runId: "run_invariants",
    callId: "stored",
    tool: "persist",
    argsHash: hash("{}"),
    status: "completed",
    result: { content: [null] },
    createdAt: now(),
    updatedAt: now(),
  };
  x.store.put("effects", effect);
  assert.equal((await x.engine.run(input)).status, "completed");
  assert.equal(executed, 0);
  assert.equal(authorized, 1);
  assert.deepEqual(x.store.get<ToolEffect>("effects", effect.id), effect);
  const result = x.engine.history.find(
    (message) => message.role === "toolResult",
  );
  assert.equal(result?.role, "toolResult");
  assert.ok(result && "isError" in result && result.isError);
  assert.match(JSON.stringify(result), /Stored tool result is invalid/);
});

test("a checkpoint failure waits for already-running sibling tools before the run settles", async (t) => {
  const started = deferred(),
    unblock = deferred();
  const checkpointFailed = deferred();
  const scheduler = new ToolScheduler(2);
  const x = await harness(t, {
    scheduler,
    tools: [
      tool("slow", async () => {
        started.resolve();
        await unblock.promise;
        return { content: [] };
      }),
      tool("fast", async () => {
        await started.promise;
        return { content: [] };
      }),
    ],
    provider: {
      complete: async () =>
        reply(
          ["slow", "fast"].map((name) => ({
            type: "toolCall",
            id: name,
            name,
            arguments: {},
          })),
        ),
    },
  });
  let failures = 0;
  const checkpoint = x.engine.options.checkpoint;
  x.engine.options.checkpoint = (message, id, text) => {
    if (message.role === "toolResult" && message.toolCallId === "fast") {
      if (++failures === 2) checkpointFailed.resolve();
      throw new Error("result checkpoint unavailable");
    }
    checkpoint(message, id, text);
  };
  let settled = false;
  const run = x.engine.run(input).then((outcome) => {
    settled = true;
    return outcome;
  });
  try {
    await checkpointFailed.promise;
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(scheduler.state.active, 1);
  } finally {
    unblock.resolve();
  }
  assert.equal((await run).status, "failed");
  assert.deepEqual(scheduler.state, { active: 0, queued: 0, limit: 2 });
  assert.equal(
    x.store.get<ToolEffect>("effects", "run_invariants:slow").status,
    "completed",
  );
});

test(
  "cancellation interrupts an uncooperative authorization without executing the tool",
  { timeout: 1000 },
  async (t) => {
    const parent = new AbortController();
    let executions = 0;
    const x = await harness(t, {
      signal: parent.signal,
      tools: [
        tool("guarded", async () => {
          executions++;
          return { content: [] };
        }),
      ],
      authorize: () => {
        parent.abort(new Error("cancelled"));
        return new Promise<void>(() => {});
      },
      provider: {
        complete: async () =>
          reply([
            { type: "toolCall", id: "guarded", name: "guarded", arguments: {} },
          ]),
      },
    });
    assert.equal((await x.engine.run(input)).status, "cancelled");
    assert.equal(executions, 0);
    assert.equal(
      x.store.get<ToolEffect>("effects", "run_invariants:guarded").status,
      "failed",
    );
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  },
);
