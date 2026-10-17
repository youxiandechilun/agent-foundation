import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MCPOAuth } from "../src/extensions/mcp-oauth.js";
import { DEVICE_GRANT } from "../src/extensions/mcp-device.js";
import { setup, until } from "./support/wire-server.js";
import { lifecyclePeer } from "./support/oauth-lifecycle.js";
for (const phase of ["registration", "management"])
  test(`OAuth ${phase} refuses an issued client secret without an explicit expiration and retains unknown outcome`, async () => {
    const x = await setup(),
      peer = await lifecyclePeer();
    try {
      install(x, peer);
      if (phase === "registration")
        peer.controls.registerChange = (data: any) => {
          delete data.client_secret_expires_at;
        };
      else {
        await x.client.registerMCPOAuth("registered");
        peer.controls.manageChange = (data: any) => {
          delete data.client_secret_expires_at;
        };
      }
      await assert.rejects(
        phase === "registration"
          ? x.client.registerMCPOAuth("registered")
          : x.client.readMCPRegistration("registered"),
        /secret expiration/,
      );
      const status = await x.client.mcpRegistration("registered");
      assert.equal(
        phase === "registration" ? status.state : status.managementState,
        "outcome_unknown",
      );
    } finally {
      await x.close();
      await peer.close();
    }
  });
