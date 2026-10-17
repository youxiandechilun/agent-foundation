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
