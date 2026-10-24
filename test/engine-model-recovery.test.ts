import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ExecutionEngine,
  type EngineOptions,
  type ModelRecoveryPolicy,
} from "../src/runtime/engine.js";
import { ProviderError } from "../src/providers/sse.js";
import { AppError, hash, now } from "../src/core/util.js";
import { Store } from "../src/storage/store.js";
import {
  emptyUsage,
  type AssistantMessage,
  type Message,
  type ToolDefinition,
} from "../src/runtime/types.js";
import type { ToolEffect } from "../src/contracts.js";

const input = {
  role: "user" as const,
  content: "finish this task",
  timestamp: 1,
};
const recovery: ModelRecoveryPolicy = {
  maxRetries: 3,
  initialDelayMs: 0,
  maxDelayMs: 0,
  maxElapsedMs: 5000,
};
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
function transportFailure(): ProviderError {
  const error = new ProviderError(
    "lost connection",
    502,
    true,
    false,
    undefined,
    {
      reason: "network",
    },
  );
  error.requestSent = true;
  error.partial = {
    ...reply([{ type: "text", text: "failed-fragment" }]),
    stopReason: "error",
    providerState: {
      protocol: "openai-responses",
      routeId: "text",
      items: [{ type: "function_call", arguments: '{"incomplete":' }],
    },
  };
  return error;
}
function tool(
  execute: ToolDefinition["execute"],
  risk: ToolDefinition["risk"] = "write",
): ToolDefinition {
  return {
    name: "persist",
    description: "record a durable value",
    parameters: { type: "object" },
    risk,
    execute,
  };
}
async function harness(
  t: TestContext,
  overrides: Partial<Omit<EngineOptions, "store">> = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "foundation-recovery-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const engine = new ExecutionEngine({
    runId: "run_recovery",
    routeId: "text",
    instructions: "finish the task",
    history: [],
    tools: [],
    provider: { complete: async () => reply([{ type: "text", text: "done" }]) },
    maxSteps: 6,
    maxToolCalls: 8,
    timeoutMs: 5000,
    store,
    checkpoint(message, id) {
      store.appendTranscript("session_recovery", {
        id,
        runId: "run_recovery",
        message,
      });
    },
    prepare: async (messages) => messages,
    ...overrides,
    publish(type, data, ...rest) {
      events.push({ type, data });
      overrides.publish?.(type, data, ...rest);
    },
  });
  return { engine, store, events };
}

test("model recovery retains completed tool results and never replays the tool batch", async (t) => {
  let requests = 0,
    writes = 0;
  const contexts: Message[][] = [];
  const x = await harness(t, {
    modelRecovery: recovery,
    tools: [
      tool(async () => {
        writes++;
        return { content: [{ type: "text", text: "saved exactly once" }] };
      }),
    ],
    provider: {
      async complete(request, delta) {
        contexts.push(structuredClone(request.messages));
        if (++requests === 1)
          return reply([
            { type: "toolCall", id: "saved", name: "persist", arguments: {} },
          ]);
        if (requests === 2) {
          await delta?.({ type: "text", text: "failed-fragment" });
          throw transportFailure();
        }
        return reply([{ type: "text", text: "finished" }]);
      },
    },
  });
  const result = await x.engine.run(input);
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.steps, 2);
  assert.equal(requests, 3);
  assert.equal(writes, 1);
  assert.deepEqual(contexts[2], contexts[1]);
  assert.ok(
    contexts[2].some(
      (message) =>
        message.role === "toolResult" && message.toolCallId === "saved",
    ),
  );
  assert.equal(
    x.store.get<ToolEffect>("effects", "run_recovery:saved").status,
    "completed",
  );
  assert.doesNotMatch(JSON.stringify(x.engine.history), /failed-fragment/);
  assert.doesNotMatch(
    JSON.stringify(x.store.transcript("session_recovery")),
    /failed-fragment/,
  );
  assert.equal(x.engine.history.filter((m) => m.role === "user").length, 1);
  const discarded = x.events.find(
    (event) => event.type === "assistant.message.discarded",
  );
  assert.ok(discarded);
  const committed = x.events.filter(
    (event) => event.type === "assistant.message.committed",
  );
  assert.ok(
    committed.every(
      (event) => event.data.messageId !== discarded.data.messageId,
    ),
  );
  const scheduled = x.events.find(
    (event) => event.type === "model.recovery.scheduled",
  );
  assert.deepEqual(scheduled?.data, {
    step: 2,
    attempt: 1,
    maxRetries: 3,
    delayMs: 0,
    reason: "network",
  });
  assert.equal(
    x.events.filter((event) => event.type === "model.recovery.completed")
      .length,
    1,
  );
  assert.equal(
    x.events.filter((event) => event.type === "model-step.started").length,
    2,
  );
  assert.equal(
    x.events.filter((event) => event.type === "model-step.completed").length,
    2,
  );
});

