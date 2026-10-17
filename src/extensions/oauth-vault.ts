import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { renameSync, rmSync } from "node:fs";
import path from "node:path";
import { invariant } from "../util.js";

/** Encrypted host-local state. The caller supplies both identity binding and its commit guard. */
export class OAuthVault {
  constructor(
    private root: string,
    private key: () => Promise<Buffer>,
    private lifetime: AbortSignal,
  ) {}
  private file(id: string, kind: string) {
    invariant(
      /^[a-zA-Z0-9_-]{1,64}$/.test(id) && /^[a-z-]{1,40}$/.test(kind),
      "Invalid OAuth vault identity",
    );
    return path.join(this.root, id + "." + kind + ".json");
  }
  async load<T>(
    id: string,
    kind: string,
    binding: string,
  ): Promise<T | undefined> {
    this.lifetime.throwIfAborted();
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file(id, kind));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    invariant(
      bytes.length <= 2 * 1024 * 1024,
      "OAuth vault entry too large",
      500,
    );
    const record = JSON.parse(bytes.toString());
    invariant(
      record.binding === binding,
      "OAuth vault configuration changed; explicit reconciliation required",
      409,
    );
    const cipher = createDecipheriv(
      "aes-256-gcm",
      await this.key(),
      Buffer.from(record.iv, "base64"),
    );
    cipher.setAAD(Buffer.from(id + "\n" + kind + "\n" + binding));
    cipher.setAuthTag(Buffer.from(record.tag, "base64"));
    this.lifetime.throwIfAborted();
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(record.data, "base64")),
        cipher.final(),
      ]).toString(),
    );
  }
  async save(
    id: string,
    kind: string,
    binding: string,
    value: unknown,
    guard: () => void = () => {},
  ) {
    this.lifetime.throwIfAborted();
    guard();
    const iv = randomBytes(12),
      actual = createCipheriv("aes-256-gcm", await this.key(), iv);
    actual.setAAD(Buffer.from(id + "\n" + kind + "\n" + binding));
    const data = Buffer.concat([
      actual.update(JSON.stringify(value)),
      actual.final(),
    ]);
    const file = this.file(id, kind),
      temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      await writeFile(
        temp,
        JSON.stringify({
          binding,
          iv: iv.toString("base64"),
          tag: actual.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
        { mode: 0o600, flag: "wx", flush: true },
      );
      this.lifetime.throwIfAborted();
      guard();
      renameSync(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }
  remove(id: string, kind: string) {
    rmSync(this.file(id, kind), { force: true });
  }
}
