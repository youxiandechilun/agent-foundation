import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { invariant, abortable } from "../core/util.js";

async function* chunks(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal?: AbortSignal,
) {
  const iterator =
    Symbol.asyncIterator in source
      ? source[Symbol.asyncIterator]()
      : source[Symbol.iterator]();
  let done = false;
  try {
    while (!done) {
      const pending = Promise.resolve(iterator.next());
      const next = signal ? await abortable(pending, signal) : await pending;
      done = Boolean(next.done);
      if (!next.done) yield next.value;
    }
  } finally {
    if (!done && iterator.return)
      void Promise.resolve(iterator.return()).catch(() => undefined);
  }
}

/** Bounded streaming snapshot; partial writes and cancellation never publish a file. */
export async function writeAssetStream(
  file: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  max: number,
  signal?: AbortSignal,
  expected?: number,
) {
  signal?.throwIfAborted();
  const handle = await open(file, "wx", 0o600);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of chunks(source, signal)) {
      signal?.throwIfAborted();
      size += chunk.byteLength;
      invariant(
        size <= max && (expected === undefined || size <= expected),
        "Asset exceeds transfer limit",
        413,
        "asset_too_large",
      );
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        signal?.throwIfAborted();
        const result = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
        );
        invariant(result.bytesWritten > 0, "Asset write made no progress", 500);
        offset += result.bytesWritten;
      }
    }
    signal?.throwIfAborted();
    invariant(
      expected === undefined || size === expected,
      "Asset transfer length changed",
      409,
      "asset_integrity_failed",
    );
    return { size, sha256: digest.digest("hex") };
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
