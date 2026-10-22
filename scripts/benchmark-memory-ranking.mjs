import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Compare actual compiled implementations and SQLite files, alternating execution order.
const option = (/** @type {string} */ name, /** @type {string} */ fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const roots = [
  option("baseline", ".agent-data-refactor/streamline-20261018-before/dist"),
  option("current", "dist"),
];
const directory = await mkdtemp(
  path.join(tmpdir(), "memory-ranking-benchmark-"),
);
const server = http.createServer((request, response) => {
  request.resume();
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
});
/** @type {Array<{search: () => Promise<void>, close: () => void}>} */
const fixtures = [];
const rows = 5000;
try {
  const { listenHttp } = await import(
    pathToFileURL(path.resolve(roots[1], "transport/http-listener.js")).href
  );
  const { port } = await listenHttp(server, { host: "127.0.0.1", port: 0 });
  for (const [index, root] of roots.entries()) {
    const load = (/** @type {string} */ name) =>
      import(pathToFileURL(path.resolve(root, name)).href);
    const [{ parseConfig }, { Store }, { MemoryStore }] = await Promise.all([
      load("core/config.js"),
      load("storage/store.js"),
      load("storage/memory.js"),
    ]);
    const dataDir = path.join(directory, String(index));
    const config = parseConfig({
      dataDir,
      workspaceRoots: [dataDir],
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
    const store = new Store(dataDir);
    const memory = new MemoryStore(store, config);
    fixtures.push({
      close: () => store.close(),
      search: async () => {
        const results = await memory.semanticSearch("project", "query", 100);
        assert.deepEqual(
          results.map((/** @type {{id: string}} */ value) => value.id),
          Array.from({ length: 100 }, (_, n) => `memory-${n}`),
        );
      },
    });
    store.put("projects", { id: "project", root: dataDir });
    memory.put({ id: "seed", projectId: "project", content: "seed" });
    const { embeddingVersion } = await memory.embed("seed");
    memory.remove("seed", "project");
    // Baseline builds keep every kind in one entities table; current builds split per kind.
    const entity = store.db.prepare(
      store.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='entities'",
        )
        .get()
        ? "INSERT INTO entities VALUES('memories',?,?)"
        : "INSERT INTO e_memories(id,body) VALUES(?,?)",
    );
    const vector = store.db.prepare("INSERT INTO memory_vectors VALUES(?,?,?)");
    store.transaction(() => {
      for (let n = 0; n < rows; n++) {
        const id = `memory-${n}`;
        entity.run(
          id,
          JSON.stringify({
            id,
            projectId: "project",
            namespace: "default",
            content: "benchmark fact ".repeat(500),
            tags: [],
            source: "benchmark",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        vector.run(
          id,
          embeddingVersion,
          JSON.stringify(n < 100 ? [1, 0] : [0, 1]),
        );
      }
    });
    await fixtures[index].search();
  }
  /** @type {number[][]} */
  const samples = [[], []];
  for (let round = 0; round < 5; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      await fixtures[index].search();
      samples[index].push(performance.now() - start);
    }
  }
  const results = roots.map((root, index) => ({
    root: path.resolve(root),
    samplesMs: samples[index],
    medianMs: [...samples[index]].sort((a, b) => a - b)[2],
  }));
  const report = {
    node: process.version,
    platform: process.platform,
    rows,
    limit: 100,
    rounds: 5,
    scenario:
      "Real SQLite semantic search; 7.5 KiB memory bodies; local HTTP embeddings; stable top 100 ties",
    results,
  };
  await writeFile(
    option("output", "verification/streamline-memory-benchmark.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const fixture of fixtures) fixture.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
