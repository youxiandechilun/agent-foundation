import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolScheduler } from "../src/runtime/scheduler.js";
import { setup, collect, until } from "./support/wire-server.js";
import type { ToolDefinition } from "../src/runtime/types.js";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tool = <A>(
  name: string,
  execute: ToolDefinition<A>["execute"],
  parallelSafe = true,
): ToolDefinition<A> => ({
  name,
  description: name,
  parameters: { type: "object" },
  risk: "read",
  capabilities: [],
  scheduling: parallelSafe ? { parallelSafe: true } : undefined,
  execute,
});

test("independent tools actually overlap and all results reach the next model step", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            { name: "parallel_a", args: {} },
            { name: "parallel_b", args: {} },
          ],
        }
      : { text: "done" },
  );
  let active = 0,
    peak = 0,
    started = 0;
  const execute: ToolDefinition["execute"] = async () => {
    active++;
    started++;
    peak = Math.max(peak, active);
    await until(() => (started === 2 ? true : undefined), 2000);
    await pause(40);
    active--;
    return { content: [{ type: "text", text: "actual parallel work" }] };
  };
  x.kernel.toolRegistry.register("parallel", () => [
    tool("parallel_a", execute),
    tool("parallel_b", execute),
  ]);
  try {
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "run both" });
    await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.equal(peak, 2);
    const results = x.wire.requests[1].body.messages.filter(
      (m: any) => m.role === "tool",
    );
    assert.equal(results.length, 2);
  } finally {
    await x.close();
  }
});

test("kernel scheduler enforces shared/exclusive locks, fairness, capacity and cancelled waiters", async () => {
  const s = new ToolScheduler(3);
  const locked = (access: "read" | "write") => ({
    ...tool("locked", async () => ({ content: [] })),
    scheduling: {
      parallelSafe: true,
      resources: () => [{ key: "same-project", access }],
    },
  });
  const a = await s.acquire(locked("read"), {}),
    b = await s.acquire(locked("read"), {});
  let writerStarted = false,
    lateReaderStarted = false;
  const writer = s.acquire(locked("write"), {}).then((r) => {
    writerStarted = true;
    return r;
  });
  const late = s.acquire(locked("read"), {}).then((r) => {
    lateReaderStarted = true;
    return r;
  });
  const c = new AbortController(),
    cancelled = s.acquire(undefined, {}, c.signal);
  c.abort(Error("test cancellation"));
  await assert.rejects(() => cancelled, /test cancellation/);
  a();
  await pause(20);
  assert.equal(writerStarted, false);
  assert.equal(lateReaderStarted, false);
  b();
  const releaseWriter = await writer;
  assert.equal(lateReaderStarted, false);
  releaseWriter();
  const releaseReader = await late;
  releaseReader();
  assert.deepEqual(s.state, { active: 0, queued: 0, limit: 3 });
});

test("undeclared native tools remain exclusive and denied parallel tools never execute", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            { name: "serial_a", args: {} },
            { name: "serial_b", args: {} },
            { name: "denied", args: {} },
          ],
        }
      : { text: "done" },
  );
  let active = 0,
    peak = 0,
    denied = 0;
  const execute: ToolDefinition["execute"] = async () => {
    active++;
    peak = Math.max(peak, active);
    await pause(50);
    active--;
    return { content: [] };
  };
  x.kernel.toolRegistry.register("serial", () => [
    tool("serial_a", execute, false),
    tool("serial_b", execute, false),
    {
      ...tool("denied", async () => {
        denied++;
        return { content: [] };
      }),
      capabilities: ["computer"],
    },
  ]);
  x.config.permissions.computer = "deny";
  try {
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "execute" });
    await collect(x.client, r.runId);
    assert.equal(peak, 1);
    assert.equal(denied, 0);
    assert.equal(
      x.kernel.store
        .list<any>("effects")
        .filter((e) => e.status === "completed").length,
      2,
    );
  } finally {
    await x.close();
  }
});

test("steering stops undispatched parallel work and retains a result for every declared call", async () => {
  const x = await setup(
    (_body, index) =>
      index === 0
        ? {
            calls: [1, 2, 3, 4].map((n) => ({
              name: "steer_parallel",
              args: { n },
            })),
          }
        : { text: "steering followed" },
    { limits: { maxConcurrentTools: 2 } },
  );
  let started = 0,
    sid = "",
    steered = false;
  x.kernel.toolRegistry.register("steering", () => [
    tool("steer_parallel", async (_id, args: { n: number }) => {
      started++;
      await until(() => (started >= 2 ? true : undefined), 2000);
      if (!steered) {
        steered = true;
        await x.client.submit(sid, {
          text: "stop the rest and continue",
          delivery: "steer",
        });
      }
      await pause(60);
      return { content: [{ type: "text", text: String(args.n) }] };
    }),
  ]);
  try {
    const s = await x.session("code");
    sid = s.id;
    const r = await x.client.submit(s.id, { text: "parallel" });
    await collect(x.client, r.runId);
    assert.equal(started, 2);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const effects = x.kernel.store.list<any>("effects");
    assert.equal(effects.filter((e) => e.status === "skipped").length, 2);
    const history = x.kernel.store.transcript(sid).map((m) => m.message);
    assert.equal(history.filter((m) => m.role === "toolResult").length, 4);
  } finally {
    await x.close();
  }
});

test("different sessions share the kernel-wide tool concurrency ceiling", async () => {
  const x = await setup(
    (body) =>
      body.messages.some((m: any) => m.role === "tool")
        ? { text: "done" }
        : { calls: [{ name: "shared_ceiling", args: {} }] },
    { limits: { maxConcurrentTools: 1 } },
  );
  let active = 0,
    peak = 0,
    executed = 0;
  x.kernel.toolRegistry.register("shared-ceiling", () => [
    tool("shared_ceiling", async () => {
      active++;
      executed++;
      peak = Math.max(peak, active);
      await pause(80);
      active--;
      return { content: [] };
    }),
  ]);
  try {
    const a = await x.session("code"),
      b = await x.session("code");
    const runs = await Promise.all([
      x.client.submit(a.id, { text: "one" }),
      x.client.submit(b.id, { text: "two" }),
    ]);
    await Promise.all(runs.map((r) => collect(x.client, r.runId)));
    assert.equal(executed, 2);
    assert.equal(peak, 1);
    assert.equal(x.kernel.scheduler.state.active, 0);
  } finally {
    await x.close();
  }
});
