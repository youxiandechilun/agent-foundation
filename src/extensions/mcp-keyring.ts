import {
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  randomBytes,
} from "node:crypto";
import {
  clientAssertion,
  clientMetadataDocument,
  type MCPClientMetadata,
} from "./mcp-client-metadata.js";
import { OAuthVault } from "./oauth-vault.js";
import { hash, invariant, registerSecret } from "../util.js";

type SigningKey = {
  kid: string;
  jwk: any;
  pem: string;
  createdAt: number;
  activatedAt?: number;
  publishedAt?: number;
  activateAfter?: number;
};
type Ring = {
  alg: string;
  active: SigningKey;
  pending?: SigningKey;
  retired: { kid: string; jwk: any; removeAfter: number }[];
};
/** Host-owned private keys never leave the encrypted vault. Only a served JWKS starts the overlap clock. */
export class MCPKeyring {
  private locks = new Map<string, Promise<unknown>>();
  private tracked = new Map<string, MCPClientMetadata>();
  private failures = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  private hostConfigurations = false;
  setConfigurations(configs: MCPClientMetadata[]) {
    this.hostConfigurations = true;
    this.tracked = new Map(
      configs.map((config) => [this.identity(config), config]),
    );
    if (this.tracked.size) this.start();
    else if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const id of this.failures.keys())
      if (!this.tracked.has(id)) this.failures.delete(id);
  }
  private current(config: MCPClientMetadata) {
    invariant(
      !this.closed &&
        (!this.hostConfigurations ||
          JSON.stringify(this.tracked.get(this.identity(config))) ===
            JSON.stringify(config)),
      "OAuth key configuration changed or was removed",
      409,
    );
  }
  constructor(
    private vault: OAuthVault,
    private lifetime: AbortSignal,
    private clock: () => number = Date.now,
  ) {
    this.lifetime.addEventListener("abort", () => this.close(), { once: true });
  }
  private identity(config: MCPClientMetadata) {
    return hash(config.clientId).slice(0, 48);
  }
  private policy(config: MCPClientMetadata) {
    const auth = config.authentication;
    invariant(
      auth.method === "private_key_jwt" && auth.managed,
      "Managed OAuth keys are not configured",
      400,
    );
    return { ...auth.managed, alg: auth.alg };
  }
  private async locked<T>(
    config: MCPClientMetadata,
    action: () => Promise<T>,
  ): Promise<T> {
    const id = this.identity(config),
      previous = this.locks.get(id);
    const operation = (async () => {
      await previous?.catch(() => undefined);
      this.lifetime.throwIfAborted();
      invariant(!this.closed, "OAuth key manager is closed", 503);
      return action();
    })();
    this.locks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(id) === operation) this.locks.delete(id);
    }
  }
  private async generate(alg: string): Promise<SigningKey> {
    const keys = await new Promise<{ privateKey: any; publicKey: any }>(
      (resolve, reject) => {
        const done = (error: Error | null, publicKey: any, privateKey: any) =>
          error ? reject(error) : resolve({ publicKey, privateKey });
        if (alg === "RS256")
          generateKeyPair("rsa", { modulusLength: 2048 }, done);
        else if (alg === "ES256")
          generateKeyPair("ec", { namedCurve: "prime256v1" }, done);
        else generateKeyPair("ed25519", {}, done);
      },
    );
    const kid = randomBytes(20).toString("base64url"),
      pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    registerSecret(pem);
    return {
      kid,
      pem,
      jwk: {
        ...createPublicKey(keys.privateKey).export({ format: "jwk" }),
        kid,
        alg,
        use: "sig",
      },
      createdAt: this.clock(),
    };
  }
  private async advance(
    config: MCPClientMetadata,
    stage = false,
    published = false,
  ) {
    this.current(config);
    const policy = this.policy(config),
      id = this.identity(config),
      binding = hash(config.clientId + "\n" + policy.alg);
    let ring = await this.vault.load<Ring>(id, "signing-keys", binding);
    const now = this.clock();
    if (!ring) {
      const active = await this.generate(policy.alg);
      active.activatedAt = now;
      ring = { alg: policy.alg, active, retired: [] };
    }
    invariant(
      ring.alg === policy.alg,
      "OAuth key algorithm changed; use a new client identity",
      409,
    );
    ring.retired = ring.retired.filter((k) => k.removeAfter > now);
    if (ring.pending?.publishedAt !== undefined)
      ring.pending.activateAfter = Math.max(
        ring.pending.activateAfter || 0,
        ring.pending.publishedAt + policy.prepublishSeconds * 1000,
      );
    if (
      ring.pending?.activateAfter !== undefined &&
      ring.pending.activateAfter <= now
    ) {
      ring.retired.push({
        kid: ring.active.kid,
        jwk: ring.active.jwk,
        removeAfter: now + policy.retainSeconds * 1000,
      });
      ring.active = { ...ring.pending, activatedAt: now };
      delete ring.pending;
    }
    invariant(
      !stage || ring.pending || ring.retired.length < 31,
      "Retained OAuth keys must expire before staging another rotation",
      409,
    );
    if (
      !ring.pending &&
      ring.retired.length < 31 &&
      (stage ||
        now >=
          ring.active.activatedAt! +
            (policy.rotationIntervalSeconds - policy.prepublishSeconds) * 1000)
    )
      ring.pending = await this.generate(policy.alg);
    if (published && ring.pending && ring.pending.publishedAt === undefined) {
      ring.pending.publishedAt = this.clock();
      ring.pending.activateAfter =
        ring.pending.publishedAt + policy.prepublishSeconds * 1000;
    }
    invariant(
      ring.retired.length <= 32,
      "Too many retained OAuth keys; reduce retention or rotation frequency",
      409,
    );
    await this.vault.save(id, "signing-keys", binding, ring, () =>
      this.current(config),
    );
    if (!this.hostConfigurations) this.tracked.set(id, config);
    this.failures.delete(id);
    this.start();
    return ring;
  }
  private start() {
    if (this.timer || this.lifetime.aborted || this.closed) return;
    this.timer = setInterval(() => {
      if (this.ticking || this.lifetime.aborted) return;
      this.ticking = true;
      void this.tick().finally(() => {
        this.ticking = false;
      });
    }, 30000);
    this.timer.unref();
  }
  /** Also exposed for embedding hosts with their own scheduler. HTTP publication and signing advance the same state. */
  async tick() {
    for (const config of this.tracked.values()) {
      if (this.lifetime.aborted) return;
      try {
        await this.locked(config, () => this.advance(config));
      } catch {
        this.failures.set(
          this.identity(config),
          "Key rotation failed; inspect the local encrypted vault and key policy",
        );
      }
    }
  }
  async prepare(config: MCPClientMetadata) {
    return this.locked(config, async () => {
      await this.advance(config);
    });
  }
  async document(
    config: MCPClientMetadata,
    redirect?: string,
    published = true,
  ) {
    return this.locked(config, async () => {
      const ring = await this.advance(config, false, published);
      return clientMetadataDocument(config, redirect, [
        ring.active.jwk,
        ...(ring.pending ? [ring.pending.jwk] : []),
        ...ring.retired.map((k) => k.jwk),
      ]);
    });
  }
  async assertion(config: MCPClientMetadata, endpoint: string) {
    return this.locked(config, async () => {
      const ring = await this.advance(config);
      registerSecret(ring.active.pem);
      return clientAssertion(
        config,
        endpoint,
        { key: createPrivateKey(ring.active.pem), kid: ring.active.kid },
        this.clock(),
      );
    });
  }
  async status(config: MCPClientMetadata, stage = false) {
    return this.locked(config, async () => {
      const ring = await this.advance(config, stage),
        policy = this.policy(config);
      const date = (v?: number) =>
        v === undefined ? undefined : new Date(v).toISOString();
      return {
        mode: "managed",
        alg: ring.alg,
        activeKid: ring.active.kid,
        activatedAt: date(ring.active.activatedAt),
        nextRotationAt: date(
          ring.active.activatedAt! + policy.rotationIntervalSeconds * 1000,
        ),
        pending: ring.pending
          ? {
              kid: ring.pending.kid,
              publishedAt: date(ring.pending.publishedAt),
              activateAfter: date(ring.pending.activateAfter),
              waitingForPublication: ring.pending.publishedAt === undefined,
            }
          : undefined,
        retained: ring.retired.map((k) => ({
          kid: k.kid,
          removeAfter: date(k.removeAfter),
        })),
        error: this.failures.get(this.identity(config)),
      };
    });
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tracked.clear();
  }
}
