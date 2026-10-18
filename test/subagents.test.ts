import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setup, collect, until } from "./support/wire-server.js";

const toolNames = (body: any) =>
  (body.tools || []).map((t: any) => t.function.name);

test("parallel sub-agents get fresh context, use tools without deadlock and report back", async () => {
  let inFlight = 0,
    peak = 0;
  const x = await setup(
    async (body) => {
      const all = JSON.stringify(body.messages);
      if (all.includes("PARENT TASK"))
        return all.includes('"role":"tool"')
          ? { text: "merged both answers" }
          : {
              calls: [
                {
                  name: "agent_delegate",
                  args: { description: "a", prompt: "CHILD-A write a file" },
                },
                {
                  name: "agent_delegate",
                  args: { description: "b", prompt: "CHILD-B just answer" },
                },
              ],
            };
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      if (all.includes("CHILD-A"))
        return all.includes('"role":"tool"')
          ? { text: "result from A" }
          : {
              calls: [
                {
                  name: "file_write",
                  args: { path: "child-a.txt", content: "from child" },
                },
              ],
            };
      return { text: "result from B" };
    },
    // One tool slot: a delegate holding it would starve child A's file_write.
    { limits: { maxConcurrentTools: 1 } },
  );
  try {
    const s = await x.session("code");
    const r = await x.client.submit(s.id, { text: "PARENT TASK" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.equal(peak, 2, "both sub-agents were in flight together");
    const parentRequests = x.wire.requests.filter((q) =>
      JSON.stringify(q.body.messages).includes("PARENT TASK"),
    );
    assert.ok(toolNames(parentRequests[0].body).includes("agent_delegate"));
    const results = JSON.stringify(parentRequests[1].body.messages);
    assert.match(results, /result from A/);
    assert.match(results, /result from B/);
    const childRequests = x.wire.requests.filter(
      (q) => !JSON.stringify(q.body.messages).includes("PARENT TASK"),
    );
    assert.ok(childRequests.length >= 3);
    for (const q of childRequests)
      assert.ok(!toolNames(q.body).includes("agent_delegate"));
    assert.equal(
      await readFile(
        path.join(x.config.workspaceRoots[0], "child-a.txt"),
        "utf8",
      ),
      "from child",
    );
    const started = events.filter((e) => e.type === "subagent.started");
    assert.equal(started.length, 2);
    for (const e of started) {
      const child = x.kernel.store.session(String(e.data.sessionId));
      assert.equal(child.parentSessionId, s.id);
      assert.equal(child.mode, "code");
      assert.equal(child.routeId, x.kernel.store.session(s.id).routeId);
    }
    assert.equal(
      events.filter(
        (e) => e.type === "subagent.completed" && e.data.status === "completed",
      ).length,
      2,
    );
  } finally {
    await x.close();
  }
});

test("sub-agents cannot switch to a more permissive mode", async () => {
  const x = await setup((body) =>
    JSON.stringify(body.messages).includes('"role":"tool"')
      ? { text: "reported" }
      : {
          calls: [
            {
              name: "agent_delegate",
              args: {
                description: "escalate",
                prompt: "run commands",
                agentId: "coder",
              },
            },
          ],
        },
  );
  try {
    x.kernel.agents.put({
      id: "coder",
      name: "Coder",
      instructions: "code",
      mode: "code",
    });
    const s = await x.session("chat");
    const r = await x.client.submit(s.id, { text: "please" });
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.match(
      JSON.stringify(x.wire.requests[1].body.messages),
      /sub-agents must use the parent's mode \(chat\)/,
    );
    assert.equal(
      x.kernel.store
        .list<any>("sessions")
        .filter((item) => item.parentSessionId).length,
      0,
    );
  } finally {
    await x.close();
  }
});

test("cancelling the parent cancels the running sub-agent", async () => {
  const x = await setup((body) =>
    JSON.stringify(body.messages).includes("PARENT")
      ? {
          calls: [
            {
              name: "agent_delegate",
              args: { description: "slow", prompt: "CHILD slow work" },
            },
          ],
        }
      : { text: "too late", delayMs: 10_000 },
  );
  try {
    const s = await x.session("chat");
    const r = await x.client.submit(s.id, { text: "PARENT" });
    const started = await until(() =>
      x.kernel.store
        .replay(r.runId)
        .find((e: any) => e.type === "subagent.started"),
    );
    x.kernel.cancel(r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "cancelled");
    const childRunId = String((started as any).data.runId);
    const child = await x.kernel.wait(childRunId);
    assert.equal(child.status, "cancelled");
  } finally {
    await x.close();
  }
});

// Tool results are JSON text inside the message, so their quotes arrive escaped.
const childRunIdFrom = (body: any) =>
  /runId\\?":\\?"(run_[0-9a-f-]+)/.exec(JSON.stringify(body.messages))?.[1];

test("background sub-agents return immediately and are collected with agent_result", async () => {
  const x = await setup(async (body) => {
    const all = JSON.stringify(body.messages);
    if (!all.includes("PARENT"))
      return { text: "background answer", delayMs: 300 };
    if (all.includes("background answer")) return { text: "parent finished" };
    const runId = childRunIdFrom(body);
    return runId
      ? { calls: [{ name: "agent_result", args: { runId, waitMs: 10000 } }] }
      : {
          calls: [
            {
              name: "agent_delegate",
              args: { description: "bg", prompt: "CHILD bg", background: true },
            },
          ],
        };
  });
  try {
    const s = await x.session(),
      r = await x.client.submit(s.id, { text: "PARENT" }),
      events = await collect(x.client, r.runId);
    const finished = await x.kernel.wait(r.runId);
    assert.equal(finished.status, "completed", finished.error);
    const settled = events
      .filter((e) => e.type === "tool.settled")
      .map((e) => (e.data.result as any).details);
    assert.equal(settled[0].status, "running");
    assert.equal(settled[0].background, true);
    assert.equal(settled[1].status, "completed");
    assert.equal(settled[1].result, "background answer");
    const other = await x.session();
    const foreign = await x.kernel.store
      .list<any>("runs")
      .find((run: any) => run.id === settled[0].runId);
    assert.ok(foreign);
    const tools = await import("../src/tools/index.js");
    const otherTools = await tools.makeTools({
      kernel: x.kernel,
      runId: r.runId,
      session: x.kernel.store.session(other.id),
      routeId: x.kernel.store.session(other.id).routeId,
    });
    await assert.rejects(
      otherTools
        .find((t) => t.name === "agent_result")!
        .execute("c", { runId: settled[0].runId }),
      /not a sub-agent of this session/,
    );
  } finally {
    await x.close();
  }
});

test("cancelling the parent run also cancels its background sub-agents", async () => {
  const x = await setup((body) => {
    const all = JSON.stringify(body.messages);
    if (!all.includes("PARENT")) return { text: "slow", delayMs: 10000 };
    return childRunIdFrom(body)
      ? { text: "waiting", delayMs: 10000 }
      : {
          calls: [
            {
              name: "agent_delegate",
              args: { description: "bg", prompt: "CHILD", background: true },
            },
          ],
        };
  });
  try {
    const s = await x.session(),
      r = await x.client.submit(s.id, { text: "PARENT" });
    const started: any = await until(() =>
      x.kernel.store.replay(r.runId).find((e) => e.type === "subagent.started"),
    );
    await until(() => x.wire.requests.length >= 3);
    x.kernel.cancel(r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "cancelled");
    assert.equal((await x.kernel.wait(started.data.runId)).status, "cancelled");
  } finally {
    await x.close();
  }
});

test("maxAgentDepth allows nested delegation up to the limit", async () => {
  const x = await setup(
    (body) => {
      const all = JSON.stringify(body.messages);
      const level = all.includes("LEVEL2") ? 2 : all.includes("LEVEL1") ? 1 : 0;
      if (all.includes('"role":"tool"')) return { text: `done at ${level}` };
      return level < 2 && toolNames(body).includes("agent_delegate")
        ? {
            calls: [
              {
                name: "agent_delegate",
                args: { description: "nest", prompt: `LEVEL${level + 1}` },
              },
            ],
          }
        : { text: `leaf at ${level}` };
    },
    { limits: { maxAgentDepth: 2 } },
  );
  try {
    const s = await x.session(),
      r = await x.client.submit(s.id, { text: "TOP" });
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const sessions = x.kernel.store.list<any>("sessions");
    assert.deepEqual(
      sessions.map((item) => item.delegationDepth || 0).sort(),
      [0, 1, 2],
    );
    const leaf = x.wire.requests.find((q) =>
      JSON.stringify(q.body.messages).includes("LEVEL2"),
    )!;
    assert.ok(!toolNames(leaf.body).includes("agent_delegate"));
    assert.ok(!toolNames(leaf.body).includes("agent_result"));
  } finally {
    await x.close();
  }
});
