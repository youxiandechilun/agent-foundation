import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

// node scripts/benchmark-scheduler.mjs --baseline=<baseline dist> [--current=<current dist>]
const root = fileURLToPath(new URL("..", import.meta.url));
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--(baseline|current)=(.+)$/.exec(argument);
  if (!match || options.has(match[1]))
    throw new Error(`无效或重复参数：${argument}`);
  options.set(match[1], path.resolve(match[2]));
}
if (!options.has("baseline"))
  throw new Error("请用 --baseline=<dist目录> 指定修改前的已编译代码。");
const baselineDirectory = options.get("baseline");
const currentDirectory = options.get("current") ?? path.join(root, "dist");
const { ToolScheduler: BaselineScheduler } = await import(
  pathToFileURL(path.join(baselineDirectory, "runtime/scheduler.js"))
);
const { ToolScheduler: CurrentScheduler } = await import(
  pathToFileURL(path.join(currentDirectory, "runtime/scheduler.js"))
);
const workload = {
  tools: 500,
  resourcesPerTool: 100,
  concurrency: 32,
  measuredRounds: 5,
};
// Preallocate inputs so this measures admission/draining, excluding tool work and I/O.
const tools = Array.from({ length: workload.tools }, (_, index) => {
  const locks = Array.from(
    { length: workload.resourcesPerTool },
    (_, resource) => ({
      key: `resource-${index}-${resource}`,
      access: "write",
    }),
  );
  return {
    name: "benchmark",
    description: "independent resource declarations",
    parameters: {},
    scheduling: { parallelSafe: true, resources: () => locks },
    execute: async () => ({ content: [] }),
  };
});

async function measure(Scheduler) {
  const scheduler = new Scheduler(workload.concurrency);
  const start = performance.now();
  const pending = tools.map((tool) => scheduler.acquire(tool, {}));
  await Promise.all(
    pending.map(async (acquired) => {
      const release = await acquired;
      await Promise.resolve();
      release();
    }),
  );
  const elapsed = performance.now() - start;
  assert.deepEqual(scheduler.state, {
    active: 0,
    queued: 0,
    limit: workload.concurrency,
  });
  return elapsed;
}

await measure(BaselineScheduler);
await measure(CurrentScheduler);
const beforeMs = [],
  afterMs = [];
for (let round = 0; round < workload.measuredRounds; round++) {
  // Alternate order to reduce systematic first-run effects.
  if (round % 2) {
    afterMs.push(await measure(CurrentScheduler));
    beforeMs.push(await measure(BaselineScheduler));
  } else {
    beforeMs.push(await measure(BaselineScheduler));
    afterMs.push(await measure(CurrentScheduler));
  }
}
const median = (samples) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const beforeMedianMs = median(beforeMs),
  afterMedianMs = median(afterMs);
console.log(
  JSON.stringify(
    {
      node: process.version,
      baselineDirectory,
      currentDirectory,
      workload,
      beforeMs,
      afterMs,
      beforeMedianMs,
      afterMedianMs,
      ratio: beforeMedianMs / afterMedianMs,
      scope:
        "仅比较独立资源声明下的调度仲裁开销，不代表模型、网络或工具执行速度。",
    },
    null,
    2,
  ),
);
