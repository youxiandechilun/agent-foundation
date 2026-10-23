import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MCPOAuth, oauthSchema } from "../src/extensions/mcp/auth/oauth.js";
import { setup, until } from "./support/wire-server.js";
import { registrationPeer } from "./support/oauth-registration.js";
function install(
  x: Awaited<ReturnType<typeof setup>>,
  peer: Awaited<ReturnType<typeof registrationPeer>>,
  extra: any = {},
) {
  const declaration = x.kernel.mcp.install({
    id: "dynamic",
    name: "Dynamic",
    transport: "http",
    url: peer.origin + "/mcp",
    oauth: {
      redirectUri: "http://127.0.0.1:43112/oauth",
      allowedIssuers: [peer.origin],
      allowLoopbackHttp: true,
      registration: { mode: "dynamic", ...extra },
    },
  });
  return {
    id: declaration.id,
    url: declaration.url!,
    oauth: declaration.oauth!,
  };
}
for (const method of ["none", "client_secret_basic", "client_secret_post"])
  test(`OAuth dynamic ${method} client completes actual registration, PKCE and refresh without SDKs`, async () => {
    const x = await setup(),
      peer = await registrationPeer();
    try {
      const target = install(x, peer, { tokenEndpointAuthMethod: method }),
        begin = await x.client.beginMCPOAuth("dynamic");
      assert.equal(peer.counts().registrations, 1);
      const callback = (
        await fetch(begin.authorizationUrl, { redirect: "manual" })
      ).headers.get("location")!;
      assert.equal(
        (await x.client.completeMCPOAuth("dynamic", callback)).authorized,
        true,
      );
      const values = await Promise.all(
        Array.from({ length: 6 }, () =>
          x.kernel.mcp.oauth!.authorization(target),
        ),
      );
      assert.ok(values.every((v) => v === values[0]));
      assert.equal(peer.counts().refreshes, 1);
      const status = await x.client.dynamicRegistration("dynamic");
      assert.equal(status.state, "registered");
      assert.equal(status.authMethod, method);
      assert.ok(!JSON.stringify(status).includes("registration-secret"));
      const files = await readdir(path.join(x.config.dataDir, "mcp-oauth"));
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        const text = await readFile(
          path.join(x.config.dataDir, "mcp-oauth", file),
          "utf8",
        );
        assert.ok(!text.includes("registration-secret"));
        assert.ok(!text.includes("registration-access"));
      }
      await x.client.request("DELETE", "/v1/mcp/dynamic/auth");
      await x.client.beginMCPOAuth("dynamic");
      assert.equal(peer.counts().registrations, 1);
    } finally {
      await x.close();
      await peer.close();
    }
  });
test("OAuth DCR deduplicates concurrent registration and reuses encrypted credentials after host restart", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  let restored: MCPOAuth | undefined;
  try {
    const target = install(x, peer);
    peer.controls.delayMs = 80;
    const values = await Promise.all(
      Array.from({ length: 10 }, () => x.client.registerMCPOAuth("dynamic")),
    );
    assert.equal(peer.counts().registrations, 1);
    assert.ok(values.every((v) => v.clientId === values[0].clientId));
    x.kernel.mcp.oauth!.close();
    restored = new MCPOAuth(x.config);
    const begin = await restored.begin(target);
    assert.equal(
      new URL(begin.authorizationUrl).searchParams.get("client_id"),
      values[0].clientId,
    );
    assert.equal(peer.counts().registrations, 1);
  } finally {
    restored?.close();
    await x.close();
    await peer.close();
  }
});
test("OAuth DCR scopes initial access tokens and software statements to the reviewed registration POST", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  process.env.FND_REG_INITIAL = "registration-initial-test-token";
  process.env.FND_REG_STATEMENT = "fixture.signed.statement";
  try {
    peer.controls.initialToken = process.env.FND_REG_INITIAL;
    install(x, peer, {
      initialAccessTokenEnv: "FND_REG_INITIAL",
      softwareStatementEnv: "FND_REG_STATEMENT",
    });
    await x.client.registerMCPOAuth("dynamic");
    const request = peer.requests.find((r) => r.path === "/register");
    assert.equal(
      request.headers.authorization,
      "Bearer " + process.env.FND_REG_INITIAL,
    );
    assert.equal(
      JSON.parse(request.text).software_statement,
      process.env.FND_REG_STATEMENT,
    );
    assert.ok(
      peer.requests
        .filter((r) => r.path !== "/register")
        .every(
          (r) =>
            !r.headers.authorization &&
            !r.text.includes("fixture.signed.statement"),
        ),
    );
    assert.ok(
      !JSON.stringify(x.kernel.mcp.list()).includes(
        "registration-initial-test-token",
      ),
    );
  } finally {
    delete process.env.FND_REG_INITIAL;
    delete process.env.FND_REG_STATEMENT;
    await x.close();
    await peer.close();
  }
});
test("OAuth DCR uncertain network outcome survives restart and requires explicit acknowledgement before retry", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  let restored: MCPOAuth | undefined;
  try {
    const target = install(x, peer);
    peer.controls.drop = true;
    await assert.rejects(
      x.client.registerMCPOAuth("dynamic"),
      /fetch|socket|failed/,
    );
    assert.equal(
      (await x.client.dynamicRegistration("dynamic")).state,
      "outcome_unknown",
    );
    x.kernel.mcp.oauth!.close();
    restored = new MCPOAuth(x.config);
    await assert.rejects(restored.begin(target), /outcome unknown/);
    assert.equal(peer.counts().registrations, 1);
    await assert.rejects(restored.resetRegistration(target), /acknowledge/);
    peer.controls.drop = false;
    const reset = await restored.resetRegistration(target, true);
    assert.equal(reset.remoteRegistrationDeleted, false);
    await restored.begin(target);
    assert.equal(peer.counts().registrations, 2);
  } finally {
    restored?.close();
    await x.close();
    await peer.close();
  }
});
for (const mismatch of ["redirect", "auth", "grant", "missing-secret"])
  test(`OAuth DCR rejects ${mismatch} response changes and prevents automatic re-registration`, async () => {
    const x = await setup(),
      peer = await registrationPeer();
    try {
      install(x, peer, {
        tokenEndpointAuthMethod:
          mismatch === "missing-secret" ? "client_secret_post" : "none",
      });
      peer.controls.change = (d) => {
        if (mismatch === "redirect")
          return {
            ...d,
            redirect_uris: [
              ...d.redirect_uris,
              "https://unreviewed.example/callback",
            ],
          };
        if (mismatch === "auth")
          return { ...d, token_endpoint_auth_method: "client_secret_post" };
        if (mismatch === "grant")
          return { ...d, grant_types: ["authorization_code", "password"] };
        delete d.client_secret;
        return d;
      };
      await assert.rejects(
        x.client.registerMCPOAuth("dynamic"),
        /Registration|secret|authentication/,
      );
      assert.equal(
        (await x.client.dynamicRegistration("dynamic")).state,
        "outcome_unknown",
      );
      await assert.rejects(
        x.client.beginMCPOAuth("dynamic"),
        /outcome unknown/,
      );
      assert.equal(peer.counts().registrations, 1);
      assert.equal(peer.counts().exchanges, 0);
    } finally {
      await x.close();
      await peer.close();
    }
  });
