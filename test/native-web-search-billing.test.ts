import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parseConfig } from "../src/core/config.js";
import {
  type BillingCharge,
  type BillingOutcome,
  type BillingProvider,
} from "../src/runtime/billing.js";
import { CostLedger, type CostEntry } from "../src/runtime/cost.js";
import type { AssistantMessage, ModelRequest } from "../src/runtime/types.js";
import { Store } from "../src/storage/store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function fixture(
  t: TestContext,
  nativeSearch: boolean,
  record?: BillingProvider["record"],
) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-native-billing-"));
  const config = parseConfig({
    dataDir: path.join(root, "data"),
    workspaceRoots: [path.join(root, "workspace")],
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-responses",
        model: "billing-test",
        baseUrl: "http://127.0.0.1:4317/v1",
        nativeWebSearch: nativeSearch,
        ...(nativeSearch ? { pricing: { maxRequestUsd: 0.25 } } : {}),
      },
    },
    budgets: { enabled: nativeSearch, maxTotalUsd: 1 },
  });
  const store = new Store(config.dataDir);
  const authorized: BillingCharge[] = [];
  const recorded: { charge: BillingCharge; outcome: BillingOutcome }[] = [];
  const provider: BillingProvider = {
    authorize(charge) {
      if (nativeSearch)
        assert.equal(
          store.get<CostEntry>("cost-ledger", charge.id).requiresReconciliation,
          true,
        );
      authorized.push(structuredClone(charge));
    },
    record(charge, outcome) {
      recorded.push(structuredClone({ charge, outcome }));
      return record?.(charge, outcome);
    },
  };
  const ledger = new CostLedger(store, config, provider);
  t.after(async () => {
    if (!store.isClosed) await ledger.close();
    store.close();
  });
  const request: ModelRequest = {
    routeId: "text",
    messages: [],
    tools: [],
    nativeWebSearch: nativeSearch,
  };
  const response: AssistantMessage = {
    role: "assistant",
    provider: "text",
    model: "billing-test",
    responseId: "billing-response",
    content: [{ type: "text", text: "Complete" }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      reported: true,
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
    },
  };
  return {
    config,
    store,
    provider,
    ledger,
    authorized,
    recorded,
    request,
    response,
  };
}

test("host billing keeps hosted search unknown until the actual charge is reconciled", async (t) => {
  const x = await fixture(t, true);
  const result = await x.ledger.text(
    "text",
    x.config.routes.text,
    x.request,
    { purpose: "agent" },
    async () => {
      assert.equal(x.authorized.length, 1);
      assert.equal(x.authorized[0].reservedMicros, 250000);
      assert.equal(x.recorded.length, 0);
      return x.response;
    },
  );
  assert.equal(result, x.response);
  await x.ledger.drain();
  const [entry] = x.ledger.entries();
  assert.equal(entry.status, "unknown");
  assert.equal(entry.requiresReconciliation, true);
  assert.equal(entry.reservedMicros, 250000);
  assert.equal(entry.chargedMicros, undefined);
  assert.equal(x.ledger.summary().heldMicros, 250000);
  assert.equal(x.recorded.length, 1);
  assert.equal(x.recorded[0].charge.id, entry.id);
  assert.deepEqual(x.recorded[0].outcome, {
    revision: 1,
    status: "unknown",
    responseId: "billing-response",
    reason: "Provider-hosted web search charges require reconciliation",
    tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  });

  x.ledger.reconcile(entry.id, 0.03, "provider-invoice-1");
  await x.ledger.drain();
  const [reconciled] = x.ledger.entries();
  assert.equal(reconciled.status, "settled");
  assert.equal(reconciled.basis, "operator");
  assert.equal(reconciled.chargedMicros, 30000);
  assert.equal(x.ledger.summary().heldMicros, 0);
  assert.equal(x.ledger.summary().chargedMicros, 30000);
  assert.equal(x.recorded.length, 2);
  assert.equal(x.recorded[1].charge.id, entry.id);
  assert.deepEqual(x.recorded[1].outcome, {
    revision: 2,
    status: "settled",
    responseId: "billing-response",
    tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    chargedMicros: 30000,
    reference: "provider-invoice-1",
  });
});

