import { invariant } from "../core/util.js";

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
  sessions: ["projectId"],
  runs: ["sessionId", "status"],
  assets: ["projectId"],
  jobs: ["projectId", "status"],
  approvals: ["runId", "status"],
  "security-audits": ["sessionId"],
  "team-tasks": ["rootSessionId", "rootRunId", "workspaceRoot", "sessionId"],
  inbox: ["runId"],
  effects: ["runId", "status"],
  processes: ["sessionId"],
  "cost-ledger": ["projectId", "sessionId", "runId"],
  "session-migrations": ["projectId"],
  "mcp-interactions": ["serverId"],
  checkpoints: ["sessionId"],
};
// Query shapes used by memory, cost and event lookups beyond plain field filters.
const special: Partial<Record<Table, readonly string[]>> = {
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
  ],
};

/** DDL for every entity table and its indexes; idempotent on existing databases. */
export const entitySchema = tables
  .flatMap((kind) => {
    const table = entityTable(kind);
    return [
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,body TEXT NOT NULL)`,
      ...(indexed[kind] || []).map(
        (field) =>
          `CREATE INDEX IF NOT EXISTS ${table}_${field} ON ${table}(json_extract(body,'$.${field}'))`,
      ),
      ...(special[kind] || []),
    ];
  })
  .join(";\n");

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
