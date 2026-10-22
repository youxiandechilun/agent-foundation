import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/storage/store.js";
import {
  committedCostExpression,
  effectWhere,
} from "../src/storage/entity-query.js";
import type { StoredMessage } from "../src/contracts.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(
    path.join(tmpdir(), "foundation-storage-performance-"),
  );
  const store = new Store(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}
const message = (index: number, content = String(index)): StoredMessage => ({
  id: "m" + index,
  runId: "run",
  message: { role: "user", content, timestamp: index },
});

test("cost index upgrade preserves ordering, sequences and custom triggers", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "foundation-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = new DatabaseSync(path.join(root, "foundation.sqlite"));
  original.exec(
    "PRAGMA page_size=4096; CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,message_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(session_id,message_id))",
  );
  original
    .prepare(
      "INSERT INTO entities(rowid,kind,id,body) VALUES(3,'sessions','b',?)",
    )
    .run(JSON.stringify({ id: "b", projectId: "p" }));
  original
    .prepare(
      "INSERT INTO entities(rowid,kind,id,body) VALUES(90,'sessions','a',?)",
    )
    .run(JSON.stringify({ id: "a", projectId: "p" }));
  original
    .prepare("INSERT INTO messages VALUES(19,'s','m0',?)")
    .run(JSON.stringify(message(0)));
  original.close();
  const legacyCosts = new DatabaseSync(path.join(root, "foundation.sqlite"));
  legacyCosts.exec(
    "CREATE TABLE e_effects(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE INDEX e_effects_status ON e_effects(json_extract(body,'$.status'))",
  );
  legacyCosts.exec(
    "CREATE TABLE e_cost_ledger(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE INDEX e_cost_ledger_projectId ON e_cost_ledger(json_extract(body,'$.projectId')); CREATE TABLE custom_cost_audit(id TEXT); CREATE TRIGGER custom_cost_update AFTER UPDATE ON e_cost_ledger BEGIN INSERT INTO custom_cost_audit VALUES(new.id); END",
  );
  legacyCosts
    .prepare("INSERT INTO e_cost_ledger(rowid,id,body) VALUES(90,'cost-a',?)")
    .run(
      JSON.stringify({
        id: "cost-a",
        projectId: "p",
        status: "settled",
        chargedMicros: 4,
      }),
    );
  legacyCosts
    .prepare("INSERT INTO e_cost_ledger(rowid,id,body) VALUES(3,'cost-b',?)")
    .run(
      JSON.stringify({
        id: "cost-b",
        projectId: "p",
        status: "settled",
        chargedMicros: 2,
      }),
    );
  legacyCosts.close();
  const active = new Store(root);
  assert.equal(active.db.prepare("PRAGMA page_size").get()!.page_size, 4096);
  assert.match(
    String(
      active.db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='e_effects_status'")
        .get()!.sql,
    ),
    /WHERE/,
  );
  assert.deepEqual(
    active
      .list<{ id: string }>("cost-ledger", { projectId: "p" })
      .map((x) => x.id),
    ["cost-b", "cost-a"],
  );
  assert.equal(active.committedCost({ projectId: "p" }), 6);
  assert.equal(
    active.db.prepare("SELECT seq FROM e_cost_ledger WHERE id='cost-a'").get()!
      .seq,
    90,
  );
  assert.equal(
    active.db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE name='e_cost_ledger_projectId'",
      )
      .get(),
    undefined,
  );
  active.db
    .prepare("UPDATE e_cost_ledger SET body=body WHERE id='cost-a'")
    .run();
  assert.equal(
    active.db.prepare("SELECT id FROM custom_cost_audit").get()!.id,
    "cost-a",
  );
  assert.equal(active.transcriptSlice("s", 0, 10).total, 1);
  active.close();
  const converted = new Store(root);
  try {
    assert.deepEqual(
      converted.list<{ id: string }>("sessions").map((x) => x.id),
      ["b", "a"],
    );
    assert.equal(
      converted.db
        .prepare("SELECT seq FROM messages WHERE message_id='m0'")
        .get()!.seq,
      19,
    );
    converted.appendTranscript("s", message(1));
    assert.equal(converted.transcriptSlice("s", 0, 10).total, 2);
    assert.equal(
      converted.db.prepare("PRAGMA journal_mode").get()!.journal_mode,
      "wal",
    );
    assert.equal(
      converted.db.prepare("PRAGMA synchronous").get()!.synchronous,
      2,
    );
    assert.equal(
      converted.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    assert.equal(
      converted.db.prepare("PRAGMA page_size").get()!.page_size,
      4096,
    );
    assert.equal(
      converted.db.prepare("PRAGMA cache_size").get()!.cache_size,
      -8192,
    );
  } finally {
    converted.close();
  }
});

