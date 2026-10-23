import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.js";
import { setup, collect } from "./support/wire-server.js";

test("legacy transcripts migrate losslessly into append-only paged messages and rollback atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-migration-")),
    file = path.join(root, "foundation.sqlite");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE transcripts(session_id TEXT PRIMARY KEY,body TEXT NOT NULL)",
  );
  const original: import("../src/contracts.js").StoredMessage = {
    id: "m_old",
    runId: "run_old",
    message: { role: "user", content: "original history", timestamp: 1 },
  };
  old
    .prepare("INSERT INTO transcripts VALUES(?,?)")
    .run("session_old", JSON.stringify([original]));
  old.close();
  const store = new Store(root);
  try {
    assert.deepEqual(store.transcript("session_old"), [original]);
    for (let i = 0; i < 6; i++)
      store.appendTranscript("session_old", {
        id: "m_" + i,
        runId: "run_new",
        message: { role: "user", content: String(i), timestamp: i },
      });
    const first = store.transcriptPage("session_old", 0, 3),
      second = store.transcriptPage("session_old", first.cursor, 3);
    assert.equal(first.hasMore, true);
    assert.equal(second.messages.length, 3);
    assert.ok(second.cursor > first.cursor);
    assert.equal(store.transcript("session_old").length, 7);
    assert.throws(
      () =>
        store.appendTranscript("session_old", {
          ...original,
          message: { ...original.message, content: "changed" } as any,
        }),
      /reused/,
    );
    assert.throws(
      () =>
        store.transaction(() => {
          store.appendTranscript("session_old", {
            ...original,
            id: "rollback",
          });
          throw Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(store.transcript("session_old").length, 7);
    assert.equal(
      JSON.parse(
        (store.db.prepare("SELECT body FROM transcripts").get() as any).body,
      )[0].message.content,
      "original history",
    );
  } finally {
    store.close();
  }
});
test("memory namespaces filter before ranking limits, revisions detect conflicts, and imports/merge/prune are transactional", async () => {
  const x = await setup();
  try {
    for (let i = 0; i < 120; i++)
      x.kernel.memory.put({
        id: "other_" + i,
        projectId: x.project.id,
        namespace: "other",
        content: "common fact " + i,
      });
    const one = x.kernel.memory.put({
      projectId: x.project.id,
      namespace: "target",
      content: "common fact selected",
    });
    assert.equal(
      x.kernel.memory.search(x.project.id, "common", 5, "target")[0].id,
      one.id,
    );
    const two = x.kernel.memory.put({
      id: one.id,
      projectId: x.project.id,
      namespace: "target",
      content: "updated fact",
      expectedRevision: 1,
    });
    assert.equal(two.revision, 2);
    assert.throws(
      () =>
        x.kernel.memory.put({
          id: one.id,
          projectId: x.project.id,
          content: "stale",
          expectedRevision: 1,
        }),
      /revision conflict/,
    );
    assert.equal(x.kernel.memory.history(one.id, x.project.id).length, 2);
    const another = x.kernel.memory.put({
      projectId: x.project.id,
      namespace: "target",
      content: "second durable fact",
    });
    const merged = x.kernel.memory.merge(
      x.project.id,
      [one.id, another.id],
      "merged durable facts",
    );
    assert.equal(x.kernel.memory.list(x.project.id, "target").length, 1);
    assert.equal(x.kernel.memory.list(x.project.id, "target")[0].id, merged.id);
    assert.throws(
      () =>
        x.kernel.memory.import(x.project.id, [
          { content: "must rollback", namespace: "new" },
          { content: "" },
        ]),
      /./,
    );
    assert.equal(x.kernel.memory.list(x.project.id, "new").length, 0);
    x.kernel.memory.put({
      projectId: x.project.id,
      namespace: "expired",
      content: "expired fact",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(x.kernel.memory.pruneExpired(x.project.id).removed, 1);
    assert.equal(
      x.kernel.memory.search(x.project.id, "expired", 5, "expired").length,
      0,
    );
  } finally {
    await x.close();
  }
});
test("automatic memory extraction creates reviewable proposals and never silently persists a fact", async () => {
  const x = await setup(
    (body) => ({
      text: JSON.stringify(body.messages[0]).includes("Extract only explicit")
        ? JSON.stringify({
            memories: [
              {
                content: "User explicitly prefers Chinese",
                tags: ["language"],
                explicit: true,
              },
            ],
          })
        : "Task complete",
    }),
    { memory: { enabled: true, autoExtract: true } },
  );
  try {
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, {
        text: "Remember my language preference",
      });
    const events = await collect(x.client, runId);
    assert.equal(x.kernel.memory.list(x.project.id).length, 0);
    const proposal = x.kernel.memory.proposals(x.project.id)[0];
    assert.equal(proposal.status, "pending");
    assert.ok(events.some((e) => e.type === "memory.proposed"));
    await x.client.request(
      "POST",
      `/v1/memory-proposals/${proposal.id}/resolve`,
      { allow: true },
    );
    assert.equal(x.kernel.memory.list(x.project.id).length, 1);
    await assert.rejects(
      x.client.request("POST", `/v1/memory-proposals/${proposal.id}/resolve`, {
        allow: true,
      }),
      /409/,
    );
  } finally {
    await x.close();
  }
});
test("Skill bundles preserve text and binary resources, directory snapshots and safe paths without executing scripts", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            {
              name: "skill_resource_read",
              args: { skillId: "bundle", path: "references/policy.txt" },
            },
          ],
        }
      : { text: "done" },
  );
  try {
    const source =
      "---\nname: bundle\ndescription: Actual resource bundle\nversion: 2.0.0\n---\nUse the bundled reference.";
    const installed = await x.client.request("POST", "/v1/skills", {
      source,
      resources: {
        "references/policy.txt": "actual bundled evidence",
        "assets/data.bin": {
          encoding: "base64",
          data: Buffer.from([0, 1, 2]).toString("base64"),
        },
        "scripts/check.py":
          'raise RuntimeError("must not execute automatically")',
      },
    });
    assert.equal(installed.resources!.length, 3);
    assert.equal(
      x.kernel.skills.resource("bundle", "assets/data.bin").data,
      "AAEC",
    );
    await assert.rejects(
      x.client.request("POST", "/v1/skills", {
        source,
        resources: { "../escape": "bad" },
      }),
      /400/,
    );
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, {
        text: "read the resource",
        skillIds: ["bundle"],
      });
    const events = await collect(x.client, runId);
    assert.match(
      JSON.stringify(
        events.find((e) => e.type === "tool.settled")?.data.result,
      ),
      /actual bundled evidence/,
    );
    const directory = path.join(
      x.config.extensions.allowedRoots[0],
      "dir-skill",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      source.replace("name: bundle", "name: from_dir"),
    );
    await writeFile(
      path.join(directory, "reference.txt"),
      "installed snapshot",
    );
    await x.client.request("POST", "/v1/skills", { directory });
    await writeFile(
      path.join(directory, "reference.txt"),
      "changed source folder",
    );
    assert.equal(
      x.kernel.skills.resource("from_dir", "reference.txt").data,
      "installed snapshot",
    );
    const exported = x.kernel.skills.export("from_dir");
    assert.match(exported.source, /from_dir/);
    assert.equal(
      exported.resources["reference.txt"].data,
      "installed snapshot",
    );
  } finally {
    await x.close();
  }
});
test("route CRUD changes defaults atomically and persists them, while invalid or referenced deletion is rejected", async () => {
  const x = await setup();
  try {
    await x.client.request("PUT", "/v1/routes/second", {
      kind: "text",
      adapter: "openai-responses",
      model: "actual-custom-id",
      baseUrl: x.wire.url + "/v1",
    });
    await x.client.request("PATCH", "/v1/routes", {
      defaultRoutes: { chat: "second" },
    });
    const s = await x.client.session(x.project.id, "chat");
    assert.equal(s.routeId, "second");
    await assert.rejects(
      x.client.request("DELETE", "/v1/routes/second"),
      /409/,
    );
    const before = await readFile(
      path.join(x.config.dataDir, "runtime-routes.json"),
      "utf8",
    );
    await assert.rejects(
      x.client.request("PATCH", "/v1/routes", {
        defaultRoutes: { chat: "missing" },
      }),
      /400/,
    );
    assert.equal(
      await readFile(
        path.join(x.config.dataDir, "runtime-routes.json"),
        "utf8",
      ),
      before,
    );
    assert.equal(x.config.defaultRoutes.chat, "second");
    await x.client.request("PATCH", `/v1/sessions/${s.id}`, { archived: true });
    await x.client.request("PATCH", "/v1/routes", {
      remove: ["second"],
      defaultRoutes: { chat: "text" },
    });
    assert.equal(x.config.routes.second, undefined);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(x.config.dataDir, "runtime-routes.json"),
          "utf8",
        ),
      ).defaultRoutes.chat,
      "text",
    );
  } finally {
    await x.close();
  }
});
