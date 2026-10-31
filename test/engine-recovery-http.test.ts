import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, collect } from "./support/wire-server.js";
import { listenHttp } from "../src/transport/http-listener.js";
import { textOf } from "../src/runtime/types.js";

type Adapter = "openai-completions" | "openai-responses" | "anthropic-messages";

async function recoveryKernel(
  t: TestContext,
  adapter: Adapter,
  maxRunUsd = 1,
  drop: "eof" | "socket" | "json-prefix" | "json-body" = "eof",
  structured = false,
) {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const first = requests.length === 1;
    const text = first ? "stale-draft" : "analysis completed";
    if (drop === "json-body") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        first
          ? '{"choices":[{"message":{"content":"split'
          : JSON.stringify({
              choices: [{ message: { content: text }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 12,
                total_tokens: 22,
              },
            }),
      );
      return;
    }
    const send = (value: unknown) =>
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (adapter === "openai-completions") {
      send({
        id: `chat-${requests.length}`,
        choices: [
          {
            delta: structured
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: "function",
                      function: {
                        name: "submit_result",
                        arguments: first ? '{"answer":' : '{"answer":42}',
                      },
                    },
                  ],
                }
              : { content: text },
            finish_reason: null,
          },
        ],
      });
      if (!first) {
        send({
          id: `chat-${requests.length}`,
          choices: [
            { delta: {}, finish_reason: structured ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        });
        response.write("data: [DONE]\n\n");
      }
    } else if (adapter === "openai-responses") {
      send({
        type: "response.created",
        response: { id: `response-${requests.length}` },
      });
      send({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "message",
        delta: text,
      });
      if (!first)
        send({
          type: "response.completed",
          response: {
            id: `response-${requests.length}`,
            status: "completed",
            output: [
              {
                type: "message",
                id: "message",
                content: [{ type: "output_text", text }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
          },
        });
    } else {
      send({
        type: "message_start",
        message: {
          id: `message-${requests.length}`,
          usage: { input_tokens: 10 },
        },
      });
      send({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
      if (!first) {
        send({ type: "content_block_stop", index: 0 });
        send({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 12 },
        });
        send({ type: "message_stop" });
      }
    }
    if (first && drop === "json-prefix")
      response.end('data: {"unfinished":"split');
    else if (first && drop === "socket") {
      // A separate turn lets fetch receive and parse the streamed output before
      // the TCP connection disappears, rather than turning this into a pre-output failure.
      setTimeout(() => response.destroy(), 50);
    } else response.end();
  });
  const address = await listenHttp(server, { host: "127.0.0.1", port: 0 });
  const resources: { fixture?: Awaited<ReturnType<typeof setup>> } = {};
  t.after(async () => {
    try {
      await resources.fixture?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  resources.fixture = await setup(undefined, {
    routes: {
      text: {
        kind: "text",
        adapter,
        model: "local-recovery-test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        contextWindow: 128000,
        maxOutputTokens: 64,
        retry: {
          maxRetries: drop === "json-body" ? 2 : 0,
          initialDelayMs: 0,
          maxDelayMs: 0,
        },
        pricing: {
          currency: "USD",
          inputPerMillion: 1,
          outputPerMillion: 1,
          requestUsd: 0,
        },
      },
    },
    limits: {
      modelRecovery: {
        maxRetries: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        maxElapsedMs: 5000,
      },
    },
    budgets: { enabled: true, maxRunUsd },
  });
  return { ...resources.fixture, requests };
}

for (const adapter of [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  test(`${adapter} recovers an interrupted real HTTP stream in the same run with separate ledger outcomes`, async (t) => {
    const x = await recoveryKernel(t, adapter);
    const session = await x.session();
    const submitted = await x.client.submit(session.id, {
      text: "analyze locally",
    });
    const events = await collect(x.client, submitted.runId);
    const result = await x.kernel.wait(submitted.runId);
    assert.equal(result.status, "completed", result.error);
    assert.equal(x.requests.length, 2);
    const scheduled = events.filter(
      (event) => event.type === "model.recovery.scheduled",
    );
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].data.reason, "stream_interrupted");
    assert.equal(
      events.filter((event) => event.type === "run.completed").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "assistant.message.discarded")
        .length,
      1,
    );
    const transcript = x.kernel.store.transcript(session.id);
    assert.doesNotMatch(JSON.stringify(transcript), /stale-draft/);
    assert.equal(textOf(transcript.at(-1)!.message), "analysis completed");
    const entries = x.kernel.costs.entries({ runId: submitted.runId });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.status).sort(), [
      "settled",
      "unknown",
    ]);
    assert.equal(new Set(entries.map((entry) => entry.id)).size, 2);
    assert.ok(
      entries.every(
        (entry) =>
          entry.runId === submitted.runId && entry.sessionId === session.id,
      ),
    );
    const unknown = entries.find((entry) => entry.status === "unknown")!;
    assert.equal(unknown.chargedMicros, undefined);
    assert.ok(unknown.reservedMicros > 0);
    const totals = x.kernel.costs.summary({ runId: submitted.runId });
    assert.equal(totals.heldMicros, unknown.reservedMicros);
    assert.equal(totals.chargedMicros, 22);
  });

test("real HTTP recovery stops at the original run budget and keeps the unknown charge", async (t) => {
  const x = await recoveryKernel(t, "openai-completions", 0.2);
  const session = await x.session();
  const submitted = await x.client.submit(session.id, {
    text: "respect the budget",
  });
  const events = await collect(x.client, submitted.runId);
  const result = await x.kernel.wait(submitted.runId);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /run cost budget exhausted/);
  assert.equal(x.requests.length, 1);
  const entries = x.kernel.costs.entries({ runId: submitted.runId });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "unknown");
  assert.equal(
    x.kernel.costs.summary({ runId: submitted.runId }).chargedMicros,
    0,
  );
  assert.equal(
    events.filter((event) => event.type === "model.recovery.scheduled").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "model.recovery.completed").length,
    0,
  );
});

