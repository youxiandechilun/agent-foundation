// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localProvider } from "./benchmark-hotpaths-fixtures.mjs";
import { fingerprint } from "./benchmark-hotpaths-report.mjs";

/** @typedef {'baseline'|'off'|'audit'|'enforce'} Mode */
/** @typedef {{mode:Mode, elapsedMs:number, cpuMs:number, runs:number, auditRecords:number}} Measurement */
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
  const values = process.argv.filter((arg) => arg.startsWith(`--${name}=`));
  assert.ok(values.length <= 1, `Duplicate --${name}`);
  return values[0]?.slice(name.length + 3) ?? fallback;
};
/** @param {string} name @param {number} fallback @param {number} min */
const integer = (name, fallback, min) => {
  const value = Number(option(name, String(fallback)));
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= 1000);
  return value;
};
const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const modes = /** @type {const} */ (["baseline", "off", "audit", "enforce"]);
const runs = integer("runs", 24, 1);
const warmups = integer("warmups", 6, 1);

/** Full Kernel path, including input admission, two tool authorizations and persisted records.
 * @param {Mode} mode @param {string} directory @returns {Promise<Measurement>}
 */
async function measure(mode, directory) {
  const load = (/** @type {string} */ name) =>
    import(pathToFileURL(path.join(directory, name)).href);
  /** @type {typeof import('../src/core/kernel.js')} */
  const { Kernel } = await load("core/kernel.js");
  /** @type {typeof import('../src/core/config.js')} */
  const { parseConfig } = await load("core/config.js");
  const scratchRoot = path.join(root, ".agent-data-security-audit", "samples");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, mode + "-"));
  const provider = await localProvider("benchmark-secret-never-submitted");
  /** @type {InstanceType<typeof Kernel> | undefined} */
  let kernel;
  try {
    const config = parseConfig({
      dataDir: path.join(scratch, "data"),
      workspaceRoots: [path.join(scratch, "workspace")],
      extensions: { allowedRoots: [path.join(scratch, "extensions")] },
      memory: { enabled: false },
      defaultRoutes: { chat: "text", code: "text", office: "text" },
      routes: {
        text: {
          kind: "text",
          adapter: "openai-completions",
          model: "benchmark",
          baseUrl: provider.url,
          contextWindow: 128000,
          maxOutputTokens: 1000,
        },
      },
      ...(mode === "baseline"
        ? {}
        : {
            securityAudit: {
              mode,
              textRules: [
                {
                  id: "sample-policy",
                  terms: ["blocked-example"],
                  action: "deny",
                  stages: ["input", "tool"],
                },
              ],
            },
          }),
    });
    kernel = new Kernel(config);
    await kernel.init();
    kernel.toolRegistry.register("benchmark", () => {
      let total = 0;
      return [
        {
          name: "benchmark_accumulate",
          description: "Accumulate a validated integer",
          parameters: {
            type: "object",
            properties: { value: { type: "integer", minimum: 1, maximum: 2 } },
            required: ["value"],
            additionalProperties: false,
          },
          risk: "read",
          execute: async (_id, args) => {
            assert.equal(typeof args.value, "number");
            total += args.value;
            return {
              content: [
                { type: "text", text: `total=${total}; ${"x".repeat(1024)}` },
              ],
            };
          },
        },
      ];
    });
    kernel.agents.put({
      id: "benchmark",
      name: "benchmark",
      mode: "chat",
      instructions: "Accumulate 1 then 2 and report the result.",
      toolAllowlist: ["benchmark_accumulate"],
    });
    const project = await kernel.createProject("benchmark");
    const activeKernel = kernel;
    const sessions = Array.from({ length: runs + warmups }, () =>
      activeKernel.createSession(
        project.id,
        "chat",
        "benchmark",
        "text",
        "benchmark",
      ),
    );
    const execute = async (/** @type {string} */ sessionId) => {
      assert.ok(kernel);
      const { runId } = await kernel.submit(sessionId, {
        text: "Accumulate 1 then 2.",
      });
      const result = await kernel.wait(runId);
      assert.equal(result.status, "completed", result.error);
      assert.equal(kernel.store.transcript(sessionId).length, 6);
    };
    for (const session of sessions.slice(0, warmups)) await execute(session.id);
    const cpuStart = process.cpuUsage(),
      start = performance.now();
    for (const session of sessions.slice(warmups)) await execute(session.id);
    const elapsedMs = performance.now() - start,
      cpu = process.cpuUsage(cpuStart);
    provider.verify((runs + warmups) * 3);
    const auditRecords = kernel.store.count("security-audits");
    assert.equal(
      auditRecords,
      mode === "baseline" || mode === "off" ? 0 : (runs + warmups) * 3,
    );
    return {
      mode,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      runs,
      auditRecords,
    };
  } finally {
    try {
      await kernel?.close();
    } finally {
      await provider.close();
    }
  }
}

