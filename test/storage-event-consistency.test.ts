import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { FoundationEvent, Run } from "../src/contracts.js";
import { registerSecret } from "../src/core/util.js";
import { Store } from "../src/storage/store.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "foundation-event-consistency-"),
  );
  const store = new Store(directory),
    observer = new Store(directory);
  t.after(() => {
    observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, observer };
}

const run = (sessionId: string, id = "run"): Run => ({
  id,
  sessionId,
  status: "running",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
});
const missing = {
  message: "runs/run not found",
  status: 404,
  code: "not_found",
};

test("events observe run updates and deletion committed through another connection", (t) => {
  const { store, observer } = fixture(t);
  const received: FoundationEvent[] = [];
  store.events.on("run", (event) => received.push(event));
  store.put("runs", run("original"));
  assert.equal(store.emit("run", "probe", {}, false).sessionId, "original");
  const sessionId = "updated-'\"\\中文";
  observer.write("runs", run(sessionId));
  const event = store.emit("run", "probe", {});
  assert.equal(event.sessionId, store.run("run").sessionId);
  assert.equal(event.sessionId, sessionId);
  assert.equal(observer.replay("run")[0].sessionId, sessionId);
  const cursor = store.eventCursor("run");
  observer.remove("runs", "run");
  assert.throws(() => store.emit("run", "probe", {}), missing);
  assert.throws(() => store.emitEphemeral("run", "text.delta", {}), missing);
  assert.equal(store.eventCursor("run"), cursor);
  assert.equal(received.length, 2);
});

test("event session identifiers use persisted redaction for put and write", (t) => {
  const { store, observer } = fixture(t);
  const secret = `event-secret-"\\中文-${randomUUID()}`;
  registerSecret(secret, 60_000);
  const saved = store.put("runs", run(secret));
  assert.equal(saved.sessionId, "[REDACTED]");
  assert.deepEqual(observer.run("run"), saved);
  const received: FoundationEvent[] = [];
  store.events.on("run", (event) => received.push(event));
  store.emit("run", "probe", { text: secret });
  store.emitEphemeral("run", "text.delta", { text: secret });
  assert.deepEqual(
    received.map(({ sessionId, data }) => ({ sessionId, data })),
    [
      { sessionId: "[REDACTED]", data: { text: "[REDACTED]" } },
      { sessionId: "[REDACTED]", data: { text: "[REDACTED]" } },
    ],
  );
  assert.equal(received[1].seq, null);
  assert.equal(observer.replay("run").length, 1);
  assert.equal(observer.replay("run")[0].sessionId, "[REDACTED]");
  store.write("runs", run(secret + "-updated"));
  assert.equal(store.emit("run", "probe", {}).sessionId, "[REDACTED]-updated");
  assert.deepEqual(
    observer.replay("run").map((event) => event.sessionId),
    ["[REDACTED]", "[REDACTED]-updated"],
  );
});

test("event session projections respect savepoints and transaction rollback", (t) => {
  const { store, observer } = fixture(t);
  store.put("runs", run("committed"));
  const session = (source = store) =>
    source.emit("run", "probe", {}, false).sessionId;
  assert.equal(session(), "committed");
  assert.throws(
    () =>
      store.transaction(() => {
        store.write("runs", run("outer"));
        assert.equal(session(), "outer");
        assert.equal(session(observer), "committed");
        assert.throws(
          () =>
            store.transaction(() => {
              store.write("runs", run("inner"));
              assert.equal(session(), "inner");
              throw new Error("rollback inner");
            }),
          /rollback inner/,
        );
        assert.equal(session(), "outer");
        assert.throws(
          () =>
            store.transaction(() => {
              store.remove("runs", "run");
              assert.throws(() => session(), missing);
              throw new Error("rollback deletion");
            }),
          /rollback deletion/,
        );
        assert.equal(session(), "outer");
        throw new Error("rollback outer");
      }),
    /rollback outer/,
  );
  assert.equal(session(), "committed");
  assert.equal(session(observer), "committed");
  store.remove("runs", "run");
  assert.throws(
    () =>
      store.transaction(() => {
        store.write("runs", run("temporary"));
        assert.equal(session(), "temporary");
        throw new Error("rollback insertion");
      }),
    /rollback insertion/,
  );
  assert.throws(() => session(), missing);
  assert.equal(store.eventCursor("run"), 0);
});

test("events observe a run update committed by a separate Store process", (t) => {
  const { directory, store } = fixture(t);
  store.put("runs", run("original"));
  store.emit("run", "probe", {}, false);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { Store } = await import(process.argv[2]);
     const store = new Store(process.argv[1]);
     try { store.write("runs", { ...store.run("run"), sessionId: "from-child" }); }
     finally { store.close(); }`,
      directory,
      new URL("../src/storage/store.js", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(store.emit("run", "probe", {}).sessionId, "from-child");
});
