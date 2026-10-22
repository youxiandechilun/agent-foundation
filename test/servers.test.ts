import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Connection, Server as SshServer } from "ssh2";
import { FoundationClient } from "../src/client.js";
import { setup, until } from "./support/wire-server.js";
import {
  serverIntegration,
  ServerManager,
  serverProfileSchema,
  hostFingerprint,
} from "../src/servers/index.js";
import { serverTools } from "../src/servers/tools.js";
import { Store } from "../src/storage/store.js";

const ssh = await import("ssh2")
  .then((module) => module.default)
  .catch(() => undefined);
const password = "server-test-secret-856169";
async function fixture() {
  assert.ok(ssh);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const parsed = ssh.utils.parseKey(privateKey);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const passphrase = "private-key-test-passphrase-3921";
  const clientKeys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const parsedClient = ssh.utils.parseKey(clientKeys.privateKey, passphrase);
  assert.ok(!(parsedClient instanceof Error) && !Array.isArray(parsedClient));
  const fingerprint = hostFingerprint(parsed.getPublicSSH());
  const clients = new Set<Connection>(),
    files = new Map<string, Buffer>();
  let authentications = 0,
    commands = 0,
    connections = 0,
    writes = 0,
    reads = 0;
  const server = new ssh.Server({ hostKeys: [privateKey] }, (client) => {
    connections++;
    clients.add(client);
    client.on("error", () => undefined);
    client.once("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      authentications++;
      if (
        ctx.method === "password" &&
        ctx.username === "operator" &&
        ctx.password === password
      )
        ctx.accept();
      else if (
        ctx.method === "publickey" &&
        ctx.username === "operator" &&
        ctx.key.data.equals(parsedClient.getPublicSSH()) &&
        (!ctx.signature ||
          Boolean(
            ctx.blob &&
            parsedClient.verify(ctx.blob, ctx.signature, ctx.hashAlgo),
          ))
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          commands++;
          const stream = accept();
          if (info.command === "hold") {
            stream.write("started\n");
            return;
          }
          if (info.command === "disconnect") {
            client.end();
            return;
          }
          stream.write(
            info.command === "large" ? "x".repeat(8192) : `ok ${password}\n`,
          );
          stream.stderr.write("diagnostic\n");
          stream.exit(info.command === "fail" ? 7 : 0);
          stream.end();
        });
        session.on("sftp", (accept) => {
          assert.ok(ssh);
          const sftp = accept(),
            handles = new Map<number, string>();
          let nextHandle = 1;
          sftp.on("OPEN", (request, filename, flags) => {
            const handle = Buffer.alloc(4),
              number = nextHandle++;
            handle.writeUInt32BE(number);
            handles.set(number, filename);
            if (flags & 8 || !files.has(filename))
              files.set(filename, Buffer.alloc(0));
            sftp.handle(request, handle);
          });
          sftp.on("WRITE", (request, handle, offset, bytes) => {
            const filename = handles.get(handle.readUInt32BE());
            assert.ok(filename);
            writes++;
            if (filename === "/hold-upload") return;
            const current = files.get(filename) ?? Buffer.alloc(0),
              output = Buffer.alloc(
                Math.max(current.length, offset + bytes.length),
              );
            current.copy(output);
            bytes.copy(output, offset);
            files.set(filename, output);
            sftp.status(request, 0);
          });
          sftp.on("READ", (request, handle, offset, length) => {
            const filename = handles.get(handle.readUInt32BE());
            assert.ok(filename);
            reads++;
            if (filename === "/hold-download") return;
            const contents = files.get(filename) ?? Buffer.alloc(0);
            if (offset >= contents.length) sftp.status(request, 1);
            else sftp.data(request, contents.subarray(offset, offset + length));
          });
          sftp.on("FSTAT", (request, handle) => {
            const filename = handles.get(handle.readUInt32BE());
            assert.ok(filename);
            sftp.attrs(request, {
              size: files.get(filename)?.length ?? 0,
              mode: 0o100600,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            });
          });
          sftp.on("CLOSE", (request, handle) => {
            handles.delete(handle.readUInt32BE());
            sftp.status(request, 0);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    fingerprint,
    files,
    privateKey: clientKeys.privateKey,
    passphrase,
    counts: () => ({
      authentications,
      commands,
      connections,
      writes,
      reads,
      active: clients.size,
    }),
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function context(options = { maxOutputBytes: 1024, timeoutMs: 3000 }) {
  const protocol = await fixture(),
    previousKey = process.env.AGENT_SERVER_VAULT_KEY;
  process.env.AGENT_SERVER_VAULT_KEY = randomBytes(32).toString("base64");
  let x: Awaited<ReturnType<typeof setup>> | undefined,
    manager: ServerManager | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const stop of [
        () => manager?.close(),
        () => x?.close(),
        () => protocol.close(),
      ]) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (previousKey === undefined) delete process.env.AGENT_SERVER_VAULT_KEY;
      else process.env.AGENT_SERVER_VAULT_KEY = previousKey;
      if (x) {
        try {
          assert.equal(path.dirname(x.root), tmpdir());
          assert.match(path.basename(x.root), /^foundation-v2-/);
          await rm(x.root, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Server fixture cleanup failed");
    })());
  try {
    x = await setup(
      undefined,
      {},
      { integrations: [serverIntegration(options)] },
    );
    const input = {
      name: "Local SSH protocol fixture",
      host: "127.0.0.1",
      port: protocol.port,
      username: "operator",
      projectIds: [x.project.id],
      hostFingerprint: protocol.fingerprint,
    };
    const profile = serverProfileSchema.parse(
      await x.client.request<unknown>("POST", "/v1/servers", input),
    );
    await x.client.request<unknown>(
      "PUT",
      `/v1/servers/${profile.id}/credentials`,
      { password },
    );
    const session = await x.session("code");
    manager = new ServerManager(x.kernel.store, x.config.dataDir, options);
    const tools = serverTools(
      { kernel: x.kernel, session, runId: "test", routeId: "text" },
      manager,
    );
    const tool = (name: string) => {
      const value = tools.find((candidate) => candidate.name === name);
      assert.ok(value);
      return value;
    };
    return { ...x, protocol, profile, input, manager, tool, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Server fixture initialization and cleanup failed",
        // Both failures are in the aggregate; the setup failure is the cause.
        // eslint-disable-next-line preserve-caught-error
        { cause: error },
      );
    }
    throw error;
  }
}

for (const stage of ["project", "session"] as const)
  test(
    `servers: failed ${stage} initialization closes its SSH listener and restores the vault environment`,
    { skip: !ssh },
    async (t) => {
      assert.ok(ssh);
      const servers: SshServer[] = [],
        previousKey = process.env.AGENT_SERVER_VAULT_KEY;
      const listen = ssh.Server.prototype.listen;
      t.mock.method(
        ssh.Server.prototype,
        "listen",
        function (this: SshServer, ...args: Parameters<SshServer["listen"]>) {
          servers.push(this);
          return listen.apply(this, args);
        },
      );
      t.after(async () => {
        for (const server of servers)
          await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previousKey === undefined)
          delete process.env.AGENT_SERVER_VAULT_KEY;
        else process.env.AGENT_SERVER_VAULT_KEY = previousKey;
      });
      const failure = new Error(`intentional ${stage} initialization failure`);
      t.mock.method(FoundationClient.prototype, stage, async () => {
        throw failure;
      });
      await assert.rejects(context(), (error) => error === failure);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].address(), null);
      assert.equal(process.env.AGENT_SERVER_VAULT_KEY, previousKey);
    },
  );

test(
  "servers: authenticated HTTP profiles, probe without authentication, encrypted credentials, bounded verified command evidence",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const unauthorized = await fetch(`${x.api.url}/v1/servers`);
      assert.equal(unauthorized.status, 401);
      const counts = x.protocol.counts();
      const probe = z
        .object({ hostFingerprint: z.string(), trusted: z.literal(false) })
        .passthrough()
        .parse(
          await x.client.request<unknown>("POST", "/v1/servers/probe", {
            host: "127.0.0.1",
            port: x.protocol.port,
          }),
        );
      assert.equal(probe.hostFingerprint, x.protocol.fingerprint);
      await until(() => x.protocol.counts().active === 0);
      assert.equal(x.protocol.counts().authentications, counts.authentications);
      assert.equal(x.protocol.counts().commands, counts.commands);
      const response = await x
        .tool("server_exec")
        .execute("one", { serverId: x.profile.id, command: "success" });
      assert.match(JSON.stringify(response), /completed/);
      assert.ok(!JSON.stringify(response).includes(password));
      const facts = x.manager.read(x.profile.id, x.project.id).facts;
      assert.equal(facts.length, 1);
      assert.equal(facts[0].evidence?.exitCode, 0);
      assert.ok(facts[0].verifiedAt);
      const vault = await readFile(
        path.join(x.config.dataDir, "server-vault", "credentials.json"),
        "utf8",
      );
      assert.ok(!vault.includes(password));
      assert.ok(
        !vault.includes(process.env.AGENT_SERVER_VAULT_KEY ?? "impossible"),
      );
      const listed = await x.client.request<unknown>("GET", "/v1/servers");
      assert.ok(!JSON.stringify(listed).includes(password));
      assert.match(JSON.stringify(listed), /credentialRef/);
      const note = await x.manager.remember(
        x.profile.id,
        x.project.id,
        `Password ${password} should never enter memory`,
      );
      assert.equal(note.kind, "note");
      assert.equal(note.source, "agent");
      assert.equal(note.verifiedAt, undefined);
      assert.ok(!note.text.includes(password));
      await assert.rejects(
        x.client.request("POST", "/v1/servers", {
          ...x.input,
          projectIds: ["missing-project"],
        }),
        /not found/,
      );
      const reopened = new Store(x.config.dataDir);
      try {
        assert.equal(reopened.list<unknown>("server-facts").length, 2);
      } finally {
        reopened.close();
      }
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: encrypted private key authentication is supported without exposing credentials",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const profile = await x.manager.setCredentials(x.profile.id, {
        privateKey: x.protocol.privateKey,
        passphrase: x.protocol.passphrase,
      });
      assert.deepEqual(profile.credentialKinds, ["privateKey"]);
      const success = await x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "success",
      });
      assert.equal(success.result.status, "completed");
      assert.equal(success.result.exitCode, 0);
      const publicData = JSON.stringify(
        await x.client.request<unknown>("GET", `/v1/servers/${x.profile.id}`),
      );
      const encrypted = await readFile(
        path.join(x.config.dataDir, "server-vault", "credentials.json"),
        "utf8",
      );
      for (const value of [
        x.protocol.privateKey,
        x.protocol.passphrase,
        password,
      ]) {
        assert.ok(!publicData.includes(value));
        assert.ok(!encrypted.includes(value));
        for (const file of ["foundation.sqlite", "foundation.sqlite-wal"]) {
          const bytes = await readFile(path.join(x.config.dataDir, file));
          assert.ok(!bytes.includes(Buffer.from(value)));
        }
      }
      await x.manager.setCredentials(x.profile.id, {
        privateKey: x.protocol.privateKey,
        passphrase: "incorrect-passphrase",
      });
      assert.equal(
        (
          await x.manager.exec(x.project.id, {
            serverId: x.profile.id,
            command: "success",
          })
        ).result.status,
        "failed",
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: wrong host fingerprint and wrong password are rejected, foreign project cannot connect",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      await x.manager.update(x.profile.id, {
        ...x.input,
        hostFingerprint: `SHA256:${"A".repeat(43)}`,
      });
      const rejected = await x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "success",
      });
      assert.equal(rejected.result.status, "failed");
      assert.equal(x.protocol.counts().commands, 0);
      assert.equal(x.protocol.counts().authentications, 0);
      await x.manager.update(x.profile.id, x.input);
      await x.manager.setCredentials(x.profile.id, {
        password: "wrong-password",
      });
      const badPassword = await x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "success",
      });
      assert.equal(badPassword.result.status, "failed");
      assert.equal(x.protocol.counts().commands, 0);
      const foreign = await x.kernel.createProject("foreign"),
        before = x.protocol.counts().connections;
      await assert.rejects(
        x.manager.exec(foreign.id, {
          serverId: x.profile.id,
          command: "success",
        }),
        /not available/,
      );
      assert.throws(
        () => x.manager.read(x.profile.id, foreign.id),
        /not available/,
      );
      assert.equal(x.protocol.counts().connections, before);
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: cancellation, disconnect and output limit preserve unknown state without retry",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const controller = new AbortController();
      const pending = x.manager.exec(
        x.project.id,
        { serverId: x.profile.id, command: "hold" },
        controller.signal,
      );
      await until(() => x.protocol.counts().commands === 1);
      controller.abort();
      const cancelled = await pending;
      assert.equal(cancelled.result.status, "unknown");
      const limited = await x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "large",
      });
      assert.equal(limited.result.status, "unknown");
      assert.equal(limited.result.truncated, true);
      assert.ok(
        Buffer.byteLength(limited.result.stdout) +
          Buffer.byteLength(limited.result.stderr) <=
          1024,
      );
      const disconnected = await x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "disconnect",
      });
      assert.equal(disconnected.result.status, "unknown");
      assert.equal(x.protocol.counts().commands, 3);
      await until(() => x.protocol.counts().active === 0);
      for (const fact of x.manager.read(x.profile.id, x.project.id).facts)
        assert.equal(fact.verifiedAt, undefined);
      assert.deepEqual(x.tool("server_exec").capabilities, ["network", "exec"]);
      assert.equal(x.tool("server_exec").risk, "execute");
      assert.deepEqual(
        x
          .tool("server_exec")
          .scheduling?.resources?.({ serverId: x.profile.id }),
        [{ key: `server:${x.profile.id}`, access: "write" }],
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: profile changes and credential deletion cancel active operations across managers before committing",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const pending = x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "hold",
      });
      await until(() => x.protocol.counts().commands === 1);
      const updates = [
        x.manager.update(x.profile.id, { ...x.input, environment: "one" }),
        x.manager.update(x.profile.id, { ...x.input, environment: "two" }),
      ];
      assert.equal((await pending).result.status, "unknown");
      await Promise.all(updates);
      assert.equal(x.manager.profile(x.profile.id).environment, "two");
      const second = x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "hold",
      });
      await until(() => x.protocol.counts().commands === 2);
      await x.client.request<unknown>(
        "DELETE",
        `/v1/servers/${x.profile.id}/credentials`,
      );
      assert.equal((await second).result.status, "unknown");
      assert.equal(x.manager.profile(x.profile.id).credentialRef, undefined);
      const before = x.protocol.counts().connections;
      await assert.rejects(
        x.manager.exec(x.project.id, {
          serverId: x.profile.id,
          command: "success",
        }),
        /No server credentials/,
      );
      assert.equal(x.protocol.counts().connections, before);
      await until(() => x.protocol.counts().active === 0);
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: trust update while credentials load cannot dispatch using an old profile",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      let resume: () => void = () => undefined,
        entered = false;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = x.manager.credentials.bind(x.manager);
      x.manager.credentials = async (profile) => {
        entered = true;
        const value = await original(profile);
        await gate;
        return value;
      };
      const pending = x.manager.exec(x.project.id, {
        serverId: x.profile.id,
        command: "success",
      });
      const failure = assert.rejects(pending, /changed/);
      await until(() => entered);
      const update = x.manager.update(x.profile.id, {
        ...x.input,
        host: "192.0.2.1",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      resume();
      await failure;
      await update;
      assert.equal(x.protocol.counts().connections, 0);
      assert.equal(x.protocol.counts().commands, 0);
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: SFTP cancellation, path validation and download byte limit preserve project boundaries",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const asset = await x.kernel.assets.create(
        x.project.id,
        "upload.txt",
        Buffer.from("partial"),
      );
      await assert.rejects(
        x.tool("server_upload").execute("path", {
          serverId: x.profile.id,
          assetId: asset.id,
          remotePath: "/a/../b",
        }),
        /Normalized absolute/,
      );
      await assert.rejects(
        x.tool("server_download").execute("path", {
          serverId: x.profile.id,
          remotePath: "C:\\Windows\\file",
        }),
        /Normalized absolute/,
      );
      assert.equal(x.protocol.counts().connections, 0);
      const controller = new AbortController(),
        upload = x.tool("server_upload").execute(
          "hold",
          {
            serverId: x.profile.id,
            assetId: asset.id,
            remotePath: "/hold-upload",
          },
          controller.signal,
        );
      await until(() => x.protocol.counts().writes > 0);
      controller.abort();
      assert.match(JSON.stringify(await upload), /unknown/);
      const download = x.tool("server_download").execute("hold", {
        serverId: x.profile.id,
        remotePath: "/hold-download",
      });
      const cancelled = assert.rejects(download, /cancelled|closed|lost/);
      await until(() => x.protocol.counts().reads > 0);
      await x.client.request<unknown>(
        "PUT",
        `/v1/servers/${x.profile.id}`,
        x.input,
      );
      await cancelled;
      x.config.limits.maxUploadBytes = 4;
      x.protocol.files.set("/large.txt", Buffer.from("too large"));
      await assert.rejects(
        x.tool("server_download").execute("limit", {
          serverId: x.profile.id,
          remotePath: "/large.txt",
        }),
        /exceeds asset limit/,
      );
      await until(() => x.protocol.counts().active === 0);
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: SFTP round trip uses owned assets, upload declares remote execution and refuses foreign assets",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const asset = await x.kernel.assets.create(
        x.project.id,
        "hello.txt",
        Buffer.from("verified SFTP bytes"),
      );
      const uploaded = await x.tool("server_upload").execute("upload", {
        serverId: x.profile.id,
        assetId: asset.id,
        remotePath: "/hello.txt",
      });
      assert.match(JSON.stringify(uploaded), /completed/);
      assert.equal(
        x.protocol.files.get("/hello.txt")?.toString(),
        "verified SFTP bytes",
      );
      const downloaded = await x.tool("server_download").execute("download", {
        serverId: x.profile.id,
        remotePath: "/hello.txt",
      });
      const result = z
        .object({ asset: z.object({ id: z.string() }).passthrough() })
        .passthrough()
        .parse(downloaded.details);
      assert.equal(
        (await x.kernel.assets.read(result.asset.id, x.project.id)).toString(),
        "verified SFTP bytes",
      );
      const foreign = await x.kernel.createProject("other-assets"),
        foreignAsset = await x.kernel.assets.create(
          foreign.id,
          "secret.txt",
          Buffer.from("foreign"),
        );
      const before = x.protocol.counts().connections;
      await assert.rejects(
        x.tool("server_upload").execute("foreign", {
          serverId: x.profile.id,
          assetId: foreignAsset.id,
          remotePath: "/foreign.txt",
        }),
        /another project/,
      );
      assert.equal(x.protocol.counts().connections, before);
      assert.equal(x.tool("server_upload").risk, "execute");
      assert.ok(x.tool("server_upload").capabilities?.includes("exec"));
    } finally {
      await x.close();
    }
  },
);

