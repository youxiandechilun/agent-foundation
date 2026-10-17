import { z } from "zod";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
  lstatSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Asset, Session, StoredMessage } from "./contracts.js";
import { Store } from "./store.js";
import { Assets } from "./assets.js";
import { decodeSessionSnapshot } from "./session-codec.js";
import { hash, id, invariant, now } from "./util.js";

const assetId = z.string().regex(/^asset_[a-f0-9-]{36}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bundleSchema = z
  .object({
    format: z.literal("foundation-migration-v1"),
    payload: z
      .object({
        createdAt: z.string().datetime(),
        snapshot: z.unknown(),
        assets: z
          .array(
            z
              .object({
                id: assetId,
                name: z.string().min(1).max(180),
                mime: z
                  .string()
                  .min(1)
                  .max(200)
                  .regex(/^[^\x00-\x1f]+$/),
                size: z.number().int().nonnegative(),
                sha256: digest,
                origin: z.enum(["upload", "artifact", "model"]),
                data: z.string(),
              })
              .strict(),
          )
          .max(2000),
      })
      .strict(),
    sha256: digest,
  })
  .strict();
export interface MigrationReceipt {
  id: string;
  projectId: string;
  key: string;
  sha256: string;
  sessionId: string;
  assetMap: Record<string, string>;
  messageMap: Record<string, string>;
  runMap: Record<string, string>;
  toolCallMap: Record<string, string>;
  createdAt: string;
  requestedRouteId?: string;
}
/** Stable JSON digest, independent of the JSON object's incoming key order. */
function canonical(value: unknown, depth = 0): string {
  invariant(depth <= 100, "Migration JSON exceeds nesting limit");
  if (Array.isArray(value))
    return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as any)[key], depth + 1),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function migrationDigest(payload: unknown) {
  return hash(canonical(payload));
}
function references(value: unknown) {
  return new Set(JSON.stringify(value).match(/\basset_[a-f0-9-]{36}\b/g) || []);
}
function replaceIds<T>(
  value: T,
  mapping: Record<string, string>,
  sourceProject: string,
  targetProject: string,
): T {
  // Asset IDs occur both in structured tool data and in attachment text/URLs.
  if (typeof value === "string")
    return value.replace(
      /\basset_[a-f0-9-]{36}\b/g,
      (x) => mapping[x] || x,
    ) as T;
  if (Array.isArray(value))
    return value.map((v) =>
      replaceIds(v, mapping, sourceProject, targetProject),
    ) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        key === "projectId" && v === sourceProject
          ? targetProject
          : replaceIds(v, mapping, sourceProject, targetProject),
      ]),
    ) as T;
  return value;
}

