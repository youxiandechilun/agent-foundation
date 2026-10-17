import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { setup, collect } from "./support/wire-server.js";
import { migrationDigest } from "../src/migration.js";
import { id } from "../src/util.js";
import { Kernel } from "../src/kernel.js";

test("portable migration moves actual binary assets and balanced tool evidence between independent hosts without replay", async () => {
  const source = await setup(),
    target = await setup();
  try {
    const s = await source.session("code");
    const bytes = Buffer.from([0, 1, 2, 128, 255, 10, 13]);
    const asset = await source.kernel.assets.create(
      source.project.id,
      "binary.bin",
      bytes,
    );
    const at = Date.now();
    source.kernel.store.saveTranscript(s.id, [
      {
        id: "message1",
        runId: "run1",
        message: {
          role: "user",
          content: `Attachment ${asset.id}`,
          timestamp: at,
        },
      },
      {
        id: "message2",
        runId: "run1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Inspecting bytes" },
            {
              type: "toolCall",
              id: "call1",
              name: "asset_read",
              arguments: { assetId: asset.id },
            },
          ],
          model: "old-model",
          provider: "old-provider",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
          },
          stopReason: "toolUse",
          timestamp: at,
          responseId: "private-continuation",
        },
      },
      {
        id: "message3",
        runId: "run1",
        message: {
          role: "toolResult",
          toolCallId: "call1",
          toolName: "asset_read",
          content: [{ type: "text", text: `/v1/assets/${asset.id}` }],
          details: { asset },
          isError: false,
          timestamp: at,
        },
      },
    ]);
    const bundle = await source.client.request(
      "GET",
      `/v1/sessions/${s.id}/migration`,
    );
    assert.equal(bundle.payload.assets.length, 1);
    assert.ok(!JSON.stringify(bundle).includes("private-continuation"));
    assert.ok(!JSON.stringify(bundle).includes(source.project.root));
    const result = await target.client.request(
      "POST",
      "/v1/migrations/import",
      { projectId: target.project.id, bundle, key: "first", routeId: "text" },
    );
    const imported = target.kernel.store.session(result.sessionId);
    assert.equal(imported.autonomy, "assist");
    assert.equal(imported.projectId, target.project.id);
    assert.equal(target.kernel.store.list("effects").length, 0);
    assert.equal(target.wire.requests.length, 0);
    const movedId = result.assetMap[asset.id];
    assert.notEqual(movedId, asset.id);
    assert.deepEqual(
      await target.kernel.assets.read(movedId, target.project.id),
      bytes,
    );
    const history = target.kernel.store.transcript(imported.id);
    assert.equal(
      (history[2].message as any).details.asset.projectId,
      target.project.id,
    );
    assert.ok(JSON.stringify(history).includes(movedId));
    assert.ok(!JSON.stringify(history).includes(asset.id));
    assert.equal(
      (history[2].message as any).toolCallId,
      (history[1].message as any).content[1].id,
    );
    assert.notEqual(history[0].runId, "run1");
    await collect(
      target.client,
      (await target.client.submit(imported.id, { text: "continue" })).runId,
    );
    assert.equal(target.kernel.store.list("effects").length, 0);
    assert.deepEqual(
      await target.kernel.assets.read(movedId, target.project.id),
      bytes,
    );
    const again = await target.client.request("POST", "/v1/migrations/import", {
      projectId: target.project.id,
      bundle,
      key: "first",
      routeId: "text",
    });
    assert.equal(again.sessionId, imported.id);
    assert.equal(again.reused, true);
    const changed = structuredClone(bundle);
    changed.payload.createdAt = new Date(0).toISOString();
    changed.sha256 = migrationDigest(changed.payload);
    await assert.rejects(
      target.client.request("POST", "/v1/migrations/import", {
        projectId: target.project.id,
        bundle: changed,
        key: "first",
      }),
      /different package/,
    );
  } finally {
    await source.close();
    await target.close();
  }
});

