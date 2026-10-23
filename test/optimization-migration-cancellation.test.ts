import assert from "node:assert/strict";
import { test } from "node:test";
import http, { type ClientRequest } from "node:http";
import { createHash } from "node:crypto";
import { setup, token, until } from "./support/wire-server.js";
import {
  jsonChunks,
  jsonBytes,
  canonicalDigest,
} from "../src/sessions/json-stream.js";

test("HTTP migration cancellation aborts blocked asset collection and releases both admission limits", async (t) => {
  const x = await setup(undefined, {
    limits: { maxConcurrentMigrations: 1 },
  });
  let request: ClientRequest | undefined;
  let rejectBlocked: ((error: Error) => void) | undefined;
  let observedSignal: AbortSignal | undefined;
  let readStarted = false;
  let cancellationDelivered = false;
  let calls = 0;
  try {
    const session = await x.session();
    const bytes = Buffer.from("migration cancellation fixture");
    const asset = await x.kernel.assets.create(
      x.project.id,
      "source.txt",
      bytes,
    );
    x.kernel.store.saveTranscript(session.id, [
      {
        id: "message-fixture",
        runId: "run-fixture",
        message: { role: "user", content: asset.id, timestamp: 0 },
      },
    ]);
    const read = x.kernel.assets.read.bind(x.kernel.assets);
    t.mock.method(
      x.kernel.assets,
      "read",
      async (...args: Parameters<typeof read>) => {
        if (++calls !== 1) return read(...args);
        observedSignal = args[2];
        return new Promise<Buffer>((_resolve, reject) => {
          rejectBlocked = reject;
          const abort = () => {
            cancellationDelivered = true;
            reject(
              observedSignal?.reason ??
                new Error("Migration request cancelled"),
            );
          };
          observedSignal?.addEventListener("abort", abort, { once: true });
          readStarted = true;
          if (observedSignal?.aborted) abort();
        });
      },
    );
    request = http.get(
      `${x.api.url}/v1/sessions/${session.id}/migration`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      (response) => response.resume(),
    );
    // Destroying the client is the stimulus; ECONNRESET is expected locally.
    request.on("error", () => undefined);
    await until(() => readStarted || undefined);
    assert.ok(observedSignal instanceof AbortSignal);
    assert.equal(observedSignal.aborted, false);
    assert.throws(() => x.kernel.migrations.reserveTransfer(), /capacity/);
    await assert.rejects(x.kernel.exportMigration(session.id), /capacity/);

    request.destroy();
    await until(() => cancellationDelivered || undefined);
    assert.equal(observedSignal.aborted, true);
    await until(() => {
      try {
        const release = x.kernel.migrations.reserveTransfer();
        release();
        return true;
      } catch (error) {
        if (error instanceof Error && /capacity/.test(error.message))
          return undefined;
        throw error;
      }
    });
    const resumed = await x.kernel.exportMigration(session.id);
    assert.equal(resumed.payload.assets.length, 1);
    assert.equal(resumed.payload.assets[0].data, bytes.toString("base64"));
    const streamed = await x.client.request(
      "GET",
      `/v1/sessions/${session.id}/migration`,
    );
    assert.equal(streamed.format, "foundation-migration-v1");
    assert.equal(streamed.payload.assets[0].data, bytes.toString("base64"));
  } finally {
    request?.destroy();
    rejectBlocked?.(new Error("Test fixture cleanup"));
    await x.close();
  }
});

test("long JSON keys preserve surrogate boundaries, bounded fragments and the v1 canonical digest", () => {
  const key =
    "x".repeat(16383) + "😀" + "\ud800" + '\\\n"'.repeat(250000) + "\udc00";
  const value = { z: 1, [key]: "key payload", a: "short" };
  const chunks = [...jsonChunks(value)];
  assert.ok(chunks.every((chunk) => chunk.length <= 98304));
  assert.equal(chunks.join(""), JSON.stringify(value));
  assert.equal(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    JSON.stringify(value),
  );
  assert.deepEqual(JSON.parse(chunks.join("")), value);
  assert.equal(jsonBytes(value), Buffer.byteLength(JSON.stringify(value)));
  // Match the existing v1 canonical form, including its UTF-16 key ordering.
  const canonical =
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (name) =>
          JSON.stringify(name) +
          ":" +
          JSON.stringify(value[name as keyof typeof value]),
      )
      .join(",") +
    "}";
  assert.equal(
    canonicalDigest(value),
    createHash("sha256").update(canonical).digest("hex"),
  );
  assert.ok(jsonBytes(value, 1024) < jsonBytes(value));
});
