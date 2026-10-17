import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, collect } from "./support/wire-server.js";
import { MCPClient } from "../src/extensions/mcp-client.js";

test("single-user kernel serves authenticated clients without account login or constructing an MCP OAuth service", async () => {
  const x = await setup();
  try {
    assert.equal(x.kernel.mcp.oauth, undefined);
    const unauthenticated = await fetch(x.api.url + "/v1/projects");
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.body?.cancel();
    const caps: any = await x.client.request("GET", "/v1/capabilities");
    assert.equal(caps.deployment.mode, "single-user");
    assert.equal(caps.deployment.accounts, false);
    assert.equal(caps.deployment.multiTenant, false);
    assert.equal(caps.extensions.mcpOAuthConfigured, false);
    assert.equal(caps.executionSupport.dockerOptional, true);
    for (const mode of ["chat", "code", "office"] as const)
      assert.equal((await x.session(mode)).mode, mode);
    const fixture = fileURLToPath(
      new URL("./support/adversarial-mcp.mjs", import.meta.url),
    );
    x.kernel.mcp.install({
      id: "plain",
      name: "plain",
      transport: "stdio",
      command: process.execPath,
      args: [fixture, x.project.root],
    });
    await x.kernel.mcp.connect("plain");
    assert.equal((await x.kernel.mcp.catalog("plain")).length, 1);
    for (const operation of [
      () => x.kernel.mcp.authStatus("plain"),
      () => x.kernel.mcp.authBegin("plain"),
      () => x.kernel.mcp.deviceBegin("plain"),
      () => x.kernel.mcp.registrationStatus("plain"),
      () => x.kernel.mcp.keyStatus("plain"),
    ])
      assert.throws(operation, /OAuth is not configured/);
    assert.equal(x.kernel.mcp.oauth, undefined);
    await assert.rejects(
      access(path.join(x.config.dataDir, "mcp-oauth")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});

test("MCP close exposes an unconfirmed execution cleanup instead of silently reporting success", async () => {
  const x = await setup();
  const fixture = fileURLToPath(
    new URL("./support/adversarial-mcp.mjs", import.meta.url),
  );
  const client = new MCPClient({
    transport: "stdio",
    protocol: "legacy",
    command: process.execPath,
    args: [fixture, x.project.root],
    cleanup: async () => {
      throw new Error("cleanup evidence unavailable");
    },
  });
  try {
    await client.connect();
    assert.equal((await client.listTools({})).tools.length, 1);
    await assert.rejects(
      client.close(),
      /cleanup unconfirmed.*cleanup evidence unavailable/,
    );
    await assert.rejects(client.close(), /cleanup unconfirmed/);
    assert.equal(client.connected, false);
  } finally {
    await client.close().catch(() => undefined);
    await x.close();
  }
});

test("route network denial blocks one-shot, persistent and Git commands before an internet-enabled execution backend starts", async () => {
  const script =
    "require('node:fs').writeFileSync('permission-escaped.txt','bad')";
  const x = await setup(
    (_body, index) =>
      index === 0
        ? {
            calls: [
              {
                name: "exec_run",
                args: { command: process.execPath, args: ["-e", script] },
              },
              {
                name: "exec_start",
                args: { command: process.execPath, args: ["-e", script] },
              },
              { name: "git_inspect", args: { action: "status" } },
            ],
          }
        : { text: "denials recorded" },
    {
      execution: {
        boundary: "windows-appcontainer",
        requireIsolation: true,
        windowsSandbox: { network: "internet" },
      },
    },
  );
  try {
    x.config.routes.text.capabilityPolicies.network = "deny";
    const session = await x.session("code");
    const { runId } = await x.client.submit(session.id, {
      text: "exercise all configured command entry points",
    });
    const events = await collect(x.client, runId),
      settled = events.filter((event) => event.type === "tool.settled");
    assert.equal(settled.length, 3);
    for (const event of settled) {
      const data: any = event.data;
      assert.equal(data.isError, true);
      assert.match(JSON.stringify(data.result), /denied/i);
    }
    await assert.rejects(
      access(path.join(x.project.root, "permission-escaped.txt")),
      /ENOENT/,
    );
    await assert.rejects(
      access(path.join(x.config.dataDir, "sandboxes")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
