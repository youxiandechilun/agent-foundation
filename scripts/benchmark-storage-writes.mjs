import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  renameSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  started = Date.now();
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const dir = path.resolve(
  option("--output") || path.join(root, "verification/storage-write-benchmark"),
);
mkdirSync(dir, { recursive: true });
const data = mkdtempSync(path.join(dir, "quick-data-")),
  statusFile = option("--progress");
const ref = option("--ref") || "HEAD";
const reference = execFileSync(
  "git",
  ["rev-parse", "--verify", ref + "^{commit}"],
  { cwd: root, encoding: "utf8" },
).trim();
const sourceSnapshots = {};
function compileStorage(readSource, output, label) {
  const seen = new Set(),
    files = [];
  mkdirSync(output, { recursive: true });
  function compile(file) {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(file.startsWith("src/") && !file.includes("/../"));
    const source = readSource(file);
    const js = file.endsWith(".ts")
      ? ts.transpileModule(source, {
          fileName: file,
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
            esModuleInterop: true,
          },
        }).outputText
      : source;
    const target = path.join(output, file.slice(4).replace(/\.ts$/, ".js"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, js);
    files.push({
      file,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    for (const entry of ts.preProcessFile(js).importedFiles) {
      if (!entry.fileName.startsWith(".")) continue;
      let next = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), entry.fileName),
      );
      if (next.endsWith(".js")) next = next.slice(0, -3) + ".ts";
      compile(next);
    }
  }
  compile("src/storage/store.ts");
  writeFileSync(path.join(output, "package.json"), '{"type":"module"}');
  sourceSnapshots[label] = files;
  return output;
}
const original =
  option("--reference-dist") ||
  compileStorage(
    (file) =>
      execFileSync("git", ["show", reference + ":" + file], {
        cwd: root,
        encoding: "utf8",
      }),
    path.join(data, "reference-dist"),
    "original",
  );
const current = compileStorage(
  (file) => readFileSync(path.join(root, file), "utf8"),
  path.join(data, "current-dist"),
  "current",
);
const versions = {
  original,
  ...(option("--previous-dist")
    ? { previous: path.resolve(option("--previous-dist")) }
    : {}),
  current,
};
const n = Number(option("--size") || 10000),
  rounds = Number(option("--rounds") || 7),
  text = "x".repeat(1024),
  samples = [],
  fixtures = [];
