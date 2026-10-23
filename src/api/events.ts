import type { ServerResponse } from "node:http";
import type { FoundationEvent } from "../contracts.js";
import { terminalStatuses } from "../contracts.js";
import { Store } from "../storage/store.js";
import { invariant } from "../core/util.js";
import type { Config } from "../core/config.js";

type StreamLimits = Pick<
  Config["limits"],
  | "maxSseSubscribers"
  | "maxSseSubscribersPerRun"
  | "maxSseBufferBytes"
  | "maxSseConnectionBytes"
  | "sseDrainTimeoutMs"
>;
const defaults: StreamLimits = {
  maxSseSubscribers: 128,
  maxSseSubscribersPerRun: 16,
  maxSseBufferBytes: 64 * 1024 * 1024,
  maxSseConnectionBytes: 16 * 1024 * 1024,
  sseDrainTimeoutMs: 30000,
};
const budgets = new WeakMap<
  Store,
  { count: number; bytes: number; runs: Map<string, number> }
>();

/** Backpressure-aware delivery with a fixed replay watermark and a bounded live queue. */
export async function streamRunEvents(
  store: Store,
  runId: string,
  after: number,
  res: ServerResponse,
  limits: StreamLimits = defaults,
) {
  let budget = budgets.get(store);
  if (!budget) {
    budget = { count: 0, bytes: 0, runs: new Map() };
    budgets.set(store, budget);
  }
  const runCount = budget.runs.get(runId) ?? 0;
  invariant(
    budget.count < limits.maxSseSubscribers &&
      runCount < limits.maxSseSubscribersPerRun,
    "Event subscription capacity reached",
    429,
    "stream_capacity",
  );
  budget.count++;
  budget.runs.set(runId, runCount + 1);
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
    reservedBytes = 0,
    head = 0,
    last = after,
    blocked = false;
  const queue: (
    { event: FoundationEvent; payload: string; bytes: number } | undefined
  )[] = [];
  const payload = (event: FoundationEvent) =>
    `${event.seq !== null ? `id: ${event.seq}\n` : ""}event: ${event.type}\ndata: ${store.eventJson(event)}\n\n`;
  const releaseBytes = (bytes: number) => {
    const released = Math.min(bytes, reservedBytes);
    reservedBytes -= released;
    budget.bytes -= released;
  };
  const reserveBytes = (bytes: number) => {
    if (
      reservedBytes + bytes > limits.maxSseConnectionBytes ||
      budget.bytes + bytes > limits.maxSseBufferBytes
    )
      return false;
    reservedBytes += bytes;
    budget.bytes += bytes;
    return true;
  };
  const write = async (
    event: FoundationEvent,
    data = payload(event),
    reserved = false,
  ) => {
    if (closed || res.destroyed || res.writableEnded) return;
    if (event.seq !== null && event.seq <= last) return;
    const bytes = Buffer.byteLength(data);
    if (!reserved && !reserveBytes(bytes)) {
      overflow = true;
      res.end();
      return false;
    }
    try {
      let written = false;
      let resume: (() => void) | undefined;
      const accepted = res.write(data, (error?: Error | null) => {
        written = true;
        if (error) res.destroy();
        // A chunked HTTP response can cross its high-water mark while its
        // underlying socket does not. Node may complete the write without
        // emitting drain; an empty buffer is the same safe point to resume.
        if (error || res.writableLength === 0) resume?.();
      });
      if (!accepted) {
        blocked = true;
        await new Promise<void>((resolve) => {
          const finish = () => {
            resume = undefined;
            res.off("drain", finish);
            res.off("close", finish);
            clearTimeout(timer);
            resolve();
          };
          resume = finish;
          res.once("drain", finish);
          res.once("close", finish);
          const timer = setTimeout(() => {
            res.destroy();
            finish();
          }, limits.sseDrainTimeoutMs).unref();
          if (
            res.destroyed ||
            res.writableEnded ||
            (written && res.writableLength === 0)
          )
            finish();
        });
        blocked = false;
      }
      if (event.seq !== null) last = event.seq;
      if (event.type === "run.completed" && !res.writableEnded) res.end();
      return true;
    } finally {
      if (!reserved) releaseBytes(bytes);
    }
  };
  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (head < queue.length && !closed && !res.writableEnded) {
        const item = queue[head]!;
        queue[head++] = undefined;
        // Release payloads immediately; moving the remaining half amortizes to linear work.
        if (head >= 1024 && head * 2 >= queue.length) {
          queue.splice(0, head);
          head = 0;
        }
        try {
          await write(item.event, item.payload, true);
        } finally {
          releaseBytes(item.bytes);
        }
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
    if (!reserveBytes(bytes)) {
      overflow = true;
      if (!replaying) void drain().catch(() => res.destroy());
      return;
    }
    queue.push({ event, payload: data, bytes });
    if (!replaying) void drain().catch(() => res.destroy());
  };
  store.events.on(runId, receive);
  const heartbeat = setInterval(() => {
    if (!closed && !blocked && !res.writableEnded && head === queue.length)
      if (!res.write(": heartbeat\n\n")) res.destroy();
  }, 15000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    store.events.off(runId, receive);
    queue.length = 0;
    head = 0;
    releaseBytes(reservedBytes);
    budget.count--;
    const remaining = (budget.runs.get(runId) ?? 1) - 1;
    if (remaining) budget.runs.set(runId, remaining);
    else budget.runs.delete(runId);
  };
  res.once("close", cleanup);
  res.once("finish", cleanup);
  const watermark = store.eventCursor(runId);
  try {
    let cursor = after;
    while (!closed && !res.writableEnded && cursor < watermark) {
      const batch = store.replay(runId, cursor, 256, watermark, 1024 * 1024);
      if (!batch.length) break;
      for (const event of batch) {
        const written = await write(event);
        if (!written) break;
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
    cleanup();
    res.destroy();
    throw e;
  }
}
