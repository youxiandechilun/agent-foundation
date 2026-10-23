import { keyDocument } from "./support/payloads.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import {
  clientMetadataSchema,
  clientMetadataDocument,
  clientMetadataURL,
  clientAssertion,
} from "../src/extensions/mcp/auth/client-metadata.js";
import { oauthSchema } from "../src/extensions/mcp/auth/oauth.js";
import { setup } from "./support/wire-server.js";
async function tlsFlow(algorithm: string, scenario = "normal") {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-cimd-tls-")),
    tls = JSON.parse(
      await readFile(
        new URL("./support/tls-fixture.json", import.meta.url),
        "utf8",
      ),
    ),
    cert = path.join(root, "test-ca.pem");
  await writeFile(cert, tls.cert);
  const worker = fileURLToPath(
    new URL("./support/cimd-flow.mjs", import.meta.url),
  );
  return new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, algorithm, scenario], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CIMD TLS integration timed out"));
    }, 20000);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error("CIMD TLS worker failed: " + stderr));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(Error("Invalid TLS worker output: " + stdout + stderr));
      }
    });
  });
}
for (const algorithm of ["none", "RS256", "ES256", "EdDSA"])
  test(`CIMD ${algorithm} completes PKCE and refresh over trusted HTTPS using published client metadata`, async () => {
    const value = await tlsFlow(algorithm);
    assert.equal(value.authorized, true);
    assert.equal(value.clientMode, "metadata");
    assert.equal(value.authorizationClientId, value.clientId);
    assert.equal(value.document.client_id, value.clientId);
    assert.equal(value.registrations, 0);
    assert.equal(value.exchanges, 2);
    assert.equal(value.refreshes, 1);
    assert.equal(value.accessMatches, true);
    assert.equal(value.privateMaterialExposed, false);
    assert.equal(value.notModified, 304);
    assert.equal(value.headStatus, 200);
    assert.equal(value.headBytes, 0);
    assert.equal(value.unauthorized, 401);
    assert.match(value.cacheControl, /max-age=300/);
    assert.ok(value.metadataFetches >= 4);
    assert.equal(value.status.externalHostingVerified, false);
    if (algorithm !== "none") {
      assert.equal(
        value.document.token_endpoint_auth_method,
        "private_key_jwt",
      );
      assert.equal(value.assertions.length, 2);
      assert.ok(
        value.assertions.every((a: any) => a.alg === algorithm && a.valid),
      );
      assert.notEqual(value.assertions[0].jti, value.assertions[1].jti);
    } else assert.equal(value.document.token_endpoint_auth_method, "none");
  });
