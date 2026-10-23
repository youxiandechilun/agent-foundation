import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { MCPClient } from "../src/extensions/mcp/client.js";
import {
  ModernMCPTasks,
  TASKS_EXTENSION,
  type ModernTaskEvent,
} from "../src/extensions/mcp/tasks/modern.js";
import type { MCPRequestContext } from "../src/extensions/mcp/protocol.js";

const createdAt = "2026-10-23T00:00:00.000Z";
function working(taskId: string) {
  return {
    taskId,
    status: "working",
    createdAt,
    lastUpdatedAt: createdAt,
    ttlMs: null,
  };
}
function context(): MCPRequestContext {
  return {
    requestId: 1,
    method: "tools/call",
    params: { name: "work", arguments: { privateArgument: "private input" } },
    localContext: { privateContext: "private context" },
    signal: new AbortController().signal,
  };
}
function completed(taskId: string) {
  return {
    ...working(taskId),
    status: "completed",
    lastUpdatedAt: "2026-10-23T00:00:01.000Z",
    result: { content: [{ type: "text", text: "actual result" }] },
    vendor: { signature: "retained opaque field" },
  };
}

test("released modern tasks drop live origins while preserving stale snapshots and terminal validation", () => {
  const events: ModernTaskEvent[] = [];
  const tasks = new ModernMCPTasks((event) => events.push(event));
  tasks.create(working("one"), context(), undefined, Date.now() + 10000);
  const terminal = tasks.update(completed("one"));
  tasks.release("one");
  assert.equal(
    tasks.get("one"),
    undefined,
    "the live context and its host references are removed",
  );
  assert.deepEqual(
    tasks.update(working("one")),
    terminal,
    "older state returns the full last validated snapshot",
  );
  assert.throws(
    () =>
      tasks.update({
        ...working("one"),
        lastUpdatedAt: terminal.lastUpdatedAt,
      }),
    /terminal state changed/,
  );
  assert.throws(
    () =>
      tasks.create(working("one"), context(), undefined, Date.now() + 10000),
    /ID reused/,
  );
  tasks.update({ ...terminal, lastUpdatedAt: "2026-10-23T00:00:02.000Z" });
  const origin = events.at(-1)!.context;
  assert.equal(origin.localContext, undefined);
  assert.deepEqual(origin.params, {});
  assert.equal(origin.signal.aborted, true);
  tasks.close();
  assert.deepEqual(
    tasks.update(working("one")),
    working("one"),
    "closing discards historical snapshots too",
  );
  assert.throws(() => tasks.reserve(), /closed/);
});

test("unknown modern tasks keep their final-result reservation until a validated terminal result arrives", () => {
  const tasks = new ModernMCPTasks(undefined, {
    maxBytes: 32 * 1024,
    maxMessageBytes: 16 * 1024,
  });
  tasks.create(working("one"), context(), undefined, Date.now() + 10000);
  tasks.unknown("one", "connection result unknown");
  assert.equal(tasks.get("one"), undefined);
  assert.throws(() => tasks.reserve(), /snapshot capacity/);
  tasks.update(completed("one"));
  const reservation = tasks.reserve();
  reservation.release();
  tasks.close();
});

test("terminal metadata growth rejects atomically without changing the retained result or emitting an update", () => {
  const events: ModernTaskEvent[] = [];
  const tasks = new ModernMCPTasks((event) => events.push(event), {
    maxBytes: 32 * 1024,
    maxMessageBytes: 16 * 1024,
  });
  tasks.create(working("one"), context(), undefined, Date.now() + 10000);
  const terminal = tasks.update(completed("one"));
  tasks.release("one");
  const reservation = tasks.reserve();
  const count = events.length;
  const grown = {
    ...terminal,
    lastUpdatedAt: "2026-10-23T00:00:02.000Z",
    statusMessage: "x".repeat(12 * 1024),
  };
  assert.throws(() => tasks.update(grown), { code: "resource_capacity" });
  assert.equal(events.length, count);
  assert.deepEqual(tasks.update(working("one")), terminal);
  reservation.release();
  assert.deepEqual(tasks.update(grown), grown);
  tasks.close();
});

