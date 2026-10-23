import {
  mkdir,
  open,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Store } from "../storage/store.js";
import {
  atomicWrite,
  hash,
  id,
  invariant,
  now,
  safePath,
} from "../core/util.js";
import { Capacity } from "../runtime/capacity.js";

/** Snapshot of one file taken immediately before an agent file tool changed it. */
export interface FileCheckpoint {
  id: string;
  sessionId: string;
  projectId: string;
  runId: string;
  callId: string;
  /** Project-relative path with "/" separators. */
  path: string;
  existed: boolean;
  /** Content hash before the write; the bytes live in the checkpoint blob store. */
  beforeSha?: string;
  /** Set when the write completed; used to detect later changes made outside the agent's file tools. */
  afterSha?: string;
  /** The original was larger than the snapshot limit and cannot be restored. */
  tooLarge?: boolean;
  revertedAt?: string;
  createdAt: string;
}
export interface RewindReport {
  restored: string[];
  deleted: string[];
  conflicts: { path: string; reason: string }[];
  unchanged: string[];
}
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
export interface CheckpointReadOptions {
  maxConcurrentReads?: number;
  /** Includes retained chunks and their concatenated snapshot buffer. */
  maxReadBytes?: number;
}
/**
 * File checkpoints for rewind. Only changes made through file_write / file_patch are tracked;
 * commands run with exec_run, plugins or MCP servers are not, and are reported as conflicts
 * when they touched a tracked file afterwards.
 */
