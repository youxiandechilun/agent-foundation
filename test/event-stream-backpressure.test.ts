import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { streamRunEvents } from "../src/api/events.js";
import { FoundationClient } from "../src/client.js";
import type { FoundationEvent } from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { listenHttp } from "../src/transport/http-listener.js";
import { decodeEventStream } from "../src/transport/sse.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "foundation-sse-queue-"));
  const store = new Store(directory),
    runId = "stream";
  store.put("runs", { id: runId, sessionId: "session", status: "running" });
  const responses: http.ServerResponse[] = [],
    pending: Promise<void>[] = [];
  let drains = 0,
    blockedWrites = 0;
  const server = http.createServer(
    { highWaterMark: 1024 },
    (request, response) => {
      responses.push(response);
      response.on("drain", () => drains++);
      const write = response.write;
      response.write = (chunk: unknown, ...args: unknown[]) => {
        const accepted = Reflect.apply(write, response, [
          chunk,
          ...args,
        ]) as boolean;
        if (!accepted) blockedWrites++;
        return accepted;
      };
      const cursor = Number(
        new URL(request.url!, "http://localhost").searchParams.get("after") ||
          0,
      );
      pending.push(streamRunEvents(store, runId, cursor, response));
    },
  );
  const { port } = await listenHttp(server, { host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(pending);
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = () =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(url + "/v1/runs/stream/events", (response) => {
          response.pause();
          resolve(response);
        })
        .once("error", reject);
    });
  const complete = () => {
    store.put("runs", { ...store.run(runId), status: "completed" });
    return store.emit(runId, "run.completed", {});
  };
  return {
    store,
    runId,
    responses,
    pending,
    url,
    open,
    complete,
    drains: () => drains,
    blockedWrites: () => blockedWrites,
  };
}

async function consume(response: http.IncomingMessage) {
  const events: { seq: number | null; type: string; index?: number }[] = [];
  const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
  // The fixture explicitly paused the socket; resume only after the adapter owns its data listeners.
  response.resume();
  for await (const frame of decodeEventStream(stream, {
    maxFrameChars: 64 * 1024 * 1024,
  })) {
    const event = JSON.parse(frame.data) as FoundationEvent;
    events.push({
      seq: event.seq,
      type: event.type,
      index: event.data.index as number | undefined,
    });
    if (events.length % 1000 === 0) await delay(1);
  }
  return events;
}

test(
  "real paused HTTP consumer drains a large live backlog in order after its replay watermark",
  { timeout: 60000 },
  async (t) => {
    const x = await fixture(t);
    const first = x.store.emit(x.runId, "replay", {
      value: "x".repeat(6 * 1024 * 1024),
    });
    const incoming = await x.open();
    const count = 40000;
    for (let index = 0; index < count; index++)
      x.store.events.emit(x.runId, {
        schemaVersion: 1,
        id: "live-" + index,
        runId: x.runId,
        sessionId: "session",
        seq: null,
        type: "live",
        timestamp: "2026-10-18T00:00:00.000Z",
        data: { index, value: "汉".repeat(10) },
      } satisfies FoundationEvent);
    const final = x.complete();
    assert.ok(
      x.blockedWrites() > 0,
      "the real server socket reached backpressure",
    );
    await delay(30);
    const events = await consume(incoming);
    assert.equal(events.length, count + 2);
    assert.equal(events[0].seq, first.seq);
    assert.deepEqual(
      events.slice(1, -1).map((event) => event.index),
      Array.from({ length: count }, (_, index) => index),
    );
    assert.equal(events.at(-1)!.seq, final.seq);
    assert.equal(events.at(-1)!.type, "run.completed");
    assert.ok(x.drains() > 0);
    await Promise.all(x.pending);
    assert.equal(x.store.events.listenerCount(x.runId), 0);
  },
);

test(
  "UTF-8 live queue overflow closes the slow HTTP stream and durable reconnect fills every remaining sequence",
  { timeout: 60000 },
  async (t) => {
    const x = await fixture(t);
    const replayed = 16;
    x.store.transaction(() => {
      for (let index = 0; index < replayed; index++)
        x.store.emit(x.runId, "replay", { value: "x".repeat(2 * 1024 * 1024) });
    });
    const incoming = await x.open();
    const count = 1000;
    x.store.transaction(() => {
      for (let index = 0; index < count; index++)
        x.store.emit(x.runId, "live", { index, value: "汉".repeat(6000) });
    });
    const final = x.complete();
    assert.equal(x.responses[0].writableNeedDrain, true);
    await delay(30);
    const received = await consume(incoming);
    assert.notEqual(
      received.at(-1)!.type,
      "run.completed",
      "overflow ends this connection before settlement",
    );
    assert.ok(received.length >= 1 && received.length < count);
    const client = new FoundationClient(x.url, "unused");
    for await (const event of client.events(x.runId, received.at(-1)!.seq!))
      received.push({
        seq: event.seq,
        type: event.type,
        index: event.data.index as number | undefined,
      });
    assert.equal(received.at(-1)!.seq, final.seq);
    assert.deepEqual(
      received.map((event) => event.seq),
      Array.from({ length: count + replayed + 1 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      received
        .filter((event) => event.type === "live")
        .map((event) => event.index),
      Array.from({ length: count }, (_, index) => index),
    );
    await Promise.all(x.pending);
    assert.equal(x.store.events.listenerCount(x.runId), 0);
  },
);

test(
  "disconnecting a genuinely blocked HTTP consumer releases the event subscription and drain waiter",
  { timeout: 10000 },
  async (t) => {
    const x = await fixture(t);
    x.store.emit(x.runId, "replay", { value: "initial" });
    const incoming = await x.open();
    await Promise.all(x.pending);
    x.store.emit(x.runId, "queued", { value: "x".repeat(6 * 1024 * 1024) });
    assert.equal(x.responses[0].writableNeedDrain, true);
    const closed = once(x.responses[0], "close");
    incoming.destroy();
    await closed;
    await Promise.all(x.pending);
    assert.equal(x.store.events.listenerCount(x.runId), 0);
    assert.equal(
      x.responses[0].listenerCount("drain"),
      1,
      "only the fixture observer remains",
    );
  },
);