test("migration rejects corruption, missing dependencies, extra assets and traversal before writing any destination state", async () => {
  const a = await setup(),
    b = await setup();
  try {
    const s = await a.session();
    const asset = await a.kernel.assets.create(
      a.project.id,
      "a.txt",
      Buffer.from("contents"),
    );
    a.kernel.store.saveTranscript(s.id, [
      {
        id: "m",
        runId: "r",
        message: { role: "user", content: asset.id, timestamp: 0 },
      },
    ]);
    const original = await a.kernel.exportMigration(s.id);
    const mutations: ((v: any) => void)[] = [
      (v) => (v.sha256 = "0".repeat(64)),
      (v) =>
        (v.payload.assets[0].data = Buffer.from("tampered").toString("base64")),
      (v) => (v.payload.assets = []),
      (v) => v.payload.assets.push({ ...v.payload.assets[0], id: id("asset") }),
      (v) => (v.payload.assets[0].name = "../escape"),
      (v) => (v.payload.assets[0].name = "C:\\escape.txt"),
      (v) => (v.payload.assets[0].data += "\n"),
      (v) => (v.payload.snapshot.messages[0].message.role = "system"),
    ];
    for (const [index, change] of mutations.entries()) {
      const v = structuredClone(original);
      change(v);
      if (index) v.sha256 = migrationDigest(v.payload);
      assert.throws(() =>
        b.kernel.importMigration(b.project.id, v, "bad" + index),
      );
      assert.equal(b.kernel.store.list("sessions").length, 0);
      assert.equal(b.kernel.store.list("assets").length, 0);
    }
    assert.deepEqual(
      await readdir(path.join(b.config.dataDir, "migration-staging")),
      [],
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("migration rolls back promoted files and metadata if destination route validation fails", async () => {
  const a = await setup(),
    b = await setup();
  try {
    const s = await a.session(),
      asset = await a.kernel.assets.create(
        a.project.id,
        "x.txt",
        Buffer.from("actual bytes"),
      );
    a.kernel.store.saveTranscript(s.id, [
      {
        id: "m",
        runId: "r",
        message: { role: "user", content: asset.id, timestamp: 0 },
      },
    ]);
    const v = await a.kernel.exportMigration(s.id);
    assert.throws(() =>
      b.kernel.importMigration(
        b.project.id,
        v,
        "route-failure",
        "not-configured",
      ),
    );
    assert.equal(b.kernel.store.list("sessions").length, 0);
    assert.deepEqual(await readdir(b.kernel.assets.root), []);
    const oldSave = b.kernel.store.saveTranscript;
    b.kernel.store.saveTranscript = () => {
      throw new Error("injected commit failure");
    };
    assert.throws(
      () => b.kernel.importMigration(b.project.id, v, "db-failure"),
      /injected/,
    );
    b.kernel.store.saveTranscript = oldSave;
    assert.equal(b.kernel.store.list("assets").length, 0);
    assert.equal(b.kernel.store.list("sessions").length, 0);
    assert.deepEqual(await readdir(b.kernel.assets.root), []);
  } finally {
    await a.close();
    await b.close();
  }
});

test("migration recovery deletes only orphan promotions and preserves committed assets", async () => {
  const x = await setup();
  try {
    const committed = await x.kernel.assets.create(
        x.project.id,
        "keep.txt",
        Buffer.from("keep"),
      ),
      orphan = id("asset");
    await writeFile(x.kernel.assets.file(orphan), "orphan");
    const stage = path.join(
      x.config.dataDir,
      "migration-staging",
      id("migration"),
    );
    await mkdir(stage);
    await writeFile(
      path.join(stage, "journal.json"),
      JSON.stringify({ ids: [committed.id, orphan] }),
    );
    x.kernel.migrations.recover();
    assert.equal(
      (await x.kernel.assets.read(committed.id, x.project.id)).toString(),
      "keep",
    );
    await assert.rejects(readFile(x.kernel.assets.file(orphan)), /ENOENT/);
    assert.deepEqual(await readdir(path.dirname(stage)), []);
  } finally {
    await x.close();
  }
});

test("migration enforces total bytes and refuses foreign-project asset references", async () => {
  const x = await setup(undefined, { limits: { maxMigrationBytes: 1024 } });
  try {
    const s = await x.session(),
      foreign = await x.kernel.createProject("foreign"),
      asset = await x.kernel.assets.create(
        foreign.id,
        "f.txt",
        Buffer.from("f"),
      );
    x.kernel.store.saveTranscript(s.id, [
      {
        id: "m",
        runId: "r",
        message: { role: "user", content: asset.id, timestamp: 0 },
      },
    ]);
    await assert.rejects(x.kernel.exportMigration(s.id), /another project/);
    const large = await x.kernel.assets.create(
      x.project.id,
      "large.bin",
      Buffer.alloc(1025),
    );
    x.kernel.store.saveTranscript(s.id, [
      {
        id: "m",
        runId: "r",
        message: { role: "user", content: large.id, timestamp: 0 },
      },
    ]);
    await assert.rejects(x.kernel.exportMigration(s.id), /budget/);
  } finally {
    await x.close();
  }
});

test("migration startup recovery works after reopening the actual database and preserves committed data", async () => {
  const x = await setup();
  let reopened: Kernel | undefined;
  try {
    const asset = await x.kernel.assets.create(
        x.project.id,
        "keep.bin",
        Buffer.from("keep"),
      ),
      orphan = id("asset");
    const stage = path.join(
      x.config.dataDir,
      "migration-staging",
      id("migration"),
    );
    await mkdir(stage);
    await writeFile(
      path.join(stage, "journal.json"),
      JSON.stringify({ ids: [asset.id, orphan] }),
    );
    await writeFile(x.kernel.assets.file(orphan), "uncommitted");
    await x.api.close();
    reopened = new Kernel(x.config);
    await reopened.init();
    assert.deepEqual(
      await reopened.assets.read(asset.id, x.project.id),
      Buffer.from("keep"),
    );
    await assert.rejects(readFile(reopened.assets.file(orphan)), /ENOENT/);
    assert.deepEqual(await readdir(path.dirname(stage)), []);
  } finally {
    await reopened?.close();
    await x.close();
  }
});

test("portable migration supports histories larger than the legacy 8 MiB snapshot while respecting the configured total budget", async () => {
  const a = await setup(),
    b = await setup();
  try {
    const s = await a.session(),
      data = Buffer.alloc(6 * 1024 * 1024 + 3, 17).toString("base64");
    a.kernel.store.saveTranscript(s.id, [
      {
        id: "large",
        runId: "run",
        message: {
          role: "user",
          timestamp: 0,
          content: [{ type: "image", mimeType: "image/png", data }],
        },
      },
    ]);
    const bundle = await a.kernel.exportMigration(s.id),
      receipt = b.kernel.importMigration(b.project.id, bundle, "large");
    const value = (
      b.kernel.store.transcript(receipt.sessionId)[0].message as any
    ).content[0].data;
    assert.equal(value, data);
    assert.throws(
      () =>
        b.kernel.importMigration(
          b.project.id,
          bundle,
          "large",
          "different-route",
        ),
      /different destination route/,
    );
  } finally {
    await a.close();
    await b.close();
  }
});