function install(x: any, peer: any) {
  const d = x.kernel.mcp.install({
    id: "registered",
    name: "Registered",
    transport: "http",
    url: peer.origin + "/mcp",
    oauth: {
      deviceFlow: true,
      allowedIssuers: [peer.origin],
      allowLoopbackHttp: true,
      registration: {
        mode: "dynamic",
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: [DEVICE_GRANT, "refresh_token"],
      },
    },
  });
  return { id: d.id, url: d.url!, oauth: d.oauth! };
}
test("OAuth RFC 7592 reads remote registration and atomically adopts rotated management and client credentials", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    const target = install(x, peer);
    await x.client.registerMCPOAuth("registered");
    const first = await x.kernel.mcp.oauth!.registrations.credentials(target),
      read = await x.client.readMCPRegistration("registered"),
      second = await x.kernel.mcp.oauth!.registrations.credentials(target);
    assert.notEqual(first!.clientSecret, second!.clientSecret);
    assert.notEqual(
      first!.registrationAccessToken,
      second!.registrationAccessToken,
    );
    assert.equal(read.clientId, first!.clientId);
    assert.ok(!JSON.stringify(read).includes("rotated-"));
    await x.client.readMCPRegistration("registered");
    const management = peer.requests.filter((r: any) =>
      r.path.startsWith("/clients/"),
    );
    assert.equal(
      management[1].authorization,
      "Bearer " + second!.registrationAccessToken,
    );
    const start = await x.client.beginMCPDeviceAuth("registered");
    assert.equal(start.state, "pending");
    const post = peer.requests.filter((r: any) => r.path === "/device").at(-1);
    assert.equal(
      new URLSearchParams(post.text).get("client_secret"),
      (await x.kernel.mcp.oauth!.registrations.credentials(target))!
        .clientSecret,
    );
    const status = await x.client.mcpRegistration("registered");
    assert.equal(status.remoteManagement, true);
    assert.ok(!JSON.stringify(status).includes("management-secret"));
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 updates send complete metadata, preserve unknown extensions and omit registration-only fields", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    await x.client.registerMCPOAuth("registered");
    const result = await x.client.updateMCPRegistration("registered", {
      client_name: "Renamed",
      logo_uri: "https://example.test/logo.png",
      contacts: ["owner@example.test"],
    });
    assert.equal(result.metadata.client_name, "Renamed");
    const post = JSON.parse(
      peer.requests.filter((r: any) => r.method === "PUT").at(-1).text,
    );
    assert.deepEqual(post.x_extension, { preserve: "server-added" });
    assert.deepEqual(post.grant_types, [DEVICE_GRANT, "refresh_token"]);
    assert.ok(post.client_id);
    assert.equal(post.token_endpoint_auth_method, "client_secret_post");
    for (const k of [
      "client_secret",
      "registration_access_token",
      "registration_client_uri",
      "client_secret_expires_at",
      "client_id_issued_at",
    ])
      assert.equal(post[k], undefined);
    await x.client.updateMCPRegistration("registered", { logo_uri: null });
    assert.equal(
      JSON.parse(
        peer.requests.filter((r: any) => r.method === "PUT").at(-1).text,
      ).logo_uri,
      undefined,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 rejects credential injection and incompatible grants without sending a remote mutation", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    await x.client.registerMCPOAuth("registered");
    for (const changes of [
      { client_id: "other" },
      { client_secret: "chosen-secret" },
      { registration_client_uri: "https://evil.test" },
      { token_endpoint_auth_method: "none" },
      { grant_types: ["authorization_code"] },
    ])
      await assert.rejects(
        x.client.updateMCPRegistration("registered", changes),
      );
    assert.equal(
      peer.requests.filter((r: any) => r.method === "PUT").length,
      0,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 successful remote deletion removes registration and authorization while local reset reports no remote deletion", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    await x.client.registerMCPOAuth("registered");
    await x.client.beginMCPDeviceAuth("registered");
    const result = await x.client.deleteMCPRegistration("registered");
    assert.equal(result.remoteRegistrationDeleted, true);
    assert.equal(peer.clients.size, 0);
    assert.equal(
      (await x.client.mcpRegistration("registered")).state,
      "unregistered",
    );
    assert.equal((await x.client.mcpDeviceAuth("registered")).state, "idle");
    await x.client.registerMCPOAuth("registered");
    const local = await x.client.resetMCPRegistration("registered");
    assert.equal(local.remoteRegistrationDeleted, false);
    assert.equal(peer.clients.size, 1);
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 uncertain management outcome persists across restart and blocks replay until an acknowledged reconciliation read", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  let restored: MCPOAuth | undefined;
  try {
    const target = install(x, peer);
    await x.client.registerMCPOAuth("registered");
    peer.controls.rotateCredentials = false;
    peer.controls.manageDrop = true;
    await assert.rejects(
      x.client.updateMCPRegistration("registered", {
        client_name: "Changed remotely",
      }),
    );
    assert.equal([...peer.clients.values()][0].client_name, "Changed remotely");
    assert.equal(
      (await x.client.mcpRegistration("registered")).managementState,
      "outcome_unknown",
    );
    await assert.rejects(
      x.client.readMCPRegistration("registered"),
      /outcome unknown/,
    );
    await assert.rejects(
      x.client.resetMCPRegistration("registered"),
      /acknowledge/,
    );
    assert.equal(
      peer.requests.filter((r: any) => r.path.startsWith("/clients/")).length,
      1,
    );
    x.kernel.mcp.oauth!.close();
    restored = new MCPOAuth(x.config);
    await assert.rejects(
      restored.registrations.credentials(target),
      /outcome unknown/,
    );
    peer.controls.manageDrop = false;
    const result = await restored.remoteRegistration(
      target,
      "GET",
      undefined,
      true,
    );
    assert.equal(result.metadata.client_name, "Changed remotely");
    assert.ok(await restored.registrations.credentials(target));
  } finally {
    restored?.close();
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 known unsupported method preserves credentials and permits an explicit retry", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    const target = install(x, peer);
    await x.client.registerMCPOAuth("registered");
    const before = await x.kernel.mcp.oauth!.registrations.credentials(target);
    peer.controls.manageStatus = 405;
    await assert.rejects(
      x.client.deleteMCPRegistration("registered"),
      /HTTP 405/,
    );
    assert.equal(
      (await x.client.mcpRegistration("registered")).managementState,
      "rejected",
    );
    assert.equal(
      (await x.kernel.mcp.oauth!.registrations.credentials(target))!
        .clientSecret,
      before!.clientSecret,
    );
    peer.controls.manageStatus = 200;
    assert.equal(
      (await x.client.readMCPRegistration("registered")).state,
      "registered",
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
for (const field of ["registration_client_uri", "client_id"])
  test(`OAuth RFC 7592 rejects a changed ${field} response and keeps the operation outcome unknown`, async () => {
    const x = await setup(),
      peer = await lifecyclePeer();
    try {
      install(x, peer);
      await x.client.registerMCPOAuth("registered");
      peer.controls.manageChange = (data: any) => {
        data[field] =
          field === "client_id"
            ? "different-client"
            : "https://unreviewed.invalid/manage";
      };
      await assert.rejects(x.client.readMCPRegistration("registered"));
      assert.equal(
        (await x.client.mcpRegistration("registered")).managementState,
        "outcome_unknown",
      );
      await assert.rejects(
        x.client.readMCPRegistration("registered"),
        /outcome unknown/,
      );
      assert.equal(
        peer.requests.filter((r: any) => r.path.startsWith("/clients/")).length,
        1,
      );
    } finally {
      await x.close();
      await peer.close();
    }
  });
test("OAuth RFC 7592 cannot race configuration replacement, local reset or another remote mutation", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    await x.client.registerMCPOAuth("registered");
    peer.controls.manageDelay = 180;
    const pending = x.client.readMCPRegistration("registered");
    await until(() =>
      peer.requests.some((r: any) => r.path.startsWith("/clients/")),
    );
    await assert.rejects(
      x.client.resetMCPRegistration("registered"),
      /in flight/,
    );
    await assert.rejects(
      x.client.updateMCPRegistration("registered", { client_name: "Race" }),
      /registration/,
    );
    assert.throws(() => install(x, peer), /finish OAuth registration/);
    await assert.rejects(
      x.kernel.mcp.remove("registered"),
      /finish OAuth registration/,
    );
    await pending;
    assert.equal(
      peer.requests.filter((r: any) => r.path.startsWith("/clients/")).length,
      1,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 is unavailable when registration returns no management credentials and rejects incomplete management pairs", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    install(x, peer);
    peer.controls.registerChange = (data: any) => {
      delete data.registration_access_token;
      delete data.registration_client_uri;
    };
    await x.client.registerMCPOAuth("registered");
    assert.equal(
      (await x.client.mcpRegistration("registered")).remoteManagement,
      false,
    );
    await assert.rejects(
      x.client.readMCPRegistration("registered"),
      /did not issue/,
    );
    assert.equal(
      peer.requests.filter((r: any) => r.path.startsWith("/clients/")).length,
      0,
    );
    await x.client.resetMCPRegistration("registered");
    peer.controls.registerChange = (data: any) => {
      delete data.registration_access_token;
    };
    await assert.rejects(x.client.registerMCPOAuth("registered"), /Incomplete/);
    assert.equal(
      (await x.client.mcpRegistration("registered")).state,
      "outcome_unknown",
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth RFC 7592 shutdown cannot commit a late credential rotation and vault files contain no plaintext credentials", async () => {
  const x = await setup(),
    peer = await lifecyclePeer();
  try {
    const target = install(x, peer);
    await x.client.registerMCPOAuth("registered");
    const credentials =
      await x.kernel.mcp.oauth!.registrations.credentials(target);
    peer.controls.manageDelay = 160;
    const pending = x.client.readMCPRegistration("registered").catch((e) => e);
    await until(() =>
      peer.requests.some((r: any) => r.path.startsWith("/clients/")),
    );
    x.kernel.mcp.oauth!.close();
    await pending;
    const root = path.join(x.config.dataDir, "mcp-oauth");
    for (const file of (await readdir(root)).filter((f) =>
      f.endsWith(".json"),
    )) {
      const text = await readFile(path.join(root, file), "utf8");
      assert.ok(!text.includes(credentials!.clientSecret!));
      assert.ok(!text.includes(credentials!.registrationAccessToken!));
    }
    const restored = new MCPOAuth(x.config);
    try {
      assert.equal(
        (await restored.registrationStatus(target)).managementState,
        "outcome_unknown",
      );
    } finally {
      restored.close();
    }
  } finally {
    await x.close();
    await peer.close();
  }
});
