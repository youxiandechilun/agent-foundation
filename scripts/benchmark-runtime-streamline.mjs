import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @typedef {"baseline" | "current"} Version
 * @typedef {{ ToolScheduler: typeof import("../src/runtime/scheduler.js").ToolScheduler,
 *   CostLedger: typeof import("../src/runtime/cost.js").CostLedger }} RuntimeModules
 * @typedef {Pick<import("../src/runtime/cost.js").CostEntry,
 *   "id" | "status" | "reservedMicros" | "basis"> & { chargedMicros: number }} MeasuredEntry
 * @typedef {{ samplesMs: Record<Version, number[]>, baselineMedianMs: number,
 *   currentMedianMs: number, ratio: number, reductionPercent: number }} ScenarioResult
 */

const root = fileURLToPath(new URL("..", import.meta.url));
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return path.resolve(root, at < 0 ? fallback : process.argv[at + 1]);
};
const baseline = option(
  "--baseline",
  ".agent-data-refactor/streamline-20261018-before/dist",
);
const current = option(
  "--current",
  ".agent-data-refactor/streamline-runtime-after/dist",
);
const output = option(
  "--output",
  "verification/streamline-runtime-benchmark.json",
);
/** @param {string} directory @returns {Promise<RuntimeModules>} */
const load = async (directory) => ({
  ...(await import(
    pathToFileURL(path.join(directory, "runtime/scheduler.js")).href
  )),
  ...(await import(
    pathToFileURL(path.join(directory, "runtime/cost.js")).href
  )),
});
const versions = {
  baseline: await load(baseline),
  current: await load(current),
};
const tool = {
  name: "benchmark",
  description: "isolated scheduler benchmark",
  parameters: {},
  scheduling: { parallelSafe: true, resources: () => [] },
  execute: async () => ({ content: [] }),
};

/** @param {RuntimeModules} modules */
async function cancellation({ ToolScheduler }) {
  const scheduler = new ToolScheduler(1);
  const release = await scheduler.acquire(tool, {});
  const count = 20_000,
    controllers = [],
    pending = [];
  const reason = new Error("benchmark cancellation");
  for (let i = 0; i < count; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    pending.push(
      scheduler.acquire(tool, {}, controller.signal).then(
        () => {
          throw new Error("Cancelled waiter was granted");
        },
        (/** @type {unknown} */ error) => {
          assert.equal(error, reason);
        },
      ),
    );
  }
  assert.equal(scheduler.state.queued, count);
  const start = performance.now();
  for (let i = count - 1; i >= 0; i--) controllers[i].abort(reason);
  await Promise.all(pending);
  const elapsedMs = performance.now() - start;
  release();
  assert.deepEqual(scheduler.state, { active: 0, queued: 0, limit: 1 });
  return elapsedMs;
}

/** @param {RuntimeModules} modules */
async function grants({ ToolScheduler }) {
  const scheduler = new ToolScheduler(1);
  const release = await scheduler.acquire(tool, {});
  const count = 20_000,
    pending = [];
  let completed = 0;
  for (let i = 0; i < count; i++)
    pending.push(
      scheduler.acquire(tool, {}).then((releaseNext) => {
        assert.equal(completed++, i, "FIFO admission must be unchanged");
        releaseNext();
      }),
    );
  const start = performance.now();
  release();
  await Promise.all(pending);
  const elapsedMs = performance.now() - start;
  assert.equal(completed, count);
  assert.deepEqual(scheduler.state, { active: 0, queued: 0, limit: 1 });
  return elapsedMs;
}

/** @type {MeasuredEntry["status"][]} */
const statuses = ["reserved", "settled", "unknown", "void"];
/** @type {MeasuredEntry[]} */
const entries = Array.from({ length: 100_000 }, (_, index) => ({
  id: String(index),
  status: statuses[index % 4],
  reservedMicros: index % 1000,
  chargedMicros: index % 300,
  basis: index % 5 ? "provider-usage" : "unpriced",
}));
const expected = entries.reduce(
  (total, entry) => {
    total.chargedMicros += entry.chargedMicros;
    if (entry.status === "reserved" || entry.status === "unknown")
      total.heldMicros += entry.reservedMicros;
    if (entry.status !== "void")
      total.committedMicros +=
        entry.status === "settled" ? entry.chargedMicros : entry.reservedMicros;
    if (entry.basis === "unpriced") total.unpriced++;
    return total;
  },
  { chargedMicros: 0, heldMicros: 0, committedMicros: 0, unpriced: 0 },
);

/** @param {RuntimeModules} modules */
function summary({ CostLedger }) {
  // Keep storage and allocation outside the measured region to isolate aggregation.
  const summarize = CostLedger.prototype.summary.bind({
    entries: () => entries,
  });
  const start = performance.now();
  let result;
  for (let i = 0; i < 40; i++) result = summarize();
  const elapsedMs = performance.now() - start;
  assert.ok(result);
  for (const field of /** @type {(keyof typeof expected)[]} */ (
    Object.keys(expected)
  ))
    assert.equal(result[field], expected[field]);
  assert.equal(result.entries, entries);
  assert.equal(result.committedUsd, expected.committedMicros / 1e6);
  return elapsedMs;
}

/** @param {number[]} samples */
const median = (samples) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const scenarios = {
  queueCancellation: cancellation,
  queueGrants: grants,
  costSummary: summary,
};
/** @type {Partial<Record<keyof typeof scenarios, ScenarioResult>>} */
const results = {};
/** @type {Version[]} */
const forward = ["baseline", "current"];
/** @type {Version[]} */
const reverse = ["current", "baseline"];
for (const name of /** @type {(keyof typeof scenarios)[]} */ (
  Object.keys(scenarios)
)) {
  const operation = scenarios[name];
  /** @type {Record<Version, number[]>} */
  const samples = { baseline: [], current: [] };
  for (const version of forward) await operation(versions[version]);
  for (let round = 0; round < 5; round++)
    for (const version of round % 2 ? reverse : forward)
      samples[version].push(await operation(versions[version]));
  const before = median(samples.baseline),
    after = median(samples.current);
  results[name] = {
    samplesMs: samples,
    baselineMedianMs: before,
    currentMedianMs: after,
    ratio: before / after,
    reductionPercent: (100 * (before - after)) / before,
  };
  console.log(
    `${name}: ${before.toFixed(2)} -> ${after.toFixed(2)} ms (${(before / after).toFixed(2)}x)`,
  );
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      baseline,
      current,
      method:
        "One process; one warm-up per version; five alternating rounds; median; equivalent-result assertions.",
      scenarios: {
        queueCancellation:
          "Cancel 20,000 blocked waiters in reverse insertion order; excludes enqueue setup.",
        queueGrants:
          "Admit 20,000 queued independent waiters with concurrency 1; assert FIFO and clean final state.",
        costSummary:
          "40 summaries of the same 100,000 in-memory ledger entries; excludes database I/O.",
      },
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(output);
