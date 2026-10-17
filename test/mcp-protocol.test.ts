import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import { MCPClient } from "../src/extensions/mcp-client.js";
import { setup, until, collect } from "./support/wire-server.js";
const file = fileURLToPath(
  new URL("./support/protocol-mcp.mjs", import.meta.url),
);
async function peer(mode = "modern", options: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "protocol-mcp-"));
  const client = new MCPClient({
    transport: "stdio",
    command: process.execPath,
    args: [file, root, mode],
    timeoutMs: 3000,
    protocol: "auto",
    ...options,
  });
  await client.connect();
  return { root, client };
}
test("modern stdio MCP discovers without initialization and completes MRTR with exact state and distinct IDs", async () => {
  const x = await peer("modern", {
    handlers: {
      "roots/list": async () => ({ roots: [{ uri: "file:///approved" }] }),
      "elicitation/create": async () => ({
        action: "accept",
        content: { value: "real answer" },
      }),
    },
  });
  try {
    const value = await x.client.callTool({ name: "work", arguments: {} });
    assert.ok(value.content[0].text.includes("real answer"));
    const effect = JSON.parse(
      await readFile(path.join(x.root, "effect.json"), "utf8"),
    );
    assert.equal(effect.form.content.value, "real answer");
    const requests = (
      await readFile(path.join(x.root, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(requests[0].method, "server/discover");
    assert.ok(
      !requests.some(
        (m) =>
          m.method === "initialize" || m.method === "notifications/initialized",
      ),
    );
    const calls = requests.filter((m) => m.method === "tools/call");
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id);
    assert.equal(calls[1].params.requestState, "opaque/状态/==");
    assert.ok(
      calls.every(
        (m) =>
          m.params._meta["io.modelcontextprotocol/protocolVersion"] ===
          "2026-07-28",
      ),
    );
  } finally {
    await x.client.close();
  }
});
test("MCP auto negotiation falls back only for a legacy discovery error and handles bidirectional requests", async () => {
  const x = await peer("legacy", {
    handlers: {
      "roots/list": async () => ({ roots: [] }),
      "elicitation/create": async () => ({ action: "decline" }),
    },
  });
  try {
    assert.equal(x.client.protocolVersion, "2025-11-25");
    const r = await x.client.callTool({ name: "work", arguments: {} });
    assert.ok(r.content[0].text.includes("decline"));
    const requests = (
      await readFile(path.join(x.root, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests.slice(0, 2).map((m) => m.method),
      ["server/discover", "initialize"],
    );
    assert.ok(requests[1].params.capabilities.roots);
    assert.ok(requests[1].params.capabilities.elicitation.form);
    await x.client.subscribeResource("file:///approved");
    await x.client.unsubscribeResource("file:///approved");
  } finally {
    await x.client.close();
  }
});
test("modern MCP rejects undeclared inputs and bounds server-driven continuation loops", async () => {
  const x = await peer("modern", { maxInputRounds: 2 });
  try {
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: {} }),
      /capability not supported/,
    );
    await assert.rejects(
      x.client.callTool({ name: "work", arguments: { loop: true } }),
      /round limit/,
    );
    await assert.rejects(readFile(path.join(x.root, "effect.json")), /ENOENT/);
  } finally {
    await x.client.close();
  }
});
test("modern subscriptions require acknowledgement, filter unrelated events and cancel the real stdio request", async () => {
  const x = await peer();
  try {
    const subscription = x.client.listenNotifications({
      toolsListChanged: true,
    });
    assert.deepEqual(await subscription.ready, { toolsListChanged: true });
    await until(() =>
      x.client
        .notifications()
        .some((n) => n.method === "subscriptions/rejected"),
    );
    assert.equal(
      x.client
        .notifications()
        .filter((n) => n.method === "notifications/tools/list_changed").length,
      1,
    );
    assert.equal(
      x.client
        .notifications()
        .filter((n) => n.method === "notifications/resources/updated").length,
      0,
    );
    subscription.close();
    await assert.rejects(subscription.completion, /cancelled/);
    await until(() =>
      readFile(path.join(x.root, "cancelled.json"), "utf8").catch(
        () => undefined,
      ),
    );
  } finally {
    await x.client.close();
  }
});
test("headless MCP elicitation validates responses, scopes roots and never accepts an expired answer", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: {} }] }
      : { text: "finished" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "peer",
      transport: "stdio",
      command: process.execPath,
      args: [file, x.project.root, "modern"],
      clientFeatures: {
        roots: [{ uri: pathToFileURL(x.project.root).href }],
        elicitation: true,
      },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "work" });
    const pending: any = await until(() =>
      x.kernel.mcp.interactions
        .list("peer")
        .find((r) => r.status === "pending"),
    );
    assert.equal(pending.origin.runId, run.runId);
    await assert.rejects(
      x.client.request("POST", `/v1/mcp-interactions/${pending.id}/resolve`, {
        action: "accept",
        content: { value: 42 },
      }),
      /schema/,
    );
    await x.client.request(
      "POST",
      `/v1/mcp-interactions/${pending.id}/resolve`,
      { action: "accept", content: { value: "from user" } },
    );
    await collect(x.client, run.runId);
    const effect = JSON.parse(
      await readFile(path.join(x.project.root, "effect.json"), "utf8"),
    );
    assert.equal(effect.form.content.value, "from user");
    assert.equal(effect.roots.roots[0].uri, pathToFileURL(x.project.root).href);
    await assert.rejects(
      x.client.request("POST", `/v1/mcp-interactions/${pending.id}/resolve`, {
        action: "accept",
        content: { value: "again" },
      }),
      /no longer pending/,
    );
  } finally {
    await x.close();
  }
});
test("MCP sampling requires explicit consent, uses the configured route and bills the originating run", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_peer_work", args: { sample: true } }] }
      : index === 1
        ? { text: "sampled via configured route" }
        : { text: "finished" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "peer",
      transport: "stdio",
      command: process.execPath,
      args: [file, x.project.root, "modern"],
      clientFeatures: { sampling: { routeId: "text", maxTokens: 100 } },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, {
        text: "PRIVATE unrelated conversation history",
      });
    const pending: any = await until(() =>
      x.kernel.mcp.interactions
        .list("peer")
        .find((r) => r.status === "pending"),
    );
    assert.equal(x.wire.requests.length, 1);
    await x.client.request(
      "POST",
      `/v1/mcp-interactions/${pending.id}/resolve`,
      { action: "accept" },
    );
    await collect(x.client, run.runId);
    assert.equal(x.wire.requests[1].body.model, "protocol-test-model");
    assert.ok(!JSON.stringify(x.wire.requests[1]).includes("PRIVATE"));
    assert.equal(x.wire.requests[1].body.max_tokens, 80);
    assert.equal(
      x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
        .length,
      1,
    );
    const effect = JSON.parse(
      await readFile(path.join(x.project.root, "effect.json"), "utf8"),
    );
    assert.equal(effect.sample.content.text, "sampled via configured route");
  } finally {
    await x.close();
  }
});
test("MCP required legacy tasks persist remote identity, poll completion and return actual peer output", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            { name: "mcp_peer_work", args: { value: "actual task bytes" } },
          ],
        }
      : { text: "done" },
  );
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "task peer",
      transport: "stdio",
      command: process.execPath,
      args: [file, x.project.root, "legacy-task"],
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "run task" });
    await collect(x.client, run.runId);
    const tasks = x.kernel.mcp.tasks("peer");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "completed");
    assert.equal(tasks[0].origin.runId, run.runId);
    assert.equal(
      await readFile(path.join(x.project.root, "task-effect.txt"), "utf8"),
      "actual task bytes",
    );
    assert.equal(
      (await x.kernel.mcp.task("peer", tasks[0].id, "result")).content[0].text,
      "actual task bytes",
    );
    await assert.rejects(
      x.kernel.mcp.task("wrong", tasks[0].id, "get"),
      /mismatch/,
    );
  } finally {
    await x.close();
  }
});

