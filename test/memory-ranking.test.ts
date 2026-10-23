import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parseConfig } from "../src/core/config.js";
import type { MemoryEntry } from "../src/contracts.js";
import { MemoryStore } from "../src/storage/memory.js";
import { Store } from "../src/storage/store.js";
import { listenHttp } from "../src/transport/http-listener.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "memory-ranking-"));
  const provider = http.createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
  });
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    provider.closeAllConnections();
    if (provider.listening)
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = await listenHttp(provider, { host: "127.0.0.1", port: 0 });
  const config = parseConfig({
    dataDir: directory,
    workspaceRoots: [directory],
    defaultRoutes: {
      chat: "text",
      code: "text",
      office: "text",
      embedding: "embedding",
    },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
      embedding: {
        kind: "embedding",
        adapter: "openai-embeddings",
        model: "test",
        baseUrl: `http://127.0.0.1:${port}`,
      },
    },
  });
  const memory = new MemoryStore(store, config);
  store.put("projects", { id: "project", root: directory });
  memory.put({ id: "seed", projectId: "project", content: "seed" });
  const { embeddingVersion } = await memory.embed("seed");
  memory.remove("seed", "project");
  const entity = store.db.prepare(
    "INSERT INTO e_memories(id,body) VALUES(?,?)",
  );
  const vector = store.db.prepare("INSERT INTO memory_vectors VALUES(?,?,?)");
  const add = (
    id: string,
    values: number[],
    fields: Partial<MemoryEntry> = {},
  ) => {
    const entry: MemoryEntry = {
      id,
      projectId: "project",
      namespace: "default",
      content: id,
      tags: [],
      source: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...fields,
    };
    entity.run(id, JSON.stringify(entry));
    vector.run(id, embeddingVersion, JSON.stringify(values));
  };
  return { store, memory, add };
}

test("semantic ranking retains stable ties, later winners, scope and top-k limits", async (t) => {
  const { store, memory, add } = await fixture(t);
  store.transaction(() => {
    add("low", [-1, 0]);
    add("first-tie", [1, 0]);
    add("second-tie", [1, 0]);
    add("zero", [0, 0]);
    add("middle", [1, 1]);
    add("wrong-dimensions", [1, 0, 0]);
    add("foreign", [1, 0], { projectId: "another-project" });
    add("expired", [1, 0], { expiresAt: "2000-01-01T00:00:00.000Z" });
    add("other-namespace", [1, 0], { namespace: "other" });
  });
  for (const limit of [1, 2, 3, 5, 100]) {
    const ranked = await memory.semanticSearch(
      "project",
      "query",
      limit,
      "default",
    );
    assert.deepEqual(
      ranked.map((entry) => entry.id),
      ["first-tie", "second-tie", "middle", "zero", "low"].slice(0, limit),
    );
    assert.equal(ranked[0].score, 1);
  }
  const all = await memory.semanticSearch("project", "query", 100);
  assert.ok(all.some((entry) => entry.id === "other-namespace"));
  await assert.rejects(
    memory.semanticSearch("project", "query", 101),
    /1\.\.100/,
  );
});

test("dimension-mismatched vectors still yield and observe cancellation during scanning", async (t) => {
  const { store, memory, add } = await fixture(t);
  store.transaction(() => {
    for (let index = 0; index < 2000; index++) add(`mismatch-${index}`, [1]);
  });
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let checked = 0;
  controller.signal.throwIfAborted = () => {
    if (++checked === 1)
      setImmediate(() => controller.abort(new Error("cancel scan")));
    check();
  };
  await assert.rejects(
    memory.semanticSearch("project", "query", 8, undefined, controller.signal),
    /cancel scan/,
  );
  assert.ok(
    checked <= 256,
    "cancellation is observed before scanning the entire database",
  );
});

test("concurrent semantic scans retain independent cursors while synchronous queries reuse statements", async (t) => {
  const { store, memory, add } = await fixture(t);
  store.transaction(() => {
    for (let index = 0; index < 600; index++) add(`row-${index}`, [-1, 0]);
    add("winner", [1, 0]);
  });
  const results = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const search = memory.semanticSearch("project", "query", 1);
      assert.equal(memory.list("project").length, 601);
      return search;
    }),
  );
  for (const result of results)
    assert.deepEqual(
      result.map((entry) => entry.id),
      ["winner"],
    );
});

test("vector norms are cached for legacy rows and invalidated by updates, replacements and deletion", async (t) => {
  const { store, memory, add } = await fixture(t);
  add("legacy", [3, 4]);
  const norm = () =>
    store
      .prepare("SELECT norm FROM memory_vector_norms WHERE id=?")
      .get("legacy")?.norm;
  assert.equal(norm(), undefined);
  const first = await memory.semanticSearch("project", "query", 1);
  assert.equal(first[0].score, 0.6);
  assert.equal(norm(), 5);
  assert.deepEqual(await memory.semanticSearch("project", "query", 1), first);
  store
    .prepare("UPDATE memory_vectors SET vector=? WHERE id=?")
    .run(JSON.stringify([4, 3]), "legacy");
  assert.equal(norm(), undefined);
  assert.equal(
    (await memory.semanticSearch("project", "query", 1))[0].score,
    0.8,
  );
  assert.equal(norm(), 5);
  store
    .prepare(
      "INSERT OR REPLACE INTO memory_vectors SELECT id,model,? FROM memory_vectors WHERE id=?",
    )
    .run(JSON.stringify([0, 1]), "legacy");
  assert.equal(norm(), undefined);
  assert.equal(
    (await memory.semanticSearch("project", "query", 1))[0].score,
    0,
  );
  assert.equal(norm(), 1);
  await memory.embed("legacy");
  assert.equal(norm(), 1);
  memory.remove("legacy", "project");
  assert.equal(norm(), undefined);
});

test("a semantic scan yielding across vector changes cannot republish stale norms", async (t) => {
  const { store, memory, add } = await fixture(t);
  store.transaction(() => {
    for (let index = 0; index < 900; index++) add(`row-${index}`, [1, 0]);
  });
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  const writer = new DatabaseSync(
    path.join(memory.config.dataDir, "foundation.sqlite"),
  );
  let scheduled = false;
  let updated = false;
  controller.signal.throwIfAborted = () => {
    check();
    if (
      !scheduled &&
      Number(
        store
          .prepare("SELECT COUNT(*) AS count FROM memory_vector_norms")
          .get()!.count,
      ) > 0
    ) {
      scheduled = true;
      setImmediate(() => {
        writer
          .prepare("UPDATE memory_vectors SET vector=?")
          .run(JSON.stringify([2, 2]));
        updated = true;
      });
    }
  };
  try {
    await memory.semanticSearch(
      "project",
      "query",
      1,
      undefined,
      controller.signal,
    );
    assert.ok(updated, "the first scan yielded while vectors were changed");
    const second = await memory.semanticSearch("project", "query", 100);
    const expected = 2 / Math.sqrt(8);
    assert.ok(second.every((entry) => entry.score === expected));
    assert.equal(
      store
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_vector_norms WHERE norm<>?",
        )
        .get(Math.sqrt(8))!.count,
      0,
    );
  } finally {
    writer.close();
  }
});
