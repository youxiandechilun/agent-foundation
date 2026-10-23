import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { MCPClient } from "../src/extensions/mcp/client.js";
import {
  ModernMCPTasks,
  TASKS_EXTENSION,
} from "../src/extensions/mcp/tasks/modern.js";
import type { MCPRequestContext } from "../src/extensions/mcp/protocol.js";

const createdAt = "2026-10-23T00:00:00.000Z";
const updatedAt = "2026-10-23T00:00:01.000Z";
const working = {
  taskId: "short-numbers",
  status: "working",
  createdAt,
  lastUpdatedAt: createdAt,
  ttlMs: null,
};
const context = (): MCPRequestContext => ({
  requestId: 1,
  method: "tools/call",
  params: { name: "work", arguments: { retained: "private" } },
  localContext: { private: "origin" },
  signal: new AbortController().signal,
});

async function withoutRawJSON<T>(
  disabled: boolean,
  work: () => T | Promise<T>,
) {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, "rawJSON");
  if (disabled)
    Object.defineProperty(JSON, "rawJSON", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  try {
    return await work();
  } finally {
    if (descriptor) Object.defineProperty(JSON, "rawJSON", descriptor);
    else delete (JSON as typeof JSON & { rawJSON?: unknown }).rawJSON;
  }
}

for (const fallback of [false, true]) {
  test(`modern task snapshots preserve numeric values and opaque strings on single release ${fallback ? "without rawJSON" : "with the available JSON encoder"}`, async () =>
    withoutRawJSON(fallback, () => {
      const tasks = new ModernMCPTasks(undefined, {
        maxBytes: 16 * 1024,
        maxMessageBytes: 2048,
      });
      tasks.create(working, context(), undefined, Date.now() + 10000);
      const terminal = {
        ...working,
        status: "completed",
        lastUpdatedAt: updatedAt,
        result: {
          content: [],
          structuredContent: {
            numbers: [
              ...Array<number>(100).fill(1e20),
              -0,
              1e-6,
              Number.MIN_VALUE,
              Number.MAX_VALUE,
              -1.2345678901234567e20,
            ],
            text: '100000000000000000000 "1e20" \\1e20 \u0000foundation-number:n:1e20',
            "100000000000000000000": "100000000000000000000",
          },
        },
      };
      tasks.update(terminal);
      const snapshot = tasks.get(working.taskId)!.snapshot;
      assert.ok(snapshot.length <= 2048);
      tasks.release(working.taskId);
      assert.equal(tasks.get(working.taskId), undefined);
      const stale = tasks.update(working);
      assert.deepEqual(
        stale,
        JSON.parse(JSON.stringify(terminal)),
        "numeric text and keys remain unchanged; -0 follows native JSON semantics",
      );
      const structured = stale.result!.structuredContent as {
        numbers: number[];
      };
      assert.equal(Object.is(structured.numbers[100], 0), true);
      tasks.close();
    }));

  test(
    `real HTTP modern tasks accept compact exponent frames and return their stale full result ${fallback ? "without rawJSON" : "with the available JSON encoder"}`,
    { timeout: 10000 },
    async () =>
      withoutRawJSON(fallback, async () => {
        const numbers = Array<number>(100).fill(1e20);
        let polls = 0;
        const frameBytes: number[] = [];
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
          else if (message.method === "tools/call")
            result = { ...working, resultType: "task" };
          else if (message.method === "tasks/get")
            result =
              ++polls === 1
                ? {
                    ...working,
                    status: "completed",
                    lastUpdatedAt: updatedAt,
                    resultType: "complete",
                    result: {
                      content: [{ type: "text", text: "done" }],
                      structuredContent: { numbers },
                    },
                  }
                : { ...working, resultType: "complete" };
          const frame = JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          }).replaceAll("100000000000000000000", "1e20");
          frameBytes.push(Buffer.byteLength(frame));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(frame);
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const client = new MCPClient({
          transport: "http",
          url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
          protocol: "modern",
          taskExtension: true,
          maxMessageBytes: 1024,
          maxTaskSnapshotBytes: 16 * 1024,
        });
        try {
          await client.connect();
          const result = await client.callTool({ name: "work", arguments: {} });
          assert.deepEqual(
            (result.structuredContent as { numbers: number[] }).numbers,
            numbers,
          );
          const stale = await client.taskGet(working.taskId);
          assert.equal(stale.status, "completed");
          assert.deepEqual(
            (stale.result as { structuredContent: { numbers: number[] } })
              .structuredContent.numbers,
            numbers,
          );
          assert.ok(frameBytes.every((bytes) => bytes <= 1024));
          assert.equal(client.connected, true);
        } finally {
          await client.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }),
  );
}

test("modern task create and active updates reject oversized snapshots before notification or mutation", () => {
  let notifications = 0;
  const tasks = new ModernMCPTasks(() => notifications++, {
    maxBytes: 16 * 1024,
    maxMessageBytes: 1024,
  });
  assert.throws(
    () =>
      tasks.create(
        { ...working, statusMessage: "x".repeat(1024) },
        context(),
        undefined,
        Date.now() + 10000,
      ),
    /snapshot exceeds message limit/,
  );
  assert.equal(notifications, 0);
  assert.equal(tasks.get(working.taskId), undefined);
  tasks.create(
    { ...working, lastUpdatedAt: updatedAt },
    context(),
    undefined,
    Date.now() + 10000,
  );
  const entry = tasks.get(working.taskId)!;
  const prior = entry.task;
  const snapshot = entry.snapshot;
  assert.throws(
    () =>
      tasks.update({
        ...working,
        status: "completed",
        lastUpdatedAt: "2026-10-23T00:00:02.000Z",
        result: { content: [{ type: "text", text: "x".repeat(1024) }] },
      }),
    /snapshot exceeds message limit/,
  );
  assert.equal(notifications, 1);
  assert.equal(entry.task, prior);
  assert.equal(entry.snapshot, snapshot);
  assert.equal(entry.finalValidated, false);
  tasks.release(working.taskId);
  assert.equal(tasks.get(working.taskId), undefined);
  assert.deepEqual(tasks.update(working), prior);
  tasks.close();
});

test("a creation observer closing the tracker cannot revive its live origin", () => {
  let signal: AbortSignal | undefined;
  const tasks = new ModernMCPTasks((event) => {
    if (event.kind === "created") {
      signal = event.context.signal;
      tasks.close();
    }
  });
  assert.throws(
    () => tasks.create(working, context(), undefined, Date.now() + 10000),
    /closed during creation/,
  );
  assert.equal(tasks.get(working.taskId), undefined);
  assert.equal(signal?.aborted, true);
  assert.throws(() => tasks.reserve(), /closed/);
});

for (const action of ["close", "release"] as const)
  test(`an update observer can ${action} its owner without a late state commit`, () => {
    const tasks = new ModernMCPTasks((event) => {
      if (event.kind === "updated") {
        if (action === "close") tasks.close();
        else tasks.release(event.task.taskId);
      }
    });
    const prior = { ...working, lastUpdatedAt: updatedAt };
    tasks.create(prior, context(), undefined, Date.now() + 10000);
    const entry = tasks.get(working.taskId)!;
    tasks.update({
      ...working,
      status: "completed",
      lastUpdatedAt: "2026-10-23T00:00:02.000Z",
      result: { content: [] },
    });
    assert.equal(tasks.get(working.taskId), undefined);
    assert.deepEqual(entry.task, prior);
    if (action === "release") assert.deepEqual(tasks.update(working), prior);
    tasks.close();
  });
