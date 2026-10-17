import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, collect, until } from "./support/wire-server.js";
import { CostLedger } from "../src/runtime/cost.js";
import { RouteRouter } from "../src/providers/text.js";
import { emptyUsage } from "../src/runtime/types.js";
const pricing = {
  currency: "USD" as const,
  inputPerMillion: 2,
  outputPerMillion: 4,
  requestUsd: 0,
};

test("real protocol usage settles the configured model price and exposes durable cost APIs", async () => {
  const x = await setup();
  x.config.routes.text.pricing = pricing;
  x.config.budgets = { enabled: true, maxRunUsd: 1 };
  try {
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "calculate" });
    await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const summary = await x.client.costs({ runId: r.runId });
    assert.equal(summary.chargedMicros, 68);
    assert.equal(summary.heldMicros, 0);
    assert.equal(summary.entries[0].basis, "provider-usage");
    assert.equal(summary.entries[0].projectId, x.project.id);
  } finally {
    await x.close();
  }
});

test("cost ceilings and missing prices stop before any model HTTP request", async () => {
  const x = await setup();
  x.config.budgets = { enabled: true, maxRunUsd: 0.000001 };
  try {
    for (const price of [undefined, pricing]) {
      x.config.routes.text.pricing = price;
      const s = await x.session("code"),
        r = await x.client.submit(s.id, { text: "must not send" });
      await collect(x.client, r.runId);
      assert.equal((await x.kernel.wait(r.runId)).status, "failed");
    }
    assert.equal(x.wire.requests.length, 0);
    assert.equal(x.kernel.costs.entries().length, 0);
  } finally {
    await x.close();
  }
});

test("reservations are atomic across concurrent scopes and ambiguous charges stay held until reconciliation", async () => {
  const x = await setup();
  const route = { ...x.config.routes.text, pricing };
  x.config.budgets = { enabled: true, maxProjectUsd: 0.1 };
  try {
    const scope = { projectId: x.project.id, purpose: "reservation-test" };
    const first = x.kernel.costs.reserve("text", route, scope, 60000);
    assert.throws(
      () => x.kernel.costs.reserve("text", route, scope, 60000),
      /budget exhausted/,
    );
    x.kernel.costs.unknown(first.id);
    assert.equal(x.kernel.costs.summary().heldMicros, 60000);
    const corrected = await x.client.reconcileCost(
      first.id,
      0.01,
      "local-test-invoice-1",
    );
    assert.equal(corrected.chargedMicros, 10000);
    assert.equal(x.kernel.store.list("cost-adjustments").length, 1);
    x.kernel.costs.reserve("text", route, scope, 60000);
    const restored = new CostLedger(x.kernel.store, x.config);
    restored.recover();
    assert.equal(restored.summary().heldMicros, 60000);
    assert.equal(
      restored.entries().filter((e) => e.status === "reserved").length,
      0,
    );
  } finally {
    await x.close();
  }
});

test("cache accounting distinguishes inclusive OpenAI usage from Anthropic cache token categories", async () => {
  const x = await setup();
  try {
    const route = {
      ...x.config.routes.text,
      pricing: {
        ...pricing,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 3,
      },
    };
    const u = {
      reported: true,
      input: 100,
      output: 10,
      cacheRead: 30,
      cacheWrite: 20,
      totalTokens: 160,
    };
    for (const adapter of [
      "openai-completions",
      "anthropic-messages",
    ] as const) {
      const r = { ...route, adapter },
        e = x.kernel.costs.reserve("text", r, { purpose: "cache-test" }, 1000);
      const settled = x.kernel.costs.settleUsage(e.id, r, u);
      assert.equal(
        settled.chargedMicros,
        adapter === "anthropic-messages" ? 315 : 215,
      );
    }
    const e = x.kernel.costs.reserve(
      "text",
      route,
      { purpose: "missing-usage" },
      1000,
    );
    x.kernel.costs.settleUsage(e.id, route, emptyUsage());
    assert.equal(x.kernel.costs.entries().at(-1)?.status, "unknown");
  } finally {
    await x.close();
  }
});

test("fallback attempts keep distinct price snapshots and the failed attempt's reservation", async () => {
  const x = await setup();
  x.config.routes.text.pricing = pricing;
  x.config.routes.fallback = {
    ...x.config.routes.text,
    pricing: { ...pricing, inputPerMillion: 5 },
  };
  x.config.routes.text.fallbackRouteIds = ["fallback"];
  x.config.routes.text.baseUrl = "http://127.0.0.1:1";
  try {
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "fallback" });
    await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const entries = x.kernel.costs.entries({ runId: r.runId });
    assert.equal(entries.length, 2);
    assert.equal(entries.find((e) => e.routeId === "text")?.status, "unknown");
    assert.equal(
      entries.find((e) => e.routeId === "fallback")?.chargedMicros,
      98,
    );
  } finally {
    await x.close();
  }
});

