import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Capacity } from "../runtime/capacity.js";
import { invariant } from "../core/util.js";
import type { Kernel } from "../core/kernel.js";
import { JsonStreamResponse, type ApiContext } from "./shared.js";

const capacities = new WeakMap<Kernel, Capacity>();

/** A bounded read-only WAL snapshot keeps v1 exports consistent while writes continue. */
export function memoryExport(context: ApiContext) {
  const { k, url } = context;
  const project = url.searchParams.get("projectId");
  invariant(project, "projectId required");
  k.store.project(project);
  context.signal?.throwIfAborted();
  let capacity = capacities.get(k);
  if (!capacity) {
    capacity = new Capacity(k.config.limits.maxConcurrentMemoryExports);
    capacities.set(k, capacity);
  }
  const release = capacity.reserve();
  let db: DatabaseSync | undefined;
  let closed = false;
  const signal = AbortSignal.any([
    ...(context.signal ? [context.signal] : []),
    AbortSignal.timeout(k.config.limits.memoryExportTimeoutMs),
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
    const namespace = url.searchParams.get("namespace") || null;
    const values = [project, namespace, namespace, new Date().toISOString()];
    const where =
      " WHERE json_extract(body,'$.projectId')=? AND (? IS NULL OR json_extract(body,'$.namespace')=?) AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?)";
    const head = '{"format":"foundation-memory-v1","memories":[';
    const size = db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM e_memories" +
          where,
      )
      .get(...values) as { count: number; bytes: number };
    invariant(
      size.bytes + Math.max(0, size.count - 1) + Buffer.byteLength(head) + 2 <=
        k.config.limits.maxMemoryExportBytes,
      "Memory export exceeds byte budget",
      413,
      "memory_export_capacity",
    );
    const reader = db;
    async function* chunks() {
      try {
        signal.throwIfAborted();
        yield head;
        let after = 0,
          first = true;
        for (;;) {
          signal.throwIfAborted();
          // Each page is bounded in rows and each memory has a content-size limit.
          const rows = reader
            .prepare(
              "SELECT rowid AS cursor,body FROM e_memories" +
                where +
                " AND rowid>? ORDER BY rowid LIMIT 32",
            )
            .all(...values, after) as { cursor: number; body: string }[];
          if (!rows.length) break;
          for (const row of rows) {
            signal.throwIfAborted();
            yield (first ? "" : ",") + row.body;
            first = false;
            after = row.cursor;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
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