/** Portable evidence and bytes. Never imports executable extensions, policies, tokens or effects. */
export class SessionMigration {
  private root: string;
  constructor(
    readonly store: Store,
    readonly assets: Assets,
    readonly config: Config,
  ) {
    this.root = path.join(config.dataDir, "migration-staging");
  }
  recover() {
    mkdirSync(this.root, { recursive: true });
    for (const name of readdirSync(this.root)) {
      if (!/^migration_[a-f0-9-]{36}$/.test(name)) continue;
      const directory = path.join(this.root, name);
      invariant(
        lstatSync(directory).isDirectory() &&
          !lstatSync(directory).isSymbolicLink(),
        "Linked migration staging directory",
        409,
      );
      const journal = path.join(directory, "journal.json");
      if (existsSync(journal)) {
        const entry = z
          .object({ ids: z.array(assetId).max(2000) })
          .strict()
          .parse(JSON.parse(readFileSync(journal, "utf8")));
        for (const asset of entry.ids) {
          // A committed asset is never removed, including after a crash between commit and cleanup.
          if (!this.store.find("assets", asset))
            rmSync(this.assets.file(asset), { force: true });
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }
  async export(sessionId: string) {
    const source = this.store.session(sessionId);
    const decoded = decodeSessionSnapshot(
      {
        format: "foundation-session-v1",
        session: source,
        messages: this.store.transcript(sessionId),
      },
      this.config.limits.maxSessionMessages,
      this.config.limits.maxMigrationBytes,
    );
    const snapshot = {
      format: "foundation-session-v1",
      session: {
        projectId: source.projectId,
        name: source.name,
        mode: source.mode,
        routeId: source.routeId,
      },
      messages: decoded.messages,
    };
    const assets = [];
    let size = Buffer.byteLength(JSON.stringify(snapshot));
    const dependencies = references(snapshot.messages);
    invariant(dependencies.size <= 2000, "Too many migration assets", 413);
    for (const ref of dependencies) {
      const meta = this.assets.owned(ref, source.projectId),
        bytes = await this.assets.read(ref, source.projectId);
      size += bytes.length;
      invariant(
        size <= this.config.limits.maxMigrationBytes,
        "Migration byte budget exceeded",
        413,
      );
      assets.push({
        id: meta.id,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        sha256: meta.sha256,
        origin: meta.origin,
        data: bytes.toString("base64"),
      });
    }
    const payload = { createdAt: now(), snapshot, assets };
    return {
      format: "foundation-migration-v1" as const,
      payload,
      sha256: migrationDigest(payload),
    };
  }
  import(
    projectId: string,
    input: unknown,
    key: string,
    createSession: (name: string, mode: string) => Session,
    requestedRouteId?: string,
  ) {
    this.store.project(projectId);
    invariant(
      typeof key === "string" && key.length >= 1 && key.length <= 180,
      "Migration import key required",
    );
    const encoded = JSON.stringify(input);
    invariant(
      encoded &&
        Buffer.byteLength(encoded) <=
          this.config.limits.maxMigrationBytes * 1.4 + 9 * 1024 * 1024,
      "Migration package too large",
      413,
    );
    const bundle = bundleSchema.parse(input);
    invariant(
      bundle.sha256 === migrationDigest(bundle.payload),
      "Migration manifest digest mismatch",
      409,
      "migration_integrity_failed",
    );
    const previous = this.store
      .list<MigrationReceipt>("session-migrations")
      .find((r) => r.projectId === projectId && r.key === key);
    if (previous) {
      invariant(
        previous.sha256 === bundle.sha256,
        "Import key reused with different package",
        409,
        "idempotency_conflict",
      );
      invariant(
        previous.requestedRouteId === requestedRouteId,
        "Import key reused with different destination route",
        409,
        "idempotency_conflict",
      );
      this.store.session(previous.sessionId);
      return { ...previous, reused: true };
    }
    const decoded = decodeSessionSnapshot(
      bundle.payload.snapshot,
      this.config.limits.maxSessionMessages,
      this.config.limits.maxMigrationBytes,
    );
    const sourceIds = new Set<string>(),
      bytes = new Map<string, Buffer>();
    let total = Buffer.byteLength(JSON.stringify(bundle.payload.snapshot));
    for (const asset of bundle.payload.assets) {
      invariant(!sourceIds.has(asset.id), "Duplicate migration asset");
      sourceIds.add(asset.id);
      invariant(
        asset.name === path.posix.basename(asset.name) &&
          !/[\\\x00-\x1f]/.test(asset.name) &&
          asset.name !== "." &&
          asset.name !== "..",
        "Invalid portable asset name",
      );
      invariant(
        asset.size <= this.config.limits.maxUploadBytes &&
          asset.data.length <= Math.ceil(asset.size / 3) * 4,
        "Asset exceeds byte limit",
        413,
      );
      invariant(asset.data.length % 4 === 0, "Non-canonical base64 asset");
      const data = Buffer.from(asset.data, "base64");
      invariant(
        data.toString("base64") === asset.data &&
          data.length === asset.size &&
          hash(data) === asset.sha256,
        "Migration asset digest mismatch",
        409,
        "migration_integrity_failed",
      );
      total += data.length;
      invariant(
        total <= this.config.limits.maxMigrationBytes,
        "Migration byte budget exceeded",
        413,
      );
      bytes.set(asset.id, data);
    }
    const refs = references(decoded.messages);
    invariant(
      [...refs].every((ref) => sourceIds.has(ref)),
      "Referenced asset missing from package",
      409,
    );
    invariant(
      [...sourceIds].every((ref) => refs.has(ref)),
      "Unreferenced asset in package",
    );
    const receipt: MigrationReceipt = {
      id: id("migration"),
      projectId,
      key,
      sha256: bundle.sha256,
      sessionId: "",
      assetMap: {},
      messageMap: {},
      runMap: {},
      toolCallMap: {},
      createdAt: now(),
      requestedRouteId,
    };
    for (const asset of sourceIds) receipt.assetMap[asset] = id("asset");
    const messages = replaceIds(
      decoded.messages,
      receipt.assetMap,
      decoded.session.projectId,
      projectId,
    ) as StoredMessage[];
    for (const item of messages) {
      receipt.messageMap[item.id] = id("message");
      item.id = receipt.messageMap[item.id];
      receipt.runMap[item.runId] ||= id("imported-run");
      item.runId = receipt.runMap[item.runId];
      if (item.message.role === "user") {
        if (item.message.inputId) item.message.inputId = id("input");
      }
      if (item.message.role === "assistant")
        for (const part of item.message.content)
          if (part.type === "toolCall") {
            receipt.toolCallMap[part.id] = id("call");
            part.id = receipt.toolCallMap[part.id];
          }
      if (item.message.role === "toolResult")
        item.message.toolCallId = receipt.toolCallMap[item.message.toolCallId];
    }
    const stage = path.join(this.root, receipt.id);
    mkdirSync(stage, { recursive: true });
    mkdirSync(this.assets.root, { recursive: true });
    // Durable intent precedes file promotion. Startup removes only uncommitted new IDs.
    writeFileSync(
      path.join(stage, "journal.json"),
      JSON.stringify({ ids: Object.values(receipt.assetMap) }),
      { flag: "wx", flush: true },
    );
    let committed = false;
    try {
      for (const [oldId, data] of bytes)
        writeFileSync(path.join(stage, receipt.assetMap[oldId]), data, {
          flag: "wx",
          flush: true,
        });
      this.store.transaction(() => {
        const session = createSession(
          decoded.session.name + " (migrated)",
          decoded.session.mode,
        );
        invariant(
          session.projectId === projectId && session.autonomy === "assist",
          "Invalid migration session factory",
          500,
        );
        receipt.sessionId = session.id;
        for (const old of bundle.payload.assets) {
          const newId = receipt.assetMap[old.id];
          invariant(
            !existsSync(this.assets.file(newId)),
            "Asset collision",
            409,
          );
          renameSync(path.join(stage, newId), this.assets.file(newId));
          const asset: Asset = {
            id: newId,
            projectId,
            name: old.name,
            mime: old.mime,
            size: old.size,
            sha256: old.sha256,
            origin: old.origin,
            createdAt: now(),
          };
          this.store.put("assets", asset);
        }
        this.store.saveTranscript(session.id, messages);
        this.store.put("session-migrations", receipt);
      });
      committed = true;
      return { ...receipt, reused: false };
    } finally {
      if (!committed)
        for (const ref of Object.values(receipt.assetMap))
          if (!this.store.find("assets", ref))
            rmSync(this.assets.file(ref), { force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  }
}
