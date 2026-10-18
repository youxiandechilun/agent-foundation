// @ts-check
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** @param {string} name */
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const baselineOption = option("baseline");
assert(
  baselineOption,
  "--baseline must identify the pre-refactor dist directory",
);
const baseline = path.resolve(baselineOption);
/** @typedef {{ Store: typeof import('../src/storage/store.js').Store, redactJson: typeof import('../src/core/util.js').redactJson, Permissions: typeof import('../src/core/permissions.js').Permissions, CostLedger: typeof import('../src/runtime/cost.js').CostLedger, parseConfig: typeof import('../src/core/config.js').parseConfig, MCPClient: typeof import('../src/extensions/mcp/client.js').MCPClient }} Runtime */
/** @param {string} directory @returns {Promise<Runtime>} */
async function load(directory) {
  const modules = await Promise.all(
    [
      "storage/store.js",
      "core/util.js",
      "core/permissions.js",
      "runtime/cost.js",
      "core/config.js",
      "extensions/mcp/client.js",
    ].map((file) => import(pathToFileURL(path.join(directory, file)).href)),
  );
  return Object.assign({}, ...modules);
}

/** @param {Runtime} runtime @param {boolean} optimized */
async function fixture(runtime, optimized) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "foundation-refactor-bench-"),
  );
  const store = new runtime.Store(directory);
  const config = runtime.parseConfig({
    dataDir: directory,
    workspaceRoots: [directory],
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "benchmark",
        baseUrl: "http://127.0.0.1:1",
        pricing: {
          currency: "USD",
          inputPerMillion: 0,
          outputPerMillion: 0,
          requestUsd: 0,
        },
      },
    },
    budgets: { enabled: true, maxProjectUsd: 10 },
  });
  store.put("projects", {
    id: "p0",
    name: "benchmark",
    root: directory,
    createdAt: new Date(0).toISOString(),
  });
  const insert = store.db.prepare(
    "INSERT INTO entities(kind,id,body) VALUES(?,?,?)",
  );
  const message = store.db.prepare(
    "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
  );
  store.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      insert.run(
        "effects",
        `e${i}`,
        JSON.stringify({
          id: `e${i}`,
          runId: `r${i % 200}`,
          result: "x".repeat(1000),
        }),
      );
      insert.run(
        "cost-ledger",
        `c${i}`,
        JSON.stringify({
          id: `c${i}`,
          projectId: `p${i % 200}`,
          status: "settled",
          chargedMicros: 1,
          reservedMicros: 1,
          createdAt: "2026-10-18T00:00:00Z",
        }),
      );
      message.run(
        "s",
        `m${i}`,
        JSON.stringify({
          id: `m${i}`,
          runId: `r${i % 200}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(1000) }],
            timestamp: i,
          },
        }),
      );
    }
    for (let i = 0; i < 100; i++)
      insert.run(
        "policies",
        `policy${i}`,
        JSON.stringify({
          id: `policy${i}`,
          capabilities: ["files.read"],
          effect: "allow",
        }),
      );
  });
  const ledger = new runtime.CostLedger(store, config),
    permissions = new runtime.Permissions(store, config);
  /** @type {import('../src/contracts.js').Session} */
  const session = {
    id: "s",
    name: "benchmark",
    projectId: "p0",
    mode: "code",
    routeId: "text",
    createdAt: new Date(0).toISOString(),
  };
  /** @type {import('../src/runtime/types.js').ToolDefinition} */
  const tool = {
    name: "inspect",
    description: "",
    parameters: {},
    risk: "read",
    capabilities: [
      "files.read",
      "files.write",
      "memory.read",
      "memory.write",
      "network",
      "exec",
    ],
    execute: async () => ({ content: [] }),
  };
  const content = Array.from({ length: 300 }, (_, i) => ({
    id: i,
    role: "toolResult",
    parts: [{ type: "text", text: "safe output " + "x".repeat(300) }],
  }));
  const operations = {
    redaction() {
      for (let i = 0; i < 20; i++)
        assert.equal(runtime.redactJson(content).length, 300);
    },
    scopedReads() {
      for (let i = 0; i < 50; i++) {
        const rows = optimized
          ? store.list("effects", { runId: "r0" })
          : store
              .list(/** @type {const} */ ("effects"))
              .filter(
                (row) => /** @type {{runId: string}} */ (row).runId === "r0",
              );
        assert.equal(rows.length, 50);
      }
    },
    transcriptWindows() {
      for (let i = 0; i < 50; i++) {
        const rows = optimized
          ? store.transcriptSlice("s", 8000, 10).messages
          : store.transcript("s").slice(8000, 8010);
        assert.equal(rows[0].id, "m8000");
      }
    },
    lastAssistant() {
      for (let i = 0; i < 50; i++) {
        const row = optimized
          ? store.lastAssistant("s", "r1")
          : store
              .transcript("s")
              .filter(
                (row) => row.runId === "r1" && row.message.role === "assistant",
              )
              .at(-1);
        assert.equal(row?.id, "m9801");
      }
    },
    permissions() {
      for (let i = 0; i < 300; i++)
        assert.ok(permissions.evaluate(session, "text", tool).reasons.length);
    },
    reservations() {
      for (let i = 0; i < 30; i++) {
        const entry = ledger.reserve(
          "text",
          config.routes.text,
          { projectId: "p0", purpose: "benchmark" },
          1,
        );
        store.remove("cost-ledger", entry.id);
      }
    },
    async mcpFrames() {
      const fetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "server/discover")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
            },
          });
        const bytes = new TextEncoder().encode(
          "data: " +
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [
                  {
                    name: "example",
                    description: "x".repeat(256 * 1024),
                    inputSchema: { type: "object" },
                  },
                ],
              },
            }) +
            "\n\n",
        );
        let offset = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (offset === bytes.length) return controller.close();
              controller.enqueue(bytes.subarray(offset, offset + 64));
              offset = Math.min(offset + 64, bytes.length);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const client = new runtime.MCPClient({
        transport: "http",
        url: "http://benchmark.invalid",
        protocol: "modern",
      });
      try {
        await client.connect();
        assert.equal((await client.listTools()).tools[0].name, "example");
      } finally {
        await client.close();
        globalThis.fetch = fetch;
      }
    },
  };
  return {
    operations,
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function benchmarkHotPaths() {
  const before = await fixture(await load(path.resolve(baseline)), false);
  const after = await fixture(await load(path.join(root, "dist")), true);
  /** @type {Record<string, {beforeMs: number[], afterMs: number[], beforeMedianMs: number, afterMedianMs: number, speedup: number}>} */
  const measurements = {};
  /** @param {number[]} values */
  const median = (values) => [...values].sort((a, b) => a - b)[2];
  try {
    for (const name of /** @type {(keyof typeof before.operations)[]} */ (
      Object.keys(before.operations)
    )) {
      await before.operations[name]();
      await after.operations[name]();
      /** @type {number[]} */
      const beforeMs = [];
      /** @type {number[]} */
      const afterMs = [];
      for (let round = 0; round < 5; round++) {
        const pairs = [
          [before.operations[name], beforeMs],
          [after.operations[name], afterMs],
        ];
        if (round % 2) pairs.reverse();
        for (const [
          operation,
          samples,
        ] of /** @type {[() => void | Promise<void>, number[]][]} */ (pairs)) {
          const start = performance.now();
          await operation();
          samples.push(performance.now() - start);
        }
      }
      const beforeMedianMs = median(beforeMs),
        afterMedianMs = median(afterMs);
      measurements[name] = {
        beforeMs,
        afterMs,
        beforeMedianMs,
        afterMedianMs,
        speedup: beforeMedianMs / afterMedianMs,
      };
      console.log(
        `${name}: ${beforeMedianMs.toFixed(2)} -> ${afterMedianMs.toFixed(2)} ms`,
      );
    }
  } finally {
    await before.close();
    await after.close();
  }
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    baseline: path.resolve(baseline),
    method:
      "Same process and inputs; one warmup then five alternating rounds, median. SQLite uses actual files; MCP uses actual client/stream code with an in-memory HTTP response, no network or model calls.",
    workloads: {
      redaction: "20 x 300 structured messages",
      scopedReads: "50 reads from 10000 1KB effects, 50 matching rows",
      transcriptWindows: "50 offset windows of 10 from 10000 1KB messages",
      lastAssistant: "50 lookups from 10000 1KB messages",
      permissions: "300 checks, 6 capabilities and 100 policies",
      reservations: "30 atomic project reservations over 10000 charges",
      mcpFrames: "256 KiB MCP catalog event delivered in 64-byte stream chunks",
    },
    measurements,
  };
  await writeFile(
    path.resolve(
      option("output") ||
        path.join(root, "verification/refactor-benchmark.json"),
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
}

async function benchmarkStorage() {
  const runtimes = {
    before: await load(path.resolve(baseline)),
    after: await load(path.join(root, "dist")),
  };
  /** @type {Record<'before' | 'after', {insertMs: number[], reopenMs: number[], databaseBytes: number[]}>} */
  const samples = {
    before: { insertMs: [], reopenMs: [], databaseBytes: [] },
    after: { insertMs: [], reopenMs: [], databaseBytes: [] },
  };
  /** @type {number[]} */
  const upgradeMs = [];
  for (let round = 0; round < 5; round++) {
    const directory = await mkdtemp(
      path.join(tmpdir(), "foundation-storage-bench-"),
    );
    try {
      /** @type {('before' | 'after')[]} */
      const order = round % 2 ? ["after", "before"] : ["before", "after"];
      for (const name of order) {
        const location = path.join(directory, name);
        const store = new runtimes[name].Store(location);
        try {
          const entity = store.db.prepare(
            "INSERT INTO entities(kind,id,body) VALUES('effects',?,?)",
          );
          const message = store.db.prepare(
            "INSERT INTO messages(session_id,message_id,body) VALUES('s',?,?)",
          );
          const started = performance.now();
          store.transaction(() => {
            for (let i = 0; i < 10000; i++) {
              entity.run(
                `e${i}`,
                JSON.stringify({
                  id: `e${i}`,
                  runId: `r${i % 200}`,
                  projectId: `p${i % 20}`,
                  sessionId: "s",
                  status: "settled",
                  result: "x".repeat(1000),
                }),
              );
              message.run(
                `m${i}`,
                JSON.stringify({
                  id: `m${i}`,
                  runId: `r${i % 200}`,
                  message: { role: "assistant", content: "x".repeat(1000) },
                }),
              );
            }
          });
          samples[name].insertMs.push(performance.now() - started);
        } finally {
          store.close();
        }
        samples[name].databaseBytes.push(
          (await stat(path.join(location, "foundation.sqlite"))).size,
        );
        const started = performance.now();
        const reopened = new runtimes[name].Store(location);
        samples[name].reopenMs.push(performance.now() - started);
        reopened.close();
      }
      const upgradedDirectory = path.join(directory, "upgraded");
      await mkdir(upgradedDirectory);
      await copyFile(
        path.join(directory, "before", "foundation.sqlite"),
        path.join(upgradedDirectory, "foundation.sqlite"),
      );
      const started = performance.now();
      const upgraded = new runtimes.after.Store(upgradedDirectory);
      upgradeMs.push(performance.now() - started);
      try {
        assert.equal(upgraded.count("effects", { runId: "r0" }), 50);
        assert.equal(upgraded.transcriptSlice("s", 9999, 1).total, 10000);
      } finally {
        upgraded.close();
      }
    } finally {
      // Only this iteration's newly allocated temporary directory is removed.
      assert(
        path.dirname(directory) === path.resolve(tmpdir()) &&
          path.basename(directory).startsWith("foundation-storage-bench-"),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }
  /** @param {number[]} values */
  const median = (values) => [...values].sort((a, b) => a - b)[2];
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    method:
      "Five fresh SQLite files per version, alternating order. Insert 10000 1KB effects and 10000 1KB assistant messages in one transaction; use prepared SQL to isolate index overhead from redaction. Timings include commit but exclude close. Reopen after clean close; upgrade a copy of each populated baseline file. OS filesystem cache is not cleared.",
    samples,
    upgradeMs,
    medians: {
      before: {
        insertMs: median(samples.before.insertMs),
        reopenMs: median(samples.before.reopenMs),
        databaseBytes: median(samples.before.databaseBytes),
      },
      after: {
        insertMs: median(samples.after.insertMs),
        reopenMs: median(samples.after.reopenMs),
        databaseBytes: median(samples.after.databaseBytes),
      },
      upgradeMs: median(upgradeMs),
    },
  };
  await writeFile(
    path.resolve(
      option("output") ||
        path.join(root, "verification/refactor-storage-cost.json"),
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report.medians, null, 2));
}

if (process.argv.includes("--storage-only")) await benchmarkStorage();
else await benchmarkHotPaths();
