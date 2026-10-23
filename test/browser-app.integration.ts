import { required } from "./support/payloads.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { setupDesktop, setup, until } from "./support/wire-server.js";
import { browserIntegration } from "../src/host/applications.js";
import {
  BrowserNetwork,
  restrictedBrowserAddress,
  validateBrowserUrl,
} from "../src/host/browser/network.js";
async function site() {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    if (req.url === "/frame")
      return res.end(
        '<input id="nested" aria-label="Nested"><button id="nested-save" onclick="document.body.append(document.querySelector(\'#nested\').value)">Apply</button>',
      );
    if (req.url === "/download") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": "attachment;filename=owned.txt",
      });
      return res.end("actual download bytes");
    }
    res.end(
      '<title>Application fixture</title><input id="input" aria-label="Name"><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#input\').value">Save</button><p id="result"></p><select id="choice"><option value="a">A</option><option value="b">B</option></select><input id="checked" type="checkbox"><input id="upload" type="file" onchange="this.files[0].text().then(t=>document.querySelector(\'#result\').textContent=this.files[0].name+\':\'+t)"><a id="download" href="/download">Download</a><button id="confirm" onclick="document.querySelector(\'#result\').textContent=confirm(\'Confirm test\')?\'accepted\':\'dismissed\'">Confirm</button><button id="ws" onclick="const w=new WebSocket(location.origin.replace(\'http\',\'ws\')+\'/ws\');w.onopen=()=>w.send(\'actual\');w.onmessage=e=>document.querySelector(\'#result\').textContent=e.data">Socket</button><iframe src="/frame"></iframe>',
    );
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", (socket) =>
    socket.on("message", (data) => socket.send("echo:" + data.toString())),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    requests,
    activeSockets: () => ws.clients.size,
    close: async () => {
      for (const client of ws.clients) client.terminate();
      ws.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test("application browser pack independently exposes only browser tools and enforces API, owner and upload policies", async () => {
  const x = await setup(
      undefined,
      {},
      { integrations: [browserIntegration()] },
    ),
    web = await site();
  try {
    const session = await x.session("code"),
      tools = await x.kernel.toolRegistry.resolve({
        kernel: x.kernel,
        session,
        runId: "test",
        routeId: session.routeId,
      });
    assert.ok(tools.some((t) => t.name === "browser_open"));
    assert.ok(!tools.some((t) => /^(office|computer|node)_/.test(t.name)));
    assert.deepEqual(
      (await x.client.request("GET", "/v1/applications")).enabled,
      ["browser"],
    );
    const opened = await x.client.request("POST", "/v1/browser", {
      projectId: x.project.id,
      owner: session.id,
      url: web.url,
    });
    assert.equal(opened.networkEnforcement, "pinned-dns-proxy");
    await assert.rejects(
      x.kernel.browser.action(
        opened.id,
        x.project.id,
        { action: "inspect" },
        undefined,
        "another-session",
      ),
      /another session/,
    );
    const upload = await x.client.upload(
      x.project.id,
      "name.txt",
      Buffer.from("owned input"),
    );
    x.config.permissions["files.read"] = "deny";
    await assert.rejects(
      x.client.request("POST", `/v1/browser/${opened.id}/action`, {
        projectId: x.project.id,
        action: "upload",
        selector: "#upload",
        assetId: upload.id,
      }),
      /denied/,
    );
    x.config.permissions["files.read"] = "allow";
    await x.client.request("POST", `/v1/browser/${opened.id}/action`, {
      projectId: x.project.id,
      action: "upload",
      selector: "#upload",
      assetId: upload.id,
    });
    await until(async () => {
      const snapshot = await x.kernel.browser.action(opened.id, x.project.id, {
        action: "inspect",
      });
      return snapshot.snapshot.includes("name.txt:owned input") || undefined;
    });
    assert.equal((await fetch(x.api.url + "/v1/browser")).status, 401);
  } finally {
    await x.close();
    await web.close();
  }
});
test("managed browser snapshots bind element references to a snapshot and target actual frames, selects and checkboxes", async () => {
  const x = await setupDesktop(),
    web = await site();
  try {
    const b = await x.kernel.browser.open(x.project.id, "refs", web.url);
    let snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "inspect",
    });
    const ref = required(snapshot.elements.find((e) => e.id === "input")).ref,
      stale = required(snapshot.elements.find((e) => e.id === "save")).ref;
    snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "fill",
      ref,
      text: "bound reference",
    });
    await assert.rejects(
      x.kernel.browser.action(b.id, x.project.id, {
        action: "click",
        ref: stale,
      }),
      /stale/,
    );
    snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "click",
      ref: required(snapshot.elements.find((e) => e.id === "save")).ref,
    });
    assert.match(snapshot.snapshot, /bound reference/);
    snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "select",
      selector: "#choice",
      values: ["b"],
    });
    assert.match(snapshot.snapshot, /B.*selected/);
    snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "check",
      selector: "#checked",
    });
    assert.match(snapshot.snapshot, /checked/);
    const frameId = required(
      snapshot.frames.find((f) => f.url.endsWith("/frame")),
    ).id;
    snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "fill",
      frameId,
      selector: "#nested",
      text: "inside frame",
    });
    assert.match(snapshot.snapshot, /inside frame/);
  } finally {
    await x.close();
    await web.close();
  }
});
test("managed browser handles explicit dialogs and actual proxied WebSocket traffic", async () => {
  const x = await setupDesktop(),
    web = await site();
  try {
    const b = await x.kernel.browser.open(x.project.id, "dialogs", web.url);
    let snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "click",
      selector: "#confirm",
    });
    assert.match(snapshot.snapshot, /dismissed/);
    assert.equal(required(snapshot.dialog).accepted, false);
    snapshot = await x.kernel.browser.action(b.id, x.project.id, {
      action: "click",
      selector: "#confirm",
      dialog: { accept: true },
    });
    assert.match(snapshot.snapshot, /accepted/);
    assert.equal(required(snapshot.dialog).accepted, true);
    await x.kernel.browser.action(b.id, x.project.id, {
      action: "click",
      selector: "#ws",
    });
    await until(async () => {
      const current = await x.kernel.browser.action(b.id, x.project.id, {
        action: "inspect",
      });
      return current.snapshot.includes("echo:actual") || undefined;
    });
    assert.ok(web.requests.every((r) => !r.headers["proxy-authorization"]));
  } finally {
    await x.close();
    await web.close();
  }
});
test("managed browser cancellation destroys its context, stops queued work and releases profile capacity", async () => {
  const x = await setupDesktop(),
    web = await site();
  try {
    const b = await x.kernel.browser.open(x.project.id, "cancel", web.url),
      controller = new AbortController();
    const waiting = x.kernel.browser.action(
      b.id,
      x.project.id,
      { action: "wait", selector: "#never" },
      controller.signal,
    );
    const queued = x.kernel.browser
      .action(b.id, x.project.id, {
        action: "fill",
        selector: "#input",
        text: "must not execute",
      })
      .catch((e) => e);
    setTimeout(() => controller.abort(new Error("Cancelled test action")), 35);
    await assert.rejects(waiting, /Cancelled/);
    await queued;
    assert.equal(x.kernel.browser.list().length, 0);
    const next = await x.kernel.browser.open(x.project.id, "cancel", web.url);
    assert.ok(next.id);
  } finally {
    await x.close();
    await web.close();
  }
});
test("browser profiles hash untrusted owner input and repeated opens cannot release an existing profile lock", async () => {
  const x = await setupDesktop();
  try {
    const owner = "../../outside-profile",
      b = await x.kernel.browser.open(x.project.id, owner);
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        x.kernel.browser.open(x.project.id, owner),
        /already open/,
      );
    x.config.browser.maxSessions = 1;
    await assert.rejects(
      x.kernel.browser.open(x.project.id, "another"),
      /capacity/,
    );
    await x.kernel.browser.closeSession(b.id, x.project.id);
    assert.equal(x.kernel.browser.list().length, 0);
  } finally {
    await x.close();
  }
});
test("browser network policy rejects reserved IPv4 and IPv6 forms and local proxy use requires its private credentials", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
  ])
    assert.equal(restrictedBrowserAddress(address), true);
  assert.equal(restrictedBrowserAddress("8.8.8.8"), false);
  const x = await setupDesktop(),
    web = await site();
  let proxy: BrowserNetwork | undefined;
  try {
    x.config.browser.allowPrivateNetwork = false;
    await assert.rejects(
      validateBrowserUrl(web.url, x.config),
      /Private or reserved/,
    );
    proxy = await new BrowserNetwork(x.config).start();
    const response = await new Promise<number>((resolve, reject) => {
      const request = http.get(proxy!.url, { path: web.url }, (r) => {
        r.resume();
        resolve(r.statusCode!);
      });
      request.on("error", reject);
    });
    assert.equal(response, 407);
    x.config.browser.allowPrivateNetwork = true;
    await assert.rejects(
      validateBrowserUrl("http://user:pass@127.0.0.1/", x.config),
      /credentials/,
    );
    x.config.permissions.network = "deny";
    await assert.rejects(validateBrowserUrl(web.url, x.config), /disabled/);
  } finally {
    await proxy?.close();
    await x.close();
    await web.close();
  }
});
test("browser project deny policies apply to direct APIs and raw services, including network and screenshot asset writes", async () => {
  const x = await setup(
      undefined,
      {},
      { integrations: [browserIntegration()] },
    ),
    web = await site();
  try {
    const b = await x.client.browserOpen(x.project.id, { url: web.url });
    x.kernel.store.put("policies", {
      id: "project-no-network",
      effect: "deny",
      projectId: x.project.id,
      capabilities: ["network"],
    });
    await assert.rejects(
      x.client.browserAction(b.id, x.project.id, { action: "inspect" }),
      /project policy/,
    );
    await assert.rejects(
      x.kernel.browser.action(b.id, x.project.id, { action: "inspect" }),
      /project policy/,
    );
    x.kernel.store.put("policies", {
      id: "project-no-network",
      effect: "allow",
      projectId: x.project.id,
      capabilities: ["network"],
    });
    x.kernel.store.put("policies", {
      id: "project-no-output",
      effect: "deny",
      projectId: x.project.id,
      capabilities: ["files.write"],
    });
    await assert.rejects(
      x.client.browserAction(b.id, x.project.id, { action: "screenshot" }),
      /project policy/,
    );
    assert.equal(x.kernel.store.list("assets").length, 0);
    x.config.permissions.network = "deny";
    await x.client.browserClose(b.id, x.project.id);
    assert.equal(x.kernel.browser.list().length, 0);
  } finally {
    await x.close();
    await web.close();
  }
});
test("browser proxy terminates an actual open WebSocket when a project network grant is revoked", async () => {
  const x = await setup(
      undefined,
      {},
      { integrations: [browserIntegration()] },
    ),
    web = await site();
  try {
    const b = await x.client.browserOpen(x.project.id, { url: web.url });
    await x.client.browserAction(b.id, x.project.id, {
      action: "click",
      selector: "#ws",
    });
    await until(
      async () =>
        (
          await x.client.browserAction(b.id, x.project.id, {
            action: "inspect",
          })
        ).snapshot.includes("echo:actual") || undefined,
    );
    assert.equal(web.activeSockets(), 1);
    // The proxy's established TCP connection is terminated by its live permission monitor.
    x.kernel.store.put("policies", {
      id: "revoke-active-network",
      effect: "deny",
      projectId: x.project.id,
      capabilities: ["network"],
    });
    await assert.rejects(
      x.kernel.browser.action(b.id, x.project.id, { action: "inspect" }),
      /project policy/,
    );
    await until(() => web.activeSockets() === 0 || undefined);
    x.kernel.store.put("policies", {
      id: "revoke-active-network",
      effect: "allow",
      projectId: x.project.id,
      capabilities: ["network"],
    });
    assert.equal(web.activeSockets(), 0);
  } finally {
    await x.close();
    await web.close();
  }
});
test("aborting the direct browser HTTP client cancels the actual waiting action and closes its managed context", async () => {
  const x = await setup(
      undefined,
      {},
      { integrations: [browserIntegration()] },
    ),
    web = await site();
  try {
    const b = await x.client.browserOpen(x.project.id, { url: web.url }),
      stop = new AbortController();
    let entered = false;
    const original = x.kernel.browser.action.bind(x.kernel.browser);
    x.kernel.browser.action = async (...args: Parameters<typeof original>) => {
      entered = true;
      return original(...args);
    };
    const waiting = x.client.browserAction(
      b.id,
      x.project.id,
      { action: "wait", selector: "#missing" },
      stop.signal,
    );
    await until(() => entered || undefined);
    stop.abort();
    await assert.rejects(waiting, /abort/i);
    await until(() => x.kernel.browser.list().length === 0 || undefined);
  } finally {
    await x.close();
    await web.close();
  }
});
