import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Store } from "../src/storage/store.js";
import { loadRunHistory } from "../src/core/kernel/run-setup.js";
import { KeyedQueue } from "../src/runtime/keyed-queue.js";
import { streamRunEvents } from "../src/api/events.js";
import {
  RedactionScope,
  registerSecret,
  redactSecrets,
  processSecretSnapshot,
} from "../src/core/util.js";
import { setup, until } from "./support/wire-server.js";
import type { Message } from "../src/runtime/types.js";

async function storage(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-capacity-"));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  return store;
}

test("history checkpoints load a bounded tail, survive append/restart and invalidate changed prefixes", async (t) => {
  const store = await storage(t);
  for (let i = 0; i < 40; i++)
    store.appendTranscript("s", {
      id: `m${i}`,
      runId: "r",
      message: { role: "user", content: "x".repeat(256), timestamp: i },
    });
  const full = store.transcript("s");
  const summary: Message = {
    role: "user",
    content: "<continuation_summary>earlier work</continuation_summary>",
    timestamp: 1,
  };
  assert.ok(
    store.saveHistoryCheckpoint("s", "text", full[29].message, summary),
  );
  store.appendTranscript("s", {
    id: "fresh",
    runId: "r",
    message: { role: "user", content: "new", timestamp: 50 },
  });
  const options = { routeId: "text", maxBytes: 6000 };
  assert.equal(loadRunHistory(store, "s", 100, options).length, 12);
  const checkpoint = store.historyCheckpoint("s", "text")!;
  const tail = store.transcriptWindow("s", checkpoint.throughSeq);
  store.saveTranscript("s", tail.slice(0, -1), checkpoint.throughSeq);
  assert.ok(store.historyCheckpoint("s", "text"));
  const filename = String(store.db.prepare("PRAGMA database_list").get()!.file);
  const reader = new Store(path.dirname(filename));
  try {
    assert.equal(loadRunHistory(reader, "s", 100, options).length, 11);
  } finally {
    reader.close();
  }
  assert.equal(loadRunHistory(store, "s", 100, options).length, 11);
  store.transaction(() => {
    store.db
      .prepare("UPDATE messages SET body=? WHERE session_id=? AND message_id=?")
      .run(
        JSON.stringify({
          ...full[0],
          message: { role: "user", content: "changed", timestamp: 0 },
        }),
        "s",
        "m0",
      );
  });
  assert.equal(store.historyCheckpoint("s", "text"), undefined);
  assert.throws(() => loadRunHistory(store, "s", 100, options), /byte budget/);
  assert.equal(
    store.saveHistoryCheckpoint("s", "text", full[29].message, summary),
    false,
  );
  const call: Message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "work", arguments: {} }],
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 100,
  };
  store.appendTranscript("s", { id: "call", runId: "r", message: call });
  assert.equal(store.saveHistoryCheckpoint("s", "text", call, summary), false);
  const result: Message = {
    role: "toolResult",
    toolName: "work",
    toolCallId: "call",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 101,
  };
  store.appendTranscript("s", { id: "result", runId: "r", message: result });
  assert.equal(store.saveHistoryCheckpoint("s", "text", result, summary), true);
  store.db
    .prepare("UPDATE messages SET seq=seq+1000 WHERE message_id='m0'")
    .run();
  assert.equal(store.historyCheckpoint("s", "text"), undefined);
  const moved = store.transcript("s").at(-1)!.message;
  assert.equal(store.saveHistoryCheckpoint("s", "text", moved, summary), true);
  store.db
    .prepare(
      "INSERT INTO messages(seq,session_id,message_id,body) VALUES(1,'s','inserted',?)",
    )
    .run(
      JSON.stringify({
        id: "inserted",
        runId: "r",
        message: { role: "user", content: "earlier", timestamp: 0 },
      }),
    );
  assert.equal(store.historyCheckpoint("s", "text"), undefined);
  assert.equal(store.saveHistoryCheckpoint("s", "text", moved, summary), false);
});

