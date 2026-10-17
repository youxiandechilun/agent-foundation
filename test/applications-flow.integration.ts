import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, collect } from "./support/wire-server.js";
import { applicationIntegration } from "../src/host/applications.js";
test("application tools execute real office, browser and native work within a continuous multi-reply Agent run and publish durable owned assets", async () => {
  const site = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<title>Agent application flow</title><h1>Actual browser fixture</h1>",
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as any).port}/`;
  const x = await setup(
    (_request, i) =>
      i === 0
        ? {
            text: "先创建实际办公文件。",
            calls: [
              {
                name: "office_create",
                args: {
                  format: "xlsx",
                  name: "agent-output",
                  title: "Data",
                  rows: [
                    ["Item", "Value"],
                    ["Actual", 17],
                  ],
                },
              },
            ],
          }
        : i === 1
          ? {
              text: "文件已返回，继续打开浏览器。",
              calls: [{ name: "browser_open", args: { url } }],
            }
          : i === 2 && process.platform === "win32"
            ? {
                text: "浏览器已返回，继续读取主机状态。",
                calls: [
                  { name: "computer_action", args: { action: "inspect" } },
                ],
              }
            : { text: "工具结果都已返回，完成这一轮。" },
    {
      permissions: {
        "files.read": "allow",
        "files.write": "allow",
        browser: "allow",
        computer: "allow",
        network: "allow",
        node: "allow",
      },
    },
    { integrations: [applicationIntegration()] },
  );
  try {
    const session = await x.session("office"),
      { runId } = await x.client.submit(session.id, {
        text: "实际运行应用工具并持续回复",
      }),
      events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    const count = process.platform === "win32" ? 3 : 2;
    const tools = events.filter((e) => e.type === "tool.settled");
    assert.equal(tools.length, count);
    assert.ok(
      tools.every((e) => !e.data.isError),
      JSON.stringify(tools),
    );
    assert.equal(
      events.filter((e) => e.type === "assistant.message.committed").length,
      count + 1,
    );
    assert.ok(
      events.findIndex((e) => e.type === "assistant.message.committed") <
        events.findIndex((e) => e.type === "tool.started"),
    );
    const asset = x.kernel.store.list<any>("assets")[0];
    assert.equal(asset.projectId, x.project.id);
    assert.match(asset.name, /\.xlsx$/);
    assert.equal(
      (await x.kernel.office.table(x.project.id, asset.id))[0].rows[1][1],
      17,
    );
    assert.ok(events.some((e) => e.type === "artifact.created"));
    assert.equal(x.kernel.browser.list().length, 1);
    assert.equal(x.kernel.computer.status().owner, undefined);
    assert.equal(
      x.kernel.store
        .list<any>("effects")
        .filter((e) => e.runId === runId && e.status === "completed").length,
      count,
    );
    assert.ok(
      x.kernel.store.replay(runId).some((e) => e.type === "artifact.created"),
    );
  } finally {
    await x.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
