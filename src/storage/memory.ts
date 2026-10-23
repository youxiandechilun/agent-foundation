import { z } from "zod";
import type { MemoryEntry, MemoryProposal } from "../contracts.js";
import { Store } from "./store.js";
import type { Config } from "../core/config.js";
import { id, now, invariant, hash, redactSecrets } from "../core/util.js";
import { wireMember, wireObject } from "../core/wire.js";
import { routeHeaders } from "../providers/text.js";
import { readJson } from "../providers/sse.js";
import type { CostLedger } from "../runtime/cost.js";
import { Capacity } from "../runtime/capacity.js";

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
type ParsedMemoryInput = z.output<typeof inputSchema>;
export interface MemoryStoreOptions {
  /** Bounds preparation work; the existing synchronous import keeps its contract. */
  maxConcurrentImports?: number;
  maxImportBytes?: number;
}
interface MemoryRevision {
  id: string;
  memoryId: string;
  projectId: string;
  revision: number;
  action: string;
  entry: MemoryEntry;
  recordedAt: string;
}
const unchangedFields = [
  "content",
  "namespace",
  "source",
  "expiresAt",
  "tags",
] as const;
const importSchema = inputSchema.omit({
  id: true,
  projectId: true,
  expectedRevision: true,
});
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
  private readonly imports: Capacity;
  private readonly maxImportBytes: number;
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly costs?: CostLedger,
    options: MemoryStoreOptions = {},
  ) {
    const concurrency = options.maxConcurrentImports ?? 1;
    this.maxImportBytes = options.maxImportBytes ?? 16 * 1024 * 1024;
    invariant(
      Number.isSafeInteger(concurrency) &&
        concurrency > 0 &&
        Number.isSafeInteger(this.maxImportBytes) &&
        this.maxImportBytes > 0,
      "Invalid memory import capacity",
    );
    this.imports = new Capacity(concurrency);
  }
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
    return this.putParsed(parsed);
  }
  private putParsed(
    parsed: ParsedMemoryInput,
    indexedTerms?: string,
  ): MemoryEntry {
    const originalContent = parsed.content;
    parsed.content = redactSecrets(parsed.content);
    this.store.project(parsed.projectId);
    const existing = parsed.id
      ? this.store.find<MemoryEntry>("memories", parsed.id)
      : this.store.selectJsonOne<MemoryEntry>(
          // Keep this hot lookup on the digest index even when old planner
          // statistics still describe a tiny project before a large import.
          "SELECT body FROM e_memories INDEXED BY memories_content_lookup WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.namespace')=? AND foundation_content_hash(json_extract(body,'$.content'))=? AND json_extract(body,'$.content')=? AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?) ORDER BY rowid LIMIT 1",
          [
            parsed.projectId,
            parsed.namespace,
            hash(parsed.content),
            parsed.content,
            now(),
          ],
        );
    const previousRevision =
      !existing && parsed.id
        ? (this.store
            .prepare(
              "SELECT json_extract(body,'$.projectId') AS projectId,json_extract(body,'$.revision') AS revision FROM e_memory_revisions WHERE json_extract(body,'$.memoryId')=? ORDER BY json_extract(body,'$.revision') DESC LIMIT 1",
            )
            .get(parsed.id) as
            Pick<MemoryRevision, "projectId" | "revision"> | undefined)
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
      unchangedFields.every(
        (key) => JSON.stringify(existing[key]) === JSON.stringify(fields[key]),
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
      const position = this.store
        .prepare(
          "SELECT fts_rowid FROM memory_fts_map WHERE memory_id=? ORDER BY fts_rowid LIMIT 1",
        )
        .get(entry.id) as { fts_rowid: number } | undefined;
      this.unindex(entry.id);
      const indexed = this.store
        .prepare(
          "INSERT INTO memory_fts(rowid,id,project_id,namespace,terms) VALUES(?,?,?,?,?)",
        )
        .run(
          position?.fts_rowid ?? null,
          entry.id,
          entry.projectId,
          entry.namespace,
          indexedTerms !== undefined && originalContent === parsed.content
            ? indexedTerms
            : terms(entry.content + " " + entry.tags.join(" ")).join(" "),
        );
      this.store
        .prepare("INSERT INTO memory_fts_map(fts_rowid,memory_id) VALUES(?,?)")
        .run(indexed.lastInsertRowid, entry.id);
      this.record(entry, existing ? "updated" : "created");
    });
    return entry;
  }
  private unindex(memoryId: string) {
    this.store
      .prepare(
        "DELETE FROM memory_fts WHERE rowid IN (SELECT fts_rowid FROM memory_fts_map WHERE memory_id=?)",
      )
      .run(memoryId);
    this.store
      .prepare("DELETE FROM memory_fts_map WHERE memory_id=?")
      .run(memoryId);
    this.store.prepare("DELETE FROM memory_vectors WHERE id=?").run(memoryId);
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
    return this.store.selectJson<MemoryEntry>(
      "SELECT body FROM e_memories WHERE json_extract(body,'$.projectId')=? AND (? IS NULL OR json_extract(body,'$.namespace')=?) AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?) ORDER BY rowid",
      [projectId, namespace ?? null, namespace ?? null, now()],
    );
  }
  history(memoryId: string, projectId: string): MemoryRevision[] {
    this.store.project(projectId);
    return this.store.selectJson<MemoryRevision>(
      "SELECT body FROM e_memory_revisions WHERE json_extract(body,'$.memoryId')=? AND json_extract(body,'$.projectId')=? ORDER BY json_extract(body,'$.revision') DESC LIMIT 1000",
      [memoryId, projectId],
    );
  }
  page(projectId: string, namespace?: string, after = 0, limit = 100) {
    this.store.project(projectId);
    return this.store.selectJsonPage<MemoryEntry>(
      "SELECT rowid AS cursor,body FROM e_memories WHERE json_extract(body,'$.projectId')=? AND (? IS NULL OR json_extract(body,'$.namespace')=?) AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?)",
      [projectId, namespace ?? null, namespace ?? null, now()],
      after,
      limit,
    );
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
      this.unindex(memoryId);
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
    const rows = this.store
      .prepare(
        "SELECT e.body,bm25(memory_fts) AS score FROM memory_fts JOIN e_memories e ON e.id=memory_fts.id WHERE memory_fts MATCH ? AND project_id=? AND (? IS NULL OR namespace=?) AND (json_extract(e.body,'$.expiresAt') IS NULL OR json_extract(e.body,'$.expiresAt')>?) ORDER BY score LIMIT ?",
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
    const rows = this.store
      .prepare(
        "SELECT id FROM e_memories WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.expiresAt')<=?",
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
      entries.map((value) =>
        this.put({ ...importSchema.parse(value), projectId }),
      ),
    );
  }
  /** Prepare in bounded batches, then commit atomically without yielding a transaction. */
  async importAsync(
    projectId: string,
    entries: unknown[],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.store.project(projectId);
    invariant(entries.length <= 10000, "Memory import exceeds limit");
    const release = this.imports.reserve();
    try {
      const prepared: { parsed: ParsedMemoryInput; indexedTerms: string }[] =
        [];
      let bytes = 0;
      let batchStarted = performance.now();
      for (let i = 0; i < entries.length; i++) {
        signal?.throwIfAborted();
        const parsed = { ...importSchema.parse(entries[i]), projectId };
        parsed.content = redactSecrets(parsed.content);
        const indexedTerms = terms(
          parsed.content + " " + parsed.tags.join(" "),
        ).join(" ");
        bytes +=
          Buffer.byteLength(JSON.stringify(parsed)) +
          Buffer.byteLength(indexedTerms);
        invariant(
          bytes <= this.maxImportBytes,
          "Memory import byte budget exceeded",
          413,
          "memory_import_capacity",
        );
        prepared.push({ parsed, indexedTerms });
        if ((i + 1) % 64 === 0 || performance.now() - batchStarted >= 8) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          signal?.throwIfAborted();
          batchStarted = performance.now();
        }
      }
      signal?.throwIfAborted();
      return this.store.transaction(() =>
        prepared.map(({ parsed, indexedTerms }) => {
          signal?.throwIfAborted();
          return this.putParsed(parsed, indexedTerms);
        }),
      );
    } finally {
      release();
    }
  }
  propose(input: MemoryInput): MemoryProposal {
    const parsed = inputSchema.parse(input);
    parsed.content = redactSecrets(parsed.content);
    this.store.project(parsed.projectId);
    const existing = this.store.selectJsonOne<MemoryProposal>(
      "SELECT body FROM e_memory_proposals WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.namespace')=? AND json_extract(body,'$.content')=? AND json_extract(body,'$.status')='pending' ORDER BY rowid LIMIT 1",
      [parsed.projectId, parsed.namespace, parsed.content],
    );
    if (existing) return existing;
    const proposal: MemoryProposal = {
      id: id("proposal"),
      projectId: parsed.projectId,
      namespace: parsed.namespace,
      content: parsed.content,
      tags: parsed.tags,
      source: parsed.source,
      status: "pending",
      createdAt: now(),
    };
    return this.store.put("memory-proposals", proposal);
  }
  proposals(projectId: string): MemoryProposal[] {
    this.store.project(projectId);
    return this.store.list<MemoryProposal>("memory-proposals", { projectId });
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
    signal?.throwIfAborted();
    const m = this.store.get<MemoryEntry>("memories", memoryId),
      key = this.embeddingKey(),
      vector = await this.vector(m.content, signal, m.projectId);
    signal?.throwIfAborted();
    invariant(
      this.embeddingKey() === key &&
        this.store.get<MemoryEntry>("memories", memoryId).updatedAt ===
          m.updatedAt,
      "Memory or embedding route changed during embedding",
      409,
    );
    this.store.transaction(() => {
      const encoded = encodeVector(vector);
      this.store
        .prepare(
          "INSERT INTO memory_vectors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,vector=excluded.vector",
        )
        .run(m.id, key, encoded);
      this.cacheNorm(m.id, vectorNorm(vector), key, encoded);
    });
    return { id: m.id, dimensions: vector.length, embeddingVersion: key };
  }
  private async vector(
    input: string,
    signal?: AbortSignal,
    projectId?: string,
  ): Promise<number[]> {
    signal?.throwIfAborted();
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
    if (charge) await this.costs!.authorize(charge, signal);
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
        first = wireMember(data, "data"),
        vector = Array.isArray(first)
          ? wireMember(first[0], "embedding")
          : undefined,
        usage = wireObject(wireMember(data, "usage"));
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
          reported: Boolean(usage),
          input: tokenCount(usage?.prompt_tokens ?? usage?.total_tokens),
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokenCount(usage?.total_tokens),
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
    signal?.throwIfAborted();
    this.store.project(projectId);
    requestedLimit(limit);
    const key = this.embeddingKey(),
      q = await this.vector(query, signal, projectId);
    signal?.throwIfAborted();
    invariant(
      this.embeddingKey() === key,
      "Embedding route changed during search",
      409,
    );
    const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0)),
      best: { body: string; score: number }[] = [];
    const statement = this.store.db.prepare(
      "SELECT e.body,v.id,v.vector,n.norm FROM memory_vectors v JOIN e_memories e ON e.id=v.id LEFT JOIN memory_vector_norms n ON n.id=v.id WHERE v.model=? AND json_extract(e.body,'$.projectId')=? AND (? IS NULL OR json_extract(e.body,'$.namespace')=?) AND (json_extract(e.body,'$.expiresAt') IS NULL OR json_extract(e.body,'$.expiresAt')>?)",
    );
    let scanned = 0;
    const pendingNorms: [string, number, string | Uint8Array][] = [];
    let pendingNormBytes = 0;
    const flushNorms = () => {
      if (!pendingNorms.length) return;
      try {
        this.store.transaction(() => {
          for (const [memoryId, norm, vector] of pendingNorms)
            this.cacheNorm(memoryId, norm, key, vector);
        });
      } catch (error) {
        // Another connection can advance a WAL snapshot while this read cursor
        // yields. A derived cache must not turn a successful scan into a write
        // lock error; the guarded cache can be rebuilt on a later scan.
        const code = (error as { errcode?: number }).errcode;
        if (code === undefined || ![5, 6].includes(code & 0xff)) throw error;
      }
      pendingNorms.length = 0;
      pendingNormBytes = 0;
    };
    for (const row of statement.iterate(
      key,
      projectId,
      namespace ?? null,
      namespace ?? null,
      now(),
    ) as Iterable<{
      body: string;
      id: string;
      vector: string | Uint8Array;
      norm: number | null;
    }>) {
      if (++scanned % 256 === 0) {
        flushNorms();
        await new Promise<void>((r) => setImmediate(r));
      }
      signal?.throwIfAborted();
      const v = decodeVector(row.vector);
      if (v.length !== q.length) continue;
      // Preserve exact Float64 scoring; older vectors lazily cache their norm.
      let dot = 0,
        squares = 0;
      for (let i = 0; i < v.length; i++) {
        dot += v[i] * q[i];
        if (row.norm === null) squares += v[i] * v[i];
      }
      const norm = row.norm ?? Math.sqrt(squares);
      if (row.norm === null && Number.isFinite(norm)) {
        const bytes =
          typeof row.vector === "string"
            ? Buffer.byteLength(row.vector)
            : row.vector.byteLength;
        if (pendingNormBytes + bytes > 1024 * 1024) flushNorms();
        pendingNorms.push([row.id, norm, row.vector]);
        pendingNormBytes += bytes;
      }
      const score = dot / Math.max(norm * qNorm, 1e-10);
      // Decode only the retained results; equal scores preserve database order.
      if (best.length < limit || score > best[best.length - 1].score) {
        best.push({ body: row.body, score });
        best.sort((a, b) => b.score - a.score);
        if (best.length > limit) best.pop();
      }
    }
    flushNorms();
    return best.map(({ body, score }) => {
      const entry: MemoryEntry = JSON.parse(body);
      return { ...entry, score };
    });
  }
  private cacheNorm(
    memoryId: string,
    norm: number,
    model: string,
    vector: string | Uint8Array,
  ) {
    if (Number.isFinite(norm))
      this.store
        // An iterator can hold an earlier row across a yield. Only cache its
        // result while both the actual stored vector and model still match.
        .prepare(
          "INSERT INTO memory_vector_norms(id,norm) SELECT id,? FROM memory_vectors WHERE id=? AND model=? AND vector=? ON CONFLICT(id) DO UPDATE SET norm=excluded.norm",
        )
        .run(norm, memoryId, model, vector);
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

/**
 * Embeddings are stored as float64 BLOBs (platform byte order): exact values, about
 * half the size of JSON text and no parsing during search. Older rows hold JSON text.
 */
function encodeVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float64Array.from(vector).buffer);
}
function vectorNorm(vector: readonly number[]): number {
  let squares = 0;
  for (const value of vector) squares += value * value;
  return Math.sqrt(squares);
}
function decodeVector(stored: string | Uint8Array): ArrayLike<number> {
  if (typeof stored === "string") return JSON.parse(stored) as number[];
  // A view needs 8-byte alignment; copy the rare unaligned buffer.
  const bytes = stored.byteOffset % 8 ? stored.slice() : stored;
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
}

/** A provider-reported token count; absent or malformed values count as 0. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && value ? value : 0;
}
