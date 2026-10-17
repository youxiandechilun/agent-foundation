import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setup, collect } from "./support/wire-server.js";
import { startFilesystemMCP } from "../examples/mcp-http-filesystem.mjs";
import { Kernel } from "../src/kernel.js";

test("actual Streamable HTTP MCP reads files with header env references", async () => {
  const x = await setup();
  let api: any;
  try {
    await writeFile(
      path.join(x.config.workspaceRoots[0], "http.txt"),
      "actual HTTP MCP file",
    );
    api = await startFilesystemMCP(
      x.config.workspaceRoots[0],
      0,
      "local-test-mcp-key",
    );
    process.env.TEST_MCP_KEY = "local-test-mcp-key";
    await x.client
      .request("POST", "/v1/mcp", {
        id: "http_files",
        name: "HTTP filesystem",
        transport: "http",
        url: api.url,
        enabled: true,
        headerEnvRefs: { Authorization: "TEST_MCP_AUTH" },
      })
      .catch(async () => {
        process.env.TEST_MCP_AUTH = "Bearer local-test-mcp-key";
        await x.client.request("POST", "/v1/mcp", {
          id: "http_files",
          name: "HTTP filesystem",
          transport: "http",
          url: api.url,
          enabled: true,
          headerEnvRefs: { Authorization: "TEST_MCP_AUTH" },
        });
      });
    const tools = await x.kernel.mcp.tools();
    const tool = tools.find((t) => t.name === "mcp_http_files_read_text")!;
    assert.match(
      (await tool.execute("test", { path: "http.txt" })).content[0].type ===
        "text"
        ? (
            (await tool.execute("test2", { path: "http.txt" }))
              .content[0] as any
          ).text
        : "",
      /actual HTTP MCP file/,
    );
  } finally {
    await x.close();
    await api?.close();
    delete process.env.TEST_MCP_AUTH;
    delete process.env.TEST_MCP_KEY;
  }
});
test("embedding adapter sends real HTTP payload and project semantic ranking uses persisted vectors", async () => {
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            embedding: body.input.includes("TypeScript")
              ? [1, 0, 0]
              : [0, 1, 0],
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const x = await setup();
  try {
    x.config.routes.embed = {
      ...x.config.routes.text,
      kind: "embedding",
      adapter: "openai-embeddings",
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    };
    x.config.defaultRoutes.embedding = "embed";
    const a = x.kernel.memory.put({
        projectId: x.project.id,
        content: "TypeScript project",
      }),
      b = x.kernel.memory.put({
        projectId: x.project.id,
        content: "Office spreadsheet preference",
      });
    await x.kernel.memory.embed(a.id);
    await x.kernel.memory.embed(b.id);
    const result = await x.kernel.memory.semanticSearch(
      x.project.id,
      "TypeScript",
    );
    assert.equal(result[0].id, a.id);
    assert.equal(result[0].score, 1);
    assert.equal(result[1].score, 0);
  } finally {
    await x.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
test("fallback model cannot escalate primary model permissions", async () => {
  const failing = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"unavailable"}}');
  });
  await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
  const x = await setup((_body, index) =>
    index === 0
      ? {
          text: "fallback write attempt",
          calls: [
            {
              name: "file_write",
              args: { path: "blocked.txt", content: "must not write" },
            },
          ],
        }
      : { text: "blocked result received" },
  );
  try {
    x.config.routes.fallback = {
      ...x.config.routes.text,
      baseUrl: x.wire.url + "/v1",
    };
    x.config.routes.text = {
      ...x.config.routes.text,
      baseUrl: `http://127.0.0.1:${(failing.address() as any).port}/v1`,
      fallbackRouteIds: ["fallback"],
      capabilityPolicies: { "files.write": "deny" },
    };
    const s = await x.session("code"),
      { runId } = await x.client.submit(s.id, { text: "write" }),
      events = await collect(x.client, runId);
    assert.ok(
      events.some((e) => e.type === "model.route.selected" && e.data.fallback),
    );
    assert.ok(events.some((e) => e.type === "tool.settled" && e.data.isError));
    await assert.rejects(
      readFile(path.join(x.config.workspaceRoots[0], "blocked.txt")),
    );
  } finally {
    await x.close();
    failing.closeAllConnections();
    await new Promise<void>((r) => failing.close(() => r()));
  }
});
test("recovery persists uncertain effects and queued input without replay; model routes persist", async () => {
  const x = await setup();
  let recovered: Kernel | undefined;
  try {
    const s = await x.session(),
      time = new Date().toISOString();
    x.kernel.store.put("runs", {
      id: "run_crash",
      sessionId: s.id,
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    x.kernel.store.put("effects", {
      id: "effect_crash",
      runId: "run_crash",
      callId: "call",
      tool: "exec_run",
      argsHash: "x",
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    x.kernel.store.put("inbox", {
      id: "input_crash",
      runId: "run_crash",
      delivery: "enqueue",
      message: {
        role: "user",
        content: "pending input",
        timestamp: Date.now(),
      },
      status: "pending",
      createdAt: time,
    });
    await x.client
      .request("PUT", "/v1/routes/new-route", {
        kind: "text",
        adapter: "openai-responses",
        model: "custom-routed",
        baseUrl: x.wire.url + "/v1",
      })
      .catch(() => undefined);
    // Route update is correctly blocked while an active run exists; settle it before update.
    x.kernel.store.status("run_crash", "interrupted");
    await x.client.request("PUT", "/v1/routes/new-route", {
      kind: "text",
      adapter: "openai-responses",
      model: "custom-routed",
      baseUrl: x.wire.url + "/v1",
    });
    x.kernel.store.put("runs", {
      id: "run_crash2",
      sessionId: s.id,
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    await x.api.close();
    recovered = new Kernel(x.config);
    await recovered.init();
    assert.equal(recovered.store.run("run_crash2").status, "interrupted");
    assert.equal(
      recovered.store.get<any>("effects", "effect_crash").status,
      "unknown",
    );
    assert.equal(
      recovered.store.get<any>("inbox", "input_crash").status,
      "pending",
    );
    assert.equal(recovered.config.routes["new-route"].model, "custom-routed");
  } finally {
    if (recovered) await recovered.close();
    else await x.api.close();
    await x.wire.close();
  }
});
