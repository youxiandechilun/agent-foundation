import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Kernel } from "../src/core/kernel.js";
import { setup, collect, until } from "./support/wire-server.js";

test("custom mode persists across restart, restricts advertised tools, and cannot elevate a denied capability", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            {
              name: "file_write",
              args: { path: "mode-blocked.txt", content: "must not write" },
            },
          ],
        }
      : { text: "blocked by the mode" },
  );
  try {
    await x.client.request("POST", "/v1/modes", {
      id: "review",
      description: "Review source",
      instructions: "Inspect only",
      toolAllowlist: ["file_write"],
      capabilityPolicies: { "files.write": "deny" },
    });
    const s = await x.client.session(x.project.id, "review");
    x.kernel.updateSession(s.id, { autonomy: "autonomous" });
    const { runId } = await x.client.submit(s.id, { text: "attempt a write" });
    const events = await collect(x.client, runId);
    assert.deepEqual(
      x.wire.requests[0].body.tools.map((t: any) => t.function.name),
      ["file_write"],
    );
    assert.ok(events.some((e) => e.type === "tool.settled" && e.data.isError));
    assert.equal(events.filter((e) => e.type === "tool.started").length, 0);
    await assert.rejects(
      readFile(path.join(x.project.root, "mode-blocked.txt")),
      /ENOENT/,
    );
    await assert.rejects(x.client.request("DELETE", "/v1/modes/review"), /409/);
    await assert.rejects(
      x.client.request("POST", "/v1/modes", {
        id: "chat",
        description: "replace builtin",
        instructions: "override",
      }),
      /400/,
    );
    await x.kernel.close();
    const restarted = new Kernel(x.config);
    try {
      await restarted.init();
      assert.equal(
        restarted.modes.get("review").capabilityPolicies?.["files.write"],
        "deny",
      );
      assert.equal(restarted.store.session(s.id).mode, "review");
    } finally {
      await restarted.close();
    }
  } finally {
    await x.close();
  }
});

test("configured credential refs with ordinary environment names are redacted before inbox, model input and events", async () => {
  const x = await setup();
  const secret = "scoped-credential-with-an-ordinary-env-name-20261016";
  process.env.FOUNDATION_VENDOR_LOCATION = secret;
  try {
    x.config.routes.text.apiKeyEnv = "FOUNDATION_VENDOR_LOCATION";
    const s = await x.session();
    const { runId } = await x.client.submit(s.id, {
      text: "Quoted value: " + secret,
    });
    const events = await collect(x.client, runId);
    assert.equal(x.wire.requests[0].headers.authorization, "Bearer " + secret);
    assert.ok(!JSON.stringify(x.wire.requests[0].body).includes(secret));
    assert.ok(!JSON.stringify(x.kernel.store.list("inbox")).includes(secret));
    assert.ok(
      !JSON.stringify(x.kernel.store.transcript(s.id)).includes(secret),
    );
    assert.ok(!JSON.stringify(events).includes(secret));
  } finally {
    delete process.env.FOUNDATION_VENDOR_LOCATION;
    await x.close();
  }
});

test("aggregate attachment byte and excerpt budgets are enforced while original bytes remain available", async () => {
  const x = await setup();
  try {
    x.config.limits.maxInputAssetBytes = 300;
    x.config.limits.maxAttachmentText = 100;
    const a = await x.kernel.assets.create(
      x.project.id,
      "one.txt",
      Buffer.from("A".repeat(200)),
    );
    const b = await x.kernel.assets.create(
      x.project.id,
      "two.txt",
      Buffer.from("B".repeat(200)),
    );
    const s = await x.session();
    await assert.rejects(
      x.client.submit(s.id, { assetIds: [a.id, b.id] }),
      /413/,
    );
    assert.equal(x.wire.requests.length, 0);
    x.config.limits.maxInputAssetBytes = 1000;
    const { runId } = await x.client.submit(s.id, {
      text: "inspect both",
      assetIds: [a.id, b.id],
    });
    await collect(x.client, runId);
    const content = JSON.stringify(x.wire.requests[0].body.messages.at(-1));
    assert.ok(content.includes(a.id) && content.includes(b.id));
    assert.ok(
      !content.includes("A".repeat(200)) && !content.includes("B".repeat(200)),
    );
    assert.equal(
      (await x.kernel.assets.read(a.id, x.project.id)).toString(),
      "A".repeat(200),
    );
  } finally {
    await x.close();
  }
});

test(
  "MCP shutdown aborts in-flight initialization and same-turn connection races without waiting for request timeout",
  { timeout: 10000 },
  async () => {
    for (const waitForChild of [true, false]) {
      const x = await setup();
      try {
        x.kernel.mcp.install({
          id: "hang",
          name: "hang during initialize",
          transport: "stdio",
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("./support/adversarial-mcp.mjs", import.meta.url),
            ),
            x.root,
            "hang-init",
          ],
          enabled: true,
          timeoutMs: 30000,
        });
        const connection = x.kernel.mcp.connect("hang");
        const rejected = assert.rejects(connection);
        if (waitForChild)
          await until(() =>
            readFile(path.join(x.root, "init-hanging"), "utf8").catch(
              () => undefined,
            ),
          );
        const start = Date.now();
        await x.kernel.mcp.close();
        await rejected;
        assert.ok(Date.now() - start < 3000);
        assert.equal(x.kernel.mcp.list()[0].connected, false);
        await assert.rejects(x.kernel.mcp.connect("hang"), /closing/);
      } finally {
        await x.close();
      }
    }
  },
);

test("automatic memory extraction obeys plan mode and host memory-write denial", async () => {
  for (const plan of [true, false]) {
    const x = await setup(undefined, {
      memory: { enabled: true, autoExtract: true },
    });
    try {
      if (!plan) x.config.permissions["memory.write"] = "deny";
      const s = await x.session();
      if (plan) x.kernel.updateSession(s.id, { autonomy: "plan" });
      const { runId } = await x.client.submit(s.id, {
        text: "Remember an explicit preference",
      });
      await collect(x.client, runId);
      assert.equal(x.wire.requests.length, 1);
      assert.equal(x.kernel.memory.proposals(x.project.id).length, 0);
    } finally {
      await x.close();
    }
  }
});
