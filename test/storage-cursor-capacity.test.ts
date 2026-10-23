import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "../src/storage/store.js";
import { MemoryStore } from "../src/storage/memory.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "foundation-storage-cursors-"),
  );
  const store = new Store(root);
  store.put("projects", { id: "project", root });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // These cleanup paths do not use model routes or provider configuration.
  const memory = new MemoryStore(store, {} as MemoryStore["config"]);
  return { root, store, memory };
}

test("Store closes its connection when initial pragmas or schema creation fail", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "foundation-store-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let closed = 0;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.includes("journal_mode=WAL"))
      throw new Error("initialization failed");
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.close = function () {
    closed++;
    return close.call(this);
  };
  try {
    assert.throws(() => new Store(root), /initialization failed/);
  } finally {
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.close = close;
  }
  assert.equal(closed, 1);
  const reopened = new Store(root);
  reopened.close();
});

test("entity cursors remain monotonic after tail deletion, emptying, rollback and reopening", async (t) => {
  const { root, store } = await fixture(t);
  store.put("sessions", { id: "first" });
  store.put("sessions", { id: "last" });
  const cursor = store.page("sessions", {}, 0, 2).cursor;
  store.remove("sessions", "last");
  store.put("sessions", { id: "replacement" });
  const next = store.page<{ id: string }>("sessions", {}, cursor);
  assert.deepEqual(
    next.items.map(({ id }) => id),
    ["replacement"],
  );
  assert.ok(next.cursor > cursor);
  store.db.exec("DELETE FROM e_sessions");
  store.close();
  const reopened = new Store(root);
  try {
    reopened.put("sessions", { id: "after-reopen" });
    const page = reopened.page<{ id: string }>("sessions", {}, next.cursor);
    assert.deepEqual(
      page.items.map(({ id }) => id),
      ["after-reopen"],
    );
    assert.throws(
      () =>
        reopened.transaction(() => {
          reopened.put("sessions", { id: "rolled-back" });
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(reopened.find("sessions", "rolled-back"), undefined);
    reopened.put("sessions", { id: "committed" });
    assert.equal(reopened.page("sessions", {}, page.cursor).items.length, 1);
  } finally {
    reopened.close();
  }
});

test("legacy cursor migration preserves rowids, body text, indexes, triggers and views", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "foundation-cursor-upgrade-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, "foundation.sqlite"));
  db.exec(`CREATE TABLE e_sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE INDEX custom_session_mode ON e_sessions(json_extract(body,'$.mode'));
    CREATE TABLE custom_audit(id TEXT);
    CREATE TRIGGER custom_session_update AFTER UPDATE ON e_sessions BEGIN INSERT INTO custom_audit VALUES(new.id); END;
    CREATE VIEW custom_sessions AS SELECT rowid AS cursor,id,body FROM e_sessions;
    CREATE TABLE e_cost_ledger(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,body TEXT NOT NULL);`);
  const body = '{ "id": "legacy", "mode": "chat" }';
  db.prepare("INSERT INTO e_sessions(rowid,id,body) VALUES(9,?,?)").run(
    "legacy",
    body,
  );
  db.prepare("INSERT INTO e_cost_ledger(seq,id,body) VALUES(17,?,?)").run(
    "old-cost",
    '{"id":"old-cost","status":"void"}',
  );
  db.close();
  const store = new Store(root);
  try {
    const row = store.db
      .prepare("SELECT cursor,body FROM custom_sessions")
      .get()!;
    assert.equal(row.cursor, 9);
    assert.equal(row.body, body);
    assert.ok(
      store.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='custom_session_mode'")
        .get(),
    );
    store.put("sessions", { id: "legacy", mode: "code" });
    assert.equal(
      store.db.prepare("SELECT id FROM custom_audit").get()!.id,
      "legacy",
    );
    store.remove("sessions", "legacy");
    store.put("sessions", { id: "new" });
    assert.ok(store.page("sessions", {}, 9).cursor > 9);
    assert.equal(
      store.db
        .prepare("SELECT seq FROM e_cost_ledger WHERE id='old-cost'")
        .get()!.seq,
      17,
    );
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
  } finally {
    store.close();
  }
});

for (const action of ["CASCADE", "NO ACTION"]) {
  test(`cursor migration preserves custom ${action} foreign keys and restores enforcement`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "foundation-cursor-fk-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = new DatabaseSync(path.join(root, "foundation.sqlite"));
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE e_sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE custom_notes(session_id TEXT REFERENCES e_sessions(id) ON DELETE ${action});
      INSERT INTO e_sessions(rowid,id,body) VALUES(9,'session','{"id":"session"}');
      INSERT INTO custom_notes VALUES('session');`);
    db.close();
    const store = new Store(root);
    try {
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM custom_notes").get()!
          .count,
        1,
      );
      assert.equal(
        store.db.prepare("SELECT rowid AS cursor FROM e_sessions").get()!
          .cursor,
        9,
      );
      assert.equal(
        store.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,
        1,
      );
      assert.equal(
        store.db.prepare("PRAGMA foreign_key_check").get(),
        undefined,
      );
      if (action === "CASCADE") {
        store.remove("sessions", "session");
        assert.equal(
          store.db.prepare("SELECT COUNT(*) AS count FROM custom_notes").get()!
            .count,
          0,
        );
      } else {
        assert.throws(() => store.remove("sessions", "session"), /FOREIGN KEY/);
        assert.equal(store.count("sessions"), 1);
      }
    } finally {
      store.close();
    }
  });
}

test("failed foreign key validation rolls the cursor migration back without losing rows", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "foundation-cursor-fk-failure-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "foundation.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE e_sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE custom_notes(session_id TEXT REFERENCES e_sessions(id) ON DELETE CASCADE);
    INSERT INTO e_sessions(rowid,id,body) VALUES(9,'session','{"id":"session"}');
    INSERT INTO custom_notes VALUES('missing');`);
  db.close();
  assert.throws(() => new Store(root), /foreign key integrity/);
  const observer = new DatabaseSync(file);
  try {
    assert.equal(
      observer.prepare("SELECT rowid FROM e_sessions").get()!.rowid,
      9,
    );
    assert.equal(
      observer.prepare("SELECT session_id FROM custom_notes").get()!.session_id,
      "missing",
    );
    assert.ok(
      !String(
        observer
          .prepare("SELECT sql FROM sqlite_schema WHERE name='e_sessions'")
          .get()!.sql,
      ).includes("AUTOINCREMENT"),
    );
  } finally {
    observer.close();
  }
});

test("cursor upgrades reject unsupported custom columns without discarding their values", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "foundation-cursor-custom-layout-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "foundation.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE e_sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL,custom TEXT); INSERT INTO e_sessions VALUES('session','{}','preserved')",
  );
  db.close();
  assert.throws(() => new Store(root), /Unsupported custom columns/);
  const observer = new DatabaseSync(file);
  try {
    assert.equal(
      observer.prepare("SELECT custom FROM e_sessions").get()!.custom,
      "preserved",
    );
  } finally {
    observer.close();
  }
});

