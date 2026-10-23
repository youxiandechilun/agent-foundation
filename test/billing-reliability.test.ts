import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parseConfig } from "../src/core/config.js";
import { Store } from "../src/storage/store.js";
import { CostLedger, billingTokens } from "../src/runtime/cost.js";
import type {
  BillingOutcome,
  BillingProvider,
} from "../src/runtime/billing.js";

function fixture(t: TestContext, provider: BillingProvider) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(
    path.join(parent, "foundation-billing-reliability-"),
  );
  const config = parseConfig({
    dataDir: root,
    workspaceRoots: [root],
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "no-provider",
        baseUrl: "http://127.0.0.1:1",
        pricing: {
          currency: "USD",
          inputPerMillion: 1,
          outputPerMillion: 1,
          requestUsd: 0,
        },
      },
    },
  });
  let store = new Store(root);
  let ledger = new CostLedger(store, config, provider);
  t.after(async () => {
    await ledger.close();
    store.close();
    assert.equal(realpathSync(path.dirname(root)), parent);
    assert.equal(realpathSync(root), root);
    rmSync(root, { recursive: true, force: false });
  });
  return {
    config,
    get ledger() {
      return ledger;
    },
    reserve() {
      return ledger.reserve(
        "text",
        config.routes.text,
        { purpose: "test" },
        1000,
      );
    },
    async restart() {
      await ledger.close();
      store.close();
      store = new Store(root);
      ledger = new CostLedger(store, config, provider);
      ledger.recover();
    },
  };
}

test("ordinary reconciliation is durably delivered with a new revision and retries keep it", async (t) => {
  const outcomes: BillingOutcome[] = [];
  let fail = false;
  const x = fixture(t, {
    authorize() {},
    record(_charge, outcome) {
      outcomes.push(outcome);
      if (fail) throw new Error("host unavailable");
    },
  });
  const charge = x.reserve();
  await x.ledger.authorize(charge);
  x.ledger.unknown(charge.id);
  assert.deepEqual(await x.ledger.drain(), {
    pending: 0,
    failed: 0,
    active: 0,
  });
  fail = true;
  x.ledger.reconcile(charge.id, 0.00002, "invoice-ordinary");
  assert.deepEqual(await x.ledger.drain(), {
    pending: 0,
    failed: 1,
    active: 0,
  });
  assert.deepEqual(
    outcomes.map(({ status, revision }) => ({ status, revision })),
    [
      { status: "unknown", revision: 1 },
      { status: "settled", revision: 2 },
    ],
  );
  fail = false;
  await x.restart();
  await x.ledger.drain();
  assert.deepEqual(outcomes[2], outcomes[1]);
  assert.equal(outcomes[2].chargedMicros, 20);
  assert.equal(outcomes[2].reference, "invoice-ordinary");
  assert.deepEqual(x.ledger.deliveryStatus(), {
    pending: 0,
    failed: 0,
    active: 0,
  });
  await x.restart();
  await x.ledger.drain();
  assert.equal(outcomes.length, 3);
});

test("invalid usage remains unknown without billable tokens on priced and unpriced routes", async (t) => {
  const outcomes: BillingOutcome[] = [];
  const x = fixture(t, {
    authorize() {},
    record(_charge, outcome) {
      outcomes.push(outcome);
    },
  });
  const usage = {
    reported: true,
    input: 100,
    output: 10,
    cacheRead: 150,
    cacheWrite: 0,
    totalTokens: 110,
  };
  for (const priced of [true, false]) {
    if (!priced) delete x.config.routes.text.pricing;
    for (const badUsage of [
      usage,
      { ...usage, cacheRead: 0, output: -1 },
      { ...usage, cacheRead: 0, cacheWrite: 101 },
    ]) {
      const charge = x.reserve();
      await x.ledger.authorize(charge);
      const entry = x.ledger.settleUsage(
        charge.id,
        x.config.routes.text,
        badUsage,
        "response-invalid",
      );
      await x.ledger.drain();
      assert.equal(entry.status, "unknown");
      assert.equal(entry.chargedMicros, undefined);
      assert.deepEqual(entry.usage, badUsage);
      const outcome = outcomes.at(-1)!;
      assert.equal(outcome.status, "unknown");
      assert.equal(outcome.tokens, undefined);
      assert.equal(outcome.responseId, "response-invalid");
      assert.match(outcome.reason ?? "", /Invalid provider usage/);
    }
  }
  assert.throws(
    () => billingTokens("openai-completions", usage),
    /Invalid provider usage/,
  );
  assert.deepEqual(billingTokens("anthropic-messages", usage), {
    input: 100,
    output: 10,
    cacheRead: 150,
    cacheWrite: 0,
  });
});

