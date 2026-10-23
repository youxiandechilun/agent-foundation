import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const script = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(script));
const { values } = parseArgs({
  options: {
    child: { type: "boolean", default: false },
    dist: { type: "string", default: "dist" },
    baseline: { type: "string" },
    samples: { type: "string", default: "3" },
    output: {
      type: "string",
      default: "verification/optimization-followup-20261023/device-queue.json",
    },
  },
});

async function sample() {
  assert.equal(typeof global.gc, "function");
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(
    path.join(parent, "foundation-node-benchmark-"),
  );
  const load = (file) =>
    import(pathToFileURL(path.resolve(root, values.dist, file)).href);
  const { Store } = await load("storage/store.js");
  const { NodeManager } = await load("host/nodes.js");
  const store = new Store(directory),
    nodes = new NodeManager(store);
  try {
    store.put("projects", { id: "p", root: directory });
    const node = nodes.pair({
      projectId: "p",
      name: "benchmark",
      capabilities: ["read"],
    });
    store.transaction(() => {
      for (let i = 0; i < 10000; i++)
        store.put("node-tasks", {
          id: `history-${i}`,
          nodeId: "unrelated",
          capability: "read",
          status: "completed",
          args: "x".repeat(1024),
          result: "y".repeat(1024),
          createdAt: "2026-01-01T00:00:00.000Z",
          deadline: "2026-01-01T00:01:00.000Z",
        });
    });
    assert.equal(nodes.claim(node.id), undefined);
    global.gc();
    const before = process.memoryUsage(),
      started = performance.now();
    assert.equal(nodes.claim(node.id), undefined);
    const durationMs = performance.now() - started,
      after = process.memoryUsage();
    return {
      durationMs,
      allocatedHeapBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
    };
  } finally {
    nodes.close();
    store.close();
    const target = await realpath(directory),
      relative = path.relative(parent, target);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(target, { recursive: true, force: true });
  }
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

if (values.child) console.log(JSON.stringify(await sample()));
else {
  const samples = Number(values.samples);
  assert.ok(
    Number.isInteger(samples) &&
      samples > 0 &&
      samples <= 15 &&
      samples % 2 === 1,
  );
  const variants = {
    current: values.dist,
    ...(values.baseline ? { baseline: values.baseline } : {}),
  };
  const results = Object.fromEntries(
    Object.keys(variants).map((key) => [key, []]),
  );
  for (let round = 0; round < samples; round++) {
    const entries = Object.entries(variants);
    if (round % 2) entries.reverse();
    for (const [name, dist] of entries) {
      const child = spawnSync(
        process.execPath,
        ["--expose-gc", script, "--child", "--dist", dist],
        { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000 },
      );
      assert.equal(child.status, 0, child.error?.message || child.stderr);
      results[name].push(JSON.parse(child.stdout));
    }
  }
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    scenario:
      "One empty device claim with 10,000 unrelated completed tasks; args/result each 1 KiB; fresh process and SQLite per sample, one warmup, explicit GC before measuring.",
    limitations:
      "Heap deltas are pre-GC allocations, not retained heap or precise peak memory. Local synthetic measurements do not predict complete agent throughput.",
    results,
    medians: Object.fromEntries(
      Object.entries(results).map(([name, rows]) => [
        name,
        Object.fromEntries(
          ["durationMs", "allocatedHeapBytes", "rssDeltaBytes"].map((field) => [
            field,
            median(rows.map((row) => row[field])),
          ]),
        ),
      ]),
    ),
  };
  const output = path.resolve(root, values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.medians, null, 2));
}
