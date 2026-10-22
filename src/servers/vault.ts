import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  atomicWrite,
  invariant,
  registerSecret,
  redactSecrets,
} from "../core/util.js";
import { credentialsSchema, type ServerCredentials } from "./types.js";
import { KeyedQueue } from "../runtime/keyed-queue.js";

const envelopeSchema = z
  .object({
    serverId: z.string(),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();
const vaultSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string().uuid(), envelopeSchema),
  })
  .strict();
type VaultFile = z.infer<typeof vaultSchema>;
const vaultOperations = new KeyedQueue<string>();
function vaultQueueKey(file: string) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export class ServerVault {
  private secrets = new Set<string>();
  constructor(
    readonly file: string,
    private keyEnv = "AGENT_SERVER_VAULT_KEY",
  ) {}
  private key(): Buffer {
    const text = process.env[this.keyEnv];
    invariant(
      text && /^[A-Za-z0-9+/]{43}=$/.test(text),
      "Server vault key must be 32 bytes in base64",
      503,
      "server_vault_key_missing",
    );
    const key = Buffer.from(text, "base64");
    invariant(
      key.length === 32 && key.toString("base64") === text,
      "Invalid server vault key",
      503,
    );
    registerSecret(text);
    return key;
  }
  private async load(): Promise<VaultFile> {
    try {
      return vaultSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { version: 1, entries: {} };
      throw error;
    }
  }
  private register(credentials: ServerCredentials): void {
    for (const secret of Object.values(credentials)) {
      if (!secret) continue;
      this.secrets.add(secret);
      this.secrets.add(JSON.stringify(secret).slice(1, -1));
      registerSecret(secret);
    }
  }
  redact(text: string): string {
    for (const secret of this.secrets)
      text = text.replaceAll(secret, "[REDACTED]");
    return redactSecrets(text);
  }
  async put(
    serverId: string,
    input: unknown,
    reference: string = randomUUID(),
  ): Promise<string> {
    const credentials = credentialsSchema.parse(input);
    this.register(credentials);
    await vaultOperations.run(vaultQueueKey(this.file), async () => {
      const key = this.key();
      try {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(`${reference}:${serverId}`));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(credentials), "utf8"),
          cipher.final(),
        ]);
        const file = await this.load();
        file.entries[reference] = {
          serverId,
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        };
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await chmod(path.dirname(this.file), 0o700);
        await atomicWrite(this.file, JSON.stringify(file));
        await chmod(this.file, 0o600);
      } finally {
        key.fill(0);
      }
    });
    return reference;
  }
  async get(serverId: string, reference: string): Promise<ServerCredentials> {
    return vaultOperations.run(vaultQueueKey(this.file), async () => {
      const entry = (await this.load()).entries[reference];
      invariant(
        entry?.serverId === serverId,
        "Server credentials not available",
        409,
        "server_credentials_missing",
      );
      const key = this.key();
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(entry.iv, "base64"),
        );
        decipher.setAAD(Buffer.from(`${reference}:${serverId}`));
        decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(entry.ciphertext, "base64")),
          decipher.final(),
        ]);
        try {
          const credentials = credentialsSchema.parse(
            JSON.parse(plaintext.toString("utf8")),
          );
          this.register(credentials);
          return credentials;
        } finally {
          plaintext.fill(0);
        }
      } finally {
        key.fill(0);
      }
    });
  }
  async remove(reference: string): Promise<void> {
    return vaultOperations.run(vaultQueueKey(this.file), async () => {
      const file = await this.load();
      delete file.entries[reference];
      await atomicWrite(this.file, JSON.stringify(file));
      await chmod(this.file, 0o600);
    });
  }
}
