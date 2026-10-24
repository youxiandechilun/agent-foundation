import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponseBuilder } from "../src/providers/protocol.js";
import { openaiResponses } from "../src/providers/protocols/openai-responses.js";
import { textOf } from "../src/runtime/types.js";

const message = (index: number, ...texts: string[]) => ({
  type: "message",
  id: `m${index}`,
  role: "assistant",
  status: "completed",
  content: texts.map((text) => ({ type: "output_text", text })),
});
const delta = (output_index: number, delta: string, content_index = 0) => ({
  type: "response.output_text.delta",
  output_index,
  content_index,
  item_id: `m${output_index}`,
  delta,
});
const done = (output_index: number, text: string, content_index = 0) => ({
  type: "response.output_text.done",
  output_index,
  content_index,
  item_id: `m${output_index}`,
  text,
});
const itemDone = (output_index: number, ...texts: string[]) => ({
  type: "response.output_item.done",
  output_index,
  item: message(output_index, ...texts),
});
const terminal = (...output: ReturnType<typeof message>[]) => ({
  type: "response.completed",
  response: { output, usage: { input_tokens: 3, output_tokens: 4 } },
});
function fixture() {
  const visible: string[] = [];
  const response = new ResponseBuilder(
    "openai-responses",
    "test",
    "test",
    (e) => {
      if (e.type === "text") visible.push(e.text);
    },
  );
  const send = async (...events: unknown[]) => {
    for (const event of events) await openaiResponses.event(event, response);
  };
  return { response, visible, send };
}

test("Responses interleaved output items retain their own text and stream in output order", async () => {
  const x = fixture();
  await x.send(delta(0, "A"), delta(1, "B"));
  assert.deepEqual(x.visible, ["A"]);
  await x.send(delta(0, "C"), terminal(message(0, "AC"), message(1, "B")));
  assert.equal(textOf(x.response.output), "ACB");
  assert.equal(x.visible.join(""), "ACB");
});

test("Responses interleaved content parts retain their content indices", async () => {
  const x = fixture();
  await x.send(delta(0, "A"), delta(0, "B", 1), delta(0, "C"));
  assert.equal(x.visible.join(""), "AC");
  await x.send(terminal(message(0, "AC", "B")));
  assert.equal(textOf(x.response.output), "ACB");
});

test("Responses snapshot-only earlier text is inserted before a later streamed item", async () => {
  const x = fixture();
  await x.send(itemDone(0, "A"), delta(1, "B"));
  assert.equal(x.visible.join(""), "AB");
  await x.send(terminal(message(0, "A"), message(1, "B")));
  assert.equal(textOf(x.response.output), "AB");
});

test("Responses terminal-only earlier text precedes buffered later text", async () => {
  const x = fixture();
  await x.send(delta(1, "B"));
  assert.equal(x.response.started, true);
  assert.deepEqual(x.visible, []);
  await x.send(terminal(message(0, "A"), message(1, "B")));
  assert.equal(textOf(x.response.output), "AB");
});

test("Responses done snapshots fill missing suffixes once at each completion level", async () => {
  const x = fixture();
  const contentDone = {
    type: "response.content_part.done",
    output_index: 0,
    content_index: 0,
    item_id: "m0",
    part: { type: "output_text", text: "ABC" },
  };
  await x.send(
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: "m0",
      part: { type: "output_text", text: "" },
    },
    delta(0, "A"),
    done(0, "ABC"),
    done(0, "ABC"),
    contentDone,
    contentDone,
    itemDone(0, "ABC"),
    itemDone(0, "ABC"),
    terminal(message(0, "ABC")),
  );
  assert.equal(textOf(x.response.output), "ABC");
  assert.equal(x.visible.join(""), "ABC");
});

test("Responses terminal snapshots complete each unfinished block independently", async () => {
  const x = fixture();
  await x.send(delta(0, "A"), delta(1, "C"));
  await x.send(terminal(message(0, "AB"), message(1, "CD")));
  assert.equal(x.visible.join(""), "ABCD");
});

