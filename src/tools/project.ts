import { Type } from "typebox";
import { readFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, safePath, invariant } from "../core/util.js";
import { processTools } from "../execution/tools.js";
import { executionCapabilities } from "../execution/process.js";
import {
  boundedDirectory,
  globMatcher,
  walkProject,
} from "../runtime/project-walk.js";
import { RegexSearch } from "../runtime/regex-search.js";
import type { BuiltinTools } from "./builtin.js";
import { sentences } from "../prompts/sentences.js";

export function registerProject({
  ctx,
  k,
  runId,
  session,
  root,
  tools,
  add,
  artifact,
}: BuiltinTools): void {
  const runner = k.commands;
  add(
    "file_list",
    "List entries under the project root.",
    Type.Object({ path: Type.Optional(Type.String()) }),
    "read",
    ["files.read"],
    async (args, signal) => {
      const { entries, truncated } = await boundedDirectory(
        await safePath(root, args.path || ""),
        1000,
        signal,
      );
      return {
        entries: entries.map((e) => ({
          name: e.name,
          kind: e.isSymbolicLink()
            ? "link"
            : e.isDirectory()
              ? "directory"
              : "file",
        })),
        truncated,
      };
    },
  );
  add(
    "file_read",
    "Read a character range of an actual UTF-8 project file.",
    Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64000 })),
    }),
    "read",
    ["files.read"],
    async (args) => {
      const target = await safePath(root, args.path);
      invariant(
        (await stat(target)).size <= 4 * 1024 * 1024,
        "Use asset ingestion for files above 4 MiB",
      );
      const text = await readFile(target, "utf8");
      invariant(!text.includes("\0"), "Binary file");
      const offset = args.offset || 0,
        limit = args.limit || 20000;
      return {
        path: args.path,
        text: text.slice(offset, offset + limit),
        totalCharacters: text.length,
        truncated: text.length > offset + limit,
      };
    },
  );
  const write = async (relative: string, content: string, callId: string) => {
    const file = await safePath(root, relative, true);
    const checkpoint = await k.checkpoints.capture(
      { sessionId: session.id, projectId: session.projectId, runId, callId },
      root,
      relative,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await safePath(root, relative, true);
    await atomicWrite(file, content);
    k.checkpoints.complete(checkpoint, content);
    const a = await k.assets.create(
      session.projectId,
      path.basename(file),
      Buffer.from(content),
      "artifact",
    );
    return { path: relative, ...artifact(a) };
  };
  add(
    "file_write",
    "Atomically write UTF-8 source/content within the project. Replaces existing contents.",
    Type.Object({
      path: Type.String(),
      content: Type.String({ maxLength: 1000000 }),
    }),
    "write",
    ["files.write"],
    async (args, _signal, callId) => write(args.path, args.content, callId),
  );
  add(
    "file_patch",
    "Replace exactly one matching text segment. Ambiguous or missing matches fail without writing.",
    Type.Object({
      path: Type.String(),
      oldText: Type.String({ minLength: 1, maxLength: 200000 }),
      newText: Type.String({ maxLength: 200000 }),
    }),
    "write",
    ["files.write"],
    async (args, _signal, callId) => {
      const file = await safePath(root, args.path);
      invariant((await stat(file)).size <= 4 * 1024 * 1024, "File too large");
      const text = await readFile(file, "utf8");
      const start = text.indexOf(args.oldText);
      invariant(
        start >= 0 &&
          text.indexOf(args.oldText, start + args.oldText.length) < 0,
        "oldText must match exactly once",
      );
      return write(
        args.path,
        text.replace(args.oldText, () => args.newText),
        callId,
      );
    },
  );
  add(
    "file_search",
    sentences(
      "Search project text files line by line (literal text, or a regular expression with regex=true).",
      "Skips .gitignore'd paths, .git, node_modules and symlinks unless includeIgnored is set; glob filters file paths (e.g.",
      '"*.ts" or "src/**/*.test.ts").',
    ),
    Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1000 }),
      path: Type.Optional(Type.String()),
      regex: Type.Optional(Type.Boolean()),
      ignoreCase: Type.Optional(Type.Boolean()),
      glob: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      includeIgnored: Type.Optional(Type.Boolean()),
    }),
    "read",
    ["files.read"],
    async (args, signal) => {
      const matches: { path: string; line: number; text: string }[] = [];
      const pattern = args.regex
        ? new RegexSearch(args.query, args.ignoreCase, signal)
        : undefined;
      const needle = args.ignoreCase ? args.query.toLowerCase() : args.query;
      const hit = (line: string) =>
        (args.ignoreCase ? line.toLowerCase() : line).includes(needle);
      const keep = args.glob ? globMatcher(args.glob) : () => true;
      try {
        if (pattern) await pattern.match([]);
        const walk = await walkProject(root, {
          start: args.path,
          signal,
          maxEntries: k.config.limits.maxSearchEntries,
          respectGitignore: !args.includeIgnored,
          onFile: async (relative, file) => {
            if (!keep(relative) || (await stat(file)).size > 500000)
              return true;
            const text = await readFile(file, { encoding: "utf8", signal });
            if (text.includes("\0")) return true;
            const lines = text.split(/\r?\n/);
            const indexes = pattern
              ? await pattern.match(lines, 200 - matches.length)
              : undefined;
            const addMatch = (index: number) => {
              matches.push({
                path: relative,
                line: index + 1,
                text: lines[index].slice(0, 600),
              });
            };
            if (indexes) {
              for (const index of indexes) addMatch(index);
              if (matches.length >= 200) return false;
            } else {
              for (let index = 0; index < lines.length; index++) {
                if (hit(lines[index])) addMatch(index);
                if (matches.length >= 200) return false;
              }
            }
            return true;
          },
        });
        if (pattern) await pattern.match([]);
        return { matches, visited: walk.visited, truncated: walk.truncated };
      } finally {
        await pattern?.close();
      }
    },
  );
  add(
    "file_glob",
    sentences(
      'Find project files by glob pattern ("**/*.ts", "src/**/index.{js,ts}"; a pattern without / matches file names at any depth).',
      "Newest first.",
      "Skips .gitignore'd paths unless includeIgnored is set.",
    ),
    Type.Object({
      pattern: Type.String({ minLength: 1, maxLength: 500 }),
      path: Type.Optional(Type.String()),
      includeIgnored: Type.Optional(Type.Boolean()),
    }),
    "read",
    ["files.read"],
    async (args, signal) => {
      const match = globMatcher(args.pattern),
        files: { path: string; bytes: number; modified: string }[] = [];
      const base = (args.path || "").replace(/\\/g, "/").replace(/\/$/, "");
      const walk = await walkProject(root, {
        start: args.path,
        signal,
        maxEntries: k.config.limits.maxSearchEntries,
        respectGitignore: !args.includeIgnored,
        onFile: async (relative, file) => {
          // Patterns are relative to the requested directory.
          const local = base ? relative.slice(base.length + 1) : relative;
          if (match(local)) {
            const info = await stat(file);
            files.push({
              path: relative,
              bytes: info.size,
              modified: info.mtime.toISOString(),
            });
          }
          return files.length < 2000;
        },
      });
      files.sort((a, b) => b.modified.localeCompare(a.modified));
      return {
        files: files.slice(0, 500),
        total: files.length,
        truncated: walk.truncated || files.length > 500,
      };
    },
  );
  add(
    "exec_run",
    "Run an actual process with argv through the configured native, optional Docker or Windows AppContainer backend. Native execution has the host user's permissions.",
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 2000 }),
      args: Type.Array(Type.String({ maxLength: 10000 }), { maxItems: 100 }),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000 })),
    }),
    "execute",
    executionCapabilities(k.config),
    async (args, signal, callId) => {
      const result = await runner.run(
        {
          command: args.command,
          args: args.args,
          cwd: await safePath(root, args.cwd || ""),
          timeoutMs: args.timeoutMs || 60000,
        },
        root,
        signal,
        (text, stream) =>
          k.store.emitEphemeral(runId, "tool.output", {
            toolCallId: callId,
            text,
            stream,
          }),
      );
      invariant(
        result.exitCode === 0,
        `Command exited ${result.exitCode}\n${result.stderr}\n${result.stdout}`,
        422,
        "command_failed",
      );
      return result;
    },
  );
  tools.push(...processTools(ctx));
  add(
    "git_inspect",
    "Inspect Git status/diff. Git can invoke repository-configured helpers, so this requires exec permission even for inspection.",
    Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("diff")]),
      staged: Type.Optional(Type.Boolean()),
    }),
    "execute",
    ["files.read", ...executionCapabilities(k.config)],
    async (args, signal) => {
      const command =
        args.action === "status"
          ? ["status", "--short", "--", "."]
          : [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...(args.staged ? ["--cached"] : []),
              "--",
              ".",
            ];
      const result = await runner.run(
        {
          command: "git",
          args: [
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            ...command,
          ],
          cwd: root,
          timeoutMs: 15000,
        },
        root,
        signal,
      );
      invariant(result.exitCode === 0, result.stderr);
      return result;
    },
  );
}