test("truncated tool arguments and provider state never execute or enter recovered context", async (t) => {
  let requests = 0,
    writes = 0;
  const x = await harness(t, {
    modelRecovery: recovery,
    tools: [
      tool(async () => {
        writes++;
        return { content: [] };
      }),
    ],
    provider: {
      async complete(request, delta) {
        if (++requests === 1) {
          await delta?.({
            type: "tool-arguments",
            callId: "incomplete",
            text: '{"incomplete":',
          });
          const error = transportFailure();
          error.partial!.content.push({
            type: "toolCall",
            id: "incomplete",
            name: "persist",
            arguments: {},
          });
          throw error;
        }
        assert.doesNotMatch(JSON.stringify(request.messages), /incomplete/);
        return reply([{ type: "text", text: "done" }]);
      },
    },
  });
  assert.equal((await x.engine.run(input)).status, "completed");
  assert.equal(requests, 2);
  assert.equal(writes, 0);
  assert.equal(x.store.list("effects").length, 0);
  assert.doesNotMatch(
    JSON.stringify(x.engine.history),
    /incomplete|providerState/,
  );
});

test("the recovery count is shared by every model step and exhaustion discards its last partial", async (t) => {
  let requests = 0,
    writes = 0;
  const x = await harness(t, {
    modelRecovery: { ...recovery, maxRetries: 2 },
    tools: [
      tool(async () => {
        writes++;
        return { content: [] };
      }),
    ],
    provider: {
      async complete() {
        if (++requests % 2) throw transportFailure();
        return reply([
          {
            type: "toolCall",
            id: `call-${requests}`,
            name: "persist",
            arguments: {},
          },
        ]);
      },
    },
  });
  const result = await x.engine.run(input);
  assert.equal(result.status, "failed");
  assert.equal(result.steps, 3);
  assert.equal(requests, 5);
  assert.equal(writes, 2);
  assert.deepEqual(
    x.events
      .filter((event) => event.type === "model.recovery.scheduled")
      .map((event) => event.data.attempt),
    [1, 2],
  );
  assert.equal(
    x.events.filter((event) => event.type === "assistant.message.discarded")
      .length,
    3,
  );
  assert.doesNotMatch(
    JSON.stringify(x.store.transcript("session_recovery")),
    /failed-fragment|providerState/,
  );
});

test("default recovery stays disabled and preserves the existing failed partial", async (t) => {
  let requests = 0;
  const x = await harness(t, {
    provider: {
      async complete() {
        requests++;
        throw transportFailure();
      },
    },
  });
  assert.equal((await x.engine.run(input)).status, "failed");
  assert.equal(requests, 1);
  assert.match(JSON.stringify(x.engine.history), /failed-fragment/);
  assert.equal(
    x.events.filter((event) => event.type === "model.recovery.scheduled")
      .length,
    0,
  );
});

test("cancellation during backoff never starts the next model request", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  const x = await harness(t, {
    signal: controller.signal,
    modelRecovery: { ...recovery, initialDelayMs: 1000, maxDelayMs: 1000 },
    publish(type) {
      if (type === "model.recovery.scheduled")
        controller.abort(new Error("cancelled"));
    },
    provider: {
      async complete() {
        requests++;
        throw transportFailure();
      },
    },
  });
  assert.equal((await x.engine.run(input)).status, "cancelled");
  assert.equal(requests, 1);
  assert.equal(x.engine.history.length, 1);
});

