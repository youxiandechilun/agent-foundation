import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setImmediate as immediate } from "node:timers/promises";

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const { values } = parseArgs({
  options: {
    child: { type: "string" },
    samples: { type: "string", default: "3" },
    output: { type: "string", default: "verification/capacity-benchmark.json" },
    baseline: { type: "string" },
  },
});
const scenarios = ["history", "compaction", "lists", "upload", "retention"];
const count = 19900;
const text = "x".repeat(1024);
const entry = (file) => pathToFileURL(path.join(root, "dist", file)).href;

async function readSample(operation) {
  global.gc();
  const before = process.memoryUsage();
  const started = performance.now();
  const rows = operation();
  const durationMs = performance.now() - started;
  const allocated = process.memoryUsage();
  globalThis.foundationBenchmarkRows = rows;
  global.gc();
  const retained = process.memoryUsage();
  const result = {
    rows: rows.length,
    durationMs,
    allocatedHeapBytes: allocated.heapUsed - before.heapUsed,
    retainedHeapBytes: retained.heapUsed - before.heapUsed,
  };
  delete globalThis.foundationBenchmarkRows;
  return result;
}
async function sample(scenario) {
  assert.equal(typeof global.gc, "function");
  const parent = await realpath(os.tmpdir());
  const scratch = await mkdtemp(
    path.join(parent, "foundation-capacity-bench-"),
  );
  let store, kernel;
  try {
    if (scenario === "upload") {
      const { Kernel, parseConfig } = await import(entry("index.js"));
      kernel = new Kernel(
        parseConfig({
          dataDir: path.join(scratch, "data"),
          workspaceRoots: [path.join(scratch, "workspace")],
          extensions: { allowedRoots: [path.join(scratch, "extensions")] },
          execution: { boundary: "native" },
          defaultRoutes: { chat: "text", code: "text", office: "text" },
          routes: {
            text: {
              kind: "text",
              adapter: "openai-completions",
              model: "unused",
              baseUrl: "http://127.0.0.1:1/v1",
            },
          },
        }),
      );
      await kernel.init();
      const project = await kernel.createProject("benchmark");
      const size = 50 * 1024 * 1024;
      global.gc();
      global.gc();
      const before = process.memoryUsage();
      let peak = before.arrayBuffers;
      async function* bytes() {
        for (let written = 0; written < size; written += 65536) {
          const chunk = Buffer.alloc(Math.min(65536, size - written), 0x78);
          peak = Math.max(peak, process.memoryUsage().arrayBuffers);
          yield chunk;
        }
      }
      const started = performance.now();
      const asset = await kernel.assets.createStream(
        project.id,
        "upload.bin",
        bytes(),
        "upload",
        undefined,
        undefined,
        size,
      );
      const after = process.memoryUsage();
      peak = Math.max(peak, after.arrayBuffers);
      assert.equal(asset.size, size);
      return {
        inputBytes: size,
        chunkBytes: 65536,
        durationMs: performance.now() - started,
        peakArrayBufferDeltaBytes: peak - before.arrayBuffers,
        finalArrayBufferDeltaBytes: after.arrayBuffers - before.arrayBuffers,
        rssDeltaBytes: after.rss - before.rss,
      };
    }
    const { Store } = await import(entry("storage/store.js"));
    store = new Store(scratch);
    if (scenario === "history" || scenario === "compaction") {
      const { loadRunHistory } = await import(
        entry("core/kernel/run-setup.js")
      );
      store.transaction(() => {
        const insert = store.db.prepare(
          "INSERT INTO messages(session_id,message_id,body) VALUES('s',?,?)",
        );
        for (let i = 0; i < count; i++)
          insert.run(
            `m${i}`,
            JSON.stringify({
              id: `m${i}`,
              runId: "r",
              message:
                i % 2
                  ? {
                      role: "assistant",
                      content: [{ type: "text", text }],
                      timestamp: i,
                    }
                  : { role: "user", content: text, timestamp: i },
            }),
          );
      });
      if (scenario === "compaction") {
        const { ExecutionEngine } = await import(entry("runtime/engine.js"));
        const { emptyUsage } = await import(entry("runtime/types.js"));
        let history = store.transcript("s").map((item) => item.message);
        const original = new WeakRef(history[0]);
        const engine = new ExecutionEngine({
          runId: "compact",
          routeId: "text",
          instructions: "benchmark",
          history,
          compactHistory: true,
          maxHistoryBytes: 128 * 1024 * 1024,
          maxMessages: 20000,
          tools: [],
          maxSteps: 2,
          maxToolCalls: 1,
          timeoutMs: 5000,
          store,
          publish() {},
          checkpoint(message, id) {
            store.appendTranscript("s", { id, runId: "compact", message });
          },
          prepare: async (messages) => [
            messages[0],
            { role: "user", content: "synthetic summary", timestamp: 0 },
            ...messages.slice(-200),
          ],
          provider: {
            complete: async (request) => {
              assert.ok(request.messages.length <= 202);
              return {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                model: "benchmark",
                provider: "benchmark",
                usage: emptyUsage(),
                stopReason: "stop",
                timestamp: 1,
              };
            },
          },
        });
        history = undefined;
        global.gc();
        const before = process.memoryUsage();
        const result = await engine.run({
          role: "user",
          content: "continue",
          timestamp: 1,
        });
        assert.equal(result.status, "completed");
        await immediate();
        global.gc();
        const after = process.memoryUsage();
        const originalReleased = original.deref() === undefined;
        assert.ok(
          originalReleased,
          "Engine retained the omitted history prefix",
        );
        assert.equal(store.transcriptCount("s"), count + 2);
        return {
          sourceRows: count,
          activeRows: engine.history.length,
          durableRows: store.transcriptCount("s"),
          originalReleased,
          fullHeapBytes: before.heapUsed,
          compactHeapBytes: after.heapUsed,
          releasedHeapBytes: before.heapUsed - after.heapUsed,
        };
      }
      const full = await readSample(() =>
        loadRunHistory(store, "s", 20000, {
          routeId: "text",
          maxBytes: 128 * 1024 * 1024,
        }),
      );
      let history = store.transcript("s");
      assert.ok(
        store.saveHistoryCheckpoint("s", "text", history[count - 201].message, {
          role: "user",
          content:
            "<continuation_summary>Earlier history retained in SQLite.</continuation_summary>",
          timestamp: 0,
        }),
      );
      history = undefined;
      const checkpoint = await readSample(() =>
        loadRunHistory(store, "s", 20000, {
          routeId: "text",
          maxBytes: 128 * 1024 * 1024,
        }),
      );
      assert.equal(checkpoint.rows, 201);
      return { sourceRows: count, textBytesPerRow: 1024, full, checkpoint };
    }
    if (scenario === "lists") {
      store.transaction(() => {
        const insert = store.db.prepare(
          "INSERT INTO e_jobs(id,body) VALUES(?,?)",
        );
        for (let i = 0; i < count; i++)
          insert.run(
            `j${i}`,
            JSON.stringify({
              id: `j${i}`,
              projectId: "p",
              status: "completed",
              prompt: text,
            }),
          );
      });
      const full = await readSample(() => store.list("jobs"));
      const page = await readSample(() => store.page("jobs", {}, 0, 100).items);
      assert.equal(page.rows, 100);
      return { sourceRows: count, textBytesPerRow: 1024, full, page };
    }
    store.write("runs", {
      id: "old",
      sessionId: "s",
      status: "completed",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    store.transaction(() => {
      const insert = store.db.prepare(
        "INSERT INTO events(run_id,body) VALUES('old',?)",
      );
      for (let i = 0; i < 50000; i++)
        insert.run(JSON.stringify({ index: i, text }));
    });
    global.gc();
    let active = true,
      maxGap = 0,
      last = performance.now();
    const tick = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (active) setImmediate(tick);
    };
    setImmediate(tick);
    const started = performance.now();
    const deleted = await store.pruneAsync(
      { events: "2021-01-01T00:00:00.000Z" },
      500,
    );
    const durationMs = performance.now() - started;
    active = false;
    await immediate();
    assert.equal(deleted.events, 50000);
    return {
      sourceEvents: 50000,
      batch: 500,
      durationMs,
      maxEventLoopGapMs: maxGap,
      deleted,
    };
  } finally {
    if (kernel) await kernel.close();
    else store?.close();
    const target = await realpath(scratch);
    const relative = path.relative(parent, target);
    assert.ok(
      relative &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative) &&
        path.basename(target).startsWith("foundation-capacity-bench-"),
    );
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
}
async function fingerprint(directory) {
  const digest = createHash("sha256");
  async function walk(folder) {
    for (const item of (await readdir(folder, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else
        digest
          .update(path.relative(directory, file).replaceAll("\\", "/"))
          .update(await readFile(file));
    }
  }
  await walk(directory);
  return digest.digest("hex");
}
if (values.child) {
  assert.ok(scenarios.includes(values.child));
  console.log(JSON.stringify(await sample(values.child)));
} else {
  const samples = Number(values.samples);
  assert.ok(
    Number.isInteger(samples) &&
      samples >= 3 &&
      samples <= 15 &&
      samples % 2 === 1,
  );
  const report = {
    checkedAt: new Date().toISOString(),
    status: "passed",
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0]?.model,
    },
    sourceSha256: await fingerprint(path.join(root, "src")),
    distSha256: await fingerprint(path.join(root, "dist")),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    samplesPerScenario: samples,
    method:
      "Independent sequential child processes with explicit GC before each read; synthetic local data, no model calls. Read allocations and retained heaps are distinct. Upload tracks peak ArrayBuffer bytes over fresh 64 KiB chunks. Retention samples setImmediate gaps between transactions.",
    limitations: [
      "A fixed synthetic summary validates checkpoint loading, not model summary quality. First-time history with no checkpoint still loads the original prefix within the byte budget.",
      "Upload includes streaming disk writes and hashing; its elapsed time is not directly comparable to a buffered request-body-only measurement.",
      "GC, filesystem cache and other system activity affect allocation and timing measurements. This is not a production concurrency or memory leak test.",
    ],
    scenarios: {},
  };
  for (const scenario of scenarios) {
    const results = [];
    for (let i = 0; i < samples; i++) {
      const child = spawnSync(
        process.execPath,
        ["--expose-gc", filename, "--child", scenario],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      assert.ok(
        !child.error && child.status === 0,
        child.error?.message || child.stderr,
      );
      results.push(JSON.parse(child.stdout));
    }
    report.scenarios[scenario] = results;
    console.log(`${scenario}: ${results.length} samples passed`);
  }
  if (values.baseline)
    report.baseline = JSON.parse(
      await readFile(path.resolve(root, values.baseline), "utf8"),
    );
  const output = path.resolve(root, values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(output);
}
