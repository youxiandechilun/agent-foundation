import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSchema } from "../src/runtime/json-schema.js";
import { sessionTools } from "../src/sessions/tools.js";
import { serverTools } from "../src/servers/tools.js";
import { ServerManager } from "../src/servers/manager.js";
import { processTools } from "../src/execution/tools.js";
import type { ToolDefinition } from "../src/runtime/types.js";
import { setup } from "./support/wire-server.js";

test("tool input contracts retain service validation, grants, cancellation and resource locks", async () => {
  const x = await setup();
  const manager = new ServerManager(x.kernel.store, x.config.dataDir);
  try {
    const session = await x.session("code");
    const context = {
      kernel: x.kernel,
      session,
      runId: "contract",
      routeId: session.routeId,
    };
    const sessions = sessionTools(context),
      servers = serverTools(context, manager);
    const find = (tools: ToolDefinition<unknown>[], name: string) => {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool);
      return tool;
    };
    const read = find(sessions, "session_read"),
      validate = compileSchema(read.parameters);
    assert.equal(validate({ sessionId: session.id }), true);
    for (const input of [
      { sessionId: "" },
      { sessionId: session.id, limit: 31 },
      { sessionId: session.id, after: -1 },
      { sessionId: session.id, unknown: true },
    ]) {
      assert.equal(validate(input), false);
      await assert.rejects(read.execute("invalid", input));
    }
    const foreign = x.kernel.createSession(x.project.id);
    await assert.rejects(
      read.execute("grant", { sessionId: foreign.id }),
      /reading grants/,
    );
    const cancelled = AbortSignal.abort(new Error("cancel-before-read"));
    await assert.rejects(
      read.execute("cancel", { sessionId: session.id }, cancelled),
      /cancel-before-read/,
    );
    const serverId = "server_11111111-1111-1111-1111-111111111111";
    const exec = find(servers, "server_exec"),
      execSchema = compileSchema(exec.parameters);
    assert.equal(execSchema({ serverId, command: "pwd" }), true);
    assert.equal(
      execSchema({ serverId, command: "pwd", timeoutMs: 99 }),
      false,
    );
    assert.equal(execSchema({ serverId, command: "pwd", extra: true }), false);
    await assert.rejects(exec.execute("nul", { serverId, command: "pwd\0" }));
    const download = find(servers, "server_download");
    assert.equal(
      compileSchema(download.parameters)({ serverId, remotePath: "/file" }),
      true,
    );
    await assert.rejects(
      download.execute("path", { serverId, remotePath: "../file" }),
      /remote path/,
    );
    assert.deepEqual(exec.scheduling?.resources?.({ serverId }), [
      { key: `server:${serverId}`, access: "write" },
    ]);
    assert.deepEqual(find(servers, "server_list").scheduling?.resources?.({}), [
      { key: `servers:${x.project.id}`, access: "read" },
    ]);
    const processes = processTools(context);
    assert.deepEqual(
      find(processes, "exec_read").scheduling?.resources?.({
        processId: "active",
      }),
      [{ key: "process:active", access: "read" }],
    );
    assert.deepEqual(find(processes, "exec_list").scheduling?.resources?.({}), [
      { key: `process:${session.id}`, access: "read" },
    ]);
  } finally {
    await manager.close();
    await x.close();
  }
});

test("branch HTTP traversal finds unordered descendants and bounds cycles within the current project", async () => {
  const x = await setup();
  try {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      x.kernel.createSession(x.project.id, "chat", `branch-${index}`),
    );
    const link = (child: number, parent: number) =>
      x.kernel.store.put("sessions", {
        ...sessions[child],
        forkedFromSessionId: sessions[parent].id,
      });
    link(0, 1);
    link(1, 2);
    link(3, 2);
    link(4, 3);
    link(5, 6);
    link(6, 5);
    const otherProject = await x.kernel.createProject("foreign");
    const foreign = x.kernel.createSession(otherProject.id);
    x.kernel.store.put("sessions", {
      ...foreign,
      forkedFromSessionId: sessions[2].id,
    });
    for (const index of [0, 2, 4]) {
      const result = await x.client.sessionBranches(sessions[index].id);
      assert.deepEqual(
        new Set(result.branches.map((entry) => entry.id)),
        new Set(sessions.slice(0, 5).map((entry) => entry.id)),
      );
    }
    const cyclic = await x.client.sessionBranches(sessions[5].id);
    assert.deepEqual(
      new Set(cyclic.branches.map((entry) => entry.id)),
      new Set(sessions.slice(5).map((entry) => entry.id)),
    );
  } finally {
    await x.close();
  }
});
