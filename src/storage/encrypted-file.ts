import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { renameSync } from "node:fs";
import { z } from "zod";
import { invariant } from "../core/util.js";

const envelope = z.object({
  binding: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});
interface EncryptedIdentity {
  file: string;
  binding: string;
  aad: string;
}

/** Existing file names, envelope fields and authenticated data remain caller-owned. */
export async function readEncryptedText(
  identity: EncryptedIdentity,
  key: () => Promise<Buffer>,
  options: { maxBytes: number; mismatch?: "missing"; guard?: () => void },
): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(identity.file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  invariant(
    bytes.length <= options.maxBytes,
    "OAuth vault entry too large",
    500,
  );
  const record = envelope.parse(JSON.parse(bytes.toString("utf8")));
  if (record.binding !== identity.binding && options.mismatch === "missing")
    return;
  invariant(
    record.binding === identity.binding,
    "OAuth vault configuration changed; explicit reconciliation required",
    409,
  );
  const cipher = createDecipheriv(
    "aes-256-gcm",
    await key(),
    Buffer.from(record.iv, "base64"),
  );
  cipher.setAAD(Buffer.from(identity.aad));
  cipher.setAuthTag(Buffer.from(record.tag, "base64"));
  options.guard?.();
  const plaintext = Buffer.concat([
    cipher.update(Buffer.from(record.data, "base64")),
    cipher.final(),
  ]);
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

/** Flush first, then check lifetime/identity immediately before the synchronous commit. */
export async function writeEncryptedJson(
  identity: EncryptedIdentity,
  key: () => Promise<Buffer>,
  value: unknown,
  guard: () => void,
): Promise<void> {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", await key(), iv);
  cipher.setAAD(Buffer.from(identity.aad));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  const temporary =
    identity.file + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        binding: identity.binding,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
      { mode: 0o600, flag: "wx", flush: true },
    );
    guard();
    renameSync(temporary, identity.file);
  } finally {
    await rm(temporary, { force: true });
  }
}