test("the model step recovery window aborts an in-flight resumed request", async (t) => {
  let requests = 0;
  let attemptSignal: AbortSignal | undefined;
  const x = await harness(t, {
    modelRecovery: { ...recovery, maxElapsedMs: 200 },
    provider: {
      async complete(_request, _delta, signal) {
        if (++requests === 1) throw transportFailure();
        attemptSignal = signal;
        return new Promise<AssistantMessage>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
        });
      },
    },
  });
  const result = await x.engine.run(input);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /Model recovery time limit reached/);
  assert.equal(requests, 2);
  assert.equal(attemptSignal?.aborted, true);
  assert.equal(x.engine.history.length, 1);
  assert.equal(
    x.events.filter((event) => event.type === "model.recovery.completed")
      .length,
    0,
  );
});

test("a recovery delay outside the step window is rejected without another request", async (t) => {
  let requests = 0;
  const x = await harness(t, {
    modelRecovery: {
      ...recovery,
      initialDelayMs: 1000,
      maxDelayMs: 1000,
      maxElapsedMs: 100,
    },
    provider: {
      async complete() {
        requests++;
        throw transportFailure();
      },
    },
  });
  assert.equal((await x.engine.run(input)).status, "failed");
  assert.equal(requests, 1);
  assert.equal(x.engine.history.length, 1);
  assert.equal(
    x.events.filter((event) => event.type === "model.recovery.scheduled")
      .length,
    0,
  );
});

test("the original run deadline also aborts an in-flight resumed request", async (t) => {
  let requests = 0;
  const x = await harness(t, {
    modelRecovery: recovery,
    timeoutMs: 200,
    provider: {
      async complete(_request, _delta, signal) {
        if (++requests === 1) throw transportFailure();
        return new Promise<AssistantMessage>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
        });
      },
    },
  });
  const result = await x.engine.run(input);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Run time limit reached");
  assert.equal(requests, 2);
  assert.equal(x.engine.history.length, 1);
});

for (const kind of [
  "protocol",
  "cancelled",
  "budget",
  "permission",
  "unstarted",
  "native",
] as const)
  test(`model recovery never replays ${kind} failures`, async (t) => {
    let requests = 0;
    const error =
      kind === "budget" || kind === "permission"
        ? new AppError(kind === "budget" ? 402 : 403, kind, kind)
        : transportFailure();
    if (error instanceof ProviderError) {
      if (kind === "protocol" || kind === "cancelled") error.reason = kind;
      if (kind === "unstarted") error.started = false;
      if (kind === "native") error.nativeActivity = true;
    }
    const x = await harness(t, {
      modelRecovery: recovery,
      provider: {
        async complete() {
          requests++;
          throw error;
        },
      },
    });
    assert.equal((await x.engine.run(input)).status, "failed");
    assert.equal(requests, 1);
    assert.equal(
      x.events.filter((event) => event.type === "model.recovery.scheduled")
        .length,
      0,
    );
  });

for (const status of ["prepared", "running", "unknown"] as const)
  test(`an uncertain write effect in state ${status} stops model recovery`, async (t) => {
    let requests = 0;
    const x = await harness(t, {
      modelRecovery: recovery,
      tools: [tool(async () => ({ content: [] }))],
      provider: {
        async complete() {
          requests++;
          throw transportFailure();
        },
      },
    });
    x.store.write("effects", {
      id: "run_recovery:uncertain",
      runId: "run_recovery",
      callId: "uncertain",
      tool: "persist",
      argsHash: hash("{}"),
      status,
      createdAt: now(),
      updatedAt: now(),
    } satisfies ToolEffect);
    assert.equal((await x.engine.run(input)).status, "failed");
    assert.equal(requests, 1);
    assert.equal(x.engine.history.length, 1);
  });
