import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactJson } from "../src/core/util.js";
import { toolParameters, compileSchema } from "../src/runtime/json-schema.js";
import {
  readSchema,
  dispatchSchema,
  roleReviewSchema,
} from "../src/collaboration/types.js";
import {
  readEncryptedText,
  writeEncryptedJson,
} from "../src/storage/encrypted-file.js";

test("JSON redaction handles escaped values and keys while observing per-call environment rotation", () => {
  const name = "FOUNDATION_REFACTOR_TEST_SECRET",
    previous = process.env[name];
  const first = 'first-secret-"\\\nvalue',
    second = "second-secret-rotated";
  try {
    process.env[name] = first;
    const input = {
      [first]: [{ text: first }, { text: JSON.stringify(first).slice(1, -1) }],
      ordinary: "safe",
    };
    const snapshot = structuredClone(input);
    assert.deepEqual(redactJson(input), {
      "[REDACTED]": [{ text: "[REDACTED]" }, { text: "[REDACTED]" }],
      ordinary: "safe",
    });
    assert.deepEqual(input, snapshot);
    process.env[name] = second;
    assert.deepEqual(redactJson({ first, second }), {
      first,
      second: "[REDACTED]",
    });
    delete process.env[name];
    assert.deepEqual(redactJson({ second }), { second });
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("generated tool schemas describe input defaults without changing arguments and retain nested service constraints", () => {
  const read = compileSchema(toolParameters(readSchema));
  const input = { sessionId: "session" };
  assert.equal(read(input), true);
  assert.deepEqual(input, { sessionId: "session" });
  assert.deepEqual(readSchema.parse(input), {
    sessionId: "session",
    offset: 0,
    limit: 20,
  });
  assert.equal(read({ ...input, unknown: true }), false);
  assert.equal(read({ ...input, limit: 51 }), false);
  assert.equal(read({ ...input, offset: -1 }), false);
  const dispatch = compileSchema(toolParameters(dispatchSchema));
  const assignment = {
    agentId: "member",
    prompt: "do task",
    scope: [],
    deliverable: "report",
  };
  assert.equal(dispatch(assignment), true);
  assert.equal(dispatch({ ...assignment, wait: "false" }), false);
  assert.equal(dispatchSchema.parse(assignment).wait, true);
  const review = compileSchema(toolParameters(roleReviewSchema));
  const roles = ["leader", "member"].map((agentId) => ({
    agentId,
    optimizedResponsibility: "existing role",
  }));
  assert.equal(review({ roles, gaps: [], rationale: "covers work" }), true);
  assert.equal(
    review({ roles: roles.slice(0, 1), gaps: [], rationale: "covers work" }),
    false,
  );
  assert.equal(
    review({
      roles,
      gaps: [],
      rationale: "covers work",
      scopeChange: {
        userQuote: "yes",
        reason: "change",
        removedResponsibilities: ["scope"],
      },
    }),
    false,
  );
});

test("encrypted persistence reads historical envelopes and writes compatible authenticated files without committing after revocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-encrypted-"));
  const key = randomBytes(32),
    bound = "existing-config-binding";
  try {
    const layouts = [
      { file: "server.json", aad: "server\n" + bound },
      {
        file: "server.registration-client.json",
        aad: "server\n" + bound + "\nregistration-client",
      },
      { file: "server.device.json", aad: "server\ndevice\n" + bound },
    ];
    for (const layout of layouts) {
      const identity = {
        ...layout,
        file: path.join(root, layout.file),
        binding: bound,
      };
      const secret = { binding: bound, token: "fixture-credential" };
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(identity.aad));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(secret)),
        cipher.final(),
      ]);
      const previous = JSON.stringify({
        binding: bound,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      });
      await writeFile(identity.file, previous);
      assert.equal(
        await readEncryptedText(identity, async () => key, { maxBytes: 1024 }),
        JSON.stringify(secret),
      );
      assert.equal(
        await readEncryptedText(
          { ...identity, binding: "changed" },
          async () => key,
          { maxBytes: 1024, mismatch: "missing" },
        ),
        undefined,
      );
      await assert.rejects(
        readEncryptedText(
          { ...identity, aad: "wrong identity" },
          async () => key,
          { maxBytes: 1024 },
        ),
      );
      await assert.rejects(
        writeEncryptedJson(
          identity,
          async () => key,
          secret,
          () => {
            throw Error("revoked before commit");
          },
        ),
        /revoked/,
      );
      assert.equal(await readFile(identity.file, "utf8"), previous);
      await writeEncryptedJson(
        identity,
        async () => key,
        { ...secret, token: "replacement" },
        () => {},
      );
      const record: { iv: string; tag: string; data: string } = JSON.parse(
        await readFile(identity.file, "utf8"),
      );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(identity.aad));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.data, "base64")),
        decipher.final(),
      ]).toString();
      assert.deepEqual(JSON.parse(plaintext), {
        ...secret,
        token: "replacement",
      });
      assert.ok(
        !(await readFile(identity.file, "utf8")).includes("replacement"),
      );
    }
    assert.equal((await readdir(root)).length, 3);
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
