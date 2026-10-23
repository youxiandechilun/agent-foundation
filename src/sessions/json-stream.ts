import { createHash } from "node:crypto";
import { invariant } from "../core/util.js";

/** Emit JSON in bounded string fragments, including large Base64 payloads. */
export function* jsonChunks(
  value: unknown,
  sorted = false,
  depth = 0,
  parents = new Set<object>(),
): Generator<string> {
  invariant(depth <= 100, "Migration JSON exceeds nesting limit");
  if (typeof value === "string") {
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + 16384);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else if (value && typeof value === "object") {
    invariant(!parents.has(value), "Circular migration JSON");
    parents.add(value);
    try {
      if (Array.isArray(value)) {
        yield "[";
        for (let i = 0; i < value.length; i++) {
          if (i) yield ",";
          yield* jsonChunks(value[i] ?? null, sorted, depth + 1, parents);
        }
        yield "]";
      } else {
        yield "{";
        const entries = Object.entries(value).filter(
          ([, item]) =>
            item !== undefined &&
            typeof item !== "function" &&
            typeof item !== "symbol",
        );
        if (sorted) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (let i = 0; i < entries.length; i++) {
          if (i) yield ",";
          yield* jsonChunks(entries[i][0], sorted, depth, parents);
          yield ":";
          yield* jsonChunks(entries[i][1], sorted, depth + 1, parents);
        }
        yield "}";
      }
    } finally {
      parents.delete(value);
    }
  } else {
    const encoded = JSON.stringify(value);
    invariant(encoded !== undefined, "Invalid migration JSON");
    yield encoded;
  }
}

export function jsonBytes(value: unknown, maximum = Infinity): number {
  let bytes = 0;
  for (const part of jsonChunks(value)) {
    bytes += Buffer.byteLength(part);
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

export function canonicalDigest(value: unknown): string {
  const digest = createHash("sha256");
  for (const part of jsonChunks(value, true)) digest.update(part);
  return digest.digest("hex");
}
