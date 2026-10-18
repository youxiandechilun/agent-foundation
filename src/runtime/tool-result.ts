import type { ToolResult } from "./types.js";
import type { Assets } from "../storage/assets.js";
import { invariant, redactJson, hash } from "../core/util.js";
export const normalizedResultDigest = Symbol("normalizedResultDigest");

/** Validate and bound data from every tool source before it enters context or durable effects. */
export async function normalizeToolResult(
  value: unknown,
  assets: Assets,
  projectId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  signal?.throwIfAborted();
  const result = value as ToolResult;
  invariant(
    result && Array.isArray(result.content) && result.content.length <= 200,
    "Invalid tool result content",
    502,
  );
  for (const part of result.content) {
    invariant(
      part && (part.type === "text" || part.type === "image"),
      "Unsupported tool result block",
      502,
    );
    if (part.type === "text")
      invariant(typeof part.text === "string", "Invalid tool text", 502);
    else
      invariant(
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          part.mimeType,
        ) &&
          typeof part.data === "string" &&
          Buffer.byteLength(part.data) <= 7 * 1024 * 1024 &&
          Buffer.from(part.data, "base64").toString("base64") === part.data,
        "Invalid or oversized tool image",
        502,
      );
  }
  invariant(
    result.isError === undefined || typeof result.isError === "boolean",
    "Invalid tool error flag",
    502,
  );
  if (result.artifacts) {
    invariant(Array.isArray(result.artifacts), "Invalid tool artifacts", 502);
    for (const id of result.artifacts) assets.owned(id, projectId);
  }
  const encoded = JSON.stringify(redactJson(result));
  invariant(
    Buffer.byteLength(encoded) <= assets.config.limits.maxUploadBytes,
    "Tool result exceeds maximum asset size",
    502,
  );
  const safe = JSON.parse(encoded) as ToolResult;
  const mark = (result: ToolResult) =>
    Object.defineProperty(result, normalizedResultDigest, {
      value: hash(encoded),
    });
  // Images have a separate byte limit and context accounting. Bound all textual/structured data.
  const textOnly = JSON.stringify({
    ...safe,
    content: safe.content.filter((p) => p.type === "text"),
  });
  if (Buffer.byteLength(textOnly) <= limit) return mark(safe);
  const asset = await assets.create(
    projectId,
    "tool-result.json",
    Buffer.from(encoded),
    "artifact",
    "application/json",
  );
  signal?.throwIfAborted();
  const source = safe.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const preview = Buffer.from(source)
    .subarray(0, Math.max(0, Math.floor(limit / 3)))
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return mark({
    content: [
      {
        type: "text",
        text: `${preview}\n[Tool output truncated. Complete result saved as asset ${asset.id}; use asset_read to inspect it.]`,
      },
      ...safe.content.filter((part) => part.type === "image"),
    ],
    isError: safe.isError,
    artifacts: [...(safe.artifacts || []), asset.id],
    details: {
      truncated: true,
      fullResultAssetId: asset.id,
      fullResultBytes: Buffer.byteLength(encoded),
      fullResultSha256: asset.sha256,
    },
  });
}
