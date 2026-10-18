// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string} name @param {string} [fallback] */
const option = (name, fallback = "") =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
assert.ok(
  option("baseline"),
  "Pass --baseline=<pre-refactor compiled directory>",
);
const output = path.resolve(
  option("output", "verification/refactor-20261018/queries.json"),
);
const directories = [option("baseline"), option("current", "dist")].map(
  (value) => path.resolve(value),
);
const scratch = await mkdtemp(
  path.join(os.tmpdir(), "foundation-query-benchmark-"),
);
const projectId = "benchmark-project",
  count = 12000,
  rounds = 5;
const serverId = "server_00000000-0000-0000-0000-000000000001";
const grants = new Set(["session-1", "session-6000", "session-11999"]);
/** @typedef {import('../src/storage/store.js').Store} Store */
/** @typedef {{id: string, projectId: string}} Row */
/** @typedef {{label: string, store: Store, manager: import('../src/servers/manager.js').ServerManager, hashes: Record<string,string>}} Version */
/** @type {Version[]} */
const versions = [];
/** @type {{scenario: string, label: string, round: number, operations: number, elapsedMs: number}[]} */
const samples = [];
try {
  for (const [index, directory] of directories.entries()) {
    const { Store } = await import(
      pathToFileURL(path.join(directory, "storage/store.js")).href
    );
    const { ServerManager } = await import(
      pathToFileURL(path.join(directory, "servers/manager.js")).href
    );
    const data = path.join(scratch, String(index));
    /** @type {Store} */
    const store = new Store(data);
    const manager = new ServerManager(store, data);
    const hashes = Object.fromEntries(
      await Promise.all(
        ["storage/store.js", "servers/manager.js"].map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(path.join(directory, file)))
            .digest("hex"),
        ]),
      ),
    );
    versions.push({
      label: index ? "current" : "baseline",
      store,
      manager,
      hashes,
    });
    const time = new Date(0).toISOString();
    store.write("projects", {
      id: projectId,
      name: "benchmark",
      root: data,
      createdAt: time,
    });
    manager.create({
      name: "unused profile",
      host: "localhost",
      username: "benchmark",
      projectIds: [projectId],
      hostFingerprint: "SHA256:" + "A".repeat(43),
    });
    const profile = manager.list()[0];
    store.remove("servers", profile.id);
    store.write("servers", { ...profile, id: serverId });
    store.transaction(() => {
      for (let i = 0; i < count; i++) {
        store.write("sessions", {
          id: `session-${i}`,
          projectId,
          name: "synthetic " + "x".repeat(300),
        });
        store.write("server-facts", {
          id: `fact-${i}`,
          serverId:
            i % 10 ? "server_00000000-0000-0000-0000-000000000002" : serverId,
          projectId,
          kind: "note",
          source: "user",
          text: "synthetic " + "x".repeat(300),
          createdAt: time,
        });
      }
    });
  }
  assert.equal(
    versions[0].hashes["storage/store.js"] ===
      versions[1].hashes["storage/store.js"],
    false,
    "Baseline and current Store must differ",
  );
  for (const scenario of ["authorized-sessions", "latest-server-facts"]) {
    const operations = scenario === "authorized-sessions" ? 20 : 10;
    /** @type {Row[] | undefined} */
    let expectedRecords;
    for (let round = -1; round < rounds; round++) {
      const order = round % 2 ? versions.toReversed() : versions;
      for (const version of order) {
        /** @type {() => Row[]} */
        const query =
          scenario === "authorized-sessions"
            ? version.label === "baseline"
              ? () =>
                  version.store
                    .list("sessions", { projectId })
                    .filter((/** @type {Row} */ item) => grants.has(item.id))
              : () =>
                  version.store
                    .listByIds("sessions", [...grants])
                    .filter(
                      (/** @type {Row} */ item) => item.projectId === projectId,
                    )
            : () => version.manager.read(serverId, projectId).facts;
        const expected =
          scenario === "authorized-sessions"
            ? [...grants]
            : Array.from({ length: 100 }, (_, i) => `fact-${11000 + i * 10}`);
        const records = query();
        assert.deepEqual(
          records.map((item) => item.id),
          expected,
        );
        expectedRecords ??= records;
        assert.deepEqual(records, expectedRecords);
        const started = performance.now();
        for (let i = 0; i < operations; i++) query();
        const elapsedMs = performance.now() - started;
        assert.deepEqual(query(), expectedRecords);
        if (round >= 0)
          samples.push({
            scenario,
            label: version.label,
            round: round + 1,
            operations,
            elapsedMs,
          });
      }
    }
  }
  /** @param {number[]} values */
  const median = (values) =>
    values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const results = ["authorized-sessions", "latest-server-facts"].map(
    (scenario) => {
      const perOperationMs = Object.fromEntries(
        versions.map(({ label }) => [
          label,
          median(
            samples
              .filter((s) => s.scenario === scenario && s.label === label)
              .map((s) => s.elapsedMs / s.operations),
          ),
        ]),
      );
      return {
        scenario,
        perOperationMs,
        speedup: perOperationMs.baseline / perOperationMs.current,
      };
    },
  );
  const report = {
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
    rounds,
    syntheticRowsPerTable: count,
    directories,
    method:
      "Separate fresh SQLite databases, identical synthetic records, untimed setup and one warmup round, alternate version order, validate result IDs and full records before and after each timed batch.",
    limitation:
      "In-process local query microbenchmark. Excludes model inference, full Kernel authorization, networking and cold startup. Do not interpret query speedup as end-to-end Agent speedup.",
    versions: versions.map(({ label, hashes }) => ({ label, hashes })),
    results,
    samples,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, results }, null, 2));
} finally {
  for (const version of versions) {
    version.manager.close();
    version.store.close();
  }
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.match(path.basename(scratch), /^foundation-query-benchmark-/);
  await rm(scratch, { recursive: true, force: true });
}