test("real compaction persists a reusable checkpoint and keeps the durable message budget", async () => {
  const x = await setup(() => ({ text: "summary of earlier work" }));
  try {
    x.config.routes.text.contextWindow = 9000;
    x.config.routes.text.maxOutputTokens = 2000;
    const session = await x.session();
    x.kernel.store.write("runs", {
      id: "checkpoint-run",
      sessionId: session.id,
      status: "running",
    });
    for (let i = 0; i < 8; i++)
      x.kernel.store.appendTranscript(session.id, {
        id: `m${i}`,
        runId: "checkpoint-run",
        message: {
          role: "user",
          content: `message-${i} ` + "x".repeat(2400),
          timestamp: i,
        },
      });
    const history = loadRunHistory(x.kernel.store, session.id, 100);
    await x.kernel.context.prepare("checkpoint-run", "text", [
      { role: "system", content: "instructions", timestamp: 0 },
      ...history.map((item) => item.message),
    ]);
    assert.ok(x.kernel.store.historyCheckpoint(session.id, "text"));
    const restored = loadRunHistory(x.kernel.store, session.id, 100, {
      routeId: "text",
      maxBytes: 10000,
    });
    assert.ok(restored.length < history.length);
    assert.match(JSON.stringify(restored[0].message), /continuation_summary/);
    assert.equal(x.kernel.store.transcriptCount(session.id), 8);
    assert.throws(
      () => loadRunHistory(x.kernel.store, session.id, 8, { routeId: "text" }),
      /message limit/,
    );
  } finally {
    await x.close();
  }
});

test("streaming assets clean cancellation, enforce reservations and serve a verified immutable snapshot", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentUploads: 1, maxConcurrentDownloads: 1 },
  });
  try {
    const controller = new AbortController();
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    };
    const pending = x.kernel.assets.createStream(
      x.project.id,
      "cancelled.bin",
      stalled,
      "upload",
      undefined,
      controller.signal,
    );
    await setImmediate();
    controller.abort();
    await assert.rejects(pending, /abort|cancel/i);
    const bytes = Buffer.alloc(128 * 1024, 0x78);
    const asset = await x.kernel.assets.createStream(
      x.project.id,
      "stream.bin",
      [bytes.subarray(0, 65536), bytes.subarray(65536)],
      "upload",
      undefined,
      undefined,
      bytes.length,
    );
    const download = await x.kernel.assets.openVerified(asset.id, x.project.id);
    await assert.rejects(
      x.kernel.assets.openVerified(asset.id, x.project.id),
      /capacity/,
    );
    await writeFile(
      x.kernel.assets.file(asset.id),
      Buffer.alloc(bytes.length, 0x79),
    );
    assert.deepEqual(await readFile(download.file), bytes);
    await download.close();
    await assert.rejects(
      x.kernel.assets.read(asset.id, x.project.id),
      /integrity/,
    );
    assert.deepEqual(
      (await readdir(x.kernel.assets.root)).filter((name) =>
        name.startsWith("."),
      ),
      [],
    );
    assert.equal(x.kernel.store.count("assets"), 1);
    const orphan = path.join(x.kernel.assets.root, `.${asset.id}.upload`);
    await writeFile(orphan, "interrupted upload");
    await x.kernel.assets.init();
    assert.ok(
      !(await readdir(x.kernel.assets.root)).includes(path.basename(orphan)),
    );
  } finally {
    await x.close();
  }
});

test("kernel shutdown cancels stalled asset writes and closes outstanding download snapshots", async () => {
  const x = await setup();
  const asset = await x.kernel.assets.create(
    x.project.id,
    "snapshot.txt",
    Buffer.from("verified"),
  );
  const snapshot = await x.kernel.assets.openVerified(asset.id, x.project.id);
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  const pending = x.kernel.assets.createStream(
    x.project.id,
    "stalled.bin",
    source,
  );
  void pending.catch(() => undefined);
  await setImmediate();
  await x.close();
  await assert.rejects(pending, /cancel|closing/i);
  assert.deepEqual(
    (await readdir(x.kernel.assets.root)).filter((name) =>
      name.startsWith("."),
    ),
    [],
  );
  await snapshot.close();
});