test(
  "modern task admission rejects before sending an additional remote effect and returns unused reservations",
  { timeout: 15000 },
  async () => {
    let calls = 0,
      firstPoll!: () => void,
      finishFirst!: () => void;
    const entered = new Promise<void>((resolve) => (firstPoll = resolve));
    const gate = new Promise<void>((resolve) => (finishFirst = resolve));
    const server = http.createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const message = JSON.parse(Buffer.concat(parts).toString("utf8"));
      let result: unknown;
      if (message.method === "server/discover")
        result = {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { extensions: { [TASKS_EXTENSION]: {} } },
        };
      else if (message.method === "tools/call") {
        if (message.params.name === "fail") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: "expected upstream failure" },
            }),
          );
          return;
        }
        if (message.params.name === "immediate")
          result = {
            resultType: "complete",
            content: [{ type: "text", text: "immediate" }],
          };
        else {
          calls++;
          result = { ...working("task_" + calls), resultType: "task" };
        }
      } else if (message.method === "tasks/get") {
        if (message.params.taskId === "task_1") {
          firstPoll();
          await gate;
        }
        result = {
          ...completed(message.params.taskId),
          resultType: "complete",
          result: { content: [{ type: "text", text: "x".repeat(16 * 1024) }] },
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = new MCPClient({
      transport: "http",
      url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      protocol: "modern",
      taskExtension: true,
      maxMessageBytes: 64 * 1024,
      maxTaskSnapshotBytes: 96 * 1024,
    });
    try {
      await client.connect();
      for (let i = 0; i < 8; i++) {
        await assert.rejects(
          client.callTool({ name: "fail", arguments: {} }),
          /expected upstream failure/,
        );
        assert.equal(
          (await client.callTool({ name: "immediate", arguments: {} })).content
            .length,
          1,
        );
      }
      const first = client.callTool({ name: "work", arguments: {} });
      await entered;
      await assert.rejects(
        client.request("tools/call", { name: "work", arguments: {} }),
        { code: "resource_capacity" },
      );
      assert.equal(calls, 1);
      finishFirst();
      await first;
      await client.callTool({ name: "work", arguments: {} });
      assert.equal(
        calls,
        2,
        "terminal snapshots consume actual bytes, not a permanent full-frame reservation",
      );
      await assert.rejects(client.callTool({ name: "work", arguments: {} }), {
        code: "resource_capacity",
      });
      assert.equal(
        calls,
        2,
        "snapshot exhaustion is detected before the next remote effect",
      );
    } finally {
      finishFirst();
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "HTTP close rejects pending work, reports every task and clears authorization despite failing callbacks",
  { timeout: 15000 },
  async () => {
    let entered!: () => void;
    let disconnected!: () => void;
    const pendingEntered = new Promise<void>((resolve) => (entered = resolve));
    const pendingDisconnected = new Promise<void>(
      (resolve) => (disconnected = resolve),
    );
    let nextTask = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(
        req.headers.authorization,
        "Bearer temporary-test-authorization",
      );
      if (message.method === "tools/list") {
        res.once("close", disconnected);
        entered();
        return;
      }
      const result =
        message.method === "server/discover"
          ? {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: { extensions: { [TASKS_EXTENSION]: {} } },
            }
          : { ...working(`task-${++nextTask}`), resultType: "task" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const unknown: string[] = [];
    const reentered: Promise<void>[] = [];
    let cleanupCalls = 0;
    let closeCalls = 0;
    const client = new MCPClient({
      transport: "http",
      url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      protocol: "modern",
      taskExtension: true,
      authorization: async () => "Bearer temporary-test-authorization",
      cleanup: async () => {
        cleanupCalls++;
        throw new Error("host cleanup failed");
      },
      onTask: (event) => {
        if (event.kind !== "unknown") return;
        unknown.push(event.task.taskId);
        reentered.push(client.close());
        if (unknown.length === 1) throw new Error("task persistence failed");
      },
    });
    const transport = (
      client as unknown as { http: { lastAuthorization?: string } }
    ).http;
    client.onclose = (error) => {
      closeCalls++;
      assert.equal(
        (error as { code?: string })?.code,
        "isolation_cleanup_failed",
      );
      assert.equal(transport.lastAuthorization, undefined);
      throw new Error("close observer failed");
    };
    try {
      await client.connect();
      await client.request("tools/call", { name: "first", arguments: {} });
      await client.request("tools/call", { name: "second", arguments: {} });
      const pending = client.request("tools/list").then(
        () => undefined,
        (error: Error) => error,
      );
      await pendingEntered;
      assert.equal(
        transport.lastAuthorization,
        "Bearer temporary-test-authorization",
      );
      const closing = client.close();
      assert.equal(client.close(), closing);
      assert.ok(reentered.every((promise) => promise === closing));
      let failure: unknown;
      await assert.rejects(
        closing,
        (error: Error & { code?: string; cause?: unknown }) => {
          failure = error;
          assert.equal(error.code, "isolation_cleanup_failed");
          assert.match(error.message, /host cleanup failed/);
          assert.match(error.message, /close observer failed/);
          assert.ok(error.cause instanceof AggregateError);
          return true;
        },
      );
      assert.match((await pending)?.message ?? "", /connection closed/);
      await pendingDisconnected;
      assert.deepEqual(unknown, ["task-1", "task-2"]);
      assert.equal(cleanupCalls, 1);
      assert.equal(closeCalls, 1);
      assert.equal(client.connected, false);
      await assert.rejects(
        client.close(),
        (error: unknown) => error === failure,
      );
    } finally {
      await client.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "stdio close finishes child termination and later cleanup even when the transport reports failure",
  { timeout: 15000 },
  async () => {
    const script = `const {createInterface}=require('node:readline');
    const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);
      if(message.method==='initialize')send({id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{},serverInfo:{name:'close-fixture',version:'1',pid:process.pid}}});
      if(message.method==='tools/list')send({method:'notifications/test-pending',params:{}});
    });`;
    let entered!: () => void;
    const pendingEntered = new Promise<void>((resolve) => (entered = resolve));
    let cleanupCalls = 0;
    let closeCalls = 0;
    const client = new MCPClient({
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
      cleanup: async () => {
        cleanupCalls++;
      },
    });
    client.onnotification = (method) => {
      if (method === "notifications/test-pending") entered();
    };
    client.onclose = () => {
      closeCalls++;
    };
    try {
      await client.connect();
      const pid = Number(client.serverInfo.pid);
      process.kill(pid, 0);
      const transport = (
        client as unknown as {
          stdio: { close(): Promise<void>; child: ChildProcess };
        }
      ).stdio;
      const exited = once(transport.child, "close");
      const originalClose = transport.close.bind(transport);
      transport.close = async () => {
        await originalClose();
        throw new Error("transport stop reported failure");
      };
      const pending = client.request("tools/list").then(
        () => undefined,
        (error: Error) => error,
      );
      await pendingEntered;
      const closing = client.close();
      await assert.rejects(closing, { code: "isolation_cleanup_failed" });
      await exited;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.match((await pending)?.message ?? "", /connection closed/);
      assert.equal(cleanupCalls, 1);
      assert.equal(closeCalls, 1);
      assert.equal(client.close(), closing);
      await assert.rejects(client.close(), /transport stop reported failure/);
    } finally {
      await client.close().catch(() => undefined);
    }
  },
);

test(
  "legacy HTTP session cleanup still sends DELETE after host cleanup and notification callbacks fail",
  { timeout: 15000 },
  async () => {
    let deletes = 0;
    let authorizations = 0;
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        deletes++;
        assert.equal(req.headers.authorization, "Bearer legacy-close-test");
        assert.equal(req.headers["mcp-session-id"], "cleanup-session");
        res.writeHead(204);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "MCP-Session-Id": "cleanup-session",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: {},
            serverInfo: { name: "legacy-close", version: "1" },
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = new MCPClient({
      transport: "http",
      url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      authorization: async () => {
        authorizations++;
        return "Bearer legacy-close-test";
      },
      cleanup: async () => {
        throw new Error("legacy host cleanup failed");
      },
    });
    client.onnotification = (method) => {
      if (method === "transport/cleanup_error")
        throw new Error("cleanup notification failed");
    };
    try {
      await client.connect();
      const before = authorizations;
      await assert.rejects(
        client.close(),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, "isolation_cleanup_failed");
          assert.match(error.message, /legacy host cleanup failed/);
          assert.match(error.message, /cleanup notification failed/);
          return true;
        },
      );
      assert.equal(deletes, 1);
      assert.equal(
        authorizations,
        before,
        "shutdown reuses the cached authorization without starting a token exchange",
      );
      assert.equal(
        (client as unknown as { http: { lastAuthorization?: string } }).http
          .lastAuthorization,
        undefined,
      );
    } finally {
      await client.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