export class Checkpoints {
  readonly root: string;
  private readonly reads: Capacity;
  constructor(
    readonly store: Store,
    dataDir: string,
    options: CheckpointReadOptions = {},
  ) {
    this.root = path.join(dataDir, "checkpoints");
    const concurrency = options.maxConcurrentReads ?? 8,
      bytes = options.maxReadBytes ?? 64 * 1024 * 1024;
    invariant(
      Number.isSafeInteger(concurrency) &&
        concurrency > 0 &&
        Number.isSafeInteger(bytes) &&
        bytes >= READ_CHUNK_BYTES,
      "Invalid checkpoint read capacity",
    );
    this.reads = new Capacity(concurrency, bytes);
  }
  private async digest(file: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const release = this.reads.reserve(READ_CHUNK_BYTES);
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, "r");
      const bytes = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const digest = createHash("sha256");
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
        signal?.throwIfAborted();
        if (!bytesRead) break;
        // Hash consumes the view synchronously; reuse its backing storage for
        // the next read instead of leaving one Buffer per chunk awaiting GC.
        digest.update(bytes.subarray(0, bytesRead));
      }
      signal?.throwIfAborted();
      return digest.digest("hex");
    } finally {
      try {
        await handle?.close();
      } finally {
        release();
      }
    }
  }
  /** The on-disk blob is bounded too, even if it changed after capture. */
  private async snapshotBytes(
    file: string,
    signal?: AbortSignal,
    maximum = MAX_SNAPSHOT_BYTES,
  ) {
    signal?.throwIfAborted();
    const source = createReadStream(file, {
      highWaterMark: READ_CHUNK_BYTES,
      signal,
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        signal?.throwIfAborted();
        size += (chunk as Buffer).length;
        invariant(
          size <= maximum,
          "Checkpoint snapshot exceeds read limit",
          413,
          "checkpoint_capacity",
        );
        chunks.push(chunk as Buffer);
      }
      signal?.throwIfAborted();
      return Buffer.concat(chunks, size);
    } finally {
      source.destroy();
    }
  }
  private blob(sha: string) {
    invariant(/^[a-f0-9]{64}$/.test(sha), "Invalid checkpoint blob");
    return path.join(this.root, sha);
  }
  /** Record the current state of `relative` before a write. */
  async capture(
    scope: {
      sessionId: string;
      projectId: string;
      runId: string;
      callId: string;
    },
    projectRoot: string,
    relative: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
    const file = await safePath(projectRoot, normalized, true);
    let existed = true,
      beforeSha: string | undefined,
      tooLarge = false;
    try {
      const info = await stat(file);
      invariant(info.isFile(), "Checkpoint target is not a regular file", 409);
      if (info.size > MAX_SNAPSHOT_BYTES) tooLarge = true;
      else {
        const release = this.reads.reserve(2 * info.size + READ_CHUNK_BYTES);
        try {
          const bytes = await this.snapshotBytes(file, signal, info.size);
          beforeSha = hash(bytes);
          await mkdir(this.root, { recursive: true });
          // Finish publishing a whole blob once writing starts. Aborting a write
          // directly could leave a partial file under its final content hash.
          await writeFile(this.blob(beforeSha), bytes, { flag: "wx" }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            },
          );
          signal?.throwIfAborted();
        } finally {
          release();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    return this.store.put<FileCheckpoint>("checkpoints", {
      id: id("checkpoint"),
      ...scope,
      path: normalized,
      existed,
      beforeSha,
      ...(tooLarge ? { tooLarge } : {}),
      createdAt: now(),
    });
  }
  complete(checkpoint: FileCheckpoint, content: Buffer | string) {
    this.store.put("checkpoints", { ...checkpoint, afterSha: hash(content) });
  }
  list(sessionId: string) {
    return this.store
      .list<FileCheckpoint>("checkpoints", { sessionId })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /**
   * Restore every file changed by the given tool calls to its state before the earliest of them.
   * A file whose current content differs from the agent's last write is a conflict and is left
   * untouched unless `force` is set.
   */
  async revert(
    sessionId: string,
    projectRoot: string,
    callIds: Set<string>,
    force = false,
    signal?: AbortSignal,
  ): Promise<RewindReport> {
    signal?.throwIfAborted();
    const report: RewindReport = {
      restored: [],
      deleted: [],
      conflicts: [],
      unchanged: [],
    };
    const byPath = new Map<string, FileCheckpoint[]>();
    for (const c of this.list(sessionId))
      if (callIds.has(c.callId) && c.afterSha && !c.revertedAt) {
        const records = byPath.get(c.path);
        if (records) records.push(c);
        else byPath.set(c.path, [c]);
      }
    for (const [relative, records] of byPath) {
      signal?.throwIfAborted();
      const first = records[0],
        latest = records.at(-1)!;
      if (first.tooLarge) {
        report.conflicts.push({
          path: relative,
          reason: "Original exceeded the snapshot limit",
        });
        continue;
      }
      const file = await safePath(projectRoot, relative, true);
      let current: string | undefined;
      try {
        current = await this.digest(file, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== latest.afterSha && !force) {
        report.conflicts.push({
          path: relative,
          reason:
            current === undefined
              ? "File was deleted after the agent's last write"
              : "File changed after the agent's last write",
        });
        continue;
      }
      if (!first.existed) {
        if (current === undefined) report.unchanged.push(relative);
        else {
          await rm(file, { force: true });
          report.deleted.push(relative);
        }
      } else if (current === first.beforeSha) report.unchanged.push(relative);
      else {
        const blob = this.blob(first.beforeSha!);
        const info = await stat(blob);
        invariant(
          info.isFile() && info.size <= MAX_SNAPSHOT_BYTES,
          "Checkpoint snapshot exceeds read limit",
          413,
          "checkpoint_capacity",
        );
        const release = this.reads.reserve(2 * info.size + READ_CHUNK_BYTES);
        try {
          const bytes = await this.snapshotBytes(blob, signal, info.size);
          invariant(
            hash(bytes) === first.beforeSha,
            "Checkpoint blob integrity changed",
            409,
            "checkpoint_integrity_failed",
          );
          signal?.throwIfAborted();
          await mkdir(path.dirname(file), { recursive: true });
          await atomicWrite(file, bytes);
        } finally {
          release();
        }
        report.restored.push(relative);
      }
      const at = now();
      for (const record of records)
        this.store.put("checkpoints", { ...record, revertedAt: at });
    }
    return report;
  }
}
