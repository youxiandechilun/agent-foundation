import { invariant } from "../core/util.js";
import type { ApiContext } from "./shared.js";
import { snapshotJsonExport } from "./json-export.js";

/** A bounded read-only WAL snapshot keeps v1 exports consistent while writes continue. */
export function memoryExport(context: ApiContext) {
  const { k, url } = context;
  const project = url.searchParams.get("projectId");
  invariant(project, "projectId required");
  k.store.project(project);
  const namespace = url.searchParams.get("namespace") || null;
  return snapshotJsonExport(context, {
    kind: "memory",
    concurrency: k.config.limits.maxConcurrentMemoryExports,
    maxBytes: k.config.limits.maxMemoryExportBytes,
    timeoutMs: k.config.limits.memoryExportTimeoutMs,
    table: "e_memories",
    cursor: "rowid",
    where:
      "json_extract(body,'$.projectId')=? AND (? IS NULL OR json_extract(body,'$.namespace')=?) AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?)",
    values: [project, namespace, namespace, new Date().toISOString()],
    head: () => '{"format":"foundation-memory-v1","memories":[',
  });
}
