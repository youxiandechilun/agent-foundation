import assert from "node:assert/strict";
import { test } from "node:test";
import { FoundationHttpError } from "../src/client.js";
import { applicationIntegration } from "../src/host/applications.js";
import { setup, setupDesktop } from "./support/wire-server.js";

const notFound = (error: unknown) =>
  error instanceof FoundationHttpError && error.status === 404;

test("desktop and application routes reject extra segments before host effects", async () => {
  const desktop = await setupDesktop();
  try {
    const node = desktop.kernel.nodes.pair({
      projectId: desktop.project.id,
      name: "preserved",
      capabilities: ["device.read"],
    });
    await assert.rejects(
      desktop.client.request("DELETE", `/v1/nodes/${node.id}/unknown`),
      notFound,
    );
    assert.equal(
      desktop.kernel.nodes.list().find((entry) => entry.id === node.id)
        ?.enabled,
      true,
    );
    for (const route of [
      "computer/stop/extra",
      "computer/resume/extra",
      "browser/absent/action/extra",
    ])
      await assert.rejects(
        desktop.client.request("POST", "/v1/" + route, {}),
        notFound,
      );
    await desktop.client.request("DELETE", `/v1/nodes/${node.id}`);
    assert.equal(
      desktop.kernel.nodes.list().find((entry) => entry.id === node.id)
        ?.enabled,
      false,
    );
  } finally {
    await desktop.close();
  }
  const app = await setup(
    undefined,
    {},
    {
      integrations: [
        applicationIntegration({ browser: true, office: true, computer: true }),
      ],
    },
  );
  try {
    const paired = await app.client.browserPair(app.project.id, "preserved");
    await assert.rejects(
      app.client.request("DELETE", `/v1/browser/bridge/${paired.id}/extra`, {
        projectId: app.project.id,
      }),
      notFound,
    );
    assert.equal(
      app.kernel.nodes.list().find((entry) => entry.id === paired.id)?.enabled,
      true,
    );
    for (const route of [
      "office/create/extra",
      "office/inspect/extra",
      "browser/bridge/pair/extra",
      "computer/stop/extra",
    ])
      await assert.rejects(
        app.client.request("POST", "/v1/" + route, {
          projectId: app.project.id,
        }),
        notFound,
      );
    await app.client.browserRevoke(paired.id, app.project.id);
    assert.equal(
      app.kernel.nodes.list().find((entry) => entry.id === paired.id)?.enabled,
      false,
    );
  } finally {
    await app.close();
  }
});
