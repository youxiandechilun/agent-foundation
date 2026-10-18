import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MCPOAuth, oauthSchema } from "../src/extensions/mcp/auth/oauth.js";
import { DEVICE_GRANT } from "../src/extensions/mcp/auth/device.js";
import { OAuthVault } from "../src/extensions/mcp/auth/vault.js";
import { setup, until } from "./support/wire-server.js";
import { lifecyclePeer } from "./support/oauth-lifecycle.js";
import { trustedOAuthWorker } from "./support/trusted-oauth-worker.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function install(x: any, peer: any, extra: any = {}) {
  const d = x.kernel.mcp.install({
    id: "device",
    name: "Device",
    transport: "http",
    url: peer.origin + "/mcp",
    oauth: {
      clientId: "public-client",
      deviceFlow: true,
      allowedIssuers: [peer.origin],
      allowLoopbackHttp: true,
      ...extra,
    },
  });
  return { id: d.id, url: d.url!, oauth: d.oauth! };
}
async function due(status: any) {
  await sleep(Math.max(1, Date.parse(status.nextPollAt) - Date.now() + 20));
}
test("OAuth device flow performs callbackless discovery, user verification, token exchange and refresh over HTTP", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    const target = install(x, peer),
      start = await x.client.beginMCPDeviceAuth("device");
    assert.equal(start.state, "pending");
    assert.equal(start.intervalSeconds, 1);
    assert.ok(!JSON.stringify(start).includes("private-device"));
    assert.equal((await x.client.pollMCPDeviceAuth("device")).state, "pending");
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      0,
    );
    await fetch(start.verificationUriComplete);
    await due(start);
    assert.equal(
      (await x.client.pollMCPDeviceAuth("device")).state,
      "authorized",
    );
    assert.match(
      await x.kernel.mcp.oauth!.authorization(target),
      /^Bearer device-access/,
    );
    assert.equal(
      peer.requests.filter(
        (r: any) =>
          new URLSearchParams(r.text).get("grant_type") === "refresh_token",
      ).length,
      1,
    );
    const state = await x.client.mcpDeviceAuth("device");
    assert.equal(state.state, "authorized");
    assert.equal(state.userCode, undefined);
    assert.equal(
      (await x.client.pollMCPDeviceAuth("device")).state,
      "authorized",
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device polling persists authorization_pending and slow_down with the required five-second increase", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    peer.controls.pollErrors = ["authorization_pending", "slow_down"];
    let status = await x.client.beginMCPDeviceAuth("device");
    await due(status);
    status = await x.client.pollMCPDeviceAuth("device");
    assert.equal(status.error, "authorization_pending");
    await due(status);
    status = await x.client.pollMCPDeviceAuth("device");
    assert.equal(status.error, "slow_down");
    assert.equal(status.intervalSeconds, 6);
    const last = peer.requests
      .filter((r: any) => r.path === "/token")
      .at(-1).at;
    assert.ok(Date.parse(status.nextPollAt) - last >= 6000);
    await x.client.pollMCPDeviceAuth("device");
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      2,
    );
    await fetch(status.verificationUriComplete);
    await due(status);
    assert.equal(
      (await x.client.pollMCPDeviceAuth("device")).state,
      "authorized",
    );
    const polls = peer.requests.filter((r: any) => r.path === "/token");
    assert.ok(polls[2].at - polls[1].at >= 6000);
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device flow uses the five-second default and never polls early after restart", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  let restored: MCPOAuth | undefined;
  try {
    peer.controls.interval = undefined;
    const target = install(x, peer),
      start = await x.client.beginMCPDeviceAuth("device");
    assert.equal(start.intervalSeconds, 5);
    x.kernel.mcp.oauth!.close();
    restored = new MCPOAuth(x.config);
    assert.equal(
      (await restored.deviceStatus(target)).userCode,
      start.userCode,
    );
    await restored.devicePoll(target);
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      0,
    );
    const files = await readdir(path.join(x.config.dataDir, "mcp-oauth"));
    for (const file of files.filter((f: string) => f.endsWith(".json")))
      assert.ok(
        !(
          await readFile(path.join(x.config.dataDir, "mcp-oauth", file), "utf8")
        ).includes("private-device"),
      );
    await fetch(start.verificationUriComplete);
    await due(start);
    assert.equal((await restored.devicePoll(target)).state, "authorized");
  } finally {
    restored?.close();
    await x.close();
    await peer.close();
  }
});
for (const error of ["access_denied", "expired_token", "invalid_client"])
  test(`OAuth device ${error} is terminal and cannot trigger automatic authorization or polling`, async () => {
    const x = await setup(),
      peer = await lifecyclePeer();
    try {
      install(x, peer);
      peer.controls.pollErrors = [error];
      const start = await x.client.beginMCPDeviceAuth("device");
      await due(start);
      const result = await x.client.pollMCPDeviceAuth("device");
      assert.equal(
        result.state,
        error === "access_denied"
          ? "denied"
          : error === "expired_token"
            ? "expired"
            : "failed",
      );
      assert.equal(result.error, error);
      await x.client.pollMCPDeviceAuth("device");
      assert.equal(
        peer.requests.filter((r: any) => r.path === "/token").length,
        1,
      );
      assert.equal((await x.kernel.mcp.authStatus("device")).authorized, false);
    } finally {
      await x.close();
      await peer.close();
    }
  });