test("modern HTTP MCP mirrors encoded routing headers and never opens a legacy GET or DELETE channel", async () => {
  const seen: any[] = [];
  let posts = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const m = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ method: req.method, headers: req.headers, message: m });
    let result: any;
    if (m.method === "server/discover")
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      };
    else if (m.method === "tools/list")
      result = {
        tools: [
          {
            name: "你好",
            inputSchema: {
              type: "object",
              properties: {
                settings: {
                  type: "object",
                  properties: {
                    region: { type: "string", "x-mcp-header": "Region" },
                  },
                },
              },
            },
          },
          {
            name: "invalid",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number", "x-mcp-header": "Bad" } },
            },
          },
        ],
      };
    else if (m.method === "tools/call") {
      posts++;
      result = {
        resultType: "complete",
        content: [{ type: "text", text: m.params.arguments.settings.region }],
      };
    } else result = {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new MCPClient({
    transport: "http",
    url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    protocol: "modern",
  });
  try {
    await client.connect();
    assert.deepEqual(
      (await client.listTools()).tools.map((t: any) => t.name),
      ["你好"],
    );
    assert.equal(
      (
        await client.callTool({
          name: "你好",
          arguments: { settings: { region: "华北\nvalue" } },
        })
      ).content[0].text,
      "华北\nvalue",
    );
    const call = seen.at(-1);
    assert.equal(
      call.headers["mcp-name"],
      "=?base64?" + Buffer.from("你好").toString("base64") + "?=",
    );
    assert.equal(
      call.headers["mcp-param-region"],
      "=?base64?" + Buffer.from("华北\nvalue").toString("base64") + "?=",
    );
    assert.equal(call.headers["mcp-protocol-version"], "2026-07-28");
    assert.equal(posts, 1);
    assert.ok(seen.every((s) => s.method === "POST"));
    await client.close();
    assert.ok(seen.every((s) => s.method === "POST"));
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("modern HTTP SSE carries MRTR and cancellation without Last-Event-ID resumption or effect replay", async () => {
  const seen: any[] = [];
  let closed = 0,
    calls = 0,
    effects = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const m = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ method: req.method, headers: req.headers, message: m });
    if (m.method === "server/discover") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (value: any) =>
      res.write(
        "id: same-per-request\ndata: " +
          JSON.stringify({ jsonrpc: "2.0", ...value }) +
          "\n\n",
      );
    if (m.method === "subscriptions/listen") {
      send({
        method: "notifications/subscriptions/acknowledged",
        params: {
          _meta: { "io.modelcontextprotocol/subscriptionId": m.id },
          notifications: m.params.notifications,
        },
      });
      res.once("close", () => closed++);
      return;
    }
    calls++;
    if (m.params.arguments.slow) {
      res.write(": running\n\n");
      res.flushHeaders();
      const timer = setTimeout(() => {
        effects++;
        send({ id: m.id, result: { content: [] } });
        res.end();
      }, 10000);
      res.once("close", () => {
        closed++;
        clearTimeout(timer);
      });
      return;
    }
    if (m.params.requestState === undefined)
      send({
        id: m.id,
        result: {
          resultType: "input_required",
          requestState: "unaltered",
          inputRequests: { r: { method: "roots/list", params: {} } },
        },
      });
    else {
      assert.equal(m.params.requestState, "unaltered");
      assert.deepEqual(m.params.inputResponses.r, { roots: [] });
      send({
        id: m.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "sse complete" }],
        },
      });
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = new MCPClient({
    transport: "http",
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    protocol: "modern",
    handlers: { "roots/list": async () => ({ roots: [] }) },
  });
  try {
    await client.connect();
    assert.equal(
      (await client.callTool({ name: "work", arguments: {} })).content[0].text,
      "sse complete",
    );
    const sub = client.listenNotifications({ toolsListChanged: true });
    await sub.ready;
    sub.close();
    await assert.rejects(sub.completion, /cancelled/);
    const c = new AbortController(),
      pending = client.callTool(
        { name: "work", arguments: { slow: true } },
        { signal: c.signal },
      );
    await until(() => seen.some((r) => r.message.params?.arguments?.slow));
    c.abort();
    await assert.rejects(pending, /cancelled/);
    await until(() => closed === 2);
    assert.equal(calls, 3);
    assert.equal(effects, 0);
    assert.ok(
      seen.every(
        (r) =>
          r.method === "POST" &&
          !r.headers["last-event-id"] &&
          r.message.method !== "notifications/cancelled",
      ),
    );
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("MCP sampling consent cannot override a newly denied capability or a cancelled originating run", async () => {
  for (const action of ["deny", "cancel"] as const) {
    const x = await setup((_body, index) =>
      index === 0
        ? { calls: [{ name: "mcp_peer_work", args: { sample: true } }] }
        : { text: "denied" },
    );
    try {
      x.kernel.mcp.install({
        id: "peer",
        name: "peer",
        transport: "stdio",
        command: process.execPath,
        args: [file, x.project.root, "modern"],
        clientFeatures: { sampling: { routeId: "text", maxTokens: 100 } },
      });
      await x.kernel.mcp.connect("peer");
      const s = await x.session("code"),
        run = await x.client.submit(s.id, { text: "request sampling" });
      const interaction: any = await until(() =>
        x.kernel.mcp.interactions.list().find((r) => r.status === "pending"),
      );
      if (action === "deny") {
        x.kernel.store.put("policies", {
          id: "revoke-sampling",
          effect: "deny",
          capabilities: ["network"],
          projectId: x.project.id,
        });
        x.kernel.mcp.interactions.resolve(interaction.id, { action: "accept" });
      } else {
        await x.client.request("POST", `/v1/runs/${run.runId}/cancel`);
        await until(
          () =>
            x.kernel.mcp.interactions
              .list()
              .find((r) => r.id === interaction.id)?.status === "cancelled",
        );
        assert.throws(
          () =>
            x.kernel.mcp.interactions.resolve(interaction.id, {
              action: "accept",
            }),
          /no longer pending/,
        );
      }
      await collect(x.client, run.runId);
      assert.equal(
        x.kernel.costs.entries({ runId: run.runId, purpose: "mcp-sampling" })
          .length,
        0,
      );
      assert.ok(
        !x.wire.requests.some((r) =>
          JSON.stringify(r.body).includes("Only this server question"),
        ),
      );
      await assert.rejects(
        readFile(path.join(x.project.root, "effect.json")),
        /ENOENT/,
      );
    } finally {
      await x.close();
    }
  }
});

test("MCP denies ambiguous legacy callbacks instead of attaching them to an arbitrary concurrent caller", async () => {
  let invoked = 0;
  const x = await peer("legacy-ambiguous", {
    handlers: {
      "sampling/createMessage": async () => {
        invoked++;
        return {
          role: "assistant",
          content: { type: "text", text: "unsafe" },
          model: "none",
        };
      },
    },
  });
  try {
    const results = await Promise.allSettled([
      x.client.callTool({ name: "work", arguments: { sample: true } }),
      x.client.callTool({ name: "work", arguments: { sample: true } }),
    ]);
    assert.equal(invoked, 0);
    assert.ok(results.every((r) => r.status === "rejected"));
    await assert.rejects(readFile(path.join(x.root, "effect.json")), /ENOENT/);
  } finally {
    await x.client.close();
  }
});

test("MCP task cancellation preserves its remote identity for explicit inspection", async () => {
  const x = await setup(() => ({
    calls: [
      {
        name: "mcp_peer_work",
        args: { value: "must not finish", delay: 5000 },
      },
    ],
  }));
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "peer",
      transport: "stdio",
      command: process.execPath,
      args: [file, x.project.root, "legacy-task"],
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "start" });
    await until(() => x.kernel.mcp.tasks("peer").length > 0);
    await x.client.request("POST", `/v1/runs/${run.runId}/cancel`);
    await collect(x.client, run.runId);
    const [task] = x.kernel.mcp.tasks("peer");
    assert.equal(task.status, "unknown");
    assert.equal(
      (await x.kernel.mcp.task("peer", task.id, "get")).status,
      "cancelled",
    );
    await assert.rejects(
      readFile(path.join(x.project.root, "task-effect.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});

test("MCP client inputs retain the effective fallback route's capability restrictions", async () => {
  const x = await setup((body, index) =>
    body.model === "primary"
      ? { status: 503 }
      : index === 1
        ? { calls: [{ name: "mcp_peer_work", args: { sample: true } }] }
        : { text: "blocked by fallback policy" },
  );
  try {
    x.config.routes.secondary = {
      ...x.config.routes.text,
      model: "secondary",
      capabilityPolicies: { network: "deny" },
      fallbackRouteIds: [],
    };
    x.config.routes.text = {
      ...x.config.routes.text,
      model: "primary",
      fallbackRouteIds: ["secondary"],
    };
    x.kernel.mcp.install({
      id: "peer",
      name: "peer",
      transport: "stdio",
      command: process.execPath,
      args: [file, x.project.root, "modern"],
      clientFeatures: { sampling: { routeId: "text", maxTokens: 100 } },
    });
    await x.kernel.mcp.connect("peer");
    const s = await x.session("code"),
      run = await x.client.submit(s.id, { text: "use fallback" });
    const events = await collect(x.client, run.runId);
    assert.ok(
      events.some((e) => e.type === "model.route.selected" && e.data.fallback),
    );
    assert.equal(x.kernel.mcp.interactions.list().length, 0);
    assert.equal(x.kernel.costs.entries({ purpose: "mcp-sampling" }).length, 0);
    assert.ok(
      JSON.stringify(x.kernel.store.transcript(s.id)).includes(
        "denied by current origin policy",
      ),
    );
    await assert.rejects(
      readFile(path.join(x.project.root, "effect.json")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});

test("MCP JSON Schema 2020-12 validates tuple inputs and rejects invalid structured output", async () => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const m = JSON.parse(Buffer.concat(chunks).toString());
    let result: any;
    if (m.method === "server/discover")
      result = {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      };
    else if (m.method === "tools/list")
      result = {
        tools: [
          {
            name: "structured",
            inputSchema: {
              type: "object",
              properties: {
                tuple: {
                  type: "array",
                  prefixItems: [{ type: "string" }],
                  items: false,
                },
              },
              required: ["tuple"],
            },
            outputSchema: {
              type: "object",
              properties: { count: { type: "integer" } },
              required: ["count"],
            },
          },
          {
            name: "external-ref",
            inputSchema: { $ref: "https://unapproved.example/schema" },
          },
        ],
      };
    else {
      calls++;
      result = { structuredContent: { count: calls === 1 ? "bad" : 2 } };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = new MCPClient({
    transport: "http",
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    protocol: "modern",
  });
  try {
    await client.connect();
    assert.deepEqual(
      (await client.listTools()).tools.map((t: any) => t.name),
      ["structured"],
    );
    await assert.rejects(
      async () =>
        client.callTool({ name: "structured", arguments: { tuple: [1] } }),
      /input violates/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      client.callTool({ name: "structured", arguments: { tuple: ["ok"] } }),
      /structured output/,
    );
    assert.equal(
      (
        await client.callTool({
          name: "structured",
          arguments: { tuple: ["ok"] },
        })
      ).structuredContent.count,
      2,
    );
    assert.equal(calls, 2);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("MCP root changes notify the peer and reject paths outside configured host roots", async () => {
  const x = await setup();
  try {
    x.kernel.mcp.install({
      id: "peer",
      name: "peer",
      transport: "stdio",
      command: process.execPath,
      args: [file, x.project.root, "legacy"],
      clientFeatures: { roots: [] },
    });
    await x.kernel.mcp.connect("peer");
    await x.kernel.mcp.roots("peer", [
      { uri: pathToFileURL(x.project.root).href, name: "project" },
    ]);
    await until(() =>
      readFile(path.join(x.project.root, "roots-changed"), "utf8").catch(
        () => undefined,
      ),
    );
    await assert.rejects(
      x.kernel.mcp.roots("peer", [{ uri: pathToFileURL(x.root).href }]),
      /outside/,
    );
    assert.equal(
      x.kernel.mcp.list()[0].clientFeatures!.roots![0].name,
      "project",
    );
  } finally {
    await x.close();
  }
});

test("MCP completion and logging use declared server capabilities and real peer notifications", async () => {
  const x = await peer();
  try {
    const response = await x.client.completeArgument({
      ref: { type: "ref/prompt", name: "review" },
      argument: { name: "language", value: "zh" },
    });
    assert.deepEqual(response.completion.values, ["zh-completed"]);
    await x.client.setLoggingLevel("warning");
    await until(() =>
      x.client
        .notifications()
        .some((m) => m.method === "notifications/message"),
    );
    assert.equal(
      (
        x.client
          .notifications()
          .find((m) => m.method === "notifications/message")!.params as any
      ).data,
      "actual peer diagnostic",
    );
  } finally {
    await x.client.close();
  }
});
