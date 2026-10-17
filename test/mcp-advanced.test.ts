import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { MCPClient } from "../src/extensions/mcp-client.js";
import {
  decodeSamplingRequest,
  samplingResult,
} from "../src/extensions/mcp-sampling.js";
import { emptyUsage } from "../src/runtime/types.js";
import { setup, until, collect } from "./support/wire-server.js";
const fixture = fileURLToPath(
  new URL("./support/advanced-mcp.mjs", import.meta.url),
);
const serverTool = {
  name: "write",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const samplingInput = {
  messages: [{ role: "user", content: { type: "text", text: "work" } }],
  tools: [serverTool],
  maxTokens: 100,
};
for (const adapter of [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const) {
  test(`MCP tool sampling performs a real server file effect and result continuation over ${adapter}`, async () => {
    const x = await setup((body, index) =>
      index === 0
        ? { calls: [{ name: "mcp_peer_work", args: {} }] }
        : index === 1
          ? {
              text: "Calling server tool",
              calls: [
                {
                  name: body.tools[0].function?.name || body.tools[0].name,
                  args: { value: "actual sampling bytes" },
                },
              ],
            }
          : {
              text: index === 2 ? "server result received" : "agent completed",
            },
    );
    x.config.routes.text.adapter = adapter;
    try {
      x.kernel.mcp.install({
        id: "peer",
        name: "Sampling",
        transport: "stdio",
        command: process.execPath,
        args: [fixture, x.project.root, "sampling", "modern"],
        clientFeatures: {
          sampling: { routeId: "text", tools: true, maxTokens: 100 },
        },
      });
      await x.kernel.mcp.connect("peer");
      const s = await x.session("code"),
        run = await x.client.submit(s.id, {
          text: "PRIVATE host conversation",
        });
      for (let i = 0; i < 2; i++) {
        const pending: any = await until(() =>
          x.kernel.mcp.interactions
            .list("peer")
            .find((r) => r.status === "pending"),
        );
        assert.equal(pending.origin.runId, run.runId);
        await x.client.resolveMCPInteraction(pending.id, "accept");
      }
      await collect(x.client, run.runId);
      assert.equal(
        await readFile(
          path.join(x.project.root, "sampling-effect.txt"),
          "utf8",
        ),
        "actual sampling bytes",
      );
      const one = x.wire.requests[1].body,
        two = x.wire.requests[2].body;
      assert.deepEqual(
        one.tool_choice,
        adapter === "anthropic-messages" ? { type: "any" } : "required",
      );
      assert.deepEqual(
        two.tool_choice,
        adapter === "anthropic-messages" ? { type: "none" } : "none",
      );
      assert.ok(JSON.stringify(two).includes("file was written"));
      assert.ok(!JSON.stringify(two).includes("PRIVATE"));
      assert.equal(
        x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
          .length,
        2,
      );
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(x.project.root, "sampling-reply.json"),
            "utf8",
          ),
        ).content.text,
        "server result received",
      );
    } finally {
      await x.close();
    }
  });
}
test("MCP sampling validates opt-in, schemas, grouped tool history and bounded tool declarations", () => {
  assert.throws(() => decodeSamplingRequest(samplingInput), /not enabled/);
  assert.throws(
    () =>
      decodeSamplingRequest(
        { ...samplingInput, includeContext: "allServers" },
        { tools: true },
      ),
    /Implicit/,
  );
  assert.throws(
    () =>
      decodeSamplingRequest(
        { ...samplingInput, tools: [serverTool, serverTool] },
        { tools: true },
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      decodeSamplingRequest(
        {
          ...samplingInput,
          tools: [
            {
              ...serverTool,
              inputSchema: { $ref: "https://external/schema", type: "object" },
            },
          ],
        },
        { tools: true },
      ),
    /External/,
  );
  assert.throws(
    () =>
      decodeSamplingRequest(
        {
          ...samplingInput,
          tools: [serverTool, { ...serverTool, name: "other" }],
        },
        { tools: true, maxTools: 1 },
      ),
    /limit/,
  );
  const use = {
    role: "assistant",
    content: [
      { type: "tool_use", id: "a", name: "write", input: { value: "x" } },
      { type: "tool_use", id: "b", name: "write", input: { value: "y" } },
    ],
  };
  const result = {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "a", content: [] }],
  };
  assert.throws(
    () =>
      decodeSamplingRequest(
        { ...samplingInput, messages: [use, result] },
        { tools: true },
      ),
    /complete preceding/,
  );
  assert.throws(
    () =>
      decodeSamplingRequest(
        { ...samplingInput, messages: [result] },
        { tools: true },
      ),
    /Orphan/,
  );
  assert.throws(
    () =>
      decodeSamplingRequest(
        { ...samplingInput, messages: [use] },
        { tools: true },
      ),
    /Incomplete/,
  );
  assert.throws(
    () =>
      decodeSamplingRequest(
        {
          ...samplingInput,
          messages: [
            use,
            {
              role: "user",
              content: [...result.content, { type: "text", text: "mixed" }],
            },
          ],
        },
        { tools: true },
      ),
    /only user/,
  );
});
test("MCP sampling rejects forged provider tool names, invalid arguments and violated tool choices", () => {
  const decoded = decodeSamplingRequest(samplingInput, { tools: true }),
    reply: any = {
      role: "assistant",
      model: "m",
      provider: "text",
      timestamp: Date.now(),
      usage: emptyUsage(),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "a", name: "write", arguments: { value: "x" } },
      ],
    };
  assert.equal(
    samplingResult(reply, decoded, decoded.tools).stopReason,
    "toolUse",
  );
  assert.throws(() => samplingResult(reply, decoded, []), /unavailable/);
  assert.throws(
    () =>
      samplingResult(
        {
          ...reply,
          content: [{ ...reply.content[0], arguments: { value: 3 } }],
        },
        decoded,
        decoded.tools,
      ),
    /schema/,
  );
  assert.throws(
    () =>
      samplingResult(
        { ...reply, content: [reply.content[0], reply.content[0]] },
        decoded,
        decoded.tools,
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      samplingResult(
        reply,
        decodeSamplingRequest(
          { ...samplingInput, toolChoice: { mode: "none" } },
          { tools: true },
        ),
        decoded.tools,
      ),
    /toolChoice/,
  );
  assert.throws(
    () =>
      samplingResult(
        { ...reply, content: [{ type: "text", text: "no call" }] },
        decodeSamplingRequest(
          { ...samplingInput, toolChoice: { mode: "required" } },
          { tools: true },
        ),
        decoded.tools,
      ),
    /required/,
  );
});
test("legacy MCP sampling runs the complete tool and tool-result cycle through real stdio", async () => {
  const x = await setup((body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : index === 1
        ? {
            calls: [
              {
                name: body.tools[0].function.name,
                args: { value: "legacy actual bytes" },
              },
            ],
          }
        : { text: "legacy result received" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Legacy",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "sampling", "legacy"],
      clientFeatures: {
        sampling: { routeId: "text", tools: true, maxTokens: 100 },
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sample" });
    for (let i = 0; i < 2; i++) {
      const input: any = await until(() =>
        x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
      );
      await x.client.resolveMCPInteraction(input.id, "accept");
    }
    await collect(x.client, run.runId);
    assert.equal(
      await readFile(path.join(x.project.root, "sampling-effect.txt"), "utf8"),
      "legacy actual bytes",
    );
    const requests = (
      await readFile(
        path.join(x.project.root, "advanced-requests.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests.find((m) => m.method === "initialize").params.capabilities
        .sampling,
      { tools: {} },
    );
  } finally {
    await x.close();
  }
});
test("MCP tool sampling remains disabled unless explicitly declared and never prompts or spends without opt-in", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : { text: "done" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Disabled",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "sampling", "modern"],
      clientFeatures: { sampling: { routeId: "text", maxTokens: 100 } },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sample" });
    await collect(x.client, run.runId);
    assert.equal(x.kernel.mcp.interactions.list().length, 0);
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 0);
    await assert.rejects(
      readFile(path.join(x.project.root, "sampling-effect.txt")),
      /ENOENT/,
    );
    const requests = (
      await readFile(
        path.join(x.project.root, "advanced-requests.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests[0].params._meta["io.modelcontextprotocol/clientCapabilities"]
        .sampling,
      {},
    );
  } finally {
    await x.close();
  }
});
test("MCP sampling fallback cannot select tools excluded by its effective route", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : index === 1
        ? { status: 503 }
        : { text: "done" },
  );
  x.config.routes.sample = {
    ...x.config.routes.text,
    fallbackRouteIds: ["restricted"],
  };
  x.config.routes.restricted = {
    ...x.config.routes.text,
    toolAllowlist: ["mcp_peer_work"],
  };
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Fallback",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "sampling", "modern"],
      clientFeatures: {
        sampling: { routeId: "sample", tools: true, maxTokens: 100 },
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sample" });
    const input: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    await x.client.resolveMCPInteraction(input.id, "accept");
    await collect(x.client, run.runId);
    assert.equal(
      x.kernel.costs
        .entries({ purpose: "mcp-sampling" })
        .filter((e) => e.routeId === "restricted").length,
      0,
    );
    await assert.rejects(
      readFile(path.join(x.project.root, "sampling-effect.txt")),
      /ENOENT/,
    );
    assert.equal(x.wire.requests.length, 3);
  } finally {
    await x.close();
  }
});
test("MCP sampling rechecks permissions after model completion before returning a server tool call", async () => {
  const x = await setup((body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : index === 1
        ? {
            delayMs: 150,
            calls: [
              {
                name: body.tools[0].function.name,
                args: { value: "must not execute" },
              },
            ],
          }
        : { text: "done" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Revoke",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "sampling", "modern"],
      clientFeatures: {
        sampling: { routeId: "text", tools: true, maxTokens: 100 },
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sample" });
    const input: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    await x.client.resolveMCPInteraction(input.id, "accept");
    await until(() => x.wire.requests.length === 2);
    x.kernel.store.put("policies", {
      id: "revoke",
      effect: "deny",
      capabilities: ["network"],
      projectId: x.project.id,
    });
    await collect(x.client, run.runId);
    await assert.rejects(
      readFile(path.join(x.project.root, "sampling-effect.txt")),
      /ENOENT/,
    );
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 1);
  } finally {
    await x.close();
  }
});
test("MCP sampling obeys the originating run cost ceiling before sending model HTTP", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : { text: "done" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Budget",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "sampling", "modern"],
      clientFeatures: {
        sampling: { routeId: "text", tools: true, maxTokens: 100 },
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sample" });
    const input: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    x.config.routes.text.pricing = {
      currency: "USD",
      inputPerMillion: 2,
      outputPerMillion: 4,
      requestUsd: 0,
    };
    x.config.budgets = { enabled: true, maxRunUsd: 0.000001 };
    await x.client.resolveMCPInteraction(input.id, "accept");
    await collect(x.client, run.runId);
    assert.equal(x.wire.requests.length, 1);
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 0);
    await assert.rejects(
      readFile(path.join(x.project.root, "sampling-effect.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
test("MCP sampling tool continuations share one per-origin request quota", async () => {
  const x = await setup((body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : index === 1
        ? {
            calls: [
              {
                name: body.tools[0].function.name,
                args: { value: "first authorized effect" },
              },
            ],
          }
        : { text: "done" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Quota",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "sampling", "modern"],
      clientFeatures: {
        sampling: {
          routeId: "text",
          tools: true,
          maxTokens: 100,
          maxRequestsPerCall: 1,
        },
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "sample" });
    const input: any = await until(() =>
      x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
    );
    await x.client.resolveMCPInteraction(input.id, "accept");
    await collect(x.client, run.runId);
    assert.equal(
      await readFile(path.join(x.project.root, "sampling-effect.txt"), "utf8"),
      "first authorized effect",
    );
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 1);
    assert.equal(x.kernel.mcp.interactions.list().length, 1);
    await assert.rejects(
      readFile(path.join(x.project.root, "sampling-reply.json")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
async function taskPeer(handler: (params: any, context: any) => Promise<any>) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-advanced-")),
    client = new MCPClient({
      transport: "stdio",
      command: process.execPath,
      args: [fixture, root, "tasks", "legacy"],
      timeoutMs: 3000,
      handlers: {
        "elicitation/create": handler,
        "sampling/createMessage": handler,
      },
    });
  await client.connect();
  return { root, client };
}
for (const behavior of ["immediate", "wait"])
  test(`MCP task reverse input retains its origin after creation for ${behavior} callbacks`, async () => {
    const x = await setup((_body, index) =>
      index === 0
        ? { calls: [{ name: "mcp_peer_work", args: { behavior } }] }
        : { text: "done" },
    );
    try {
      x.kernel.mcp.install({
        id: "peer",
        name: "Task",
        transport: "stdio",
        command: process.execPath,
        args: [fixture, x.project.root, "tasks", "legacy"],
        clientFeatures: { elicitation: true },
      });
      await x.kernel.mcp.connect("peer");
      const s = await x.session("code"),
        run = await x.client.submit(s.id, { text: "task input" });
      const pending: any = await until(() =>
        x.kernel.mcp.interactions
          .list("peer")
          .find((r) => r.status === "pending"),
      );
      assert.equal(pending.origin.runId, run.runId);
      await x.client.resolveMCPInteraction(pending.id, "accept", {
        value: "actual task callback bytes",
      });
      await collect(x.client, run.runId);
      const task = x.kernel.mcp.tasks("peer")[0];
      assert.equal(task.status, "completed");
      assert.equal(
        await readFile(
          path.join(x.project.root, `task-effect-${task.remoteId}.txt`),
          "utf8",
        ),
        "actual task callback bytes",
      );
      const reply = JSON.parse(
        await readFile(
          path.join(x.project.root, `task-input-${task.remoteId}.json`),
          "utf8",
        ),
      );
      assert.equal(
        reply.result._meta["io.modelcontextprotocol/related-task"].taskId,
        task.remoteId,
      );
    } finally {
      await x.close();
    }
  });
test("MCP concurrent tasks route reverse callbacks by exact task ID and shared origin only", async () => {
  const seen: any[] = [],
    x = await taskPeer(async (_p, ctx) => {
      seen.push(ctx.localContext);
      return { action: "accept", content: { value: ctx.localContext.label } };
    });
  try {
    const tasks = await Promise.all(
      ["one", "two"].map((label) =>
        x.client.createToolTask(
          { name: "work", arguments: { behavior: "wait" } },
          { localContext: { label } },
        ),
      ),
    );
    await Promise.all(tasks.map((t) => x.client.taskResult(t.taskId)));
    assert.deepEqual(seen.map((v) => v.label).sort(), ["one", "two"]);
    for (let i = 0; i < tasks.length; i++)
      assert.equal(
        await readFile(
          path.join(x.root, `task-effect-${tasks[i].taskId}.txt`),
          "utf8",
        ),
        ["one", "two"][i],
      );
  } finally {
    await x.client.close();
  }
});
test("MCP asynchronous task sampling executes server tools and keeps both model charges on the originating run", async () => {
  const x = await setup((body, index) =>
    index === 0
      ? {
          calls: [
            { name: "mcp_peer_work", args: { behavior: "sample-tools" } },
          ],
        }
      : index === 1
        ? {
            calls: [
              {
                name: body.tools[0].function.name,
                args: { value: "async actual sampling bytes" },
              },
            ],
          }
        : { text: "async server result received" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "Async sample",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root, "tasks", "legacy"],
      clientFeatures: {
        sampling: { routeId: "text", tools: true, maxTokens: 100 },
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "async task sampling" });
    for (let i = 0; i < 2; i++) {
      const input: any = await until(() =>
        x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
      );
      assert.equal(input.origin.runId, run.runId);
      await x.client.resolveMCPInteraction(input.id, "accept");
    }
    await collect(x.client, run.runId);
    assert.equal(x.kernel.mcp.tasks("peer")[0].status, "completed");
    assert.equal(
      await readFile(
        path.join(x.project.root, "task-sampling-effect.txt"),
        "utf8",
      ),
      "async actual sampling bytes",
    );
    assert.equal(
      x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
        .length,
      2,
    );
  } finally {
    await x.close();
  }
});
for (const behavior of ["foreign", "no-meta"])
  test(`MCP task rejects ${behavior} reverse callbacks without granting another origin`, async () => {
    let calls = 0;
    const x = await taskPeer(async () => {
      calls++;
      return {};
    });
    try {
      const t = await x.client.createToolTask(
        { name: "work", arguments: { behavior } },
        { localContext: { private: "host" } },
      );
      const r = await x.client.taskResult(t.taskId);
      assert.equal(r.isError, true);
      assert.equal(calls, 0);
      await assert.rejects(
        readFile(path.join(x.root, `task-effect-${t.taskId}.txt`)),
        /ENOENT/,
      );
    } finally {
      await x.client.close();
    }
  });
test("MCP task cancellation aborts an active reverse callback and rejects late callbacks", async () => {
  let calls = 0,
    aborted = false;
  const controller = new AbortController(),
    x = await taskPeer(async (_p, context) => {
      calls++;
      await new Promise<void>((resolve) =>
        context.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return {};
    });
  try {
    const task = await x.client.createToolTask(
      { name: "work", arguments: { behavior: "immediate" } },
      { signal: controller.signal },
    );
    await until(() => calls === 1);
    controller.abort();
    await until(() => aborted);
    await x.client.taskCancel(task.taskId);
    const late: any = await until(() =>
      readFile(path.join(x.root, "late-callback.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined),
    );
    assert.match(late.error.message, /Unknown|expired/);
    assert.equal(calls, 1);
  } finally {
    await x.client.close();
  }
});
test("MCP task TTL aborts stalled callback consent and prevents file effects", async () => {
  let aborted = false;
  const x = await taskPeer(async (_p, ctx) => {
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return { action: "accept" };
  });
  try {
    const t = await x.client.createToolTask({
      name: "work",
      arguments: { behavior: "immediate", ttl: 60 },
    });
    await until(() => aborted);
    const r = await x.client.taskResult(t.taskId);
    assert.equal(r.isError, true);
    await assert.rejects(
      readFile(path.join(x.root, `task-effect-${t.taskId}.txt`)),
      /ENOENT/,
    );
  } finally {
    await x.client.close();
  }
});
for (const behavior of ["result-no-meta", "result-foreign"])
  test(`MCP rejects ${behavior} task results instead of accepting an unbound result`, async () => {
    const x = await taskPeer(async () => ({
      action: "accept",
      content: { value: "server effect" },
    }));
    try {
      const task = await x.client.createToolTask({
        name: "work",
        arguments: { behavior },
      });
      await assert.rejects(
        x.client.taskResult(task.taskId),
        /related-task metadata/,
      );
    } finally {
      await x.client.close();
    }
  });
test("MCP task progress survives initial RPC completion with the original progress token", async () => {
  const progress: any[] = [],
    x = await taskPeer(async () => ({
      action: "accept",
      content: { value: "progress effect" },
    }));
  try {
    const task = await x.client.createToolTask(
      { name: "work", arguments: {} },
      { progress: (p) => progress.push(p) },
    );
    await x.client.taskResult(task.taskId);
    assert.equal(progress.length, 1);
    assert.equal(
      progress[0]._meta["io.modelcontextprotocol/related-task"].taskId,
      task.taskId,
    );
    assert.equal(progress[0].progress, 1);
  } finally {
    await x.client.close();
  }
});
for (const channel of ["GET", "unrelated POST"])
  test(`MCP HTTP task callbacks on ${channel} streams keep their related-task origin`, async () => {
    const related = "io.modelcontextprotocol/related-task";
    let stream: http.ServerResponse | undefined,
      other: http.ServerResponse | undefined,
      otherId: any,
      waiter: http.ServerResponse | undefined,
      waiterId: any,
      status = "input_required",
      calls = 0;
    const replies: any[] = [],
      sse = (res: http.ServerResponse, m: any) =>
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...m })}\n\n`);
    const callback = () => ({
      id: "http-callback",
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "HTTP task input",
        requestedSchema: { type: "object" },
        _meta: { [related]: { taskId: "http-task" } },
      },
    });
    const server = http.createServer(async (req, res) => {
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
      const json = (result: any) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "http-test",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      };
      if (!m.method && m.id) {
        replies.push(m);
        res.writeHead(202);
        res.end();
        if (m.id === "http-callback") {
          status = "completed";
          waiter!.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: waiterId,
              result: {
                content: [{ type: "text", text: "http completed" }],
                _meta: { [related]: { taskId: "http-task" } },
              },
            }),
          );
          if (other) {
            sse(other, { id: otherId, result: { messages: [] } });
            other.end();
          }
        }
        return;
      }
      if (m.method === "initialize")
        return json({
          protocolVersion: "2025-11-25",
          capabilities: { tasks: { requests: { tools: { call: {} } } } },
          serverInfo: { name: "HTTP task peer", version: "1" },
        });
      if (m.method === "tools/call")
        return json({ task: { taskId: "http-task", status, ttl: 5000 } });
      if (m.method === "tasks/result") {
        waiter = res;
        waiterId = m.id;
        res.writeHead(200, { "Content-Type": "application/json" });
        if (channel === "GET") sse(stream!, callback());
        return;
      }
      if (m.method === "prompts/get") {
        other = res;
        otherId = m.id;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, callback());
        return;
      }
      res.writeHead(202);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = new MCPClient({
      transport: "http",
      protocol: "legacy",
      url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
      timeoutMs: 3000,
      handlers: {
        "elicitation/create": async (_params, context) => {
          calls++;
          assert.equal((context.localContext as any).label, "task origin");
          return { action: "accept", content: { value: "HTTP accepted" } };
        },
      },
    });
    try {
      await client.connect();
      await until(() => stream);
      await client.createToolTask(
        { name: "work", arguments: {} },
        { localContext: { label: "task origin" } },
      );
      const result = client.taskResult("http-task");
      await until(() => waiter);
      const prompt =
        channel === "unrelated POST"
          ? client.request(
              "prompts/get",
              { name: "other" },
              { localContext: { label: "unrelated prompt" } },
            )
          : Promise.resolve();
      assert.equal((await result).content[0].text, "http completed");
      await prompt;
      assert.equal(calls, 1);
      assert.equal(replies[0].result._meta[related].taskId, "http-task");
      sse(stream!, { ...callback(), id: "late-http" });
      await until(() => replies.find((r) => r.id === "late-http"));
      assert.match(
        replies.find((r) => r.id === "late-http").error.message,
        /Unknown|expired/,
      );
      assert.equal(calls, 1);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
