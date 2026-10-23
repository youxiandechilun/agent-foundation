import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./support/wire-server.js";

test("storage diagnostics require authentication and report explicit persisted categories", async () => {
  const x = await setup();
  try {
    const denied = await fetch(x.api.url + "/v1/storage/stats");
    assert.equal(denied.status, 401);
    await denied.text();
    x.kernel.memory.put({
      projectId: x.project.id,
      content: "storage diagnostic memory",
    });
    const stats = await x.client.storageStats();
    assert.equal(
      stats.tables.find((table) => table.table === "e_projects")?.rows,
      1,
    );
    assert.equal(
      stats.tables.find((table) => table.table === "e_memories")?.rows,
      1,
    );
    assert.ok(
      stats.tables.find((table) => table.table === "e_memory_revisions")!
        .jsonBytes > 0,
    );
    assert.ok(stats.database.pageSize > 0);
    assert.ok(stats.database.walBytes >= 0);
    assert.ok(stats.directories.assets.bytes >= 0);
    assert.ok(Date.parse(stats.completedAt) >= Date.parse(stats.startedAt));
  } finally {
    await x.close();
  }
});
