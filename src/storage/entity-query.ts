import { invariant } from "../core/util.js";
import type { DatabaseSync } from "node:sqlite";

// Identifiers are fixed by the repository; caller values are always SQL parameters.
const fields = [
  "projectId",
  "sessionId",
  "runId",
  "rootSessionId",
  "rootRunId",
  "serverId",
  "parentSessionId",
  "workspaceRoot",
  "status",
  "purpose",
  "key",
  "routeId",
  "mode",
  "teamId",
  "teamRootSessionId",
  "teamMemberId",
  "collaboration.teamId",
] as const;
export type EntityField = (typeof fields)[number];
export type EntityFilter = Partial<
  Record<EntityField, string | readonly string[]>
>;
export interface EntityPage {
  limit?: number;
  offset?: number;
  descending?: boolean;
}

export const tables = [
  "projects",
  "sessions",
  "runs",
  "assets",
  "jobs",
  "approvals",
  "security-audits",
  "memories",
  "skills",
  "plugins",
  "mcps",
  "policies",
  "agents",
  "teams",
  "team-tasks",
  "servers",
  "server-facts",
  "inbox",
  "effects",
  "nodes",
  "node-tasks",
  "summaries",
  "browser-sessions",
  "work-plans",
  "memory-revisions",
  "memory-proposals",
  "work-contexts",
  "media-route-versions",
  "mode-profiles",
  "processes",
  "cost-ledger",
  "cost-adjustments",
  "session-migrations",
  "mcp-interactions",
  "mcp-tasks",
  "mcp-client-tasks",
  "checkpoints",
] as const;
export type Table = (typeof tables)[number];

const names = new Map<Table, string>(
  tables.map((kind) => [kind, `e_${kind.replaceAll("-", "_")}`]),
);
/** Physical table of one entity kind; each kind owns its rows, rowid order and indexes. */
export const entityTable = (kind: Table): string => {
  const name = names.get(kind);
  invariant(name, "Unknown entity kind");
  return name;
};

// Only filters the repository issues are indexed, so writes to other kinds stay cheap.
// An unindexed filter still answers correctly by scanning that kind's own table.
const indexed: Partial<Record<Table, readonly EntityField[]>> = {
  sessions: ["projectId", "collaboration.teamId", "teamRootSessionId"],
  runs: ["sessionId", "status"],
  assets: ["projectId"],
  jobs: ["projectId", "status"],
  approvals: ["runId", "status"],
  "security-audits": ["sessionId"],
  "team-tasks": [
    "rootSessionId",
    "rootRunId",
    "workspaceRoot",
    "sessionId",
    "teamId",
  ],
  inbox: ["runId"],
  effects: ["runId", "projectId"],
  processes: ["sessionId"],
  "cost-ledger": ["sessionId", "runId"],
  "session-migrations": ["projectId"],
  "mcp-interactions": ["serverId"],
  checkpoints: ["sessionId"],
};
// Use the same expression in budget reads and the covering index. SQLite can
// sum persisted index values without parsing each matching ledger JSON body.
export const committedCostExpression = `CASE json_extract(body,'$.status')
  WHEN 'void' THEN 0 WHEN 'settled' THEN COALESCE(json_extract(body,'$.chargedMicros'),0)
  ELSE json_extract(body,'$.reservedMicros') END`;
const pendingEffect = "json_extract(body,'$.status') IN ('running','prepared')";
// Query shapes used by memory, cost and event lookups beyond plain field filters.
const special: Partial<Record<Table, readonly string[]>> = {
  effects: [
    `CREATE INDEX IF NOT EXISTS e_effects_status ON e_effects(json_extract(body,'$.status')) WHERE ${pendingEffect}`,
  ],
  runs: [
    "CREATE INDEX IF NOT EXISTS runs_session ON e_runs(id,json_extract(body,'$.sessionId'))",
  ],
  memories: [
    "CREATE INDEX IF NOT EXISTS memories_project_namespace ON e_memories(json_extract(body,'$.projectId'),json_extract(body,'$.namespace'))",
  ],
  "memory-revisions": [
    "CREATE INDEX IF NOT EXISTS memory_revisions_latest ON e_memory_revisions(json_extract(body,'$.memoryId'),json_extract(body,'$.revision') DESC)",
  ],
  "memory-proposals": [
    "CREATE INDEX IF NOT EXISTS memory_proposals_project ON e_memory_proposals(json_extract(body,'$.projectId'))",
  ],
  "cost-ledger": [
    "CREATE INDEX IF NOT EXISTS cost_ledger_day ON e_cost_ledger(substr(json_extract(body,'$.createdAt'),1,10))",
    `CREATE INDEX IF NOT EXISTS cost_ledger_project_budget ON e_cost_ledger(json_extract(body,'$.projectId'),seq,substr(json_extract(body,'$.createdAt'),1,10),${committedCostExpression})`,
  ],
};

