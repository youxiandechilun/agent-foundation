import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { performance } from "node:perf_hooks";
import type { MemoryEntry, Project, StoredMessage } from "../src/contracts.js";
import { parseConfig } from "../src/core/config.js";
import { Store } from "../src/storage/store.js";
import { MemoryStore } from "../src/storage/memory.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "foundation-storage-refactor-"));
  const config = parseConfig({
    dataDir: root,
    workspaceRoots: [root],
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
    },
  });
  const store = new Store(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ["project-a", "project-b"])
    store.put<Project>("projects", {
      id,
      name: id,
      root,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  return { root, store, config, memory: new MemoryStore(store, config) };
}

test("repeated storage operations preserve nested rollback, message identity and cross-connection visibility", (t) => {
  const { store, root } = fixture(t);
  const observer = new Store(root);
  try {
    for (let i = 0; i < 3; i++) {
      store.transaction(() => {
        store.put("sessions", { id: "session", name: `outer-${i}` });
        assert.throws(
          () =>
            store.transaction(() => {
              store.put("sessions", { id: "session", name: "inner" });
              assert.equal(
                store.get<{ name: string }>("sessions", "session").name,
                "inner",
              );
              throw Error("rollback nested write");
            }),
          /rollback nested/,
        );
        assert.equal(
          store.get<{ name: string }>("sessions", "session").name,
          `outer-${i}`,
        );
      });
      assert.equal(
        observer.get<{ name: string }>("sessions", "session").name,
        `outer-${i}`,
      );
      assert.throws(
        () =>
          store.transaction(() => {
            store.remove("sessions", "session");
            throw Error("rollback removal");
          }),
        /rollback removal/,
      );
    }
    const message: StoredMessage = {
      id: "message",
      runId: "run",
      message: { role: "user", content: "first", timestamp: 1 },
    };
    store.appendTranscript("session", message);
    store.appendTranscript("session", message);
    assert.throws(
      () =>
        store.saveTranscript("session", [
          message,
          {
            ...message,
            message: { role: "user", content: "conflict", timestamp: 2 },
          },
        ]),
      /reused/,
    );
    assert.deepEqual(observer.transcript("session"), [message]);
    assert.equal(observer.transcriptPage("session", 0, 1).hasMore, false);
    store.remove("sessions", "session");
    assert.equal(observer.find("sessions", "session"), undefined);
    assert.throws(() => observer.get("sessions", "session"), /not found/);
  } finally {
    observer.close();
  }
});

test("memory lookups preserve insertion order, expiry, revisions and project ownership after reopen", (t) => {
  const { root, store, config, memory } = fixture(t);
  const input = {
    projectId: "project-a",
    namespace: "target",
    content: "same fact",
  };
  const first = memory.put({ ...input, id: "first" });
  memory.put({ ...input, id: "second" });
  memory.put({ ...input, projectId: "project-b", id: "foreign" });
  memory.put({ ...input, namespace: "other", id: "other" });
  memory.put({
    ...input,
    content: "expired",
    id: "expired",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.deepEqual(memory.put(input), first);
  assert.deepEqual(
    memory.list("project-a", "target").map((entry) => entry.id),
    ["first", "second"],
  );
  assert.deepEqual(
    memory.list("project-a").map((entry) => entry.id),
    ["first", "second", "other"],
  );
  const changed = memory.put({
    ...input,
    id: first.id,
    tags: ["changed"],
    expectedRevision: 1,
  });
  assert.equal(changed.revision, 2);
  assert.equal(
    memory.put({ ...input, id: first.id, tags: ["changed"] }).revision,
    2,
  );
  assert.throws(
    () => memory.put({ ...input, id: first.id, expectedRevision: 1 }),
    /revision conflict/,
  );
  memory.remove(first.id, "project-a");
  assert.throws(
    () => memory.put({ ...input, id: first.id, projectId: "project-b" }),
    /another project/,
  );
  assert.equal(memory.pruneExpired("project-a").removed, 1);
  store.close();
  const reopened = new Store(root);
  try {
    const reopenedMemory = new MemoryStore(reopened, config);
    assert.equal(reopenedMemory.put({ ...input, id: first.id }).revision, 4);
    assert.deepEqual(
      reopenedMemory
        .history(first.id, "project-a")
        .map((entry) => entry.revision),
      [4, 3, 2, 1],
    );
    assert.deepEqual(reopenedMemory.history(first.id, "project-b"), []);
    assert.deepEqual(
      reopenedMemory
        .search("project-a", "same", 8, "target")
        .map((entry) => entry.id)
        .sort(),
      ["first", "second"],
    );
  } finally {
    reopened.close();
  }
});

test("memory import and proposals retain atomicity and project scope", (t) => {
  const { memory } = fixture(t);
  assert.throws(() =>
    memory.import("project-a", [
      { content: "must roll back" },
      { content: "" },
    ]),
  );
  assert.deepEqual(memory.list("project-a"), []);
  const imported = memory.import("project-a", [
    {
      id: "untrusted-id",
      projectId: "project-b",
      expectedRevision: 999,
      content: "imported fact",
    },
  ]);
  assert.equal(imported[0].projectId, "project-a");
  assert.notEqual(imported[0].id, "untrusted-id");
  assert.equal(imported[0].revision, 1);
  const input = { projectId: "project-a", content: "proposed fact" };
  const proposal = memory.propose(input);
  assert.equal(memory.propose(input).id, proposal.id);
  memory.propose({ ...input, projectId: "project-b" });
  assert.deepEqual(
    memory.proposals("project-a").map((entry) => entry.id),
    [proposal.id],
  );
  memory.resolve(proposal.id, true);
  assert.throws(() => memory.resolve(proposal.id, true), /already resolved/);
  assert.equal(memory.list("project-a").length, 2);
});

test("opening an existing database adds selective memory indexes without changing stored bodies", (t) => {
  const { root, store, memory } = fixture(t);
  const entry = memory.put({
    projectId: "project-a",
    content: "existing fact",
  });
  const before = store.db
    .prepare("SELECT kind,id,body FROM entities ORDER BY rowid")
    .all();
  store.db.exec(`
    DROP INDEX memories_project_namespace;
    DROP INDEX memory_revisions_latest;
    DROP INDEX memory_proposals_project;
  `);
  store.close();
  const reopened = new Store(root);
  try {
    assert.deepEqual(
      reopened.db
        .prepare("SELECT kind,id,body FROM entities ORDER BY rowid")
        .all(),
      before,
    );
    const plan = reopened.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM entities WHERE kind='memory-revisions' AND json_extract(body,'$.memoryId')=? ORDER BY json_extract(body,'$.revision') DESC LIMIT 1",
      )
      .all(entry.id);
    assert.ok(
      plan.some(
        (row) =>
          typeof row.detail === "string" &&
          row.detail.includes("memory_revisions_latest"),
      ),
    );
    assert.ok(
      plan.every(
        (row) =>
          typeof row.detail === "string" &&
          !row.detail.includes("SCAN ") &&
          !row.detail.includes("TEMP B-TREE"),
      ),
    );
  } finally {
    reopened.close();
  }
});

if (process.env.FOUNDATION_STORAGE_BENCHMARK === "1")
  test("storage benchmark: repeated reads and new memory IDs with 12000 historical revisions", (t) => {
    const { store, memory } = fixture(t);
    const entry: MemoryEntry = {
      id: "historical",
      projectId: "project-a",
      namespace: "default",
      revision: 1,
      content: "historical context ".repeat(20),
      tags: [],
      source: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const insert = store.db.prepare(
      "INSERT INTO entities(kind,id,body) VALUES(?,?,?)",
    );
    store.transaction(() => {
      for (let i = 0; i < 12000; i++)
        insert.run(
          "memory-revisions",
          `revision-${i}`,
          JSON.stringify({
            id: `revision-${i}`,
            memoryId: `history-${i % 1000}`,
            projectId: "project-a",
            revision: Math.floor(i / 1000) + 1,
            action: "updated",
            entry,
            recordedAt: entry.updatedAt,
          }),
        );
    });
    const measure = (operation: () => void) => {
      operation();
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        operation();
        samples.push(performance.now() - start);
      }
      return Number(samples.sort((a, b) => a - b)[2].toFixed(2));
    };
    const readsMs = measure(() => {
      for (let i = 0; i < 30000; i++) store.project("project-a");
    });
    let sequence = 0;
    const memoryWritesMs = measure(() => {
      for (let i = 0; i < 30; i++)
        memory.put({
          id: `new-${sequence++}`,
          projectId: "project-a",
          content: "new fact",
        });
    });
    t.diagnostic(
      JSON.stringify({
        reads: 30000,
        readsMedianMs: readsMs,
        memoryWrites: 30,
        historicalRevisions: 12000,
        memoryWritesMedianMs: memoryWritesMs,
        rounds: 5,
      }),
    );
  });
