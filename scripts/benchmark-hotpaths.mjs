// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import {
  fingerprint,
  scriptFingerprints,
  summarize,
} from "./benchmark-hotpaths-report.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkerResult, scenarios } from "./benchmark-hotpaths-worker.mjs";

/** @typedef {{label: string, directory: string, source?: string}} Version */
/** @typedef {import("./benchmark-hotpaths-worker.mjs").WorkerResult & {label: string, round: number, position: number, stderr: string}} Sample */

const help = `Usage: node scripts/benchmark-hotpaths.mjs [options]

Required (repeat for each version; paths are resolved from the current directory):
  --version=<label>=<compiled-dir>   Compiled directory containing core/, storage/, runtime/
Optional:
  --source=<label>=<source-dir>      Source directory to fingerprint; no build or checkout occurs
  --output=<report.json>            Default: verification/hotpath-fix/benchmark.json
  --scenarios=<comma-separated>     Default: all scenarios
  --rounds=<n>                      At least 5; default 5
  --warmups=<n>                     Warmups within each independent worker; default 1
  --timeout-ms=<n>                  Per-worker timeout; default 120000
  --smoke                          One small round; correctness only, not performance evidence
  --help                           Show this help without running or writing anything

Examples:
  node scripts/benchmark-hotpaths.mjs --version=eb88ae5=before/dist --source=eb88ae5=before/src --version=a531661=remote/dist --source=a531661=remote/src --version=fixed=dist --source=fixed=src
  node scripts/benchmark-hotpaths.mjs --version=fixed=dist --source=fixed=src --smoke --output=.agent-data-tests/hotpaths-smoke.json

Scenarios: ${scenarios.join(", ")}
The Engine scenario uses real local HTTP/SSE and production APIs; it excludes external model inference.
Do not run performance sampling concurrently with builds, tests, or other benchmark processes.
`;
if (process.argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}

/** @param {string} name */
const values = (name) =>
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3));
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
  const found = values(name);
  assert.ok(found.length <= 1, `Duplicate --${name}`);
  return found[0] ?? fallback;
};
/** @param {string} value */
function pair(value) {
  const at = value.indexOf("=");
  assert.ok(at > 0 && at < value.length - 1, "Expected label=directory");
  const label = value.slice(0, at);
  assert.match(
    label,
    /^[A-Za-z0-9._-]+$/,
    "Labels may contain letters, digits, dot, underscore and hyphen",
  );
  return { label, directory: path.resolve(value.slice(at + 1)) };
}
/** @param {string} name @param {number} fallback @param {number} minimum */
function integer(name, fallback, minimum) {
  const value = Number(option(name, String(fallback)));
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum,
    `--${name} must be an integer >= ${minimum}`,
  );
  return value;
}
for (const arg of process.argv.slice(2))
  assert.ok(
    arg === "--smoke" ||
      /^--(version|source|output|scenarios|rounds|warmups|timeout-ms)=/.test(
        arg,
      ),
    `Unknown argument: ${arg}`,
  );
const smoke = process.argv.includes("--smoke");
const rounds = integer("rounds", smoke ? 1 : 5, smoke ? 1 : 5),
  warmups = integer("warmups", 1, 1);
const timeout = integer("timeout-ms", 120000, 1000);
const output = path.resolve(
  option("output", "verification/hotpath-fix/benchmark.json"),
);
/** @type {Version[]} */
const versions = values("version").map(pair);
assert.ok(versions.length > 0, help);
assert.equal(
  new Set(versions.map((version) => version.label)).size,
  versions.length,
  "Duplicate version label",
);
for (const value of values("source")) {
  const source = pair(value),
    version = versions.find((item) => item.label === source.label);
  assert.ok(
    version && !version.source,
    `Unknown or duplicate source label: ${source.label}`,
  );
  version.source = source.directory;
}
const selected = option("scenarios", scenarios.join(",")).split(",");
assert.ok(
  selected.length && selected.every((name) => scenarios.includes(name)),
  "Unknown scenario",
);
assert.equal(new Set(selected).size, selected.length, "Duplicate scenario");

const identities = [];
for (const version of versions) {
  await readFile(path.join(version.directory, "storage/store.js"));
  identities.push({
    ...version,
    compiled: await fingerprint(version.directory, true),
    sourceFiles: version.source
      ? await fingerprint(version.source, false)
      : null,
  });
}
const worker = fileURLToPath(
  new URL("./benchmark-hotpaths-worker.mjs", import.meta.url),
);
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const scripts = await scriptFingerprints(scriptsDirectory);
const environmentKeys = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
];
const childEnv = Object.fromEntries(
  environmentKeys.flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : [],
  ),
);
childEnv.NODE_ENV = "test";
childEnv.TZ = "UTC";
/** @type {Sample[]} */
const samples = [];
const startedAt = new Date().toISOString();
for (const scenario of selected) {
  for (let round = 0; round < rounds; round++) {
    const offset = versions.length === 2 ? 0 : round % versions.length;
    const order = [...versions.slice(offset), ...versions.slice(0, offset)];
    if (round % 2) order.reverse();
    for (const [position, version] of order.entries()) {
      console.error(
        `${smoke ? "smoke" : "sample"} ${scenario} round=${round + 1}/${rounds} version=${version.label}`,
      );
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          worker,
          JSON.stringify({
            directory: version.directory,
            scenario,
            smoke,
            warmups,
          }),
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: childEnv,
          timeout,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (child.error) throw child.error;
      assert.equal(
        child.status,
        0,
        `Worker failed (${version.label}/${scenario}): ${child.stderr}\n${child.stdout}`,
      );
      /** @type {unknown} */
      const result = JSON.parse(child.stdout.trim());
      assertWorkerResult(result);
      assert.equal(result.scenario, scenario);
      assert.equal(result.node, process.version);
      assert.equal(result.warmups.length, warmups);
      samples.push({
        label: version.label,
        round: round + 1,
        position: position + 1,
        ...result,
        stderr: child.stderr.trim(),
      });
    }
  }
}
for (const identity of identities) {
  assert.deepEqual(
    await fingerprint(identity.directory, true),
    identity.compiled,
    `Compiled files changed during sampling: ${identity.label}`,
  );
  if (identity.source)
    assert.deepEqual(
      await fingerprint(identity.source, false),
      identity.sourceFiles,
      `Sources changed during sampling: ${identity.label}`,
    );
}
const results = summarize(samples, versions, selected, rounds);
assert.deepEqual(
  await scriptFingerprints(scriptsDirectory),
  scripts,
  "Benchmark scripts changed during sampling",
);
const report = {
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  smoke,
  rounds,
  warmups,
  method:
    "Fresh Node process per version/scenario/round; in-process warmups on separate fresh databases; rotate version order and reverse every other round (two versions alternate directly); GC before each timed region; setup and post-run verification excluded; timed Engine includes loopback fixture parsing, validation and response generation; sequential workers.",
  limitation:
    "Local microbenchmarks and a deterministic loopback HTTP/SSE Engine scenario. No external model inference/network latency, native desktop UI, or full Kernel authorization path. Smoke results are correctness checks only. A forcibly terminated worker can leave its isolated OS temporary directory; successful workers clean up.",
  environment: {
    node: process.version,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    childEnvironmentKeys: [...environmentKeys, "NODE_ENV", "TZ"],
    secretFixture:
      "Three fixed synthetic credentials; user credential environment is not inherited",
  },
  command: [process.execPath, ...process.argv.slice(1)],
  scripts,
  identities,
  results,
  samples,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(output);