/** DDL for every entity table and its indexes; idempotent on existing databases. */
const schemaStatements = tables.flatMap((kind) => {
  const table = entityTable(kind);
  return [
    kind === "cost-ledger"
      ? `CREATE TABLE IF NOT EXISTS ${table}(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,body TEXT NOT NULL)`
      : `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
    ...(indexed[kind] || []).map(
      (field) =>
        `CREATE INDEX IF NOT EXISTS ${table}_${field.replaceAll(".", "_")} ON ${table}(json_extract(body,'$.${field}'))`,
    ),
    ...(special[kind] || []),
  ];
});
export const entitySchema = schemaStatements.join(";\n");
const schemaObjects = schemaStatements.map((sql) => ({
  name: /^CREATE (?:TABLE|INDEX) IF NOT EXISTS ([^( ]+)/.exec(sql)![1],
  sql,
}));

/** Repair missing objects without parsing every CREATE statement on each open. */
export function ensureEntitySchema(db: DatabaseSync): ReadonlySet<string> {
  // The caller holds a write transaction, including during the one-time upgrade.
  const cost = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='e_cost_ledger'",
    )
    .get() as { sql: string } | undefined;
  if (cost && !/\bseq\s+INTEGER\s+PRIMARY\s+KEY/i.test(cost.sql)) {
    const extra = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE tbl_name='e_cost_ledger' AND type IN ('index','trigger') AND sql IS NOT NULL",
      )
      .all() as { name: string; sql: string }[];
    db.exec(`CREATE TABLE e_cost_ledger_layout(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,body TEXT NOT NULL);
      INSERT INTO e_cost_ledger_layout(seq,id,body) SELECT rowid,id,body FROM e_cost_ledger ORDER BY rowid;
      DROP TABLE e_cost_ledger;
      ALTER TABLE e_cost_ledger_layout RENAME TO e_cost_ledger;`);
    for (const object of extra)
      if (
        !["e_cost_ledger_projectId", "cost_ledger_project_budget"].includes(
          object.name,
        )
      )
        db.exec(object.sql);
  }
  const existing = new Set(
    (
      db.prepare("SELECT name FROM sqlite_schema").all() as { name: string }[]
    ).map((row) => row.name),
  );
  if (existing.has("e_effects_status")) {
    const status = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='e_effects_status'")
      .get() as { sql: string };
    if (!/\bWHERE\b/i.test(status.sql)) {
      db.exec("DROP INDEX e_effects_status");
      existing.delete("e_effects_status");
    }
  }
  // One covering index also supplies project-list order through the rowid alias.
  if (existing.has("e_cost_ledger_projectId")) {
    db.exec("DROP INDEX e_cost_ledger_projectId");
    existing.delete("e_cost_ledger_projectId");
  }
  const missing = schemaObjects.filter((object) => !existing.has(object.name));
  if (missing.length) db.exec(missing.map((object) => object.sql).join(";\n"));
  return existing;
}

export function entityWhere(filter: EntityFilter) {
  const values: string[] = [],
    clauses: string[] = [];
  for (const field of Object.keys(filter).sort()) {
    invariant(
      fields.some((known) => known === field),
      "Unknown entity filter",
    );
    const value = filter[field as keyof EntityFilter];
    if (value === undefined) continue;
    const alternatives = typeof value === "string" ? [value] : value;
    invariant(
      Array.isArray(alternatives) &&
        alternatives.length <= 100 &&
        alternatives.every((item) => typeof item === "string"),
      "Invalid entity filter values",
    );
    clauses.push(
      alternatives.length
        ? `json_extract(body,'$.${field}') IN (${alternatives.map(() => "?").join(",")})`
        : "0",
    );
    values.push(...alternatives);
  }
  return {
    sql: clauses.length ? " WHERE " + clauses.join(" AND ") : "",
    values,
  };
}

/** Keep recovery's partial-index predicate off the common entity-query path. */
export function effectWhere(filter: EntityFilter) {
  const snapshot = { ...filter };
  const where = entityWhere(snapshot);
  const status = snapshot.status;
  const alternatives = typeof status === "string" ? [status] : status;
  if (
    !alternatives?.length ||
    !alternatives.every((item) => item === "running" || item === "prepared")
  )
    return where;
  if (alternatives.includes("running") && alternatives.includes("prepared")) {
    const { status: _status, ...rest } = snapshot;
    const other = entityWhere(rest);
    return {
      sql: `${other.sql || " WHERE 1"} AND ${pendingEffect}`,
      values: other.values,
    };
  }
  return { sql: `${where.sql} AND ${pendingEffect}`, values: where.values };
}

export function entityPage(page: EntityPage) {
  const { limit = -1, offset = 0, descending = false } = page;
  invariant(
    (page.limit === undefined || (Number.isSafeInteger(limit) && limit > 0)) &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      typeof descending === "boolean",
    "Invalid entity page",
  );
  return {
    sql: ` ORDER BY rowid ${descending ? "DESC" : "ASC"} LIMIT ? OFFSET ?`,
    values: [limit, offset],
  };
}
