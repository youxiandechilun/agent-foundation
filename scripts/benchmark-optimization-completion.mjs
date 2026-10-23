// Build current first, then run: node scripts/benchmark-optimization-completion.mjs
// Every variant/sample uses an independent process, local HTTP and a fresh SQLite fixture.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const { values } = parseArgs({
  options: {
    child: { type: "string" },
    variant: { type: "string" },
    runtime: { type: "string" },
    baseline: {
      type: "string",
      default: ".agent-data-tests/optimization-complete-baseline-dist",
    },
    current: { type: "string", default: "dist" },
    samples: { type: "string", default: "3" },
    output: {
      type: "string",
      default: "verification/optimization-completion-20261023/benchmark.json",
    },
  },
});
const scenarios = ["json-admission", "session-export", "memory-prune"];
const jsonRequests = 16;
const jsonRequestBytes = 8 * 1024 * 1024;
const messageCount = 19900;
const memoryCount = 1000;
const textBytes = 1024;
const token = "local-completion-benchmark-token-12345";

async function removeScratch(directory, parent) {
  const resolvedParent = await realpath(parent);
  const resolvedTarget = await realpath(directory);
  const relative = path.relative(resolvedParent, resolvedTarget);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative),
    "Refusing cleanup outside the resolved temporary parent",
  );
  assert.ok(
    path.basename(resolvedTarget).startsWith("foundation-completion-bench-"),
  );
  await rm(resolvedTarget, { recursive: true, force: true, maxRetries: 3 });
}

async function observe() {
  global.gc();
  global.gc();
  const before = process.memoryUsage();
  const peak = { ...before };
  let samples = 0;
  let active = true;
  let maximumGapMs = 0;
  let last = performance.now();
  const sample = () => {
    const memory = process.memoryUsage();
    for (const key of ["heapUsed", "rss", "external", "arrayBuffers"])
      peak[key] = Math.max(peak[key], memory[key]);
    samples++;
  };
  const beat = () => {
    const now = performance.now();
    maximumGapMs = Math.max(maximumGapMs, now - last);
    last = now;
    if (active) setImmediate(beat);
  };
  const interval = setInterval(sample, 2);
  setImmediate(beat);
  await immediate();
  return {
    before,
    sample,
    async finish() {
      sample();
      // Let the heartbeat observe the preceding synchronous operation as well.
      await immediate();
      active = false;
      clearInterval(interval);
      return {
        sampledPeakHeapDeltaBytes: peak.heapUsed - before.heapUsed,
        sampledPeakRssDeltaBytes: peak.rss - before.rss,
        sampledPeakExternalDeltaBytes: peak.external - before.external,
        sampledPeakArrayBuffersDeltaBytes:
          peak.arrayBuffers - before.arrayBuffers,
        maxEventLoopGapMs: maximumGapMs,
        memorySampleCount: samples,
      };
    },
  };
}

