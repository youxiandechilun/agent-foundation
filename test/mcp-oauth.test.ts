import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setup, until } from "./support/wire-server.js";

async function authorizationPeer() {
  let origin = "",
    serial = 0,
    refreshes = 0,
    exchanges = 0,
    invalidRefresh = false,
    requireScope = false,
    effects = 0;
  const requests: any[] = [],
    grants = new Map<string, URLSearchParams>(),
    refreshTokens = new Set<string>(),
    accessTokens = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, origin),
      chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const text = Buffer.concat(chunks).toString();
    requests.push({ url: url.pathname, headers: req.headers, text });
    const json = (
      status: number,
      data: any,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json(200, {
        resource: origin + "/mcp",
        authorization_servers: [origin],
        scopes_supported: ["read"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (
        p.get("resource") !== origin + "/mcp" ||
        p.get("code_challenge_method") !== "S256"
      )
        return json(400, { error: "invalid_request" });
      const code = "fixture-authorization-code-" + ++serial;
      grants.set(code, p);
      const callback = new URL(p.get("redirect_uri")!);
      callback.searchParams.set("state", p.get("state")!);
      callback.searchParams.set("code", code);
      callback.searchParams.set("iss", origin);
      res.writeHead(302, { Location: callback.href });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      exchanges++;
      const p = new URLSearchParams(text);
      if (p.get("resource") !== origin + "/mcp")
        return json(400, { error: "invalid_target" });
      const refresh = p.get("grant_type") === "refresh_token";
      if (refresh) {
        refreshes++;
        const value = p.get("refresh_token")!;
        if (invalidRefresh || !refreshTokens.delete(value))
          return json(400, { error: "invalid_grant" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        const grant = grants.get(p.get("code")!);
        grants.delete(p.get("code")!);
        if (
          !grant ||
          createHash("sha256")
            .update(p.get("code_verifier") || "")
            .digest("base64url") !== grant.get("code_challenge") ||
          p.get("redirect_uri") !== grant.get("redirect_uri")
        )
          return json(400, { error: "invalid_grant" });
      }
      const access = "fixture-access-token-" + ++serial,
        next = "fixture-refresh-token-" + serial;
      accessTokens.add(access);
      refreshTokens.add(next);
      return json(200, {
        access_token: access,
        refresh_token: next,
        token_type: "Bearer",
        expires_in: refresh ? 3600 : 1,
        scope: "read",
      });
    }
    if (url.pathname === "/mcp") {
      const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!accessTokens.has(bearer))
        return json(
          401,
          {},
          {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"`,
          },
        );
      if (requireScope)
        return json(
          403,
          {},
          {
            "WWW-Authenticate": `Bearer error="insufficient_scope", scope="write", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
      const m = JSON.parse(text);
      let result: any;
      if (m.method === "server/discover")
        result = {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        };
      else if (m.method === "tools/list")
        result = {
          tools: [{ name: "effect", inputSchema: { type: "object" } }],
        };
      else {
        effects++;
        result = {
          content: [{ type: "text", text: "actual authorized peer effect" }],
        };
      }
      return json(200, { jsonrpc: "2.0", id: m.id, result });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const oauth = {
    clientId: "registered-foundation-client",
    redirectUri: "http://127.0.0.1:43111/callback",
    allowedIssuers: [origin],
    allowLoopbackHttp: true,
  };
  return {
    origin,
    oauth,
    requests,
    counts: () => ({ refreshes, exchanges, effects }),
    invalidate: () => {
      invalidRefresh = true;
    },
    stepUp: () => {
      requireScope = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function grant(
  x: Awaited<ReturnType<typeof setup>>,
  _peer: Awaited<ReturnType<typeof authorizationPeer>>,
) {
  const begin = await x.client.request("POST", "/v1/mcp/authpeer/auth-begin");
  const response = await fetch(begin.authorizationUrl, { redirect: "manual" });
  return response.headers.get("location")!;
}
function install(
  x: Awaited<ReturnType<typeof setup>>,
  peer: Awaited<ReturnType<typeof authorizationPeer>>,
  change: any = {},
) {
  return x.kernel.mcp.install({
    id: "authpeer",
    name: "auth peer",
    transport: "http",
    url: peer.origin + "/mcp",
    oauth: peer.oauth,
    ...change,
  });
}
test("source OAuth performs real PKCE exchange, encrypts tokens and refreshes once across concurrent MCP requests", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    const declaration = install(x, peer),
      callback = await grant(x, peer);
    const status = await x.client.request(
      "POST",
      "/v1/mcp/authpeer/auth-complete",
      { callbackUrl: callback },
    );
    assert.equal(status.authorized, true);
    await assert.rejects(
      x.client.request("POST", "/v1/mcp/authpeer/auth-complete", {
        callbackUrl: callback,
      }),
      /state/,
    );
    const target = {
      id: declaration.id,
      url: declaration.url!,
      oauth: declaration.oauth!,
    };
    const headers = await Promise.all(
      Array.from({ length: 12 }, () =>
        x.kernel.mcp.oauth!.authorization(target),
      ),
    );
    assert.ok(headers.every((value) => value === headers[0]));
    assert.equal(peer.counts().refreshes, 1);
    await x.kernel.mcp.connect("authpeer");
    const tools = await x.kernel.mcp.tools();
    assert.equal(tools.length, 1);
    const result = await tools[0].execute("call", {});
    assert.ok(JSON.stringify(result).includes("actual authorized"));
    assert.equal(peer.counts().effects, 1);
    const vault = await readFile(
      path.join(x.config.dataDir, "mcp-oauth", "authpeer.json"),
      "utf8",
    );
    assert.ok(
      !vault.includes("fixture-access") && !vault.includes("fixture-refresh"),
    );
    assert.ok(
      peer.requests
        .filter((r) => r.url.includes("well-known"))
        .every((r) => !r.headers.authorization),
    );
    await x.client.request("DELETE", "/v1/mcp/authpeer/auth");
    assert.equal((await x.kernel.mcp.authStatus("authpeer")).authorized, false);
    await assert.rejects(x.kernel.mcp.oauth!.authorization(target), /required/);
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth rejects state substitution, issuer mix-up and redirect mismatch before sending a token exchange", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    install(x, peer);
    const callback = await grant(x, peer);
    const altered = new URL(callback);
    altered.searchParams.set("iss", peer.origin + "/");
    await assert.rejects(
      x.kernel.mcp.authComplete("authpeer", altered.href),
      /issuer mismatch/,
    );
    assert.equal(peer.counts().exchanges, 0);
    const callback2 = await grant(x, peer),
      bad = new URL(callback2);
    bad.pathname = "/different";
    await assert.rejects(
      x.kernel.mcp.authComplete("authpeer", bad.href),
      /redirect/,
    );
    assert.equal(peer.counts().exchanges, 0);
    const wrongState = new URL(callback2);
    wrongState.searchParams.set("state", "attacker-state");
    await assert.rejects(
      x.kernel.mcp.authComplete("authpeer", wrongState.href),
      /state/,
    );
    await x.kernel.mcp.authComplete("authpeer", callback2);
    assert.equal(peer.counts().exchanges, 1);
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth invalid_grant clears local authorization and never retries the uncertain tool effect", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    install(x, peer);
    await x.kernel.mcp.authComplete("authpeer", await grant(x, peer));
    peer.invalidate();
    await assert.rejects(x.kernel.mcp.connect("authpeer"), /invalid_grant/);
    assert.equal((await x.kernel.mcp.authStatus("authpeer")).authorized, false);
    assert.equal(peer.counts().refreshes, 1);
    assert.equal(peer.counts().effects, 0);
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth scope challenges require explicit reauthorization and do not replay a tool call", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    install(x, peer);
    await x.kernel.mcp.authComplete("authpeer", await grant(x, peer));
    await x.kernel.mcp.connect("authpeer");
    const [tool] = await x.kernel.mcp.tools();
    peer.stepUp();
    await assert.rejects(tool.execute("once", {}), /scope upgrade/);
    assert.equal(peer.counts().effects, 0);
    const begin = await x.kernel.mcp.authBegin("authpeer"),
      scopes = new URL(begin.authorizationUrl).searchParams
        .get("scope")!
        .split(" ");
    assert.ok(scopes.includes("read") && scopes.includes("write"));
    assert.equal(
      peer.requests.filter(
        (r) => r.url === "/mcp" && r.text.includes('"tools/call"'),
      ).length,
      1,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});
test("OAuth tokens are bound to the reviewed resource and HTTP or unapproved issuers are rejected", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    const d = install(x, peer);
    await x.kernel.mcp.authComplete("authpeer", await grant(x, peer));
    const changed = { id: d.id, url: peer.origin + "/other", oauth: d.oauth! };
    assert.equal((await x.kernel.mcp.oauth!.status(changed)).authorized, false);
    install(x, peer, { oauth: { ...peer.oauth, allowLoopbackHttp: false } });
    await assert.rejects(x.kernel.mcp.authBegin("authpeer"), /HTTPS/);
    install(x, peer, {
      oauth: { ...peer.oauth, allowedIssuers: [peer.origin + "/unapproved"] },
    });
    await assert.rejects(x.kernel.mcp.authBegin("authpeer"), /allowlist/);
    assert.equal(peer.counts().exchanges, 1);
  } finally {
    await x.close();
    await peer.close();
  }
});

test("revoking OAuth while a refresh is in flight cannot restore the token vault", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    const d = install(x, peer);
    await x.kernel.mcp.authComplete("authpeer", await grant(x, peer));
    const target = { id: d.id, url: d.url!, oauth: d.oauth! },
      pending = x.kernel.mcp.oauth!.authorization(target);
    void pending.catch(() => undefined);
    await until(() => peer.counts().refreshes === 1);
    await x.kernel.mcp.authClear("authpeer");
    await assert.rejects(pending, /revoked/);
    assert.equal((await x.kernel.mcp.authStatus("authpeer")).authorized, false);
    await assert.rejects(
      readFile(path.join(x.config.dataDir, "mcp-oauth", "authpeer.json")),
      /ENOENT/,
    );
  } finally {
    await x.close();
    await peer.close();
  }
});

test("closing the MCP host aborts pending OAuth refresh instead of leaving background authorization work", async () => {
  const x = await setup(),
    peer = await authorizationPeer();
  try {
    const d = install(x, peer);
    await x.kernel.mcp.authComplete("authpeer", await grant(x, peer));
    const target = { id: d.id, url: d.url!, oauth: d.oauth! },
      pending = x.kernel.mcp.oauth!.authorization(target);
    void pending.catch(() => undefined);
    await until(() => peer.counts().refreshes === 1);
    await x.kernel.mcp.close();
    await assert.rejects(pending, /closed|abort/);
    await assert.rejects(x.kernel.mcp.oauth!.authorization(target), /closed/);
  } finally {
    await x.close();
    await peer.close();
  }
});