test("CIMD refuses an unsupported authorization server without silently registering another client", async () => {
  const value = await tlsFlow("none", "unsupported");
  assert.match(value.error, /does not support Client ID Metadata/);
  assert.equal(value.registrations, 0);
  assert.equal(value.exchanges, 0);
});
test("CIMD uses explicit DCR fallback only when metadata support is absent", async () => {
  const value = await tlsFlow("none", "unsupported-fallback");
  assert.equal(value.authorized, true);
  assert.equal(value.clientMode, "dynamic");
  assert.equal(value.registrations, 1);
  assert.equal(value.authorizationClientId, "fallback-registered-client");
  assert.equal(value.status.fallbackRegistration.state, "registered");
});
test("CIMD configuration rejects insecure or ambiguous client identifiers before publication", () => {
  for (const url of [
    "http://127.0.0.1/client.json",
    "https://metadata.example/",
    "https://user:pass@metadata.example/client.json",
    "https://metadata.example/client.json#fragment",
    "https://metadata.example/client.json?query=1",
    "https://metadata.example/a/../client.json",
    "https://metadata.example/a/%2e%2e/client.json",
    "https://metadata.example/a\\client.json",
  ])
    assert.throws(() => clientMetadataURL(url));
  assert.equal(
    clientMetadataURL("https://metadata.example/oauth/client.json").pathname,
    "/oauth/client.json",
  );
});
test("CIMD documents include the exact callback and prohibit shared-secret authentication", () => {
  const parsed = clientMetadataSchema.parse({
    clientId: "https://metadata.example/client.json",
    clientName: "App",
    redirectUris: ["https://app.example/wrong"],
  });
  assert.throws(
    () => clientMetadataDocument(parsed, "http://127.0.0.1:4317/callback"),
    /configured OAuth callback/,
  );
  assert.throws(() =>
    clientMetadataSchema.parse({
      ...parsed,
      authentication: { method: "client_secret_basic" },
    }),
  );
  assert.throws(() =>
    clientMetadataSchema.parse({ ...parsed, client_secret: "forbidden" }),
  );
  assert.throws(
    () =>
      oauthSchema.parse({
        clientMetadata: parsed,
        clientSecretEnv: "SECRET",
        redirectUri: "https://app.example/wrong",
        allowedIssuers: ["https://as.example"],
      }),
    /prohibits shared secrets/,
  );
});
test("CIMD private key JWT uses public JWKS and a short audience-bound assertion with unique IDs", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FND_CIMD_KEY = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  try {
    const config = clientMetadataSchema.parse({
        clientId: "https://metadata.example/client.json",
        clientName: "App",
        authentication: {
          method: "private_key_jwt",
          privateKeyEnv: "FND_CIMD_KEY",
          alg: "RS256",
          kid: "own-key",
        },
      }),
      document = clientMetadataDocument(
        config,
        "http://127.0.0.1:4317/callback",
      ),
      one = clientAssertion(config, "https://as.example/token"),
      two = clientAssertion(config, "https://as.example/token"),
      [header, payload, signature] = one.split("."),
      claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(keyDocument(document).jwks.keys[0].d, undefined);
    assert.equal(claims.iss, config.clientId);
    assert.equal(claims.sub, config.clientId);
    assert.equal(claims.aud, "https://as.example/token");
    assert.equal(claims.exp - claims.iat, 60);
    assert.notEqual(one, two);
    assert.ok(
      verify(
        "sha256",
        Buffer.from(header + "." + payload),
        createPublicKey({
          key: keyDocument(document).jwks.keys[0],
          format: "jwk",
        }),
        Buffer.from(signature, "base64url"),
      ),
    );
    assert.throws(
      () =>
        clientAssertion(
          {
            ...config,
            authentication: {
              method: "private_key_jwt",
              privateKeyEnv: "FND_CIMD_KEY",
              alg: "ES256",
              kid: "bad",
            },
          },
          "https://as.example/token",
        ),
      /algorithm does not match/,
    );
  } finally {
    delete process.env.FND_CIMD_KEY;
  }
});
test("CIMD public endpoint exposes only the configured document and rejects conflicting paths", async () => {
  const x = await setup();
  const input = (id: string, name: string, path = "/oauth/client.json") => ({
    id,
    name,
    transport: "http",
    url: "https://mcp.example/mcp",
    oauth: {
      clientMetadata: {
        clientId: "https://metadata.example" + path,
        clientName: name,
      },
      redirectUri: "http://127.0.0.1:4317/callback",
      allowedIssuers: ["https://as.example"],
      allowLoopbackHttp: true,
    },
  });
  try {
    x.kernel.mcp.install(input("one", "One"));
    const response = await fetch(x.api.url + "/oauth/client.json", {
        headers: { Host: "untrusted.example" },
      }),
      document = await response.json();
    assert.equal(response.status, 200);
    assert.equal(
      document.client_id,
      "https://metadata.example/oauth/client.json",
    );
    assert.equal(document.client_name, "One");
    assert.ok(!JSON.stringify(document).includes("allowedIssuers"));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.throws(
      () => x.kernel.mcp.install(input("two", "Different")),
      /Conflicting public/,
    );
    assert.throws(
      () => x.kernel.mcp.install(input("three", "Reserved", "/v1/secrets")),
      /reserved/,
    );
    await x.kernel.mcp.remove("one");
    assert.equal((await fetch(x.api.url + "/oauth/client.json")).status, 401);
  } finally {
    await x.close();
  }
});
test("CIMD can export a document for external HTTPS hosting without exposing a local public endpoint", async () => {
  const x = await setup();
  try {
    const declaration = x.kernel.mcp.install({
      id: "external",
      name: "External CIMD",
      transport: "http",
      url: "https://mcp.example/mcp",
      oauth: {
        redirectUri: "https://app.example/callback",
        allowedIssuers: ["https://as.example"],
        clientMetadata: {
          clientId: "https://metadata.example/app.json",
          clientName: "External",
          publish: false,
        },
      },
    });
    assert.equal((await fetch(x.api.url + "/app.json")).status, 401);
    const document = clientMetadataDocument(
      declaration.oauth!.clientMetadata!,
      declaration.oauth!.redirectUri,
    );
    assert.equal(document.client_id, "https://metadata.example/app.json");
    assert.equal(
      (
        (await x.client.mcpRegistration("external")) as {
          publicationConfigured: boolean;
        }
      ).publicationConfigured,
      false,
    );
  } finally {
    await x.close();
  }
});
test("CIMD rejects a client assertion algorithm excluded by authorization server metadata", async () => {
  const value = await tlsFlow("RS256", "bad-alg");
  assert.match(value.error, /does not support.*signing algorithm/);
  assert.equal(value.registrations, 0);
  assert.equal(value.exchanges, 0);
});
