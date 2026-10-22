import assert from "node:assert/strict";
import { test } from "node:test";
import { closeResources } from "../src/core/util.js";
import { Store } from "../src/storage/store.js";
import { setup } from "./support/wire-server.js";

test("resource cleanup preserves dependency order and reports every failure", async () => {
  const order: string[] = [];
  const first = new Error("first failure"),
    second = new Error("second failure");
  await assert.rejects(
    closeResources(
      [
        {
          close() {
            order.push("first");
            throw first;
          },
        },
        undefined,
        {
          async close() {
            await Promise.resolve();
            order.push("second");
            throw second;
          },
        },
        {
          close() {
            order.push("last");
          },
        },
      ],
      "cleanup failed",
    ),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.message === "cleanup failed" &&
      error.errors[0] === first &&
      error.errors[1] === second,
  );
  assert.deepEqual(order, ["first", "second", "last"]);
});

test("failed integration cleanup still closes later integrations and releases the kernel lease", async () => {
  const order: string[] = [];
  const failure = new Error("integration close failure");
  const x = await setup(
    undefined,
    {},
    {
      integrations: [
        {
          id: "failure",
          close() {
            order.push("failure");
            throw failure;
          },
        },
        {
          id: "later",
          close() {
            order.push("later");
          },
        },
      ],
    },
  );
  await assert.rejects(x.close(), AggregateError);
  await assert.rejects(
    x.kernel.close(),
    (error: unknown) =>
      error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.deepEqual(order, ["failure", "later"]);
  const reopened = new Store(x.config.dataDir, { exclusiveKernel: true });
  reopened.close();
});
