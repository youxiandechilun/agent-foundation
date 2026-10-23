// Build first, then run: node scripts/benchmark-memory-scaling.mjs
// Uses local synthetic embeddings, fresh child processes and temporary databases.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setImmediate, setInterval, clearInterval } from "node:timers";
import { log } from "node:console";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const runtime = path.resolve(option("current", "dist"));
const child = process.argv.includes("--child");
const positiveList = (name, fallback, maximum) => {
  const values = option(name, fallback).split(",").map(Number);
  assert.ok(values.length > 0 && values.length <= 4);
  assert.ok(
    values.every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= maximum,
    ),
  );
  return values;
};

if (child) {
  assert.equal(typeof globalThis.gc, "function", "Child requires --expose-gc");
  const rows = positiveList("rows", "1000", 100000)[0];
  const dimensions = positiveList("dimensions", "128", 4096)[0];
  assert.ok(rows * dimensions <= 20000000);
  const load = (file) => import(pathToFileURL(path.join(runtime, file)).href);
  const [{ Store }, { MemoryStore }, { parseConfig }] = await Promise.all([
    load("storage/store.js"),
    load("storage/memory.js"),
    load("core/config.js"),
  ]);
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(
    path.join(parent, "foundation-memory-scaling-"),
  );
  const vector = Array.from(
    { length: dimensions },
    (_, index) => ((index % 19) - 9) / 19,
  );
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const encoded = new Uint8Array(Float64Array.from(vector).buffer);
  const provider = http.createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ embedding: vector }] }));
  });
  let store;
  let timer;
  let finished = false;
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const port = provider.address().port;
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
          model: "synthetic",
          baseUrl: `http://127.0.0.1:${port}`,
        },
      },
    });
    store = new Store(directory);
    store.put("projects", { id: "project", root: directory });
    const memory = new MemoryStore(store, config);
    memory.put({ id: "seed", projectId: "project", content: "seed" });
    const { embeddingVersion } = await memory.embed("seed");
    memory.remove("seed", "project");
    const entity = store.db.prepare(
      "INSERT INTO e_memories(id,body) VALUES(?,?)",
    );
    const vectors = store.db.prepare(
      "INSERT INTO memory_vectors VALUES(?,?,?)",
    );
    const norms = store.db.prepare(
      "INSERT INTO memory_vector_norms VALUES(?,?)",
    );
    store.transaction(() => {
      for (let index = 0; index < rows; index++) {
        const id = `row-${String(index).padStart(8, "0")}`;
        entity.run(
          id,
          JSON.stringify({
            id,
            projectId: "project",
            namespace: "default",
            content: id,
            tags: [],
          }),
        );
        vectors.run(id, embeddingVersion, encoded);
        norms.run(id, norm);
      }
    });
    globalThis.gc();
    const before = process.memoryUsage();
    const samples = [];
    let previous = performance.now();
    let maximumPauseMs = 0;
    const tick = () => {
      const current = performance.now();
      maximumPauseMs = Math.max(maximumPauseMs, current - previous);
      previous = current;
      if (!finished) setImmediate(tick);
    };
    setImmediate(tick);
    timer = setInterval(() => samples.push(process.memoryUsage()), 2);
    const started = performance.now();
    const result = await memory.semanticSearchWithStats(
      "project",
      "synthetic",
      8,
    );
    const totalElapsedMs = performance.now() - started;
    finished = true;
    clearInterval(timer);
    samples.push(process.memoryUsage());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.stats.scannedRows, rows);
    assert.equal(result.stats.scoredRows, rows);
    assert.equal(result.stats.vectorBytes, rows * dimensions * 8);
    assert.deepEqual(
      result.memories.map(({ id }) => id),
      Array.from(
        { length: Math.min(rows, 8) },
        (_, index) => `row-${String(index).padStart(8, "0")}`,
      ),
    );
    const peak = (key) =>
      Math.max(...samples.map((sample) => sample[key])) - before[key];
    log(
      JSON.stringify({
        rows,
        dimensions,
        ...result.stats,
        totalElapsedMs,
        maximumPauseMs,
        sampledRssDeltaBytes: peak("rss"),
        sampledHeapDeltaBytes: peak("heapUsed"),
        sampledArrayBufferDeltaBytes: peak("arrayBuffers"),
        sampleCount: samples.length,
      }),
    );
  } finally {
    finished = true;
    clearInterval(timer);
    store?.close();
    provider.closeAllConnections();
    if (provider.listening)
      await new Promise((resolve) => provider.close(resolve));
    const resolved = await realpath(directory);
    const relative = path.relative(parent, resolved);
    assert.ok(
      relative &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative),
    );
    assert.ok(path.basename(resolved).startsWith("foundation-memory-scaling-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
} else {
  const rows = positiveList("rows", "1000,5000,20000", 100000);
  const dimensions = positiveList("dimensions", "128,512", 4096);
  const samples = Number(option("samples", "3"));
  assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 5);
  const records = [];
  for (const size of rows)
    for (const width of dimensions) {
      assert.ok(size * width <= 20000000);
      const runs = [];
      for (let round = 0; round < samples; round++) {
        const result = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            fileURLToPath(import.meta.url),
            "--child",
            `--current=${runtime}`,
            `--rows=${size}`,
            `--dimensions=${width}`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 120000 },
        );
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        runs.push(JSON.parse(result.stdout.trim()));
      }
      const medians = Object.fromEntries(
        Object.keys(runs[0]).map((key) => {
          const values = runs.map((run) => run[key]).sort((a, b) => a - b);
          return [key, values[Math.floor(values.length / 2)]];
        }),
      );
      records.push({ rows: size, dimensions: width, runs, medians });
    }
  const fingerprint = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model,
        samplesPerScenario: samples,
        scriptSha256: await fingerprint(fileURLToPath(import.meta.url)),
        memoryRuntimeSha256: await fingerprint(
          path.join(runtime, "storage/memory.js"),
        ),
        method:
          "Fresh processes and SQLite databases; Float64 BLOB vectors, cached norms and identical vectors to verify stable tie ordering. Embedding response comes from a local HTTP fixture; exact scan timing excludes that request. No paid or external providers.",
        limitation:
          "Exact scanning remains O(N×D). These are corpus-size diagnostics, not an ANN comparison or production latency guarantee. SQLite cache, JIT, GC, filesystem and host load affect timings; sampled memory deltas are not exact peaks or evidence about long-term leaks.",
        records,
      },
      null,
      2,
    ),
  );
}
