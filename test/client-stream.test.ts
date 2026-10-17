import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FoundationClient, FoundationHttpError } from "../src/client.js";
import { setup } from "./support/wire-server.js";

test("client reconnects only GET streams with a durable cursor and deduplicates replayed events", async () => {
  const after: string[] = [];
  let calls = 0;
  const event = (seq: number, type: string) => ({
    schemaVersion: 1,
    id: "e" + seq,
    runId: "stream-run",
    sessionId: "s",
    type,
    timestamp: new Date().toISOString(),
    seq,
    data: {},
  });
  const frame = (seq: number, type: string) =>
    `id: ${seq}\r\nevent: ${type}\r\ndata: ${JSON.stringify(event(seq, type))}\r\n\r\n`;
  const server = http.createServer((req, res) => {
    calls++;
    after.push(
      new URL(req.url!, "http://localhost").searchParams.get("after")!,
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      calls === 1
        ? frame(1, "assistant.message.committed")
        : frame(1, "assistant.message.committed") +
            frame(2, "tool.settled") +
            frame(3, "run.completed"),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const client = new FoundationClient(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "private-host-token",
    );
    assert.equal(JSON.stringify(client).includes("private-host-token"), false);
    const events = [];
    for await (const event of client.events("stream-run", 0, undefined, {
      retryMs: 1,
      maxReconnects: 2,
    }))
      events.push(event);
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2, 3],
    );
    assert.deepEqual(after, ["0", "1"]);
    assert.equal(calls, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("event delivery handles a large durable replay and live completion without discarding its initial event", async () => {
  const x = await setup();
  try {
    const s = await x.session(),
      time = new Date().toISOString();
    x.kernel.store.put("runs", {
      id: "run_backpressure",
      sessionId: s.id,
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    x.kernel.store.emit("run_backpressure", "large.payload", {
      value: "x".repeat(2 * 1024 * 1024),
    });
    const events: any[] = [];
    const reading = (async () => {
      for await (const e of x.client.events("run_backpressure")) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 20));
    x.kernel.store.status("run_backpressure", "completed");
    x.kernel.store.emit("run_backpressure", "run.completed", {
      status: "completed",
    });
    await reading;
    assert.equal(events[0].data.value.length, 2 * 1024 * 1024);
    assert.equal(events.at(-1).type, "run.completed");
    assert.equal(
      new Set(events.filter((e) => e.seq !== null).map((e) => e.seq)).size,
      events.filter((e) => e.seq !== null).length,
    );
  } finally {
    await x.close();
  }
});
test("structured HTTP errors preserve status and code, and permanent auth failures are never retried", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "unauthorized", message: "token required" },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const client = new FoundationClient(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "invalid",
    );
    await assert.rejects(
      async () => {
        for await (const _event of client.events("x")) {
        }
      },
      (error: any) =>
        error instanceof FoundationHttpError &&
        error.status === 401 &&
        error.code === "unauthorized",
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