test("entity API cursor pages remain bounded and stable across updates", async () => {
  const x = await setup();
  try {
    x.kernel.store.transaction(() => {
      for (let i = 0; i < 205; i++)
        x.kernel.store.write("jobs", {
          id: `job-${i}`,
          projectId: x.project.id,
          prompt: "x".repeat(1024),
        });
    });
    type Page = { jobs: { id: string }[]; cursor: number; hasMore: boolean };
    const first = await x.client.request<Page>("GET", "/v1/jobs");
    assert.equal(first.jobs.length, 100);
    assert.equal(first.hasMore, true);
    x.kernel.store.write("jobs", {
      id: first.jobs[0].id,
      projectId: x.project.id,
      prompt: "updated",
    });
    const second = await x.client.request<Page>(
      "GET",
      `/v1/jobs?after=${first.cursor}`,
    );
    const last = await x.client.request<Page>(
      "GET",
      `/v1/jobs?after=${second.cursor}`,
    );
    assert.equal(second.jobs.length, 100);
    assert.equal(last.jobs.length, 5);
    assert.equal(last.hasMore, false);
    assert.equal(
      new Set(
        [...first.jobs, ...second.jobs, ...last.jobs].map((job) => job.id),
      ).size,
      205,
    );
    await assert.rejects(
      x.client.request("GET", "/v1/jobs?limit=1001"),
      /Invalid entity page/,
    );
  } finally {
    await x.close();
  }
});

test("live retention yields between batches and cancellation preserves remaining work", async (t) => {
  const store = await storage(t);
  store.write("runs", {
    id: "old",
    sessionId: "s",
    status: "completed",
    updatedAt: "2020-01-01",
  });
  store.transaction(() => {
    const statement = store.db.prepare(
      "INSERT INTO events(run_id,body) VALUES('old','{}')",
    );
    for (let i = 0; i < 2501; i++) statement.run();
  });
  const count = () =>
    Number(store.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n);
  const controller = new AbortController();
  const work = store.pruneAsync(
    { events: "2021-01-01" },
    100,
    controller.signal,
  );
  await setImmediate();
  assert.ok(count() > 0 && count() < 2501);
  controller.abort();
  await assert.rejects(work, /abort/i);
  const remaining = count();
  assert.equal(
    (await store.pruneAsync({ events: "2021-01-01" }, 100)).events,
    remaining,
  );
  assert.equal(count(), 0);
});

