import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applicationIntegration,
  officeIntegration,
} from "../src/host/applications.js";
import { setup } from "./support/wire-server.js";

test("a cancelled host installation cannot add services or extractors", async () => {
  const x = await setup();
  const integration = officeIntegration();
  const cancellation = new AbortController();
  cancellation.abort(new Error("stop host installation"));
  try {
    await assert.rejects(
      async () => integration.install?.(x.kernel, cancellation.signal),
      /stop host installation/,
    );
    assert.equal("office" in x.kernel, false);
    assert.deepEqual(x.kernel.assets.extractors.list(), []);
  } finally {
    await integration.close?.(x.kernel);
    await x.close();
  }
});

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

test("reference desktop validates untrusted node results before completing tasks", async () => {
  const x = await setup(undefined, {}, { desktop: true });
  try {
    const node = x.kernel.nodes.pair({
      projectId: x.project.id,
      name: "result validation",
      capabilities: ["device.read"],
    });
    const response = await fetch(x.api.url + `/v1/nodes/${node.id}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${node.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ taskId: 42, ok: "true", error: {} }),
    });
    assert.equal(response.status, 400);
    assert.equal(x.kernel.nodes.list()[0].enabled, true);
  } finally {
    await x.close();
  }
});
