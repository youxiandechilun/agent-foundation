import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponseBuilder } from "../src/providers/protocol.js";
import { openaiCompletions } from "../src/providers/protocols/openai-completions.js";
import { openaiResponses } from "../src/providers/protocols/openai-responses.js";
import { anthropicMessages } from "../src/providers/protocols/anthropic-messages.js";
import { textOf } from "../src/runtime/types.js";

const builder = () => new ResponseBuilder("test", "route", "model");

test("compatible completion streams may leave optional tool fields null", async () => {
  const response = builder();
  await openaiCompletions.event(
    { id: null, choices: [{ delta: { content: "hello", tool_calls: null } }] },
    response,
  );
  await openaiCompletions.event(
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call",
                function: { name: "lookup", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    response,
  );
  await openaiCompletions.event(
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: null, function: { name: null, arguments: "{}" } },
            ],
          },
        },
      ],
    },
    response,
  );
  response.finalizeCalls();
  assert.equal(textOf(response.output), "hello");
  assert.deepEqual(response.calls.get(0), {
    id: "call",
    name: "lookup",
    json: "{}",
  });
  await openaiResponses.event(
    { type: "future.event", delta: { opaque: true } },
    response,
  );
});

test("provider boundaries reject malformed deltas before appending visible content", async () => {
  for (const [protocol, value] of [
    [openaiCompletions, { choices: [{ delta: { content: [{ text: 42 }] } }] }],
    [openaiResponses, { type: "response.output_text.delta", delta: 42 }],
    [
      anthropicMessages,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: 42 },
      },
    ],
  ] as const) {
    const response = builder();
    await assert.rejects(() => protocol.event(value, response));
    assert.deepEqual(response.output.content, []);
  }
});

test("provider usage validates counts atomically and retains split cache accounting", () => {
  const response = builder();
  response.usage({ input_tokens: 5, cache_read_input_tokens: 3 }, true, false);
  assert.equal(response.output.usage.reported, false);
  response.usage({ output_tokens: 2, cache_creation_input_tokens: 4 }, true);
  assert.deepEqual(response.output.usage, {
    input: 5,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 14,
    reported: true,
  });
  for (const bad of ["2", -1, 0.5, Infinity]) {
    assert.throws(() =>
      response.usage({ input_tokens: 100, output_tokens: bad }),
    );
    assert.equal(response.output.usage.input, 5);
    assert.equal(response.output.usage.output, 2);
  }
});

test("Anthropic retains opaque native replay fields while ignoring unrelated events", async () => {
  const response = builder();
  await anthropicMessages.event({ type: "ping" }, response);
  await anthropicMessages.event(
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "redacted_thinking",
        data: "opaque-signature",
        future_field: { keep: true },
      },
    },
    response,
  );
  anthropicMessages.finalize?.(response);
  assert.deepEqual(response.output.providerState?.items, [
    {
      type: "redacted_thinking",
      data: "opaque-signature",
      future_field: { keep: true },
    },
  ]);
});

test("unknown message parts cannot be mistaken for text", () => {
  assert.equal(
    textOf({
      content: [
        null,
        42,
        { type: "text", text: 5 },
        { type: "text", text: "valid" },
      ],
    }),
    "valid",
  );
});
