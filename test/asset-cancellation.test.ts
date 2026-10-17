import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { setup } from "./support/wire-server.js";
test("cancelled asset writes never publish metadata or leave a partial artifact", async () => {
  const x = await setup();
  try {
    const controller = new AbortController();
    const write = x.kernel.assets.create(
      x.project.id,
      "cancelled.bin",
      Buffer.alloc(5 * 1024 * 1024, 7),
      "artifact",
      undefined,
      controller.signal,
    );
    controller.abort(new Error("Cancel pending asset commit"));
    await assert.rejects(write, /Cancel|abort/i);
    assert.equal(x.kernel.store.list("assets").length, 0);
    assert.deepEqual(await readdir(x.kernel.assets.root), []);
    const a = await x.kernel.assets.create(
      x.project.id,
      "completed.bin",
      Buffer.from([1, 4, 9]),
      "artifact",
    );
    assert.deepEqual(
      await x.kernel.assets.read(a.id, x.project.id),
      Buffer.from([1, 4, 9]),
    );
  } finally {
    await x.close();
  }
});
