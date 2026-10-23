import { invariant } from "../core/util.js";
import type { ApiContext } from "./shared.js";
import { snapshotJsonExport } from "./json-export.js";

/** The original session format streams persisted rows without an entire transcript copy. */
export function sessionExport(context: ApiContext, sessionId: string) {
  const { k } = context;
  return snapshotJsonExport(context, {
    kind: "session",
    concurrency: k.config.limits.maxConcurrentSessionExports,
    maxBytes: k.config.limits.maxSessionExportBytes,
    timeoutMs: k.config.limits.sessionExportTimeoutMs,
    table: "messages",
    cursor: "seq",
    where: "session_id=?",
    values: [sessionId],
    head: (db) => {
      const row = db
        .prepare("SELECT body FROM e_sessions WHERE id=?")
        .get(sessionId) as { body: string } | undefined;
      invariant(row, "Session not found", 404, "not_found");
      return `{"format":"foundation-session-v1","session":${row.body},"messages":[`;
    },
  });
}
