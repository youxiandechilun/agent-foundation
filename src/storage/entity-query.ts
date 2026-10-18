import { invariant } from "../core/util.js";

// Identifiers are fixed by the repository; caller values are always SQL parameters.
const fields = [
  "projectId",
  "sessionId",
  "runId",
  "rootSessionId",
  "rootRunId",
  "teamId",
  "serverId",
  "parentSessionId",
  "workspaceRoot",
  "status",
  "purpose",
  "key",
] as const;
export type EntityFilter = Partial<
  Record<(typeof fields)[number], string | readonly string[]>
>;
export interface EntityPage {
  limit?: number;
  offset?: number;
  descending?: boolean;
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
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", values };
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

// Partial indexes omit entities without the field and leave existing JSON records intact.
export const entityIndexes = fields
  .filter((field) => field !== "purpose" && field !== "key")
  .map(
    (field) =>
      `CREATE INDEX IF NOT EXISTS entities_${field} ON entities(kind,json_extract(body,'$.${field}')) WHERE json_extract(body,'$.${field}') IS NOT NULL;`,
  )
  .join("\n");
