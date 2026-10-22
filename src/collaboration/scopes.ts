import path from "node:path";
import { invariant } from "../core/util.js";

/** Ownership declarations use project-relative files/directories; [] means no writes. */
export function normalizeScopes(scopes: string[]): string[] {
  return [
    ...new Set(
      scopes.map((scope) => {
        const source = scope.replaceAll("\\", "/").replace(/\/$/, "");
        invariant(
          source.length > 0 &&
            !path.posix.isAbsolute(source) &&
            !/^[a-zA-Z]:/.test(source) &&
            !/[\x00-\x1f*?[\]{}]/.test(source) &&
            !source.split("/").includes(".."),
          "Write scope must be a relative file or directory without wildcards or traversal",
        );
        const normalized = path.posix.normalize(source);
        return process.platform === "win32"
          ? normalized.toLowerCase()
          : normalized;
      }),
    ),
  ];
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) =>
    right.some(
      (b) =>
        a === "." ||
        b === "." ||
        a === b ||
        a.startsWith(`${b}/`) ||
        b.startsWith(`${a}/`),
    ),
  );
}

export function workspaceKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
