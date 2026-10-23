// Build current first. Baseline is optional; every sample runs in a fresh process.
// node scripts/benchmark-followup-storage.mjs --baseline=.agent-data-tests/optimization-followup-baseline-dist
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const scenario = option("child", "");
const rows = Number(option("rows", "4000"));
assert.ok(Number.isSafeInteger(rows) && rows > 0 && rows <= 10000);

if (scenario) {
  assert.equal(typeof global.gc, "function", "Worker requires --expose-gc");
  const runtime = path.resolve(option("current", "dist"));
  const load = (name) => import(pathToFileURL(path.join(runtime, name)).href);
  const [{ Store }, { MemoryStore }, { Checkpoints }] = await Promise.all([
    load("storage/store.js"),
    load("storage/memory.js"),
    load("sessions/checkpoints.js"),
  ]);
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(
    path.join(parent, "foundation-followup-storage-"),
  );
  let store;
  let timer;
  try {
    store = new Store(path.join(directory, "data"));
    const samples = [];
    let result;
    if (scenario === "memory-import") {
      store.put("projects", { id: "project", root: directory });
      const memory = new MemoryStore(store, {});
      const entries = Array.from({ length: rows }, (_, index) => ({
        content: `fact ${index} unique content`,
        tags: [],
      }));
      global.gc();
      const started = performance.now();
      const imported = memory.import("project", entries);
      result = { rows, elapsedMs: performance.now() - started };
      assert.equal(imported.length, rows);
      assert.equal(store.count("memories"), rows);
      const sql = store.db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name='memories_content_lookup'",
        )
        .get()?.sql;
      result.digestIndexPresent = Boolean(sql);
    } else if (scenario === "checkpoint-conflict") {
      const checkpoints = new Checkpoints(store, path.join(directory, "data"));
      const file = path.join(directory, "tracked.bin");
      await writeFile(file, "before");
      const checkpoint = await checkpoints.capture(
        {
          sessionId: "session",
          projectId: "project",
          runId: "run",
          callId: "call",
        },
        directory,
        "tracked.bin",
      );
      checkpoints.complete(checkpoint, "after");
      const handle = await open(file, "r+");
      await handle.truncate(128 * 1024 * 1024);
      await handle.close();
      global.gc();
      const before = process.memoryUsage();
      timer = setInterval(() => samples.push(process.memoryUsage()), 2);
      const started = performance.now();
      const rewind = await checkpoints.revert(
        "session",
        directory,
        new Set(["call"]),
      );
      const elapsedMs = performance.now() - started;
      samples.push(process.memoryUsage());
      clearInterval(timer);
      assert.equal(rewind.conflicts.length, 1);
      const peak = (key) =>
        Math.max(...samples.map((sample) => sample[key])) - before[key];
      result = {
        fileMiB: 128,
        elapsedMs,
        sampledRssDeltaMiB: peak("rss") / 2 ** 20,
        sampledArrayBuffersDeltaMiB: peak("arrayBuffers") / 2 ** 20,
        sampleCount: samples.length,
      };
    } else throw new Error("Unknown benchmark scenario");
    console.log(JSON.stringify({ scenario, node: process.version, result }));
  } finally {
    clearInterval(timer);
    store?.close();
    const resolved = await realpath(directory);
    const relative = path.relative(parent, resolved);
    assert.ok(
      relative &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative),
    );
    assert.ok(
      path.basename(resolved).startsWith("foundation-followup-storage-"),
    );
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
} else {
  const count = Number(option("samples", "3"));
  assert.ok(Number.isSafeInteger(count) && count >= 3 && count <= 5);
  const variants = [
    { name: "current", runtime: path.resolve(option("current", "dist")) },
  ];
  const baseline = option("baseline", "");
  if (baseline)
    variants.unshift({ name: "baseline", runtime: path.resolve(baseline) });
  const records = [];
  for (const name of ["memory-import", "checkpoint-conflict"]) {
    const runs = Object.fromEntries(
      variants.map((variant) => [variant.name, []]),
    );
    for (let round = 0; round < count; round++) {
      for (const variant of round % 2 ? [...variants].reverse() : variants) {
        const child = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            fileURLToPath(import.meta.url),
            `--child=${name}`,
            `--current=${variant.runtime}`,
            `--rows=${rows}`,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            windowsHide: true,
            timeout: 60000,
          },
        );
        assert.equal(child.status, 0, child.stderr || child.error?.message);
        runs[variant.name].push(JSON.parse(child.stdout.trim()).result);
      }
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    records.push({
      scenario: name,
      variants: variants.map((variant) => ({
        name: variant.name,
        runtime: variant.runtime,
        samples: runs[variant.name],
        medians: Object.fromEntries(
          Object.keys(runs[variant.name][0])
            .filter((key) => typeof runs[variant.name][0][key] === "number")
            .map((key) => [
              key,
              median(runs[variant.name].map((run) => run[key])),
            ]),
        ),
      })),
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        samplesPerVariant: count,
        method:
          "Fresh child processes and SQLite directories, alternating baseline/current order; no model or network calls. Checkpoint memory sampled every 2ms plus end-of-call; GC is explicit only before the measured call.",
        limitation:
          "Local synthetic measurements vary with machine load, JIT, filesystem and GC. Sampled RSS/ArrayBuffer deltas are not exact allocation peaks or evidence of long-term leaks. Synchronous import remains atomic and can pause the event loop during its final commit.",
        records,
      },
      null,
      2,
    ),
  );
}
