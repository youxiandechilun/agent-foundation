import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, rm, writeFile, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parseConfig } from "../src/core/config.js";
import { hash } from "../src/core/util.js";
import { Store } from "../src/storage/store.js";
import { MemoryStore } from "../src/storage/memory.js";
import { Checkpoints } from "../src/sessions/checkpoints.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(tmpdir(), "foundation-memory-capacity-"),
  );
  const store = new Store(root);
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
  const memory = new MemoryStore(store, config);
  store.put("projects", { id: "project", root });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, config, memory };
}

test("memory content index upgrades existing rows and tracks direct SQL changes without exposing digests", async (t) => {
  const { root, store, memory } = await fixture(t);
  const entry = memory.put({ projectId: "project", content: "old content" });
  store.db.exec("DROP INDEX memories_content_lookup");
  store.close();
  const upgraded = new Store(root);
  try {
    const current = new MemoryStore(upgraded, memory.config);
    assert.equal(
      current.put({ projectId: "project", content: "old content" }).id,
      entry.id,
    );
    assert.equal(
      upgraded.db
        .prepare(
          "SELECT json_extract(body,'$.contentHash') AS digest FROM e_memories WHERE id=?",
        )
        .get(entry.id)!.digest,
      null,
    );
    upgraded.db
      .prepare(
        "UPDATE e_memories SET body=json_set(body,'$.content',?) WHERE id=?",
      )
      .run("new content", entry.id);
    assert.equal(
      current.put({ projectId: "project", content: "new content" }).id,
      entry.id,
    );
    assert.notEqual(
      current.put({ projectId: "project", content: "old content" }).id,
      entry.id,
    );
    assert.notEqual(
      current.put({
        projectId: "project",
        namespace: "other",
        content: "new content",
      }).id,
      entry.id,
    );
    const plan = upgraded.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM e_memories INDEXED BY memories_content_lookup WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.namespace')=? AND foundation_content_hash(json_extract(body,'$.content'))=? AND json_extract(body,'$.content')=? ORDER BY rowid LIMIT 1",
      )
      .all("project", "default", hash("new content"), "new content");
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes("memories_content_lookup"),
      ),
    );
    assert.equal(
      upgraded.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    const copy = path.join(root, "copy.sqlite");
    await backup(upgraded.db, copy);
    const external = new DatabaseSync(copy, { readOnly: true });
    try {
      assert.equal(
        external.prepare("SELECT COUNT(*) AS count FROM e_memories").get()!
          .count,
        3,
      );
      assert.equal(
        external
          .prepare(
            "SELECT json_extract(body,'$.content') AS content FROM e_memories WHERE id=?",
          )
          .get(entry.id)!.content,
        "new content",
      );
      assert.equal(
        external.prepare("PRAGMA quick_check").get()!.quick_check,
        "ok",
      );
    } finally {
      external.close();
    }
  } finally {
    upgraded.close();
  }
});

test("async memory import yields before an atomic commit and cancellation leaves no revisions or FTS rows", async (t) => {
  const { store, memory } = await fixture(t);
  const entries = Array.from({ length: 200 }, (_, index) => ({
    content: `fact ${index}`,
  }));
  let observed = false;
  const heartbeat = new Promise<void>((resolve) =>
    setImmediate(() => {
      observed = true;
      assert.equal(store.count("memories"), 0);
      resolve();
    }),
  );
  const imported = await memory.importAsync("project", entries);
  await heartbeat;
  assert.ok(observed);
  assert.equal(imported.length, 200);
  assert.equal(store.count("memories"), 200);
  const controller = new AbortController();
  setImmediate(() => controller.abort(new Error("cancel preparation")));
  await assert.rejects(
    memory.importAsync(
      "project",
      entries.map((entry) => ({ content: `new ${entry.content}` })),
      controller.signal,
    ),
    /cancel preparation/,
  );
  assert.equal(store.count("memories"), 200);
  assert.equal(store.count("memory-revisions"), 200);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()!.count,
    200,
  );
});

