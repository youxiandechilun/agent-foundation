import https from "node:https";
import { readFile } from "node:fs/promises";
import {
  generateKeyPairSync,
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { setup } from "./wire-server.js";
const [algorithm = "none", scenario = "normal"] = process.argv.slice(2),
  tls = JSON.parse(
    await readFile(new URL("./tls-fixture.json", import.meta.url), "utf8"),
  );
let origin = "",
  foundationURL = "",
  x,
  registrations = 0,
  exchanges = 0,
  metadataFetches = 0;
const grants = new Map(),
  clients = new Map(),
  refreshTokens = new Map(),
  assertionIds = new Set(),
  assertions = [],
  requests = [];
if (algorithm !== "none") {
  const pair =
    algorithm === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : algorithm === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : generateKeyPairSync("ed25519");
  process.env.FND_CIMD_TEST_KEY = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}
const server = https.createServer(
  { cert: tls.cert, key: tls.key },
  async (req, res) => {
    try {
      const url = new URL(req.url, origin),
        parts = [];
      for await (const p of req) parts.push(p);
      const raw = Buffer.concat(parts).toString();
      requests.push({ path: url.pathname, headers: req.headers, body: raw });
      const json = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/oauth/client.json") {
        metadataFetches++;
        const response = await fetch(foundationURL + url.pathname, {
          method: req.method,
          headers: {
            ...(req.headers["if-none-match"]
              ? { "If-None-Match": req.headers["if-none-match"] }
              : {}),
          },
        });
        const headers = Object.fromEntries(
          ["content-type", "cache-control", "etag"]
            .map((k) => [k, response.headers.get(k)])
            .filter(([, v]) => v),
        );
        res.writeHead(response.status, headers);
        res.end(req.method === "HEAD" ? undefined : await response.text());
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
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          registration_endpoint: origin + "/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
          ...(scenario === "bad-alg"
            ? { token_endpoint_auth_signing_alg_values_supported: ["ES256"] }
            : {}),
          client_id_metadata_document_supported:
            !scenario.startsWith("unsupported"),
          authorization_response_iss_parameter_supported: true,
        });
      if (url.pathname === "/register") {
        registrations++;
        const value = {
          ...JSON.parse(raw),
          client_id: "fallback-registered-client",
        };
        clients.set(value.client_id, value);
        return json(201, value);
      }
      if (url.pathname === "/authorize") {
        const p = url.searchParams,
          id = p.get("client_id");
        let document = clients.get(id);
        if (id.startsWith("https://")) {
          const response = await fetch(id);
          document = await response.json();
        }
        if (
          !document ||
          document.client_id !== id ||
          !document.client_name ||
          !document.redirect_uris?.includes(p.get("redirect_uri")) ||
          p.get("resource") !== origin + "/mcp" ||
          p.get("code_challenge_method") !== "S256"
        )
          return json(400, { error: "invalid_client_metadata" });
        clients.set(id, document);
        const code = "cimd-code-" + grants.size;
        grants.set(code, p);
        const callback = new URL(p.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", p.get("state"));
        callback.searchParams.set("iss", origin);
        res.writeHead(302, { Location: callback.href });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        exchanges++;
        const p = new URLSearchParams(raw),
          id = p.get("client_id"),
          document = clients.get(id);
        if (!document || p.get("resource") !== origin + "/mcp")
          return json(401, { error: "invalid_client" });
        if (document.token_endpoint_auth_method === "private_key_jwt") {
          const assertion = p.get("client_assertion"),
            [head, payload, signature] = assertion.split("."),
            header = JSON.parse(Buffer.from(head, "base64url").toString()),
            claims = JSON.parse(Buffer.from(payload, "base64url").toString()),
            jwk = document.jwks.keys.find((k) => k.kid === header.kid),
            now = Math.floor(Date.now() / 1000);
          if (
            p.get("client_assertion_type") !==
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
            !jwk ||
            jwk.alg !== header.alg ||
            claims.iss !== id ||
            claims.sub !== id ||
            claims.aud !== origin + "/token" ||
            claims.exp <= now ||
            claims.exp > now + 61 ||
            claims.iat > now ||
            assertionIds.has(claims.jti)
          )
            return json(401, { error: "invalid_client" });
          const key = createPublicKey({ key: jwk, format: "jwk" });
          if (
            !verify(
              header.alg === "EdDSA" ? null : "sha256",
              Buffer.from(head + "." + payload),
              {
                key,
                ...(header.alg === "ES256"
                  ? { dsaEncoding: "ieee-p1363" }
                  : {}),
              },
              Buffer.from(signature, "base64url"),
            )
          )
            return json(401, { error: "invalid_client" });
          assertionIds.add(claims.jti);
          assertions.push({
            alg: header.alg,
            kid: header.kid,
            aud: claims.aud,
            jti: claims.jti,
            valid: true,
          });
        }
        if (p.get("client_secret") || req.headers.authorization)
          return json(400, { error: "shared_secret_prohibited" });
        const refresh = p.get("grant_type") === "refresh_token";
        if (refresh) {
          if (refreshTokens.get(p.get("refresh_token")) !== id)
            return json(400, { error: "invalid_grant" });
          refreshTokens.delete(p.get("refresh_token"));
        } else {
          const grant = grants.get(p.get("code"));
          grants.delete(p.get("code"));
          if (
            !grant ||
            grant.get("client_id") !== id ||
            p.get("redirect_uri") !== grant.get("redirect_uri") ||
            createHash("sha256")
              .update(p.get("code_verifier") || "")
              .digest("base64url") !== grant.get("code_challenge")
          )
            return json(400, { error: "invalid_grant" });
        }
        const next = "cimd-refresh-" + exchanges;
        refreshTokens.set(next, id);
        return json(200, {
          access_token: "cimd-access-" + exchanges,
          refresh_token: next,
          token_type: "Bearer",
          expires_in: refresh ? 3600 : 1,
          scope: "read",
        });
      }
      json(404, {});
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "fixture_failure", message: String(e) }));
    }
  },
);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
  x = await setup();
  foundationURL = x.api.url;
  const declaration = x.kernel.mcp.install({
    id: "cimd",
    name: "CIMD integration",
    transport: "http",
    url: origin + "/mcp",
    oauth: {
      redirectUri: "http://127.0.0.1:43113/callback",
      allowedIssuers: [origin],
      allowLoopbackHttp: true,
      clientMetadata: {
        clientId: origin + "/oauth/client.json",
        clientName: "Foundation TLS integration",
        ...(scenario === "managed" ? { cacheMaxAge: 0 } : {}),
        authentication:
          algorithm === "none"
            ? { method: "none" }
            : scenario === "managed"
              ? {
                  method: "private_key_jwt",
                  alg: algorithm,
                  managed: {
                    rotationIntervalSeconds: 180,
                    prepublishSeconds: 60,
                    retainSeconds: 120,
                  },
                }
              : {
                  method: "private_key_jwt",
                  privateKeyEnv: "FND_CIMD_TEST_KEY",
                  alg: algorithm,
                  kid: "test-key",
                },
      },
      ...(scenario === "unsupported-fallback"
        ? { registration: { mode: "dynamic" } }
        : {}),
    },
  });
  const target = {
    id: declaration.id,
    url: declaration.url,
    oauth: declaration.oauth,
  };
  if (scenario === "unsupported" || scenario === "bad-alg") {
    let error;
    try {
      await x.client.beginMCPOAuth("cimd");
    } catch (e) {
      error = e.message;
    }
    console.log(JSON.stringify({ error, registrations, exchanges }));
  } else {
    const publicResponse = await fetch(origin + "/oauth/client.json"),
      doc = await publicResponse.json(),
      etag = publicResponse.headers.get("etag"),
      notModified = await fetch(origin + "/oauth/client.json", {
        headers: { "If-None-Match": etag },
      }),
      head = await fetch(origin + "/oauth/client.json", { method: "HEAD" });
    const unauthorized = await fetch(foundationURL + "/v1/mcp");
    const begin = await x.client.beginMCPOAuth("cimd"),
      authorization = new URL(begin.authorizationUrl),
      redirect = await fetch(begin.authorizationUrl, { redirect: "manual" }),
      callback = redirect.headers.get("location");
    if (!callback)
      throw Error("CIMD authorization rejected by real HTTPS peer");
    const completed = await x.client.completeMCPOAuth("cimd", callback),
      values = await Promise.all(
        Array.from({ length: 5 }, () =>
          x.kernel.mcp.oauth.authorization(target),
        ),
      ),
      status = await x.client.mcpRegistration("cimd");
    let rotation;
    if (scenario === "managed") {
      const before = await x.client.mcpOAuthKeys("cimd"),
        staged = await x.client.rotateMCPOAuthKeys("cimd");
      await fetch(origin + "/oauth/client.json", { method: "HEAD" });
      const afterHead = await x.client.mcpOAuthKeys("cimd");
      const publication = await fetch(origin + "/oauth/client.json"),
        published = await publication.json();
      const announced = await x.client.mcpOAuthKeys("cimd");
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(
            1,
            Date.parse(announced.pending.activateAfter) - Date.now() + 100,
          ),
        ),
      );
      const next = await x.client.beginMCPOAuth("cimd"),
        secondRedirect = await fetch(next.authorizationUrl, {
          redirect: "manual",
        });
      await x.client.completeMCPOAuth(
        "cimd",
        secondRedirect.headers.get("location"),
      );
      await x.kernel.mcp.oauth.authorization(target);
      const after = await x.client.mcpOAuthKeys("cimd"),
        current = await (await fetch(origin + "/oauth/client.json")).json();
      rotation = {
        before,
        staged,
        afterHead,
        publishedKids: published.jwks.keys.map((k) => k.kid),
        announced,
        after,
        currentKids: current.jwks.keys.map((k) => k.kid),
        changedETag: etag !== publication.headers.get("etag"),
      };
    }
    console.log(
      JSON.stringify({
        algorithm,
        scenario,
        document: doc,
        cacheControl: publicResponse.headers.get("cache-control"),
        notModified: notModified.status,
        headStatus: head.status,
        headBytes: (await head.arrayBuffer()).byteLength,
        unauthorized: unauthorized.status,
        authorizationClientId: authorization.searchParams.get("client_id"),
        clientId: target.oauth.clientMetadata.clientId,
        authorized: completed.authorized,
        clientMode: completed.clientMode,
        refreshes: exchanges - 1,
        accessMatches: values.every((v) => v === values[0]),
        registrations,
        exchanges,
        metadataFetches,
        assertions,
        status,
        rotation,
        privateMaterialExposed:
          JSON.stringify(doc).includes("PRIVATE KEY") ||
          !!doc.jwks?.keys.some((k) => k.d || k.p || k.q),
        tokenHeadersSafe: requests
          .filter((r) => r.path !== "/oauth/client.json")
          .every((r) => !r.headers["x-foundation-token"]),
      }),
    );
  }
} finally {
  delete process.env.FND_CIMD_TEST_KEY;
  if (x) await x.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}
