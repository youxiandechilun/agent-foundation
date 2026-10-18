import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { Session } from "../src/contracts.js";
import { sessionTools } from "../src/sessions/tools.js";
import { setup } from "./support/wire-server.js";

test("session references use primary keys, retain insertion order and recheck live project grants", async (t) => {
  const x = await setup();
  try {
    const { store } = x.kernel;
    const source = x.kernel.createSession(x.project.id),
      branch = x.kernel.createSession(x.project.id);
    store.write("sessions", { ...branch, forkedFromSessionId: source.id });
    const reader = x.kernel.createSession(x.project.id),
      attached = x.kernel.createSession(x.project.id);
    const other = await x.kernel.createProject("other"),
      foreign = x.kernel.createSession(other.id);
    const granted = [attached.id, foreign.id, "missing"];
    store.write("sessions", {
      ...reader,
      forkedFromSessionId: branch.id,
      readableSessionIds: granted,
    });
    store.transaction(() => {
      for (let index = 0; index < 12000; index++)
        store.write("sessions", {
          ...reader,
          id: `unrelated-${index}`,
          name: "historical context ".repeat(10),
        });
    });
    const tool = sessionTools({
      kernel: x.kernel,
      session: reader,
      runId: "unused",
      routeId: reader.routeId,
    }).find((candidate) => candidate.name === "session_list");
    assert.ok(tool);
    const expected = [source, branch, reader, attached].map(
      ({ id, name, mode }) => ({
        id,
        name,
        mode,
        forkedThroughMessageId: undefined,
        forkedFromSessionId:
          id === branch.id
            ? source.id
            : id === reader.id
              ? branch.id
              : undefined,
      }),
    );
    assert.deepEqual((await tool.execute("read", {})).details, {
      sessions: expected,
    });
    const ids = [
      attached.id,
      foreign.id,
      reader.id,
      branch.id,
      source.id,
      attached.id,
      "missing",
    ];
    assert.deepEqual(
      store.listByIds<Session>("sessions", ids).map((item) => item.id),
      [source.id, branch.id, reader.id, attached.id, foreign.id],
    );
    assert.deepEqual(store.listByIds("sessions", []), []);
    assert.throws(
      () => Reflect.apply(store.listByIds, store, ["sessions", [null]]),
      /Invalid entity IDs/,
    );
    const plan = store
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM entities WHERE kind=? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
      )
      .all("sessions", JSON.stringify(ids));
    assert.match(
      JSON.stringify(plan),
      /SEARCH entities USING INDEX sqlite_autoindex_entities_1/,
    );
    const median = (operation: () => unknown) => {
      const samples = Array.from({ length: 5 }, () => {
        const start = performance.now();
        operation();
        return performance.now() - start;
      }).sort((a, b) => a - b);
      return Number(samples[2].toFixed(3));
    };
    const scope = new Set(ids);
    t.diagnostic(
      JSON.stringify({
        unrelatedSessions: 12000,
        previousMedianMs: median(() =>
          store
            .list<Session>("sessions", { projectId: x.project.id })
            .filter((item) => scope.has(item.id)),
        ),
        primaryKeyMedianMs: median(() =>
          store
            .listByIds<Session>("sessions", ids)
            .filter((item) => item.projectId === x.project.id),
        ),
      }),
    );
    store.write("sessions", {
      ...reader,
      forkedFromSessionId: branch.id,
      readableSessionIds: [],
    });
    assert.deepEqual((await tool.execute("revoked", {})).details, {
      sessions: expected.slice(0, 3),
    });
  } finally {
    try {
      await x.close();
    } finally {
      assert.equal(path.dirname(x.root), tmpdir());
      assert.match(path.basename(x.root), /^foundation-v2-/);
      await rm(x.root, { recursive: true, force: true });
    }
  }
});
