import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setup, collect, until } from "./support/wire-server.js";

test("cancellation settles a run blocked in an uncooperative context counter", async () => {
  const x = await setup();
  let entered = false;
  try {
    x.kernel.context.counters.register({
      id: "hanging-counter",
      precision: "estimate",
      count: () => {
        entered = true;
        return new Promise(() => {});
      },
    });
    x.config.routes.text.tokenCounterId = "hanging-counter";
    const session = await x.session();
    const { runId } = await x.client.submit(session.id, {
      text: "cancel during context preparation",
    });
    await until(() => entered || undefined);
    x.kernel.cancel(runId);
    assert.equal((await x.kernel.wait(runId)).status, "cancelled");
    assert.equal(x.wire.requests.length, 0);
    assert.ok(
      x.kernel.store
        .replay(runId)
        .some((e) => e.type === "model-step.completed"),
    );
  } finally {
    await x.close();
  }
});

test("default kernel has no desktop services and registered source tools execute through the shared loop with revocation", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "source_probe", args: {} }] }
      : { text: "verified" },
  );
  try {
    assert.equal("office" in x.kernel, false);
    assert.equal("browser" in x.kernel, false);
    assert.equal("computer" in x.kernel, false);
    assert.deepEqual(x.kernel.toolRegistry.list(), []);
    await writeFile(
      path.join(x.project.root, "registered.txt"),
      "actual registered tool input",
    );
    const unregister = x.kernel.toolRegistry.register(
      "custom-source",
      async () => [
        {
          name: "source_probe",
          description: "read fixture file",
          parameters: { type: "object" },
          risk: "read",
          capabilities: ["files.read"],
          execute: async () => ({
            content: [
              {
                type: "text",
                text: await readFile(
                  path.join(x.project.root, "registered.txt"),
                  "utf8",
                ),
              },
            ],
          }),
        },
      ],
    );
    const s = await x.session("code"),
      resolved = await x.kernel.toolRegistry.resolve({
        kernel: x.kernel,
        runId: "before",
        routeId: "text",
        session: s,
      });
    const { runId } = await x.client.submit(s.id, {
      text: "use the registered tool",
    });
    const events = await collect(x.client, runId);
    assert.match(
      JSON.stringify(
        events.find((e) => e.type === "tool.settled")?.data.result,
      ),
      /actual registered tool input/,
    );
    unregister();
    await assert.rejects(
      resolved[0].execute("revoked", {}),
      /removed or replaced/,
    );
  } finally {
    await x.close();
  }
});
test("cancellation settles an uncooperative tool promptly and records its uncertain effect", async () => {
  const x = await setup(() => ({
    calls: [{ name: "uncooperative", args: {} }],
  }));
  try {
    x.kernel.toolRegistry.register("uncooperative", () => [
      {
        name: "uncooperative",
        description: "uncooperative async host test",
        parameters: { type: "object" },
        risk: "write",
        capabilities: ["files.write"],
        execute: () => new Promise(() => {}),
      },
    ]);
    const s = await x.session("code"),
      { runId } = await x.client.submit(s.id, { text: "run then cancel" });
    await until(
      () =>
        x.kernel.store.replay(runId).some((e) => e.type === "tool.started") ||
        undefined,
    );
    x.kernel.cancel(runId);
    const result = await x.kernel.wait(runId);
    assert.equal(result.status, "cancelled");
    assert.equal(
      x.kernel.store.list<any>("effects").find((e) => e.runId === runId).status,
      "unknown",
    );
  } finally {
    await x.close();
  }
});
test("cancellation also stops a run during tool-factory preparation and settlement hook errors do not strand sessions", async () => {
  const x = await setup(
    undefined,
    {},
    {
      integrations: [
        {
          id: "failing-settlement",
          settled() {
            throw new Error("test hook failure");
          },
        },
      ],
    },
  );
  try {
    const remove = x.kernel.toolRegistry.register(
      "hanging-factory",
      () => new Promise(() => {}),
    );
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "cancel preparation" });
    x.kernel.cancel(runId);
    assert.equal((await x.kernel.wait(runId)).status, "cancelled");
    remove();
    const again = await x.client.submit(s.id, { text: "another task" });
    await collect(x.client, again.runId);
    assert.equal((await x.kernel.wait(again.runId)).status, "completed");
    assert.ok(
      x.kernel.store
        .replay(again.runId)
        .some((e) => e.type === "integration.settlement.failed"),
    );
  } finally {
    await x.close();
  }
});
test("explicit resume applies durable pending input once and never replays unknown effects automatically", async () => {
  const x = await setup();
  try {
    const s = await x.session(),
      time = new Date().toISOString();
    x.kernel.store.put("runs", {
      id: "run_interrupted",
      sessionId: s.id,
      status: "interrupted",
      createdAt: time,
      updatedAt: time,
    });
    x.kernel.store.put("inbox", {
      id: "pending_old",
      runId: "run_interrupted",
      status: "pending",
      delivery: "steer",
      message: {
        role: "user",
        content: "important queued instruction",
        inputId: "pending_old",
        timestamp: 1,
      },
      createdAt: time,
    });
    x.kernel.store.put("effects", {
      id: "old_effect",
      runId: "run_interrupted",
      callId: "old",
      tool: "file_write",
      argsHash: "old",
      status: "unknown",
      createdAt: time,
      updatedAt: time,
    });
    const resumed = await x.kernel.resume("run_interrupted");
    await collect(x.client, resumed.runId);
    const messages = x.kernel.store.transcript(s.id);
    assert.equal(
      messages.filter(
        (m) => m.message.role === "user" && m.message.inputId === "pending_old",
      ).length,
      1,
    );
    assert.equal(
      x.kernel.store.get<any>("inbox", "pending_old").status,
      "applied",
    );
    assert.equal(
      x.kernel.store.get<any>("effects", "old_effect").status,
      "unknown",
    );
    assert.deepEqual(await x.kernel.resume("run_interrupted"), resumed);
    assert.equal(x.kernel.store.transcript(s.id).length, messages.length);
  } finally {
    await x.close();
  }
});
test("a registered model counter receives tool declarations and reports its precision; missing counters fail explicitly", async () => {
  const x = await setup();
  try {
    x.kernel.context.counters.register({
      id: "configured-counter",
      precision: "exact",
      count: (request) => {
        assert.ok(request.tools.length > 0);
        return 345;
      },
    });
    x.config.routes.text.tokenCounterId = "configured-counter";
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "count this" });
    await collect(x.client, runId);
    const state = await x.client.request("GET", `/v1/runs/${runId}/context`);
    assert.equal(state.inputTokens, 345);
    assert.equal(state.precision, "exact");
    assert.equal(state.counter, "configured-counter");
    x.config.routes.text.tokenCounterId = "missing";
    const failed = await x.client.submit(s.id, { text: "must fail" });
    await collect(x.client, failed.runId);
    assert.match(
      (await x.kernel.wait(failed.runId)).error || "",
      /not registered/,
    );
  } finally {
    await x.close();
  }
});