test("media requests reserve their configured maximum and idempotent replay does not reserve twice", async () => {
  const x = await setup();
  x.config.routes.image = {
    ...x.config.routes.text,
    kind: "image",
    adapter: "image-json",
    pricing: { ...pricing, maxRequestUsd: 0.2 },
  };
  x.config.budgets = { enabled: true, maxProjectUsd: 0.3 };
  x.kernel.media.adapters.register({
    id: "cost-media",
    capabilities: {
      kinds: ["image"],
      operations: ["generate"],
      cancellation: false,
      recovery: false,
    },
    submit: async () => ({
      status: "completed",
      outputs: [
        {
          type: "image",
          base64: Buffer.from("actual-adapter-payload").toString("base64"),
          mime: "image/png",
        },
      ],
    }),
  });
  x.config.routes.image.mediaAdapterId = "cost-media";
  try {
    const input = {
      projectId: x.project.id,
      routeId: "image",
      kind: "image" as const,
      prompt: "render",
      idempotencyKey: "cost-idempotent",
    };
    const job = x.kernel.media.create(input);
    assert.equal(x.kernel.media.create(input).id, job.id);
    assert.throws(
      () => x.kernel.media.create({ ...input, idempotencyKey: "second" }),
      /budget exhausted/,
    );
    assert.equal(x.kernel.costs.entries().length, 1);
  } finally {
    await x.close();
  }
});

test("embedding work inside a run inherits its financial scope and settles actual input usage", async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ embedding: [1, 0, 0.5] }],
        usage: { prompt_tokens: 20, total_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const x = await setup();
  x.config.routes.text.pricing = pricing;
  x.config.routes.embedding = {
    ...x.config.routes.text,
    kind: "embedding",
    adapter: "openai-embeddings",
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    pricing,
  };
  x.config.defaultRoutes.embedding = "embedding";
  x.config.budgets = { enabled: true, maxRunUsd: 1 };
  try {
    x.kernel.memory.put({
      projectId: x.project.id,
      content: "remembered project preference",
    });
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "project preference" });
    await collect(x.client, r.runId);
    const entries = x.kernel.costs.entries({ runId: r.runId });
    const embedding = entries.find((e) => e.purpose === "embedding");
    assert.ok(embedding);
    assert.equal(embedding.sessionId, s.id);
    assert.equal(embedding.chargedMicros, 40);
  } finally {
    await x.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("automatic memory extraction is charged to the same run with its own purpose", async () => {
  const x = await setup(
    (_body, index) =>
      index === 0
        ? { text: "I will remember your preference" }
        : { text: '{"memories":[]}' },
    { memory: { autoExtract: true } },
  );
  x.config.routes.text.pricing = pricing;
  x.config.budgets = { enabled: true, maxRunUsd: 1 };
  try {
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "remember this preference" });
    await collect(x.client, r.runId);
    const entries = x.kernel.costs.entries({ runId: r.runId });
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.purpose === "memory-extraction"));
    assert.equal(x.kernel.costs.summary({ runId: r.runId }).chargedMicros, 136);
  } finally {
    await x.close();
  }
});

test("media adapter billing settles the job reservation and keeps the configured price snapshot", async () => {
  const x = await setup();
  x.config.routes.image = {
    ...x.config.routes.text,
    kind: "image",
    adapter: "image-json",
    pricing: { ...pricing, maxRequestUsd: 0.2 },
    mediaAdapterId: "billed-media",
  };
  x.config.budgets = { enabled: true, maxProjectUsd: 1 };
  x.kernel.media.adapters.register({
    id: "billed-media",
    capabilities: {
      kinds: ["image"],
      operations: ["generate"],
      cancellation: false,
      recovery: false,
    },
    submit: async () => ({
      status: "completed",
      billing: { actualUsd: 0.05, reference: "vendor-test-charge" },
      outputs: [
        {
          type: "image",
          base64: Buffer.from("adapter-bytes").toString("base64"),
          mime: "image/png",
        },
      ],
    }),
  });
  try {
    const job = x.kernel.media.create({
      projectId: x.project.id,
      routeId: "image",
      kind: "image",
      prompt: "bill",
      idempotencyKey: "billed",
    });
    await until(() =>
      x.kernel.store.job(job.id).status === "completed" ? true : undefined,
    );
    const entry = x.kernel.costs.entries()[0];
    assert.equal(entry.status, "settled");
    assert.equal(entry.chargedMicros, 50000);
    assert.equal(entry.pricing?.maxRequestUsd, 0.2);
  } finally {
    await x.close();
  }
});

