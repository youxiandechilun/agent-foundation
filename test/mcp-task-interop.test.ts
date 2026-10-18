import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { MCPClient } from "../src/extensions/mcp/client.js";
import { MCPTaskReceiver } from "../src/extensions/mcp/tasks/receiver.js";
import { MCPManager } from "../src/extensions/mcp/manager.js";
import { setup, until, collect } from "./support/wire-server.js";
const modernFile = fileURLToPath(
    new URL("./support/modern-task-mcp.mjs", import.meta.url),
  ),
  clientFile = fileURLToPath(
    new URL("./support/client-task-mcp.mjs", import.meta.url),
  );
const extension = "io.modelcontextprotocol/tasks";
async function peer(file: string, options: any = {}, kind = "elicitation") {
  const root = await mkdtemp(path.join(tmpdir(), "task-interop-")),
    client = new MCPClient({
      transport: "stdio",
      command: process.execPath,
      args: [file, root, kind],
      protocol: "auto",
      timeoutMs: 3000,
      ...options,
    });
  await client.connect();
  await client.listTools();
  return { root, client };
}
async function requests(root: string, file: string) {
  return (await readFile(path.join(root, file), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
}
function install(
  x: Awaited<ReturnType<typeof setup>>,
  modern: boolean,
  features: any = {},
  kind = "elicitation",
) {
  return x.kernel.mcp.install({
    id: "peer",
    name: "Task interoperability",
    transport: "stdio",
    command: process.execPath,
    args: [modern ? modernFile : clientFile, x.project.root, kind],
    timeoutMs: 5000,
    clientFeatures: {
      elicitation: true,
      ...(modern ? { taskExtension: true } : { tasks: { elicitation: true } }),
      ...features,
    },
  });
}
for (const kind of ["elicitation", "sampling"])
  test(`MCP client receives a real asynchronous ${kind} task with durable state and deferred result`, async () => {
    const x = await setup((_body, index) =>
      index === 0
        ? { calls: [{ name: "mcp_peer_work", args: {} }] }
        : {
            text:
              kind === "sampling" && index === 1
                ? "actual async client model answer"
                : "finished",
          },
    );
    try {
      install(
        x,
        false,
        {
          tasks: { [kind]: true },
          ...(kind === "sampling"
            ? { sampling: { routeId: "text", maxTokens: 100 } }
            : {}),
        },
        kind,
      );
      await x.kernel.mcp.connect("peer");
      const s = await x.session("code"),
        run = await x.client.submit(s.id, { text: "client task" });
      const pending: any = await until(() =>
        x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
      );
      const record = await until(() => x.kernel.mcp.receivedTasks("peer")[0]);
      assert.equal(record.origin.runId, run.runId);
      assert.equal(record.status, "input_required");
      await x.client.resolveMCPInteraction(
        pending.id,
        "accept",
        kind === "elicitation"
          ? { value: "actual client task bytes" }
          : undefined,
      );
      await collect(x.client, run.runId);
      const tasks = (await x.client.mcpClientTasks("peer")).tasks;
      assert.equal(tasks[0].status, "completed");
      assert.equal(
        await readFile(
          path.join(x.project.root, "client-task-effect.txt"),
          "utf8",
        ),
        kind === "elicitation"
          ? "actual client task bytes"
          : "actual async client model answer",
      );
      const logs = await requests(x.project.root, "client-task-requests.jsonl"),
        initial = logs.find((m) => m.method === "initialize");
      assert.ok(initial.params.capabilities.tasks.requests[kind]);
      const values = JSON.parse(
        await readFile(
          path.join(x.project.root, "client-task-values.json"),
          "utf8",
        ),
      );
      assert.equal(
        values[0].output.result._meta["io.modelcontextprotocol/related-task"]
          .taskId,
        tasks[0].taskId,
      );
      if (kind === "sampling")
        assert.equal(
          x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
            .length,
          1,
        );
    } finally {
      await x.close();
    }
  });
test("MCP client tasks require explicit capabilities and matching enabled input handlers", async () => {
  const x = await peer(clientFile, {
    handlers: {
      "elicitation/create": async () => ({
        action: "accept",
        content: { value: "forbidden" },
      }),
    },
  });
  try {
    const result = await x.client.callTool({ name: "work", arguments: {} });
    assert.equal(result.isError, true);
    await assert.rejects(
      readFile(path.join(x.root, "client-task-effect.txt")),
      /ENOENT/,
    );
    const log = await requests(x.root, "client-task-requests.jsonl");
    assert.equal(
      log.find((m) => m.method === "initialize").params.capabilities.tasks,
      undefined,
    );
  } finally {
    await x.client.close();
  }
});
test("MCP received task cancellation aborts consent, stays terminal and creates no file effect", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "cancel" } }] }
      : { text: "done" },
  );
  try {
    install(x, false);
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "cancel client task" });
    await collect(x.client, run.runId);
    const [task] = x.kernel.mcp.receivedTasks("peer");
    assert.equal(task.status, "cancelled");
    assert.equal(x.kernel.mcp.interactions.list()[0].status, "cancelled");
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(x.project.root, "client-task-terminal-cancel.json"),
          "utf8",
        ),
      ).error.code,
      -32602,
    );
    await assert.rejects(
      readFile(path.join(x.project.root, "client-task-effect.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
test("MCP received task TTL cancels pending input and expired handles cannot retrieve a result", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { ttl: 60 } }] }
      : { text: "done" },
  );
  try {
    install(x, false);
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "expire client task" });
    await collect(x.client, run.runId);
    assert.equal(x.kernel.mcp.receivedTasks("peer")[0].status, "cancelled");
    const values = JSON.parse(
      await readFile(
        path.join(x.project.root, "client-task-values.json"),
        "utf8",
      ),
    );
    assert.equal(values[0].output.error.code, -32602);
    assert.equal(x.kernel.mcp.interactions.list()[0].status, "cancelled");
    await assert.rejects(
      readFile(path.join(x.project.root, "client-task-effect.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
test("MCP client tasks cannot outlive an originating tool call or charge after its run has ended", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "orphan" } }] }
      : { text: "done" },
  );
  try {
    install(x, false);
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "orphan client task" });
    await collect(x.client, run.runId);
    const record = await until(
      () => x.kernel.mcp.receivedTasks("peer")[0]?.status === "cancelled",
    );
    assert.ok(record);
    const outcome: any = await until(() =>
      readFile(path.join(x.project.root, "orphan-client-task.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined),
    );
    assert.equal(outcome.result.status, "cancelled");
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 0);
  } finally {
    await x.close();
  }
});
test("MCP received task pagination uses scoped opaque cursors and preserves every actual result", async () => {
  const effects: any[] = [],
    x = await peer(clientFile, {
      receiverTasks: { elicitation: true, pageSize: 1 },
      handlers: {
        "elicitation/create": async () => {
          const value = "answer-" + effects.length;
          effects.push(value);
          return { action: "accept", content: { value } };
        },
      },
    });
  try {
    await x.client.callTool({
      name: "work",
      arguments: { scenario: "pagination" },
    });
    const result = JSON.parse(
      await readFile(path.join(x.root, "client-task-pages.json"), "utf8"),
    );
    assert.equal(result.pages.length, 3);
    assert.equal(
      new Set(
        result.pages.flatMap((p: any) => p.tasks.map((t: any) => t.taskId)),
      ).size,
      3,
    );
    assert.equal(result.bad.error.code, -32602);
    assert.equal(
      JSON.parse(
        await readFile(path.join(x.root, "client-task-values.json"), "utf8"),
      ).length,
      3,
    );
    assert.equal(effects.length, 3);
  } finally {
    await x.client.close();
  }
});
test("MCP received task handles from another connection never expose private state", async () => {
  let started = false;
  const first = await peer(clientFile, {
    receiverTasks: { elicitation: true },
    handlers: {
      "elicitation/create": async (_p: any, context: any) => {
        started = true;
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return {};
      },
    },
  });
  const second = new MCPClient({
    transport: "stdio",
    command: process.execPath,
    args: [clientFile, first.root, "elicitation"],
    timeoutMs: 3000,
    receiverTasks: { elicitation: true },
    handlers: { "elicitation/create": async () => ({}) },
  });
  try {
    const controller = new AbortController(),
      original = first.client.callTool(
        { name: "work", arguments: {} },
        { signal: controller.signal },
      );
    void original.catch(() => undefined);
    await until(() => started);
    const ids: any = await until(() =>
      readFile(path.join(first.root, "received-client-task-ids.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined),
    );
    await second.connect();
    await second.callTool({
      name: "work",
      arguments: { scenario: "inspect", taskId: ids[0] },
    });
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(first.root, "foreign-client-task.json"),
          "utf8",
        ),
      ).error.code,
      -32602,
    );
    controller.abort();
    await assert.rejects(original, /cancelled/);
  } finally {
    await first.client.close();
    await second.close();
  }
});
test("MCP receiver persists interrupted tasks on shutdown and startup never resumes model work", async () => {
  const x = await setup();
  try {
    x.kernel.store.put("mcp-client-tasks", {
      id: "interrupted",
      taskId: "interrupted",
      serverId: "peer",
      status: "working",
      createdAt: new Date().toISOString(),
    });
    const manager = new MCPManager(x.kernel.store, x.config);
    assert.equal(
      x.kernel.store.get<any>("mcp-client-tasks", "interrupted").status,
      "failed",
    );
    assert.equal(x.wire.requests.length, 0);
    await manager.close();
  } finally {
    await x.close();
  }
});
test("modern MCP task extension polls and submits actual user input before returning real server output", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "input" } }] }
      : { text: "done" },
  );
  try {
    install(x, true);
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "modern task" });
    const pending: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    assert.equal(pending.origin.runId, run.runId);
    await x.client.resolveMCPInteraction(pending.id, "accept", {
      value: "real modern task bytes",
    });
    await collect(x.client, run.runId);
    const [task] = x.kernel.mcp.tasks("peer");
    assert.equal(task.protocol, "modern");
    assert.equal(task.status, "completed");
    assert.equal(
      await readFile(
        path.join(x.project.root, "modern-task-effect.txt"),
        "utf8",
      ),
      "real modern task bytes",
    );
    assert.equal(
      (await x.kernel.mcp.task("peer", task.id, "result")).content[0].text,
      "real modern task bytes",
    );
    const logs = await requests(x.project.root, "modern-task-requests.jsonl");
    assert.ok(
      logs[0].params._meta["io.modelcontextprotocol/clientCapabilities"]
        .extensions[extension],
    );
    assert.ok(logs.some((m) => m.method === "tasks/update"));
    assert.ok(
      !logs.some((m) =>
        ["tasks/result", "tasks/list", "initialize"].includes(m.method),
      ),
    );
  } finally {
    await x.close();
  }
});
test("modern MCP task sampling preserves tool results, real file bytes and the originating cost scope", async () => {
  const x = await setup((body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "sampling" } }] }
      : index === 1
        ? {
            calls: [
              {
                name: body.tools[0].function.name,
                args: { value: "modern sampled actual bytes" },
              },
            ],
          }
        : { text: "modern sampling followup" },
  );
  try {
    install(x, true, {
      sampling: { routeId: "text", tools: true, maxTokens: 100 },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sampling task" });
    for (let i = 0; i < 2; i++) {
      const pending: any = await until(() =>
        x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
      );
      await x.client.resolveMCPInteraction(pending.id, "accept");
    }
    await collect(x.client, run.runId);
    assert.equal(
      await readFile(
        path.join(x.project.root, "modern-sampling-effect.txt"),
        "utf8",
      ),
      "modern sampled actual bytes",
    );
    assert.equal(
      x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
        .length,
      2,
    );
    assert.equal(x.kernel.mcp.tasks("peer")[0].status, "completed");
  } finally {
    await x.close();
  }
});
test("modern MCP tasks require negotiated extension support and may still return an immediate result", async () => {
  const x = await peer(modernFile, { taskExtension: false });
  try {
    assert.equal(
      (
        await x.client.callTool({
          name: "work",
          arguments: { scenario: "plain" },
        })
      ).content[0].text,
      "immediate result",
    );
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: { scenario: "input" } }),
      /unnegotiated/,
    );
  } finally {
    await x.client.close();
  }
});
test("modern task input deduplication tolerates eventually consistent acknowledgement without repeating a prompt", async () => {
  let prompts = 0;
  const x = await peer(modernFile, {
    taskExtension: true,
    handlers: {
      "elicitation/create": async () => {
        prompts++;
        return { action: "accept", content: { value: "deduplicated" } };
      },
    },
  });
  try {
    await x.client.callTool({
      name: "work",
      arguments: { scenario: "duplicate" },
    });
    assert.equal(prompts, 1);
    const log = await requests(x.root, "modern-task-requests.jsonl");
    assert.equal(log.filter((m) => m.method === "tasks/update").length, 1);
  } finally {
    await x.client.close();
  }
});
test("modern task input keys cannot be reused for different payloads before showing another prompt", async () => {
  let prompts = 0;
  const x = await peer(modernFile, {
    taskExtension: true,
    maxInputRounds: 1,
    handlers: {
      "elicitation/create": async () => {
        prompts++;
        return { action: "accept", content: { value: "one" } };
      },
    },
  });
  try {
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: { scenario: "reused" } }),
      /reused an input key/,
    );
    assert.equal(prompts, 1);
  } finally {
    await x.client.close();
  }
});
test("modern task cancellation acknowledges intent while keeping uncertain remote effects distinct from cancellation", async () => {
  const events: any[] = [],
    x = await peer(modernFile, {
      taskExtension: true,
      onTask: (e: any) => events.push(e),
    }),
    controller = new AbortController();
  try {
    const pending = x.client.callTool(
      { name: "work", arguments: { scenario: "slow" } },
      { signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await until(() => events.find((e) => e.kind === "created"));
    controller.abort();
    await assert.rejects(pending, /cancel|ended/i);
    assert.equal(events.at(-1).kind, "unknown");
    const id = events[0].task.taskId;
    const current = await x.client.taskGet(id);
    assert.ok(["working", "cancelled"].includes(current.status));
    await until(
      async () =>
        (await x.client.taskGet(id)).status === "cancelled" || undefined,
    );
    assert.ok(
      (await requests(x.root, "modern-task-requests.jsonl")).some(
        (m) => m.method === "tasks/cancel",
      ),
    );
  } finally {
    await x.client.close();
  }
});
test("modern task TTL bounds polling and records an uncertain outcome without replaying tools", async () => {
  const events: any[] = [],
    x = await peer(modernFile, {
      taskExtension: true,
      onTask: (e: any) => events.push(e),
    });
  try {
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: { scenario: "ttl" } }),
      /TTL|timeout|aborted/i,
    );
    assert.ok(events.some((e) => e.kind === "unknown"));
    const log = await requests(x.root, "modern-task-requests.jsonl");
    assert.equal(log.filter((m) => m.method === "tools/call").length, 1);
  } finally {
    await x.client.close();
  }
});
test("modern task protocol errors, tool errors and terminal seed states keep their distinct semantics", async () => {
  const events: any[] = [],
    x = await peer(modernFile, {
      taskExtension: true,
      onTask: (e: any) => events.push(e),
    });
  try {
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: { scenario: "failed" } }),
      /Actual task protocol error/,
    );
    assert.equal(events.at(-1).task.status, "failed");
    assert.equal(events.at(-1).kind, "updated");
    assert.equal(
      (
        await x.client.callTool({
          name: "work",
          arguments: { scenario: "tool-error" },
        })
      ).isError,
      true,
    );
    assert.equal(events.at(-1).task.status, "completed");
    assert.equal(
      (
        await x.client.callTool({
          name: "work",
          arguments: { scenario: "seed" },
        })
      ).content[0].text,
      "actual final result",
    );
  } finally {
    await x.client.close();
  }
});
for (const scenario of ["wrong-id", "bad-shape"])
  test(`modern task rejects ${scenario} polling results before accepting success`, async () => {
    const x = await peer(modernFile, { taskExtension: true });
    try {
      await assert.rejects(
        x.client.callTool({ name: "work", arguments: { scenario } }),
        /task ID mismatch|missing its result/,
      );
    } finally {
      await x.client.close();
    }
  });
