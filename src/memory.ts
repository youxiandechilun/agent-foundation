import { z } from "zod";
import type { MemoryEntry, MemoryProposal } from "./contracts.js";
import { Store } from "./store.js";
import type { Config } from "./config.js";
import { id, now, invariant, hash, redactSecrets } from "./util.js";
import { routeHeaders } from "./providers/text.js";
import { readJson } from "./providers/sse.js";
import type { CostLedger } from "./runtime/cost.js";

const inputSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  namespace: z.string().min(1).max(100).default("default"),
  content: z.string().min(1).max(32000),
  tags: z.array(z.string().max(100)).max(40).default([]),
  source: z.string().max(200).default("user"),
  expiresAt: z.string().datetime().optional(),
  expectedRevision: z.number().int().positive().optional(),
});
type MemoryInput = z.input<typeof inputSchema>;
function terms(text: string): string[] {
  const lower = text.toLowerCase(),
    words = lower.match(/[\p{L}\p{N}_-]+/gu) || [],
    cjk = lower.match(/[\p{Script=Han}]+/gu) || [];
  return [
    ...new Set([
      ...words,
      ...cjk.flatMap((s) =>
        [...s].slice(0, -1).map((_, i) => s.slice(i, i + 2)),
      ),
    ]),
  ].slice(0, 3000);
}
const requestedLimit = (limit = 8) => {
  invariant(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    "Memory limit must be 1..100",
  );
  return limit;
};
export class MemoryStore {
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly costs?: CostLedger,
  ) {}
  get(memoryId: string, projectId: string): MemoryEntry {
    const memory = this.store.get<MemoryEntry>("memories", memoryId);
    invariant(
      memory.projectId === projectId,
      "Memory belongs to another project",
      403,
    );
    invariant(
      !memory.expiresAt || memory.expiresAt > now(),
      "Memory expired",
      404,
    );
    return memory;
  }
  put(input: MemoryInput): MemoryEntry {
    const parsed = inputSchema.parse(input);
    parsed.content = redactSecrets(parsed.content);
    this.store.project(parsed.projectId);
    const existing = parsed.id
      ? this.store.find<MemoryEntry>("memories", parsed.id)
      : this.list(parsed.projectId, parsed.namespace).find(
          (m) => m.content === parsed.content,
        );
    const previousRevision =
      !existing && parsed.id
        ? this.store
            .list<any>("memory-revisions")
            .filter((r) => r.memoryId === parsed.id)
            .sort((a, b) => b.revision - a.revision)[0]
        : undefined;
    invariant(
      !previousRevision || previousRevision.projectId === parsed.projectId,
      "Memory ID belongs to another project's history",
      403,
    );
    invariant(
      !existing || existing.projectId === parsed.projectId,
      "Memory belongs to another project",
      403,
    );
    invariant(
      parsed.expectedRevision === undefined ||
        existing?.revision === parsed.expectedRevision,
      "Memory revision conflict",
      409,
      "revision_conflict",
    );
    const { expectedRevision, ...fields } = parsed;
    if (
      existing &&
      ["content", "namespace", "source", "expiresAt", "tags"].every(
        (key) =>
          JSON.stringify((existing as any)[key]) ===
          JSON.stringify((fields as any)[key]),
      )
    )
      return existing;
    const entry: MemoryEntry = {
      ...fields,
      id: existing?.id || parsed.id || id("memory"),
      revision: (existing?.revision || previousRevision?.revision || 0) + 1,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    this.store.transaction(() => {
      this.store.put("memories", entry);
      this.store.db.prepare("DELETE FROM memory_fts WHERE id=?").run(entry.id);
      this.store.db
        .prepare("DELETE FROM memory_vectors WHERE id=?")
        .run(entry.id);
      this.store.db
        .prepare(
          "INSERT INTO memory_fts(id,project_id,namespace,terms) VALUES(?,?,?,?)",
        )
        .run(
          entry.id,
          entry.projectId,
          entry.namespace,
          terms(entry.content + " " + entry.tags.join(" ")).join(" "),
        );
      this.record(entry, existing ? "updated" : "created");
    });
    return entry;
  }
  private record(entry: MemoryEntry, action: string) {
    this.store.put("memory-revisions", {
      id: `${entry.id}:${entry.revision || 1}`,
      memoryId: entry.id,
      projectId: entry.projectId,
      revision: entry.revision || 1,
      action,
      entry,
      recordedAt: now(),
    });
  }
  list(projectId: string, namespace?: string): MemoryEntry[] {
    this.store.project(projectId);
    return (
      this.store.db
        .prepare(
          "SELECT body FROM entities WHERE kind='memories' AND json_extract(body,'$.projectId')=? AND (? IS NULL OR json_extract(body,'$.namespace')=?) AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?) ORDER BY rowid",
        )
        .all(projectId, namespace ?? null, namespace ?? null, now()) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  }
  history(memoryId: string, projectId: string) {
    this.store.project(projectId);
    return (
      this.store.db
        .prepare(
          "SELECT body FROM entities WHERE kind='memory-revisions' AND json_extract(body,'$.memoryId')=? AND json_extract(body,'$.projectId')=? ORDER BY json_extract(body,'$.revision') DESC LIMIT 1000",
        )
        .all(memoryId, projectId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  remove(memoryId: string, projectId: string, reason = "deleted") {
    const entry = this.store.get<MemoryEntry>("memories", memoryId);
    invariant(entry.projectId === projectId, "Memory project mismatch", 403);
    this.store.transaction(() => {
      this.record(
        { ...entry, revision: (entry.revision || 1) + 1, updatedAt: now() },
        reason,
      );
      this.store.remove("memories", memoryId);
      this.store.db.prepare("DELETE FROM memory_fts WHERE id=?").run(memoryId);
      this.store.db
        .prepare("DELETE FROM memory_vectors WHERE id=?")
        .run(memoryId);
    });
  }
  search(
    projectId: string,
    query: string,
    limit = 8,
    namespace?: string,
  ): (MemoryEntry & { score: number })[] {
    this.store.project(projectId);
    requestedLimit(limit);
    const tokens = terms(query)
      .filter((t) => !/[\p{Script=Han}]/u.test(t) || t.length <= 2)
      .slice(0, 40);
    if (!tokens.length) return [];
    const match = tokens
      .map((t) => `"${t.replaceAll('"', '""')}"`)
      .join(query.trim().length <= 20 ? " AND " : " OR ");
    const rows = this.store.db
      .prepare(
        "SELECT e.body,bm25(memory_fts) AS score FROM memory_fts JOIN entities e ON e.kind='memories' AND e.id=memory_fts.id WHERE memory_fts MATCH ? AND project_id=? AND (? IS NULL OR namespace=?) AND (json_extract(e.body,'$.expiresAt') IS NULL OR json_extract(e.body,'$.expiresAt')>?) ORDER BY score LIMIT ?",
      )
      .all(
        match,
        projectId,
        namespace ?? null,
        namespace ?? null,
        now(),
        limit,
      ) as { body: string; score: number }[];
    return rows.map((r) => ({ ...JSON.parse(r.body), score: -r.score }));
  }
  pruneExpired(projectId: string) {
    this.store.project(projectId);
    const rows = this.store.db
      .prepare(
        "SELECT id FROM entities WHERE kind='memories' AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.expiresAt')<=?",
      )
      .all(projectId, now()) as { id: string }[];
    this.store.transaction(() => {
      for (const row of rows) this.remove(row.id, projectId, "expired");
    });
    return { removed: rows.length };
  }
  merge(projectId: string, ids: string[], content: string) {
    invariant(
      ids.length >= 2 && ids.length <= 100 && new Set(ids).size === ids.length,
      "Merge requires 2..100 unique memory IDs",
    );
    const entries = ids.map((id) =>
      this.store.get<MemoryEntry>("memories", id),
    );
    invariant(
      entries.every(
        (m) =>
          m.projectId === projectId && m.namespace === entries[0].namespace,
      ),
      "Merge crosses project or namespace",
      403,
    );
    return this.store.transaction(() => {
      const entry = this.put({
        projectId,
        namespace: entries[0].namespace,
        content,
        tags: [...new Set(entries.flatMap((m) => m.tags))].slice(0, 40),
        source: "merge:" + ids.join(",").slice(0, 190),
      });
      for (const old of entries)
        if (old.id !== entry.id) this.remove(old.id, projectId, "merged");
      return entry;
    });
  }
  import(projectId: string, entries: unknown[]) {
    this.store.project(projectId);
    invariant(entries.length <= 10000, "Memory import exceeds limit");
    return this.store.transaction(() =>
      entries.map((value) => {
        const v = inputSchema.parse({
          ...(value as any),
          projectId,
          id: undefined,
          expectedRevision: undefined,
        });
        return this.put(v);
      }),
    );
  }
  propose(input: MemoryInput): MemoryProposal {
    const parsed = inputSchema.parse(input);
    this.store.project(parsed.projectId);
    const existing = this.proposals(parsed.projectId).find(
      (p) =>
        p.namespace === parsed.namespace &&
        p.content === parsed.content &&
        p.status === "pending",
    );
    if (existing) return existing;
    const proposal: MemoryProposal = {
      id: id("proposal"),
      projectId: parsed.projectId,
      namespace: parsed.namespace,
      content: redactSecrets(parsed.content),
      tags: parsed.tags,
      source: parsed.source,
      status: "pending",
      createdAt: now(),
    };
    return this.store.put("memory-proposals", proposal);
  }
  proposals(projectId: string) {
    this.store.project(projectId);
    return this.store
      .list<MemoryProposal>("memory-proposals")
      .filter((p) => p.projectId === projectId);
  }
  resolve(proposalId: string, allow: boolean) {
    const p = this.store.get<MemoryProposal>("memory-proposals", proposalId);
    invariant(p.status === "pending", "Memory proposal already resolved", 409);
    return this.store.transaction(() => {
      const memory = allow
        ? this.put({
            projectId: p.projectId,
            namespace: p.namespace,
            content: p.content,
            tags: p.tags,
            source: p.source,
          })
        : undefined;
      return this.store.put("memory-proposals", {
        ...p,
        status: allow ? ("approved" as const) : ("denied" as const),
        memoryId: memory?.id,
      });
    });
  }
  private embeddingKey() {
    const routeId = this.config.defaultRoutes.embedding;
    invariant(routeId, "Embedding route is not configured", 503);
    const route = this.config.routes[routeId];
    invariant(
      route?.enabled && route.adapter === "openai-embeddings",
      "Embedding route unavailable",
      503,
    );
    return (
      routeId +
      ":" +
      hash(
        JSON.stringify([
          route.adapter,
          route.model,
          route.baseUrl,
          route.requestDefaults,
        ]),
      )
    );
  }
  async embed(memoryId: string, signal?: AbortSignal) {
    const m = this.store.get<MemoryEntry>("memories", memoryId),
      key = this.embeddingKey(),
      vector = await this.vector(m.content, signal, m.projectId);
    invariant(
      this.embeddingKey() === key &&
        this.store.get<MemoryEntry>("memories", memoryId).updatedAt ===
          m.updatedAt,
      "Memory or embedding route changed during embedding",
      409,
    );
    this.store.db
      .prepare(
        "INSERT INTO memory_vectors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,vector=excluded.vector",
      )
      .run(m.id, key, JSON.stringify(vector));
    return { id: m.id, dimensions: vector.length, embeddingVersion: key };
  }
  private async vector(
    input: string,
    signal?: AbortSignal,
    projectId?: string,
  ): Promise<number[]> {
    this.embeddingKey();
    const route = this.config.routes[this.config.defaultRoutes.embedding!];
    invariant(input.length <= 64000, "Embedding input exceeds limit");
    const charge = this.costs?.reserve(
      this.config.defaultRoutes.embedding!,
      route,
      { projectId, purpose: "embedding" },
      Math.ceil(
        route.contextWindow * (route.pricing?.inputPerMillion || 0) +
          (route.pricing?.requestUsd || 0) * 1e6,
      ),
    );
    try {
      const response = await fetch(
        route.baseUrl.replace(/\/$/, "") + "/embeddings",
        {
          method: "POST",
          headers: routeHeaders(route),
          body: JSON.stringify({
            ...route.requestDefaults,
            model: route.model,
            input: redactSecrets(input),
          }),
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(route.timeoutMs),
          ]),
          redirect: "error",
        },
      );
      invariant(response.ok, `Embedding provider HTTP ${response.status}`, 502);
      const data = await readJson(response),
        vector = data.data?.[0]?.embedding;
      invariant(
        Array.isArray(vector) &&
          vector.length > 0 &&
          vector.length <= 32000 &&
          vector.every(Number.isFinite),
        "Invalid embedding vector",
        502,
      );
      if (charge)
        this.costs!.settleUsage(charge.id, route, {
          reported: Boolean(data.usage),
          input: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: data.usage?.total_tokens || 0,
        });
      return vector;
    } catch (error) {
      if (charge) this.costs!.unknown(charge.id);
      throw error;
    }
  }
  async semanticSearch(
    projectId: string,
    query: string,
    limit = 8,
    namespace?: string,
    signal?: AbortSignal,
  ) {
    this.store.project(projectId);
    requestedLimit(limit);
    const key = this.embeddingKey(),
      q = await this.vector(query, signal, projectId);
    invariant(
      this.embeddingKey() === key,
      "Embedding route changed during search",
      409,
    );
    const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
      qNorm = norm(q),
      best: (MemoryEntry & { score: number })[] = [];
    const statement = this.store.db.prepare(
      "SELECT e.body,v.vector FROM memory_vectors v JOIN entities e ON e.kind='memories' AND e.id=v.id WHERE v.model=? AND json_extract(e.body,'$.projectId')=? AND (? IS NULL OR json_extract(e.body,'$.namespace')=?) AND (json_extract(e.body,'$.expiresAt') IS NULL OR json_extract(e.body,'$.expiresAt')>?)",
    );
    let scanned = 0;
    for (const row of statement.iterate(
      key,
      projectId,
      namespace ?? null,
      namespace ?? null,
      now(),
    ) as Iterable<{ body: string; vector: string }>) {
      signal?.throwIfAborted();
      const v: number[] = JSON.parse(row.vector);
      if (v.length !== q.length) continue;
      const score =
        v.reduce((s, x, i) => s + x * q[i], 0) /
        Math.max(norm(v) * qNorm, 1e-10);
      best.push({ ...JSON.parse(row.body), score });
      best.sort((a, b) => b.score - a.score);
      if (best.length > limit) best.pop();
      if (++scanned % 256 === 0)
        await new Promise<void>((r) => setImmediate(r));
    }
    return best;
  }
  async retrieve(
    projectId: string,
    query: string,
    limit = 8,
    namespace?: string,
    signal?: AbortSignal,
    onSemanticError?: (error: unknown) => void,
  ) {
    if (!query.trim() || limit === 0) return [];
    query = query.slice(0, 64000);
    const lexical = this.search(
      projectId,
      query,
      Math.min(100, limit * 3),
      namespace,
    );
    if (!this.config.defaultRoutes.embedding) return lexical.slice(0, limit);
    let semantic: (MemoryEntry & { score: number })[];
    try {
      semantic = await this.semanticSearch(
        projectId,
        query,
        Math.min(100, limit * 3),
        namespace,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      onSemanticError?.(error);
      return lexical.slice(0, limit);
    }
    const items = new Map<string, MemoryEntry & { score: number }>();
    for (const list of [lexical, semantic])
      for (const [rank, m] of list.entries()) {
        const previous = items.get(m.id);
        items.set(m.id, {
          ...m,
          score: (previous?.score || 0) + 1 / (60 + rank + 1),
        });
      }
    return [...items.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
