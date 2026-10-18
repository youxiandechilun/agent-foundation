import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setup, collect } from "./support/wire-server.js";
import {
  globMatcher,
  parseGitignore,
  ignored,
} from "../src/runtime/project-walk.js";

test("file_patch inserts replacement markers literally and rejects ambiguous matches", async () => {
  const replacement = "$& $$ $` $' 中文";
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            {
              name: "file_patch",
              args: {
                path: "literal.txt",
                oldText: "target",
                newText: replacement,
              },
            },
            {
              name: "file_patch",
              args: {
                path: "repeated.txt",
                oldText: "target",
                newText: replacement,
              },
            },
          ],
        }
      : { text: "done" },
  );
  try {
    await writeFile(
      path.join(x.project.root, "literal.txt"),
      "before target after",
    );
    await writeFile(path.join(x.project.root, "repeated.txt"), "target target");
    const session = await x.session("code");
    const run = await x.client.submit(session.id, { text: "Patch files" });
    const events = await collect(x.client, run.runId);
    assert.equal(
      await readFile(path.join(x.project.root, "literal.txt"), "utf8"),
      `before ${replacement} after`,
    );
    assert.equal(
      await readFile(path.join(x.project.root, "repeated.txt"), "utf8"),
      "target target",
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.settled" &&
          JSON.stringify(event.data).includes(
            "oldText must match exactly once",
          ),
      ),
    );
  } finally {
    await x.close();
  }
});

test("glob matching: segments, globstar, braces, classes and basename patterns", () => {
  const m = (glob: string, file: string) => globMatcher(glob)(file);
  assert.ok(m("*.ts", "src/deep/a.ts"));
  assert.ok(!m("*.ts", "src/a.tsx"));
  assert.ok(m("src/*.ts", "src/a.ts"));
  assert.ok(!m("src/*.ts", "src/deep/a.ts"));
  assert.ok(m("src/**/*.ts", "src/a.ts"));
  assert.ok(m("src/**/*.ts", "src/x/y/a.ts"));
  assert.ok(m("**/index.{js,ts}", "a/b/index.ts"));
  assert.ok(!m("**/index.{js,ts}", "a/b/index.md"));
  assert.ok(m("file[0-9].txt", "file7.txt"));
  assert.ok(!m("file[!0-9].txt", "file7.txt"));
  assert.ok(m("a?c.md", "abc.md"));
  assert.ok(m("./docs/*.md", "docs/x.md"));
  assert.ok(m("name.with+chars(1).txt", "name.with+chars(1).txt"));
});

test(".gitignore rules: last match wins, anchoring, directory-only and nested bases", () => {
  const rules = [
    ...parseGitignore(
      "# comment\n\n*.log\n!keep.log\n/build\nout/\ndocs/**/*.tmp\n\\#hash\n",
    ),
    ...parseGitignore("secret.txt\n", "pkg"),
  ];
  const is = (p: string, dir = false) => ignored(rules, p, dir);
  assert.ok(is("a.log") && is("x/y/a.log"));
  assert.ok(!is("keep.log") && !is("x/keep.log"));
  assert.ok(is("build", true) && !is("src/build", true));
  assert.ok(is("out", true) && is("a/out", true) && !is("out", false));
  assert.ok(is("docs/a/b.tmp") && !is("other/b.tmp"));
  assert.ok(is("#hash"));
  assert.ok(is("pkg/secret.txt") && is("pkg/a/secret.txt"));
  assert.ok(!is("secret.txt"));
});

test("file_search and file_glob respect .gitignore, filters and regex", async () => {
  const steps = [
    { name: "file_search", args: { query: "needle" } },
    { name: "file_search", args: { query: "needle", includeIgnored: true } },
    {
      name: "file_search",
      args: { query: "NEE+DLE", regex: true, ignoreCase: true, glob: "*.ts" },
    },
    { name: "file_glob", args: { pattern: "**/*.ts" } },
    { name: "file_glob", args: { pattern: "*.test.ts", path: "src" } },
    { name: "file_glob", args: { pattern: "*.log", includeIgnored: true } },
    { name: "file_search", args: { query: "(", regex: true } },
  ];
  const x = await setup((_body, index) =>
    steps[index] ? { calls: [steps[index]] } : { text: "done" },
  );
  try {
    const root = x.config.workspaceRoots[0];
    const files: Record<string, string> = {
      ".gitignore": "dist/\n*.log\n!keep.log\n/root-only.txt\n",
      "src/a.ts": "const needle = 1;",
      "src/b.test.ts": "test('needle')",
      "src/c.md": "needle in docs",
      "dist/out.js": "needle",
      "app.log": "needle",
      "keep.log": "needle",
      "root-only.txt": "needle",
      "sub/root-only.txt": "needle",
      "sub/.gitignore": "secret.txt\n",
      "sub/secret.txt": "needle",
      "node_modules/x.js": "needle",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    const s = await x.session("code"),
      r = await x.client.submit(s.id, { text: "search" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const results = events
      .filter((e) => e.type === "tool.settled")
      .map((e) => e.data.result as any);
    const paths = (i: number) =>
      (results[i].details.matches || results[i].details.files)
        .map((m: any) => m.path)
        .sort();
    assert.deepEqual(paths(0), [
      "keep.log",
      "src/a.ts",
      "src/b.test.ts",
      "src/c.md",
      "sub/root-only.txt",
    ]);
    assert.deepEqual(paths(1), [
      "app.log",
      "dist/out.js",
      "keep.log",
      "root-only.txt",
      "src/a.ts",
      "src/b.test.ts",
      "src/c.md",
      "sub/root-only.txt",
      "sub/secret.txt",
    ]);
    assert.deepEqual(paths(2), ["src/a.ts", "src/b.test.ts"]);
    assert.deepEqual(paths(3), ["src/a.ts", "src/b.test.ts"]);
    assert.deepEqual(paths(4), ["src/b.test.ts"]);
    assert.deepEqual(paths(5), ["app.log", "keep.log"]);
    assert.equal(results[6].isError, true, "invalid regex is a tool error");
  } finally {
    await x.close();
  }
});
