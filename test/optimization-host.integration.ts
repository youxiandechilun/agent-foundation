import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { Kernel } from "../src/core/kernel.js";
import { parseConfig } from "../src/core/config.js";
import {
  browserIntegration,
  officeIntegration,
  applicationIntegration,
} from "../src/host/applications.js";
import { BrowserNetwork } from "../src/host/browser/network.js";
import { setup, until } from "./support/wire-server.js";

test("actual managed context closure releases its profile, proxy and capacity before reopening", async (t) => {
  const contexts: BrowserContext[] = [];
  const launch = chromium.launchPersistentContext.bind(chromium);
  t.mock.method(
    chromium,
    "launchPersistentContext",
    async (...args: Parameters<typeof launch>) => {
      const context = await launch(...args);
      contexts.push(context);
      return context;
    },
  );
  let releasedNetworks = 0;
  const releaseNetwork = BrowserNetwork.prototype.close;
  t.mock.method(
    BrowserNetwork.prototype,
    "close",
    async function (this: BrowserNetwork) {
      releasedNetworks++;
      await releaseNetwork.call(this);
    },
  );
  const x = await setup(
    undefined,
    {
      browser: { headless: true, maxSessions: 1 },
    },
    { integrations: [browserIntegration()] },
  );
  try {
    const first = await x.kernel.browser.open(x.project.id, "direct-user");
    await contexts[0].close();
    await until(() => x.kernel.browser.list().length === 0 || undefined);
    assert.equal(releasedNetworks, 1);
    const second = await x.kernel.browser.open(x.project.id, "direct-user");
    assert.notEqual(second.id, first.id);
    await Promise.all([
      x.kernel.browser.closeSession(second.id, x.project.id),
      x.kernel.browser.closeSession(second.id, x.project.id),
    ]);
    assert.equal(releasedNetworks, 2);
    assert.equal(x.kernel.browser.list().length, 0);
  } finally {
    await x.close();
  }
});

test("actual CDP disconnection releases capacity without closing the user's browser or tabs", async (t) => {
  const x = await setup(
    undefined,
    {
      browser: { headless: true, maxSessions: 1, cdpAllowExistingTabs: true },
    },
    { integrations: [browserIntegration()] },
  );
  let userContext: BrowserContext | undefined;
  let attached: Browser | undefined;
  const connect = chromium.connectOverCDP.bind(chromium);
  t.mock.method(
    chromium,
    "connectOverCDP",
    async (...args: Parameters<typeof connect>) => {
      attached = await connect(...args);
      return attached;
    },
  );
  try {
    const profile = path.join(x.root, "external-cdp-owner");
    userContext = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    const page = userContext.pages()[0];
    await page.setContent("<title>User-owned tab remains open</title>");
    const active = await readFile(
      path.join(profile, "DevToolsActivePort"),
      "utf8",
    );
    const endpoint = `http://127.0.0.1:${active.split("\n")[0]}`;
    x.config.browser.cdpEndpoints.push(endpoint);
    await x.kernel.browser.open(
      x.project.id,
      "direct-user",
      "about:blank",
      endpoint,
    );
    assert.ok(attached);
    await attached.close();
    await until(() => x.kernel.browser.list().length === 0 || undefined);
    assert.equal(page.isClosed(), false);
    assert.equal(await page.title(), "User-owned tab remains open");
    const reopened = await x.kernel.browser.open(
      x.project.id,
      "direct-user",
      "about:blank",
      endpoint,
    );
    await x.kernel.browser.closeSession(reopened.id, x.project.id);
    assert.equal(page.isClosed(), false);
    assert.equal(await page.title(), "User-owned tab remains open");
  } finally {
    try {
      await x.close();
    } finally {
      await userContext?.close();
    }
  }
});

test("a failed second Kernel installation cannot close the first Kernel's application services", async (t) => {
  const integration = officeIntegration();
  const x = await setup(undefined, {}, { integrations: [integration] });
  const second = new Kernel(
    parseConfig({
      ...x.config,
      dataDir: path.join(x.root, "second-kernel-data"),
    }),
    { integrations: [integration] },
  );
  const original = x.kernel.office;
  let closes = 0;
  const close = original.close.bind(original);
  t.mock.method(original, "close", async () => {
    closes++;
    await close();
  });
  try {
    await Promise.all([
      integration.install!(x.kernel),
      integration.install!(x.kernel),
    ]);
    assert.equal(x.kernel.office, original);
    assert.deepEqual(x.kernel.assets.extractors.list(), ["office-formats"]);
    await assert.rejects(second.init(), /belongs to one kernel/);
    await second.close();
    assert.equal(closes, 0);
    const asset = await x.kernel.office.create(x.project.id, {
      format: "csv",
      name: "still-active",
      title: "Retained ownership",
      rows: [["value"], [42]],
    });
    assert.ok(asset.size > 0);
    await x.close();
    assert.equal(closes, 1);
    await assert.rejects(
      async () => integration.install!(x.kernel),
      /have closed/,
    );
  } finally {
    await second.close();
    await x.close();
  }
});

test("overlapping application packs reject service replacement and retain the original cleanup owner", async (t) => {
  const first = officeIntegration();
  const overlapping = applicationIntegration({
    browser: false,
    computer: true,
    office: true,
  });
  const x = await setup(undefined, {}, { integrations: [first] });
  const original = x.kernel.office;
  let closes = 0;
  const close = original.close.bind(original);
  t.mock.method(original, "close", async () => {
    closes++;
    await close();
  });
  try {
    await assert.rejects(
      async () => overlapping.install!(x.kernel),
      /already installed/,
    );
    await overlapping.close?.(x.kernel);
    assert.equal(x.kernel.office, original);
    assert.equal(closes, 0);
    await x.close();
    assert.equal(closes, 1);
  } finally {
    await x.close();
  }
});
