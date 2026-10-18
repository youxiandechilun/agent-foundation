import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, collect } from "./support/wire-server.js";

const names = (body: any) =>
  (body.tools || []).map((t: any) => t.function.name);
const last = (body: any) => JSON.stringify(body.messages.at(-1));

test("a reply cut off by the output limit continues instead of failing", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { text: "part one", finish: "length" }
      : { text: " part two" },
  );
  try {
    const s = await x.session(),
      r = await x.client.submit(s.id, { text: "write a lot" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.equal(x.wire.requests.length, 2);
    assert.match(last(x.wire.requests[1].body), /cut off/);
    assert.match(JSON.stringify(x.wire.requests[1].body.messages), /part one/);
    assert.equal(events.filter((e) => e.type === "model.continued").length, 1);
  } finally {
    await x.close();
  }
});

test("continuation is bounded, disabled by 0, and never applies to truncated tool calls", async () => {
  const always = await setup(() => ({ text: "again", finish: "length" }), {
    limits: { maxOutputContinuations: 2 },
  });
  try {
    const s = await always.session(),
      r = await always.client.submit(s.id, { text: "x" });
    const run = await always.kernel.wait(r.runId);
    assert.equal(run.status, "failed");
    assert.match(String(run.error), /length/);
    assert.equal(always.wire.requests.length, 3);
  } finally {
    await always.close();
  }
  const off = await setup(() => ({ text: "cut", finish: "length" }), {
    limits: { maxOutputContinuations: 0 },
  });
  try {
    const s = await off.session(),
      r = await off.client.submit(s.id, { text: "x" });
    assert.equal((await off.kernel.wait(r.runId)).status, "failed");
    assert.equal(off.wire.requests.length, 1);
  } finally {
    await off.close();
  }
  const tools = await setup(() => ({
    calls: [{ name: "plan_update", args: { steps: [] } }],
    finish: "length",
  }));
  try {
    const s = await tools.session(),
      r = await tools.client.submit(s.id, { text: "x" });
    const run = await tools.kernel.wait(r.runId);
    assert.equal(run.status, "failed");
    assert.match(String(run.error), /incomplete tools were not executed/);
    assert.equal(tools.wire.requests.length, 1);
  } finally {
    await tools.close();
  }
});

test("structured output: schema-validated result ends the run and is stored on it", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "submit_result", args: { answer: "not a number" } }] }
      : {
          calls: [{ name: "submit_result", args: { answer: 42, note: "ok" } }],
        },
  );
  try {
    const s = await x.session(),
      outputSchema = {
        type: "object",
        properties: { answer: { type: "number" }, note: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      };
    const r = await x.client.submit(s.id, { text: "compute", outputSchema }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.equal(x.wire.requests.length, 2, "valid submission ends the run");
    assert.ok(names(x.wire.requests[0].body).includes("submit_result"));
    assert.deepEqual(
      x.wire.requests[0].body.tools.find(
        (t: any) => t.function.name === "submit_result",
      ).function.parameters,
      outputSchema,
    );
    assert.match(
      JSON.stringify(x.wire.requests[0].body.messages[0]),
      /requires a structured result/,
    );
    assert.match(
      JSON.stringify(x.wire.requests[1].body.messages),
      /Invalid arguments for submit_result/,
    );
    const run = await x.client.request<any>("GET", `/v1/runs/${r.runId}`);
    assert.deepEqual(run.output, { answer: 42, note: "ok" });
    assert.deepEqual(run.outputSchema, outputSchema);
    assert.ok(events.some((e) => e.type === "run.output"));
    const plain = await x.client.submit(s.id, { text: "chat" });
    await x.kernel.wait(plain.runId);
    assert.ok(!names(x.wire.requests[2].body).includes("submit_result"));
  } finally {
    await x.close();
  }
});

test("non-object schemas are wrapped; missing results are reminded, then fail", async () => {
  const x = await setup((body) => {
    const reminded = JSON.stringify(body.messages).includes(
      "requires a structured result. Call",
    );
    return JSON.stringify(body.messages).includes("WRAP") && reminded
      ? { calls: [{ name: "submit_result", args: { result: ["a", "b"] } }] }
      : { text: "here is prose instead" };
  });
  try {
    const s = await x.session();
    const r = await x.client.submit(s.id, {
      text: "WRAP list",
      outputSchema: {
        $defs: { item: { type: "string" } },
        type: "array",
        items: { $ref: "#/$defs/item" },
      },
    });
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const run = await x.client.request<any>("GET", `/v1/runs/${r.runId}`);
    assert.deepEqual(run.output, ["a", "b"]);
    const before = x.wire.requests.length;
    const fresh = await x.session();
    const never = await x.client.submit(fresh.id, {
      text: "never",
      outputSchema: { type: "object", properties: {} },
    });
    const failed = await x.kernel.wait(never.runId);
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error), /without calling submit_result/);
    assert.equal(
      x.wire.requests.length - before,
      3,
      "two reminders, then fail",
    );
  } finally {
    await x.close();
  }
});

test("restrictive allowlists still offer submit_result; bad schemas and steering use are rejected", async () => {
  const x = await setup(
    () => ({ calls: [{ name: "submit_result", args: { ok: true } }] }),
    {
      routes: {
        text: {
          kind: "text",
          adapter: "openai-completions",
          model: "m",
          baseUrl: "http://127.0.0.1:1",
          contextWindow: 128000,
          toolAllowlist: ["file_read"],
        },
      },
    },
  );
  try {
    x.config.routes.text.baseUrl = x.wire.url + "/v1";
    const s = await x.session("code");
    const r = await x.client.submit(s.id, {
      text: "go",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    });
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.deepEqual(names(x.wire.requests[0].body).sort(), [
      "file_read",
      "submit_result",
    ]);
    await assert.rejects(
      x.client.submit(s.id, {
        text: "bad",
        outputSchema: {
          type: "object",
          properties: { a: { $ref: "http://x/y" } },
        },
      }),
      /400|External JSON schema/,
    );
    await assert.rejects(
      x.client.submit(s.id, {
        text: "steer",
        delivery: "steer",
        outputSchema: { type: "object" },
      }),
      /only accepted when starting a run/,
    );
  } finally {
    await x.close();
  }
});