test("a lost authorization response releases the committed hold after delivery recovery", async (t) => {
  const holds = new Set<string>();
  const outcomes: BillingOutcome[] = [];
  let offline = true;
  let calls = 0;
  const x = fixture(t, {
    authorize(charge) {
      calls++;
      holds.add(charge.id);
      throw new Error("response lost after commit");
    },
    record(charge, outcome) {
      outcomes.push(outcome);
      if (offline) throw new Error("offline");
      if (outcome.status === "void") holds.delete(charge.id);
    },
  });
  const charge = x.reserve();
  await assert.rejects(
    x.ledger.authorize(charge),
    /response lost after commit/,
  );
  assert.deepEqual(await x.ledger.drain(), {
    pending: 0,
    failed: 1,
    active: 0,
  });
  assert.equal(holds.size, 1);
  assert.equal(x.ledger.entries()[0].status, "void");
  await assert.rejects(x.ledger.authorize(charge), /already attempted/);
  offline = false;
  await x.restart();
  await x.ledger.drain();
  assert.equal(holds.size, 0);
  assert.equal(calls, 1);
  assert.equal(outcomes[0].status, "void");
  assert.equal(outcomes[0].revision, 1);
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test("a void tombstone prevents a pending authorization from reserving after restart", async (t) => {
  const holds = new Set<string>();
  const terminal = new Set<string>();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const x = fixture(t, {
    async authorize(charge) {
      await gate;
      if (terminal.has(charge.id)) throw new Error("charge is void");
      holds.add(charge.id);
    },
    record(charge, outcome) {
      assert.equal(outcome.status, "void");
      terminal.add(charge.id);
      holds.delete(charge.id);
    },
  });
  const charge = x.reserve();
  const attempt = x.ledger.authorize(charge).catch((error: unknown) => error);
  assert.deepEqual(await x.ledger.drain(0), {
    pending: 1,
    failed: 0,
    active: 0,
  });
  await x.restart();
  await x.ledger.drain();
  assert.ok(terminal.has(charge.id));
  finish();
  assert.match(String(await attempt), /charge is void/);
  assert.equal(holds.size, 0);
});

test("an older in-flight result cannot acknowledge a newer reconciliation revision", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes: BillingOutcome[] = [];
  const x = fixture(t, {
    authorize() {},
    async record(_charge, outcome) {
      outcomes.push(outcome);
      if (outcome.revision === 1) await gate;
    },
  });
  const charge = x.reserve();
  await x.ledger.authorize(charge);
  x.ledger.unknown(charge.id);
  await x.ledger.drain(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  x.ledger.reconcile(charge.id, 0.00001, "invoice-newer");
  assert.deepEqual(x.ledger.deliveryStatus(), {
    pending: 1,
    failed: 0,
    active: 1,
  });
  release();
  await x.ledger.drain();
  assert.deepEqual(
    outcomes.map(({ revision }) => revision),
    [1, 2],
  );
  assert.equal(x.ledger.entries()[0].billing?.revision, 2);
  assert.deepEqual(x.ledger.deliveryStatus(), {
    pending: 0,
    failed: 0,
    active: 0,
  });
});
