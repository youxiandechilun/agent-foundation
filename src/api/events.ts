import type { ServerResponse } from "node:http";
import type { FoundationEvent } from "../contracts.js";
import { terminalStatuses } from "../contracts.js";
import { Store } from "../storage/store.js";

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
    head = 0,
    last = after,
    blocked = false;
  const queue: (
    { event: FoundationEvent; payload: string; bytes: number } | undefined
  )[] = [];
  const payload = (event: FoundationEvent) =>
    `${event.seq !== null ? `id: ${event.seq}\n` : ""}event: ${event.type}\ndata: ${store.eventJson(event)}\n\n`;
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
      while (head < queue.length && !closed && !res.writableEnded) {
        const item = queue[head]!;
        queue[head++] = undefined;
        queuedBytes -= item.bytes;
        // Release payloads immediately; moving the remaining half amortizes to linear work.
        if (head >= 1024 && head * 2 >= queue.length) {
          queue.splice(0, head);
          head = 0;
        }
        await write(item.event, item.payload);
      }
      if (overflow && !closed && !res.writableEnded) res.end();
    } finally {
      if (head === queue.length) {
        queue.length = 0;
        head = 0;
      }
      draining = false;
    }
  };
  const receive = (event: FoundationEvent) => {
    if (closed || overflow || res.writableEnded) return;
    const data = payload(event),
      bytes = Buffer.byteLength(data);
    if (queuedBytes + bytes > 16 * 1024 * 1024) {
      overflow = true;
      if (!replaying) void drain().catch(() => res.destroy());
      return;
    }
    queue.push({ event, payload: data, bytes });
    queuedBytes += bytes;
    if (!replaying) void drain().catch(() => res.destroy());
  };
  store.events.on(runId, receive);
  const heartbeat = setInterval(() => {
    if (!closed && !blocked && !res.writableEnded && head === queue.length)
      res.write(": heartbeat\n\n");
  }, 15000);
  res.once("close", () => {
    closed = true;
    clearInterval(heartbeat);
    store.events.off(runId, receive);
    queue.length = 0;
    head = queuedBytes = 0;
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
    // Reconnect before live events can advance past history that was not replayed.
    if (overflow && cursor < watermark) {
      if (!closed && !res.writableEnded) res.end();
      return;
    }
    replaying = false;
    await drain();
    if (
      !closed &&
      !res.writableEnded &&
      terminalStatuses.has(store.run(runId).status) &&
      head === queue.length
    )
      res.end();
  } catch (e) {
    res.destroy();
    throw e;
  }
}
