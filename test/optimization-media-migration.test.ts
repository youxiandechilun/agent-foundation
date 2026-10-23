import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setup, until } from "./support/wire-server.js";
import type { AdapterResult } from "../src/media/adapters.js";
import {
  jsonChunks,
  jsonBytes,
  canonicalDigest,
} from "../src/sessions/json-stream.js";

test("media admission bounds provider concurrency and queued work, cancels reservations and reuses idempotent jobs", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentMediaJobs: 1, maxQueuedMediaJobs: 1 },
  });
  let active = 0,
    peak = 0;
  try {
    x.config.routes.image = {
      ...x.config.routes.text,
      kind: "image",
      adapter: "media-http",
      mediaAdapterId: "queue-test",
    };
    x.kernel.media.adapters.register({
      id: "queue-test",
      capabilities: {
        kinds: ["image"],
        operations: ["generate"],
        cancellation: false,
        recovery: false,
      },
      submit: (_request, context) =>
        new Promise((_resolve, reject) => {
          peak = Math.max(peak, ++active);
          context.signal.addEventListener(
            "abort",
            () => {
              active--;
              reject(context.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const input = {
      projectId: x.project.id,
      kind: "image" as const,
      routeId: "image",
      prompt: "test",
      idempotencyKey: "first",
    };
    const first = x.kernel.media.create(input);
    await until(() => active === 1);
    const second = x.kernel.media.create({
      ...input,
      idempotencyKey: "second",
    });
    assert.equal(x.kernel.store.job(second.id).status, "queued");
    assert.throws(
      () => x.kernel.media.create({ ...input, idempotencyKey: "third" }),
      /capacity/,
    );
    assert.equal(x.kernel.media.create(input).id, first.id);
    await x.kernel.media.cancel(second.id);
    assert.equal(x.kernel.store.job(second.id).status, "cancelled");
    assert.equal(
      x.kernel.store.get<{ status: string }>("cost-ledger", second.costEntryId!)
        .status,
      "void",
    );
    const third = x.kernel.media.create({ ...input, idempotencyKey: "third" });
    await x.kernel.media.cancel(first.id);
    await until(
      () => x.kernel.store.job(third.id).status === "running" && active === 1,
    );
    assert.equal(peak, 1);
    await x.kernel.media.close();
    assert.equal(active, 0);
    assert.throws(
      () => x.kernel.media.create({ ...input, idempotencyKey: "closed" }),
      /closed/,
    );
    // Preserve the public async contract even when admission rejects immediately.
    await assert.rejects(x.kernel.media.cancel(first.id), /closed/);
  } finally {
    await x.close();
  }
});

test("media rejects queued metadata above its byte budget before persisting a job or charge", async () => {
  const x = await setup(undefined, { limits: { maxMediaQueueBytes: 1024 } });
  try {
    x.config.routes.image = {
      ...x.config.routes.text,
      kind: "image",
      adapter: "image-json",
    };
    assert.throws(
      () =>
        x.kernel.media.create({
          projectId: x.project.id,
          kind: "image",
          routeId: "image",
          prompt: "x".repeat(4000),
          idempotencyKey: "too-large",
        }),
      /capacity/,
    );
    assert.equal(x.kernel.store.count("jobs"), 0);
    assert.equal(x.kernel.store.count("cost-ledger"), 0);
  } finally {
    await x.close();
  }
});

test("media timeouts retain admission for adapters that ignore abort and do not block close", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentMediaJobs: 1, maxQueuedMediaJobs: 1 },
  });
  const completions: ((result: AdapterResult) => void)[] = [];
  try {
    x.config.routes.image = {
      ...x.config.routes.text,
      kind: "image",
      adapter: "media-http",
      mediaAdapterId: "ignores-abort",
      timeoutMs: 100,
    };
    x.kernel.media.adapters.register({
      id: "ignores-abort",
      capabilities: {
        kinds: ["image"],
        operations: ["generate"],
        cancellation: false,
        recovery: false,
      },
      submit: () => new Promise((resolve) => completions.push(resolve)),
    });
    const input = {
      projectId: x.project.id,
      kind: "image" as const,
      routeId: "image",
      prompt: "test",
      idempotencyKey: "first",
    };
    const first = x.kernel.media.create(input);
    const second = x.kernel.media.create({
      ...input,
      idempotencyKey: "second",
    });
    await until(() => x.kernel.store.job(first.id).status === "unknown");
    assert.equal(completions.length, 1);
    assert.equal(x.kernel.store.job(second.id).status, "queued");
    assert.throws(
      () => x.kernel.media.create({ ...input, idempotencyKey: "third" }),
      /capacity/,
    );
    await x.kernel.media.close();
    assert.equal(x.kernel.store.job(second.id).status, "cancelled");
    completions[0]({ status: "failed" });
  } finally {
    for (const resolve of completions) resolve({ status: "failed" });
    await x.close();
  }
});

test("text excerpts stream full integrity verification and detect binary bytes beyond the retained prefix", async (t) => {
  const x = await setup();
  try {
    const text = "文".repeat(21845) + "😀" + "tail".repeat(100000);
    const asset = await x.kernel.assets.create(
      x.project.id,
      "large.txt",
      Buffer.from(text),
    );
    t.mock.method(x.kernel.assets, "read", async () => {
      throw new Error("whole asset read must not be used");
    });
    const excerpt = await x.kernel.assets.extract(
      asset.id,
      x.project.id,
      65537,
    );
    assert.ok(excerpt.supported && excerpt.truncated);
    assert.ok(excerpt.text.startsWith(text.slice(0, 65537)));
    const binary = await x.kernel.assets.create(
      x.project.id,
      "binary.txt",
      Buffer.from("a".repeat(100000) + "\0"),
    );
    assert.equal(
      (await x.kernel.assets.extract(binary.id, x.project.id, 10)).supported,
      false,
    );
    const bytes = Buffer.from(text);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(x.kernel.assets.file(asset.id), bytes);
    await assert.rejects(
      x.kernel.assets.extract(asset.id, x.project.id, 10),
      /integrity/,
    );
  } finally {
    await x.close();
  }
});

test("bounded JSON fragments preserve escaping, Unicode and stable migration digests", () => {
  const value = {
    z: [true, null, 0, "\ud800", "\udc00"],
    a: "x".repeat(16383) + "😀" + '\\\n"'.repeat(20000),
  };
  const chunks = [...jsonChunks(value)];
  assert.equal(chunks.join(""), JSON.stringify(value));
  assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) <= 98304);
  assert.equal(jsonBytes(value), Buffer.byteLength(JSON.stringify(value)));
  assert.equal(
    canonicalDigest(value),
    createHash("sha256")
      .update(JSON.stringify({ a: value.a, z: value.z }))
      .digest("hex"),
  );
  assert.ok(jsonBytes(value, 1024) < jsonBytes(value));
});

