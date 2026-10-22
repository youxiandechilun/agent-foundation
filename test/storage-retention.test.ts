import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type {
  FoundationEvent,
  Project,
  Run,
  Session,
  StoredMessage,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "foundation-retention-"));
  const store = new Store(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.put<Project>("projects", {
    id: "project",
    name: "project",
    root,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const session = (id: string, fields: Partial<Session> = {}) =>
    store.put<Session>("sessions", {
      id,
      projectId: "project",
      name: id,
      mode: "chat",
      routeId: "text",
      autonomy: "assist",
      createdAt: "2026-01-01T00:00:00.000Z",
      archived: false,
      ...fields,
    } as Session);
  const run = (id: string, status: Run["status"], updatedAt: string) =>
    store.put<Run>("runs", {
      id,
      sessionId: "session",
      status,
      createdAt: updatedAt,
      updatedAt,
    });
  session("session");
  return { store, root, session, run };
}

test("prune deletes old finished-run events and unreferenced caches only", (t) => {
  const { store, run } = fixture(t);
  run("old-done", "completed", "2026-01-01T00:00:00.000Z");
  run("old-active", "running", "2026-01-01T00:00:00.000Z");
  run("new-done", "completed", "2099-01-01T00:00:00.000Z");
  for (const runId of ["old-done", "old-active", "new-done"])
    for (let i = 0; i < 5; i++) store.emit(runId, "test.event", { i });
  store.write("summaries", {
    id: "old-unreferenced",
    summary: "a",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.write("summaries", {
    id: "old-referenced",
    summary: "b",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.write("summaries", {
    id: "text:session:latest-summary",
    summaryId: "old-referenced",
    sourceHash: "x",
    omittedMessages: 1,
  });
  store.write("work-contexts", {
    id: "old-done",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const cutoff = "2026-06-01T00:00:00.000Z";
  // Kept categories are untouched when no cutoff is given.
  assert.deepEqual(store.prune({}), {
    events: 0,
    summaries: 0,
    workContexts: 0,
  });
  // A batch of 2 exercises the repeated bounded deletes.
  assert.deepEqual(store.prune({ events: cutoff, caches: cutoff }, 2), {
    events: 5,
    summaries: 1,
    workContexts: 1,
  });
  assert.equal(store.replay("old-done").length, 0);
  assert.equal(store.replay("old-active").length, 5);
  assert.equal(store.replay("new-done").length, 5);
  assert.ok(store.find("summaries", "old-referenced"));
  assert.equal(store.find("summaries", "old-unreferenced"), undefined);
  // Runs themselves are kept.
  assert.equal(store.run("old-done").status, "completed");
});

test("emitted events reuse one wire serialization equal to JSON.stringify", (t) => {
  const { store, run } = fixture(t);
  run("run", "running", "2026-01-01T00:00:00.000Z");
  const received: FoundationEvent[] = [];
  store.events.on("run", (event: FoundationEvent) => received.push(event));
  const durable = store.emit("run", "durable", { text: "a", n: 1 });
  store.emit("run", "ephemeral", { text: "b" }, false);
  const prepared = store.emit(
    "run",
    "prepared",
    { message: { text: "c" } },
    true,
    '{"message":{"text":"c"}}',
  );
  assert.equal(received.length, 3);
  for (const event of received)
    assert.equal(store.eventJson(event), JSON.stringify(event));
  assert.deepEqual(prepared.data, { message: { text: "c" } });
  // Stored bodies replay to the same events.
  assert.deepEqual(
    store.replay("run").map((event) => event.data),
    [durable.data, prepared.data],
  );
});

test("pre-serialized transcript messages store the same row as plain appends", (t) => {
  const { store, session } = fixture(t);
  session("other");
  const message: StoredMessage = {
    id: "m1",
    runId: "run",
    message: { role: "user", content: "hello", timestamp: 1 },
  };
  store.appendTranscript("session", message);
  store.appendTranscript("other", message, JSON.stringify(message.message));
  const body = (sessionId: string) =>
    (
      store
        .prepare("SELECT body FROM messages WHERE session_id=?")
        .get(sessionId) as { body: string }
    ).body;
  assert.equal(body("other"), body("session"));
  // Re-appending identical content is idempotent through either path.
  store.appendTranscript("session", message, JSON.stringify(message.message));
  assert.equal(store.transcript("session").length, 1);
});

test("transcript version changes on every insert and suffix rewrite", (t) => {
  const { store } = fixture(t);
  const message = (id: string, content: string): StoredMessage => ({
    id,
    runId: "run",
    message: { role: "user", content, timestamp: 1 },
  });
  const empty = store.transcriptVersion("session");
  store.appendTranscript("session", message("a", "1"));
  const one = store.transcriptVersion("session");
  assert.notEqual(one, empty);
  store.saveTranscript("session", [message("a", "1"), message("b", "2")]);
  const two = store.transcriptVersion("session");
  assert.notEqual(two, one);
  // Same length, different content: the rewritten suffix gets new sequence numbers.
  store.saveTranscript("session", [message("a", "1"), message("c", "3")]);
  assert.notEqual(store.transcriptVersion("session"), two);
});

test("cost totals aggregate in SQL like the per-entry summary", (t) => {
  const { store } = fixture(t);
  const entries = [
    { status: "settled", chargedMicros: 10, reservedMicros: 50 },
    { status: "reserved", reservedMicros: 20 },
    { status: "unknown", reservedMicros: 30, basis: "unpriced" },
    { status: "void", chargedMicros: 0, reservedMicros: 40 },
  ];
  entries.forEach((entry, i) =>
    store.write("cost-ledger", {
      id: `cost-${i}`,
      sessionId: "session",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...entry,
    }),
  );
  assert.deepEqual(
    { ...store.costTotals({ sessionId: "session" }) },
    {
      count: 4,
      chargedMicros: 10,
      heldMicros: 50,
      committedMicros: 60,
      unpriced: 1,
    },
  );
  assert.equal(store.costTotals({ sessionId: "missing" }).count, 0);
});

test("session filters on nested team fields match the JSON values", (t) => {
  const { store, session } = fixture(t);
  session("member", {
    teamRootSessionId: "session",
    teamMemberId: "agent",
    collaboration: { teamId: "team" },
  } as Partial<Session>);
  assert.deepEqual(
    store
      .list<Session>("sessions", { "collaboration.teamId": "team" })
      .map((s) => s.id),
    ["member"],
  );
  assert.equal(
    store.count("sessions", {
      teamRootSessionId: "session",
      teamMemberId: "agent",
    }),
    1,
  );
  assert.equal(store.count("sessions", { routeId: "text" }), 2);
});
