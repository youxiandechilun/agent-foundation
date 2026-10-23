import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";
import { Capacity } from "../runtime/capacity.js";
import { invariant } from "../core/util.js";
import type { Kernel } from "../core/kernel.js";
import { JsonStreamResponse, type ApiContext } from "./shared.js";

const capacities = new WeakMap<Kernel, Map<string, Capacity>>();

interface ExportOptions {
  kind: "memory" | "session";
  concurrency: number;
  maxBytes: number;
  timeoutMs: number;
  table: "e_memories" | "messages";
  cursor: "rowid" | "seq";
  where: string;
  values: SQLInputValue[];
  head: (db: DatabaseSync) => string;
}

/** Internal SQL and identifiers are fixed by callers; values remain bound parameters. */
export function snapshotJsonExport(
  context: ApiContext,
  options: ExportOptions,
) {
  const { k } = context;
  context.signal?.throwIfAborted();
  let groups = capacities.get(k);
  if (!groups) capacities.set(k, (groups = new Map()));
  let capacity = groups.get(options.kind);
  if (!capacity) {
    capacity = new Capacity(options.concurrency);
    groups.set(options.kind, capacity);
  }
  const release = capacity.reserve();
  let db: DatabaseSync | undefined;
  let closed = false;
  const signal = AbortSignal.any([
    ...(context.signal ? [context.signal] : []),
    AbortSignal.timeout(options.timeoutMs),
  ]);
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    try {
      db?.close();
    } finally {
      release();
    }
  };
  try {
    db = new DatabaseSync(path.join(k.config.dataDir, "foundation.sqlite"), {
      readOnly: true,
    });
    db.exec("BEGIN");
    const head = options.head(db);
    const size = db
      .prepare(
        `SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM ${options.table} WHERE ${options.where}`,
      )
      .get(...options.values) as { count: number; bytes: number };
    invariant(
      size.bytes + Math.max(0, size.count - 1) + Buffer.byteLength(head) + 2 <=
        options.maxBytes,
      `${options.kind === "memory" ? "Memory" : "Session"} export exceeds byte budget`,
      413,
      `${options.kind}_export_capacity`,
    );
    // Complete each iterator before yielding so abort can close the WAL snapshot.
    const statement = db.prepare(
      `SELECT ${options.cursor} AS cursor,body FROM ${options.table} WHERE ${options.where} AND ${options.cursor}>? ORDER BY ${options.cursor} LIMIT 32`,
    );
    async function* chunks() {
      try {
        signal.throwIfAborted();
        yield head;
        let after = 0,
          first = true;
        for (;;) {
          signal.throwIfAborted();
          const rows: { cursor: number; body: string }[] = [];
          let bytes = 0;
          for (const row of statement.iterate(
            ...options.values,
            after,
          ) as Iterable<{
            cursor: number;
            body: string;
          }>) {
            rows.push(row);
            bytes += Buffer.byteLength(row.body);
            // One complete record may exceed this batch target.
            if (bytes >= 1024 * 1024) break;
          }
          if (!rows.length) break;
          for (const row of rows) {
            signal.throwIfAborted();
            yield (first ? "" : ",") + row.body;
            first = false;
            after = row.cursor;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        signal.throwIfAborted();
        yield "]}";
      } finally {
        close();
      }
    }
    signal.addEventListener("abort", close, { once: true });
    signal.throwIfAborted();
    return new JsonStreamResponse(chunks(), close, signal);
  } catch (error) {
    close();
    throw error;
  }
}
