import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setup, collect, until } from "./support/wire-server.js";
import { nativeProcess } from "../src/execution/process.js";

test("automatic memory retrieval respects host, route and project denial and never bypasses ask", async () => {
  for (const scope of ["host", "route", "project", "ask"]) {
    const x = await setup();
    try {
      x.kernel.memory.put({
        projectId: x.project.id,
        content: "orchid forest durable evidence",
      });
      if (scope === "host" || scope === "ask")
        x.config.permissions["memory.read"] = scope === "ask" ? "ask" : "deny";
      if (scope === "route")
        x.config.routes.text.capabilityPolicies["memory.read"] = "deny";
      if (scope === "project")
        x.kernel.store.put("policies", {
          id: "block-memory",
          projectId: x.project.id,
          capabilities: ["memory.read"],
          effect: "deny",
        });
      const s = await x.session();
      await collect(
        x.client,
        (await x.client.submit(s.id, { text: "orchid forest" })).runId,
      );
      assert.ok(
        !JSON.stringify(x.wire.requests[0].body).includes("durable evidence"),
        scope,
      );
    } finally {
      await x.close();
    }
  }
});

test("a policy revoked while approval is pending is enforced before the file effect begins", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            {
              name: "file_write",
              args: { path: "revoked.txt", content: "must not execute" },
            },
          ],
        }
      : { text: "done" },
  );
  try {
    x.config.permissions["files.write"] = "ask";
    const s = await x.session("code");
    const { runId } = await x.client.submit(s.id, {
      text: "write with approval",
    });
    const approval = await until(() =>
      x.kernel.store
        .list<any>("approvals")
        .find((a) => a.runId === runId && a.status === "pending"),
    );
    x.kernel.store.put("policies", {
      id: "revoked",
      projectId: x.project.id,
      capabilities: ["files.write"],
      effect: "deny",
    });
    x.kernel.permissions.resolve(approval.id, true);
    const events = await collect(x.client, runId);
    assert.equal(events.filter((e) => e.type === "tool.started").length, 0);
    await assert.rejects(
      readFile(path.join(x.project.root, "revoked.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});

test("git inspection cannot execute repository helpers under read-only permissions", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "git_inspect", args: { action: "diff" } }] }
      : { text: "done" },
  );
  try {
    const git = async (args: string[]) => {
      const result = await nativeProcess({
        command: "git",
        args,
        cwd: x.project.root,
        timeoutMs: 10000,
      });
      assert.equal(result.exitCode, 0, result.stderr);
    };
    await git(["init", "--quiet"]);
    await writeFile(path.join(x.project.root, "source.txt"), "before\n");
    await git(["add", "--", "source.txt"]);
    await writeFile(path.join(x.project.root, "source.txt"), "after\n");
    const marker = path.join(x.root, "git-helper-executed");
    const helper = path.join(x.root, "git-helper.cjs");
    await writeFile(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`,
    );
    await git([
      "config",
      "diff.external",
      `"${process.execPath.replaceAll("\\", "/")}" "${helper.replaceAll("\\", "/")}"`,
    ]);
    x.config.permissions.exec = "deny";
    const s = await x.session("code");
    x.kernel.updateSession(s.id, { autonomy: "plan" });
    await collect(
      x.client,
      (await x.client.submit(s.id, { text: "inspect only" })).runId,
    );
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    await x.close();
  }
});

test("an MCP tool closure is revoked after disconnect and cannot call a replacement server", async () => {
  const x = await setup();
  try {
    const args = [
      fileURLToPath(new URL("./support/adversarial-mcp.mjs", import.meta.url)),
      x.root,
    ];
    x.kernel.mcp.install({
      id: "replace",
      name: "old",
      transport: "stdio",
      command: process.execPath,
      args,
      enabled: true,
    });
    await x.kernel.mcp.connect("replace");
    const old = (await x.kernel.mcp.tools())[0];
    await x.kernel.mcp.disconnect("replace");
    x.kernel.mcp.install({
      id: "replace",
      name: "replacement",
      transport: "stdio",
      command: process.execPath,
      args,
      enabled: true,
    });
    await x.kernel.mcp.connect("replace");
    await assert.rejects(
      old.execute("old-call", {}),
      /revoked|changed|replaced|disconnected/i,
    );
    await assert.rejects(readFile(path.join(x.root, "effect.txt")), /ENOENT/);
  } finally {
    await x.close();
  }
});
