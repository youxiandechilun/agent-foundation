import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Kernel } from "../src/core/kernel.js";
import { setup } from "./support/wire-server.js";
import { collect } from "./support/wire-server.js";
import { nativeProcess } from "../src/execution/process.js";

test("settlement hooks cannot keep a completed run or its session alive forever", async () => {
  const x = await setup(
    undefined,
    { extensions: { timeoutMs: 100 } },
    {
      integrations: [
        { id: "hang-settlement", settled: () => new Promise(() => {}) },
      ],
    },
  );
  try {
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "complete" });
    const events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.ok(events.some((e) => e.type === "integration.settlement.failed"));
    x.kernel.updateSession(s.id, { name: "available" });
  } finally {
    await x.close();
  }
});

test("failed kernel initialization releases the single-writer lease", async () => {
  const x = await setup();
  try {
    await x.kernel.close();
    const broken = new Kernel(x.config, {
      integrations: [
        {
          id: "init-failure",
          install() {
            throw Error("init failed");
          },
        },
      ],
    });
    await assert.rejects(broken.init(), /init failed/);
    const next = new Kernel(x.config);
    await next.init();
    await next.close();
  } finally {
    await x.close();
  }
});

test("actual command stdout preserves UTF-8 characters split between process writes", async () => {
  const x = await setup();
  try {
    const text = "中文输出",
      bytes = Buffer.from(text);
    const result = await nativeProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(Buffer.from(${JSON.stringify([...bytes.subarray(0, 1)])}));setTimeout(()=>process.stdout.write(Buffer.from(${JSON.stringify([...bytes.subarray(1)])})),40)`,
      ],
      cwd: x.project.root,
      timeoutMs: 3000,
    });
    assert.equal(result.stdout, text);
  } finally {
    await x.close();
  }
});

test("reinstalling reviewed plugin source repairs added files without retaining old trust", async () => {
  const x = await setup();
  try {
    const manifest = {
      schemaVersion: 1,
      id: "repair",
      name: "repair",
      version: "1.0.0",
      entry: "index.mjs",
    };
    const files = {
      "index.mjs": "export async function execute(){return {content:[]}}",
    };
    const installed = await x.kernel.plugins.install(manifest, files);
    x.kernel.plugins.enable(installed.id, true, installed.hash);
    const previous = x.kernel.store.get<any>("plugins", installed.id);
    await writeFile(
      path.join(previous.directory, "unreviewed.mjs"),
      "export const changed=true;",
    );
    await assert.rejects(x.kernel.plugins.verify(installed.id), /integrity/);
    const repaired = await x.kernel.plugins.install(manifest, files);
    assert.equal(repaired.hash, installed.hash);
    assert.equal(repaired.enabled, false);
    assert.notEqual(
      x.kernel.store.get<any>("plugins", installed.id).directory,
      previous.directory,
    );
    assert.equal((await x.kernel.plugins.verify(installed.id)).verified, true);
    assert.deepEqual(
      (await x.client.request("GET", "/v1/plugins/repair/export")).files,
      files,
    );
  } finally {
    await x.close();
  }
});

test("media plugins declare actual capabilities and adapter IDs cannot silently bind another plugin", async () => {
  const x = await setup();
  try {
    const manifest = {
      schemaVersion: 1,
      id: "first_media",
      name: "media",
      version: "1.0.0",
      entry: "index.mjs",
      mediaAdapters: ["image_only"],
    };
    const files = {
      "index.mjs":
        "export const mediaAdapters={image_only:{submit(){throw Error('not invoked by this test')}}};",
    };
    await assert.rejects(
      x.kernel.plugins.install(manifest, files),
      /mediaCapabilities/,
    );
    const full = {
      ...manifest,
      mediaCapabilities: {
        image_only: {
          kinds: ["image"],
          operations: ["generate"],
          polling: false,
          cancellation: false,
          recovery: false,
        },
      },
    };
    const installed = await x.kernel.plugins.install(full, files);
    x.kernel.plugins.enable(installed.id, true, installed.hash);
    const definition = x.kernel.plugins.mediaDefinition("image_only");
    assert.equal(definition.cancellation, false);
    assert.equal(definition.recovery, false);
    assert.throws(
      () =>
        x.kernel.media.adapters.register({
          id: "missing-method",
          capabilities: {
            kinds: ["image"],
            operations: ["generate"],
            cancellation: true,
            recovery: false,
          },
          submit: async () => ({ status: "failed" }),
        }),
      /declared methods/,
    );
    await assert.rejects(
      x.kernel.plugins.install({ ...full, id: "second_media" }, files),
      /already belongs/,
    );
  } finally {
    await x.close();
  }
});

test("route deletion respects reusable mode and agent references", async () => {
  const x = await setup();
  try {
    await x.client.request("PUT", "/v1/routes/profile_route", {
      kind: "text",
      adapter: "openai-responses",
      model: "custom",
      baseUrl: x.wire.url,
    });
    await x.client.request("POST", "/v1/modes", {
      id: "profile_mode",
      description: "mode",
      instructions: "Read actual evidence",
      defaultRouteId: "profile_route",
    });
    await assert.rejects(
      x.client.request("DELETE", "/v1/routes/profile_route"),
      /409/,
    );
    await x.client.request("DELETE", "/v1/modes/profile_mode");
    x.kernel.agents.put({
      id: "profile_agent",
      name: "profile",
      instructions: "Read actual evidence",
      mode: "chat",
      routeId: "profile_route",
    });
    await assert.rejects(
      x.client.request("DELETE", "/v1/routes/profile_route"),
      /409/,
    );
    x.kernel.agents.remove("profile_agent");
    await x.client.request("DELETE", "/v1/routes/profile_route");
  } finally {
    await x.close();
  }
});

test("a failing integration cleanup cannot leave the store lease or other resources open", async () => {
  const x = await setup(
    undefined,
    {},
    {
      integrations: [
        {
          id: "cleanup-error",
          close() {
            throw Error("integration failed");
          },
        },
      ],
    },
  );
  try {
    await assert.rejects(x.api.close(), /cleanup/);
    const reopened = new Kernel(x.config);
    await reopened.close();
  } finally {
    await x.api.close().catch(() => undefined);
    await x.wire.close();
  }
});
