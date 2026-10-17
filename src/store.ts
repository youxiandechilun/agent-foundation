import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import type {
  Approval,
  Asset,
  FoundationEvent,
  Job,
  Project,
  Run,
  Session,
  StoredMessage,
  ToolEffect,
  InboxEntry,
} from "./contracts.js";
import { id, now, invariant, redactJson } from "./util.js";

export type Table =
  | "projects"
  | "sessions"
  | "runs"
  | "assets"
  | "jobs"
  | "approvals"
  | "memories"
  | "skills"
  | "plugins"
  | "mcps"
  | "policies"
  | "agents"
  | "inbox"
  | "effects"
  | "nodes"
  | "node-tasks"
  | "summaries"
  | "browser-sessions"
  | "work-plans"
  | "memory-revisions"
  | "memory-proposals"
  | "work-contexts"
  | "media-route-versions"
  | "mode-profiles"
  | "processes"
  | "cost-ledger"
  | "cost-adjustments"
  | "session-migrations"
  | "mcp-interactions"
  | "mcp-tasks"
  | "mcp-client-tasks";
// Runtime records are kept apart from optional host integrations.
export class Store {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  private transactionDepth = 0;
  private leaseOwner?: string;
  private closed = false;
  constructor(dataDir: string, options: { exclusiveKernel?: boolean } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "foundation.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS transcripts (session_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (session_id TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,key));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, project_id UNINDEXED, namespace UNINDEXED, terms, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS memory_vectors (id TEXT PRIMARY KEY, model TEXT NOT NULL, vector TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(2,datetime('now'));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,message_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(session_id,message_id));
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
      CREATE TABLE IF NOT EXISTS kernel_owner(slot INTEGER PRIMARY KEY CHECK(slot=1),owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    try {
      if (options.exclusiveKernel) this.acquireKernelLease();
      if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=3").get())
        this.transaction(() => {
          for (const row of this.db
            .prepare("SELECT session_id,body FROM transcripts")
            .all() as { session_id: string; body: string }[])
            for (const message of JSON.parse(row.body) as StoredMessage[])
              this.appendTranscript(row.session_id, message);
          this.db
            .prepare("INSERT INTO migrations VALUES(3,datetime('now'))")
            .run();
        });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private acquireKernelLease() {
    this.transaction(() => {
      const current = this.db
        .prepare("SELECT owner,pid,host FROM kernel_owner WHERE slot=1")
        .get() as { owner: string; pid: number; host: string } | undefined;
      if (current) {
        invariant(
          current.host === hostname(),
          "Data directory is owned by another host; refusing unsafe recovery",
          409,
          "kernel_owned",
        );
        let alive = true;
        try {
          process.kill(current.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        invariant(
          !alive,
          "Data directory already has a live kernel writer",
          409,
          "kernel_owned",
        );
      }
      const owner = id("kernel-owner");
      this.db
        .prepare("INSERT OR REPLACE INTO kernel_owner VALUES(1,?,?,?,?)")
        .run(owner, process.pid, hostname(), now());
      this.leaseOwner = owner;
    });
  }
  put<T extends { id: string }>(kind: Table, item: T): T {
    const body = [
      "inbox",
      "effects",
      "memories",
      "memory-revisions",
      "memory-proposals",
      "runs",
      "summaries",
      "work-plans",
    ].includes(kind)
      ? JSON.stringify(redactJson(item))
      : JSON.stringify(item);
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, item.id, body);
    return JSON.parse(body);
  }
  get<T>(kind: Table, entityId: string): T {
    const row = this.db
      .prepare("SELECT body FROM entities WHERE kind=? AND id=?")
      .get(kind, entityId) as { body: string } | undefined;
    invariant(row, `${kind}/${entityId} not found`, 404, "not_found");
    return JSON.parse(row.body);
  }
  list<T>(kind: Table): T[] {
    return (
      this.db
        .prepare("SELECT body FROM entities WHERE kind=? ORDER BY rowid")
        .all(kind) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  find<T>(kind: Table, entityId: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM entities WHERE kind=? AND id=?")
      .get(kind, entityId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  remove(kind: Table, entityId: string) {
    this.db
      .prepare("DELETE FROM entities WHERE kind=? AND id=?")
      .run(kind, entityId);
  }
  transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth,
      savepoint = `foundation_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
      if (depth) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  project(id: string) {
    return this.get<Project>("projects", id);
  }
  session(id: string) {
    return this.get<Session>("sessions", id);
  }
  run(id: string) {
    return this.get<Run>("runs", id);
  }
  asset(id: string) {
    return this.get<Asset>("assets", id);
  }
  job(id: string) {
    return this.get<Job>("jobs", id);
  }
  approval(id: string) {
    return this.get<Approval>("approvals", id);
  }
  transcript(sessionId: string): StoredMessage[] {
    return (
      this.db
        .prepare("SELECT body FROM messages WHERE session_id=? ORDER BY seq")
        .all(sessionId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  transcriptPage(sessionId: string, after = 0, limit = 100) {
    invariant(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 1000,
      "Invalid transcript page",
    );
    const rows = this.db
      .prepare(
        "SELECT seq,body FROM messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(sessionId, after, limit + 1) as { seq: number; body: string }[];
    return {
      messages: rows
        .slice(0, limit)
        .map((row) => ({ ...JSON.parse(row.body), seq: row.seq })),
      cursor: rows.slice(0, limit).at(-1)?.seq || after,
      hasMore: rows.length > limit,
    };
  }
  appendTranscript(sessionId: string, message: StoredMessage) {
    const body = JSON.stringify(redactJson(message));
    const previous = this.db
      .prepare("SELECT body FROM messages WHERE session_id=? AND message_id=?")
      .get(sessionId, message.id) as { body: string } | undefined;
    invariant(
      !previous || previous.body === body,
      "Message ID reused with different content",
      409,
    );
    if (!previous)
      this.db
        .prepare(
          "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
        )
        .run(sessionId, message.id, body);
  }
  saveTranscript(sessionId: string, messages: StoredMessage[]) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId);
      for (const message of messages) this.appendTranscript(sessionId, message);
    });
  }
  emit(
    runId: string,
    type: string,
    data: Record<string, unknown>,
    durable = true,
  ): FoundationEvent {
    const run = this.run(runId);
    const safeData = redactJson(data);
    const event: FoundationEvent = {
      schemaVersion: 1,
      id: id("ev"),
      runId,
      sessionId: run.sessionId,
      type,
      timestamp: now(),
      seq: null,
      data: safeData,
    };
    if (durable) {
      const result = this.db
        .prepare("INSERT INTO events(run_id,body) VALUES(?,?)")
        .run(runId, JSON.stringify(event));
      event.seq = Number(result.lastInsertRowid);
    }
    this.events.emit(runId, event);
    return event;
  }
  eventCursor(runId: string) {
    return Number(
      (
        this.db
          .prepare("SELECT MAX(seq) AS cursor FROM events WHERE run_id=?")
          .get(runId) as any
      ).cursor || 0,
    );
  }
  replay(
    runId: string,
    after = 0,
    limit = 10000,
    until = Number.MAX_SAFE_INTEGER,
  ): FoundationEvent[] {
    return (
      this.db
        .prepare(
          "SELECT seq,body FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
        )
        .all(runId, after, until, Math.max(1, Math.min(limit, 10000))) as {
        seq: number;
        body: string;
      }[]
    ).map((r) => ({ ...JSON.parse(r.body), seq: r.seq }));
  }
  status(runId: string, status: Run["status"], error?: string) {
    this.put("runs", { ...this.run(runId), status, error, updatedAt: now() });
    this.emit(runId, "run.status", { status, ...(error ? { error } : {}) });
  }
  lookupInput(
    sessionId: string,
    key: string,
    digest: string,
  ): { runId: string; inputId: string } | undefined {
    const row = this.db
      .prepare("SELECT hash,body FROM inputs WHERE session_id=? AND key=?")
      .get(sessionId, key) as { hash: string; body: string } | undefined;
    if (!row) return;
    invariant(
      row.hash === digest,
      "clientMessageId was reused with different input",
      409,
      "idempotency_conflict",
    );
    return JSON.parse(row.body);
  }
  recordInput(sessionId: string, key: string, digest: string, result: unknown) {
    this.db
      .prepare("INSERT INTO inputs VALUES(?,?,?,?)")
      .run(sessionId, key, digest, JSON.stringify(result));
  }
  recover() {
    for (const run of this.list<Run>("runs")) {
      if (["running", "queued", "waiting_approval"].includes(run.status)) {
        this.status(
          run.id,
          "interrupted",
          "Host restarted; unfinished effects are not automatically replayed",
        );
        this.emit(run.id, "run.completed", { status: "interrupted" });
      }
    }
    for (const a of this.list<Approval>("approvals"))
      if (a.status === "pending")
        this.put("approvals", { ...a, status: "expired" });
    for (const job of this.list<Job>("jobs"))
      if (["queued", "running"].includes(job.status))
        this.put("jobs", {
          ...job,
          status: "unknown",
          error:
            "Restart interrupted job; inspect remoteId before resubmission",
          updatedAt: now(),
        });
    for (const effect of this.list<ToolEffect>("effects"))
      if (["running", "prepared"].includes(effect.status))
        this.put("effects", {
          ...effect,
          status: "unknown",
          error: "Host restarted during an effect; inspect before repeating",
          updatedAt: now(),
        });
    for (const node of this.list<{ id: string; connected: boolean }>("nodes"))
      this.put("nodes", { ...node, connected: false });
  }
  close() {
    if (this.closed) return;
    if (this.leaseOwner)
      this.db
        .prepare("DELETE FROM kernel_owner WHERE owner=?")
        .run(this.leaseOwner);
    this.db.close();
    this.closed = true;
  }
}
