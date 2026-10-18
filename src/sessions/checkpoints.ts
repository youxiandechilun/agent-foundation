import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
/**
 * File checkpoints for rewind. Only changes made through file_write / file_patch are tracked;
 * commands run with exec_run, plugins or MCP servers are not, and are reported as conflicts
 * when they touched a tracked file afterwards.
 */
export class Checkpoints {
  readonly root: string;
  constructor(
    readonly store: Store,
    dataDir: string,
  ) {
    this.root = path.join(dataDir, "checkpoints");
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
  ) {
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
        const bytes = await readFile(file);
        beforeSha = hash(bytes);
        await mkdir(this.root, { recursive: true });
        await writeFile(this.blob(beforeSha), bytes, { flag: "wx" }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
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
  ): Promise<RewindReport> {
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
      const first = records[0],
        latest = records.at(-1)!;
      const file = await safePath(projectRoot, relative, true);
      let current: string | undefined;
      try {
        current = hash(await readFile(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (first.tooLarge) {
        report.conflicts.push({
          path: relative,
          reason: "Original exceeded the snapshot limit",
        });
        continue;
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
        await mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, await readFile(this.blob(first.beforeSha!)));
        report.restored.push(relative);
      }
      const at = now();
      for (const record of records)
        this.store.put("checkpoints", { ...record, revertedAt: at });
    }
    return report;
  }
}
