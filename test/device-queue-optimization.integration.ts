import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.js";
import {
  NodeManager,
  type NodeManagerOptions,
  type NodeTask,
} from "../src/host/nodes.js";

async function fixture(t: TestContext, options: NodeManagerOptions = {}) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "foundation-device-queue-"));
  const store = new Store(root);
  store.put("projects", { id: "p", root });
  const nodes = new NodeManager(store, undefined, options);
  const node = nodes.pair({
    projectId: "p",
    name: "test",
    capabilities: ["read"],
  });
  t.after(async () => {
    nodes.close();
    store.close();
    const target = await realpath(root),
      relative = path.relative(parent, target);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(target, { recursive: true, force: true });
  });
  return { store, nodes, node };
}

test("device claims ignore unrelated history, keep FIFO and never duplicate a running task", async (t) => {
  const { store, nodes, node } = await fixture(t);
  const createdAt = new Date().toISOString(),
    deadline = new Date(Date.now() + 60000).toISOString();
  store.transaction(() => {
    for (let i = 0; i < 1000; i++)
      store.put("node-tasks", {
        id: `old${i}`,
        nodeId: "other",
        capability: "read",
        args: "x".repeat(1000),
        result: "y".repeat(1000),
        status: "completed",
        createdAt,
        deadline,
      });
    for (const id of ["first", "second"])
      store.put("node-tasks", {
        id,
        nodeId: node.id,
        capability: "read",
        args: {},
        status: "queued",
        createdAt,
        deadline,
      });
  });
  const list = store.list.bind(store);
  store.list = (...args) => {
    assert.notEqual(
      args[0],
      "node-tasks",
      "claim/revoke must not deserialize historical task bodies",
    );
    return list(...args);
  };
  assert.equal(nodes.claim(node.id)?.id, "first");
  assert.equal(nodes.claim(node.id), undefined);
  nodes.complete(node.id, "first", { ok: true, result: 1 });
  assert.equal(nodes.claim(node.id)?.id, "second");
  nodes.revoke(node.id);
  assert.equal(store.get<NodeTask>("node-tasks", "second").status, "unknown");
  assert.equal(store.get<NodeTask>("node-tasks", "old0").status, "completed");
  const plan = store
    .prepare(
      "EXPLAIN QUERY PLAN SELECT body FROM e_node_tasks WHERE json_extract(body,'$.nodeId')=? AND json_extract(body,'$.status')='queued' AND json_extract(body,'$.deadline')>? ORDER BY rowid LIMIT 1",
    )
    .all(node.id, createdAt);
  assert.match(JSON.stringify(plan), /node_tasks_claim/);
});

test("device admission bounds pending work and releases capacity after cancellation and completion", async (t) => {
  const { store, nodes, node } = await fixture(t, { maxPendingTasks: 1 });
  const controller = new AbortController();
  const first = nodes.call("p", node.id, "read", {}, 5000, controller.signal);
  await assert.rejects(nodes.call("p", node.id, "read", {}, 5000), /capacity/);
  controller.abort(new Error("test cancelled"));
  await assert.rejects(first, /test cancelled/);
  const pending = nodes.call("p", node.id, "read", {}, 5000);
  const task = nodes.claim(node.id)!;
  nodes.complete(node.id, task.id, { ok: true, result: "event result" });
  assert.equal(await pending, "event result");
  assert.equal(store.get<NodeTask>("node-tasks", task.id).status, "completed");
});

test("device shutdown wakes HTTP-polled calls and pending byte limits reject before writing", async (t) => {
  const { store, nodes, node } = await fixture(t, { maxPendingBytes: 600 });
  await assert.rejects(
    nodes.call("p", node.id, "read", { text: "x".repeat(1000) }),
    /capacity/,
  );
  assert.equal(store.count("node-tasks"), 0);
  const pending = nodes.call("p", node.id, "read", {}, 5000);
  nodes.close();
  await assert.rejects(pending, /closed/);
  assert.equal(store.list<NodeTask>("node-tasks")[0].status, "cancelled");
});

test("device dispatch failures record uncertainty and do not strand an admission slot", async (t) => {
  const { store, nodes, node } = await fixture(t, { maxPendingTasks: 1 });
  const target = nodes as unknown as { dispatch(nodeId: string): void };
  const dispatch = target.dispatch;
  target.dispatch = () => {
    nodes.claim(node.id);
    throw new Error("transport send failed");
  };
  await assert.rejects(
    nodes.call("p", node.id, "read", {}, 5000),
    /transport send failed/,
  );
  assert.equal(store.list<NodeTask>("node-tasks")[0].status, "unknown");
  target.dispatch = dispatch;
  const pending = nodes.call("p", node.id, "read", {}, 5000);
  const task = nodes.claim(node.id)!;
  nodes.complete(node.id, task.id, { ok: true, result: "recovered" });
  assert.equal(await pending, "recovered");
});

test("device retention removes only old confirmed outcomes, retaining unknown and recent completions", async (t) => {
  const { store, nodes, node } = await fixture(t, { retentionDays: 1 });
  // Let the constructor's empty cleanup finish before adding controlled data.
  await nodes.prune();
  const old = new Date(Date.now() - 3 * 86400000).toISOString(),
    recent = new Date().toISOString();
  for (const [id, status, finishedAt] of [
    ["old", "completed", old],
    ["uncertain", "unknown", old],
    ["recent", "completed", recent],
  ] as const) {
    store.put("node-tasks", {
      id,
      nodeId: node.id,
      capability: "read",
      args: {},
      status,
      createdAt: old,
      deadline: old,
      finishedAt,
    });
  }
  assert.equal(await nodes.prune(), 1);
  assert.equal(store.find("node-tasks", "old"), undefined);
  assert.ok(store.find("node-tasks", "uncertain"));
  assert.ok(store.find("node-tasks", "recent"));
});