test("OAuth device flow expires locally without contacting the token endpoint", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    peer.controls.expiresIn = 1;
    peer.controls.interval = 5;
    install(x, peer);
    await x.client.beginMCPDeviceAuth("device");
    await sleep(1050);
    assert.equal((await x.client.pollMCPDeviceAuth("device")).state, "expired");
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      0,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device connection failure doubles the persisted polling interval", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    peer.controls.pollDrop = true;
    const start = await x.client.beginMCPDeviceAuth("device");
    await due(start);
    const status = await x.client.pollMCPDeviceAuth("device");
    assert.equal(status.error, "connection_error");
    assert.equal(status.intervalSeconds, 2);
    await x.client.pollMCPDeviceAuth("device");
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      1,
    );
    peer.controls.pollDrop = false;
    await fetch(status.verificationUriComplete);
    await due(status);
    assert.equal(
      (await x.client.pollMCPDeviceAuth("device")).state,
      "authorized",
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device concurrent polls share one request and cancellation prevents a late token from reviving authorization", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    const target = install(x, peer);
    let status = await x.client.beginMCPDeviceAuth("device");
    await fetch(status.verificationUriComplete);
    await due(status);
    peer.controls.pollDelay = 200;
    const pending = Array.from({ length: 5 }, () =>
      x.client.pollMCPDeviceAuth("device").then(
        (v) => ({ v }),
        (e) => ({ e }),
      ),
    );
    await until(() => peer.requests.some((r: any) => r.path === "/token"));
    await x.client.cancelMCPDeviceAuth("device");
    await Promise.all(pending);
    await sleep(230);
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      1,
    );
    assert.equal((await x.kernel.mcp.oauth!.status(target)).authorized, false);
    assert.equal((await x.client.mcpDeviceAuth("device")).state, "idle");
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device start cancellation and logout during discovery leave no resumable grant", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    peer.controls.beginDelay = 150;
    const pending = x.client.beginMCPDeviceAuth("device").catch((e) => e);
    await until(() => peer.requests.some((r: any) => r.path === "/device"));
    await x.client.request("DELETE", "/v1/mcp/device/auth");
    await pending;
    await sleep(180);
    assert.equal((await x.client.mcpDeviceAuth("device")).state, "idle");
  } finally {
    await x.close();
    await peer.close();
  }
});
for (const method of ["none", "client_secret_basic", "client_secret_post"])
  test(`OAuth device dynamic ${method} registration uses the issued credentials and device grant metadata`, async () => {
    const x = await setup(),
      peer = await lifecyclePeer();
    try {
      const target = install(x, peer, {
        clientId: undefined,
        registration: {
          mode: "dynamic",
          tokenEndpointAuthMethod: method,
          grantTypes: [DEVICE_GRANT, "refresh_token"],
        },
      });
      const start = await x.client.beginMCPDeviceAuth("device"),
        post = JSON.parse(
          peer.requests.find((r: any) => r.path === "/register").text,
        );
      assert.deepEqual(post.grant_types, [DEVICE_GRANT, "refresh_token"]);
      assert.equal(post.redirect_uris, undefined);
      await fetch(start.verificationUriComplete);
      await due(start);
      assert.equal(
        (await x.client.pollMCPDeviceAuth("device")).state,
        "authorized",
      );
      assert.match(await x.kernel.mcp.oauth!.authorization(target), /^Bearer/);
    } finally {
      await x.close();
      await peer.close();
    }
  });
