import https from "node:https";
import { readFile } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { setup } from "./wire-server.js";
const tls = JSON.parse(
    await readFile(new URL("./tls-fixture.json", import.meta.url), "utf8"),
  ),
  managed = process.argv[2] === "managed",
  grantType = "urn:ietf:params:oauth:grant-type:device_code";
let origin = "",
  x,
  approved = false,
  exchanges = 0;
const assertions = [],
  nonces = new Set();
const server = https.createServer(
  { cert: tls.cert, key: tls.key },
  async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, origin),
        chunks = [];
      for await (const p of req) chunks.push(p);
      const p = new URLSearchParams(Buffer.concat(chunks).toString());
      if (url.pathname === "/oauth/device-client.json") {
        const r = await fetch(x.api.url + url.pathname);
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(await r.text());
        return;
      }
      if (url.pathname === "/mcp") {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json(200, {
          resource: origin + "/mcp",
          authorization_servers: [origin],
          scopes_supported: ["read"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: origin,
          token_endpoint: origin + "/token",
          device_authorization_endpoint: origin + "/device",
          grant_types_supported: [grantType, "refresh_token"],
          client_id_metadata_document_supported: true,
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
          token_endpoint_auth_signing_alg_values_supported: ["ES256"],
        });
      if (url.pathname === "/verify") {
        approved = true;
        return json(200, { approved: true });
      }
      if (url.pathname === "/device" || url.pathname === "/token") {
        const id = p.get("client_id");
        if (
          id !== origin + "/oauth/device-client.json" ||
          p.get("resource") !== origin + "/mcp"
        )
          return json(400, { error: "invalid_client" });
        const doc = await (await fetch(id)).json();
        if (doc.redirect_uris || !doc.grant_types.includes(grantType))
          return json(400, { error: "invalid_client_metadata" });
        if (managed) {
          const [h, c, s] = (p.get("client_assertion") || "").split("."),
            head = JSON.parse(Buffer.from(h, "base64url").toString()),
            claims = JSON.parse(Buffer.from(c, "base64url").toString()),
            jwk = doc.jwks.keys.find((k) => k.kid === head.kid);
          if (
            p.get("client_assertion_type") !==
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
            head.alg !== "ES256" ||
            !jwk ||
            claims.iss !== id ||
            claims.sub !== id ||
            claims.aud !== origin + url.pathname ||
            claims.exp <= Date.now() / 1000 ||
            nonces.has(claims.jti) ||
            !verify(
              "sha256",
              Buffer.from(h + "." + c),
              {
                key: createPublicKey({ key: jwk, format: "jwk" }),
                dsaEncoding: "ieee-p1363",
              },
              Buffer.from(s, "base64url"),
            )
          )
            return json(401, { error: "invalid_client" });
          nonces.add(claims.jti);
          assertions.push({ aud: claims.aud, kid: head.kid, valid: true });
        } else if (p.has("client_assertion"))
          return json(400, { error: "invalid_client" });
        if (url.pathname === "/device")
          return json(200, {
            device_code: "tls-device-private",
            user_code: "TLS-USER",
            verification_uri: origin + "/verify",
            verification_uri_complete: origin + "/verify?user_code=TLS-USER",
            expires_in: 120,
            interval: 1,
          });
        if (p.get("grant_type") === grantType) {
          if (p.get("device_code") !== "tls-device-private")
            return json(400, { error: "expired_token" });
          if (!approved) return json(400, { error: "authorization_pending" });
        } else if (
          p.get("grant_type") !== "refresh_token" ||
          p.get("refresh_token") !== "tls-device-refresh"
        )
          return json(400, { error: "invalid_grant" });
        exchanges++;
        return json(200, {
          access_token: "tls-device-access-" + exchanges,
          refresh_token: "tls-device-refresh",
          token_type: "Bearer",
          expires_in: exchanges === 1 ? 1 : 3600,
        });
      }
      json(404, {});
    } catch (e) {
      json(500, { error: "fixture_failure", message: String(e) });
    }
  },
);
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `https://127.0.0.1:${server.address().port}`;
  x = await setup();
  const d = x.kernel.mcp.install({
    id: "device-cimd",
    name: "Device CIMD",
    transport: "http",
    url: origin + "/mcp",
    oauth: {
      deviceFlow: true,
      allowedIssuers: [origin],
      clientMetadata: {
        clientId: origin + "/oauth/device-client.json",
        clientName: "Device",
        cacheMaxAge: 0,
        grantTypes: [grantType, "refresh_token"],
        authentication: managed
          ? {
              method: "private_key_jwt",
              alg: "ES256",
              managed: {
                rotationIntervalSeconds: 180,
                prepublishSeconds: 60,
                retainSeconds: 120,
              },
            }
          : { method: "none" },
      },
    },
  });
  const start = await x.client.beginMCPDeviceAuth(d.id);
  await fetch(start.verificationUriComplete);
  const result = await x.client.waitMCPDeviceAuth(d.id),
    bearer = await x.kernel.mcp.oauth.authorization({
      id: d.id,
      url: d.url,
      oauth: d.oauth,
    }),
    document = await (await fetch(origin + "/oauth/device-client.json")).json();
  console.log(
    JSON.stringify({
      state: result.state,
      exchanges,
      assertions,
      bearerMatches: bearer === "Bearer tls-device-access-2",
      clientMode: (await x.kernel.mcp.authStatus(d.id)).clientMode,
      privateMaterialExposed:
        JSON.stringify(document).includes("PRIVATE KEY") ||
        !!document.jwks?.keys.some((k) => k.d || k.p || k.q),
    }),
  );
} finally {
  if (x) await x.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r()));
}
