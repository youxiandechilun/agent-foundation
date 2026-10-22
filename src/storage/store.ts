import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
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
} from "../contracts.js";
import {
  id,
  now,
  invariant,
  redactJson,
  redactJsonText,
} from "../core/util.js";
import {
  entitySchema,
  entityTable,
  entityWhere,
  entityPage,
  tables,
  type EntityFilter,
  type EntityPage,
  type Table,
} from "./entity-query.js";

export type { Table } from "./entity-query.js";

const redactedTables = new Set<Table>([
  "security-audits",
  "inbox",
  "effects",
  "memories",
  "memory-revisions",
  "memory-proposals",
  "runs",
  "summaries",
  "work-plans",
]);

// Runtime records are kept apart from optional host integrations.
export class Store {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;
  private leaseOwner?: string;
  private closed = false;
  constructor(dataDir: string, options: { exclusiveKernel?: boolean } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "foundation.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      PRAGMA temp_store=MEMORY;
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
      CREATE INDEX IF NOT EXISTS messages_run_assistant ON messages(session_id,json_extract(body,'$.runId'),seq) WHERE json_extract(body,'$.message.role')='assistant';
      CREATE TABLE IF NOT EXISTS kernel_owner(slot INTEGER PRIMARY KEY CHECK(slot=1),owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    try {
      if (options.exclusiveKernel) this.acquireKernelLease();
      this.db.exec(entitySchema);
      this.splitEntities();
      if (!this.prepare("SELECT 1 FROM migrations WHERE version=3").get())
        this.transaction(() => {
          for (const row of this.prepare(
            "SELECT session_id,body FROM transcripts",
          ).all() as { session_id: string; body: string }[])
            for (const message of JSON.parse(row.body) as StoredMessage[])
              this.appendTranscript(row.session_id, message);
          this.prepare(
            "INSERT INTO migrations VALUES(3,datetime('now'))",
          ).run();
        });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  // Only share statements for synchronous operations; active iterators use db.prepare.
  // Queries never retain entity values. Bound the cache as filters add query shapes.
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    this.statements.delete(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
    }
    this.statements.set(sql, statement);
    if (this.statements.size > 128)
      this.statements.delete(this.statements.keys().next().value!);
    return statement;
  }
  selectJson<T>(sql: string, values: SQLInputValue[] = []): T[] {
    return (this.prepare(sql).all(...values) as { body: string }[]).map(
      (row) => JSON.parse(row.body) as T,
    );
  }
  selectJsonOne<T>(sql: string, values: SQLInputValue[] = []): T | undefined {
    const row = this.prepare(sql).get(...values) as
      { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }
  private acquireKernelLease() {
    this.transaction(() => {
      const current = this.prepare(
        "SELECT owner,pid,host FROM kernel_owner WHERE slot=1",
      ).get() as { owner: string; pid: number; host: string } | undefined;
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
      this.prepare("INSERT OR REPLACE INTO kernel_owner VALUES(1,?,?,?,?)").run(
        owner,
        process.pid,
        hostname(),
        now(),
      );
      this.leaseOwner = owner;
    });
  }
  /** One-time move from the shared entities table into per-kind tables, keeping rowid order. */
  private splitEntities() {
    const legacy = () =>
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='entities'",
        )
        .get();
    if (!legacy()) return;
    this.transaction(() => {
      // Another connection may have finished the move while this one waited for the lock.
      if (!legacy()) return;
      for (const kind of tables)
        this.db
          .prepare(
            `INSERT OR IGNORE INTO ${entityTable(kind)}(id,body) SELECT id,body FROM entities WHERE kind=? ORDER BY rowid`,
          )
          .run(kind);
      const known = tables.map(() => "?").join(",");
      const { unknown } = this.db
        .prepare(
          `SELECT COUNT(*) AS unknown FROM entities WHERE kind NOT IN (${known})`,
        )
        .get(...tables) as { unknown: number };
      // Rows of kinds this version does not read are kept aside rather than dropped.
      if (unknown)
        this.db
          .prepare(
            `CREATE TABLE IF NOT EXISTS entities_legacy AS SELECT kind,id,body FROM entities WHERE kind NOT IN (${known})`,
          )
          .run(...tables);
      // Dropping the table also frees the legacy index names reused by the split tables.
      this.db.exec(`DROP TABLE entities; ${entitySchema};
        INSERT OR IGNORE INTO migrations VALUES(4,datetime('now'))`);
    });
  }
  private insert<T extends { id: string }>(kind: Table, item: T): string {
    const body = redactedTables.has(kind)
      ? redactJsonText(item)
      : JSON.stringify(item);
    this.prepare(
      `INSERT INTO ${entityTable(kind)}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
    ).run(item.id, body);
    return body;
  }
  /** Persist when the caller does not need a redacted copy of the record. */
  write<T extends { id: string }>(kind: Table, item: T): void {
    this.insert(kind, item);
  }
  put<T extends { id: string }>(kind: Table, item: T): T {
    return JSON.parse(this.insert(kind, item));
  }
  private runSession(runId: string): string {
    // Read the persisted index value without reparsing large Run JSON records.
    const row = this.prepare(
      "SELECT json_extract(body,'$.sessionId') AS sessionId FROM e_runs INDEXED BY runs_session WHERE id=?",
    ).get(runId) as { sessionId: string } | undefined;
    invariant(row, `runs/${runId} not found`, 404, "not_found");
    return row.sessionId;
  }
  get<T>(kind: Table, entityId: string): T {
    const item = this.find<T>(kind, entityId);
    invariant(
      item !== undefined,
      `${kind}/${entityId} not found`,
      404,
      "not_found",
    );
    return item;
  }
  list<T>(kind: Table, filter: EntityFilter = {}, page: EntityPage = {}): T[] {
    const where = entityWhere(filter),
      order = entityPage(page);
    return this.selectJson<T>(
      `SELECT body FROM ${entityTable(kind)}${where.sql}${order.sql}`,
      [...where.values, ...order.values],
    );
  }
  count(kind: Table, filter: EntityFilter = {}): number {
    const where = entityWhere(filter);
    const row = this.prepare(
      `SELECT COUNT(*) AS count FROM ${entityTable(kind)}${where.sql}`,
    ).get(...where.values) as { count: number };
    return row.count;
  }
  committedCost(
    filter: Pick<EntityFilter, "projectId" | "sessionId" | "runId"> = {},
    day?: string,
  ): number {
    const where = entityWhere(filter);
    const dayClause =
      day === undefined
        ? ""
        : `${where.sql ? " AND" : " WHERE"} substr(json_extract(body,'$.createdAt'),1,10)=?`;
    const row = this.prepare(
      `SELECT TOTAL(CASE json_extract(body,'$.status')
      WHEN 'void' THEN 0 WHEN 'settled' THEN COALESCE(json_extract(body,'$.chargedMicros'),0)
      ELSE json_extract(body,'$.reservedMicros') END) AS total
      FROM e_cost_ledger${where.sql}${dayClause}`,
    ).get(...where.values, ...(day === undefined ? [] : [day])) as {
      total: number;
    };
    // TOTAL avoids SQLite's signed-integer overflow; accepted sums must stay exact in JS.
    invariant(
      Number.isSafeInteger(row.total) && row.total >= 0,
      "Committed cost exceeds safe integer range",
      402,
      "cost_budget_exhausted",
    );
    return row.total;
  }
  find<T>(kind: Table, entityId: string): T | undefined {
    return this.selectJsonOne<T>(
      `SELECT body FROM ${entityTable(kind)} WHERE id=?`,
      [entityId],
    );
  }
  remove(kind: Table, entityId: string) {
    this.prepare(`DELETE FROM ${entityTable(kind)} WHERE id=?`).run(entityId);
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
    return this.selectJson<StoredMessage>(
      "SELECT body FROM messages WHERE session_id=? ORDER BY seq",
      [sessionId],
    );
  }
  transcriptSlice(sessionId: string, offset: number, limit: number) {
    entityPage({ offset, limit });
    const { total } = this.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE session_id=?",
    ).get(sessionId) as { total: number };
    const messages = this.selectJson<StoredMessage>(
      "SELECT body FROM messages WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?",
      [sessionId, limit, offset],
    );
    return { total, offset, messages, hasMore: total > offset + limit };
  }
  lastAssistant(sessionId: string, runId: string): StoredMessage | undefined {
    return this.selectJsonOne<StoredMessage>(
      "SELECT body FROM messages WHERE session_id=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.message.role')='assistant' ORDER BY seq DESC LIMIT 1",
      [sessionId, runId],
    );
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
    const rows = this.prepare(
      "SELECT seq,body FROM messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
    ).all(sessionId, after, limit + 1) as { seq: number; body: string }[];
    const page = rows.slice(0, limit);
    return {
      messages: page.map((row) => ({ ...JSON.parse(row.body), seq: row.seq })),
      cursor: page.at(-1)?.seq || after,
      hasMore: rows.length > limit,
    };
  }
  appendTranscript(sessionId: string, message: StoredMessage) {
    const body = redactJsonText(message);
    // A conflicting INSERT is dramatically slower in Node's SQLite binding, so
    // check the unique key first and write only fresh messages.
    const previous = this.prepare(
      "SELECT body FROM messages WHERE session_id=? AND message_id=?",
    ).get(sessionId, message.id) as { body: string } | undefined;
    invariant(
      !previous || previous.body === body,
      "Message ID reused with different content",
      409,
    );
    if (!previous)
      this.prepare(
        "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
      ).run(sessionId, message.id, body);
  }
  /** Replace a transcript, rewriting only the suffix after the unchanged prefix. */
  saveTranscript(sessionId: string, messages: StoredMessage[]) {
    this.transaction(() => {
      const existing = this.prepare(
        "SELECT seq,message_id,body FROM messages WHERE session_id=? ORDER BY seq",
      ).all(sessionId) as { seq: number; message_id: string; body: string }[];
      let kept = 0;
      while (
        kept < existing.length &&
        kept < messages.length &&
        existing[kept].message_id === messages[kept].id &&
        existing[kept].body === redactJsonText(messages[kept])
      )
        kept++;
      if (kept < existing.length)
        this.prepare("DELETE FROM messages WHERE session_id=? AND seq>=?").run(
          sessionId,
          existing[kept].seq,
        );
      for (const message of messages.slice(kept))
        this.appendTranscript(sessionId, message);
    });
  }
  emit(
    runId: string,
    type: string,
    data: Record<string, unknown>,
    durable = true,
  ): FoundationEvent {
    const safeData = redactJson(data);
    const event: FoundationEvent = {
      schemaVersion: 1,
      id: id("ev"),
      runId,
      sessionId: this.runSession(runId),
      type,
      timestamp: now(),
      seq: null,
      data: safeData,
    };
    if (durable) {
      const result = this.prepare(
        "INSERT INTO events(run_id,body) VALUES(?,?)",
      ).run(runId, JSON.stringify(event));
      event.seq = Number(result.lastInsertRowid);
    }
    this.events.emit(runId, event);
    return event;
  }
  eventCursor(runId: string) {
    const row = this.prepare(
      "SELECT MAX(seq) AS cursor FROM events WHERE run_id=?",
    ).get(runId) as { cursor: number | null };
    return row.cursor ?? 0;
  }
  /** Ephemeral deltas are only observable by live subscribers. */
  emitEphemeral(runId: string, type: string, data: Record<string, unknown>) {
    if (!this.events.listenerCount(runId)) return;
    this.emit(runId, type, data, false);
  }
  replay(
    runId: string,
    after = 0,
    limit = 10000,
    until = Number.MAX_SAFE_INTEGER,
  ): FoundationEvent[] {
    return (
      this.prepare(
        "SELECT seq,body FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
      ).all(runId, after, until, Math.max(1, Math.min(limit, 10000))) as {
        seq: number;
        body: string;
      }[]
    ).map((r) => ({ ...JSON.parse(r.body), seq: r.seq }));
  }
  status(runId: string, status: Run["status"], error?: string) {
    this.write("runs", {
      ...this.run(runId),
      status,
      error,
      updatedAt: now(),
    });
    this.emit(runId, "run.status", { status, ...(error ? { error } : {}) });
  }
  lookupInput(
    sessionId: string,
    key: string,
    digest: string,
  ): { runId: string; inputId: string } | undefined {
    const row = this.prepare(
      "SELECT hash,body FROM inputs WHERE session_id=? AND key=?",
    ).get(sessionId, key) as { hash: string; body: string } | undefined;
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
    this.prepare("INSERT INTO inputs VALUES(?,?,?,?)").run(
      sessionId,
      key,
      digest,
      JSON.stringify(result),
    );
  }
  recover() {
    for (const run of this.list<Run>("runs", {
      status: ["running", "queued", "waiting_approval"],
    })) {
      this.status(
        run.id,
        "interrupted",
        "Host restarted; unfinished effects are not automatically replayed",
      );
      this.emit(run.id, "run.completed", { status: "interrupted" });
    }
    for (const a of this.list<Approval>("approvals", { status: "pending" }))
      this.write("approvals", { ...a, status: "expired" });
    for (const job of this.list<Job>("jobs", { status: ["queued", "running"] }))
      this.write("jobs", {
        ...job,
        status: "unknown",
        error: "Restart interrupted job; inspect remoteId before resubmission",
        updatedAt: now(),
      });
    for (const effect of this.list<ToolEffect>("effects", {
      status: ["running", "prepared"],
    }))
      this.write("effects", {
        ...effect,
        status: "unknown",
        error: "Host restarted during an effect; inspect before repeating",
        updatedAt: now(),
      });
    for (const node of this.list<{ id: string; connected: boolean }>("nodes"))
      this.write("nodes", { ...node, connected: false });
  }
  close() {
    if (this.closed) return;
    if (this.leaseOwner)
      this.prepare("DELETE FROM kernel_owner WHERE owner=?").run(
        this.leaseOwner,
      );
    this.db.close();
    this.statements.clear();
    this.closed = true;
  }
}