for (const [name, events] of [
  [
    "output indices",
    [delta(1, "A"), delta(0, "B"), terminal(message(0, "A"), message(1, "B"))],
  ],
  [
    "content indices",
    [delta(0, "A", 1), delta(0, "B"), terminal(message(0, "A", "B"))],
  ],
  ["true text conflict", [delta(0, "X"), terminal(message(0, "Y"))]],
  [
    "text.done conflict",
    [delta(0, "A"), done(0, "B"), terminal(message(0, "A"))],
  ],
  ["item.done conflict", [delta(0, "A"), itemDone(0, "B")]],
  [
    "terminal conflict after done",
    [delta(0, "A"), done(0, "A"), terminal(message(0, "AB"))],
  ],
  ["missing streamed message", [delta(0, "A"), terminal()]],
  [
    "missing streamed content part",
    [delta(0, "B", 1), terminal(message(0, "A"))],
  ],
] satisfies [string, unknown[]][])
  test(`Responses rejects ${name} even when flat text could hide the conflict`, async () => {
    const x = fixture();
    await assert.rejects(
      x.send(...events),
      /Responses terminal text differs from streamed text/,
    );
  });

for (const events of [
  [delta(0, "A"), { ...done(0, "A"), item_id: "other" }],
  [delta(0, "A"), { ...delta(1, "B"), item_id: "m0" }],
  [
    delta(0, "A"),
    { ...itemDone(0, "A"), item: { ...message(0, "A"), id: "other" } },
  ],
])
  test("Responses rejects conflicting item identity without appending the conflicting delta", async () => {
    const x = fixture();
    await assert.rejects(
      x.send(...events),
      /Conflicting Responses text item identity/,
    );
    assert.equal(x.visible.join(""), "A");
  });

test("Responses rejects extra deltas after a content block is finalized", async () => {
  const x = fixture();
  await x.send(delta(0, "A"), done(0, "A"));
  await assert.rejects(x.send(delta(0, "B")), /follows completed content/);
  assert.equal(textOf(x.response.output), "A");
});

test("Responses keeps legacy unindexed streams and terminal-only JSON behavior", async () => {
  const legacy = fixture();
  await legacy.send(
    { type: "response.output_text.delta", delta: "A" },
    terminal(message(0, "AB")),
  );
  assert.equal(textOf(legacy.response.output), "AB");
  const omitted = fixture();
  await omitted.send(
    { type: "response.output_text.delta", delta: "A" },
    terminal(),
  );
  assert.equal(textOf(omitted.response.output), "A");
  const json = fixture();
  await json.send(
    ...openaiResponses.jsonEvents!({
      output: [message(0, "A"), message(1, "B")],
    }),
  );
  assert.equal(textOf(json.response.output), "AB");
});

test("Responses still rejects text conflicts in legacy unindexed streams", async () => {
  const x = fixture();
  await x.send({ type: "response.output_text.delta", delta: "X" });
  await assert.rejects(
    x.send(terminal(message(0, "Y"))),
    /terminal text differs/,
  );
});

test("Responses never guesses a missing address after an indexed stream starts", async () => {
  const x = fixture();
  await x.send(delta(0, "A"));
  await assert.rejects(
    x.send({ type: "response.output_text.delta", delta: "B" }),
    /missing its index/,
  );
  assert.equal(x.visible.join(""), "A");
});

test("Responses retains terminal usage when text integrity validation fails", async () => {
  const x = fixture();
  await x.send(delta(0, "X"));
  await assert.rejects(
    x.send(terminal(message(0, "Y"))),
    /terminal text differs/,
  );
  assert.equal(x.response.output.usage.reported, true);
  assert.equal(x.response.output.usage.input, 3);
  assert.equal(x.response.output.usage.output, 4);
});
