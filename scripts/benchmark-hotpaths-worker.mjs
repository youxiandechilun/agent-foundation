// @ts-check
import assert from "node:assert/strict";
import { requestJsonScenario } from "./benchmark-hotpaths-fixtures.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEngineScenario } from "./benchmark-hotpaths-engine.mjs";

/** @typedef {import("../src/storage/store.js").Store} Store */
/** @typedef {Record<string, string | number | boolean>} Parameters */
/** @typedef {{operations: number, parameters: Parameters, run: () => void | Promise<void>, verify: () => void, close?: () => Promise<void>}} Scenario */
/** @typedef {{elapsedMs: number, cpuUserMicros: number, cpuSystemMicros: number, rssBeforeBytes: number, rssAfterBytes: number}} Timing */
/** @typedef {{scenario: string, operations: number, parameters: Parameters, warmups: Timing[], measured: Timing, node: string, pid: number}} WorkerResult */

export const scenarios = [
  "request-json",
  "durable-events-small",
  "durable-events-large",
  "ephemeral-observed-small",
  "ephemeral-observed-large",
  "ephemeral-unobserved-small",
  "ephemeral-unobserved-large",
  "transcript-append",
  "engine-local",
];
export const benchmarkSecret = "benchmark-api-key-20261018";

/** Use the production API introduced in a531661; older versions use its original call path.
 * @param {Store} store @returns {(runId: string, type: string, data: Record<string, unknown>) => void}
 */
export function ephemeralEmitter(store) {
  return typeof store.emitEphemeral === "function"
    ? store.emitEphemeral.bind(store)
    : (runId, type, data) => {
        store.emit(runId, type, data, false);
      };
}

/** @param {string} directory @param {string} scenario @param {boolean} smoke @param {Store} store @param {string} scratch @returns {Promise<Scenario>} */
async function setup(directory, scenario, smoke, store, scratch) {
  /** @type {typeof import("../src/core/util.js")} */
  const util = await import(
    pathToFileURL(path.join(directory, "core/util.js")).href
  );
  const secrets = [
    benchmarkSecret,
    "Bearer benchmark-access-token-20261018",
    'benchmark\n"escaped\\secret',
  ];
  for (const secret of secrets) util.registerSecret(secret);
  if (scenario === "engine-local")
    return createEngineScenario(
      directory,
      store,
      scratch,
      smoke ? 1 : 10,
      benchmarkSecret,
      ephemeralEmitter(store),
    );
  if (scenario === "request-json")
    return requestJsonScenario(util, secrets, smoke);
  if (scenario === "transcript-append") {
    const count = smoke ? 10 : 1000;
    const messages = Array.from({ length: count }, (_, i) => ({
      id: `message-${i}`,
      runId: "run",
      message: {
        role: /** @type {const} */ ("user"),
        content: `${"x".repeat(256)} ${benchmarkSecret}`,
        timestamp: i,
      },
    }));
    return {
      operations: count + Math.ceil(count / 4),
      parameters: {
        freshMessages: count,
        identicalRetries: Math.ceil(count / 4),
        messageBytes: Buffer.byteLength(JSON.stringify(messages[0])),
        transaction: "one normal append at a time",
      },
      run: () => {
        for (let i = 0; i < count; i++) {
          store.appendTranscript("session", messages[i]);
          if (i % 4 === 0) store.appendTranscript("session", messages[i]);
        }
      },
      verify: () => {
        const saved = store.transcript("session");
        assert.equal(saved.length, count);
        assert.deepEqual(
          saved.map((item) => item.id),
          messages.map((item) => item.id),
        );
        assert.ok(!JSON.stringify(saved).includes(benchmarkSecret));
      },
    };
  }
  const durable = scenario.startsWith("durable-events-");
  const observed = scenario.startsWith("ephemeral-observed-");
  const operations = smoke ? 20 : durable ? 2000 : 5000;
  const runCount = smoke ? 4 : 64;
  const input = "x".repeat(scenario.endsWith("-large") ? 64 * 1024 : 512);
  for (let i = 0; i < runCount; i++)
    store.put("runs", {
      id: `run-${i}`,
      sessionId: `session-${i}`,
      status: "running",
      input,
    });
  let received = 0;
  /** @type {import("../src/contracts.js").FoundationEvent | undefined} */
  let lastEvent;
  if (observed)
    for (let i = 0; i < runCount; i++)
      store.events.on(`run-${i}`, (event) => {
        received++;
        lastEvent = event;
      });
  const emit = durable ? store.emit.bind(store) : ephemeralEmitter(store);
  const data = {
    text: `${"x".repeat(256)} ${benchmarkSecret}`,
    stream: "stdout",
    toolCallId: "call",
  };
  return {
    operations,
    parameters: {
      runCount,
      runInputBytes: Buffer.byteLength(input),
      eventInputBytes: Buffer.byteLength(JSON.stringify(data)),
      durable,
      liveListener: observed,
      api: durable
        ? "Store.emit"
        : typeof store.emitEphemeral === "function"
          ? "Store.emitEphemeral"
          : "Store.emit(false)",
    },
    run: () => {
      for (let i = 0; i < operations; i++)
        emit(`run-${i % runCount}`, "tool.output", data);
    },
    verify: () => {
      assert.equal(received, observed ? operations : 0);
      if (observed) {
        assert.equal(
          lastEvent?.sessionId,
          `session-${(operations - 1) % runCount}`,
        );
        assert.equal(lastEvent?.seq, null);
        assert.ok(!JSON.stringify(lastEvent).includes(benchmarkSecret));
      }
      let persisted = 0;
      for (let i = 0; i < runCount; i++) {
        const events = store.replay(`run-${i}`);
        persisted += events.length;
        for (const event of events) {
          assert.equal(event.sessionId, `session-${i}`);
          assert.ok(!JSON.stringify(event).includes(benchmarkSecret));
        }
      }
      assert.equal(persisted, durable ? operations : 0);
    },
  };
}

