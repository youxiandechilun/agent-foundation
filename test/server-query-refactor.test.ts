import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ServerManager } from "../src/servers/manager.js";
import { serverAccess } from "../src/servers/access.js";
import type { ServerFact } from "../src/servers/types.js";
import { Store } from "../src/storage/store.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "foundation-server-query-"));
  const store = new Store(root),
    manager = new ServerManager(store, root);
  t.after(() => {
    manager.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ["project", "other"])
    store.write("projects", {
      id,
      root,
      name: id,
      createdAt: "2026-10-18T00:00:00Z",
    });
  const input = {
    name: "fixture",
    host: "127.0.0.1",
    username: "operator",
    projectIds: ["project", "other"],
    hostFingerprint: `SHA256:${"A".repeat(43)}`,
  };
  const server = manager.create(input),
    foreign = manager.create(input);
  const facts: ServerFact[] = [];
  store.transaction(() => {
    for (let index = 0; index < 240; index++) {
      const fact: ServerFact = {
        id: `fact-${index}`,
        serverId: server.id,
        projectId: index % 3 ? "project" : "other",
        kind: "note",
        source: "user",
        text: String(index),
        createdAt: new Date(
          Date.UTC(2026, 9, 18, 0, 0, 240 - index),
        ).toISOString(),
      };
      facts.push(fact);
      store.write("server-facts", fact);
      store.write("server-facts", {
        ...fact,
        id: `foreign-${index}`,
        serverId: foreign.id,
      });
    }
  });
  return { root, store, manager, input, server, foreign, facts };
}

test("server fact windows retain insertion order, the latest 100 and project grants", (t) => {
  const { manager, server, facts } = fixture(t);
  assert.deepEqual(manager.read(server.id).facts, facts.slice(-100));
  assert.deepEqual(
    manager.read(server.id, "project").facts,
    facts.filter((fact) => fact.projectId === "project").slice(-100),
  );
  manager.store.write("projects", { id: "denied" });
  assert.throws(() => manager.read(server.id, "denied"), /not available/);
  const latest = facts.at(-1);
  assert.ok(latest);
  manager.store.write("server-facts", { ...latest, text: 123 });
  assert.throws(() => manager.read(server.id), /Invalid input/);
});

test("removing a server deletes its facts across projects and preserves other servers", async (t) => {
  const { store, manager, server, foreign } = fixture(t);
  assert.deepEqual(await manager.remove(server.id), { removed: true });
  assert.equal(store.find("servers", server.id), undefined);
  assert.equal(store.count("server-facts", { serverId: server.id }), 0);
  assert.equal(store.count("server-facts", { serverId: foreign.id }), 240);
  assert.equal(manager.read(foreign.id).facts.length, 100);
});

test("server creation retains the 1000 profile limit and project validation", (t) => {
  const { store, manager, input, server } = fixture(t);
  assert.throws(
    () => manager.create({ ...input, projectIds: ["missing"] }),
    /not found/,
  );
  store.transaction(() => {
    for (let index = 0; index < 998; index++)
      store.write("servers", {
        ...server,
        id: `server_${String(index).padStart(36, "0")}`,
      });
  });
  assert.equal(store.count("servers"), 1000);
  assert.throws(() => manager.create(input), {
    status: 429,
    message: "Server profile limit reached",
  });
});

test("server mutation queues drain the same server without blocking another server", async (t) => {
  const { store } = fixture(t),
    access = serverAccess(store);
  const active = access.acquire("first");
  const order: string[] = [];
  const first = access.change("first", async () => {
    order.push("first");
  });
  const second = access.change("first", async () => {
    order.push("second");
  });
  await access.change("other", async () => {
    order.push("other");
  });
  assert.deepEqual(order, ["other"]);
  assert.equal(active.controller.signal.aborted, true);
  assert.throws(() => access.acquire("first"), /configuration is changing/);
  active.release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["other", "first", "second"]);
  const next = access.acquire("first");
  next.release();
});

test("a rejected server mutation does not strand queued or later changes", async (t) => {
  const { store } = fixture(t),
    access = serverAccess(store);
  const failure = new Error("mutation failed"),
    order: string[] = [];
  const first = access.change("server", async () => {
    throw failure;
  });
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = access.change("server", async () => {
    order.push("queued");
  });
  await Promise.all([rejected, second]);
  await access.change("server", async () => {
    order.push("later");
  });
  assert.deepEqual(order, ["queued", "later"]);
  const lease = access.acquire("server");
  lease.release();
});

for (const alias of ["same path", "Windows case alias"] as const)
  test(
    `different managers preserve concurrent credentials using ${alias}`,
    { skip: alias === "Windows case alias" && process.platform !== "win32" },
    async (t) => {
      const { root, store, server, foreign } = fixture(t);
      const keyEnv = "FOUNDATION_SERVER_QUERY_VAULT_KEY",
        previousKey = process.env[keyEnv];
      process.env[keyEnv] = randomBytes(32).toString("base64");
      const first = new ServerManager(store, root, { vaultKeyEnv: keyEnv });
      const second = new ServerManager(store, root, {
        vaultKeyEnv: keyEnv,
        vaultPath:
          alias === "Windows case alias"
            ? path.join(root, "server-vault", "credentials.json").toUpperCase()
            : undefined,
      });
      t.after(() => {
        first.close();
        second.close();
        if (previousKey === undefined) delete process.env[keyEnv];
        else process.env[keyEnv] = previousKey;
      });
      const credentials = [
        { password: "first-concurrent-password" },
        { password: "second-concurrent-password" },
      ];
      await Promise.all([
        first.setCredentials(server.id, credentials[0]),
        second.setCredentials(foreign.id, credentials[1]),
      ]);
      assert.deepEqual(
        await Promise.all([
          first.credentials(first.profile(server.id)),
          second.credentials(second.profile(foreign.id)),
        ]),
        credentials,
      );
    },
  );
