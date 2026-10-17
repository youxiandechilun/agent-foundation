import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { MCPClient } from "../src/extensions/mcp-client.js";
import { setup, until, collect } from "./support/wire-server.js";
const childFile = fileURLToPath(
  new URL("./support/adversarial-mcp.mjs", import.meta.url),
);
async function ownStdio(mode?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "own-mcp-"));
  const client = new MCPClient({
    transport: "stdio",
    command: process.execPath,
    args: [childFile, root, ...(mode ? [mode] : [])],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          /^(PATH|Path|SystemRoot|TEMP|TMP|WINDIR|PATHEXT)$/.test(name),
        ),
      ),
    },
    timeoutMs: 2000,
    maxMessageBytes: 2048,
  });
  await client.connect();
  return { client, root };
}
test("own stdio MCP correlates concurrent responses, handles server ping, progress and explicit cancellation", async () => {
  const { client, root } = await ownStdio();
  try {
    const progress: any[] = [];
    const slow = client.callTool(
      { name: "declared_readonly", arguments: { value: "slow", delay: 90 } },
      { progress: (p) => progress.push(p) },
    );
    const fast = client.callTool({
      name: "declared_readonly",
      arguments: { value: "fast", delay: 1 },
    });
    assert.equal((await fast).content[0].text, "fast");
    assert.equal((await slow).content[0].text, "slow");
    assert.equal(progress[0].total, 2);
    await until(() =>
      readFile(path.join(root, "server-response.json"), "utf8").catch(
        () => undefined,
      ),
    );
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "declared_readonly", arguments: { delay: 1000 } },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await until(() =>
      readFile(path.join(root, "cancelled.json"), "utf8").catch(
        () => undefined,
      ),
    );
    await client.ping();
  } finally {
    await client.close();
  }
});
test("own MCP rejects malformed and oversized stdio frames and terminates their connections", async () => {
  for (const mode of ["malformed", "oversized"]) {
    const { client } = await ownStdio(mode);
    try {
      await assert.rejects(client.listTools());
      assert.equal(client.connected, false);
    } finally {
      await client.close();
    }
  }
});
test("a false remote readOnlyHint cannot cause an actual side effect in a planning run", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "mcp_untrusted_declared_readonly", args: {} }] }
      : { text: "permission denied" },
  );
  try {
    x.kernel.mcp.install({
      id: "untrusted",
      name: "false hint",
      transport: "stdio",
      command: process.execPath,
      args: [childFile, x.root],
      enabled: true,
    });
    await x.kernel.mcp.connect("untrusted");
    const s = await x.session("code");
    x.kernel.updateSession(s.id, { autonomy: "plan" });
    const { runId } = await x.client.submit(s.id, { text: "plan only" });
    const events = await collect(x.client, runId);
    assert.equal(events.filter((e) => e.type === "tool.started").length, 0);
    assert.ok(events.some((e) => e.type === "tool.settled" && e.data.isError));
    await assert.rejects(readFile(path.join(x.root, "effect.txt")), /ENOENT/);
  } finally {
    await x.close();
  }
});
test("MCP catalog rejects repeated pagination cursors", async () => {
  const x = await setup();
  try {
    x.kernel.mcp.install({
      id: "pages",
      name: "bad cursor",
      transport: "stdio",
      command: process.execPath,
      args: [childFile, x.root, "repeat-cursor"],
      enabled: true,
    });
    await x.kernel.mcp.connect("pages");
    await assert.rejects(x.kernel.mcp.catalog("pages"), /repeated/);
  } finally {
    await x.close();
  }
});

test("own HTTP MCP negotiates session headers, JSON/SSE, server requests, stream recovery and never replays an expired effect", async () => {
  const requests: any[] = [];
  let sessions = 0,
    resumeId: any,
    renderPosts = 0,
    deleted = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      if (req.headers["last-event-id"] === "resume-0") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `id: resume-1\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: resumeId, result: { content: [{ type: "text", text: "resumed without a new POST" }] } })}\n\n`,
        );
      } else {
        res.writeHead(405);
        res.end();
      }
      return;
    }
    if (req.method === "DELETE") {
      deleted++;
      res.writeHead(200);
      res.end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const m = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ m, headers: req.headers });
    if (m.method === "initialize") {
      sessions++;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "MCP-Session-Id": "session-" + sessions,
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "session-wire-test", version: "1" },
          },
        }),
      );
      return;
    }
    if (m.id === undefined || !m.method) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (m.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [] } }),
      );
      return;
    }
    if (m.method === "tools/call") {
      renderPosts++;
      if (m.params.arguments.mode === "expire") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (m.params.arguments.mode === "resume") {
        resumeId = m.id;
        res.end("retry: 1\nid: resume-0\ndata:\n\n");
        return;
      }
      const payload = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: m.params._meta.progressToken, progress: 1, total: 1 } })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "server-http-ping", method: "ping" })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "中文 HTTP 工具结果" }] } })}\r\n\r\n`;
      for (const byte of Buffer.from(payload)) res.write(Buffer.from([byte]));
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  let client = new MCPClient({
    transport: "http",
    url,
    headers: { Authorization: "Bearer local-wire-key" },
    timeoutMs: 2000,
  });
  try {
    await client.connect();
    await client.listTools();
    const progress: any[] = [];
    assert.equal(
      (
        await client.callTool(
          { name: "render", arguments: { mode: "normal" } },
          { progress: (p) => progress.push(p) },
        )
      ).content[0].text,
      "中文 HTTP 工具结果",
    );
    assert.equal(progress.length, 1);
    await until(() =>
      requests.find((r) => r.m.id === "server-http-ping" && r.m.result),
    );
    assert.equal(
      (await client.callTool({ name: "render", arguments: { mode: "resume" } }))
        .content[0].text,
      "resumed without a new POST",
    );
    assert.equal(renderPosts, 2);
    await assert.rejects(
      client.callTool({ name: "render", arguments: { mode: "expire" } }),
      /session expired/,
    );
    await client.close();
    assert.equal(renderPosts, 3);
    assert.equal(client.connected, false);
    const subsequent = requests.filter((r) => r.m.method !== "initialize");
    assert.ok(
      subsequent.every(
        (r) =>
          r.headers["mcp-session-id"] === "session-1" &&
          r.headers["mcp-protocol-version"] === "2025-11-25",
      ),
    );
    client = new MCPClient({ transport: "http", url, timeoutMs: 2000 });
    await client.connect();
    assert.equal(sessions, 2);
    assert.equal(renderPosts, 3);
  } finally {
    await client.close();
    assert.ok(deleted >= 1);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
