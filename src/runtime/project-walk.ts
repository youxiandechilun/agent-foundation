import { opendir, open } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { safePath, invariant } from "../core/util.js";

/** Never materialize an entire large directory just to apply a result limit. */
export async function boundedDirectory(
  directory: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  signal?.throwIfAborted();
  const entries: Dirent[] = [];
  const handle = await opendir(directory, {
    bufferSize: Math.min(32, limit + 1),
  });
  try {
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (entries.length >= limit) return { entries, truncated: true };
      entries.push(entry);
    }
  } finally {
    // for-await closes on exhaustion, error and an early return.
    await handle.close().catch(() => undefined);
  }
  return { entries, truncated: false };
}

const MAX_IGNORE_BYTES = 256 * 1024;
const MAX_IGNORE_RULES = 4096;
const MAX_ACTIVE_IGNORE_RULES = 16384;
const MAX_WALK_DEPTH = 128;

/**
 * Glob to RegExp over "/"-separated relative paths: `**` spans directories, `*` and `?` stay
 * within one segment, `{a,b}` alternates and `[...]` classes pass through.
 */
export function globToRegExp(glob: string) {
  let out = "",
    braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? "^" + body.slice(1) : body}]`;
        i = end;
      }
    } else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces) {
      braces--;
      out += ")";
    } else if (c === "," && braces) out += "|";
    else if (c === "\\" && i + 1 < glob.length) out += "\\" + glob[++i];
    else out += /[.+^$()|\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp(`^${out}$`);
}
/** A glob without "/" matches the file name at any depth, as in ripgrep and .gitignore. */
export function globMatcher(glob: string) {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const regex = globToRegExp(normalized.replace(/^\//, ""));
  return normalized.includes("/")
    ? (relative: string) => regex.test(relative)
    : (relative: string) =>
        regex.test(relative.slice(relative.lastIndexOf("/") + 1));
}

interface IgnoreRule {
  base: string;
  negate: boolean;
  directoryOnly: boolean;
  test: (relative: string) => boolean;
}
/** Parse one .gitignore located at `base` (relative to the walk root, "" for root). */
export function parseGitignore(
  text: string,
  base = "",
  maxRules = Infinity,
): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    line = line.replace(/(?<!\\)\s+$/, "");
    const negate = line.startsWith("!");
    if (negate || line.startsWith("\\!") || line.startsWith("\\#"))
      line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    if (!line) continue;
    invariant(
      rules.length < maxRules,
      "Ignore rule capacity exceeded",
      413,
      "search_capacity",
    );
    const anchored = line.includes("/");
    const regex = globToRegExp(line.replace(/^\//, ""));
    rules.push({
      base,
      negate,
      directoryOnly,
      test: (relative) => {
        if (base && !relative.startsWith(base + "/")) return false;
        const local = base ? relative.slice(base.length + 1) : relative;
        return anchored
          ? regex.test(local)
          : regex.test(local.slice(local.lastIndexOf("/") + 1));
      },
    });
  }
  return rules;
}
/** Last matching rule wins, as in Git. */
export function ignored(
  rules: IgnoreRule[],
  relative: string,
  directory: boolean,
) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if ((!rule.directoryOnly || directory) && rule.test(relative))
      return !rule.negate;
  }
  return false;
}

export interface WalkOptions {
  /** Relative directory to start from. */
  start?: string;
  signal?: AbortSignal;
  maxEntries: number;
  /** Honour .gitignore files (root and nested) and .git/info/exclude. */
  respectGitignore: boolean;
  /** Return false to stop the walk early. */
  onFile: (relative: string, absolute: string) => boolean | Promise<boolean>;
}
const ALWAYS_SKIPPED = new Set([".git", "node_modules", ".agent-data"]);
/** Bounded, symlink-free traversal within the project root using "/" separators. */
export async function walkProject(root: string, options: WalkOptions) {
  let visited = 0,
    stopped = false,
    truncated = false,
    pendingEntries = 0;
  const rules: IgnoreRule[] = [];
  const load = async (relative: string, file: string) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      options.signal?.throwIfAborted();
      handle = await open(await safePath(root, path.join(relative, file)), "r");
      invariant(
        (await handle.stat()).isFile(),
        "Ignore path must be a regular file",
      );
      const buffer = Buffer.alloc(MAX_IGNORE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          bytes,
          buffer.length - bytes,
          null,
        );
        if (!bytesRead) break;
        bytes += bytesRead;
      }
      invariant(
        bytes <= MAX_IGNORE_BYTES,
        "Ignore file exceeds 256 KiB limit",
        413,
        "search_capacity",
      );
      const parsed = parseGitignore(
        buffer.subarray(0, bytes).toString("utf8"),
        relative,
        MAX_IGNORE_RULES,
      );
      invariant(
        parsed.length <= MAX_IGNORE_RULES &&
          rules.length + parsed.length <= MAX_ACTIVE_IGNORE_RULES,
        "Ignore rule capacity exceeded",
        413,
        "search_capacity",
      );
      rules.push(...parsed);
    } catch (error) {
      if (
        !["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code!)
      )
        throw error;
    } finally {
      await handle?.close();
    }
  };
  if (options.respectGitignore) {
    await load("", ".git/info/exclude");
    // Ancestors of the start directory contribute their rules too.
    const parts = (options.start || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    for (let i = 0; i < parts.length; i++)
      await load(parts.slice(0, i).join("/"), ".gitignore");
  }
  const walk = async (relative: string, depth = 0): Promise<void> => {
    options.signal?.throwIfAborted();
    if (stopped || visited + pendingEntries >= options.maxEntries) {
      truncated = true;
      return;
    }
    invariant(
      depth <= MAX_WALK_DEPTH,
      "Project directory nesting limit exceeded",
      413,
      "search_capacity",
    );
    const ruleStart = rules.length;
    try {
      if (options.respectGitignore) await load(relative, ".gitignore");
      const listing = await boundedDirectory(
        await safePath(root, relative),
        options.maxEntries - visited - pendingEntries,
        options.signal,
      );
      truncated ||= listing.truncated;
      const entries = listing.entries;
      pendingEntries += entries.length;
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        if (stopped || visited >= options.maxEntries) return;
        pendingEntries--;
        visited++;
        if (entry.isSymbolicLink() || ALWAYS_SKIPPED.has(entry.name)) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        const directory = entry.isDirectory();
        if (options.respectGitignore && ignored(rules, child, directory))
          continue;
        if (directory) await walk(child, depth + 1);
        else if (entry.isFile())
          stopped = !(await options.onFile(child, await safePath(root, child)));
      }
    } finally {
      rules.length = ruleStart;
    }
  };
  await walk((options.start || "").replace(/\\/g, "/").replace(/\/$/, ""));
  return {
    visited,
    truncated: truncated || visited >= options.maxEntries || stopped,
  };
}