test("online expired-memory cleanup yields, rejects duplicate work and preserves revision history", async (t) => {
  const { store, memory } = await fixture(t);
  for (let i = 0; i < 8; i++)
    memory.put({
      projectId: "project",
      content: `expired ${i}`,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
  const live = memory.put({ projectId: "project", content: "live" });
  let yielded = false;
  const heartbeat = new Promise<void>((resolve) =>
    setImmediate(() => {
      yielded = true;
      assert.ok(store.count("memories") > 1);
      resolve();
    }),
  );
  const work = memory.pruneExpiredAsync("project", { batchSize: 2 });
  await assert.rejects(memory.pruneExpiredAsync("project"), /already running/);
  assert.deepEqual(await work, { removed: 8 });
  await heartbeat;
  assert.ok(yielded);
  assert.equal(store.count("memories"), 1);
  assert.equal(store.count("memory-revisions"), 17);
  assert.equal(memory.get(live.id, "project").content, "live");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()!.count,
    1,
  );
});

test("cancelled memory cleanup commits only whole batches and releases admission", async (t) => {
  const { store, memory } = await fixture(t);
  for (let i = 0; i < 6; i++)
    memory.put({
      projectId: "project",
      content: `expired ${i}`,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
  const controller = new AbortController();
  setImmediate(() => controller.abort(new Error("stop cleanup")));
  await assert.rejects(
    memory.pruneExpiredAsync("project", {
      batchSize: 2,
      signal: controller.signal,
    }),
    /stop cleanup/,
  );
  assert.equal(store.count("memories"), 4);
  assert.equal(store.count("memory-revisions"), 8);
  assert.deepEqual(
    await memory.pruneExpiredAsync("project", { batchSize: 2 }),
    { removed: 4 },
  );
  assert.equal(store.count("memory-revisions"), 12);
});

test("a failed cleanup batch rolls back its revisions and FTS changes before releasing admission", async (t) => {
  const { store, memory } = await fixture(t);
  for (let i = 0; i < 3; i++)
    memory.put({
      projectId: "project",
      content: `expired ${i}`,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
  const remove = store.remove.bind(store);
  let calls = 0;
  store.remove = (kind, id) => {
    if (kind === "memories" && ++calls === 2) throw new Error("delete failure");
    return remove(kind, id);
  };
  try {
    await assert.rejects(
      memory.pruneExpiredAsync("project", { batchSize: 2 }),
      /delete failure/,
    );
  } finally {
    store.remove = remove;
  }
  assert.equal(store.count("memories"), 3);
  assert.equal(store.count("memory-revisions"), 3);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()!.count,
    3,
  );
  assert.deepEqual(await memory.pruneExpiredAsync("project"), { removed: 3 });
});

test("explicit storage diagnostics count bytes, skip links, bound admission and cancel", async (t) => {
  const { root, store, memory } = await fixture(t);
  memory.put({ projectId: "project", content: "你好 👋" });
  await mkdir(path.join(root, "assets"));
  await mkdir(path.join(root, "checkpoints"));
  await writeFile(path.join(root, "assets", "data.bin"), Buffer.alloc(13));
  await writeFile(path.join(root, "checkpoints", "snapshot"), Buffer.alloc(7));
  const external = await mkdtemp(
    path.join(os.tmpdir(), "foundation-stats-external-"),
  );
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "excluded"), Buffer.alloc(99));
  await symlink(
    external,
    path.join(root, "assets", "external"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const scan = store.storageStats();
  await assert.rejects(store.storageStats(), /already running/);
  const result = await scan;
  const memories = result.tables.find(({ table }) => table === "e_memories")!;
  const actual = store.db
    .prepare("SELECT length(CAST(body AS BLOB)) AS bytes FROM e_memories")
    .get()!.bytes;
  assert.equal(memories.rows, 1);
  assert.equal(memories.jsonBytes, actual);
  assert.deepEqual(result.directories.assets, {
    files: 1,
    bytes: 13,
    symbolicLinks: 1,
  });
  assert.deepEqual(result.directories.checkpoints, {
    files: 1,
    bytes: 7,
    symbolicLinks: 0,
  });
  assert.deepEqual(result.directories.migrationStaging, {
    files: 0,
    bytes: 0,
    symbolicLinks: 0,
  });
  assert.ok(result.database.fileBytes > 0);
  const controller = new AbortController();
  const cancelled = store.storageStats(controller.signal);
  controller.abort(new Error("stop statistics"));
  await assert.rejects(cancelled, /stop statistics/);
  assert.ok((await store.storageStats()).tables.length > 0);
});

test("active route existence uses the partial index and includes missing archived flags", async (t) => {
  const { store } = await fixture(t);
  store.put("sessions", { id: "archived", routeId: "old", archived: true });
  store.put("sessions", { id: "active", routeId: "new" });
  assert.equal(store.hasActiveSessionForRoute("old"), false);
  assert.equal(store.hasActiveSessionForRoute("new"), true);
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM e_sessions WHERE json_extract(body,'$.routeId')=? AND NOT COALESCE(json_extract(body,'$.archived'),0) LIMIT 1",
    )
    .all("new");
  assert.ok(
    plan.some((row) => String(row.detail).includes("sessions_active_route")),
  );
  store.put("agents", { id: "agent", routeId: "assigned" });
  assert.equal(store.hasAgentForRoute("assigned"), true);
  assert.equal(store.hasAgentForRoute("unassigned"), false);
  const agents = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM e_agents WHERE json_extract(body,'$.routeId')=? LIMIT 1",
    )
    .all("assigned");
  assert.ok(
    agents.some((row) => String(row.detail).includes("e_agents_routeId")),
  );
});

test("storage directory scans report depth capacity and release admission", async (t) => {
  const { root, store } = await fixture(t);
  const checkpoints = path.join(root, "checkpoints");
  await mkdir(
    path.join(checkpoints, ...Array.from({ length: 65 }, () => "d")),
    { recursive: true },
  );
  await assert.rejects(store.storageStats(), /directory traversal capacity/);
  await rm(checkpoints, { recursive: true, force: true });
  assert.ok((await store.storageStats()).directories.checkpoints.files === 0);
});