test("a real TCP disconnect after visible output recovers only its model step", async (t) => {
  const x = await recoveryKernel(t, "openai-completions", 1, "socket");
  const session = await x.session();
  const submitted = await x.client.submit(session.id, {
    text: "recover the connection",
  });
  const events = await collect(x.client, submitted.runId);
  assert.equal((await x.kernel.wait(submitted.runId)).status, "completed");
  assert.equal(x.requests.length, 2);
  const scheduled = events.find(
    (event) => event.type === "model.recovery.scheduled",
  );
  assert.equal(scheduled?.data.reason, "stream_interrupted");
  assert.equal(
    events.filter((event) => event.type === "model-step.started").length,
    1,
  );
});

test("structured result recovery discards truncated parameters before executing the output tool", async (t) => {
  const x = await recoveryKernel(
    t,
    "openai-completions",
    1,
    "json-prefix",
    true,
  );
  const session = await x.session();
  const submitted = await x.client.submit(session.id, {
    text: "compute",
    outputSchema: {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    },
  });
  const events = await collect(x.client, submitted.runId);
  const result = await x.kernel.wait(submitted.runId);
  assert.equal(result.status, "completed", result.error);
  assert.deepEqual(result.output, { answer: 42 });
  assert.equal(x.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(x.requests[1]), /call-1|unfinished/);
  assert.equal(
    events.filter((event) => event.type === "assistant.message.discarded")
      .length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "run.output").length, 1);
  assert.equal(
    events.filter((event) => event.type === "tool.started").length,
    1,
  );
  assert.deepEqual(
    x.kernel.costs
      .entries({ runId: submitted.runId })
      .map((entry) => entry.status)
      .sort(),
    ["settled", "unknown"],
  );
});

test("a truncated non-streaming JSON body uses route retry with independent unknown and settled charges", async (t) => {
  const x = await recoveryKernel(t, "openai-completions", 1, "json-body");
  const session = await x.session();
  const submitted = await x.client.submit(session.id, {
    text: "compute locally",
  });
  const events = await collect(x.client, submitted.runId);
  const result = await x.kernel.wait(submitted.runId);
  assert.equal(result.status, "completed", result.error);
  assert.equal(x.requests.length, 2);
  assert.equal(
    textOf(x.kernel.store.transcript(session.id).at(-1)!.message),
    "analysis completed",
  );
  assert.equal(
    events.filter((event) => event.type === "model.recovery.scheduled").length,
    0,
  );
  const entries = x.kernel.costs.entries({ runId: submitted.runId });
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 2);
  assert.deepEqual(entries.map((entry) => entry.status).sort(), [
    "settled",
    "unknown",
  ]);
  assert.ok(
    entries.find((entry) => entry.status === "unknown")!.reservedMicros > 0,
  );
});