if (process.argv.includes("--help")) {
  console.log(
    "node scripts/benchmark-security-audit.mjs --baseline-dist=<compiled baseline dir> [--current-dist=dist] [--rounds=8] [--runs=24] [--warmups=6] [--output=verification/security-audit/benchmark.json]\nRequires prebuilt versions; never checks out or builds sources. Uses independent workers in rotating order and a real loopback HTTP/SSE model fixture; excludes external inference and startup. Run without concurrent builds/tests. Scratch databases stay in .agent-data-security-audit/samples.",
  );
} else if (process.argv.some((arg) => arg.startsWith("--worker="))) {
  const mode = modes.find((value) => value === option("worker", ""));
  assert.ok(mode);
  console.log(
    JSON.stringify(
      await measure(mode, path.resolve(option("compiled", "dist"))),
    ),
  );
} else {
  const baseline = option("baseline-dist", "");
  assert.ok(baseline, "--baseline-dist is required (use --help)");
  const current = path.resolve(option("current-dist", "dist"));
  const rounds = integer("rounds", 8, 5);
  const output = path.resolve(
    option("output", "verification/security-audit/benchmark.json"),
  );
  /** @type {(Measurement & {round:number,position:number,stderr:string})[]} */
  const samples = [];
  const directories = { baseline: path.resolve(baseline), current };
  const versions = await Promise.all(
    Object.entries(directories).map(async ([label, directory]) => ({
      label,
      directory,
      compiled: await fingerprint(directory, true),
    })),
  );
  for (let round = 0; round < rounds; round++) {
    for (let position = 0; position < modes.length; position++) {
      const mode = modes[(round + position) % modes.length];
      const result = spawnSync(
        process.execPath,
        [
          filename,
          `--worker=${mode}`,
          `--compiled=${mode === "baseline" ? directories.baseline : current}`,
          `--runs=${runs}`,
          `--warmups=${warmups}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      /** @type {unknown} */
      const sample = JSON.parse(result.stdout);
      assert.ok(
        sample &&
          typeof sample === "object" &&
          "mode" in sample &&
          sample.mode === mode,
      );
      assert.ok(
        "elapsedMs" in sample &&
          typeof sample.elapsedMs === "number" &&
          sample.elapsedMs > 0,
      );
      assert.ok(
        "cpuMs" in sample &&
          typeof sample.cpuMs === "number" &&
          Number.isFinite(sample.cpuMs),
      );
      assert.ok("runs" in sample && sample.runs === runs);
      assert.ok(
        "auditRecords" in sample && typeof sample.auditRecords === "number",
      );
      samples.push({
        mode,
        elapsedMs: sample.elapsedMs,
        cpuMs: sample.cpuMs,
        runs,
        auditRecords: sample.auditRecords,
        round,
        position,
        stderr: result.stderr,
      });
      console.log(
        `Round ${round + 1}/${rounds} ${mode}: ${(sample.elapsedMs / runs).toFixed(3)} ms/run`,
      );
    }
  }
  const summaries = modes.map((mode) => {
    const values = samples
      .filter((sample) => sample.mode === mode)
      .map((sample) => sample.elapsedMs / runs)
      .sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return {
      mode,
      medianMsPerRun:
        values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
      minMsPerRun: values[0],
      maxMsPerRun: values.at(-1),
    };
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        rounds,
        runs,
        warmups,
        versions,
        scripts: await Promise.all(
          [
            filename,
            path.join(root, "scripts/benchmark-hotpaths-fixtures.mjs"),
            path.join(root, "scripts/benchmark-hotpaths-report.mjs"),
          ].map(async (file) => ({
            file: path.basename(file),
            sha256: createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          })),
        ),
        scenario:
          "Kernel.submit + wait; 3 model steps, 2 read tools, 1 input; local HTTP/SSE; fresh session per run; startup/session setup excluded; audit/enforce enable prompt-injection and 1 literal rule",
        summaries,
        samples,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(summaries, null, 2));
}