test("ordinary unpriced text still reports settled tokens to host billing", async (t) => {
  const x = await fixture(t, false);
  await x.ledger.text(
    "text",
    x.config.routes.text,
    x.request,
    { purpose: "agent" },
    async () => {
      assert.equal(x.authorized.length, 1);
      assert.equal(x.recorded.length, 0);
      return x.response;
    },
  );
  await x.ledger.drain();
  const [entry] = x.ledger.entries();
  assert.equal(entry.status, "unknown");
  assert.equal(entry.requiresReconciliation, undefined);
  assert.equal(entry.basis, "unpriced");
  assert.equal(entry.reservedMicros, 0);
  assert.equal(x.recorded.length, 1);
  assert.equal(x.recorded[0].charge.id, entry.id);
  assert.deepEqual(x.recorded[0].outcome, {
    revision: 1,
    status: "settled",
    responseId: "billing-response",
    tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  });
});

test("reconciliation waits for the earlier outcome without marking its newer delivery complete", async (t) => {
  const unknownStarted = deferred();
  const releaseUnknown = deferred();
  const settledStarted = deferred();
  const releaseSettled = deferred();
  const applied: BillingOutcome["status"][] = [];
  const x = await fixture(t, true, async (_charge, outcome) => {
    if (outcome.status === "unknown") {
      unknownStarted.resolve();
      await releaseUnknown.promise;
    } else {
      settledStarted.resolve();
      await releaseSettled.promise;
    }
    applied.push(outcome.status);
  });
  try {
    await x.ledger.text(
      "text",
      x.config.routes.text,
      x.request,
      { purpose: "agent" },
      async () => x.response,
    );
    await unknownStarted.promise;
    const [initial] = x.ledger.entries();
    const initialDelivery = initial.billing?.deliveryId;
    assert.ok(initialDelivery);
    assert.equal(initial.billing?.state, "authorized");

    x.ledger.reconcile(initial.id, 0.04, "concurrent-invoice-1");
    const pendingDelivery = x.ledger.entries()[0].billing?.deliveryId;
    assert.ok(pendingDelivery);
    assert.notEqual(pendingDelivery, initialDelivery);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(x.recorded.length, 1);
    assert.deepEqual(applied, []);

    releaseUnknown.resolve();
    await settledStarted.promise;
    assert.deepEqual(applied, ["unknown"]);
    assert.equal(x.recorded.length, 2);
    const [pending] = x.ledger.entries();
    assert.equal(pending.status, "settled");
    assert.equal(pending.billing?.deliveryId, pendingDelivery);
    assert.equal(pending.billing?.state, "authorized");

    releaseSettled.resolve();
    await x.ledger.drain();
    assert.deepEqual(applied, ["unknown", "settled"]);
    assert.equal(x.recorded[1].charge.id, initial.id);
    assert.equal(x.recorded[1].outcome.chargedMicros, 40000);
    const [completed] = x.ledger.entries();
    assert.equal(completed.billing?.deliveryId, pendingDelivery);
    assert.equal(completed.billing?.state, "recorded");
  } finally {
    releaseUnknown.resolve();
    releaseSettled.resolve();
    await x.ledger.drain();
  }
});

