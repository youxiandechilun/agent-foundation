import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Kernel } from "../src/core/kernel.js";
import { parseConfig } from "../src/core/config.js";
import { Store } from "../src/storage/store.js";
import { MediaAdapterRegistry } from "../src/media/adapters.js";
import { CostLedger } from "../src/runtime/cost.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-construction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return parseConfig({
    dataDir: path.join(root, "data"),
    workspaceRoots: [root],
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
    },
    defaultRoutes: { chat: "text", code: "text", office: "text" },
  });
}

test("invalid billing options fail before the data directory is acquired and allow immediate retry", async (t) => {
  const config = await fixture(t);
  for (const billingDelivery of [
    { concurrency: 0 },
    { timeoutMs: NaN },
    { shutdownTimeoutMs: -1 },
  ])
    assert.throws(
      () => new Kernel(config, { billingDelivery }),
      /Invalid billing delivery option/,
    );
  await assert.rejects(access(config.dataDir), /ENOENT/);
  const retried = new Kernel(config);
  await retried.close();
});

test("a late service construction failure releases the lease before rethrowing", async (t) => {
  const config = await fixture(t);
  const failure = new Error("adapter assembly failed");
  const registration = t.mock.method(
    MediaAdapterRegistry.prototype,
    "register",
    () => {
      throw failure;
    },
  );
  assert.throws(
    () => new Kernel(config),
    (error: unknown) => error === failure,
  );
  registration.mock.restore();
  const retried = new Kernel(config);
  await retried.close();
});

test("recovery failure closes the assembled store and preserves the original error", async (t) => {
  const config = await fixture(t);
  const failure = new Error("billing recovery failed");
  const recovery = t.mock.method(CostLedger.prototype, "recover", () => {
    throw failure;
  });
  assert.throws(
    () => new Kernel(config),
    (error: unknown) => error === failure,
  );
  recovery.mock.restore();
  const store = new Store(config.dataDir, { exclusiveKernel: true });
  store.close();
});

test("construction rollback reports cleanup failures without losing the constructor error", async (t) => {
  const config = await fixture(t);
  const failure = new Error("recovery failed");
  const cleanupFailure = new Error("store cleanup failed after release");
  t.mock.method(CostLedger.prototype, "recover", () => {
    throw failure;
  });
  const close = Store.prototype.close;
  const cleanup = t.mock.method(
    Store.prototype,
    "close",
    function (this: Store) {
      close.call(this);
      throw cleanupFailure;
    },
  );
  assert.throws(
    () => new Kernel(config),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.cause === failure &&
      error.errors[0] === failure &&
      error.errors[1] === cleanupFailure,
  );
  cleanup.mock.restore();
  const reopened = new Store(config.dataDir, { exclusiveKernel: true });
  reopened.close();
});
