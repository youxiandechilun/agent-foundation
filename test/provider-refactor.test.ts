import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseConfig } from "../src/core/config.js";
import { HttpTextProvider } from "../src/providers/text.js";
import { ResponseBuilder } from "../src/providers/protocol.js";
import { openaiResponses } from "../src/providers/protocols/openai-responses.js";
import {
  anthropicMessages,
  responsesInput,
} from "../src/providers/serialize.js";
import type { ModelDelta } from "../src/runtime/types.js";

type Adapter = "openai-completions" | "openai-responses" | "anthropic-messages";

async function complete(adapter: Adapter, reply: unknown, streaming = false) {
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the real HTTP request. */
    }
    response.writeHead(200, {
      "Content-Type": streaming ? "text/event-stream" : "application/json",
    });
    response.end(streaming ? String(reply) : JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = parseConfig({
      defaultRoutes: { chat: "text", code: "text", office: "text" },
      routes: {
        text: {
          kind: "text",
          adapter,
          model: "wire",
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      },
    });
    const deltas: ModelDelta[] = [];
    const message = await new HttpTextProvider(
      "text",
      config.routes.text,
    ).complete({ routeId: "text", messages: [], tools: [] }, (delta) => {
      deltas.push(delta);
    });
    return { message, deltas };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const stream = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const call = (callId: string, args: string) => ({
  type: "function_call",
  call_id: callId,
  name: "read",
  arguments: args,
});

for (const delivery of ["json", "terminal-stream", "repeated-stream"] as const)
  test(`Responses ${delivery} retains ordered reasoning and compaction once for its route`, async () => {
    const reasoning = {
      type: "reasoning",
      id: "reason",
      encrypted_content: "opaque-reason",
    };
    const compaction = {
      type: "compaction",
      id: "compact",
      encrypted_content: "opaque-compact",
    };
    const response = {
      status: "completed",
      output: [
        reasoning,
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        compaction,
      ],
    };
    const repeated =
      delivery === "repeated-stream"
        ? [
            {
              type: "response.output_item.done",
              output_index: 2,
              item: compaction,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: reasoning,
            },
          ]
        : [];
    const { message } = await complete(
      "openai-responses",
      delivery === "json"
        ? response
        : stream(...repeated, { type: "response.completed", response }),
      delivery !== "json",
    );
    assert.deepEqual(message.providerState, {
      protocol: "openai-responses",
      routeId: "text",
      items: [reasoning, compaction],
    });
    assert.deepEqual(responsesInput([message], "text"), [
      reasoning,
      compaction,
      { role: "assistant", content: "done" },
    ]);
    assert.deepEqual(responsesInput([message], "other"), [
      { role: "assistant", content: "done" },
    ]);
  });

test("Responses interrupted streams retain completed reasoning in the failure's partial message", async () => {
  const reasoning = {
    type: "reasoning",
    id: "partial",
    encrypted_content: "opaque-partial",
  };
  await assert.rejects(
    complete(
      "openai-responses",
      stream({
        type: "response.output_item.done",
        output_index: 2,
        item: reasoning,
      }),
      true,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "partial" in error);
      const partial = error.partial;
      assert.ok(
        partial && typeof partial === "object" && "providerState" in partial,
      );
      assert.deepEqual(partial.providerState, {
        protocol: "openai-responses",
        routeId: "text",
        items: [reasoning],
      });
      return true;
    },
  );
});

for (const completed of [false, true])
  test(`Responses ${completed ? "complete" : "interrupted"} multi-message replay keeps all text once with search and reasoning`, async () => {
    const response = new ResponseBuilder(
      "openai-responses",
      "text",
      "wire",
      undefined,
      true,
    );
    const firstText = "First message.";
    const secondText = "Second partial";
    const first = {
      type: "message",
      id: "first-message",
      role: "assistant",
      content: [{ type: "output_text", text: firstText }],
    };
    const second = {
      type: "message",
      id: "second-message",
      role: "assistant",
      content: [{ type: "output_text", text: secondText }],
    };
    const search = {
      type: "web_search_call",
      id: "search",
      status: "completed",
      action: { type: "search", query: "latest project update" },
    };
    const reasoning = {
      type: "reasoning",
      id: "reasoning",
      encrypted_content: "opaque-reasoning",
    };
    for (const event of [
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: firstText,
      },
      { type: "response.output_item.done", output_index: 0, item: first },
      { type: "response.output_item.done", output_index: 1, item: search },
      {
        type: "response.output_text.delta",
        output_index: 2,
        content_index: 0,
        delta: secondText,
      },
      ...(completed
        ? [{ type: "response.output_item.done", output_index: 2, item: second }]
        : []),
      { type: "response.output_item.done", output_index: 3, item: reasoning },
    ])
      await openaiResponses.event(event, response);

    // Interrupted delivery has no done item for the second message or terminal event.
    response.retainResponsesState();
    const nativeItems = completed
      ? [first, search, second, reasoning]
      : [search, reasoning];
    assert.deepEqual(response.output.providerState?.items, nativeItems);
    assert.deepEqual(
      responsesInput([response.output], "text"),
      completed
        ? nativeItems
        : [
            ...nativeItems,
            { role: "assistant", content: firstText + secondText },
          ],
    );
    assert.deepEqual(responsesInput([response.output], "other"), [
      { role: "assistant", content: firstText + secondText },
    ]);
    assert.equal(response.output.webSearch?.calls[0].id, "search");
  });

