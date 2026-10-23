import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionExport } from "../src/api/session-export.js";
import { type ApiContext } from "../src/api/shared.js";
import { setup, token, until } from "./support/wire-server.js";
import type { Session, StoredMessage } from "../src/contracts.js";

function context(
  x: Awaited<ReturnType<typeof setup>>,
  signal?: AbortSignal,
): ApiContext {
  return {
    k: x.kernel,
    signal,
    url: new URL("http://localhost/v1/sessions/unused/export"),
    method: "GET",
    parts: [],
    json: async () => ({}),
  };
}

test("session HTTP export retains the v1 format and streams every persisted message", async () => {
  const x = await setup();
  try {
    const session = await x.session();
    const expected: StoredMessage[] = [];
    x.kernel.store.transaction(() => {
      for (let i = 0; i < 70; i++) {
        const row: StoredMessage = {
          id: `export_${i}`,
          runId: "r",
          message: { role: "user", content: `消息 ${i}`, timestamp: i },
        };
        x.kernel.store.appendTranscript(session.id, row);
        expected.push(row);
      }
    });
    x.kernel.store.transcript = () => {
      throw new Error("whole transcript forbidden");
    };
    const response = await fetch(
      `${x.api.url}/v1/sessions/${session.id}/export`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assert.equal(response.status, 200);
    const value = (await response.json()) as {
      format: string;
      session: Session;
      messages: StoredMessage[];
    };
    assert.equal(value.format, "foundation-session-v1");
    assert.equal(value.session.id, session.id);
    assert.deepEqual(value.messages, expected);
  } finally {
    await x.close();
  }
});

test("session export preflights bytes, closes failed snapshots and validates missing sessions", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentSessionExports: 1, maxSessionExportBytes: 4000 },
  });
  try {
    const session = await x.session();
    x.kernel.store.appendTranscript(session.id, {
      id: "large",
      runId: "r",
      message: { role: "user", content: "x".repeat(5000), timestamp: 1 },
    });
    const response = await fetch(
      `${x.api.url}/v1/sessions/${session.id}/export`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 413);
    assert.match(await response.text(), /session_export_capacity/);
    assert.throws(() => sessionExport(context(x), "missing"), /not found/i);
    const empty = await x.session();
    sessionExport(context(x), empty.id).close();
  } finally {
    await x.close();
  }
});

test("session export snapshots metadata and history together and releases on cancellation", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentSessionExports: 1 },
  });
  try {
    const session = await x.session();
    const controller = new AbortController();
    const first = sessionExport(context(x, controller.signal), session.id);
    assert.throws(() => sessionExport(context(x), session.id), /capacity/);
    x.kernel.updateSession(session.id, { name: "after snapshot" });
    x.kernel.store.appendTranscript(session.id, {
      id: "late",
      runId: "r",
      message: { role: "user", content: "late", timestamp: 1 },
    });
    const chunks = [];
    for await (const part of first.chunks) chunks.push(part);
    const snapshot = JSON.parse(chunks.join(""));
    assert.equal(snapshot.session.name, session.name);
    assert.deepEqual(snapshot.messages, []);
    const cancelled = sessionExport(context(x, controller.signal), session.id);
    controller.abort(new Error("test disconnect"));
    await assert.rejects(async () => {
      for await (const part of cancelled.chunks) void part;
    }, /test disconnect/);
    sessionExport(context(x), session.id).close();
  } finally {
    await x.close();
  }
});

test("session export timeout frees an unconsumed snapshot and its WAL reader", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentSessionExports: 1, sessionExportTimeoutMs: 100 },
  });
  try {
    const session = await x.session();
    const first = sessionExport(context(x), session.id);
    await until(() => {
      try {
        sessionExport(context(x), session.id).close();
        return true;
      } catch (error) {
        if (error instanceof Error && /capacity/.test(error.message)) return;
        throw error;
      }
    });
    await assert.rejects(async () => {
      for await (const part of first.chunks) void part;
    }, /abort|timeout/i);
    const checkpoint = x.kernel.store
      .prepare("PRAGMA wal_checkpoint(PASSIVE)")
      .get() as { log: number; checkpointed: number };
    assert.equal(checkpoint.log, checkpoint.checkpointed);
  } finally {
    await x.close();
  }
});
