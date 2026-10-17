import type { ServerResponse } from "node:http";
import type { FoundationEvent } from "./contracts.js";
import { terminalStatuses } from "./contracts.js";
import { Store } from "./store.js";

/** Backpressure-aware delivery with a fixed replay watermark and a bounded live queue. */
export async function streamRunEvents(
  store: Store,
  runId: string,
  after: number,
  res: ServerResponse,
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false,
    replaying = true,
    draining = false,
    overflow = false,
    queuedBytes = 0,
    last = after,
    blocked = false;
  const queue: { event: FoundationEvent; payload: string }[] = [];
  const payload = (event: FoundationEvent) =>
    `${event.seq !== null ? `id: ${event.seq}\n` : ""}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const write = async (event: FoundationEvent, data = payload(event)) => {
    if (closed || res.destroyed || res.writableEnded) return;
    if (event.seq !== null && event.seq <= last) return;
    if (!res.write(data)) {
      blocked = true;
      await new Promise<void>((resolve) => {
        const finish = () => {
          res.off("drain", finish);
          res.off("close", finish);
          resolve();
        };
        res.once("drain", finish);
        res.once("close", finish);
      });
      blocked = false;
    }
    if (event.seq !== null) last = event.seq;
    if (event.type === "run.completed" && !res.writableEnded) res.end();
  };
  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (queue.length && !closed && !res.writableEnded) {
        const item = queue.shift()!;
        queuedBytes -= Buffer.byteLength(item.payload);
        await write(item.event, item.payload);
      }
      if (overflow && !closed && !res.writableEnded) res.end();
    } finally {
      draining = false;
    }
  };
  const receive = (event: FoundationEvent) => {
    if (closed || overflow || res.writableEnded) return;
    const data = payload(event);
    if (queuedBytes + Buffer.byteLength(data) > 16 * 1024 * 1024) {
      overflow = true;
      if (!replaying) void drain().catch(() => res.destroy());
      return;
    }
    queue.push({ event, payload: data });
    queuedBytes += Buffer.byteLength(data);
    if (!replaying) void drain().catch(() => res.destroy());
  };
  store.events.on(runId, receive);
  const heartbeat = setInterval(() => {
    if (!closed && !blocked && !res.writableEnded && !queue.length)
      res.write(": heartbeat\n\n");
  }, 15000);
  res.once("close", () => {
    closed = true;
    clearInterval(heartbeat);
    store.events.off(runId, receive);
    queue.length = 0;
  });
  const watermark = store.eventCursor(runId);
  try {
    let cursor = after;
    while (!closed && !res.writableEnded && cursor < watermark) {
      const batch = store.replay(runId, cursor, 256, watermark);
      if (!batch.length) break;
      for (const event of batch) {
        await write(event);
        cursor = event.seq!;
        if (closed || res.writableEnded || overflow) break;
      }
      if (overflow) break;
    }
    replaying = false;
    await drain();
    if (
      !closed &&
      !res.writableEnded &&
      terminalStatuses.has(store.run(runId).status) &&
      !queue.length
    )
      res.end();
  } catch (e) {
    res.destroy();
    throw e;
  }
}
