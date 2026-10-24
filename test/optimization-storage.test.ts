import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parseConfig } from "../src/core/config.js";
import { Store } from "../src/storage/store.js";
import { MemoryStore } from "../src/storage/memory.js";
import { CostLedger, type CostEntry } from "../src/runtime/cost.js";
import type { BillingOutcome } from "../src/runtime/billing.js";

function fixture(t: TestContext, prepare?: (file: string) => void) {
  const root = mkdtempSync(
    path.join(tmpdir(), "foundation-storage-optimization-"),
  );
  prepare?.(path.join(root, "foundation.sqlite"));
  const store = new Store(root);
  const config = parseConfig({
    dataDir: root,
    workspaceRoots: [root],
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
    },
  });
  store.put("projects", {
    id: "project",
    name: "test",
    root,
    createdAt: new Date().toISOString(),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, config };
}
const pendingCharge = (id: string): CostEntry => ({
  id,
  routeId: "text",
  model: "unused",
  adapter: "openai-completions",
  endpoint: "http://127.0.0.1:1",
  purpose: "test",
  status: "settled",
  reservedMicros: 1,
  chargedMicros: 1,
  basis: "provider-usage",
  billing: { state: "failed" },
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("billing recovery keeps backlog in SQLite and bounds callback concurrency", async (t) => {
  const { store, config } = fixture(t);
  store.transaction(() => {
    for (let i = 0; i < 400; i++)
      store.write("cost-ledger", pendingCharge(`charge-${i}`));
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const allDelivered = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const deliveredIds = new Set<string>();
  let active = 0,
    peak = 0,
    delivered = 0;
  const ledger = new CostLedger(
    store,
    config,
    {
      authorize() {},
      async record(charge) {
        active++;
        peak = Math.max(peak, active);
        await gate;
        delivered++;
        deliveredIds.add(charge.id);
        active--;
        if (delivered === 400) completed();
      },
    },
    { concurrency: 3, timeoutMs: 10000 },
  );
  const selectJson = store.selectJson;
  store.selectJson = () => {
    throw new Error("Recovery must not materialize a backlog");
  };
  try {
    ledger.recover();
    await turn();
    assert.equal(active, 3);
    await ledger.drain(0);
    assert.equal(delivered, 0);
    assert.equal(
      store.prepare("SELECT COUNT(*) AS count FROM billing_deliveries").get()!
        .count,
      400,
    );
    store.selectJson = selectJson;
    release();
    // A bounded shutdown drain does not promise to finish a backlog by its deadline.
    // Observe host completion independently of filesystem/CI speed before draining.
    await allDelivered;
    await ledger.drain();
    assert.equal(delivered, 400);
    assert.equal(deliveredIds.size, 400);
    assert.equal(active, 0);
    assert.equal(peak, 3);
    assert.equal(
      store.prepare("SELECT COUNT(*) AS count FROM billing_deliveries").get()!
        .count,
      0,
    );
    assert.equal(
      store
        .prepare(
          "SELECT COUNT(*) AS count FROM e_cost_ledger WHERE json_extract(body,'$.billing.state')='recorded'",
        )
        .get()!.count,
      400,
    );
  } finally {
    store.selectJson = selectJson;
    release();
    await ledger.close();
  }
});

test("billing latest outcomes remain ordered per charge while other charges can progress", async (t) => {
  const { store, config } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes: BillingOutcome[] = [];
  let active = 0,
    peak = 0;
  const ledger = new CostLedger(
    store,
    config,
    {
      authorize() {},
      async record(_charge, outcome) {
        outcomes.push(outcome);
        active++;
        peak = Math.max(peak, active);
        if (outcomes.length === 1) await gate;
        active--;
      },
    },
    { concurrency: 2 },
  );
  const charge = ledger.reserveMedia("text", config.routes.text, {
    purpose: "test",
  });
  await ledger.authorize(charge.id);
  ledger.unknown(charge.id);
  await turn();
  ledger.settleMedia(charge.id, 0.2, "invoice");
  await turn();
  assert.equal(outcomes.length, 1);
  release();
  await ledger.drain();
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["unknown", "settled"],
  );
  assert.equal(peak, 1);
  assert.equal(
    store.get<CostEntry>("cost-ledger", charge.id).billing?.state,
    "recorded",
  );
  await ledger.close();
});

test("billing timeouts preserve slots for callbacks ignoring abort and close leaves recoverable work", async (t) => {
  const { root, store, config } = fixture(t);
  for (let i = 0; i < 10; i++)
    store.write("cost-ledger", pendingCharge(`charge-${i}`));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  let started!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ledger = new CostLedger(
    store,
    config,
    {
      authorize() {},
      async record(_charge, _outcome, signal) {
        signals.push(signal!);
        if (signals.length === 2) started();
        await gate;
      },
    },
    { concurrency: 2, timeoutMs: 10, shutdownTimeoutMs: 20 },
  );
  ledger.recover();
  const listeners = new Map<AbortSignal, () => void>();
  const bothAborted = async () => {
    await bothStarted;
    assert.equal(signals.length, 2);
    await Promise.all(
      signals.map(
        (signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const onAbort = () => resolve();
            listeners.set(signal, onAbort);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
      ),
    );
    // Give any incorrectly freed slot a chance to start another callback.
    await turn();
  };
  let deadline!: ReturnType<typeof setTimeout>;
  // Delivery timers are unref'ed: a referenced failure deadline also keeps the wait alive.
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () =>
        reject(
          new Error(
            "Billing callbacks did not start and abort within 10 seconds",
          ),
        ),
      10000,
    );
  });
  try {
    await Promise.race([bothAborted(), expired]);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
  } catch (error) {
    await ledger.close();
    release();
    await turn();
    throw error;
  } finally {
    clearTimeout(deadline);
    for (const [signal, listener] of listeners)
      signal.removeEventListener("abort", listener);
  }
  await ledger.close();
  store.close();
  release();
  await turn();
  const reopened = new Store(root);
  let delivered = 0;
  const restored = new CostLedger(reopened, config, {
    authorize() {},
    record() {
      delivered++;
    },
  });
  try {
    restored.recover();
    await restored.drain();
    assert.equal(delivered, 10);
  } finally {
    await restored.close();
    reopened.close();
  }
});

test("FTS upgrade preserves old rows and updates/deletes use indexed rowid mappings", (t) => {
  const { store, config } = fixture(t, (file) => {
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,project_id UNINDEXED,namespace UNINDEXED,terms,tokenize='unicode61'); INSERT INTO memory_fts(rowid,id,project_id,namespace,terms) VALUES(7,'old','project','default','legacy'),(9,'old','project','default','legacy duplicate')",
    );
    db.close();
  });
  assert.equal(
    store.prepare("SELECT COUNT(*) AS count FROM memory_fts_map").get()!.count,
    2,
  );
  const memory = new MemoryStore(store, config);
  memory.put({ id: "old", projectId: "project", content: "replacement" });
  assert.equal(
    store.prepare("SELECT rowid FROM memory_fts WHERE rowid=7").get()!.rowid,
    7,
  );
  assert.equal(
    store.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()!.count,
    1,
  );
  assert.equal(memory.search("project", "legacy").length, 0);
  assert.equal(memory.search("project", "replacement")[0].id, "old");
  const plan = JSON.stringify(
    store
      .prepare(
        "EXPLAIN QUERY PLAN DELETE FROM memory_fts WHERE rowid IN (SELECT fts_rowid FROM memory_fts_map WHERE memory_id=?)",
      )
      .all("old"),
  );
  assert.match(plan, /memory_fts_map_id/);
  assert.match(plan, /VIRTUAL TABLE INDEX 0:=/);
  memory.put({ id: "old", projectId: "project", content: "updated" });
  assert.equal(
    store
      .prepare("SELECT fts_rowid FROM memory_fts_map WHERE memory_id=?")
      .get("old")!.fts_rowid,
    7,
  );
  assert.throws(
    () =>
      store.transaction(() => {
        memory.remove("old", "project");
        throw Error("rollback");
      }),
    /rollback/,
  );
  assert.equal(memory.search("project", "updated").length, 1);
  memory.remove("old", "project");
  assert.equal(
    store.prepare("SELECT COUNT(*) AS count FROM memory_fts_map").get()!.count,
    0,
  );
  assert.equal(
    store.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()!.count,
    0,
  );
});