/** A fresh file-backed database is prepared outside every timed region.
 * @param {string} directory @param {string} scenario @param {boolean} smoke
 */
async function sample(directory, scenario, smoke) {
  /** @type {typeof import("../src/storage/store.js")} */
  const { Store } = await import(
    pathToFileURL(path.join(directory, "storage/store.js")).href
  );
  const scratch = await mkdtemp(path.join(tmpdir(), "foundation-hotpaths-"));
  let store;
  /** @type {Scenario | undefined} */
  let workload;
  try {
    store = new Store(scratch);
    workload = await setup(directory, scenario, smoke, store, scratch);
    global.gc?.();
    const rssBeforeBytes = process.memoryUsage().rss;
    const cpu = process.cpuUsage(),
      started = performance.now();
    await workload.run();
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const measured = {
      elapsedMs,
      cpuUserMicros: used.user,
      cpuSystemMicros: used.system,
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage().rss,
    };
    workload.verify();
    return {
      operations: workload.operations,
      parameters: workload.parameters,
      measured,
    };
  } finally {
    try {
      await workload?.close?.();
    } finally {
      store?.close();
      // mkdtemp owns this exact child of the OS temp directory; never delete an input directory.
      assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
      assert.ok(path.basename(scratch).startsWith("foundation-hotpaths-"));
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate subprocess output before it enters the aggregate report.
 * @param {unknown} value @returns {asserts value is WorkerResult}
 */
export function assertWorkerResult(value) {
  assert.ok(isRecord(value) && scenarios.includes(String(value.scenario)));
  assert.ok(
    typeof value.operations === "number" &&
      Number.isSafeInteger(value.operations) &&
      value.operations > 0,
  );
  assert.ok(typeof value.node === "string" && Number.isSafeInteger(value.pid));
  assert.ok(
    isRecord(value.parameters) &&
      Object.values(value.parameters).every((item) =>
        ["string", "number", "boolean"].includes(typeof item),
      ),
  );
  assert.ok(Array.isArray(value.warmups) && value.warmups.length >= 1);
  for (const timing of [...value.warmups, value.measured]) {
    assert.ok(isRecord(timing));
    for (const field of [
      "elapsedMs",
      "cpuUserMicros",
      "cpuSystemMicros",
      "rssBeforeBytes",
      "rssAfterBytes",
    ])
      assert.ok(
        typeof timing[field] === "number" &&
          Number.isFinite(timing[field]) &&
          timing[field] >= 0,
      );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  /** @type {unknown} */
  const input = JSON.parse(process.argv[2] || "null");
  assert.ok(
    isRecord(input) &&
      typeof input.directory === "string" &&
      typeof input.scenario === "string",
  );
  assert.ok(
    scenarios.includes(input.scenario) && typeof input.smoke === "boolean",
  );
  assert.ok(
    typeof input.warmups === "number" &&
      Number.isSafeInteger(input.warmups) &&
      input.warmups >= 1,
  );
  const warmups = [];
  for (let i = 0; i < input.warmups; i++)
    warmups.push(
      (await sample(input.directory, input.scenario, input.smoke)).measured,
    );
  const result = await sample(input.directory, input.scenario, input.smoke);
  console.log(
    JSON.stringify({
      scenario: input.scenario,
      ...result,
      warmups,
      node: process.version,
      pid: process.pid,
    }),
  );
}