test("migration checks attachment metadata before reading and bounds overlapping exports", async (t) => {
  const x = await setup(undefined, {
    limits: { maxMigrationBytes: 1024, maxConcurrentMigrations: 1 },
  });
  try {
    const session = await x.session();
    const asset = await x.kernel.assets.create(
      x.project.id,
      "large.bin",
      Buffer.alloc(2048),
    );
    x.kernel.store.saveTranscript(session.id, [
      {
        id: "m",
        runId: "r",
        message: { role: "user", content: asset.id, timestamp: 0 },
      },
    ]);
    t.mock.method(x.kernel.assets, "read", async () => {
      throw new Error("budget should reject before reading");
    });
    await assert.rejects(x.kernel.exportMigration(session.id), /budget/);
    x.kernel.store.saveTranscript(session.id, []);
    const release = x.kernel.migrations.reserveTransfer();
    try {
      assert.throws(() => x.kernel.migrations.reserveTransfer(), /capacity/);
    } finally {
      release();
    }
    const first = x.kernel.exportMigration(session.id);
    await assert.rejects(x.kernel.exportMigration(session.id), /capacity/);
    await first;
    const bundle = await x.client.request(
      "GET",
      `/v1/sessions/${session.id}/migration`,
    );
    assert.equal(bundle.format, "foundation-migration-v1");
    assert.equal(bundle.payload.assets.length, 0);
  } finally {
    await x.close();
  }
});