test("modern terminal task snapshots cannot be changed back to a working task", async () => {
  const events: any[] = [],
    x = await peer(modernFile, {
      taskExtension: true,
      onTask: (e: any) => events.push(e),
    });
  try {
    await x.client.callTool({
      name: "work",
      arguments: { scenario: "terminal-change" },
    });
    await assert.rejects(
      x.client.taskGet(events[0].task.taskId),
      /terminal state changed/,
    );
  } finally {
    await x.client.close();
  }
});
test("modern task subscriptions require acknowledgement and reject notifications for unrequested tasks", async () => {
  const x = await peer(modernFile, { taskExtension: true });
  try {
    const task = await x.client.request("tools/call", {
      name: "work",
      arguments: { scenario: "slow" },
    });
    const stream = x.client.listenNotifications({ taskIds: [task.taskId] });
    assert.deepEqual(await stream.ready, { taskIds: [task.taskId] });
    await until(() =>
      x.client.notifications().find((n) => n.method === "notifications/tasks"),
    );
    assert.equal(
      x.client.notifications().filter((n) => n.method === "notifications/tasks")
        .length,
      1,
    );
    assert.ok(
      x.client
        .notifications()
        .some((n) => n.method === "subscriptions/rejected"),
    );
    stream.close();
    await assert.rejects(stream.completion, /cancelled/);
  } finally {
    await x.client.close();
  }
});
test("modern task records preserve remote IDs across disconnect and reject a changed server binding", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "slow" } }] }
      : { text: "done" },
  );
  try {
    install(x, true);
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "persist task" });
    const record: any = await until(() => x.kernel.mcp.tasks("peer")[0]);
    await x.client.request("POST", `/v1/runs/${run.runId}/cancel`);
    await collect(x.client, run.runId);
    await x.kernel.mcp.disconnect("peer");
    const prior: any = x.kernel.mcp.list().find((d) => d.id === "peer");
    delete prior.connected;
    delete prior.protocolVersion;
    delete prior.serverCapabilities;
    delete prior.executionBoundary;
    delete prior.isolationEnforcement;
    delete prior.status;
    delete prior.error;
    prior.args = [modernFile, x.project.root, "different-server"];
    x.kernel.mcp.install(prior);
    await assert.rejects(
      x.kernel.mcp.task("peer", record.id, "get"),
      /different server configuration/,
    );
    assert.equal(x.kernel.mcp.tasks("peer")[0].remoteId, record.remoteId);
  } finally {
    await x.close();
  }
});
test("modern HTTP task requests mirror the task ID in routing headers without legacy task methods", async () => {
  const seen: any[] = [],
    createdAt = new Date().toISOString();
  let origin = "",
    polls = 0;
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const m = JSON.parse(Buffer.concat(parts).toString());
    seen.push({ method: m.method, headers: req.headers, params: m.params });
    let result: any;
    if (m.method === "server/discover")
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { extensions: { [extension]: {} } },
      };
    else if (m.method === "tools/call")
      result = {
        resultType: "task",
        taskId: "task/中文",
        status: "working",
        createdAt,
        lastUpdatedAt: createdAt,
        ttlMs: 5000,
        pollIntervalMs: 10,
      };
    else if (m.method === "tasks/get") {
      polls++;
      result = {
        resultType: "complete",
        taskId: "task/中文",
        status: "completed",
        createdAt,
        lastUpdatedAt: createdAt,
        ttlMs: 5000,
        result: { content: [{ type: "text", text: "actual HTTP result" }] },
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new MCPClient({
    transport: "http",
    url: origin,
    protocol: "modern",
    taskExtension: true,
  });
  try {
    await client.connect();
    assert.equal(
      (await client.callTool({ name: "work", arguments: {} })).content[0].text,
      "actual HTTP result",
    );
    const request = seen.find((r) => r.method === "tasks/get");
    assert.equal(
      request.headers["mcp-name"],
      "=?base64?" + Buffer.from("task/中文").toString("base64") + "?=",
    );
    assert.equal(request.headers["mcp-method"], "tasks/get");
    assert.equal(polls, 1);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("modern task input round limits stop before another model or user handler runs", async () => {
  let samples = 0;
  const x = await peer(modernFile, {
    taskExtension: true,
    maxInputRounds: 1,
    handlers: {
      "sampling/createMessage": async () => {
        samples++;
        return {
          role: "assistant",
          model: "local-controlled-peer",
          stopReason: "toolUse",
          content: {
            type: "tool_use",
            id: "local-call",
            name: "write_remote_file",
            input: { value: "first allowed effect" },
          },
        };
      },
    },
  });
  try {
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: { scenario: "sampling" } }),
      /input round limit/,
    );
    assert.equal(samples, 1);
    assert.equal(
      await readFile(path.join(x.root, "modern-sampling-effect.txt"), "utf8"),
      "first allowed effect",
    );
    assert.equal(
      (await requests(x.root, "modern-task-requests.jsonl")).filter(
        (m) => m.method === "tasks/update",
      ).length,
      1,
    );
  } finally {
    await x.client.close();
  }
});
test("modern task sampling consent cannot override a newly denied capability", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "sampling" } }] }
      : { text: "done" },
  );
  try {
    install(x, true, {
      sampling: { routeId: "text", tools: true, maxTokens: 100 },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "revoke while sampling" });
    const input: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    x.kernel.store.put("policies", {
      id: "deny-sampling",
      effect: "deny",
      capabilities: ["network"],
      projectId: x.project.id,
    });
    await x.client.resolveMCPInteraction(input.id, "accept");
    await collect(x.client, run.runId);
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 0);
    assert.equal(x.kernel.mcp.tasks("peer")[0].status, "unknown");
    await assert.rejects(
      readFile(path.join(x.project.root, "modern-sampling-effect.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
test("received sampling tasks share one originating quota across concurrent client task handles", async () => {
  const x = await setup((_b, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { scenario: "pagination" } }] }
      : { text: "quota-bound answer" },
  );
  try {
    install(
      x,
      false,
      {
        tasks: { sampling: true },
        sampling: { routeId: "text", maxTokens: 100, maxRequestsPerCall: 1 },
      },
      "sampling",
    );
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "quota" });
    const input: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    await x.client.resolveMCPInteraction(input.id, "accept");
    await collect(x.client, run.runId);
    const tasks = x.kernel.mcp.receivedTasks("peer");
    assert.equal(tasks.length, 3);
    assert.equal(tasks.filter((t) => t.status === "completed").length, 1);
    assert.equal(tasks.filter((t) => t.status === "failed").length, 2);
    assert.equal(x.kernel.mcp.interactions.list().length, 1);
    assert.equal(
      x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
        .length,
      1,
    );
  } finally {
    await x.close();
  }
});
test("MCP task receiver fails closed when durable task creation cannot be persisted", () => {
  let ran = false;
  const controller = new AbortController(),
    receiver = new MCPTaskReceiver(
      {
        elicitation: true,
        persist: () => {
          throw Error("disk unavailable");
        },
      },
      async () => {},
      1024,
    );
  try {
    assert.throws(
      () =>
        receiver.create(
          "elicitation/create",
          { task: { ttl: 1000 } },
          {
            requestId: 1,
            method: "tools/call",
            params: {},
            signal: controller.signal,
          },
          async () => {
            ran = true;
            return {};
          },
        ),
      /disk unavailable/,
    );
    assert.equal(ran, false);
  } finally {
    receiver.close();
  }
});
test("modern task update connection loss retains unknown state without repeating input or tool effects", async () => {
  let prompts = 0;
  const events: any[] = [],
    x = await peer(modernFile, {
      taskExtension: true,
      onTask: (event: any) => events.push(event),
      handlers: {
        "elicitation/create": async () => {
          prompts++;
          return { action: "accept", content: { value: "one input" } };
        },
      },
    });
  try {
    await assert.rejects(
      x.client.callTool({
        name: "work",
        arguments: { scenario: "lost-update" },
      }),
      /exited|closed|ended/i,
    );
    assert.equal(prompts, 1);
    assert.ok(events.some((e) => e.kind === "unknown"));
    const log = await requests(x.root, "modern-task-requests.jsonl");
    assert.equal(log.filter((m) => m.method === "tools/call").length, 1);
    assert.equal(log.filter((m) => m.method === "tasks/update").length, 1);
  } finally {
    await x.client.close();
  }
});
test("legacy HTTP peer can create a client task and fetch its deferred result over the notification stream", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "client-task-http-"));
  let stream: http.ServerResponse | undefined,
    operation: http.ServerResponse | undefined,
    operationId: any;
  const seen: any[] = [],
    responses: any[] = [];
  const sse = (res: http.ServerResponse, value: any) =>
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...value })}\n\n`),
    server = http.createServer(async (req, res) => {
      if (req.method === "GET") {
        stream = res;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      const parts = [];
      for await (const p of req) parts.push(p);
      const m = JSON.parse(Buffer.concat(parts).toString());
      seen.push(m);
      const json = (value: any) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "client-task-http",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: value }));
      };
      if (!m.method) {
        responses.push(m);
        res.writeHead(202);
        res.end();
        if (m.id === "create-client-task")
          sse(stream!, {
            id: "fetch-client-task",
            method: "tasks/result",
            params: { taskId: m.result.task.taskId },
          });
        else if (m.id === "fetch-client-task") {
          sse(operation!, {
            id: operationId,
            result: {
              content: [{ type: "text", text: m.result.content.value }],
            },
          });
          operation!.end();
        }
        return;
      }
      if (m.method === "initialize")
        return json({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "Client task HTTP peer", version: "1" },
        });
      if (m.method === "tools/call") {
        operation = res;
        operationId = m.id;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, {
          id: "create-client-task",
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "HTTP task",
            requestedSchema: { type: "object" },
            task: { ttl: 3000 },
          },
        });
        return;
      }
      res.writeHead(202);
      res.end();
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new MCPClient({
    transport: "http",
    protocol: "legacy",
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    receiverTasks: { elicitation: true },
    handlers: {
      "elicitation/create": async (_params, context) => {
        assert.equal((context.localContext as any).label, "real origin");
        await writeFile(
          path.join(root, "http-client-task.txt"),
          "real HTTP client task bytes",
        );
        return {
          action: "accept",
          content: { value: "actual deferred HTTP answer" },
        };
      },
    },
  });
  try {
    await client.connect();
    await until(() => stream);
    const result = await client.callTool(
      { name: "work", arguments: {} },
      { localContext: { label: "real origin" } },
    );
    assert.equal(result.content[0].text, "actual deferred HTTP answer");
    assert.equal(
      await readFile(path.join(root, "http-client-task.txt"), "utf8"),
      "real HTTP client task bytes",
    );
    const created = responses.find((r) => r.id === "create-client-task"),
      finished = responses.find((r) => r.id === "fetch-client-task");
    assert.equal(
      finished.result._meta["io.modelcontextprotocol/related-task"].taskId,
      created.result.task.taskId,
    );
    assert.ok(
      seen.find((m) => m.method === "initialize").params.capabilities.tasks
        .requests.elicitation,
    );
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
for (const scenario of ["seed-invalid", "invalid-tool"])
  test(`modern ${scenario} cannot be counted as a completed validated task`, async () => {
    const events: any[] = [],
      x = await peer(modernFile, {
        taskExtension: true,
        onTask: (event: any) => events.push(event),
      });
    try {
      await assert.rejects(
        x.client.callTool({ name: "work", arguments: { scenario } }),
        /missing its result|Invalid MCP tool result/,
      );
      assert.equal(events.at(-1).kind, "unknown");
      assert.equal(events.at(-1).task.status, "completed");
    } finally {
      await x.client.close();
    }
  });
