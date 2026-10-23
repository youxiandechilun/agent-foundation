import {
  mkdir,
  lstat,
  rm,
  link,
  readFile,
  unlink,
  readdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { Asset } from "../contracts.js";
import type { Config } from "../core/config.js";
import { Store } from "./store.js";
import { hash, id, now, invariant, truncate } from "../core/util.js";

const mimes: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".ts": "text/plain",
  ".js": "text/plain",
  ".py": "text/plain",
  ".xml": "application/xml",
  ".log": "text/plain",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
import { ExtractorRegistry } from "../runtime/extractors.js";
import { Capacity } from "../runtime/capacity.js";
import { writeAssetStream } from "./asset-stream.js";
export class Assets {
  readonly extractors = new ExtractorRegistry();
  readonly root: string;
  private readonly uploads: Capacity;
  private readonly downloads: Capacity;
  private readonly transfers: Capacity;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeFiles = new Set<string>();
  private readonly snapshots = new Set<() => Promise<void>>();
  private closed = false;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.root = path.join(config.dataDir, "assets");
    this.uploads = new Capacity(config.limits.maxConcurrentUploads);
    this.downloads = new Capacity(config.limits.maxConcurrentDownloads);
    this.transfers = new Capacity(
      Infinity,
      config.limits.maxInFlightAssetBytes,
    );
  }
  file(assetId: string) {
    invariant(/^asset_[a-f0-9-]+$/.test(assetId), "Invalid asset ID");
    return path.join(this.root, assetId);
  }
  async init() {
    invariant(!this.closed, "Asset storage is closed", 503);
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      const file = path.join(this.root, entry.name);
      if (
        !this.activeFiles.has(file) &&
        (entry.isFile() || entry.isSymbolicLink()) &&
        /^\.(?:asset_[a-f0-9-]+\.upload|download_[a-f0-9-]+\.verified)$/.test(
          entry.name,
        )
      )
        await rm(file, { force: true });
    }
  }
  private signal(signal?: AbortSignal) {
    return signal
      ? AbortSignal.any([this.lifetime.signal, signal])
      : this.lifetime.signal;
  }
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    invariant(!this.closed, "Asset storage is closed", 503);
    const work = operation();
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }
  async create(
    projectId: string,
    name: string,
    bytes: Buffer,
    origin: Asset["origin"] = "upload",
    mime?: string,
    signal?: AbortSignal,
  ): Promise<Asset> {
    return this.createStream(
      projectId,
      name,
      [bytes],
      origin,
      mime,
      signal,
      bytes.length,
    );
  }
  async createStream(
    projectId: string,
    name: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    origin: Asset["origin"] = "upload",
    mime?: string,
    signal?: AbortSignal,
    expectedBytes?: number,
  ): Promise<Asset> {
    return this.track(() =>
      this.writeStream(
        projectId,
        name,
        source,
        origin,
        mime,
        this.signal(signal),
        expectedBytes,
      ),
    );
  }
  private async writeStream(
    projectId: string,
    name: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    origin: Asset["origin"],
    mime: string | undefined,
    signal: AbortSignal,
    expectedBytes?: number,
  ): Promise<Asset> {
    signal?.throwIfAborted();
    this.store.project(projectId);
    invariant(
      expectedBytes === undefined ||
        (Number.isSafeInteger(expectedBytes) &&
          expectedBytes >= 0 &&
          expectedBytes <= this.config.limits.maxUploadBytes),
      "Asset exceeds upload limit",
      413,
      "asset_too_large",
    );
    const release = this.reserve(
      this.uploads,
      expectedBytes ?? this.config.limits.maxUploadBytes,
    );
    const safeName =
      path
        .basename(name.replaceAll("\\", "/"))
        .replace(/[\x00-\x1f]/g, "_")
        .slice(0, 180) || "attachment.bin";
    const asset: Asset = {
      id: id("asset"),
      projectId,
      name: safeName,
      size: 0,
      sha256: "",
      mime:
        mime ||
        mimes[path.extname(safeName).toLowerCase()] ||
        "application/octet-stream",
      createdAt: now(),
      origin,
    };
    const file = this.file(asset.id);
    const temporary = path.join(this.root, `.${asset.id}.upload`);
    this.activeFiles.add(temporary);
    let published = false;
    try {
      await mkdir(this.root, { recursive: true });
      Object.assign(
        asset,
        await writeAssetStream(
          temporary,
          source,
          this.config.limits.maxUploadBytes,
          signal,
          expectedBytes,
        ),
      );
      signal?.throwIfAborted();
      await link(temporary, file);
      published = true;
      await unlink(temporary);
      signal?.throwIfAborted();
      return this.store.put("assets", asset);
    } catch (error) {
      if (published) await rm(file, { force: true });
      throw error;
    } finally {
      try {
        await rm(temporary, { force: true });
      } finally {
        this.activeFiles.delete(temporary);
        release();
      }
    }
  }
  private reserve(capacity: Capacity, bytes: number) {
    const releaseCount = capacity.reserve();
    try {
      const releaseBytes = this.transfers.reserve(bytes);
      return () => {
        releaseBytes();
        releaseCount();
      };
    } catch (error) {
      releaseCount();
      throw error;
    }
  }
  owned(assetId: string, projectId: string) {
    const asset = this.store.asset(assetId);
    invariant(
      asset.projectId === projectId,
      "Asset belongs to another project",
      403,
      "asset_denied",
    );
    return asset;
  }
  async read(assetId: string, projectId: string, signal?: AbortSignal) {
    return this.track(() =>
      this.readBuffer(assetId, projectId, this.signal(signal)),
    );
  }
  private async readBuffer(
    assetId: string,
    projectId: string,
    signal: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const asset = this.owned(assetId, projectId);
    const release = this.reserve(this.downloads, asset.size);
    try {
      const file = this.file(asset.id);
      const info = await lstat(file);
      invariant(
        info.isFile() && !info.isSymbolicLink(),
        "Asset file changed or is linked",
        409,
      );
      invariant(
        info.size <= this.config.limits.maxUploadBytes,
        "Asset exceeds read limit",
      );
      const bytes = await readFile(file, { signal });
      invariant(
        bytes.length === asset.size && hash(bytes) === asset.sha256,
        "Asset integrity digest changed",
        409,
        "asset_integrity_failed",
      );
      return bytes;
    } finally {
      release();
    }
  }
  /** Snapshot before responding: changed source bytes must never reach a client. */
  async openVerified(assetId: string, projectId: string, signal?: AbortSignal) {
    return this.track(() =>
      this.snapshot(assetId, projectId, this.signal(signal)),
    );
  }
  private async snapshot(
    assetId: string,
    projectId: string,
    signal: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const asset = this.owned(assetId, projectId);
    const release = this.reserve(this.downloads, asset.size);
    const file = this.file(asset.id);
    const snapshot = path.join(this.root, `.${id("download")}.verified`);
    this.activeFiles.add(snapshot);
    try {
      const info = await lstat(file);
      invariant(
        info.isFile() && !info.isSymbolicLink(),
        "Asset file changed or is linked",
        409,
      );
      invariant(
        info.size <= this.config.limits.maxUploadBytes,
        "Asset exceeds read limit",
      );
      const source = createReadStream(file, {
        highWaterMark: 64 * 1024,
        signal,
      });
      let result: { size: number; sha256: string };
      try {
        result = await writeAssetStream(
          snapshot,
          source,
          this.config.limits.maxUploadBytes,
          signal,
        );
      } finally {
        source.destroy();
      }
      invariant(
        result.size === asset.size && result.sha256 === asset.sha256,
        "Asset integrity digest changed",
        409,
        "asset_integrity_failed",
      );
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await rm(snapshot, { force: true });
        } finally {
          this.snapshots.delete(close);
          this.activeFiles.delete(snapshot);
          release();
        }
      };
      this.snapshots.add(close);
      return { asset, file: snapshot, close };
    } catch (error) {
      try {
        await rm(snapshot, { force: true });
      } finally {
        this.activeFiles.delete(snapshot);
        release();
      }
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error("Asset storage is closing"));
    await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled(
      [...this.snapshots].map((close) => close()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Asset snapshot cleanup failed");
  }
  async extract(
    assetId: string,
    projectId: string,
    limit = this.config.limits.maxAttachmentText,
    signal?: AbortSignal,
  ): Promise<{ text: string; supported: boolean; truncated: boolean }> {
    const asset = this.owned(assetId, projectId);
    const parser = this.extractors.find(asset);
    if (parser) {
      const result = await parser.extract({
        asset,
        limit,
        signal,
        read: () => this.read(assetId, projectId, signal),
      });
      signal?.throwIfAborted();
      invariant(
        typeof result.text === "string" &&
          typeof result.supported === "boolean" &&
          typeof result.truncated === "boolean",
        "Invalid extractor result",
        502,
      );
      return {
        ...result,
        text: result.text.slice(0, limit),
        truncated: result.truncated || result.text.length > limit,
      };
    }
    const ext = path.extname(asset.name).toLowerCase();
    if (
      asset.mime.startsWith("text/") ||
      [
        ".json",
        ".xml",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".sql",
        ".sh",
        ".css",
      ].includes(ext)
    ) {
      const bytes = await this.read(assetId, projectId, signal);
      const text = bytes.toString("utf8");
      if (text.includes("\0"))
        return {
          text: "[Binary content; use a matching parser]",
          supported: false,
          truncated: false,
        };
      return {
        text: truncate(text, limit),
        supported: true,
        truncated: text.length > limit,
      };
    }
    return {
      text: `[${asset.mime}, ${asset.size} bytes. Stored as asset ${asset.id}; native text extraction unavailable.]`,
      supported: false,
      truncated: false,
    };
  }
}
