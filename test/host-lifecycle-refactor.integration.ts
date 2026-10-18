import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationIntegration } from "../src/host/applications.js";
import { setup } from "./support/wire-server.js";

for (const reference of [false, true]) {
  test(`${reference ? "reference desktop" : "application pack"} closes later services after a browser cleanup failure`, async (t) => {
    const x = await setup(
      undefined,
      {},
      reference
        ? { desktop: true }
        : { integrations: [applicationIntegration()] },
    );
    const order: string[] = [];
    for (const name of ["browser", "office", "computer"] as const) {
      const service = x.kernel[name],
        close = service.close.bind(service);
      t.mock.method(service, "close", async () => {
        await close();
        order.push(name);
        if (name === "browser") throw new Error("browser cleanup failed");
      });
    }
    await assert.rejects(x.close(), AggregateError);
    assert.deepEqual(order, ["browser", "office", "computer"]);
  });
}
