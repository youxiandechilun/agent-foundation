// Build both variants before running; every measurement uses a fresh Node process.
// node scripts/benchmark-mcp-task-retention.mjs --baseline=.agent-data-tests/optimization-complete-baseline-dist --current=dist --samples=3 --output=verification/optimization-completion-20261023/mcp-memory.json
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const { values } = parseArgs({
  options: {
    baseline: {
      type: "string",
      default: ".agent-data-tests/optimization-complete-baseline-dist",
    },
    current: { type: "string", default: "dist" },
    samples: { type: "string", default: "3" },
    output: {
      type: "string",
      default: "verification/optimization-completion-20261023/mcp-memory.json",
    },
    child: { type: "boolean", default: false },
    runtime: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
const sampleCount = Number(values.samples);
assert.ok(
  Number.isSafeInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 9,
  "--samples must be an integer from 3 to 9",
);
const memoryFields = ["rss", "heapUsed", "external", "arrayBuffers"];
const phases = ["before", "release", "close", "drop"];
const workload = {
  tasks: 128,
  resultBytesPerTask: 256 * 1024,
  argumentBytesPerTask: 64 * 1024,
  localContextBytesPerTask: 64 * 1024,
  expectedResultBytes: 128 * 256 * 1024,
  discardedOriginBytes: 128 * 2 * 64 * 1024,
};
const runtimeFiles = [
  "extensions/mcp/tasks/modern.js",
  "core/util.js",
  "core/redaction.js",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function runtimeHashes(directory) {
  return Object.fromEntries(
    await Promise.all(
      runtimeFiles.map(async (file) => [
        file,
        sha256(await readFile(path.join(directory, file))),
      ]),
    ),
  );
}

function memory() {
  assert.equal(typeof global.gc, "function", "Child requires --expose-gc");
  for (let iteration = 0; iteration < 3; iteration++) global.gc();
  const usage = process.memoryUsage();
  return Object.fromEntries(
    memoryFields.map((field) => [`${field}Bytes`, usage[field]]),
  );
}

async function measure() {
  assert.ok(values.runtime, "Child requires --runtime");
  const runtime = path.resolve(root, values.runtime);
  const hashesBefore = await runtimeHashes(runtime);
  const { ModernMCPTasks } = await import(
    pathToFileURL(path.join(runtime, runtimeFiles[0])).href
  );
  let tasks = new ModernMCPTasks();
  await setImmediate();
  const before = memory();
  function add(index) {
    const task = {
      taskId: `task_${index}`,
      status: "working",
      createdAt: "2026-10-23T00:00:00.000Z",
      lastUpdatedAt: "2026-10-23T00:00:00.000Z",
      ttlMs: null,
    };
    tasks.create(
      task,
      {
        requestId: index,
        method: "tools/call",
        params: {
          name: "synthetic-memory-result",
          arguments: {
            payload: randomBytes(workload.argumentBytesPerTask / 2).toString(
              "hex",
            ),
          },
        },
        localContext: {
          hostData: randomBytes(workload.localContextBytesPerTask / 2).toString(
            "hex",
          ),
        },
        signal: new AbortController().signal,
      },
      undefined,
      Date.now() + 30000,
    );
    tasks.update({
      ...task,
      status: "completed",
      lastUpdatedAt: "2026-10-23T00:00:01.000Z",
      result: {
        content: [
          {
            type: "text",
            text: randomBytes(workload.resultBytesPerTask / 2).toString("hex"),
          },
        ],
      },
    });
    tasks.release(task.taskId);
  }
  const started = performance.now();
  for (let index = 0; index < workload.tasks; index++) add(index);
  const createUpdateReleaseMs = performance.now() - started;
  await setImmediate();
  const release = memory();
  const liveOriginRetainedAfterRelease = Boolean(tasks.get("task_0"));
  tasks.close();
  await setImmediate();
  const close = memory();
  const liveOriginRetainedAfterClose = Boolean(tasks.get("task_0"));
  tasks = null;
  await setImmediate();
  const drop = memory();
  assert.deepEqual(await runtimeHashes(runtime), hashesBefore);
  return {
    pid: process.pid,
    node: process.version,
    hashes: hashesBefore,
    createUpdateReleaseMs,
    memory: { before, release, close, drop },
    liveOriginRetainedAfterRelease,
    liveOriginRetainedAfterClose,
    cleanup:
      "tracker closed and reference dropped; no files or database created",
  };
}

function statistics(numbers) {
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    minimum: sorted[0],
    maximum: sorted.at(-1),
  };
}

async function benchmark() {
  const output = path.resolve(root, values.output);
  const variants = [
    { name: "baseline", runtime: path.resolve(root, values.baseline) },
    { name: "current", runtime: path.resolve(root, values.current) },
  ];
  const retainedEnvironment = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "TZ",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      retainedEnvironment.has(key.toUpperCase()),
    ),
  );
  const report = {
    schemaVersion: 1,
    scenario: "mcp-task-retention",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: "",
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    workload,
    samplesPerVariant: sampleCount,
    method:
      "Each variant/sample runs in a fresh serial Node child process with --expose-gc and an allowlisted environment. Import each actual compiled runtime; alternate baseline/current order every round. At each phase yield one event-loop turn, run explicit GC three times, then sample process.memoryUsage(). Random hex payloads have fixed byte lengths and separate origins. No model/network calls, files or database are used by the workload.",
    limitations: [
      "These are post-GC retained-memory snapshots, not allocation or transient peaks. GC, JIT, native allocators and host activity affect the observations; three samples do not prove absence of long-term leaks.",
      "RSS covers the whole process. heapUsed, external and arrayBuffers describe different accounting domains; arrayBuffers is included in external and must not be added to it. None is a substitute for total RSS.",
      "The current implementation retains necessary full task results in bounded Buffer snapshots, so a heapUsed decrease partly moves data to arrayBuffers. Report that retained output separately from the released argument/localContext data.",
      "The baseline must be a separately saved/rebuilt compiled runtime. Runtime module SHA-256 values are recorded before and after each sample; this benchmark neither edits nor transpiles either implementation.",
      "No peer, receiver, MCP manager persistence, model, browser or concurrent production load is included. Local measurements cannot be extrapolated to end-to-end Agent throughput or a process RSS hard limit.",
    ],
    scriptSha256: sha256(await readFile(filename)),
    dependencyLockSha256: sha256(
      await readFile(path.join(root, "package-lock.json")),
    ),
    executionOrder: [],
    variants: variants.map((variant) => ({
      ...variant,
      hashes: {},
      samples: [],
      statistics: {},
      deltaStatistics: {},
    })),
    errors: [],
  };
  try {
    for (const variant of report.variants)
      variant.hashes = await runtimeHashes(variant.runtime);
    for (let round = 0; round < sampleCount; round++) {
      const order =
        round % 2 ? [...report.variants].reverse() : report.variants;
      for (const variant of order) {
        const child = spawnSync(
          process.execPath,
          ["--expose-gc", filename, "--child", `--runtime=${variant.runtime}`],
          {
            cwd: root,
            env,
            encoding: "utf8",
            windowsHide: true,
            timeout: 60000,
            maxBuffer: 1024 * 1024,
          },
        );
        assert.ok(
          !child.error && child.status === 0,
          `${variant.name} sample ${round + 1}: ${child.error?.message || child.stderr || child.signal || child.status}`,
        );
        const sample = JSON.parse(child.stdout);
        assert.deepEqual(sample.hashes, variant.hashes);
        for (const phase of phases)
          for (const field of memoryFields)
            assert.ok(
              Number.isFinite(sample.memory[phase][`${field}Bytes`]) &&
                sample.memory[phase][`${field}Bytes`] >= 0,
              `Invalid ${phase}/${field} measurement`,
            );
        variant.samples.push(sample);
        report.executionOrder.push({
          round: round + 1,
          variant: variant.name,
          pid: sample.pid,
        });
      }
    }
    for (const variant of report.variants) {
      assert.deepEqual(await runtimeHashes(variant.runtime), variant.hashes);
      for (const phase of phases) {
        variant.statistics[phase] = {};
        variant.deltaStatistics[phase] = {};
        for (const field of memoryFields) {
          const key = `${field}Bytes`;
          variant.statistics[phase][key] = statistics(
            variant.samples.map((sample) => sample.memory[phase][key]),
          );
          variant.deltaStatistics[phase][key] = statistics(
            variant.samples.map(
              (sample) => sample.memory[phase][key] - sample.memory.before[key],
            ),
          );
        }
      }
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.errors.push(String(error));
  }
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  assert.equal(report.status, "passed", report.errors.join("\n"));
  console.log(`MCP task retention report: ${output}`);
  for (const variant of report.variants)
    console.log(
      JSON.stringify({
        variant: variant.name,
        mediansMiB: Object.fromEntries(
          phases.map((phase) => [
            phase,
            Object.fromEntries(
              memoryFields.map((field) => [
                field,
                +(
                  variant.statistics[phase][`${field}Bytes`].median /
                  2 ** 20
                ).toFixed(3),
              ]),
            ),
          ]),
        ),
      }),
    );
}

try {
  if (values.help)
    console.log(
      "node scripts/benchmark-mcp-task-retention.mjs --baseline=<saved-dist> --current=dist --samples=3 --output=<report.json>; build both variants first.",
    );
  else if (values.child) console.log(JSON.stringify(await measure()));
  else await benchmark();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