test("a blocked billing delivery does not prevent another charge from reaching the host", async (t) => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  let firstId: string | undefined;
  const applied: string[] = [];
  const x = await fixture(t, true, async (charge) => {
    if (!firstId) {
      firstId = charge.id;
      firstStarted.resolve();
      await releaseFirst.promise;
    } else secondStarted.resolve();
    applied.push(charge.id);
  });
  const complete = () =>
    x.ledger.text(
      "text",
      x.config.routes.text,
      x.request,
      { purpose: "agent" },
      async () => x.response,
    );
  try {
    await complete();
    await firstStarted.promise;
    await complete();
    await secondStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(x.recorded.length, 2);
    const secondId = x.recorded[1].charge.id;
    assert.notEqual(secondId, firstId);
    assert.deepEqual(applied, [secondId]);
    const entries = x.ledger.entries();
    assert.equal(
      entries.find((entry) => entry.id === firstId)?.billing?.state,
      "authorized",
    );
    assert.equal(
      entries.find((entry) => entry.id === secondId)?.billing?.state,
      "recorded",
    );
    releaseFirst.resolve();
    await x.ledger.drain();
    assert.deepEqual(applied, [secondId, firstId]);
  } finally {
    releaseFirst.resolve();
    await x.ledger.drain();
  }
});

for (const explicitSent of [false, true]) {
  test(`failed hosted search ${explicitSent ? "with requestSent" : "without requestSent"} still notifies the reconciled charge`, async (t) => {
    const x = await fixture(t, true);
    const failure = new Error("Provider connection interrupted");
    if (explicitSent) Object.assign(failure, { requestSent: true });
    await assert.rejects(
      x.ledger.text(
        "text",
        x.config.routes.text,
        x.request,
        { purpose: "agent" },
        async () => {
          const [reserved] = x.ledger.entries();
          assert.equal(reserved.status, "reserved");
          assert.equal(reserved.requiresReconciliation, true);
          throw failure;
        },
      ),
      (error) => error === failure,
    );
    await x.ledger.drain();
    const [entry] = x.ledger.entries();
    assert.equal(entry.status, "unknown");
    assert.equal(entry.requiresReconciliation, true);
    assert.equal(x.recorded.length, 1);
    assert.equal(x.recorded[0].outcome.status, "unknown");

    x.ledger.reconcile(entry.id, 0.02, "interrupted-invoice-1");
    await x.ledger.drain();
    assert.equal(x.recorded.length, 2);
    assert.equal(x.recorded[1].charge.id, entry.id);
    assert.deepEqual(x.recorded[1].outcome, {
      revision: 2,
      status: "settled",
      chargedMicros: 20000,
      reference: "interrupted-invoice-1",
    });
  });
}

test("a persisted hosted search reservation retains reconciliation after recovery", async (t) => {
  const x = await fixture(t, true);
  let reservation: CostEntry | undefined;
  await assert.rejects(
    x.ledger.text(
      "text",
      x.config.routes.text,
      x.request,
      { purpose: "agent" },
      async () => {
        reservation = structuredClone(x.ledger.entries()[0]);
        throw new Error("Simulated process interruption");
      },
    ),
    /Simulated process interruption/,
  );
  await x.ledger.drain();
  assert.ok(reservation);
  assert.equal(reservation.status, "reserved");
  assert.equal(reservation.requiresReconciliation, true);
  // Restore the pre-operation SQLite image: a terminated process cannot run its catch path.
  x.store.put("cost-ledger", reservation);
  x.store.close();
  x.recorded.length = 0;
  const reopened = new Store(x.config.dataDir);
  const restarted = new CostLedger(reopened, x.config, x.provider);
  try {
    restarted.recover();
    await restarted.drain();
    const [recovered] = restarted.entries();
    assert.equal(recovered.status, "unknown");
    assert.equal(recovered.requiresReconciliation, true);
    assert.equal(restarted.summary().heldMicros, 250000);
    assert.equal(x.recorded.length, 1);
    assert.equal(x.recorded[0].outcome.status, "unknown");

    restarted.reconcile(recovered.id, 0.06, "recovered-invoice-1");
    await restarted.drain();
    assert.equal(x.recorded.length, 2);
    assert.equal(x.recorded[1].charge.id, reservation.id);
    assert.deepEqual(x.recorded[1].outcome, {
      revision: 2,
      status: "settled",
      chargedMicros: 60000,
      reference: "recovered-invoice-1",
    });
  } finally {
    await restarted.drain();
    reopened.close();
  }
});
