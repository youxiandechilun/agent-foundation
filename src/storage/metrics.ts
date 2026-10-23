import { DatabaseSync } from "node:sqlite";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { tables, entityTable } from "./entity-query.js";
import { invariant } from "../core/util.js";

export interface StorageTableStats {
  table: string;
  rows: number;
  jsonBytes: number;
  vectorBytes: number;
  textBytes: number;
}
export interface StorageDirectoryStats {
  files: number;
  bytes: number;
  /** Links are counted but never followed. */
  symbolicLinks: number;
}
export interface StorageStats {
  startedAt: string;
  completedAt: string;
  database: {
    fileBytes: number;
    walBytes: number;
    sharedMemoryBytes: number;
    pageSize: number;
    pageCount: number;
    freePageCount: number;
  };
  tables: StorageTableStats[];
  directories: {
    assets: StorageDirectoryStats;
    checkpoints: StorageDirectoryStats;
    migrationStaging: StorageDirectoryStats;
  };
}

function absent(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function fileBytes(file: string): Promise<number> {
  try {
    const info = await lstat(file);
    return info.isFile() ? info.size : 0;
  } catch (error) {
    if (absent(error)) return 0;
    throw error;
  }
}

async function directoryStats(root: string, signal?: AbortSignal) {
  const result: StorageDirectoryStats = {
    files: 0,
    bytes: 0,
    symbolicLinks: 0,
  };
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    signal?.throwIfAborted();
    try {
      // lstat also rejects a linked directory supplied as the traversal root.
      const info = await lstat(directory);
      if (info.isSymbolicLink()) {
        result.symbolicLinks++;
        continue;
      }
      if (!info.isDirectory()) continue;
      const entries = await opendir(directory);
      for await (const entry of entries) {
        signal?.throwIfAborted();
        const target = path.join(directory, entry.name);
        const current = await lstat(target).catch((error: unknown) => {
          if (absent(error)) return undefined;
          throw error;
        });
        if (!current) continue;
        if (current.isSymbolicLink()) result.symbolicLinks++;
        else if (current.isDirectory()) {
          invariant(
            depth < 64 && pending.length < 4096,
            "Storage statistics directory traversal capacity reached",
            429,
            "storage_stats_capacity",
          );
          pending.push({ directory: target, depth: depth + 1 });
        } else if (current.isFile()) {
          result.files++;
          result.bytes += current.size;
        }
      }
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  return result;
}

/** Explicit diagnostics only: read a consistent database snapshot in bounded pages.
 * Directory/file sizes are sampled afterward and may change while writes continue.
 */
export async function collectStorageStats(
  dataDir: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const file = path.join(dataDir, "foundation.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const counts: StorageTableStats[] = [];
  let pageSize: number;
  let pageCount: number;
  let freePageCount: number;
  try {
    db.exec("PRAGMA cache_size=-1024; PRAGMA query_only=ON; BEGIN");
    const existing = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
          .all() as {
          name: string;
        }[]
      ).map(({ name }) => name),
    );
    const specs = [
      ...tables.map((kind) => [entityTable(kind), "body", "", ""]),
      ...["events", "messages", "transcripts", "inputs"].map((name) => [
        name,
        "body",
        "",
        "",
      ]),
      ["transcript_contexts", "summary", "", ""],
      ["memory_vectors", "", "vector", ""],
      ["memory_fts", "", "", "terms"],
      ...[
        "memory_fts_map",
        "memory_vector_norms",
        "billing_deliveries",
        "transcript_generations",
        "transcript_counts",
      ].map((name) => [name, "", "", ""]),
    ];
    for (const [table, json, vector, text] of specs) {
      if (!existing.has(table)) continue;
      const bytes = (column: string) =>
        column ? `COALESCE(length(CAST(${column} AS BLOB)),0)` : "0";
      const statement = db.prepare(
        `SELECT rowid AS cursor,${bytes(json)} AS jsonBytes,${bytes(vector)} AS vectorBytes,${bytes(text)} AS textBytes FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 256`,
      );
      const total: StorageTableStats = {
        table,
        rows: 0,
        jsonBytes: 0,
        vectorBytes: 0,
        textBytes: 0,
      };
      let after = -Number.MAX_SAFE_INTEGER;
      for (;;) {
        signal?.throwIfAborted();
        const rows = statement.all(after) as {
          cursor: number;
          jsonBytes: number;
          vectorBytes: number;
          textBytes: number;
        }[];
        for (const row of rows) {
          total.rows++;
          total.jsonBytes += row.jsonBytes;
          total.vectorBytes += row.vectorBytes;
          total.textBytes += row.textBytes;
          after = row.cursor;
        }
        if (rows.length < 256) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      counts.push(total);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    pageSize = db.prepare("PRAGMA page_size").get()!.page_size as number;
    pageCount = db.prepare("PRAGMA page_count").get()!.page_count as number;
    freePageCount = db.prepare("PRAGMA freelist_count").get()!
      .freelist_count as number;
  } finally {
    db.close();
  }
  signal?.throwIfAborted();
  const directories = {
    assets: await directoryStats(path.join(dataDir, "assets"), signal),
    checkpoints: await directoryStats(
      path.join(dataDir, "checkpoints"),
      signal,
    ),
    migrationStaging: await directoryStats(
      path.join(dataDir, "migration-staging"),
      signal,
    ),
  };
  signal?.throwIfAborted();
  const [databaseBytes, walBytes, sharedMemoryBytes] = await Promise.all([
    fileBytes(file),
    fileBytes(file + "-wal"),
    fileBytes(file + "-shm"),
  ]);
  signal?.throwIfAborted();
  const result: StorageStats = {
    startedAt,
    completedAt: new Date().toISOString(),
    database: {
      fileBytes: databaseBytes,
      walBytes,
      sharedMemoryBytes,
      pageSize,
      pageCount,
      freePageCount,
    },
    tables: counts,
    directories,
  };
  return result;
}
