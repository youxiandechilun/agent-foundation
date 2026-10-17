import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { setup, collect, until } from "./support/wire-server.js";
import { HttpTextProvider } from "../src/providers/text.js";
import { ToolRegistry } from "../src/runtime/registry.js";
import { TokenCounterRegistry } from "../src/runtime/token-counter.js";

test("automatic memory is excluded from a fallback model that denies memory reads", async () => {
  const x = await setup();
  const failed = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"retry"}}');
  });
  await new Promise<void>((r) => failed.listen(0, "127.0.0.1", r));
  try {
    x.kernel.memory.put({
      projectId: x.project.id,
      content: "violet granite private stored preference",
    });
    x.config.routes.secondary = {
      ...x.config.routes.text,
      capabilityPolicies: { "memory.read": "deny" },
    };
    x.config.routes.text.baseUrl = `http://127.0.0.1:${(failed.address() as any).port}`;
    x.config.routes.text.fallbackRouteIds = ["secondary"];
    const s = await x.session();
    const { runId } = await x.client.submit(s.id, { text: "violet granite" });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.equal(x.wire.requests.length, 1);
    assert.ok(
      !JSON.stringify(x.wire.requests[0].body).includes(
        "private stored preference",
      ),
    );
  } finally {
    await x.close();
    failed.closeAllConnections();
    await new Promise<void>((r) => failed.close(() => r()));
  }
});

test("fallback context is budgeted for the actual smaller model before sending its request", async () => {
  const x = await setup();
  const failed = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"retry elsewhere"}}');
  });
  await new Promise<void>((r) => failed.listen(0, "127.0.0.1", r));
  try {
    x.config.routes.small = {
      ...x.config.routes.text,
      contextWindow: 4096,
      maxOutputTokens: 128,
    };
    x.config.routes.text.baseUrl = `http://127.0.0.1:${(failed.address() as any).port}`;
    x.config.routes.text.fallbackRouteIds = ["small"];
    const s = await x.session();
    const { runId } = await x.client.submit(s.id, {
      text: "large-input ".repeat(1000),
    });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "failed");
    assert.equal(
      x.wire.requests.length,
      0,
      "oversized context reached fallback model",
    );
  } finally {
    await x.close();
    failed.closeAllConnections();
    await new Promise<void>((r) => failed.close(() => r()));
  }
});

test("Responses argument deltas are emitted before the completed tool declaration", async () => {
  const deltas: any[] = [];
  const x = await setup();
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type: string, value: any) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      );
    event("response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc_item",
        type: "function_call",
        call_id: "call_live",
        name: "probe",
        arguments: "",
      },
    });
    event("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_item",
      delta: '{"value":',
    });
    event("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_item",
      delta: '"actual"}',
    });
    event("response.output_item.done", {
      output_index: 0,
      item: {
        id: "fc_item",
        type: "function_call",
        call_id: "call_live",
        name: "probe",
        arguments: '{"value":"actual"}',
      },
    });
    event("response.completed", { response: { id: "r", output: [] } });
    res.end();
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  try {
    const route = {
      ...x.config.routes.text,
      adapter: "openai-responses" as const,
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}`,
    };
    const result = await new HttpTextProvider("responses", route).complete(
      { routeId: "responses", messages: [], tools: [] },
      (d) => {
        deltas.push(d);
      },
    );
    assert.equal(
      deltas
        .filter((d) => d.type === "tool-arguments")
        .map((d) => d.text)
        .join(""),
      '{"value":"actual"}',
    );
    assert.equal(
      (result.content.find((p) => p.type === "toolCall") as any).arguments
        .value,
      "actual",
    );
  } finally {
    await x.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});

test("session message budgets stop before another model call and keep the executed tool result", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            {
              name: "file_write",
              args: { path: "quota.txt", content: "actual write" },
            },
          ],
        }
      : { text: "would overflow history" },
  );
  try {
    x.config.limits.maxSessionMessages = 3;
    const s = await x.session("code"),
      { runId } = await x.client.submit(s.id, { text: "write once" });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "failed");
    assert.equal(x.wire.requests.length, 1);
    assert.equal(x.kernel.store.transcript(s.id).length, 3);
    assert.equal(
      (await readFile(path.join(x.project.root, "quota.txt"))).toString(),
      "actual write",
    );
  } finally {
    await x.close();
  }
});

test("steering between tools skips remaining effects and records matching results before continuing", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            { name: "wait_for_steering", args: {} },
            {
              name: "file_write",
              args: { path: "stale-write.txt", content: "old instruction" },
            },
          ],
        }
      : { text: "followed the updated instruction" },
  );
  let release!: () => void,
    entered = false;
  try {
    x.kernel.toolRegistry.register("pause", () => [
      {
        name: "wait_for_steering",
        description: "pause actual execution",
        parameters: { type: "object" },
        risk: "read",
        capabilities: [],
        execute: async () => {
          entered = true;
          await new Promise<void>((r) => {
            release = r;
          });
          return { content: [{ type: "text", text: "ready" }] };
        },
      },
    ]);
    const s = await x.session("code"),
      { runId } = await x.client.submit(s.id, { text: "inspect then write" });
    await until(() => entered || undefined);
    await x.client.submit(s.id, {
      text: "Change of instruction: do not write that file",
      delivery: "steer",
    });
    release();
    const events = await collect(x.client, runId);
    await assert.rejects(
      readFile(path.join(x.project.root, "stale-write.txt")),
      /ENOENT/,
    );
    assert.ok(events.some((e) => e.type === "tool.skipped"));
    const messages = x.kernel.store.transcript(s.id);
    assert.equal(
      messages.filter((m) => m.message.role === "toolResult").length,
      2,
    );
    assert.equal(x.wire.requests.length, 2);
  } finally {
    release?.();
    await x.close();
  }
});

test("old registration disposers cannot revoke replacement tools or counters", async () => {
  const tools = new ToolRegistry();
  const old = tools.register("one", () => []);
  old();
  tools.register("one", () => []);
  old();
  assert.deepEqual(tools.list(), ["one"]);
  const counters = new TokenCounterRegistry();
  const remove = counters.register({
    id: "one",
    precision: "estimate",
    count: () => 1,
  });
  remove();
  counters.register({ id: "one", precision: "exact", count: () => 2 });
  remove();
  assert.equal(counters.get("one")?.precision, "exact");
});

test("escaped configured secrets never enter model inputs or durable tool effect results", async () => {
  const secret = 'vendor-value-"quoted"-\\backslash-12345';
  process.env.AUDIT_ESCAPED_KEY = secret;
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "reveal_test_value", args: {} }] }
      : { text: "done" },
  );
  try {
    x.kernel.toolRegistry.register("secret-test", () => [
      {
        name: "reveal_test_value",
        description: "fixture",
        parameters: { type: "object" },
        risk: "read",
        capabilities: [],
        execute: async () => ({
          content: [
            { type: "text", text: JSON.stringify({ credential: secret }) },
          ],
          details: { secret },
        }),
      },
    ]);
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "test redaction" });
    await collect(x.client, runId);
    const effect = x.kernel.store
      .list<any>("effects")
      .find((e) => e.runId === runId);
    assert.ok(
      !JSON.stringify(x.wire.requests.at(-1).body).includes(
        JSON.stringify(secret).slice(1, -1),
      ),
    );
    assert.ok(
      !JSON.stringify(effect.result).includes(
        JSON.stringify(secret).slice(1, -1),
      ),
    );
  } finally {
    delete process.env.AUDIT_ESCAPED_KEY;
    await x.close();
  }
});
