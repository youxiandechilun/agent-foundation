import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import type { Message } from "../runtime/types.js";
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
import { activeRunStatuses, terminalStatuses } from "../contracts.js";
import {
  id,
  hash,
  now,
  invariant,
  redactJsonText,
  createJsonRedactor,
} from "../core/util.js";
import {
  entitySchema,
  ensureEntitySchema,
  entityTable,
  entityWhere,
  effectWhere,
  entityPage,
  committedCostExpression,
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
type EntityStatement = "insert" | "find" | "remove" | "count";
type JsonRow = string[] | { body: string };
type JsonStatement = { statement: StatementSync; bodyColumn: number };
type EntityWriter = (item: { id: string }) => string;
interface MessagePosition {
  sessionId: string;
  seq: number;
  messageId: string;
  generation: number;
}
export interface HistoryCheckpoint {
  throughSeq: number;
  summary: Message;
}
const returnArrays = (statement: StatementSync) => {
  const supported = statement as StatementSync & {
    setReturnArrays?: (enabled: boolean) => void;
  };
  supported.setReturnArrays?.(true);
};

// Runtime records are kept apart from optional host integrations.
export class Store {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter().setMaxListeners(0);
  private readonly statements = new Map<string, StatementSync>();
  // Wire text of emitted events, so each subscriber reuses one serialization.
  private readonly eventText = new WeakMap<FoundationEvent, string>();
  private readonly messagePositions = new WeakMap<Message, MessagePosition>();
  private readonly jsonStatements = new Map<string, JsonStatement>();
  private readonly entityStatements = new Map<
    Table,
    Partial<Record<EntityStatement, StatementSync>>
  >();
  private writers: Partial<Record<Table, EntityWriter>> = Object.create(null);
  private transactionDepth = 0;
  private leaseOwner?: string;
  private closed = false;
  constructor(dataDir: string, options: { exclusiveKernel?: boolean } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "foundation.sqlite"));
    // Every writer registers this before opening an expression index. Keep the
    // derived digest outside public memory JSON and avoid indexing large text.
    this.db.function(
      "foundation_content_hash",
      { deterministic: true },
      (value) => (typeof value === "string" ? hash(value) : null),
    );
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      PRAGMA temp_store=MEMORY; PRAGMA recursive_triggers=ON; PRAGMA cache_size=-8192;
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
      CREATE TABLE IF NOT EXISTS transcript_generations(session_id TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_contexts(session_id TEXT NOT NULL,route_id TEXT NOT NULL,through_seq INTEGER NOT NULL,summary TEXT NOT NULL,PRIMARY KEY(session_id,route_id));
      CREATE TRIGGER IF NOT EXISTS messages_context_insert AFTER INSERT ON messages WHEN new.seq<(SELECT MAX(seq) FROM messages WHERE session_id=new.session_id) BEGIN
        DELETE FROM transcript_contexts WHERE session_id=new.session_id AND through_seq>=new.seq;
        INSERT INTO transcript_generations VALUES(new.session_id,1) ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_context_delete AFTER DELETE ON messages BEGIN
        DELETE FROM transcript_contexts WHERE session_id=old.session_id AND through_seq>=old.seq;
        INSERT INTO transcript_generations VALUES(old.session_id,1) ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_context_update AFTER UPDATE OF body,message_id,session_id,seq ON messages BEGIN
        DELETE FROM transcript_contexts WHERE (session_id=old.session_id AND through_seq>=old.seq) OR (session_id=new.session_id AND through_seq>=new.seq);
        INSERT INTO transcript_generations VALUES(old.session_id,1) ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
        INSERT INTO transcript_generations VALUES(new.session_id,1) ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
      END;
    `);
    try {
      if (options.exclusiveKernel) this.acquireKernelLease();
      const schema = this.transaction(() => ensureEntitySchema(this.db));
      this.splitEntities();
      this.ensureAuxiliarySchema();
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
      this.ensureTranscriptCounts(schema);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  /** Add derived structures after legacy entity migration has completed. */
  private ensureAuxiliarySchema() {
    this.transaction(() => {
      const exists = (name: string) =>
        Boolean(
          this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name),
        );
      const hadMemoryMap = exists("memory_fts_map");
      const costObjects = [
        "cost_ledger_total",
        "cost_total_insert",
        "cost_total_update",
        "cost_total_delete",
      ];
      const rebuildCost =
        costObjects.some((name) => !exists(name)) ||
        !this.db.prepare("SELECT 1 FROM cost_ledger_total WHERE slot=1").get();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_fts_map(fts_rowid INTEGER PRIMARY KEY,memory_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS memory_fts_map_id ON memory_fts_map(memory_id);
        CREATE TABLE IF NOT EXISTS memory_vector_norms(id TEXT PRIMARY KEY,norm REAL NOT NULL);
        CREATE TRIGGER IF NOT EXISTS memory_vector_norm_insert AFTER INSERT ON memory_vectors BEGIN
          DELETE FROM memory_vector_norms WHERE id=new.id;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_vector_norm_update AFTER UPDATE ON memory_vectors BEGIN
          DELETE FROM memory_vector_norms WHERE id=old.id OR id=new.id;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_vector_norm_delete AFTER DELETE ON memory_vectors BEGIN
          DELETE FROM memory_vector_norms WHERE id=old.id;
        END;
        CREATE TABLE IF NOT EXISTS billing_deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,charge_id TEXT NOT NULL UNIQUE,delivery_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cost_ledger_total(slot INTEGER PRIMARY KEY CHECK(slot=1),total INTEGER NOT NULL,dirty INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO cost_ledger_total VALUES(1,0,0);
        CREATE TRIGGER IF NOT EXISTS jobs_idempotency_insert BEFORE INSERT ON e_jobs
          WHEN json_extract(new.body,'$.idempotencyKey') IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM e_jobs WHERE id=new.id)
            AND EXISTS(SELECT 1 FROM e_jobs WHERE json_extract(body,'$.projectId')=json_extract(new.body,'$.projectId') AND json_extract(body,'$.idempotencyKey')=json_extract(new.body,'$.idempotencyKey'))
          BEGIN SELECT RAISE(ABORT,'Media idempotency key already exists'); END;
      `);
      if (!hadMemoryMap)
        this.db.exec(
          "INSERT INTO memory_fts_map SELECT rowid,id FROM memory_fts WHERE id IS NOT NULL",
        );
      const amount = (row: "old" | "new") =>
        `COALESCE((${committedCostExpression.replaceAll("json_extract(body,", `json_extract(${row}.body,`)}),0)`;
      for (const [operation, change] of [
        ["INSERT", `total+${amount("new")}`],
        ["UPDATE", `total-${amount("old")}+${amount("new")}`],
        ["DELETE", `total-${amount("old")}`],
      ])
        this.db
          .exec(`CREATE TRIGGER IF NOT EXISTS cost_total_${operation.toLowerCase()} AFTER ${operation}${operation === "UPDATE" ? " OF body" : ""} ON e_cost_ledger${operation === "UPDATE" ? ` WHEN ${amount("old")} IS NOT ${amount("new")}` : ""} BEGIN
          UPDATE cost_ledger_total SET dirty=dirty OR typeof(${change})<>'integer',total=${change} WHERE slot=1;
        END`);
      if (rebuildCost) this.rebuildCommittedCostTotal();
    });
  }
  // Only share statements for synchronous operations; active iterators use db.prepare.
  // Queries never retain entity values. Bound the cache as filters add query shapes.
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement) {
      // Refresh recency so hot statements survive bursts of new filter shapes.
      this.statements.delete(sql);
      this.statements.set(sql, statement);
      return statement;
    }
    statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > 128)
      this.statements.delete(this.statements.keys().next().value!);
    return statement;
  }
  // Fixed entity kinds bound this cache. Retain statements, never record values.
  private entityStatement(
    kind: Table,
    operation: EntityStatement,
  ): StatementSync {
    let statements = this.entityStatements.get(kind);
    if (!statements) {
      entityTable(kind);
      statements = {};
      this.entityStatements.set(kind, statements);
    }
    const cached = statements[operation];
    if (cached) return cached;
    const table = entityTable(kind);
    const sql = {
      insert: `INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
      find: `SELECT body FROM ${table} WHERE id=?`,
      remove: `DELETE FROM ${table} WHERE id=?`,
      count: `SELECT COUNT(*) AS count FROM ${table}`,
    }[operation];
    const statement = this.db.prepare(sql);
    if (operation === "find") returnArrays(statement);
    return (statements[operation] = statement);
  }
  private jsonStatement(sql: string): JsonStatement {
    const cached = this.jsonStatements.get(sql);
    if (cached) {
      this.jsonStatements.delete(sql);
      this.jsonStatements.set(sql, cached);
      return cached;
    }
    const statement = this.db.prepare(sql);
    // Callers of prepare(sql) retain named rows even when this SQL is also read here.
    returnArrays(statement);
    const prepared = {
      statement,
      bodyColumn: statement
        .columns()
        .findLastIndex((column) => column.name === "body"),
    };
    this.jsonStatements.set(sql, prepared);
    if (this.jsonStatements.size > 128)
      this.jsonStatements.delete(this.jsonStatements.keys().next().value!);
    return prepared;
  }
  private ensureTranscriptCounts(schema: ReadonlySet<string>): void {
    if (
      [
        "transcript_counts",
        "messages_count_insert",
        "messages_count_delete",
        "messages_count_move",
      ].every((name) => schema.has(name))
    )
      return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcript_counts(session_id TEXT PRIMARY KEY,total INTEGER NOT NULL CHECK(total>=0));
        DELETE FROM transcript_counts;
        INSERT INTO transcript_counts SELECT session_id,COUNT(*) FROM messages GROUP BY session_id;
        CREATE TRIGGER IF NOT EXISTS messages_count_insert AFTER INSERT ON messages BEGIN
          INSERT INTO transcript_counts VALUES(new.session_id,1) ON CONFLICT(session_id) DO UPDATE SET total=total+1;
        END;
        CREATE TRIGGER IF NOT EXISTS messages_count_delete AFTER DELETE ON messages BEGIN
          UPDATE transcript_counts SET total=total-1 WHERE session_id=old.session_id;
        END;
        CREATE TRIGGER IF NOT EXISTS messages_count_move AFTER UPDATE OF session_id ON messages WHEN new.session_id<>old.session_id BEGIN
          UPDATE transcript_counts SET total=total-1 WHERE session_id=old.session_id;
          INSERT INTO transcript_counts VALUES(new.session_id,1) ON CONFLICT(session_id) DO UPDATE SET total=total+1;
        END;
        INSERT OR IGNORE INTO migrations VALUES(5,datetime('now'));
      `);
    });
  }
  selectJson<T>(sql: string, values: SQLInputValue[] = []): T[] {
    const { statement, bodyColumn } = this.jsonStatement(sql);
    const rows = statement.all(...values) as unknown as JsonRow[];
    const result = new Array<T>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      result[i] = JSON.parse(
        Array.isArray(row) ? row[bodyColumn] : row.body,
      ) as T;
    }
    return result;
  }
  selectJsonOne<T>(sql: string, values: SQLInputValue[] = []): T | undefined {
    const { statement, bodyColumn } = this.jsonStatement(sql);
    const row = statement.get(...values) as unknown as JsonRow | undefined;
    return row
      ? (JSON.parse(Array.isArray(row) ? row[bodyColumn] : row.body) as T)
      : undefined;
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
    let writer = this.writers[kind];
    if (!writer) {
      const statement = this.entityStatement(kind, "insert");
      writer = this.writers[kind] = redactedTables.has(kind)
        ? (value) => {
            const body = redactJsonText(value);
            statement.run(value.id, body);
            return body;
          }
        : (value) => {
            const body = JSON.stringify(value);
            statement.run(value.id, body);
            return body;
          };
    }
    return writer(item);
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
    const where =
        kind === "effects" && filter.status !== undefined
          ? effectWhere(filter)
          : entityWhere(filter),
      order = entityPage(page);
    return this.selectJson<T>(
      `SELECT body FROM ${entityTable(kind)}${where.sql}${order.sql}`,
      [...where.values, ...order.values],
    );
  }
  /** Indexed lookup also rejects conflicting historical duplicates without loading their bodies. */
  findMediaJob(
    projectId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Job | undefined {
    const values = [projectId, idempotencyKey];
    invariant(
      !this.prepare(
        "SELECT 1 FROM e_jobs WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.idempotencyKey')=? AND json_extract(body,'$.requestHash') IS NOT ? LIMIT 1",
      ).get(...values, requestHash),
      "Media idempotency key reused with different input",
      409,
      "idempotency_conflict",
    );
    return this.selectJsonOne<Job>(
      "SELECT body FROM e_jobs WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.idempotencyKey')=? ORDER BY rowid LIMIT 1",
      values,
    );
  }
  /** Stable rowid cursor: updates do not move existing records to a different page. */
  page<T>(kind: Table, filter: EntityFilter = {}, after = 0, limit = 100) {
    const where = entityWhere(filter);
    return this.selectJsonPage<T>(
      `SELECT rowid AS cursor,body FROM ${entityTable(kind)}${where.sql || " WHERE 1"}`,
      where.values,
      after,
      limit,
    );
  }
  selectJsonPage<T>(
    sql: string,
    values: SQLInputValue[],
    after = 0,
    limit = 100,
  ) {
    invariant(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 1000,
      "Invalid entity page",
    );
    const rows = this.prepare(`${sql} AND rowid>? ORDER BY rowid LIMIT ?`).all(
      ...values,
      after,
      limit + 1,
    ) as {
      cursor: number;
      body: string;
    }[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => JSON.parse(row.body) as T),
      cursor: selected.at(-1)?.cursor ?? after,
      hasMore: rows.length > limit,
    };
  }
  /** Select requested primary keys while retaining the table's insertion order. */
  listByIds<T>(kind: Table, entityIds: readonly string[]): T[] {
    invariant(
      Array.isArray(entityIds) &&
        entityIds.every((value) => typeof value === "string"),
      "Invalid entity IDs",
    );
    if (!entityIds.length) return [];
    return this.selectJson<T>(
      `SELECT body FROM ${entityTable(kind)} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
      [JSON.stringify(entityIds)],
    );
  }
  count(kind: Table, filter: EntityFilter = {}): number {
    if (!Object.keys(filter).length)
      return (this.entityStatement(kind, "count").get() as { count: number })
        .count;
    const where =
      kind === "effects" && filter.status !== undefined
        ? effectWhere(filter)
        : entityWhere(filter);
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
    const cached =
      !where.sql && day === undefined
        ? (this.prepare(
            "SELECT CAST(total AS REAL) AS total,dirty FROM cost_ledger_total WHERE slot=1",
          ).get() as { total: number; dirty: number })
        : undefined;
    const row =
      cached && !cached.dirty
        ? cached
        : (this.prepare(
            `SELECT TOTAL(${committedCostExpression}) AS total
      FROM e_cost_ledger${where.sql}${dayClause}`,
          ).get(...where.values, ...(day === undefined ? [] : [day])) as {
            total: number;
          });
    // TOTAL avoids SQLite's signed-integer overflow; accepted sums must stay exact in JS.
    invariant(
      Number.isSafeInteger(row.total) && row.total >= 0,
      "Committed cost exceeds safe integer range",
      402,
      "cost_budget_exhausted",
    );
    return row.total;
  }
  /** Rebuild after an administrative import/repair; triggers normally keep the total exact. */
  rebuildCommittedCostTotal() {
    return this.transaction(() => {
      const { total } = this.prepare(
        `SELECT TOTAL(${committedCostExpression}) AS total FROM e_cost_ledger`,
      ).get() as { total: number };
      const exact = Number.isSafeInteger(total);
      this.prepare(
        "INSERT INTO cost_ledger_total VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET total=excluded.total,dirty=excluded.dirty",
      ).run(exact ? total : 0, exact ? 0 : 1);
      return total;
    });
  }
  /** Offline consistency check; does not replace the constant-time budget read. */
  verifyCommittedCostTotal() {
    const stored = this.prepare(
      "SELECT CAST(total AS REAL) AS total,dirty FROM cost_ledger_total WHERE slot=1",
    ).get() as { total: number; dirty: number };
    const { total } = this.prepare(
      `SELECT TOTAL(${committedCostExpression}) AS total FROM e_cost_ledger`,
    ).get() as { total: number };
    return {
      stored: stored.total,
      calculated: total,
      valid: !stored.dirty && stored.total === total,
    };
  }
  /** Ledger totals as CostLedger.summary reports them, without loading the entries. */
  costTotals(filter: EntityFilter = {}) {
    const where = entityWhere(filter);
    return this.prepare(
      `SELECT COUNT(*) AS count,
        TOTAL(COALESCE(json_extract(body,'$.chargedMicros'),0)) AS chargedMicros,
        TOTAL(CASE WHEN json_extract(body,'$.status') IN ('reserved','unknown')
          THEN json_extract(body,'$.reservedMicros') ELSE 0 END) AS heldMicros,
        TOTAL(${committedCostExpression}) AS committedMicros,
        TOTAL(json_extract(body,'$.basis')='unpriced') AS unpriced
      FROM e_cost_ledger${where.sql}`,
    ).get(...where.values) as {
      count: number;
      chargedMicros: number;
      heldMicros: number;
      committedMicros: number;
      unpriced: number;
    };
  }
  find<T>(kind: Table, entityId: string): T | undefined {
    const row = this.entityStatement(kind, "find").get(entityId) as unknown as
      JsonRow | undefined;
    return row
      ? (JSON.parse(Array.isArray(row) ? row[0] : row.body) as T)
      : undefined;
  }
  remove(kind: Table, entityId: string) {
    this.entityStatement(kind, "remove").run(entityId);
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
    return this.transcriptWindow(sessionId);
  }
  transcriptCount(sessionId: string): number {
    return (
      (
        this.prepare(
          "SELECT total FROM transcript_counts WHERE session_id=?",
        ).get(sessionId) as { total: number } | undefined
      )?.total || 0
    );
  }
  private transcriptGeneration(sessionId: string): number {
    return (
      (
        this.prepare(
          "SELECT generation FROM transcript_generations WHERE session_id=?",
        ).get(sessionId) as { generation: number } | undefined
      )?.generation || 0
    );
  }
  /** Parse one row at a time; never retain a second array of serialized history. */
  transcriptWindow(
    sessionId: string,
    after = 0,
    maxBytes = Infinity,
  ): StoredMessage[] {
    const result: StoredMessage[] = [];
    const generation = this.transcriptGeneration(sessionId);
    let bytes = 0;
    const statement = this.prepare(
      "SELECT seq,body FROM messages WHERE session_id=? AND seq>? ORDER BY seq",
    );
    for (const row of statement.iterate(sessionId, after) as Iterable<{
      seq: number;
      body: string;
    }>) {
      bytes += Buffer.byteLength(row.body);
      invariant(
        bytes <= maxBytes,
        "Session history byte budget exceeded; fork or export it first",
        413,
        "history_capacity",
      );
      const item = JSON.parse(row.body) as StoredMessage;
      this.messagePositions.set(item.message, {
        sessionId,
        seq: row.seq,
        messageId: item.id,
        generation,
      });
      result.push(item);
    }
    return result;
  }
  historyCheckpoint(
    sessionId: string,
    routeId: string,
  ): HistoryCheckpoint | undefined {
    const row = this.prepare(
      "SELECT through_seq,summary FROM transcript_contexts WHERE session_id=? AND route_id=?",
    ).get(sessionId, routeId) as
      { through_seq: number; summary: string } | undefined;
    return row
      ? {
          throughSeq: row.through_seq,
          summary: JSON.parse(row.summary) as Message,
        }
      : undefined;
  }
  /** A summary is usable only when its covered persisted prefix has not changed. */
  saveHistoryCheckpoint(
    sessionId: string,
    routeId: string,
    through: Message,
    summary: Message,
  ): boolean {
    const position = this.messagePositions.get(through);
    if (
      !position ||
      position.sessionId !== sessionId ||
      position.generation !== this.transcriptGeneration(sessionId)
    )
      return false;
    const row = this.prepare(
      "SELECT message_id FROM messages WHERE session_id=? AND seq=?",
    ).get(sessionId, position.seq) as { message_id: string } | undefined;
    if (row?.message_id !== position.messageId) return false;
    const assistant = this.prepare(
      "SELECT seq,body FROM messages WHERE session_id=? AND seq<=? AND json_extract(body,'$.message.role')='assistant' ORDER BY seq DESC LIMIT 1",
    ).get(sessionId, position.seq) as { seq: number; body: string } | undefined;
    if (assistant) {
      const item = JSON.parse(assistant.body) as StoredMessage;
      if (item.message.role === "assistant") {
        const calls = item.message.content.filter(
          (part) => part.type === "toolCall",
        );
        if (calls.length) {
          const results = this.prepare(
            "SELECT json_extract(body,'$.message.toolCallId') AS id FROM messages WHERE session_id=? AND seq>? AND seq<=? AND json_extract(body,'$.message.role')='toolResult'",
          ).all(sessionId, assistant.seq, position.seq) as { id: string }[];
          const completed = new Set(results.map((result) => result.id));
          if (calls.some((call) => !completed.has(call.id))) return false;
        }
      }
    }
    this.prepare(
      "INSERT INTO transcript_contexts VALUES(?,?,?,?) ON CONFLICT(session_id,route_id) DO UPDATE SET through_seq=excluded.through_seq,summary=excluded.summary",
    ).run(sessionId, routeId, position.seq, redactJsonText(summary));
    return true;
  }
  transcriptSlice(sessionId: string, offset: number, limit: number) {
    entityPage({ offset, limit });
    const total =
      (
        this.prepare(
          "SELECT total FROM transcript_counts WHERE session_id=?",
        ).get(sessionId) as { total: number } | undefined
      )?.total || 0;
    const messages = this.selectJson<StoredMessage>(
      "SELECT body FROM messages WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?",
      [sessionId, limit, offset],
    );
    return { total, offset, messages, hasMore: total > offset + limit };
  }
  /**
   * Changes whenever the transcript does: messages are only inserted or deleted, and
   * sequence numbers are never reused, so count and sequence sums identify a version.
   */
  transcriptVersion(sessionId: string): string {
    const row = this.prepare(
      "SELECT COUNT(*) AS count,MAX(seq) AS last,TOTAL(seq) AS total FROM messages WHERE session_id=?",
    ).get(sessionId) as { count: number; last: number | null; total: number };
    return `${row.count}:${row.last ?? 0}:${row.total}`;
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
  /**
   * `messageText` is the already redacted JSON of `message.message`; supplying it
   * avoids serializing and redacting the same message a second time.
   */
  appendTranscript(
    sessionId: string,
    message: StoredMessage,
    messageText?: string,
  ) {
    const body =
      messageText === undefined
        ? redactJsonText(message)
        : spliceJson(message, "message", messageText);
    // A conflicting INSERT is dramatically slower in Node's SQLite binding, so
    // check the unique key first and write only fresh messages.
    const previous = this.prepare(
      "SELECT seq,body FROM messages WHERE session_id=? AND message_id=?",
    ).get(sessionId, message.id) as { seq: number; body: string } | undefined;
    invariant(
      !previous || previous.body === body,
      "Message ID reused with different content",
      409,
    );
    const seq =
      previous?.seq ??
      Number(
        this.prepare(
          "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
        ).run(sessionId, message.id, body).lastInsertRowid,
      );
    this.messagePositions.set(message.message, {
      sessionId,
      seq,
      messageId: message.id,
      generation: this.transcriptGeneration(sessionId),
    });
  }
  /** Replace a transcript, rewriting only the suffix after the unchanged prefix. */
  saveTranscript(sessionId: string, messages: StoredMessage[], after = 0) {
    this.transaction(() => {
      // A synchronous replacement is one redaction operation. Do not rebuild
      // the credential snapshot for every message or serialize its suffix twice.
      const encode = createJsonRedactor();
      const identities = new Map<string, string>();
      const incoming: { id: string; body: string }[] = [];
      for (const message of messages) {
        const body = encode(message),
          previous = identities.get(message.id);
        invariant(
          previous === undefined || previous === body,
          "Message ID reused with different content",
          409,
        );
        if (previous === undefined) {
          identities.set(message.id, body);
          incoming.push({ id: message.id, body });
        }
      }
      const existing = this.prepare(
        "SELECT seq,message_id,body FROM messages WHERE session_id=? AND seq>? ORDER BY seq",
      ).all(sessionId, after) as {
        seq: number;
        message_id: string;
        body: string;
      }[];
      let kept = 0;
      while (
        kept < existing.length &&
        kept < incoming.length &&
        existing[kept].message_id === incoming[kept].id &&
        existing[kept].body === incoming[kept].body
      )
        kept++;
      if (kept < existing.length)
        this.prepare("DELETE FROM messages WHERE session_id=? AND seq>=?").run(
          sessionId,
          existing[kept].seq,
        );
      // Incoming identities are unique, and every old suffix row was removed.
      // The unchanged prefix cannot conflict, so no per-message SELECT is needed.
      const insert = this.prepare(
        "INSERT INTO messages(session_id,message_id,body) VALUES(?,?,?)",
      );
      for (let i = kept; i < incoming.length; i++)
        insert.run(sessionId, incoming[i].id, incoming[i].body);
    });
  }
  /**
   * `redactedText`, when given, is the already redacted JSON of `data`, and `data`
   * itself must already be redacted; the payload is then neither serialized nor
   * parsed again.
   */
  emit(
    runId: string,
    type: string,
    data: Record<string, unknown>,
    durable = true,
    redactedText?: string,
  ): FoundationEvent {
    // Serialize the redacted payload once: the stored body and the wire text splice
    // that text into the envelope, equal to JSON.stringify of the whole event.
    const dataText = redactedText ?? redactJsonText(data);
    const envelope = {
      schemaVersion: 1 as const,
      id: id("ev"),
      runId,
      sessionId: this.runSession(runId),
      type,
      timestamp: now(),
      seq: null as number | null,
    };
    const event: FoundationEvent = {
      ...envelope,
      data: redactedText === undefined ? JSON.parse(dataText) : data,
    };
    if (durable) {
      const result = this.prepare(
        "INSERT INTO events(run_id,body) VALUES(?,?)",
      ).run(runId, spliceJson(envelope, "data", dataText));
      event.seq = envelope.seq = Number(result.lastInsertRowid);
    }
    if (this.events.listenerCount(runId)) {
      this.eventText.set(event, spliceJson(envelope, "data", dataText));
      this.events.emit(runId, event);
    }
    return event;
  }
  /** JSON text of an event, reusing the serialization made when it was emitted. */
  eventJson(event: FoundationEvent): string {
    return this.eventText.get(event) ?? JSON.stringify(event);
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
    maxBytes = Infinity,
  ): FoundationEvent[] {
    const events: FoundationEvent[] = [];
    let bytes = 0;
    const statement = this.prepare(
      "SELECT seq,body FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
    );
    for (const row of statement.iterate(
      runId,
      after,
      until,
      Math.max(1, Math.min(limit, 10000)),
    ) as Iterable<{ seq: number; body: string }>) {
      const size = Buffer.byteLength(row.body);
      if (events.length && bytes + size > maxBytes) break;
      bytes += size;
      events.push({ ...JSON.parse(row.body), seq: row.seq } as FoundationEvent);
      if (bytes >= maxBytes) break;
    }
    return events;
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
      status: activeRunStatuses,
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
    // Only startup recovery owns this transition. Another NodeManager can share
    // the live store, so constructing one must not revoke an active caller.
    this.prepare(
      "UPDATE e_node_tasks SET body=json_set(body,'$.status',CASE json_extract(body,'$.status') WHEN 'queued' THEN 'cancelled' ELSE 'unknown' END,'$.finishedAt',?,'$.error',?) WHERE json_extract(body,'$.status') IN ('queued','running')",
    ).run(
      now(),
      "Host restarted during a node task; inspect device before repeating",
    );
  }
  /**
   * Delete data that only long-finished runs reference, in bounded batches so a
   * large backlog never holds the write lock for long. Runs, transcripts, effects
   * and the cost ledger are kept. A cutoff of undefined skips that category.
   */
  prune(cutoffs: { events?: string; caches?: string }, batch = 2000) {
    invariant(
      Number.isSafeInteger(batch) && batch > 0 && batch <= 10000,
      "Invalid retention batch",
    );
    return this.pruneBatch(cutoffs, batch, true);
  }
  /** Live maintenance yields between bounded transactions; synchronous prune is for offline callers. */
  async pruneAsync(
    cutoffs: { events?: string; caches?: string },
    batch = 2000,
    signal?: AbortSignal,
  ) {
    invariant(
      Number.isSafeInteger(batch) && batch > 0 && batch <= 10000,
      "Invalid retention batch",
    );
    const total = { events: 0, summaries: 0, workContexts: 0 };
    for (;;) {
      signal?.throwIfAborted();
      const deleted = this.pruneBatch(cutoffs, batch, false);
      for (const key of ["events", "summaries", "workContexts"] as const)
        total[key] += deleted[key];
      if (Object.values(deleted).every((count) => count < batch)) return total;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  private pruneBatch(
    cutoffs: { events?: string; caches?: string },
    batch: number,
    all: boolean,
  ) {
    const deleted = { events: 0, summaries: 0, workContexts: 0 };
    const repeat = (sql: string, ...values: SQLInputValue[]) => {
      let total = 0;
      for (;;) {
        const changes = Number(
          this.transaction(() => this.prepare(sql).run(...values, batch))
            .changes,
        );
        total += changes;
        if (!all || changes < batch) return total;
      }
    };
    const terminal = [...terminalStatuses].map(() => "?").join(",");
    if (cutoffs.events !== undefined)
      deleted.events = repeat(
        `DELETE FROM events WHERE seq IN (SELECT e.seq FROM events e JOIN e_runs r ON r.id=e.run_id
          WHERE json_extract(r.body,'$.status') IN (${terminal}) AND json_extract(r.body,'$.updatedAt')<? LIMIT ?)`,
        ...terminalStatuses,
        cutoffs.events,
      );
    if (cutoffs.caches !== undefined) {
      // Pointers name the summary each session extends; those stay until replaced.
      deleted.summaries = repeat(
        `DELETE FROM e_summaries WHERE id IN (SELECT id FROM e_summaries
          WHERE json_extract(body,'$.createdAt')<? AND id NOT IN (
            SELECT json_extract(body,'$.summaryId') FROM e_summaries WHERE json_extract(body,'$.summaryId') IS NOT NULL)
          LIMIT ?)`,
        cutoffs.caches,
      );
      deleted.workContexts = repeat(
        `DELETE FROM e_work_contexts WHERE id IN (SELECT id FROM e_work_contexts
          WHERE json_extract(body,'$.updatedAt')<? LIMIT ?)`,
        cutoffs.caches,
      );
    }
    // Refresh planner statistics after large deletions; cheap when nothing changed.
    this.db.exec("PRAGMA optimize");
    return deleted;
  }
  get isClosed() {
    return this.closed;
  }
  close() {
    if (this.closed) return;
    if (this.leaseOwner)
      this.prepare("DELETE FROM kernel_owner WHERE owner=?").run(
        this.leaseOwner,
      );
    try {
      this.db.exec("PRAGMA optimize");
    } catch {
      // Statistics are an optimization; closing must not fail because of them.
    }
    this.db.close();
    this.statements.clear();
    this.jsonStatements.clear();
    this.entityStatements.clear();
    this.writers = Object.create(null);
    this.closed = true;
  }
}

/** JSON.stringify of `value` with `key` moved last and set to the JSON text `raw`. */
function spliceJson(value: object, key: string, raw: string): string {
  const { [key]: _omitted, ...rest } = value as Record<string, unknown>;
  const head = JSON.stringify(rest);
  return `${head.slice(0, -1)}${head.length > 2 ? "," : ""}${JSON.stringify(key)}:${raw}}`;
}
