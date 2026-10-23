import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/store.js";

test("startup recovery frees orphaned device admission while preserving uncertain side effects", async () => {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "foundation-device-recovery-"));
  let store = new Store(root, { exclusiveKernel: true });
  try {
    for (const status of ["queued", "running", "completed"]) {
      store.put("node-tasks", {
        id: status,
        nodeId: "node",
        status,
        args: {},
        deadline: "2020-01-01T00:00:00.000Z",
      });
    }
    store.close();
    store = new Store(root, { exclusiveKernel: true });
    store.recover();
    assert.equal(
      store.get<{ status: string }>("node-tasks", "queued").status,
      "cancelled",
    );
    const running = store.get<{
      status: string;
      finishedAt: string;
      error: string;
    }>("node-tasks", "running");
    assert.equal(running.status, "unknown");
    assert.ok(running.finishedAt);
    assert.match(running.error, /inspect device/);
    assert.equal(
      store.get<{ status: string }>("node-tasks", "completed").status,
      "completed",
    );
    assert.equal(
      store.count("node-tasks", { status: ["queued", "running"] }),
      0,
    );
    store.recover();
    assert.deepEqual(store.get("node-tasks", "running"), running);
  } finally {
    store.close();
    const target = await realpath(root),
      relative = path.relative(parent, target);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(target, { recursive: true, force: true });
  }
});