for (const [status, stopReason] of [
  ["completed", "stop"],
  ["incomplete", "length"],
  ["failed", "error"],
] as const) {
  test(`Responses JSON ${status} retains its terminal status`, async () => {
    const { message } = await complete("openai-responses", {
      id: "terminal",
      status,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "partial" }],
        },
      ],
      ...(status === "failed"
        ? { error: { message: "generation failed" } }
        : {}),
    });
    assert.equal(message.stopReason, stopReason);
    if (status === "failed")
      assert.equal(message.errorMessage, "generation failed");
  });
}

test("Responses merges sparse streamed calls with terminal-only calls without losing IDs", async () => {
  const first = call("first", '{"path":"a"}');
  const second = call("second", '{"path":"b"}');
  const third = call("third", '{"path":"c"}');
  const { message, deltas } = await complete(
    "openai-responses",
    stream(
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...first, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"path":"a"}',
      },
      { type: "response.output_item.done", output_index: 1, item: first },
      {
        type: "response.completed",
        response: {
          output: [
            { type: "reasoning", encrypted_content: "opaque" },
            first,
            second,
            third,
          ],
        },
      },
    ),
    true,
  );
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content,
    ["a", "b", "c"].map((path, index) => ({
      type: "toolCall",
      id: ["first", "second", "third"][index],
      name: "read",
      arguments: { path },
    })),
  );
  assert.deepEqual(deltas, [
    { type: "tool-arguments", callId: "first", text: '{"path":"a"}' },
  ]);
});

test("Anthropic thinking blocks retain separate text and signatures in content and replay", async () => {
  const events = [
    {
      type: "message_start",
      message: { id: "signed", usage: { input_tokens: 1 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signature-one" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "first" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "between" },
    },
    {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "thinking",
        thinking: "second",
        signature: "initial-",
      },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "thinking_delta", thinking: "-continued" },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "signature_delta", signature: "signature-two" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  ];
  const { message, deltas } = await complete(
    "anthropic-messages",
    stream(...events),
    true,
  );
  const content = [
    { type: "thinking", thinking: "first", signature: "signature-one" },
    { type: "text", text: "between" },
    {
      type: "thinking",
      thinking: "second-continued",
      signature: "initial-signature-two",
    },
  ];
  assert.deepEqual(message.content, content);
  assert.deepEqual(anthropicMessages([message], "text"), [
    { role: "assistant", content },
  ]);
  assert.deepEqual(
    deltas
      .filter((delta) => delta.type === "thinking")
      .map((delta) => delta.text),
    ["first", "second", "-continued"],
  );
});

test("Anthropic JSON retains the signature supplied with an initial thinking block", async () => {
  const { message } = await complete("anthropic-messages", {
    id: "json",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "reason", signature: "json-signature" },
    ],
  });
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "reason", signature: "json-signature" },
  ]);
});
