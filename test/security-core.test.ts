import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setup, until } from "./support/wire-server.js";

const manifest = {
  schemaVersion: 1,
  id: "integrity",
  name: "integrity test",
  version: "1.0.0",
  entry: "index.mjs",
  tools: [
    {
      name: "read",
      description: "test",
      parameters: { type: "object" },
      risk: "read",
      capabilities: [],
    },
  ],
};
test("plugin integrity rejects changed entry, dependencies and added source, then revokes trust", async () => {
  const x = await setup();
  try {
    for (const mutation of ["entry", "dependency", "added"]) {
      const installed = await x.kernel.plugins.install(manifest, {
        "index.mjs":
          "import {value} from './helper.mjs';export async function execute(){return {content:[{type:'text',text:value}]};}",
        "helper.mjs": "export const value='reviewed';",
      });
      x.kernel.plugins.enable(installed.id, true, installed.hash);
      const record = x.kernel.store.get<any>("plugins", installed.id);
      await writeFile(
        path.join(
          record.directory,
          mutation === "entry"
            ? "index.mjs"
            : mutation === "dependency"
              ? "helper.mjs"
              : "extra.mjs",
        ),
        "throw Error('unreviewed source must not run');",
      );
      const tool = x.kernel.plugins.tools(x.project.id, x.project.root)[0];
      await assert.rejects(
        tool.execute("integrity", {}),
        /integrity check failed/,
      );
      assert.equal(x.kernel.plugins.list()[0].enabled, false);
      assert.equal(x.kernel.plugins.list()[0].trustedHash, undefined);
    }
  } finally {
    await x.close();
  }
});
test("plugin runs its verified snapshot even if the installation changes during invocation", async () => {
  const x = await setup();
  try {
    const installed = await x.kernel.plugins.install(manifest, {
      "index.mjs":
        "export async function execute(){await new Promise(r=>setTimeout(r,250));const {value}=await import('./helper.mjs');return {content:[{type:'text',text:value}]};}",
      "helper.mjs": "export const value='reviewed snapshot';",
    });
    x.kernel.plugins.enable(installed.id, true, installed.hash);
    const record = x.kernel.store.get<any>("plugins", installed.id);
    const pending = x.kernel.plugins
      .tools(x.project.id, x.project.root)[0]
      .execute("snapshot", {});
    await until(async () => {
      const dirs = await readdir(
        path.join(x.config.dataDir, "plugin-invocations"),
      ).catch(() => []);
      return dirs.length ? dirs : undefined;
    });
    await writeFile(
      path.join(record.directory, "helper.mjs"),
      "export const value='changed installed source';",
    );
    const snapshotResult = await pending;
    assert.equal((snapshotResult.content[0] as any).text, "reviewed snapshot");
    // Re-run after restoring the integrity check separately: original installation edits cannot enter the already-running snapshot.
    const snapshots = await readdir(
      path.join(x.config.dataDir, "plugin-invocations"),
    );
    assert.equal(snapshots.length, 0);
    await assert.rejects(
      x.kernel.plugins
        .tools(x.project.id, x.project.root)[0]
        .execute("next", {}),
      /integrity check failed/,
    );
  } finally {
    await x.close();
  }
});
test("planning mode rejects MCP and native plugin operations regardless of their read-only metadata", async () => {
  const x = await setup();
  try {
    const s = x.kernel.updateSession((await x.session("code")).id, {
      autonomy: "plan",
    });
    for (const kind of ["mcp", "plugin", "device"] as const) {
      const tool: any = {
        name: "claimed_readonly",
        description: "untrusted claim",
        parameters: { type: "object" },
        risk: "read",
        capabilities: [
          kind === "mcp" ? "mcp" : kind === "plugin" ? "plugin" : "node",
        ],
        source: { kind, id: "external" },
        execute: async () => {
          throw Error("must never execute");
        },
      };
      assert.equal(
        x.kernel.permissions.evaluate(s, "text", tool).effect,
        "deny",
      );
    }
  } finally {
    await x.close();
  }
});
