import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/storage/store.js";
import type { StoredMessage } from "../src/contracts.js";
import { setup } from "./support/wire-server.js";

test("indexed entity queries upgrade existing JSON data and preserve ordering, rollback and connection visibility", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "foundation-query-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = new DatabaseSync(path.join(root, "foundation.sqlite"));
  original.exec(
    "CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
  );
  const insert = original.prepare("INSERT INTO entities VALUES('runs',?,?)");
  for (const [id, sessionId, status] of [
    ["a", "s", "queued"],
    ["b", "other", "queued"],
    ["c", "s", "completed"],
    ["empty", "", "queued"],
  ])
    insert.run(id, JSON.stringify({ id, sessionId, status }));
  original.close();
  const store = new Store(root),
    observer = new Store(root);
  try {
    const ids = (scope = { sessionId: "s" }) =>
      store.list<{ id: string }>("runs", scope).map((row) => row.id);
    assert.deepEqual(ids(), ["a", "c"]);
    assert.deepEqual(ids({ sessionId: "" }), ["empty"]);
    assert.equal(store.count("runs", { status: ["queued", "completed"] }), 4);
    assert.equal(store.count("runs", { status: [] }), 0);
    assert.equal(store.count("runs", { sessionId: "s", status: "queued" }), 1);
    assert.deepEqual(
      store
        .list<{ id: string }>(
          "runs",
          {},
          { descending: true, limit: 2, offset: 1 },
        )
        .map((row) => row.id),
      ["c", "b"],
    );
    store.put("runs", { id: "a", sessionId: "s", status: "running" });
    assert.deepEqual(ids(), ["a", "c"]);
    assert.equal(observer.count("runs", { status: "running" }), 1);
    assert.throws(
      () =>
        store.transaction(() => {
          store.put("runs", { id: "a", sessionId: "other", status: "failed" });
          assert.deepEqual(ids(), ["c"]);
          throw Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(observer.count("runs", { sessionId: "s" }), 2);
    assert.throws(
      () =>
        Reflect.apply(store.list, store, ["runs", { "id') OR 1=1 --": "s" }]),
      /Unknown entity filter/,
    );
    assert.throws(
      () => Reflect.apply(store.count, store, ["runs", { sessionId: 1 }]),
      /Invalid entity filter/,
    );
    assert.throws(
      () => store.list("runs", {}, { limit: 0 }),
      /Invalid entity page/,
    );
    assert.deepEqual(ids({ sessionId: "' OR 1=1 --" }), []);
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM entities WHERE kind=? AND json_extract(body,'$.sessionId') IN (?) ORDER BY rowid LIMIT ? OFFSET ?",
      )
      .all("runs", "s", 2, 0);
    assert.match(JSON.stringify(plan), /entities_sessionId/);
  } finally {
    observer.close();
    store.close();
  }
});

test("transcript windows and last assistant use canonical sequence and run ownership", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "foundation-transcript-query-"));
  const store = new Store(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const messages: StoredMessage[] = Array.from({ length: 80 }, (_, index) => ({
    id: "m" + index,
    runId: index % 2 ? "one" : "two",
    message:
      index % 3
        ? { role: "user", content: String(index), timestamp: index }
        : {
            role: "assistant",
            model: "fixture",
            provider: "fixture",
            content: [{ type: "text", text: String(index) }],
            timestamp: index,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
            },
            stopReason: "stop",
          },
  }));
  store.saveTranscript("session", messages);
  store.saveTranscript("foreign", [{ ...messages[0], id: "foreign-last" }]);
  assert.deepEqual(store.transcriptSlice("session", 12, 8), {
    total: 80,
    offset: 12,
    messages: messages.slice(12, 20),
    hasMore: true,
  });
  assert.deepEqual(store.transcriptSlice("session", 100, 8), {
    total: 80,
    offset: 100,
    messages: [],
    hasMore: false,
  });
  assert.deepEqual(
    store.lastAssistant("session", "one"),
    messages
      .filter((m) => m.runId === "one" && m.message.role === "assistant")
      .at(-1),
  );
  assert.equal(store.lastAssistant("session", "missing"), undefined);
  assert.throws(
    () => store.transcriptSlice("session", -1, 8),
    /Invalid entity page/,
  );
  store.saveTranscript("session", messages.slice(0, 4));
  assert.deepEqual(store.lastAssistant("session", "one"), messages[3]);
});