function configuration(parseConfig, directory) {
  return parseConfig({
    server: { host: "127.0.0.1", port: 0 },
    dataDir: path.join(directory, "data"),
    workspaceRoots: [directory],
    extensions: { allowedRoots: [directory] },
    memory: { enabled: false },
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
}

async function until(predicate, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(
      performance.now() < deadline,
      "Benchmark synchronization timed out",
    );
    await delay(5);
  }
}

async function jsonAdmission(load, directory, variant) {
  const { Kernel, parseConfig, serve } = await load("index.js");
  const kernel = new Kernel(configuration(parseConfig, directory));
  let api;
  const requests = [];
  let monitor;
  try {
    api = await serve(kernel, token);
    let readers = 0;
    let arrived = 0;
    const statuses = [];
    api.server.prependListener("request", (req) => {
      if (req.url !== "/v1/memories/import") return;
      arrived++;
      const iterate = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = () => {
        readers++;
        return iterate();
      };
    });
    monitor = await observe();
    const started = performance.now();
    for (let i = 0; i < jsonRequests; i++) {
      const request = http.request(`${api.url}/v1/memories/import`, {
        method: "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": jsonRequestBytes,
        },
      });
      request.on("error", () => {});
      request.on("response", (response) => {
        statuses.push(response.statusCode);
        response.resume();
      });
      request.flushHeaders();
      request.write("{");
      requests.push(request);
    }
    await until(
      () =>
        arrived === jsonRequests && readers + statuses.length === jsonRequests,
    );
    await delay(250);
    monitor.sample();
    const memory = process.memoryUsage();
    const memoryBefore = monitor.before;
    const elapsedMs = performance.now() - started;
    const observation = await monitor.finish();
    monitor = undefined;
    const rejected429 = statuses.filter((status) => status === 429).length;
    assert.equal(
      statuses.length,
      rejected429,
      "Only admission rejections should complete",
    );
    assert.equal(readers, variant === "baseline" ? 16 : 8);
    assert.equal(rejected429, variant === "baseline" ? 0 : 8);
    return {
      requestCount: jsonRequests,
      declaredBytesPerRequest: jsonRequestBytes,
      sentBytesPerRequest: 1,
      arrivedRequests: arrived,
      bodyReaders: readers,
      rejected429,
      observationMs: elapsedMs,
      heldExternalDeltaBytes: memory.external - memoryBefore.external,
      heldArrayBuffersDeltaBytes:
        memory.arrayBuffers - memoryBefore.arrayBuffers,
      heldRssDeltaBytes: memory.rss - memoryBefore.rss,
      heldArrayBuffersBytes: memory.arrayBuffers,
      heldExternalBytes: memory.external,
      heldRssBytes: memory.rss,
      ...observation,
    };
  } finally {
    await monitor?.finish();
    requests.forEach((request) => request.destroy());
    if (api) await api.close();
    else await kernel.close();
  }
}

async function sessionExport(load, directory) {
  const [
    { Store },
    { parseConfig },
    { sessionManagementRoutes },
    { JsonStreamResponse },
  ] = await Promise.all([
    load("storage/store.js"),
    load("core/config.js"),
    load("api/routes/session-management.js"),
    load("api/shared.js"),
  ]);
  const config = configuration(parseConfig, directory);
  const store = new Store(config.dataDir);
  let monitor;
  try {
    const session = {
      id: "session",
      projectId: "project",
      name: "benchmark",
      mode: "chat",
      routeId: "text",
      createdAt: "2026-10-23T00:00:00.000Z",
    };
    store.put("sessions", session);
    let messageBytes = 0;
    const content = "x".repeat(textBytes);
    const digest = createHash("sha256");
    store.transaction(() => {
      const insert = store.db.prepare(
        "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
      );
      for (let i = 0; i < messageCount; i++) {
        const body = JSON.stringify({
          id: `m${i}`,
          runId: "run",
          message: { role: "user", content, timestamp: i },
        });
        insert.run(session.id, `m${i}`, body);
        messageBytes += Buffer.byteLength(body);
        digest.update(body);
      }
    });
    const expectedBytes =
      Buffer.byteLength(
        JSON.stringify({
          session,
          messages: [],
          format: "foundation-session-v1",
        }),
      ) +
      messageBytes +
      messageCount -
      1;
    monitor = await observe();
    const started = performance.now();
    const response = await sessionManagementRoutes({
      k: { store, config },
      method: "GET",
      parts: ["v1", "sessions", session.id, "export"],
      url: new URL(`http://localhost/v1/sessions/${session.id}/export`),
      json: async () => ({}),
    });
    assert.ok(response);
    monitor.sample();
    let wireBytes = 0;
    let chunkCount = 0;
    let serialized;
    const wireDigest = createHash("sha256");
    const streamed = response.data instanceof JsonStreamResponse;
    if (streamed) {
      try {
        for await (const chunk of response.data.chunks) {
          wireBytes += Buffer.byteLength(chunk);
          wireDigest.update(chunk);
          chunkCount++;
        }
      } finally {
        response.data.close();
      }
    } else {
      assert.equal(response.data.messages.length, messageCount);
      serialized = JSON.stringify(response.data);
      wireBytes = Buffer.byteLength(serialized);
      wireDigest.update(serialized);
      chunkCount = 1;
    }
    const elapsedMs = performance.now() - started;
    // Both variants are sampled with their produced result still live.
    monitor.sample();
    const observation = await monitor.finish();
    monitor = undefined;
    assert.equal(wireBytes, expectedBytes);
    assert.ok(streamed || serialized.length > 0);
    return {
      messages: messageCount,
      contentBytesPerMessage: textBytes,
      wireBytes,
      expectedBytes,
      fixtureMessagesSha256: digest.digest("hex"),
      wireSha256: wireDigest.digest("hex"),
      streamed,
      chunkCount,
      elapsedMs,
      ...observation,
    };
  } finally {
    await monitor?.finish();
    store.close();
  }
}