test("OAuth device flow rejects unreviewed endpoints, verification origins and malformed intervals before saving a grant", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    peer.controls.deviceEndpoint = "https://unreviewed.invalid/device";
    await assert.rejects(
      x.client.beginMCPDeviceAuth("device"),
      /outside reviewed/,
    );
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/device").length,
      0,
    );
    peer.controls.deviceEndpoint = undefined;
    peer.controls.deviceChange = (data: any) => {
      data.verification_uri = "https://unreviewed.invalid/verify";
    };
    await assert.rejects(
      x.client.beginMCPDeviceAuth("device"),
      /outside reviewed/,
    );
    peer.controls.deviceChange = (data: any) => {
      data.interval = 0;
    };
    await assert.rejects(
      x.client.beginMCPDeviceAuth("device"),
      /Invalid device/,
    );
    assert.equal((await x.client.mcpDeviceAuth("device")).state, "idle");
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device flow is opt-in and callbackless configuration rejects authorization-code metadata", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer, {
      deviceFlow: false,
      redirectUri: "http://127.0.0.1/callback",
    });
    await assert.rejects(x.client.beginMCPDeviceAuth("device"), /not enabled/);
    assert.equal(
      oauthSchema.safeParse({
        clientId: "public-client",
        allowedIssuers: [peer.origin],
      }).success,
      false,
    );
    assert.equal(
      oauthSchema.safeParse({
        registration: { mode: "dynamic" },
        deviceFlow: true,
        allowedIssuers: [peer.origin],
      }).success,
      false,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth device recovery recognizes a committed token after a failed final status write without redeeming the device code twice", async () => {
  const x = await setup(),
    peer = await lifecyclePeer(),
    save = OAuthVault.prototype.save;
  let restored: MCPOAuth | undefined;
  try {
    const target = install(x, peer),
      start = await x.client.beginMCPDeviceAuth("device");
    await fetch(start.verificationUriComplete);
    await due(start);
    let fail = true;
    OAuthVault.prototype.save = async function (
      id,
      kind,
      bound,
      value: any,
      guard,
    ) {
      if (kind === "device-flow" && value.state === "authorized" && fail) {
        fail = false;
        throw Error("Injected final-state storage failure");
      }
      return save.call(this, id, kind, bound, value, guard);
    };
    await assert.rejects(
      x.client.pollMCPDeviceAuth("device"),
      /storage failure/,
    );
    OAuthVault.prototype.save = save;
    x.kernel.mcp.oauth!.close();
    restored = new MCPOAuth(x.config);
    assert.equal((await restored.deviceStatus(target)).state, "authorized");
    assert.equal((await restored.devicePoll(target)).state, "authorized");
    assert.equal(
      peer.requests.filter((r: any) => r.path === "/token").length,
      1,
    );
  } finally {
    OAuthVault.prototype.save = save;
    restored?.close();
    await x.close();
    await peer.close();
  }
});
test("OAuth device continuous waiting honors cancellation and can resume the same pending grant", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    const target = install(x, peer),
      start = await x.client.beginMCPDeviceAuth("device"),
      controller = new AbortController();
    const waiting = x.client.waitMCPDeviceAuth("device", controller.signal);
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(waiting, /Cancelled|aborted/);
    assert.equal((await x.client.mcpDeviceAuth("device")).state, "pending");
    await fetch(start.verificationUriComplete);
    assert.equal(
      (await x.kernel.mcp.oauth!.deviceWait(target)).state,
      "authorized",
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
for (const authentication of ["none", "managed"])
  test(`OAuth device CIMD ${authentication} completes callbackless authorization and refresh over trusted HTTPS`, async () => {
    const value = await trustedOAuthWorker("./device-cimd.mjs", [
      authentication,
    ]);
    assert.equal(value.state, "authorized");
    assert.equal(value.clientMode, "metadata");
    assert.equal(value.bearerMatches, true);
    assert.equal(value.exchanges, 2);
    assert.equal(value.privateMaterialExposed, false);
    assert.equal(value.assertions.length, authentication === "managed" ? 3 : 0);
    assert.ok(value.assertions.every((a: any) => a.valid));
    if (authentication === "managed")
      assert.ok(value.assertions[0].aud.endsWith("/device"));
  });