test(
  "servers: credentials deletion removes reference and external master key is required",
  { skip: !ssh },
  async () => {
    const x = await context();
    try {
      const savedKey = process.env.AGENT_SERVER_VAULT_KEY;
      delete process.env.AGENT_SERVER_VAULT_KEY;
      try {
        await assert.rejects(
          x.manager.exec(x.project.id, {
            serverId: x.profile.id,
            command: "success",
          }),
          /vault key/,
        );
      } finally {
        process.env.AGENT_SERVER_VAULT_KEY = savedKey;
      }
      const cleared = serverProfileSchema.parse(
        await x.client.request<unknown>(
          "DELETE",
          `/v1/servers/${x.profile.id}/credentials`,
        ),
      );
      assert.equal(cleared.credentialRef, undefined);
      assert.deepEqual(cleared.credentialKinds, []);
      await assert.rejects(
        x.manager.exec(x.project.id, {
          serverId: x.profile.id,
          command: "success",
        }),
        /No server credentials/,
      );
      const vault = z
        .object({ entries: z.record(z.string(), z.unknown()) })
        .passthrough()
        .parse(
          JSON.parse(
            await readFile(
              path.join(x.config.dataDir, "server-vault", "credentials.json"),
              "utf8",
            ),
          ),
        );
      assert.equal(Object.keys(vault.entries).length, 0);
      await x.client.request<unknown>("DELETE", `/v1/servers/${x.profile.id}`);
      await assert.rejects(
        x.client.request<unknown>("GET", `/v1/servers/${x.profile.id}`),
        /not found/,
      );
    } finally {
      await x.close();
    }
  },
);
