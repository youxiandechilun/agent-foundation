import { firstText } from "./support/payloads.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { MCPClient } from "../src/extensions/mcp/client.js";
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
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            /^(PATH|Path|SystemRoot|TEMP|TMP|WINDIR|PATHEXT)$/.test(entry[0]),
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
    assert.equal(firstText(await fast), "fast");
    assert.equal(firstText(await slow), "slow");
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

test("concurrent MCP catalogs share only in-flight pages and isolate cancellation, changes and reconnects", async () => {
  const x = await setup();
  const pending: { id: number; response: http.ServerResponse }[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (message.method === "tools/list") {
      pending.push({ id: message.id, response });
      return;
    }
    if (message.method === "initialize") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "shared-catalog", version: "1.0.0" },
          },
        }),
      );
    } else response.writeHead(202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const complete = (index: number, name: string, nextCursor?: string) => {
    const { id, response } = pending[index];
    const reply = {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{ name, inputSchema: { type: "object" } }],
        nextCursor,
      },
    };
    if (!response.headersSent)
      response.setHeader("Content-Type", "application/json");
    response.end(
      response.getHeader("Content-Type") === "text/event-stream"
        ? `data: ${JSON.stringify(reply)}\n\n`
        : JSON.stringify(reply),
    );
  };
  try {
    x.kernel.mcp.install({
      id: "shared",
      name: "shared",
      transport: "http",
      protocol: "legacy",
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    await x.kernel.mcp.connect("shared");
    const cancelled = new AbortController();
    const first = x.kernel.mcp.catalog("shared", cancelled.signal);
    const joined = Array.from({ length: 11 }, () =>
      x.kernel.mcp.catalog("shared"),
    );
    await until(() => pending.length === 1);
    cancelled.abort(Error("caller stopped"));
    await assert.rejects(first, /caller stopped/);
    complete(0, "first", "next");
    await until(() => pending.length === 2);
    complete(1, "second");
    const results = await Promise.all(joined);
    assert.equal(
      pending.length,
      2,
      "12 callers must issue only two paginated requests",
    );
    assert.deepEqual(
      results[0].map((tool: { name: string }) => tool.name),
      ["first", "second"],
    );
    results[0][0].name = "caller-local mutation";
    assert.equal(results[1][0].name, "first");

    const refresh = x.kernel.mcp.catalog("shared");
    await until(() => pending.length === 3);
    complete(2, "fresh");
    assert.equal(
      (await refresh)[0].name,
      "fresh",
      "completed catalogs must not be cached",
    );

    const abandoned = new AbortController();
    const old = x.kernel.mcp.catalog("shared", abandoned.signal);
    await until(() => pending.length === 4);
    abandoned.abort(Error("all callers left"));
    await assert.rejects(old, /all callers left/);
    const retry = x.kernel.mcp.catalog("shared");
    await until(() => pending.length === 5);
    complete(3, "abandoned");
    complete(4, "retry");
    assert.equal((await retry)[0].name, "retry");

    const changed = x.kernel.mcp.catalog("shared");
    const staleRejected = assert.rejects(changed, /catalog changed|cancelled/);
    await until(() => pending.length === 6);
    pending[5].response.setHeader("Content-Type", "text/event-stream");
    pending[5].response.write(
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
    );
    await until(() =>
      x.kernel.mcp
        .notifications("shared")
        .some((event) => event.method === "notifications/tools/list_changed"),
    );
    const current = x.kernel.mcp.catalog("shared");
    await until(() => pending.length === 7);
    complete(6, "current");
    assert.equal((await current)[0].name, "current");
    complete(5, "stale");
    await staleRejected;

    const beforeDisconnect = x.kernel.mcp.catalog("shared");
    const disconnected = assert.rejects(
      beforeDisconnect,
      /closed|disconnected|cancelled/i,
    );
    await until(() => pending.length === 8);
    await x.kernel.mcp.disconnect("shared");
    await disconnected;
    await x.kernel.mcp.connect("shared");
    const afterReconnect = x.kernel.mcp.catalog("shared");
    await until(() => pending.length === 9);
    complete(7, "old-connection");
    complete(8, "new-connection");
    assert.equal((await afterReconnect)[0].name, "new-connection");
    const definitions = x.kernel.mcp.tools();
    await until(() => pending.length === 10);
    complete(9, "revoked");
    const [tool] = await definitions;
    await x.kernel.mcp.disconnect("shared");
    await assert.rejects(
      tool.execute("revoked-call", {}),
      /revoked|disconnected/,
    );
  } finally {
    await x.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
      firstText(
        await client.callTool(
          { name: "render", arguments: { mode: "normal" } },
          { progress: (p) => progress.push(p) },
        ),
      ),
      "中文 HTTP 工具结果",
    );
    assert.equal(progress.length, 1);
    await until(() =>
      requests.find((r) => r.m.id === "server-http-ping" && r.m.result),
    );
    assert.equal(
      firstText(
        await client.callTool({
          name: "render",
          arguments: { mode: "resume" },
        }),
      ),
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