test("input admission limits reject before persistence and release queue capacity after failure", async () => {
  const x = await setup(() => ({ text: "done", delayMs: 250 }), {
    limits: { maxQueuedInputs: 1 },
  });
  try {
    const session = await x.session();
    const run = await x.client.submit(session.id, { text: "start" });
    await until(() => x.wire.requests.length > 0 || undefined);
    await x.client.submit(session.id, { text: "queued", delivery: "enqueue" });
    const before = x.kernel.store.count("inbox");
    await assert.rejects(
      x.client.submit(session.id, {
        text: "over capacity",
        delivery: "enqueue",
      }),
      /capacity/,
    );
    assert.equal(x.kernel.store.count("inbox"), before);
    x.kernel.cancel(run.runId);
    await x.kernel.wait(run.runId);
  } finally {
    await x.close();
  }
  const queue = new KeyedQueue<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(
    "s",
    () =>
      gate.then(() => {
        throw new Error("fixture failure");
      }),
    { count: 1, bytes: 10, size: 10 },
  );
  await assert.rejects(
    queue.run("s", async () => {}, { count: 1, bytes: 10, size: 1 }),
    /capacity/,
  );
  release();
  await assert.rejects(first, /fixture failure/);
  assert.equal(
    await queue.run("s", async () => "released", {
      count: 1,
      bytes: 10,
      size: 10,
    }),
    "released",
  );
});

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  headersSent = false;
  blocked = false;
  writeHead() {
    this.headersSent = true;
    return this;
  }
  write() {
    return !this.blocked;
  }
  end() {
    this.writableEnded = this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
  get http() {
    return this as unknown as ServerResponse;
  }
}
test("SSE global bytes, per-run subscribers and stalled drain reservations are released", async (t) => {
  const store = await storage(t);
  for (const id of ["a", "b", "c"])
    store.write("runs", { id, sessionId: "s", status: "running" });
  const limits = {
    maxSseSubscribers: 2,
    maxSseSubscribersPerRun: 1,
    maxSseBufferBytes: 2048,
    maxSseConnectionBytes: 2048,
    sseDrainTimeoutMs: 100,
  };
  const first = new Response();
  first.blocked = true;
  const second = new Response();
  await streamRunEvents(store, "a", 0, first.http, limits);
  const rejected = new Response();
  await assert.rejects(
    streamRunEvents(store, "a", 0, rejected.http, limits),
    /subscription capacity/,
  );
  assert.equal(rejected.headersSent, false);
  await streamRunEvents(store, "b", 0, second.http, limits);
  store.emit("a", "payload", { text: "x".repeat(1000) });
  store.emit("b", "payload", { text: "x".repeat(1000) });
  await setImmediate();
  assert.ok(second.writableEnded);
  const closed = once(first, "close");
  const guard = setTimeout(() => first.destroy(), 2000);
  await closed;
  clearTimeout(guard);
  assert.ok(first.destroyed);
  const third = new Response();
  await streamRunEvents(store, "c", 0, third.http, limits);
  store.emit("c", "payload", { text: "x".repeat(1000) });
  await setImmediate();
  assert.equal(third.writableEnded, false);
  third.destroy();
});

test("kernel redaction policies and rotated credentials have independent async lifetimes", async () => {
  const a = new RedactionScope({ mode: "registered" });
  const b = new RedactionScope({ mode: "off" });
  a.run(() => registerSecret("private-scope-credential"));
  await Promise.all([
    a.run(async () => {
      await setImmediate();
      assert.equal(redactSecrets("private-scope-credential"), "[REDACTED]");
    }),
    b.run(async () => {
      await setImmediate();
      assert.equal(
        redactSecrets("private-scope-credential"),
        "private-scope-credential",
      );
    }),
  ]);
  a.close();
  b.close();
  assert.ok(!a.run(processSecretSnapshot).includes("private-scope-credential"));
  class Service {
    value() {
      return redactSecrets("owned-prototype-credential");
    }
  }
  const scope = new RedactionScope({ mode: "registered" });
  scope.run(() => registerSecret("owned-prototype-credential"));
  const service = scope.bind(new Service());
  const original = Service.prototype.value;
  Service.prototype.value = function () {
    return "patched:" + original.call(this);
  };
  assert.equal(service.value(), "patched:[REDACTED]");
  scope.close();
  const x = await setup(undefined, { redaction: { mode: "registered" } });
  const y = await setup(undefined, { redaction: { mode: "off" } });
  try {
    x.kernel.redaction.run(() => registerSecret("kernel-owned-credential"));
    x.kernel.store.write("effects", {
      id: "a",
      text: "kernel-owned-credential",
    });
    y.kernel.store.write("effects", {
      id: "b",
      text: "kernel-owned-credential",
    });
    assert.equal(
      x.kernel.store.get<{ text: string }>("effects", "a").text,
      "[REDACTED]",
    );
    assert.equal(
      y.kernel.store.get<{ text: string }>("effects", "b").text,
      "kernel-owned-credential",
    );
  } finally {
    await x.close();
    await y.close();
  }
});