async function memoryPrune(load, directory, variant) {
  const [{ Store }, { MemoryStore }, { parseConfig }] = await Promise.all([
    load("storage/store.js"),
    load("storage/memory.js"),
    load("core/config.js"),
  ]);
  const config = configuration(parseConfig, directory);
  const store = new Store(config.dataDir);
  const memory = new MemoryStore(store, config);
  let monitor;
  try {
    store.put("projects", { id: "project", root: directory });
    store.transaction(() => {
      for (let i = 0; i < memoryCount; i++) {
        const prefix = `${String(i).padStart(4, "0")} `;
        memory.put({
          projectId: "project",
          content: prefix + "x".repeat(textBytes - prefix.length),
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
      }
    });
    monitor = await observe();
    const started = performance.now();
    const result =
      variant === "baseline"
        ? memory.pruneExpired("project")
        : await memory.pruneExpiredAsync("project", { batchSize: 100 });
    const elapsedMs = performance.now() - started;
    const observation = await monitor.finish();
    monitor = undefined;
    assert.equal(result.removed, memoryCount);
    assert.equal(store.count("memories"), 0);
    assert.equal(store.count("memory-revisions"), memoryCount * 2);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get().n,
      0,
    );
    return {
      memories: memoryCount,
      contentBytesPerMemory: textBytes,
      removed: result.removed,
      revisions: memoryCount * 2,
      batchSize: variant === "baseline" ? memoryCount : 100,
      elapsedMs,
      ...observation,
    };
  } finally {
    await monitor?.finish();
    store.close();
  }
}

async function fingerprint(directory) {
  const digest = createHash("sha256");
  let files = 0;
  async function walk(folder) {
    for (const item of (await readdir(folder, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else {
        const bytes = await readFile(file);
        digest
          .update(path.relative(directory, file).replaceAll("\\", "/"))
          .update("\0")
          .update(bytes)
          .update("\0");
        files++;
      }
    }
  }
  await walk(directory);
  return { sha256: digest.digest("hex"), files };
}

if (values.child) {
  assert.ok(scenarios.includes(values.child));
  assert.ok(["baseline", "current"].includes(values.variant));
  assert.equal(
    typeof global.gc,
    "function",
    "Child process requires --expose-gc",
  );
  const runtime = path.resolve(root, values.runtime);
  const load = (name) => import(pathToFileURL(path.join(runtime, name)).href);
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(
    path.join(parent, "foundation-completion-bench-"),
  );
  try {
    const result =
      values.child === "json-admission"
        ? await jsonAdmission(load, directory, values.variant)
        : values.child === "session-export"
          ? await sessionExport(load, directory)
          : await memoryPrune(load, directory, values.variant);
    console.log(JSON.stringify({ pid: process.pid, result }));
  } finally {
    await removeScratch(directory, parent);
  }
} else {
  const samples = Number(values.samples);
  assert.ok(
    Number.isInteger(samples) &&
      samples >= 3 &&
      samples <= 9 &&
      samples % 2 === 1,
  );
  const variants = [
    { name: "baseline", runtime: path.resolve(root, values.baseline) },
    { name: "current", runtime: path.resolve(root, values.current) },
  ];
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    source: {
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      source: await fingerprint(path.join(root, "src")),
      benchmarkSha256: createHash("sha256")
        .update(await readFile(filename))
        .digest("hex"),
      variants: await Promise.all(
        variants.map(async (variant) => ({
          ...variant,
          fingerprint: await fingerprint(variant.runtime),
        })),
      ),
    },
    samplesPerVariant: samples,
    method:
      "Independent sequential processes and fresh SQLite fixtures; alternating baseline/current order each round. Explicit GC before the measured operation. Memory sampled every 2 ms plus identical result-boundary checkpoints. Continuous setImmediate heartbeat includes the final synchronous pause. Local HTTP only; no model, browser, Office or external server calls.",
    limitations: [
      "JSON admission sends one byte of each declared 8 MiB body. External/ArrayBuffer allocations include reserved body buffers; RSS need not grow in proportion because most allocated pages remain untouched. This measures admission, not successful JSON parsing throughput.",
      "Export consumes the current native stream without accumulating chunks. Baseline materializes route data and JSON.stringify text. Both byte counting and SHA-256 are included. Property order differs across formats, so wire byte length and the seeded ordered-message digest establish fixture equivalence; wire hashes may differ.",
      "A timer cannot sample the interior of synchronous baseline work. Explicit end-of-stage samples retain its result and serialized string, but reported peaks are sampled observations, not allocation totals or exact transient peaks.",
      "Memory cleanup compares the existing synchronous maintenance path with the online batch API. It preserves revision/FTS semantics; better responsiveness does not imply lower total elapsed time. Filesystem, JIT, GC and system load affect all timings.",
      "Fresh-fixture synthetic results do not establish production throughput, total process memory caps, long-term leak absence or cross-product rankings. Runtime tree hashes identify the measured builds; source HEAD alone may include uncommitted current changes.",
    ],
    scenarios: [],
  };
  const output = path.resolve(root, values.output);
  await mkdir(path.dirname(output), { recursive: true });
  try {
    for (const scenario of scenarios) {
      const record = {
        scenario,
        executionOrder: [],
        variants: variants.map((variant) => ({ ...variant, samples: [] })),
      };
      report.scenarios.push(record);
      for (let round = 0; round < samples; round++) {
        for (const variant of round % 2 ? [...variants].reverse() : variants) {
          record.executionOrder.push({
            round: round + 1,
            variant: variant.name,
          });
          const child = spawnSync(
            process.execPath,
            [
              "--expose-gc",
              filename,
              `--child=${scenario}`,
              `--variant=${variant.name}`,
              `--runtime=${variant.runtime}`,
            ],
            {
              cwd: root,
              encoding: "utf8",
              windowsHide: true,
              timeout: 60000,
              maxBuffer: 1024 * 1024,
            },
          );
          assert.ok(
            !child.error && child.status === 0,
            child.error?.message || child.stderr || child.stdout,
          );
          record.variants
            .find((item) => item.name === variant.name)
            .samples.push(JSON.parse(child.stdout.trim()));
          console.log(
            `${scenario} ${variant.name}: sample ${round + 1}/${samples} passed`,
          );
        }
      }
      for (const variant of record.variants) {
        variant.medians = Object.fromEntries(
          Object.keys(variant.samples[0].result)
            .filter((key) => typeof variant.samples[0].result[key] === "number")
            .map((key) => [
              key,
              variant.samples
                .map((sample) => sample.result[key])
                .sort((a, b) => a - b)[Math.floor(samples / 2)],
            ]),
        );
      }
      if (scenario === "session-export") {
        const runs = record.variants.flatMap((variant) =>
          variant.samples.map((sample) => sample.result),
        );
        assert.equal(new Set(runs.map((run) => run.wireBytes)).size, 1);
        assert.equal(
          new Set(runs.map((run) => run.fixtureMessagesSha256)).size,
          1,
        );
      }
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack || String(error);
    process.exitCode = 1;
    console.error(report.error);
  } finally {
    report.completedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(output);
  }
}
