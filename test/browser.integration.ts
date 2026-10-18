import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { setupDesktop as setup, until } from "./support/wire-server.js";
import { fileURLToPath } from "node:url";

async function pageServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/download") {
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="actual.csv"',
      });
      res.end("name,value\nactual,73\n");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<title>Actual browser test</title><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><p id="result"></p><input id="file" type="file"><a id="download" href="/download">Download</a>',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
test("actual Chromium navigation, DOM input/click, screenshots, file upload and download", async () => {
  const page = await pageServer(),
    x = await setup();
  try {
    const browser = await x.kernel.browser.open(
      x.project.id,
      "browser-test",
      page.url,
    );
    const browserId = browser.id;
    await x.kernel.browser.action(browserId, x.project.id, {
      action: "fill",
      selector: "#name",
      text: "real-browser-value",
    });
    const clicked = await x.kernel.browser.action(browserId, x.project.id, {
      action: "click",
      selector: "#save",
    });
    assert.match(clicked.snapshot, /Saved real-browser-value/);
    const screenshot = await x.kernel.browser.action(browserId, x.project.id, {
      action: "screenshot",
    });
    assert.ok(screenshot.asset.size > 1000);
    assert.equal(
      (await x.kernel.assets.read(screenshot.asset.id, x.project.id))[0],
      137,
    );
    const upload = await x.kernel.assets.create(
      x.project.id,
      "upload.txt",
      Buffer.from("actual upload"),
    );
    await x.kernel.browser.action(browserId, x.project.id, {
      action: "upload",
      selector: "#file",
      assetId: upload.id,
    });
    const download = await x.kernel.browser.action(browserId, x.project.id, {
      action: "download",
      selector: "#download",
    });
    assert.match(
      (await x.kernel.assets.read(download.asset.id, x.project.id)).toString(),
      /actual,73/,
    );
    await x.kernel.browser.closeSession(browserId, x.project.id);
    assert.equal(x.kernel.browser.list().length, 0);
  } finally {
    await x.close();
    await page.close();
  }
});
test("actual CDP attachment controls a separate browser and disconnect preserves its tabs", async () => {
  const x = await setup(),
    page = await pageServer();
  const profile = path.join(x.root, "cdp-profile");
  await mkdir(profile, { recursive: true });
  const child = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  try {
    const active = await until(async () => {
      try {
        return await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
      } catch {
        return undefined;
      }
    }, 15000);
    const endpoint = `http://127.0.0.1:${active.split("\n")[0]}`;
    x.config.browser.cdpEndpoints.push(endpoint);
    const browser = await x.kernel.browser.open(
      x.project.id,
      "cdp-test",
      page.url,
      endpoint,
    );
    const snapshot = await x.kernel.browser.action(browser.id, x.project.id, {
      action: "fill",
      selector: "#name",
      text: "cdp",
    });
    assert.equal(snapshot.title, "Actual browser test");
    await x.kernel.browser.closeSession(browser.id, x.project.id);
    const connected = await chromium.connectOverCDP(endpoint);
    assert.ok(
      connected
        .contexts()[0]
        .pages()
        .some((p) => p.url() === page.url + "/"),
    );
    await connected.close();
  } finally {
    child.kill();
    await x.close();
    await page.close();
  }
});
test("real PDF generation and bounded text extraction", async () => {
  const x = await setup();
  try {
    const pdf = await x.kernel.office.create(x.project.id, {
      format: "pdf",
      name: "actual",
      title: "PDF actual result",
      paragraphs: ["Total derived from source: 40."],
    });
    assert.equal(pdf.mime, "application/pdf");
    const text = await x.kernel.assets.extract(pdf.id, x.project.id);
    assert.match(text.text, /PDF actual result/);
    assert.match(text.text, /40/);
  } finally {
    await x.close();
  }
});
test("Windows native controller compiles its input helpers and reads actual desktop state without sending input", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows adapter host required");
    return;
  }
  const x = await setup();
  try {
    const state = await x.kernel.computer.action("test-native", x.project.id, {
      action: "inspect",
    });
    assert.equal(state.ok, true);
    assert.ok(state.width > 0 && state.height > 0);
    x.kernel.computer.release("test-native");
    assert.equal(x.kernel.computer.status().owner, undefined);
  } finally {
    await x.close();
  }
});
test("actual Chrome extension bridge connects, inspects, fills and clicks only its allowed test tab", async () => {
  const x = await setup(),
    page = await pageServer();
  let context: any;
  try {
    const paired = x.kernel.nodes.pair({
      projectId: x.project.id,
      name: "real extension",
      kind: "browser",
      capabilities: ["browser.control"],
    });
    const extension = fileURLToPath(
      new URL("../extensions/browser-bridge", import.meta.url),
    );
    context = await chromium.launchPersistentContext(
      path.join(x.root, "extension-profile"),
      {
        headless: true,
        channel: "chromium",
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const tab = context.pages()[0] || (await context.newPage());
    await tab.goto(page.url);
    let worker = context.serviceWorkers()[0];
    if (!worker)
      worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
    await worker.evaluate(
      async (data: any) => {
        const chrome = (globalThis as any).chrome;
        const tabs = await chrome.tabs.query({});
        const target = tabs.find((t: any) => t.url === data.pageUrl + "/");
        if (!target) throw Error("Test tab not found");
        await chrome.storage.local.set({
          connection: {
            baseUrl: data.baseUrl,
            nodeId: data.nodeId,
            token: data.token,
          },
          allowedTabs: [target.id],
        });
        await (globalThis as any).connect();
      },
      {
        baseUrl: x.api.url,
        nodeId: paired.id,
        token: paired.token,
        pageUrl: page.url,
      },
    );
    await until(
      () =>
        x.kernel.nodes.list(x.project.id).find((n) => n.id === paired.id)
          ?.connected || undefined,
      15000,
    );
    const before: any = await x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "browser.control",
      { action: "inspect" },
      10000,
    );
    assert.equal(before.title, "Actual browser test");
    await x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "browser.control",
      { action: "fill", selector: "#name", text: "extension-actual" },
      10000,
    );
    const after: any = await x.kernel.nodes.call(
      x.project.id,
      paired.id,
      "browser.control",
      { action: "click", selector: "#save" },
      10000,
    );
    assert.match(after.text, /Saved extension-actual/);
    await assert.rejects(
      x.kernel.nodes.call(
        x.project.id,
        paired.id,
        "browser.control",
        { action: "inspect", tabId: "9999999" },
        10000,
      ),
      /not explicitly allowed/,
    );
  } finally {
    await context?.close();
    await x.close();
    await page.close();
  }
});