test("run, session, project, UTC-day and total ceilings account for outstanding reservations", async () => {
  for (const limit of [
    "maxRunUsd",
    "maxSessionUsd",
    "maxProjectUsd",
    "maxDayUsd",
    "maxTotalUsd",
  ]) {
    const x = await setup();
    try {
      const s = await x.session("code"),
        r = {
          id: "run_financial_test",
          sessionId: s.id,
          status: "completed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      x.kernel.store.put("runs", r);
      x.config.budgets = { enabled: true, [limit]: 0.1 };
      const route = { ...x.config.routes.text, pricing };
      const scope = {
        runId: r.id,
        sessionId: s.id,
        projectId: x.project.id,
        purpose: "all-limits",
      };
      x.kernel.costs.reserve("text", route, scope, 60000);
      assert.throws(
        () => x.kernel.costs.reserve("text", route, scope, 60000),
        /budget exhausted/,
        limit,
      );
      assert.equal(x.kernel.costs.summary(scope).heldMicros, 60000);
    } finally {
      await x.close();
    }
  }
});

test("cancelled model streams retain reservations instead of inventing zero-cost success", async () => {
  const x = await setup(() => ({ text: "late result", delayMs: 5000 }));
  x.config.routes.text.pricing = pricing;
  x.config.budgets = { enabled: true, maxRunUsd: 1 };
  try {
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "cancel" });
    await until(() => (x.wire.requests.length ? true : undefined));
    x.kernel.cancel(r.runId);
    await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "cancelled");
    const entry = await until(() => {
      const e = x.kernel.costs.entries({ runId: r.runId })[0];
      return e?.status === "unknown" ? e : undefined;
    });
    assert.equal(entry.chargedMicros, undefined);
    assert.ok(entry.reservedMicros > 0);
  } finally {
    await x.close();
  }
});

test("missing credentials release a provably unsent reservation and settlement overruns preserve the actual charge", async () => {
  const x = await setup();
  x.config.routes.text.pricing = pricing;
  x.config.routes.text.apiKeyEnv = "FOUNDATION_TEST_UNSET_CREDENTIAL";
  try {
    const s = await x.session("code");
    await assert.rejects(
      () => x.client.submit(s.id, { text: "credentials" }),
      /Missing environment/,
    );
    assert.equal(x.kernel.costs.entries().length, 0);
    await assert.rejects(
      () =>
        new RouteRouter(x.config, undefined, undefined, undefined, {
          ledger: x.kernel.costs,
          scope: { projectId: x.project.id, purpose: "missing-credentials" },
        }).complete({ routeId: "text", messages: [], tools: [] }),
      /Missing environment/,
    );
    assert.equal(x.wire.requests.length, 0);
    assert.equal(x.kernel.costs.entries()[0].status, "void");
    x.config.budgets = { enabled: true, maxTotalUsd: 1 };
    const entry = x.kernel.costs.reserve(
      "text",
      x.config.routes.text,
      { purpose: "overrun" },
      10,
    );
    assert.throws(
      () =>
        x.kernel.costs.settleUsage(entry.id, x.config.routes.text, {
          reported: true,
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110,
        }),
      /exceeded/,
    );
    assert.equal(
      x.kernel.costs.entries().find((e) => e.id === entry.id)?.chargedMicros,
      240,
    );
  } finally {
    await x.close();
  }
});

test("hierarchical compaction model calls are charged to the originating run", async () => {
  const x = await setup((body) => ({
    text:
      JSON.stringify(body.messages?.[0]?.content).includes(
        "Summarize untrusted",
      ) ||
      JSON.stringify(body.messages?.[0]?.content).includes(
        "Consolidate continuation",
      )
        ? "The user is developing the original project. Preserve the pending task."
        : "continued",
  }));
  x.config.routes.text.contextWindow = 32000;
  x.config.routes.text.maxOutputTokens = 256;
  x.config.routes.text.pricing = pricing;
  x.config.budgets = { enabled: true, maxRunUsd: 10 };
  try {
    const s = await x.session("code");
    x.kernel.store.appendTranscript(s.id, {
      id: "historical-user",
      runId: "history",
      message: {
        role: "user",
        content: "history source data ".repeat(6000),
        timestamp: Date.now() - 1000,
      },
    });
    const r = await x.client.submit(s.id, {
      text: "continue the original project",
    });
    await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const entries = x.kernel.costs.entries({ runId: r.runId });
    assert.ok(entries.some((e) => e.purpose === "compaction"));
    assert.ok(entries.some((e) => e.purpose === "agent"));
    assert.equal(entries.length, x.wire.requests.length);
    assert.ok(entries.every((e) => e.status === "settled"));
  } finally {
    await x.close();
  }
});
