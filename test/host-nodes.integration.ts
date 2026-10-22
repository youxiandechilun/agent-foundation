import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { setupDesktop as setup, until } from "./support/wire-server.js";

test("paired node HTTP transport uses scoped auth, actual queued tasks and explicit results", async () => {
  const x = await setup();
  try {
    const paired = await x.client.request("POST", "/v1/nodes/pair", {
      projectId: x.project.id,
      name: "device protocol test",
      capabilities: ["gpio.read"],
    });
    const pending = x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "gpio.read",
      { pin: 4 },
      3000,
    );
    const response = await fetch(x.api.url + `/v1/nodes/${paired.id}/poll`, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    assert.equal(response.status, 200);
    const { task } = (await response.json()) as any;
    assert.equal(task.args.pin, 4);
    const completed = await fetch(x.api.url + `/v1/nodes/${paired.id}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paired.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskId: task.id,
        ok: true,
        result: { pin: 4, value: 1 },
      }),
    });
    assert.equal(completed.status, 200);
    assert.deepEqual(await pending, { pin: 4, value: 1 });
    assert.equal(
      (
        await fetch(x.api.url + `/v1/nodes/${paired.id}/poll`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
      401,
    );
    await assert.rejects(
      x.kernel.nodes.call(x.project.id, paired.id, "gpio.write", {
        pin: 4,
        value: 0,
      }),
      /denied/,
    );
    x.kernel.nodes.revoke(paired.id);
    assert.throws(
      () => x.kernel.nodes.verify(paired.id, paired.token),
      /Invalid/,
    );
  } finally {
    await x.close();
  }
});
test("real WebSocket node channel authenticates, dispatches once and records results", async () => {
  const x = await setup();
  let ws: WebSocket | undefined;
  try {
    const paired = x.kernel.nodes.pair({
      projectId: x.project.id,
      name: "browser transport peer",
      kind: "browser",
      capabilities: ["browser.control"],
    });
    ws = new WebSocket(x.api.url.replace("http:", "ws:") + "/v1/nodes/channel");
    let ready = false,
      tasks = 0;
    ws.on("open", () =>
      ws!.send(
        JSON.stringify({
          type: "auth",
          nodeId: paired.id,
          token: paired.token,
        }),
      ),
    );
    ws.on("message", (data) => {
      const value = JSON.parse(data.toString());
      if (value.type === "ready") ready = true;
      if (value.type === "task") {
        tasks++;
        ws!.send(
          JSON.stringify({
            type: "result",
            taskId: value.task.id,
            ok: true,
            result: { url: "https://test.example", title: "channel-result" },
          }),
        );
      }
    });
    await until(() => ready || undefined);
    const result: any = await x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "browser.control",
      { action: "inspect" },
      3000,
    );
    assert.equal(result.title, "channel-result");
    assert.equal(tasks, 1);
    assert.equal(x.kernel.store.list<any>("node-tasks")[0].status, "completed");
  } finally {
    ws?.terminate();
    await x.close();
  }
});