test("OAuth DCR denies unreviewed endpoint origins and rejects contradictory registration configuration", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  try {
    const target = install(x, peer);
    peer.controls.endpoint = "https://unreviewed.example/register";
    await assert.rejects(
      x.client.registerMCPOAuth("dynamic"),
      /outside reviewed/,
    );
    assert.equal(peer.counts().registrations, 0);
    assert.throws(
      () => oauthSchema.parse({ ...target.oauth, clientId: "existing" }),
      /Choose/,
    );
    assert.throws(
      () => oauthSchema.parse({ ...target.oauth, clientSecretEnv: "SECRET" }),
      /manages its own/,
    );
    assert.throws(
      () => oauthSchema.parse({ ...target.oauth, registration: undefined }),
      /Choose/,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth DCR known rejection permits an explicit retry and local reset preserves truthful remote status", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  try {
    install(x, peer);
    peer.controls.status = 400;
    await assert.rejects(
      x.client.registerMCPOAuth("dynamic"),
      /registration failed/,
    );
    assert.equal(
      (await x.client.dynamicRegistration("dynamic")).state,
      "rejected",
    );
    peer.controls.status = 201;
    await x.client.registerMCPOAuth("dynamic");
    assert.equal(peer.counts().registrations, 2);
    const reset = await x.client.resetMCPRegistration("dynamic");
    assert.equal(reset.remoteRegistrationDeleted, false);
    assert.equal(
      (await x.client.dynamicRegistration("dynamic")).state,
      "unregistered",
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth DCR configuration replacement and reset cannot race an in-flight registration", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  try {
    install(x, peer);
    peer.controls.delayMs = 150;
    const pending = x.client.registerMCPOAuth("dynamic");
    await until(() => peer.counts().registrations === 1);
    assert.throws(() => install(x, peer), /registration/);
    await assert.rejects(x.client.resetMCPRegistration("dynamic"), /in flight/);
    await pending;
    peer.controls.metadataDelay = 120;
    const begin = x.client.beginMCPOAuth("dynamic");
    await until(
      () =>
        peer.requests.filter(
          (r) => r.path === "/.well-known/oauth-authorization-server",
        ).length >= 2,
    );
    install(x, peer, { clientName: "Changed" });
    await assert.rejects(begin, /changed during discovery/);
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth DCR host shutdown leaves an uncertain attempt instead of committing late credentials", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  let restored: MCPOAuth | undefined;
  try {
    const target = install(x, peer);
    peer.controls.delayMs = 150;
    const pending = x.kernel.mcp.oauth!.register(target);
    await until(() => peer.counts().registrations === 1);
    x.kernel.mcp.oauth!.close();
    await assert.rejects(pending, /closed|abort/i);
    restored = new MCPOAuth(x.config);
    assert.equal(
      (await restored.registrations.status(target)).state,
      "outcome_unknown",
    );
    await assert.rejects(restored.begin(target), /outcome unknown/);
    assert.equal(peer.counts().registrations, 1);
  } finally {
    restored?.close();
    await x.close();
    await peer.close();
  }
});
test("OAuth DCR server failure is not replayed and expired client secrets require an explicit reset", async () => {
  const x = await setup(),
    peer = await registrationPeer();
  try {
    install(x, peer, { tokenEndpointAuthMethod: "client_secret_post" });
    peer.controls.status = 503;
    await assert.rejects(
      x.client.registerMCPOAuth("dynamic"),
      /registration failed/,
    );
    peer.controls.status = 201;
    await assert.rejects(x.client.beginMCPOAuth("dynamic"), /outcome unknown/);
    assert.equal(peer.counts().registrations, 1);
    await x.client.resetMCPRegistration("dynamic", true);
    peer.controls.change = (d) => ({
      ...d,
      client_secret_expires_at: Math.floor(Date.now() / 1000) - 1,
    });
    await x.client.registerMCPOAuth("dynamic");
    assert.equal((await x.client.dynamicRegistration("dynamic")).expired, true);
    await assert.rejects(x.client.beginMCPOAuth("dynamic"), /expired/);
    assert.equal(peer.counts().registrations, 2);
  } finally {
    await x.close();
    await peer.close();
  }
});
