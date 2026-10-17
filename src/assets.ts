import { readFile, writeFile, mkdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { Asset } from "./contracts.js";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { hash, id, now, invariant, truncate } from "./util.js";

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
import { ExtractorRegistry } from "./runtime/extractors.js";
export class Assets {
  readonly extractors = new ExtractorRegistry();
  readonly root: string;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.root = path.join(config.dataDir, "assets");
  }
  file(assetId: string) {
    invariant(/^asset_[a-f0-9-]+$/.test(assetId), "Invalid asset ID");
    return path.join(this.root, assetId);
  }
  async create(
    projectId: string,
    name: string,
    bytes: Buffer,
    origin: Asset["origin"] = "upload",
    mime?: string,
    signal?: AbortSignal,
  ): Promise<Asset> {
    signal?.throwIfAborted();
    this.store.project(projectId);
    invariant(
      bytes.length <= this.config.limits.maxUploadBytes,
      "Asset exceeds upload limit",
      413,
      "asset_too_large",
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
      size: bytes.length,
      sha256: hash(bytes),
      mime:
        mime ||
        mimes[path.extname(safeName).toLowerCase()] ||
        "application/octet-stream",
      createdAt: now(),
      origin,
    };
    await mkdir(this.root, { recursive: true });
    const file = this.file(asset.id);
    try {
      await writeFile(file, bytes, { flag: "wx", signal });
      signal?.throwIfAborted();
      return this.store.put("assets", asset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        await rm(file, { force: true });
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
    const asset = this.owned(assetId, projectId);
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