test("async memory imports bound admission and bytes, preserve duplicate ordering and roll back commit failures", async (t) => {
  const { store, config } = await fixture(t);
  const memory = new MemoryStore(store, config, undefined, {
    maxImportBytes: 10000,
  });
  const entries = Array.from({ length: 128 }, (_, index) => ({
    content: `fact ${index}`,
  }));
  const first = memory.importAsync("project", entries);
  await assert.rejects(memory.importAsync("project", []), /Resource capacity/);
  await assert.rejects(first, /byte budget/);
  await assert.rejects(
    memory.importAsync("project", [{ content: "x".repeat(12000) }]),
    /byte budget/,
  );
  assert.equal(store.count("memories"), 0);
  const ordinary = new MemoryStore(store, config);
  const duplicate = await ordinary.importAsync("project", [
    { content: "same", tags: ["first"] },
    { content: "same", tags: ["second"] },
  ]);
  assert.equal(duplicate[0].id, duplicate[1].id);
  assert.deepEqual(ordinary.get(duplicate[0].id, "project").tags, ["second"]);
  const originalPut = store.put.bind(store);
  let writes = 0;
  store.put = ((kind, value) => {
    if (kind === "memories" && ++writes === 2)
      throw new Error("commit failure");
    return originalPut(kind, value);
  }) as typeof store.put;
  try {
    await assert.rejects(
      ordinary.importAsync("project", [
        { content: "first new" },
        { content: "second new" },
      ]),
      /commit failure/,
    );
  } finally {
    store.put = originalPut;
  }
  assert.equal(store.count("memories"), 1);
  assert.equal(store.count("memory-revisions"), 2);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()!.count,
    1,
  );
});

test("checkpoint conflicts hash large changed files with cancellation, capacity release and forced restoration", async (t) => {
  const { root, store } = await fixture(t);
  const checkpoints = new Checkpoints(store, root, {
    maxConcurrentReads: 1,
    maxReadBytes: 1024 * 1024,
  });
  const file = path.join(root, "tracked.bin");
  await writeFile(file, "before");
  const checkpoint = await checkpoints.capture(
    {
      sessionId: "session",
      projectId: "project",
      runId: "run",
      callId: "call",
    },
    root,
    "tracked.bin",
  );
  checkpoints.complete(checkpoint, "after");
  const handle = await open(file, "r+");
  await handle.truncate(64 * 1024 * 1024);
  await handle.close();
  const controller = new AbortController();
  const aborted = checkpoints.revert(
    "session",
    root,
    new Set(["call"]),
    false,
    controller.signal,
  );
  const abortedAssertion = assert.rejects(aborted);
  const cancel = new Promise<void>((resolve) =>
    setImmediate(() => {
      controller.abort(new Error("cancel hash"));
      resolve();
    }),
  );
  await abortedAssertion;
  await cancel;
  const concurrent = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      checkpoints.revert("session", root, new Set(["call"])),
    ),
  );
  assert.ok(concurrent.some((result) => result.status === "fulfilled"));
  assert.ok(
    concurrent.some(
      (result) =>
        result.status === "rejected" &&
        /Resource capacity/.test(String(result.reason)),
    ),
  );
  const conflicts = await checkpoints.revert(
    "session",
    root,
    new Set(["call"]),
  );
  assert.deepEqual(conflicts.conflicts, [
    {
      path: "tracked.bin",
      reason: "File changed after the agent's last write",
    },
  ]);
  const forced = await checkpoints.revert(
    "session",
    root,
    new Set(["call"]),
    true,
  );
  assert.deepEqual(forced.restored, ["tracked.bin"]);
  assert.equal(await readFile(file, "utf8"), "before");
});

test("checkpoint restoration rejects oversized or corrupted blobs without changing the working file", async (t) => {
  const { root, store } = await fixture(t);
  const checkpoints = new Checkpoints(store, root);
  const file = path.join(root, "tracked.txt");
  await writeFile(file, "before");
  const checkpoint = await checkpoints.capture(
    {
      sessionId: "session",
      projectId: "project",
      runId: "run",
      callId: "call",
    },
    root,
    "tracked.txt",
  );
  await writeFile(file, "after");
  checkpoints.complete(checkpoint, "after");
  await writeFile(
    path.join(checkpoints.root, checkpoint.beforeSha!),
    "corrupted",
  );
  await assert.rejects(
    checkpoints.revert("session", root, new Set(["call"])),
    /integrity/,
  );
  assert.equal(await readFile(file, "utf8"), "after");
});