test("project budgets use covered values and stay exact across raw changes, rollback and index repair", (t) => {
  const { store, root } = fixture(t);
  const entries = [
    { id: "reserved", status: "reserved", reservedMicros: 40 },
    { id: "unknown", status: "unknown", reservedMicros: 30, chargedMicros: 99 },
    {
      id: "settled",
      status: "settled",
      reservedMicros: 100,
      chargedMicros: 20,
    },
    { id: "void", status: "void", reservedMicros: 1000, chargedMicros: 1000 },
    { id: "missing-charge", status: "settled", reservedMicros: 50 },
  ];
  store.transaction(() => {
    for (const entry of entries)
      store.write("cost-ledger", {
        projectId: "p",
        sessionId: "s",
        runId: "r",
        createdAt: "2026-10-22T00:00:00Z",
        ...entry,
      });
  });
  const explain = (day: boolean) =>
    JSON.stringify(
      store.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT TOTAL(${committedCostExpression}) FROM e_cost_ledger WHERE json_extract(body,'$.projectId') IN (?)${day ? " AND substr(json_extract(body,'$.createdAt'),1,10)=?" : ""}`,
        )
        .all("p", ...(day ? ["2026-10-22"] : [])),
    );
  assert.match(explain(false), /cost_ledger_project_budget/);
  assert.match(explain(true), /cost_ledger_project_budget/);
  const listPlan = JSON.stringify(
    store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM e_cost_ledger WHERE json_extract(body,'$.projectId') IN (?) ORDER BY rowid LIMIT ? OFFSET ?",
      )
      .all("p", 20, 0),
  );
  assert.match(listPlan, /cost_ledger_project_budget/);
  assert.doesNotMatch(listPlan, /TEMP B-TREE/);
  assert.equal(store.committedCost({ projectId: "p" }), 90);
  assert.equal(
    store.committedCost({ projectId: ["p", "missing"] }, "2026-10-22"),
    90,
  );
  assert.equal(store.committedCost({ projectId: [] }), 0);
  assert.equal(store.committedCost({ sessionId: "s", runId: "r" }), 90);
  const observer = new Store(root);
  try {
    store.db
      .prepare(
        "UPDATE e_cost_ledger SET body=json_set(body,'$.status','settled','$.chargedMicros',70) WHERE id='reserved'",
      )
      .run();
    assert.equal(observer.committedCost({ projectId: "p" }), 120);
    assert.throws(
      () =>
        store.transaction(() => {
          store.db
            .prepare(
              "UPDATE e_cost_ledger SET body=json_set(body,'$.projectId','other') WHERE id='reserved'",
            )
            .run();
          assert.equal(store.committedCost({ projectId: "p" }), 50);
          throw Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(observer.committedCost({ projectId: "p" }), 120);
    store.db
      .prepare(
        "UPDATE e_cost_ledger SET body=json_set(body,'$.createdAt','2026-10-23T00:00:00Z') WHERE id='reserved'",
      )
      .run();
    assert.equal(observer.committedCost({ projectId: "p" }, "2026-10-22"), 50);
    assert.equal(observer.committedCost({ projectId: "p" }, "2026-10-23"), 70);
    store.remove("cost-ledger", "reserved");
    assert.equal(observer.committedCost({ projectId: "p" }), 50);
  } finally {
    observer.close();
  }
  store.db.exec("DROP INDEX cost_ledger_project_budget");
  const repaired = new Store(root);
  try {
    assert.ok(
      repaired.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='cost_ledger_project_budget'",
        )
        .get(),
    );
    assert.equal(repaired.committedCost({ projectId: "p" }), 50);
    repaired.write("cost-ledger", {
      id: "overflow",
      projectId: "p",
      status: "settled",
      chargedMicros: Number.MAX_SAFE_INTEGER,
    });
    assert.throws(() => repaired.committedCost({ projectId: "p" }), {
      code: "cost_budget_exhausted",
    });
  } finally {
    repaired.close();
  }
});

test("effects project filtering remains indexed after updates, rollback and missing-index repair", (t) => {
  const { store, root } = fixture(t);
  store.transaction(() => {
    for (let i = 0; i < 400; i++)
      store.write("effects", {
        id: "e" + i,
        projectId: "p" + (i % 4),
        runId: "r",
        status: "settled",
      });
  });
  assert.equal(store.count("effects", { projectId: "p1" }), 100);
  store.write("effects", {
    id: "pending-a",
    projectId: "p",
    runId: "r",
    status: "running",
  });
  store.write("effects", {
    id: "pending-b",
    projectId: "p",
    runId: "r",
    status: "prepared",
  });
  for (const status of [
    ["running", "prepared"],
    ["prepared", "running"],
    ["running"],
    "prepared",
  ] as const) {
    const where = effectWhere({ status });
    const plan = store.db
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM e_effects" + where.sql)
      .all(...where.values);
    assert.match(JSON.stringify(plan), /e_effects_status/);
    assert.equal(
      store.count("effects", { status }),
      typeof status === "string" || status.length === 1 ? 1 : 2,
    );
  }
  assert.equal(store.count("effects", { status: "settled" }), 400);
  store.recover();
  assert.equal(store.count("effects", { status: ["running", "prepared"] }), 0);
  assert.equal(
    store.get<{ status: string }>("effects", "pending-a").status,
    "unknown",
  );
  assert.equal(
    store.get<{ status: string }>("effects", "pending-b").status,
    "unknown",
  );
  store.remove("effects", "pending-a");
  store.remove("effects", "pending-b");
  const explain = (connection: Store) =>
    JSON.stringify(
      connection.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM e_effects WHERE json_extract(body,'$.projectId') IN (?)",
        )
        .all("p1"),
    );
  assert.match(explain(store), /e_effects_projectId/);
  assert.doesNotMatch(explain(store), /SCAN e_effects/);
  assert.throws(
    () =>
      store.transaction(() => {
        store.write("effects", { id: "e1", projectId: "p2" });
        assert.equal(store.count("effects", { projectId: "p1" }), 99);
        throw Error("rollback");
      }),
    /rollback/,
  );
  assert.equal(store.count("effects", { projectId: "p1" }), 100);
  store.db.exec("DROP INDEX e_effects_projectId");
  const observer = new Store(root);
  try {
    assert.match(explain(observer), /e_effects_projectId/);
    assert.equal(observer.count("effects", { projectId: "p1" }), 100);
  } finally {
    observer.close();
  }
});

test("transcript replacement preserves prefix sequences, unique identities and atomic conflicts", (t) => {
  const { store } = fixture(t);
  const history = Array.from({ length: 80 }, (_, i) => message(i));
  store.saveTranscript("history", history);
  const sequences = () =>
    store.db
      .prepare("SELECT seq FROM messages WHERE session_id=? ORDER BY seq")
      .all("history");
  const before = sequences();
  const changes = () =>
    Number(store.db.prepare("SELECT total_changes() AS n").get()!.n);
  const unchanged = changes();
  store.saveTranscript("history", history);
  assert.equal(changes(), unchanged);
  assert.deepEqual(sequences(), before);
  const updated = history.map((row, i) =>
    i < 70 ? row : message(i, "updated"),
  );
  const initial = changes();
  store.saveTranscript("history", updated);
  // Ten deletions and ten inserts, each updating the transactional count once.
  assert.equal(changes() - initial, 40);
  assert.deepEqual(sequences().slice(0, 70), before.slice(0, 70));
  store.saveTranscript("history", [
    updated[0],
    updated[0],
    ...updated.slice(1),
  ]);
  assert.deepEqual(store.transcript("history"), updated);
  assert.throws(
    () => store.saveTranscript("history", [...updated, message(0, "conflict")]),
    /reused/,
  );
  assert.deepEqual(store.transcript("history"), updated);
  store.saveTranscript("history", [message(99), ...updated.slice(10, 20)]);
  assert.deepEqual(store.transcript("history"), [
    message(99),
    ...updated.slice(10, 20),
  ]);
  store.saveTranscript("history", []);
  assert.deepEqual(store.transcript("history"), []);
});

test("redacted storage observes credential addition, rotation and deletion between synchronous calls", (t) => {
  const { store } = fixture(t);
  const name = "FOUNDATION_STORAGE_PERF_SECRET",
    previous = process.env[name];
  const first = 'storage-first-"\\\ncredential',
    second = "storage-second-credential";
  try {
    process.env[name] = first;
    const original = message(1, first),
      snapshot = structuredClone(original);
    store.saveTranscript("history", [original]);
    assert.equal(store.transcript("history")[0].message.content, "[REDACTED]");
    assert.deepEqual(original, snapshot);
    process.env[name] = second;
    store.saveTranscript("history", [message(1, second)]);
    assert.equal(store.transcript("history")[0].message.content, "[REDACTED]");
    store.transaction(() => {
      store.write("effects", { id: "one", value: second });
      process.env[name] = first;
      store.write("effects", { id: "two", value: first });
    });
    assert.equal(
      store.get<{ value: string }>("effects", "one").value,
      "[REDACTED]",
    );
    assert.equal(
      store.get<{ value: string }>("effects", "two").value,
      "[REDACTED]",
    );
    delete process.env[name];
    store.saveTranscript("history", [message(1, second)]);
    assert.equal(store.transcript("history")[0].message.content, second);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("transcript counts follow raw SQL, cross-connection changes, moves and trigger repair", (t) => {
  const { store, root } = fixture(t);
  const put = store.db.prepare(
    "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
  );
  for (let i = 0; i < 12; i++)
    put.run("a", "m" + i, JSON.stringify(message(i)));
  const observer = new Store(root);
  try {
    const total = (sessionId: string) =>
      observer.transcriptSlice(sessionId, 0, 2).total;
    assert.equal(total("a"), 12);
    assert.equal(total("b"), 0);
    store.db
      .prepare(
        "UPDATE messages SET session_id=? WHERE session_id=? AND message_id=?",
      )
      .run("b", "a", "m0");
    assert.equal(total("a"), 11);
    assert.equal(total("b"), 1);
    store.db
      .prepare(
        "INSERT OR REPLACE INTO messages(session_id,message_id,body) VALUES(?,?,?)",
      )
      .run("a", "m1", JSON.stringify(message(1, "replaced")));
    assert.equal(total("a"), 11);
    store.db
      .prepare(
        "INSERT OR IGNORE INTO messages(session_id,message_id,body) VALUES(?,?,?)",
      )
      .run("a", "m1", JSON.stringify(message(1, "ignored")));
    assert.equal(total("a"), 11);
    assert.equal(
      store.transcript("a").find((row) => row.id === "m1")?.message.content,
      "replaced",
    );
    assert.throws(
      () =>
        store.transaction(() => {
          store.db.prepare("DELETE FROM messages WHERE session_id=?").run("a");
          assert.equal(store.transcriptSlice("a", 0, 2).total, 0);
          throw Error("rollback count");
        }),
      /rollback count/,
    );
    assert.equal(total("a"), 11);
    store.db.exec("DROP TRIGGER messages_count_insert");
    put.run("a", "extra", JSON.stringify(message(20)));
    const repaired = new Store(root);
    try {
      assert.equal(repaired.transcriptSlice("a", 0, 2).total, 12);
      store.appendTranscript("a", message(21));
      assert.equal(repaired.transcriptSlice("a", 0, 2).total, 13);
    } finally {
      repaired.close();
    }
  } finally {
    observer.close();
  }
});

test("JSON read statements preserve named public rows and body aliases in any column position", (t) => {
  const { store } = fixture(t);
  store.write("sessions", { id: "s", projectId: "p", name: "before" });
  const sql = "SELECT id,body FROM e_sessions WHERE id=?";
  assert.equal(
    store.selectJsonOne<{ name: string }>(sql, ["s"])?.name,
    "before",
  );
  assert.equal(typeof store.prepare(sql).get("s")!.body, "string");
  assert.equal(
    store.selectJson<{ name: string }>(sql, ["s"])[0].name,
    "before",
  );
  store.write("sessions", { id: "s", projectId: "p", name: "after" });
  assert.equal(store.get<{ name: string }>("sessions", "s").name, "after");
  assert.equal(
    store.selectJsonOne<{ name: string }>(sql, ["s"])?.name,
    "after",
  );
});
