// Build first, then run: node --expose-gc scripts/benchmark-optimization-storage.mjs
// Only temporary SQLite fixtures and an in-process mock adapter are used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as immediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { parseConfig } from "../dist/core/config.js";
import { hash } from "../dist/core/util.js";
import { Media } from "../dist/media/manager.js";
import { Assets } from "../dist/storage/assets.js";
import { Store } from "../dist/storage/store.js";

const { values } = parseArgs({
  options: { samples: { type: "string", default: "5" } },
});
const samples = Number(values.samples);
assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 5);
assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const median = (items) =>
  [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)];
const temporaryParent = await realpath(os.tmpdir());
const temporaryRoot = await mkdtemp(
  path.join(temporaryParent, "foundation-optimization-storage-"),
);
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("Network is disabled in this benchmark");
};
let store;
let assets;
let media;
let report;

async function removeTemporaryRoot() {
  const resolved = await realpath(temporaryRoot);
  const relative = path.relative(temporaryParent, resolved);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative),
    "Refusing cleanup outside the temporary parent",
  );
  assert.ok(
    path.basename(resolved).startsWith("foundation-optimization-storage-"),
    "Unexpected temporary directory name",
  );
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

function measureFtsLookups() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,project_id UNINDEXED,namespace UNINDEXED,terms,tokenize='unicode61'); CREATE TABLE memory_fts_map(fts_rowid INTEGER PRIMARY KEY,memory_id TEXT NOT NULL); CREATE INDEX memory_fts_map_id ON memory_fts_map(memory_id)",
    );
    const insert = db.prepare(
      "INSERT INTO memory_fts(id,project_id,namespace,terms) VALUES(?,?,?,?)",
    );
    const mapping = db.prepare("INSERT INTO memory_fts_map VALUES(?,?)");
    const oldSql = "DELETE FROM memory_fts WHERE id=?";
    const newSql =
      "DELETE FROM memory_fts WHERE rowid IN (SELECT fts_rowid FROM memory_fts_map WHERE memory_id=?)";
    const statements = {
      before: db.prepare(oldSql),
      after: db.prepare(newSql),
    };
    const plans = {
      before: db
        .prepare("EXPLAIN QUERY PLAN " + oldSql)
        .all("absent")
        .map((row) => row.detail),
      after: db
        .prepare("EXPLAIN QUERY PLAN " + newSql)
        .all("absent")
        .map((row) => row.detail),
    };
    const results = [];
    let inserted = 0;
    const callsPerSample = 20;
    for (const count of [10000, 50000]) {
      db.exec("BEGIN");
      for (; inserted < count; inserted++) {
        const id = "memory-" + inserted;
        const row = insert.run(
          id,
          "project",
          "default",
          "audit note " + inserted,
        );
        mapping.run(row.lastInsertRowid, id);
      }
      db.exec("COMMIT");
      const timings = { before: [], after: [] };
      statements.before.run("absent");
      statements.after.run("absent");
      for (let round = 0; round < samples; round++) {
        for (const name of round % 2
          ? ["after", "before"]
          : ["before", "after"]) {
          global.gc();
          const started = performance.now();
          for (let i = 0; i < callsPerSample; i++)
            statements[name].run("absent");
          timings[name].push((performance.now() - started) / callsPerSample);
        }
      }
      results.push({
        rows: count,
        millisecondsPerDelete: timings,
        beforeMedianMs: median(timings.before),
        afterMedianMs: median(timings.after),
      });
    }
    return {
      method:
        "Same in-memory FTS data; delete a missing ID using the old unindexed lookup versus the current rowid-map lookup. Alternate execution order and report median per-call time across batches.",
      samples,
      callsPerSample,
      queryPlans: plans,
      results,
      limitation:
        "This isolates FTS lookup cost. It does not measure a complete memory write/import, including content deduplication, redaction, transactions or revision storage.",
    };
  } finally {
    db.close();
  }
}

