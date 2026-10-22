import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const baseline = option("baseline");
assert(
  baseline,
  "Usage: node scripts/benchmark-runtime.mjs --baseline=<baseline dist> [--output=<json>]",
);
const rounds = 5;
const load = (directory, name) =>
  import(pathToFileURL(path.join(directory, name)).href);

async function measure(operation) {
  await operation();
  const samplesMs = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    await operation();
    samplesMs.push(performance.now() - start);
  }
  return {
    samplesMs,
    medianMs: [...samplesMs].sort((a, b) => a - b)[Math.floor(rounds / 2)],
  };
}

async function benchmark(directory) {
  const [
    { compileSchema },
    { sse },
    { ContextManager, estimateTokens },
    { Store },
    { MemoryStore },
    { parseConfig },
  ] = await Promise.all([
    load(directory, "runtime/json-schema.js"),
    load(directory, "providers/sse.js"),
    load(directory, "core/context.js"),
    load(directory, "storage/store.js"),
    load(directory, "storage/memory.js"),
    load(directory, "core/config.js"),
  ]);
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  };
  const schemas = await measure(() => {
    for (let i = 0; i < 200; i++) {
      const validate = compileSchema(structuredClone(schema));
      assert.equal(validate({ path: "src", limit: 10 }), true);
      assert.equal(validate({ path: 3 }), false);
    }
  });
  const payload = "x".repeat(256 * 1024),
    bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
  const streams = await measure(async () => {
    let offset = 0,
      count = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 64));
        offset = Math.min(offset + 64, bytes.length);
      },
    });
    for await (const event of sse(new Response(body))) {
      assert.equal(event.data, payload);
      count++;
    }
    assert.equal(count, 1);
  });
  const scratch = await mkdtemp(
    path.join(tmpdir(), "foundation-runtime-benchmark-"),
  );
  const store = new Store(scratch);
  try {
    const config = parseConfig({
      dataDir: scratch,
      workspaceRoots: [scratch],
      defaultRoutes: { chat: "text", code: "text", office: "text" },
      routes: {
        text: {
          kind: "text",
          adapter: "openai-completions",
          model: "unused",
          baseUrl: "http://127.0.0.1:1",
          contextWindow: 1000000,
          maxOutputTokens: 2000,
        },
      },
    });
    store.put("projects", {
      id: "project",
      name: "benchmark",
      root: scratch,
      createdAt: new Date(0).toISOString(),
    });
    const reads = await measure(() => {
      for (let i = 0; i < 30000; i++)
        assert.equal(store.project("project").id, "project");
    });
    // Baseline builds keep every kind in one entities table; current builds split per kind.
    const insert = store.db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='entities'",
      )
      .get()
      ? store.db.prepare(
          "INSERT INTO entities(kind,id,body) VALUES('memory-revisions',?,?)",
        )
      : store.db.prepare("INSERT INTO e_memory_revisions(id,body) VALUES(?,?)");
    store.transaction(() => {
      for (let i = 0; i < 12000; i++)
        insert.run(
          `revision-${i}`,
          JSON.stringify({
            id: `revision-${i}`,
            memoryId: `history-${i % 1000}`,
            projectId: "project",
            revision: Math.floor(i / 1000) + 1,
            action: "updated",
            entry: { content: "historical context ".repeat(20) },
            recordedAt: new Date(0).toISOString(),
          }),
        );
    });
    let sequence = 0;
    const memory = new MemoryStore(store, config);
    const memoryWrites = await measure(() => {
      for (let i = 0; i < 30; i++)
        memory.put({
          id: `new-${sequence++}`,
          projectId: "project",
          content: "new fact",
        });
    });
    const messages = [
      { role: "system", content: "system instructions", timestamp: 0 },
    ];
    for (let i = 0; i < 3000; i++)
      messages.push({
        role: "user",
        content: `${i}:` + "x".repeat(1000),
        timestamp: i + 1,
      });
    const budget = Math.min(
      Math.floor(
        config.routes.text.contextWindow * config.limits.compactAtRatio,
      ),
      config.routes.text.contextWindow -
        config.routes.text.maxOutputTokens -
        1800,
    );
    let boundary = messages.length - 1;
    while (
      boundary > 1 &&
      estimateTokens([messages[0], ...messages.slice(boundary - 1)]) <=
        budget * 0.5
    )
      boundary--;
    const digest = createHash("sha256")
      .update(JSON.stringify(messages.slice(1, boundary)))
      .digest("hex");
    store.put("summaries", {
      id: `text:${digest}:hierarchical-v2`,
      summary: "cached continuation",
      model: "text",
    });
    const manager = new ContextManager(store, config);
    store.put("sessions", { id: "benchmark-session", projectId: "project" });
    store.put("runs", {
      id: "benchmark-run",
      sessionId: "benchmark-session",
      status: "running",
    });
    const context = await measure(async () => {
      const prepared = await manager.prepare("benchmark-run", "text", messages);
      assert.equal(prepared.length, messages.length - boundary + 2);
      assert.match(prepared[1].content, /cached continuation/);
    });
    return { schemas, streams, reads, memoryWrites, context };
  } finally {
    store.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

const before = await benchmark(path.resolve(baseline));
const after = await benchmark(
  path.resolve(option("current") || path.join(root, "dist")),
);
const report = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  rounds,
  method:
    "Same process and inputs; one warmup then five samples per implementation. No external model/network calls. File-backed SQLite.",
  workloads: {
    schemas: "200 identical tool schemas and two validations each",
    streams: "256 KiB SSE frame in 64-byte chunks",
    reads: "30000 project reads",
    memoryWrites: "30 new memory IDs with 12000 historical revisions",
    context:
      "3000 messages with 1000 ASCII characters each; cached summary, 1M token window",
  },
  before,
  after,
  speedup: Object.fromEntries(
    Object.keys(before).map((name) => [
      name,
      before[name].medianMs / after[name].medianMs,
    ]),
  ),
  limitation:
    "Microbenchmarks measure only these workloads; do not imply the same speedup for complete agent runs or remote model latency.",
};
const output = option("output");
if (output)
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