assert.ok(n >= 200 && n % 200 === 0);
assert.ok(rounds >= 3 && rounds <= 21 && rounds % 2 === 1);
const rows = {
  sessions: Array.from({ length: n }, (_, i) => ({
    id: "s" + i,
    projectId: "p" + (i % 20),
    status: "idle",
    name: "session " + i,
    createdAt: "2026-10-22T00:00:00Z",
  })),
  effects: Array.from({ length: n }, (_, i) => ({
    id: "e" + i,
    runId: "r" + (i % 200),
    projectId: "p" + (i % 20),
    sessionId: "s" + (i % 200),
    status: i % 100 === 0 ? "prepared" : i % 100 === 1 ? "running" : "settled",
    result: text,
  })),
  "cost-ledger": Array.from({ length: n }, (_, i) => ({
    id: "c" + i,
    projectId: "p" + (i % 20),
    sessionId: "s" + (i % 200),
    runId: "r" + (i % 200),
    status: "settled",
    chargedMicros: 1,
    reservedMicros: 1,
    createdAt: "2026-10-22T00:00:00Z",
  })),
};
const history = Array.from({ length: 1000 }, (_, i) => ({
  id: "m" + i,
  runId: "r0",
  message: { role: "user", content: text, timestamp: i },
}));
const workRows = Object.fromEntries(
  Object.entries(rows).map(([k, v]) => [
    k,
    v.map((r) => ({ ...r, id: "new-" + r.id })),
  ]),
);
const metricNames = {
  raw_effects: "SQL 逐行批量插入 effects",
  sessions_batch: "API 批量写 sessions",
  costs_batch: "API 批量写费用",
  sessions_commit: "API 逐条提交 sessions",
  project_count: "effects 项目筛选计数",
  run_list: "effects 按 runId 列表",
  recovery_count: "effects 未完成状态筛选",
  cost_sum: "项目费用聚合",
  cost_list: "项目费用列表",
  history_window: "历史窗口读取",
};
function update(detail, completed) {
  if (!statusFile) return;
  const s = JSON.parse(readFileSync(statusFile, "utf8"));
  s.state = "running";
  s.phases.forEach(
    (p, i) => (p.state = i < 4 ? "passed" : i === 4 ? "running" : "pending"),
  );
  s.sampling = { completed, total: rounds * Object.keys(versions).length };
  s.detail = detail;
  s.updatedAt = new Date().toISOString();
  s.results = [];
  writeFileSync(statusFile + ".tmp", JSON.stringify(s, null, 2));
  renameSync(statusFile + ".tmp", statusFile);
}
function checkpoint(store) {
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
try {
  for (const [version, dist] of Object.entries(versions)) {
    const { Store } = await import(
      pathToFileURL(path.join(dist, "storage/store.js"))
    );
    const folder = path.join(data, version);
    mkdirSync(folder);
    const store = new Store(folder);
    store.transaction(() => {
      for (const [kind, items] of Object.entries(rows)) {
        const stmt = store.db.prepare(
          `INSERT INTO e_${kind.replaceAll("-", "_")}(id,body) VALUES(?,?)`,
        );
        for (const row of items) stmt.run(row.id, JSON.stringify(row));
      }
      const stmt = store.db.prepare(
        "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
      );
      for (const row of history)
        stmt.run("history", row.id, JSON.stringify(row));
    });
    checkpoint(store);
    assert.equal(store.count("effects"), n);
    assert.equal(store.transcriptSlice("history", 0, 1).total, 1000);
    const raw = store.db.prepare("INSERT INTO e_effects(id,body) VALUES(?,?)"),
      bodies = workRows.effects.map((r) => JSON.stringify(r));
    const cleanup = (kind) => () =>
      store.db
        .prepare(
          `DELETE FROM e_${kind.replaceAll("-", "_")} WHERE id LIKE 'new-%'`,
        )
        .run();
    const cases = {
      raw_effects: {
        ops: n,
        run: () =>
          store.transaction(() => {
            for (let i = 0; i < n; i++)
              raw.run(workRows.effects[i].id, bodies[i]);
          }),
        clean: cleanup("effects"),
        valid: () => assert.equal(store.count("effects"), 2 * n),
      },
      sessions_batch: {
        ops: n,
        run: () =>
          store.transaction(() => {
            for (const row of workRows.sessions) store.write("sessions", row);
          }),
        clean: cleanup("sessions"),
        valid: () => assert.equal(store.count("sessions"), 2 * n),
      },
      costs_batch: {
        ops: n,
        run: () =>
          store.transaction(() => {
            for (const row of workRows["cost-ledger"])
              store.write("cost-ledger", row);
          }),
        clean: cleanup("cost-ledger"),
        valid: () => assert.equal(store.count("cost-ledger"), 2 * n),
      },
      sessions_commit: {
        ops: 200,
        run: () => {
          for (let i = 0; i < 200; i++)
            store.write("sessions", workRows.sessions[i]);
        },
        clean: cleanup("sessions"),
        valid: () => assert.equal(store.count("sessions"), n + 200),
      },
      project_count: {
        ops: version === "original" ? 20 : 1000,
        run: () => {
          for (let i = 0; i < (version === "original" ? 20 : 1000); i++)
            assert.equal(
              store.count("effects", { projectId: "p" + (i % 20) }),
              n / 20,
            );
        },
      },
      run_list: {
        ops: 100,
        run: () => {
          for (let i = 0; i < 100; i++)
            assert.equal(
              store.list("effects", { runId: "r" + (i % 200) }, { limit: 50 })
                .length,
              Math.min(50, n / 200),
            );
        },
      },
      recovery_count: {
        ops: 1000,
        run: () => {
          for (let i = 0; i < 1000; i++)
            assert.equal(
              store.count("effects", { status: ["running", "prepared"] }),
              n / 50,
            );
        },
      },
      cost_sum: {
        ops: 500,
        run: () => {
          for (let i = 0; i < 500; i++)
            assert.equal(
              store.committedCost({ projectId: "p" + (i % 20) }),
              n / 20,
            );
        },
      },
      cost_list: {
        ops: 300,
        run: () => {
          for (let i = 0; i < 300; i++) {
            const found = store.list(
              "cost-ledger",
              { projectId: "p" + (i % 20) },
              { limit: 20 },
            );
            assert.equal(found[0].id, "c" + (i % 20));
            assert.equal(found.length, 20);
          }
        },
      },
      history_window: {
        ops: 100,
        run: () => {
          for (let i = 0; i < 100; i++) {
            const found = store.transcriptSlice("history", 500, 50);
            assert.equal(found.total, 1000);
            assert.equal(found.messages[0].id, "m500");
          }
        },
      },
    };
    fixtures.push({
      version,
      store,
      cases,
      pageSize: store.db.prepare("PRAGMA page_size").get().page_size,
      synchronous: store.db.prepare("PRAGMA synchronous").get().synchronous,
      bytes: statSync(path.join(folder, "foundation.sqlite")).size,
      storeHash: createHash("sha256")
        .update(readFileSync(path.join(dist, "storage/store.js")))
        .digest("hex"),
    });
    for (const item of Object.values(cases)) {
      item.run();
      item.valid?.();
      item.clean?.();
    }
    checkpoint(store);
  }
  for (let round = 0; round < rounds; round++) {
    const order = fixtures
      .slice(round % fixtures.length)
      .concat(fixtures.slice(0, round % fixtures.length));
    if (fixtures.length > 2 && round % 2) order.reverse();
    for (const f of order) {
      const metrics = {};
      let cases = Object.entries(f.cases);
      cases = cases
        .slice(round % cases.length)
        .concat(cases.slice(0, round % cases.length));
      for (const [id, item] of cases) {
        if (id === "sessions_commit") continue;
        checkpoint(f.store);
        global.gc?.();
        if (item.clean)
          await new Promise((resolve) =>
            setTimeout(resolve, id === "sessions_commit" ? 100 : 20),
          );
        const start = performance.now();
        item.run();
        const ms = performance.now() - start;
        item.valid?.();
        item.clean?.();
        metrics[id] = { ms, operations: item.ops, msPerOp: ms / item.ops };
      }
      samples.push({ version: f.version, round, metrics });
      writeFileSync(
        path.join(dir, "quick-samples.json"),
        JSON.stringify(samples, null, 2),
      );
      update(
        `短流程复测 ${samples.length}/${rounds * fixtures.length}：第 ${round + 1}/${rounds} 轮 ${f.version}，只运行 10 个受影响场景。`,
        samples.length,
      );
      console.log(
        "Sample " +
          samples.length +
          "/" +
          rounds * fixtures.length +
          " " +
          f.version,
      );
    }
    // Alternate independent FULL commits record by record, reducing disk drift
    // between versions without merging or weakening any transaction.
    for (const f of fixtures) checkpoint(f.store);
    global.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const commits = new Map(fixtures.map((f) => [f.version, 0]));
    for (let i = 0; i < 200; i++) {
      const at = (i + round) % fixtures.length;
      const commitOrder = fixtures.slice(at).concat(fixtures.slice(0, at));
      if (i % 2) commitOrder.reverse();
      for (const f of commitOrder) {
        const before = performance.now();
        f.store.write("sessions", workRows.sessions[i]);
        commits.set(
          f.version,
          commits.get(f.version) + performance.now() - before,
        );
      }
    }
    for (const f of fixtures) {
      f.cases.sessions_commit.valid();
      f.cases.sessions_commit.clean();
      const ms = commits.get(f.version);
      samples.find(
        (s) => s.version === f.version && s.round === round,
      ).metrics.sessions_commit = { ms, operations: 200, msPerOp: ms / 200 };
    }
    writeFileSync(
      path.join(dir, "quick-samples.json"),
      JSON.stringify(samples, null, 2),
    );
  }
  const median = (a) => {
    const v = a.slice().sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  let seed = 20261022;
  const rng = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const interval = (before, after) => {
    const ratios = [];
    for (let k = 0; k < 3000; k++) {
      const b = [],
        a = [];
      for (let i = 0; i < rounds; i++) {
        const j = Math.floor(rng() * rounds);
        b.push(before[j]);
        a.push(after[j]);
      }
      ratios.push(median(b) / median(a));
    }
    ratios.sort((a, b) => a - b);
    return [
      ratios[Math.floor(0.025 * ratios.length)],
      ratios[Math.floor(0.975 * ratios.length)],
    ];
  };
  const results = Object.entries(metricNames).map(([id, label]) => {
    const values = Object.fromEntries(
      Object.keys(versions).map((version) => [
        version,
        samples
          .filter((s) => s.version === version)
          .sort((a, b) => a.round - b.round)
          .map((s) => s.metrics[id].msPerOp),
      ]),
    );
    const originalMs = median(values.original),
      beforeMs = median(values.previous || values.original),
      afterMs = median(values.current);
    return {
      id,
      label,
      originalMs,
      beforeMs,
      afterMs,
      speedup: beforeMs / afterMs,
      originalSpeedup: originalMs / afterMs,
      speedupBootstrap95: interval(
        values.previous || values.original,
        values.current,
      ),
      originalBootstrap95: interval(values.original, values.current),
      values,
    };
  });
  for (const f of fixtures) {
    assert.equal(
      f.store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    checkpoint(f.store);
    f.store.close();
  }
  const result = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    rounds,
    size: n,
    reference,
    sourceSnapshots,
    method:
      "Focused warm-file in-process comparison; alternating blocks; fixtures seeded once/version and reused; checkpoint, forced GC, write settling and cleanup outside timing; unchanged FULL synchronous durability. Independent commits alternate versions per record. Batch means include fixed identical correctness assertions. Project count uses 20 calls on the scanning original and 1000 on indexed versions to avoid tiny timed batches; compared per-operation means. Bootstrap interval is descriptive across paired blocks, not independent process inference. No full history replacement, external model, network or unrelated core tests.",
    versions: Object.fromEntries(
      fixtures.map(({ version, pageSize, synchronous, bytes, storeHash }) => [
        version,
        { pageSize, synchronous, bytes, storeHash },
      ]),
    ),
    results,
    samples,
  };
  writeFileSync(
    path.join(dir, "quick-benchmark.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        durationSeconds: result.durationMs / 1000,
        results: results.map(
          ({
            id,
            originalMs,
            beforeMs,
            afterMs,
            speedup,
            originalSpeedup,
            speedupBootstrap95,
          }) => ({
            id,
            originalMs,
            beforeMs,
            afterMs,
            speedup,
            originalSpeedup,
            speedupBootstrap95,
          }),
        ),
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const f of fixtures)
    try {
      f.store.close();
    } catch {}
  throw error;
}
