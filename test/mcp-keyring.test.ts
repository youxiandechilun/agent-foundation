import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OAuthVault } from "../src/extensions/oauth-vault.js";
import { MCPKeyring } from "../src/extensions/mcp-keyring.js";
import { clientMetadataSchema } from "../src/extensions/mcp-client-metadata.js";
import {
  hash,
  registerSecret,
  redactSecrets,
  processSecretSnapshot,
} from "../src/util.js";
import { setup } from "./support/wire-server.js";
test("OAuth short-lived assertion redaction expires without removing persistent credential redaction", async () => {
  const ephemeral = "ephemeral-assertion-" + randomBytes(20).toString("hex"),
    persistent = "persistent-credential-" + randomBytes(20).toString("hex");
  registerSecret(ephemeral, 35);
  registerSecret(persistent);
  assert.equal(redactSecrets(ephemeral), "[REDACTED]");
  assert.ok(processSecretSnapshot().includes(ephemeral));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!processSecretSnapshot().includes(ephemeral));
  assert.equal(redactSecrets(persistent), "[REDACTED]");
});
function config(alg = "ES256") {
  return clientMetadataSchema.parse({
    clientId: "https://client.example/oauth/client.json",
    clientName: "Own managed keys",
    cacheMaxAge: 0,
    authentication: {
      method: "private_key_jwt",
      alg,
      managed: {
        rotationIntervalSeconds: 180,
        prepublishSeconds: 60,
        retainSeconds: 120,
      },
    },
  });
}
async function fixture(alg = "ES256") {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-keys-")),
    key = randomBytes(32),
    lifetime = new AbortController();
  let now = Date.now();
  const vault = new OAuthVault(root, async () => key, lifetime.signal),
    manager = new MCPKeyring(vault, lifetime.signal, () => now);
  return {
    root,
    vault,
    manager,
    lifetime,
    config: config(alg),
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      manager.close();
      lifetime.abort();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function verifyJWT(jwt: string, document: any) {
  const [h, p, s] = jwt.split("."),
    header = JSON.parse(Buffer.from(h, "base64url").toString()),
    jwk = document.jwks.keys.find((k: any) => k.kid === header.kid);
  assert.ok(jwk);
  assert.ok(
    verify(
      header.alg === "EdDSA" ? null : "sha256",
      Buffer.from(h + "." + p),
      {
        key: createPublicKey({ key: jwk, format: "jwk" }),
        ...(header.alg === "ES256"
          ? { dsaEncoding: "ieee-p1363" as const }
          : {}),
      },
      Buffer.from(s, "base64url"),
    ),
  );
  return header;
}
for (const algorithm of ["RS256", "ES256", "EdDSA"])
  test(`OAuth managed ${algorithm} keys prepublish, rotate real signatures, retain public keys and erase retired private material`, async () => {
    const f = await fixture(algorithm);
    try {
      const first = await f.manager.document(
          f.config,
          "http://127.0.0.1/callback",
        ),
        old = await f.manager.assertion(f.config, "https://as.example/token"),
        oldKid = verifyJWT(old, first).kid;
      const staged = await f.manager.status(f.config, true);
      assert.equal(staged.pending!.waitingForPublication, true);
      assert.equal(
        verifyJWT(
          await f.manager.assertion(f.config, "https://as.example/token"),
          first,
        ).kid,
        oldKid,
      );
      const published = await f.manager.document(
        f.config,
        "http://127.0.0.1/callback",
      );
      assert.equal(published.jwks.keys.length, 2);
      assert.ok(published.jwks.keys.every((k: any) => !k.d && !k.p && !k.q));
      f.advance(59999);
      assert.equal((await f.manager.status(f.config)).activeKid, oldKid);
      f.advance(1);
      await f.manager.tick();
      const rotated = await f.manager.status(f.config);
      assert.notEqual(rotated.activeKid, oldKid);
      assert.equal(rotated.retained[0].kid, oldKid);
      const doc = await f.manager.document(
        f.config,
        "http://127.0.0.1/callback",
      );
      verifyJWT(old, doc);
      assert.equal(
        verifyJWT(
          await f.manager.assertion(f.config, "https://as.example/token"),
          doc,
        ).kid,
        rotated.activeKid,
      );
      const ring: any = await f.vault.load(
        hash(f.config.clientId).slice(0, 48),
        "signing-keys",
        hash(f.config.clientId + "\n" + algorithm),
      );
      assert.ok(ring.active.pem.includes("PRIVATE KEY"));
      assert.equal(ring.retired[0].pem, undefined);
      for (const file of await readdir(f.root))
        assert.ok(
          !(await readFile(path.join(f.root, file), "utf8")).includes(
            "PRIVATE KEY",
          ),
        );
      f.advance(120001);
      const pruned = await f.manager.document(
        f.config,
        "http://127.0.0.1/callback",
      );
      assert.ok(!pruned.jwks.keys.some((k: any) => k.kid === oldKid));
    } finally {
      await f.close();
    }
  });
test("OAuth managed keys automatically stage on schedule and cannot activate before a JWKS GET has started the overlap clock", async () => {
  const f = await fixture();
  try {
    await f.manager.prepare(f.config);
    const initial = await f.manager.status(f.config);
    f.advance(120000);
    await f.manager.tick();
    assert.ok((await f.manager.status(f.config)).pending);
    f.advance(1000000);
    await f.manager.tick();
    assert.equal(
      (await f.manager.status(f.config)).activeKid,
      initial.activeKid,
    );
    await f.manager.document(f.config, "http://127.0.0.1/callback", false);
    assert.equal(
      (await f.manager.status(f.config)).pending!.waitingForPublication,
      true,
    );
    await f.manager.document(f.config, "http://127.0.0.1/callback");
    f.advance(60000);
    await f.manager.tick();
    assert.notEqual(
      (await f.manager.status(f.config)).activeKid,
      initial.activeKid,
    );
  } finally {
    await f.close();
  }
});
test("OAuth managed keyring resumes staged and retained keys after restart without resetting their publication deadline", async () => {
  const f = await fixture();
  let restored: MCPKeyring | undefined;
  try {
    await f.manager.prepare(f.config);
    await f.manager.status(f.config, true);
    await f.manager.document(f.config, "http://127.0.0.1/callback");
    const before = await f.manager.status(f.config);
    f.manager.close();
    restored = new MCPKeyring(f.vault, f.lifetime.signal, f.clock);
    await restored.prepare(f.config);
    assert.deepEqual(await restored.status(f.config), before);
    f.advance(60000);
    await restored.tick();
    const after = await restored.status(f.config);
    assert.equal(after.activeKid, before.pending!.kid);
    assert.equal(after.retained[0].kid, before.activeKid);
  } finally {
    restored?.close();
    await f.close();
  }
});
test("OAuth managed concurrent publication, signing and rotation share one active key and one successor", async () => {
  const f = await fixture();
  try {
    await f.manager.prepare(f.config);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => f.manager.status(f.config, true)),
    );
    assert.equal(new Set(results.map((v) => v.activeKid)).size, 1);
    assert.equal(new Set(results.map((v) => v.pending!.kid)).size, 1);
    const docs = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.manager.document(f.config, "http://127.0.0.1/callback"),
      ),
    );
    assert.ok(docs.every((d) => d.jwks.keys.length === 2));
    const jwt = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.manager.assertion(f.config, "https://as.example/token"),
      ),
    );
    assert.equal(new Set(jwt).size, 8);
    for (const token of jwt) verifyJWT(token, docs[0]);
  } finally {
    await f.close();
  }
});
test("OAuth managed configuration rejects unsafe cache overlap, contradictory key sources and unpublished automatic keys", () => {
  const good = config();
  for (const change of [
    { prepublishSeconds: 59 },
    { rotationIntervalSeconds: 60 },
    { retainSeconds: 1 },
  ])
    assert.equal(
      clientMetadataSchema.safeParse({
        ...good,
        authentication: {
          ...good.authentication,
          managed: { ...(good.authentication as any).managed, ...change },
        },
      }).success,
      false,
    );
  assert.equal(
    clientMetadataSchema.safeParse({ ...good, cacheMaxAge: 300 }).success,
    false,
  );
  assert.equal(
    clientMetadataSchema.safeParse({ ...good, publish: false }).success,
    false,
  );
  assert.equal(
    clientMetadataSchema.safeParse({
      ...good,
      authentication: {
        ...good.authentication,
        privateKeyEnv: "KEY",
        kid: "manual",
      },
    }).success,
    false,
  );
});
test("OAuth managed key vault detects ciphertext tampering, identity changes and host shutdown", async () => {
  const f = await fixture();
  try {
    await f.manager.prepare(f.config);
    const file = path.join(f.root, (await readdir(f.root))[0]),
      encrypted = JSON.parse(await readFile(file, "utf8"));
    encrypted.tag = Buffer.alloc(16).toString("base64");
    await writeFile(file, JSON.stringify(encrypted));
    await assert.rejects(f.manager.status(f.config));
    await assert.rejects(
      f.manager.status({
        ...f.config,
        authentication: { ...f.config.authentication, alg: "EdDSA" } as any,
      }),
      /configuration changed/,
    );
    f.lifetime.abort();
    await assert.rejects(
      f.manager.assertion(f.config, "https://as.example/token"),
    );
  } finally {
    await f.close();
  }
});
test("OAuth managed host configuration removal stops future rotation and cannot replace a live identity with a different key algorithm", async () => {
  const f = await fixture();
  try {
    f.manager.setConfigurations([f.config]);
    await f.manager.prepare(f.config);
    f.manager.setConfigurations([]);
    await assert.rejects(
      f.manager.status(f.config),
      /configuration changed or was removed/,
    );
    await f.manager.tick();
    assert.equal((await readdir(f.root)).length, 1);
  } finally {
    await f.close();
  }
  const x = await setup();
  try {
    const input: any = {
      id: "managed",
      name: "Managed",
      transport: "http",
      url: "https://mcp.example/mcp",
      oauth: {
        redirectUri: "http://127.0.0.1/callback",
        allowedIssuers: ["https://as.example"],
        clientMetadata: config(),
      },
    };
    x.kernel.mcp.install(input);
    assert.throws(
      () =>
        x.kernel.mcp.install({
          ...input,
          oauth: {
            ...input.oauth,
            clientMetadata: {
              ...config(),
              authentication: { ...config().authentication, alg: "EdDSA" },
            },
          },
        }),
      /requires a new client metadata identity/,
    );
    await x.kernel.mcp.remove("managed");
    assert.equal((await fetch(x.api.url + "/oauth/client.json")).status, 401);
  } finally {
    await x.close();
  }
});
test("OAuth managed HTTP API publishes only public keys and HEAD cannot acknowledge prepublication", async () => {
  const x = await setup();
  try {
    x.kernel.mcp.install({
      id: "managed",
      name: "Managed",
      transport: "http",
      url: "https://mcp.example/mcp",
      oauth: {
        redirectUri: "http://127.0.0.1/callback",
        allowedIssuers: ["https://as.example"],
        clientMetadata: config(),
      },
    });
    const first = await x.client.mcpOAuthKeys("managed"),
      stage = await x.client.rotateMCPOAuthKeys("managed");
    assert.equal(first.activeKid, stage.activeKid);
    await fetch(x.api.url + "/oauth/client.json", { method: "HEAD" });
    assert.equal(
      (await x.client.mcpOAuthKeys("managed")).pending.waitingForPublication,
      true,
    );
    const response = await fetch(x.api.url + "/oauth/client.json"),
      doc = await response.json();
    assert.equal(doc.jwks.keys.length, 2);
    assert.ok(!JSON.stringify(doc).includes("PRIVATE KEY"));
    assert.ok(doc.jwks.keys.every((k: any) => !k.d));
    assert.equal(
      (await x.client.mcpOAuthKeys("managed")).pending.waitingForPublication,
      false,
    );
    assert.equal(
      (await fetch(x.api.url + "/v1/mcp/managed/auth-keys")).status,
      401,
    );
    await x.client.request("DELETE", "/v1/mcp/managed/auth");
    assert.equal(
      (await (await fetch(x.api.url + "/oauth/client.json")).json()).jwks
        .keys[0].kid,
      first.activeKid,
    );
  } finally {
    await x.close();
  }
});
test("OAuth managed key rotation completes actual HTTPS PKCE and refresh before and after the real prepublication window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-rotation-tls-"));
  try {
    const tls = JSON.parse(
        await readFile(
          new URL("./support/tls-fixture.json", import.meta.url),
          "utf8",
        ),
      ),
      cert = path.join(root, "test-ca.pem");
    await writeFile(cert, tls.cert);
    const value = await new Promise<any>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./support/cimd-flow.mjs", import.meta.url)),
          "ES256",
          "managed",
        ],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Managed TLS integration timed out"));
      }, 85000);
      child.stdout.on("data", (p) => (out += p));
      child.stderr.on("data", (p) => (err += p));
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(Error(err));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error(out + err));
        }
      });
    });
    assert.equal(value.authorized, true);
    assert.equal(value.registrations, 0);
    assert.equal(value.exchanges, 4);
    assert.equal(value.assertions.length, 4);
    assert.ok(value.assertions.every((a: any) => a.valid));
    assert.equal(value.rotation.afterHead.pending.waitingForPublication, true);
    assert.equal(value.rotation.publishedKids.length, 2);
    assert.equal(value.rotation.changedETag, true);
    assert.notEqual(value.assertions[0].kid, value.assertions[2].kid);
    assert.equal(value.assertions[2].kid, value.rotation.after.activeKid);
    assert.ok(value.rotation.currentKids.includes(value.assertions[0].kid));
    assert.equal(value.privateMaterialExposed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