try {
  const config = parseConfig({
    dataDir: temporaryRoot,
    workspaceRoots: [temporaryRoot],
    defaultRoutes: {
      chat: "text",
      code: "text",
      office: "text",
      image: "image",
    },
    limits: { maxConcurrentMediaJobs: 2, maxQueuedMediaJobs: 16 },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
      image: {
        kind: "image",
        adapter: "media-http",
        mediaAdapterId: "benchmark-mock",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
    },
  });
  store = new Store(temporaryRoot);
  assets = new Assets(store, config);
  await assets.init();
  media = new Media(store, assets, config);
  store.write("projects", {
    id: "project",
    name: "benchmark",
    root: temporaryRoot,
    createdAt: "2026-10-23T00:00:00Z",
  });
  const rowCount = 20032;
  const prompt = "x".repeat(1024);
  const request = {
    schemaVersion: 1,
    kind: "image",
    operation: "generate",
    prompt,
    inputAssets: [],
    parameters: {},
  };
  const requestHash = hash(JSON.stringify({ request, routeId: "image" }));
  const insert = store.db.prepare("INSERT INTO e_jobs(id,body) VALUES(?,?)");
  let sampleBodyBytes = 0;
  store.transaction(() => {
    for (let i = 0; i < rowCount; i++) {
      const id = "historical-job-" + i;
      const body = JSON.stringify({
        id,
        projectId: "project",
        routeId: "image",
        kind: "image",
        prompt,
        request,
        requestHash,
        idempotencyKey: "historical-key-" + i,
        status: "completed",
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
      });
      sampleBodyBytes = Buffer.byteLength(body);
      insert.run(id, body);
    }
  });
  const existingInput = {
    projectId: "project",
    routeId: "image",
    kind: "image",
    prompt,
    idempotencyKey: "historical-key-" + (rowCount - 1),
  };
  const targetId = "historical-job-" + (rowCount - 1);
  assert.equal(media.create(existingInput).id, targetId);
  const lookupSamples = [];
  for (let i = 0; i < samples; i++) {
    global.gc();
    const before = process.memoryUsage();
    const started = performance.now();
    const result = media.create(existingInput);
    const durationMs = performance.now() - started;
    const after = process.memoryUsage();
    assert.equal(result.id, targetId);
    lookupSamples.push({
      durationMs,
      allocatedHeapBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
    });
  }
  assert.equal(store.count("jobs"), rowCount);
  const queryPlan = store
    .prepare(
      "EXPLAIN QUERY PLAN SELECT body FROM e_jobs WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.idempotencyKey')=? ORDER BY rowid LIMIT 1",
    )
    .all("project", existingInput.idempotencyKey)
    .map((row) => row.detail);

  let active = 0;
  let peakActive = 0;
  let submitted = 0;
  media.adapters.register({
    id: "benchmark-mock",
    capabilities: {
      kinds: ["image"],
      operations: ["generate"],
      cancellation: false,
      recovery: false,
    },
    submit: (_request, context) =>
      new Promise((_resolve, reject) => {
        submitted++;
        active++;
        peakActive = Math.max(peakActive, active);
        const cancel = () => {
          active--;
          reject(context.signal.reason);
        };
        if (context.signal.aborted) cancel();
        else context.signal.addEventListener("abort", cancel, { once: true });
      }),
  });
  const accepted = [];
  for (let i = 0; i < 18; i++)
    accepted.push(
      media.create({
        projectId: "project",
        routeId: "image",
        kind: "image",
        prompt: "admission probe",
        idempotencyKey: "admission-" + i,
      }),
    );
  await immediate();
  let rejected;
  try {
    media.create({
      projectId: "project",
      routeId: "image",
      kind: "image",
      prompt: "admission probe",
      idempotencyKey: "admission-19",
    });
  } catch (error) {
    rejected = {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }
  assert.equal(rejected?.status, 429);
  assert.equal(rejected?.code, "resource_capacity");
  assert.equal(active, 2);
  assert.equal(submitted, 2);
  const queued = accepted.filter(
    (job) => store.job(job.id).status === "queued",
  ).length;
  assert.equal(queued, 16);
  assert.equal(store.count("jobs"), rowCount + 18);
  await media.close();
  await immediate();
  assert.equal(active, 0);
  const finalStatuses = {};
  for (const job of accepted) {
    const status = store.job(job.id).status;
    finalStatuses[status] = (finalStatuses[status] || 0) + 1;
  }
  assert.deepEqual(finalStatuses, { unknown: 2, cancelled: 16 });
  assert.equal(networkAttempts, 0);
  const compiledHashes = Object.fromEntries(
    await Promise.all(
      ["media/manager.js", "storage/store.js", "storage/entity-query.js"].map(
        async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(new URL("../dist/" + file, import.meta.url)))
            .digest("hex"),
        ],
      ),
    ),
  );
  report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      sqlite: process.versions.sqlite,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.availableParallelism(),
      explicitGc: true,
    },
    compiledSha256: compiledHashes,
    mediaLookup: {
      rows: rowCount,
      promptBytes: Buffer.byteLength(prompt),
      representativeStoredJobBytes: sampleBodyBytes,
      target:
        "Last inserted existing job; the Media instance remains open throughout all lookups.",
      warmups: 1,
      samples: lookupSamples,
      medianDurationMs: median(
        lookupSamples.map((sample) => sample.durationMs),
      ),
      medianAllocatedHeapBytes: median(
        lookupSamples.map((sample) => sample.allocatedHeapBytes),
      ),
      queryPlan,
    },
    mediaAdmission: {
      maxConcurrent: 2,
      maxQueued: 16,
      accepted: accepted.length,
      activeAtSaturation: 2,
      queuedAtSaturation: queued,
      peakActive,
      attempted19th: rejected,
      providerSubmissions: submitted,
      activeAfterClose: active,
      finalStatuses,
    },
    ftsLookup: measureFtsLookups(),
    networkAttempts,
    limitations: [
      "Lookup uses one local process and a warm SQLite cache. Concurrent host work, JIT and GC can affect timing; these results are not a production throughput claim.",
      "allocatedHeapBytes is the observed heapUsed increase around one synchronous call after explicit GC. It is not cumulative allocator traffic, retained heap, whole-process RSS or a measured peak.",
      "Media admission uses a mock adapter that remains pending until cancelled; it measures local limits, not provider/network throughput.",
      "No model, external service, browser, desktop or Office integration is invoked.",
    ],
  };
} finally {
  const cleanupErrors = [];
  for (const close of [
    () => media?.close(),
    () => assets?.close(),
    () => store?.close(),
    removeTemporaryRoot,
  ]) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  globalThis.fetch = originalFetch;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Benchmark cleanup failed");
}
console.log(JSON.stringify({ ...report, temporaryDataRemoved: true }, null, 2));