test("global budget totals follow raw SQL, replacement, rollback, overflow and trigger repair", (t) => {
  const { root, store } = fixture(t);
  store.write("cost-ledger", {
    id: "held",
    status: "reserved",
    reservedMicros: 40,
  });
  store.write("cost-ledger", {
    id: "unknown",
    status: "unknown",
    reservedMicros: 30,
  });
  store.write("cost-ledger", {
    id: "settled",
    status: "settled",
    chargedMicros: 20,
  });
  store.write("cost-ledger", {
    id: "void",
    status: "void",
    reservedMicros: 100,
  });
  assert.equal(store.committedCost(), 90);
  const observer = new Store(root);
  try {
    store.db.exec(
      "UPDATE e_cost_ledger SET body=json_set(body,'$.status','settled','$.chargedMicros',70) WHERE id='held'",
    );
    assert.equal(observer.committedCost(), 120);
    assert.throws(
      () =>
        store.transaction(() => {
          store.remove("cost-ledger", "unknown");
          assert.equal(store.committedCost(), 90);
          throw Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(observer.committedCost(), 120);
    store
      .prepare("INSERT OR REPLACE INTO e_cost_ledger(id,body) VALUES(?,?)")
      .run("held", JSON.stringify({ id: "held", status: "void" }));
    assert.equal(observer.committedCost(), 50);
    store.write("cost-ledger", {
      id: "large",
      status: "settled",
      chargedMicros: Number.MAX_SAFE_INTEGER,
    });
    assert.throws(() => store.committedCost(), /safe integer/);
    store.remove("cost-ledger", "large");
    assert.equal(store.committedCost(), 50);
    store.write("cost-ledger", {
      id: "overflow",
      status: "settled",
      chargedMicros: 1e300,
    });
    assert.throws(() => store.committedCost(), /safe integer/);
    store.remove("cost-ledger", "overflow");
    assert.equal(store.committedCost(), 50);
    assert.equal(store.rebuildCommittedCostTotal(), 50);
    assert.deepEqual(store.verifyCommittedCostTotal(), {
      stored: 50,
      calculated: 50,
      valid: true,
    });
    const read = store.prepare.bind(store);
    store.prepare = (sql) => {
      assert.doesNotMatch(sql, /FROM e_cost_ledger/);
      return read(sql);
    };
    assert.equal(store.committedCost(), 50);
    store.prepare = read;
    store.db.exec(
      "DROP TRIGGER cost_total_update; UPDATE e_cost_ledger SET body=json_set(body,'$.reservedMicros',60) WHERE id='unknown'",
    );
  } finally {
    observer.close();
  }
  const repaired = new Store(root);
  try {
    assert.equal(repaired.committedCost(), 80);
    assert.equal(repaired.verifyCommittedCostTotal().valid, true);
  } finally {
    repaired.close();
  }
});

test("media idempotency lookup tolerates historical duplicates but rejects any conflicting hash and new duplicates", (t) => {
  const { root, store } = fixture(t);
  store.db.exec("DROP TRIGGER jobs_idempotency_insert");
  for (const [id, requestHash] of [
    ["first", "same"],
    ["duplicate", "same"],
    ["conflict", "different"],
  ])
    store.write("jobs", {
      id,
      projectId: "project",
      idempotencyKey: "key",
      requestHash,
    });
  const repaired = new Store(root);
  try {
    assert.throws(
      () => repaired.findMediaJob("project", "key", "same"),
      /different input/,
    );
    repaired.remove("jobs", "conflict");
    assert.equal(repaired.findMediaJob("project", "key", "same")?.id, "first");
    assert.throws(
      () =>
        repaired.write("jobs", {
          id: "new",
          projectId: "project",
          idempotencyKey: "key",
          requestHash: "same",
        }),
      /already exists/,
    );
    repaired.write("jobs", {
      id: "first",
      projectId: "project",
      idempotencyKey: "key",
      requestHash: "same",
      status: "completed",
    });
    assert.equal(
      repaired.findMediaJob("project", "key", "same")?.status,
      "completed",
    );
    assert.equal(repaired.findMediaJob("other", "key", "same"), undefined);
    const plan = JSON.stringify(
      repaired
        .prepare(
          "EXPLAIN QUERY PLAN SELECT body FROM e_jobs WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.idempotencyKey')=? ORDER BY rowid LIMIT 1",
        )
        .all("project", "key"),
    );
    assert.match(plan, /jobs_idempotency/);
  } finally {
    repaired.close();
  }
});

test("queued media cancellation releases only an unsubmitted unauthorized reservation", async (t) => {
  const { store, config } = fixture(t);
  const ledger = new CostLedger(store, config, { authorize() {}, record() {} });
  const first = ledger.reserve(
    "text",
    config.routes.text,
    { purpose: "test" },
    10,
  );
  ledger.voidUnsubmitted(first.id);
  assert.equal(store.committedCost(), 0);
  const second = ledger.reserve(
    "text",
    config.routes.text,
    { purpose: "test" },
    20,
  );
  await ledger.authorize(second.id);
  assert.throws(() => ledger.voidUnsubmitted(second.id), /Cannot void/);
  assert.equal(store.committedCost(), 20);
  await ledger.close();
});

test("cancelled authorization waits for the host result before voiding the unsent call", async (t) => {
  const { store, config } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes: BillingOutcome[] = [];
  const ledger = new CostLedger(store, config, {
    authorize() {
      return gate;
    },
    record(_charge, outcome) {
      outcomes.push(outcome);
    },
  });
  const charge = ledger.reserve(
    "text",
    config.routes.text,
    { purpose: "test" },
    10,
  );
  const controller = new AbortController();
  const attempt = ledger
    .authorize(charge.id, controller.signal)
    .catch((error: unknown) => error);
  assert.equal(
    store.get<CostEntry>("cost-ledger", charge.id).billing?.state,
    "authorizing",
  );
  controller.abort(new Error("cancelled authorization"));
  ledger.unknown(charge.id);
  await ledger.drain();
  assert.equal(outcomes.length, 0);
  release();
  assert.match(String(await attempt), /cancelled authorization/);
  await ledger.drain();
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["void"],
  );
  await ledger.close();
});

test("late authorization cannot access a closed store and recovers as an unsent void", async (t) => {
  for (const reject of [false, true]) {
    const { root, store, config } = fixture(t);
    let finish!: () => void;
    const gate = new Promise<void>((resolve, fail) => {
      finish = () => (reject ? fail(new Error("late refusal")) : resolve());
    });
    const ledger = new CostLedger(store, config, {
      authorize() {
        return gate;
      },
      record() {
        assert.fail("Host authorization is still pending");
      },
    });
    const charge = ledger.reserve(
      "text",
      config.routes.text,
      { purpose: "test" },
      10,
    );
    const controller = new AbortController();
    const attempt = ledger
      .authorize(charge.id, controller.signal)
      .catch((error: unknown) => error);
    controller.abort(new Error("cancelled authorization"));
    ledger.unknown(charge.id);
    await ledger.close();
    store.close();
    finish();
    assert.match(String(await attempt), /cancelled authorization|late refusal/);
    const reopened = new Store(root);
    const outcomes: BillingOutcome[] = [];
    const recovered = new CostLedger(reopened, config, {
      authorize() {},
      record(_charge, outcome) {
        outcomes.push(outcome);
      },
    });
    try {
      recovered.recover();
      await recovered.drain();
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        ["void"],
      );
    } finally {
      await recovered.close();
      reopened.close();
    }
  }
});
