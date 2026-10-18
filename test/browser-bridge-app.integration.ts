import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, until } from "./support/wire-server.js";
import { browserIntegration } from "../src/host/applications.js";

test("independent browser pack pairs a real Chrome extension with host URL review, explicit tab grants, screenshots and revocation", async () => {
  const x = await setup(
    undefined,
    {},
    { integrations: [browserIntegration()] },
  );
  const site = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<title>Independent bridge fixture</title><input id="entry"><button id="commit" onclick="document.querySelector(\'#out\').textContent=document.querySelector(\'#entry\').value">Commit</button><p id="out"></p>',
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as any).port}/`;
  let browser: any;
  try {
    const paired = await x.client.browserPair(
      x.project.id,
      "actual user browser test",
    );
    const extension = fileURLToPath(
      new URL("../extensions/browser-bridge", import.meta.url),
    );
    browser = await chromium.launchPersistentContext(
      path.join(x.root, "bridge-profile"),
      {
        headless: true,
        channel: "chromium",
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto(url);
    const other = await browser.newPage();
    await other.goto(url + "other");
    const worker =
      browser.serviceWorkers()[0] ||
      (await browser.waitForEvent("serviceworker"));
    const tabIds = await worker.evaluate(
      async (data: any) => {
        const chrome = (globalThis as any).chrome,
          tabs = await chrome.tabs.query({});
        const target = tabs.find((t: any) => t.url === data.url),
          other = tabs.find((t: any) => t.url === data.url + "other");
        await chrome.storage.local.set({
          connection: {
            baseUrl: data.baseUrl,
            nodeId: data.nodeId,
            token: data.token,
          },
          allowedTabs: [target.id],
        });
        await (globalThis as any).connect();
        return { target: target.id, other: other.id };
      },
      { url, baseUrl: x.api.url, nodeId: paired.id, token: paired.token },
    );
    await until(
      () =>
        x.kernel.nodes
          .list(x.project.id)
          .some((n) => n.id === paired.id && n.connected) || undefined,
    );
    const act = (args: any) =>
      x.client.browserBridgeAction(paired.id, x.project.id, args);
    assert.equal(
      (await act({ action: "inspect" })).title,
      "Independent bridge fixture",
    );
    await act({
      action: "fill",
      selector: "#entry",
      text: "real paired transport",
    });
    assert.match(
      (await act({ action: "click", selector: "#commit" })).text,
      /real paired transport/,
    );
    assert.equal((await act({ action: "tabs" })).length, 1);
    await assert.rejects(
      act({
        action: "fill",
        tabId: String(tabIds.other),
        selector: "#entry",
        text: "blocked",
      }),
      /not explicitly allowed/,
    );
    assert.equal(await other.locator("#entry").inputValue(), "");
    await assert.rejects(
      x.kernel.nodes.call(x.project.id, paired.id, "browser.control", {
        action: "fill",
        tabId: tabIds.target,
        expectedUrl: url + "different",
        selector: "#entry",
        text: "stale",
      }),
      /navigated after host review/,
    );
    x.config.browser.allowedHosts = ["blocked.invalid"];
    await assert.rejects(
      act({ action: "fill", selector: "#entry", text: "blocked by host" }),
      /host is not allowed/,
    );
    assert.equal(
      await page.locator("#entry").inputValue(),
      "real paired transport",
    );
    x.config.browser.allowedHosts = ["*"];
    const shot = await act({ action: "screenshot" });
    assert.equal(shot.asset.mime, "image/png");
    assert.ok(
      (await x.kernel.assets.read(shot.asset.id, x.project.id)).length > 100,
    );
    await worker.evaluate(async () => {
      await (globalThis as any).chrome.storage.local.set({ allowedTabs: [] });
    });
    await assert.rejects(act({ action: "inspect" }), /not explicitly allowed/);
    await worker.evaluate(async (id: number) => {
      await (globalThis as any).chrome.storage.local.set({ allowedTabs: [id] });
    }, tabIds.target);
    const different = await x.client.project("other-project");
    await assert.rejects(
      x.client.browserRevoke(paired.id, different.id),
      /another project/,
    );
    assert.ok(
      !JSON.stringify(
        await x.client.request("GET", "/v1/browser/bridge"),
      ).includes(paired.token),
    );
    await x.client.browserRevoke(paired.id, x.project.id);
    await assert.rejects(act({ action: "inspect" }), /denied|revoked/);
    await until(
      async () =>
        (await worker.evaluate(
          async () =>
            !(await (globalThis as any).chrome.storage.local.get("connection"))
              .connection,
        )) || undefined,
      10000,
    );
  } finally {
    await browser?.close();
    await x.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});

test("browser node transport serializes real WebSocket tasks and revocation marks unconfirmed effects unknown and rejects the pending caller", async () => {
  const x = await setup(
    undefined,
    {},
    { integrations: [browserIntegration()] },
  );
  let ws: WebSocket | undefined;
  try {
    const paired = await x.client.browserPair(x.project.id),
      received: any[] = [];
    ws = new WebSocket(x.api.url.replace("http:", "ws:") + "/v1/nodes/channel");
    ws.on("open", () =>
      ws!.send(
        JSON.stringify({
          type: "auth",
          nodeId: paired.id,
          token: paired.token,
        }),
      ),
    );
    let ready = false;
    ws.on("message", (bytes) => {
      const m = JSON.parse(bytes.toString());
      if (m.type === "ready") ready = true;
      if (m.type === "task") received.push(m.task);
    });
    await until(() => ready || undefined);
    const first = x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "browser.control",
      { action: "inspect" },
    );
    await until(() => received.length === 1 || undefined);
    const next = x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "browser.control",
      { action: "inspect" },
    );
    ws.send(JSON.stringify({ type: "pull" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    const a = assert.rejects(first, /revoked|unknown/),
      b = assert.rejects(next, /revoked|cancelled/);
    x.kernel.nodes.revoke(paired.id);
    await a;
    await b;
    const tasks = x.kernel.store.list<any>("node-tasks");
    assert.equal(tasks[0].status, "unknown");
    assert.equal(tasks[1].status, "cancelled");
    assert.throws(
      () => x.kernel.nodes.verify(paired.id, paired.token),
      /credentials/,
    );
  } finally {
    ws?.terminate();
    await x.close();
  }
});
