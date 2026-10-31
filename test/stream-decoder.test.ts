import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { decodeEventStream } from "../src/transport/sse.js";
import { sse } from "../src/providers/sse.js";
import { FoundationClient } from "../src/client.js";

function stream(text: string, chunkSize = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset = Math.min(bytes.length, offset + chunkSize);
    },
  });
}

test("shared SSE decoder preserves mixed line endings, split Unicode and final events", async () => {
  const source =
    "\uFEFF: comment\r\nevent: delta\rid: valid\nid: bad\0id\r\ndata: 中文😀\r\ndata\rdata: tail\r\rdata: eof";
  for (const chunkSize of [1, 2, 7, 256]) {
    const events = [];
    for await (const event of sse(new Response(stream(source, chunkSize))))
      events.push(event);
    assert.deepEqual(events, [
      { event: "delta", id: "valid", data: "中文😀\n\ntail" },
      { data: "eof", unterminated: true },
    ]);
  }
});

test("SSE limits apply to individual frames across chunks and enforce total bytes", async () => {
  const read = async (
    text: string,
    maxFrameChars: number,
    maxBytes?: number,
  ) => {
    const events = [];
    for await (const event of decodeEventStream(stream(text, 1024), {
      maxFrameChars,
      maxBytes,
    }))
      events.push(event);
    return events;
  };
  assert.equal((await read("data: x\n\n".repeat(100), 7)).length, 100);
  await assert.rejects(read("data: xx", 7), /frame exceeds/);
  await assert.rejects(read(": " + "x".repeat(20), 7), /frame exceeds/);
  await assert.rejects(read("data: x\n\n".repeat(100), 7, 80), /byte limit/);
});

test("MCP frames preserve empty cursor events, bounded retry and UTF-8 byte limits across every split", async () => {
  const source = "id: resume\r\nretry: 99999\r\n\r\ndata: 中文😀\r\n\r\n";
  for (const chunkSize of [1, 2, 3, 7, 1024]) {
    const events = [];
    const body = stream(source, chunkSize);
    for await (const event of decodeEventStream(body, {
      maxFrameChars: 100,
      maxFrameBytes: 23,
      emitEmptyFrames: true,
    }))
      events.push(event);
    assert.deepEqual(events, [
      { data: "", id: "resume", retry: 30000 },
      { data: "中文😀" },
    ]);
    assert.equal(body.locked, false);
    await assert.rejects(async () => {
      for await (const _ of decodeEventStream(
        stream("data: 中文😀\n\n", chunkSize),
        {
          maxFrameChars: 100,
          maxFrameBytes: 15,
          emitEmptyFrames: true,
        },
      )) {
        /* Every chunking must reject this 16-byte frame. */
      }
    }, /frame exceeds limit/);
  }
});

test("SSE abort interrupts an idle reader and early consumer exit releases its lock", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const idle = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const events = decodeEventStream(idle, {
    signal: controller.signal,
    maxFrameChars: 128,
  });
  const pending = events.next();
  const reason = new Error("cancel idle stream");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(cancelled, 1);
  assert.equal(idle.locked, false);

  const body = stream("data: first\n\ndata: second\n\n", 12);
  for await (const event of decodeEventStream(body, { maxFrameChars: 128 })) {
    assert.equal(event.data, "first");
    break;
  }
  assert.equal(body.locked, false);
});

test("SSE cancellation stops buffered events and cleans up an already-aborted input", async () => {
  const controller = new AbortController();
  const body = stream("data: first\n\ndata: second\n\n", 100);
  const events = decodeEventStream(body, {
    signal: controller.signal,
    maxFrameChars: 100,
  });
  assert.equal((await events.next()).value?.data, "first");
  controller.abort(new Error("stop buffered events"));
  await assert.rejects(events.next(), /stop buffered events/);
  assert.equal(body.locked, false);

  let cancelled = false;
  const unopened = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    decodeEventStream(unopened, {
      signal: controller.signal,
      maxFrameChars: 100,
    }).next(),
    /stop buffered events/,
  );
  assert.equal(cancelled, true);
  assert.equal(unopened.locked, false);
});

test("fetch client accepts coalesced bounded frames and validates complete event envelopes over HTTP", async () => {
  let malformed = false;
  const server = http.createServer((_req, res) => {
    const frame = (seq: number, type: string) =>
      "data: " +
      JSON.stringify({
        schemaVersion: 1,
        id: `e${seq}`,
        runId: "r",
        sessionId: "s",
        seq,
        timestamp: new Date(0).toISOString(),
        type,
        data: {},
        ...(malformed ? { data: null } : {}),
      }) +
      "\r\n\r\n";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame(1, "tool.settled") +
        frame(2, "tool.settled") +
        frame(3, "run.completed"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new FoundationClient(
      `http://127.0.0.1:${address.port}`,
      "token",
    );
    const read = async () => {
      const result = [];
      for await (const event of client.events("r", 0, undefined, {
        reconnect: false,
        maxFrameChars: 200,
      }))
        result.push(event);
      return result;
    };
    assert.deepEqual(
      (await read()).map((event) => event.seq),
      [1, 2, 3],
    );
    malformed = true;
    await assert.rejects(read(), /Invalid foundation event frame/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
