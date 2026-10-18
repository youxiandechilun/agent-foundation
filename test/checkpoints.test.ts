import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { setup } from "./support/wire-server.js";
import { textOf } from "../src/runtime/types.js";

const userMessageId = (x: any, sessionId: string, text: string) =>
  x.kernel.store
    .transcript(sessionId)
    .find((m: any) => m.message.role === "user" && textOf(m.message) === text)
    .id;

test("rewind restores files and forks the conversation at a past input", async () => {
  const replies = [
    {
      calls: [
        { name: "file_write", args: { path: "a.txt", content: "v1" } },
        { name: "file_write", args: { path: "dir/new.txt", content: "n" } },
      ],
    },
    { text: "step one done" },
    {
      calls: [
        {
          name: "file_patch",
          args: { path: "a.txt", oldText: "v1", newText: "v2" },
        },
      ],
    },
    { text: "step two done" },
  ];
  const x = await setup((_b, i) => replies[i] || { text: "ok" });
  try {
    const root = x.config.workspaceRoots[0],
      read = (f: string) => readFile(path.join(root, f), "utf8");
    await writeFile(path.join(root, "a.txt"), "v0");
    const s = await x.session("code");
    for (const text of ["step1", "step2"]) {
      const r = await x.client.submit(s.id, { text });
      assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    }
    assert.equal(await read("a.txt"), "v2");
    const checkpoints = await x.client.request<any>(
      "GET",
      `/v1/sessions/${s.id}/checkpoints`,
    );
    assert.deepEqual(
      checkpoints.checkpoints.map((c: any) => [c.path, c.existed]),
      [
        ["a.txt", true],
        ["dir/new.txt", false],
        ["a.txt", true],
      ],
    );
    const before = x.kernel.store.transcript(s.id).length;
    const second = await x.client.request<any>(
      "POST",
      `/v1/sessions/${s.id}/rewind`,
      { beforeMessageId: userMessageId(x, s.id, "step2") },
    );
    assert.deepEqual(second.files.restored, ["a.txt"]);
    assert.deepEqual(second.files.conflicts, []);
    assert.equal(await read("a.txt"), "v1");
    assert.equal(await read("dir/new.txt"), "n");
    const forked = x.kernel.store.transcript(second.session.id);
    assert.equal(textOf(forked.at(-1)!.message), "step one done");
    assert.equal(
      x.kernel.store.transcript(s.id).length,
      before,
      "the original transcript is preserved",
    );
    const first = await x.client.request<any>(
      "POST",
      `/v1/sessions/${s.id}/rewind`,
      { beforeMessageId: userMessageId(x, s.id, "step1"), conversation: false },
    );
    assert.deepEqual(first.files.restored, ["a.txt"]);
    assert.deepEqual(first.files.deleted, ["dir/new.txt"]);
    assert.equal(first.session, undefined);
    assert.equal(await read("a.txt"), "v0");
    await assert.rejects(stat(path.join(root, "dir/new.txt")));
    const again = await x.client.request<any>(
      "POST",
      `/v1/sessions/${s.id}/rewind`,
      { beforeMessageId: userMessageId(x, s.id, "step1"), conversation: false },
    );
    assert.deepEqual(
      [again.files.restored, again.files.deleted, again.files.conflicts],
      [[], [], []],
      "reverted checkpoints are not applied twice",
    );
  } finally {
    await x.close();
  }
});

test("external changes are reported as conflicts and only overwritten with force", async () => {
  const x = await setup((_b, i) =>
    i === 0
      ? {
          calls: [
            { name: "file_write", args: { path: "c.txt", content: "agent" } },
          ],
        }
      : { text: "done" },
  );
  try {
    const root = x.config.workspaceRoots[0],
      file = path.join(root, "c.txt");
    await writeFile(file, "original");
    const s = await x.session("code");
    const r = await x.client.submit(s.id, { text: "edit" });
    await x.kernel.wait(r.runId);
    await writeFile(file, "edited by a person");
    const options = {
      beforeMessageId: userMessageId(x, s.id, "edit"),
      conversation: false,
    };
    const blocked = await x.kernel.rewind(s.id, options);
    assert.deepEqual(blocked.files!.conflicts, [
      { path: "c.txt", reason: "File changed after the agent's last write" },
    ]);
    assert.equal(await readFile(file, "utf8"), "edited by a person");
    const forced = await x.kernel.rewind(s.id, { ...options, force: true });
    assert.deepEqual(forced.files!.restored, ["c.txt"]);
    assert.equal(await readFile(file, "utf8"), "original");
    await assert.rejects(
      x.kernel.rewind(s.id, { conversation: false }),
      /exactly one of/,
    );
    await assert.rejects(
      x.kernel.rewind(s.id, { throughMessageId: "message_missing" }),
      /Message not found/,
    );
  } finally {
    await x.close();
  }
});