test("cost aggregate preserves void, unknown, settlement, UTC day and atomic budget enforcement", async () => {
  const x = await setup();
  const { store, costs } = x.kernel;
  try {
    for (const [
      id,
      status,
      reservedMicros,
      chargedMicros,
      projectId,
      createdAt,
    ] of [
      ["held", "reserved", 40, undefined, x.project.id, "2026-10-17T23:59:59Z"],
      ["unknown", "unknown", 30, 99, x.project.id, "2026-10-18T00:00:00Z"],
      ["void", "void", 1000, 1000, x.project.id, "2026-10-18T00:00:00Z"],
      ["settled", "settled", 100, 20, x.project.id, "2026-10-18T00:00:00Z"],
      ["other", "settled", 100, 500, "other", "2026-10-18T00:00:00Z"],
    ] as const)
      store.put("cost-ledger", {
        id,
        status,
        reservedMicros,
        chargedMicros,
        projectId,
        createdAt,
        purpose: "query-test",
      });
    assert.equal(
      store.committedCost({ projectId: x.project.id }),
      costs.summary({ projectId: x.project.id }).committedMicros,
    );
    assert.equal(store.committedCost({ projectId: x.project.id }), 90);
    assert.equal(
      store.committedCost({ projectId: x.project.id }, "2026-10-18"),
      50,
    );
    assert.equal(store.committedCost({}, "2026-10-18"), 550);
    assert.equal(store.committedCost({ projectId: "absent" }), 0);
    assert.equal(costs.entries({ purpose: "query-test" }).length, 5);
    const route = {
      ...x.config.routes.text,
      pricing: {
        currency: "USD" as const,
        inputPerMillion: 0,
        outputPerMillion: 0,
        requestUsd: 0,
      },
    };
    x.config.budgets = { enabled: true, maxProjectUsd: 0.0001 };
    costs.reserve(
      "text",
      route,
      { projectId: x.project.id, purpose: "budget" },
      10,
    );
    assert.throws(
      () =>
        costs.reserve(
          "text",
          route,
          { projectId: x.project.id, purpose: "budget" },
          1,
        ),
      /budget exhausted/,
    );
    assert.equal(store.count("cost-ledger"), 6);
    store.transaction(() => {
      for (let i = 0; i < 1025; i++)
        store.put("cost-ledger", {
          id: `large-${i}`,
          projectId: x.project.id,
          status: "settled",
          chargedMicros: Number.MAX_SAFE_INTEGER,
        });
    });
    assert.throws(
      () =>
        costs.reserve(
          "text",
          route,
          { projectId: x.project.id, purpose: "overflow" },
          0,
        ),
      { code: "cost_budget_exhausted" },
    );
    assert.equal(store.count("cost-ledger"), 1031);
  } finally {
    await x.close();
  }
});

test("unknown MCP DELETE operation cannot remove the server and indexed API views remain scoped", async () => {
  const x = await setup();
  try {
    const server = await x.client.request<{ id: string }>("POST", "/v1/mcp", {
      id: "preserved",
      name: "preserved",
      transport: "http",
      url: "http://127.0.0.1:1",
      enabled: false,
    });
    await assert.rejects(
      x.client.request("DELETE", `/v1/mcp/${server.id}/unknown-operation`),
      /404/,
    );
    assert.equal(x.kernel.mcp.get(server.id).id, server.id);
    const session = await x.session("code");
    x.kernel.store.put("runs", {
      id: "included",
      sessionId: session.id,
      status: "completed",
    });
    x.kernel.store.put("runs", {
      id: "excluded",
      sessionId: "foreign",
      status: "completed",
    });
    const result = await x.client.request<{ runs: { id: string }[] }>(
      "GET",
      `/v1/sessions/${session.id}`,
    );
    assert.deepEqual(
      result.runs.map((run) => run.id),
      ["included"],
    );
  } finally {
    await x.close();
  }
});
