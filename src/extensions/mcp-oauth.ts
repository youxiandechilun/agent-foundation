import { z } from "zod";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { renameSync, rmSync } from "node:fs";
import type { Config } from "../config.js";
import { readJson } from "../providers/sse.js";
import { invariant, hash, registerSecret } from "../util.js";
import { MCPRegistrations, registrationSchema } from "./mcp-registration.js";
import {
  clientMetadataSchema,
  clientMetadataDocument,
  clientAssertion,
  type MCPClientMetadata,
} from "./mcp-client-metadata.js";
import { OAuthVault } from "./oauth-vault.js";
import { MCPKeyring } from "./mcp-keyring.js";
import {
  MCPDeviceFlow,
  DEVICE_GRANT,
  type DeviceContext,
} from "./mcp-device.js";

export const oauthSchema = z
  .object({
    clientId: z.string().min(1).max(2048).optional(),
    registration: registrationSchema.optional(),
    clientMetadata: clientMetadataSchema.optional(),
    redirectUri: z.string().url().optional(),
    deviceFlow: z.boolean().optional(),
    allowedIssuers: z.array(z.string().url()).min(1).max(10),
    allowedEndpointOrigins: z.array(z.string().url()).max(10).default([]),
    resourceMetadataUrl: z.string().url().optional(),
    scopes: z
      .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/))
      .max(100)
      .optional(),
    clientSecretEnv: z.string().min(1).optional(),
    allowLoopbackHttp: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.redirectUri &&
      (!value.deviceFlow ||
        (value.registration &&
          (value.registration.grantTypes || ["authorization_code"]).includes(
            "authorization_code",
          )) ||
        (value.clientMetadata &&
          (value.clientMetadata.grantTypes || ["authorization_code"]).includes(
            "authorization_code",
          )))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Authorization-code clients require a callback; callbackless clients must explicitly enable device flow and device-only registration metadata",
      });
    if (
      value.registration?.grantTypes &&
      new Set(value.registration.grantTypes).size !==
        value.registration.grantTypes.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate registration grant types",
      });
    if (
      (!value.clientId && !value.registration && !value.clientMetadata) ||
      (value.clientId && (value.registration || value.clientMetadata))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Choose a pre-registered clientId, client metadata or explicit dynamic registration",
      });
    if ((value.registration || value.clientMetadata) && value.clientSecretEnv)
      ctx.addIssue({
        code: "custom",
        message:
          "Dynamic registration manages its own client secret; client metadata prohibits shared secrets",
      });
  });
export type MCPOAuthConfig = z.infer<typeof oauthSchema>;
interface Target {
  id: string;
  url: string;
  oauth: MCPOAuthConfig;
}
interface Token {
  deviceGrantId?: string;
  access: string;
  refresh?: string;
  expiresAt: number;
  scope: string;
  binding: string;
  issuer: string;
  tokenEndpoint: string;
  authMethod: string;
  clientId?: string;
  clientMode?: "metadata" | "dynamic" | "pre_registered";
}
interface Flow {
  target: Target;
  binding: string;
  verifier: string;
  issuer: string;
  tokenEndpoint: string;
  authMethod: string;
  clientId: string;
  clientSecret?: string;
  clientMode: "metadata" | "dynamic" | "pre_registered";
  issRequired: boolean;
  expiresAt: number;
  scope: string;
  generation: number;
}
function binding(target: Target) {
  return hash(JSON.stringify({ url: target.url, oauth: target.oauth }));
}
function challenge(header: string) {
  invariant(header.length <= 16000, "OAuth challenge too large", 502);
  if (!/\bBearer\b/i.test(header)) return {};
  return Object.fromEntries(
    [...header.matchAll(/([A-Za-z_]+)="([^"\r\n]*)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}
/** Source-maintained OAuth / PKCE with pre-registration or explicit RFC 7591 registration. */
export class MCPOAuth {
  readonly registrations: MCPRegistrations;
  readonly devices: MCPDeviceFlow;
  readonly keys: MCPKeyring;
  private flows = new Map<string, Flow>();
  private refreshing = new Map<string, Promise<Token>>();
  private challenges = new Map<string, Record<string, string>>();
  private generations = new Map<string, number>();
  private lifetime = new AbortController();
  private root: string;
  private keyMaterial?: Promise<Buffer>;
  constructor(readonly config: Config) {
    this.root = path.join(config.dataDir, "mcp-oauth");
    this.registrations = new MCPRegistrations(
      this.root,
      () => this.key(),
      this.lifetime.signal,
    );
    const vault = new OAuthVault(
      this.root,
      () => this.key(),
      this.lifetime.signal,
    );
    this.devices = new MCPDeviceFlow(vault, this.lifetime.signal);
    this.keys = new MCPKeyring(vault, this.lifetime.signal);
  }
  private safeUrl(value: string, oauth: MCPOAuthConfig) {
    const url = new URL(value);
    invariant(
      !url.username && !url.password && !url.hash,
      "OAuth URLs cannot contain credentials or fragments",
    );
    invariant(
      url.protocol === "https:" ||
        (oauth.allowLoopbackHttp &&
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)),
      "OAuth requires HTTPS; loopback HTTP must be explicitly enabled",
      403,
    );
    return url;
  }
  private file(id: string) {
    invariant(/^[a-zA-Z0-9_-]{1,40}$/.test(id), "Invalid OAuth server ID");
    return path.join(this.root, id + ".json");
  }
  private key(): Promise<Buffer> {
    return (this.keyMaterial ||= this.loadKey().catch((error) => {
      this.keyMaterial = undefined;
      throw error;
    }));
  }
  private async loadKey() {
    await mkdir(this.root, { recursive: true });
    const file = path.join(this.root, "host-key");
    try {
      const key = await readFile(file);
      invariant(key.length === 32, "Invalid OAuth vault key", 500);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    try {
      await writeFile(file, key, { mode: 0o600, flag: "wx", flush: true });
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const key = await readFile(file);
      invariant(key.length === 32, "Invalid OAuth vault key", 500);
      return key;
    }
  }
  private async load(target: Target): Promise<Token | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file(target.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    invariant(
      bytes.length <= 2 * 1024 * 1024,
      "OAuth vault entry too large",
      500,
    );
    const record = JSON.parse(bytes.toString());
    if (record.binding !== binding(target)) return;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await this.key(),
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(target.id + "\n" + record.binding));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const token = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(record.data, "base64")),
        decipher.final(),
      ]).toString(),
    ) as Token;
    invariant(
      token.binding === binding(target),
      "OAuth token binding mismatch",
      500,
    );
    registerSecret(token.access);
    if (token.refresh) registerSecret(token.refresh);
    return token;
  }
  private async save(
    target: Target,
    token: Token,
    generation: number,
    guard: () => void = () => {},
  ) {
    this.lifetime.signal.throwIfAborted();
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    cipher.setAAD(Buffer.from(target.id + "\n" + token.binding));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(token)),
      cipher.final(),
    ]);
    const temporary =
      this.file(target.id) + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          binding: token.binding,
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
        { mode: 0o600, flag: "wx", flush: true },
      );
      this.lifetime.signal.throwIfAborted();
      invariant(
        (this.generations.get(target.id) || 0) === generation,
        "OAuth authorization was revoked during exchange",
        401,
      );
      guard();
      renameSync(temporary, this.file(target.id));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  noteChallenge(target: Target, header: string) {
    this.challenges.set(target.id, challenge(header));
  }
  async status(target: Target) {
    const token = await this.load(target);
    return {
      configured: true,
      authorized: Boolean(token),
      clientMode: token?.clientMode,
      expiresAt: token ? new Date(token.expiresAt).toISOString() : undefined,
      scope: token?.scope,
      challenge: this.challenges.get(target.id)
        ? {
            scope: this.challenges.get(target.id)?.scope,
            error: this.challenges.get(target.id)?.error,
          }
        : undefined,
    };
  }
  private async metadata(url: string, oauth: MCPOAuthConfig) {
    this.safeUrl(url, oauth);
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(10000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    invariant(
      (response.headers.get("content-type") || "").includes("application/json"),
      "OAuth metadata must be JSON",
      502,
    );
    return await readJson(response, 1024 * 1024);
  }
  private async discover(
    target: Target,
    grant: "code" | "device" | "management" = "code",
  ) {
    this.lifetime.signal.throwIfAborted();
    const oauth = target.oauth,
      resource = this.safeUrl(target.url, oauth);
    if (oauth.redirectUri) this.safeUrl(oauth.redirectUri, oauth);
    let hinted = this.challenges.get(target.id) || {};
    if (!Object.keys(hinted).length) {
      const response = await fetch(resource, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(5000),
        ]),
      });
      hinted = challenge(response.headers.get("www-authenticate") || "");
      await response.body?.cancel();
      this.challenges.set(target.id, hinted);
    }
    let metadataUrl = oauth.resourceMetadataUrl;
    if (!metadataUrl && hinted.resource_metadata) {
      invariant(
        new URL(hinted.resource_metadata).origin === resource.origin,
        "Cross-origin protected resource metadata needs explicit host configuration",
        403,
      );
      metadataUrl = hinted.resource_metadata;
    }
    const candidates = metadataUrl
      ? [metadataUrl]
      : [
          resource.origin +
            "/.well-known/oauth-protected-resource" +
            resource.pathname.replace(/\/$/, ""),
          resource.origin + "/.well-known/oauth-protected-resource",
        ];
    let protectedMetadata: any;
    for (const url of [...new Set(candidates)]) {
      protectedMetadata = await this.metadata(url, oauth);
      if (protectedMetadata) break;
    }
    invariant(
      protectedMetadata?.resource === target.url &&
        Array.isArray(protectedMetadata.authorization_servers),
      "OAuth protected resource metadata does not match the MCP resource",
      502,
    );
    const issuer = protectedMetadata.authorization_servers.find((value: any) =>
      oauth.allowedIssuers.includes(value),
    );
    invariant(issuer, "Authorization issuer is not in the host allowlist", 403);
    const issuerUrl = this.safeUrl(issuer, oauth);
    const issuerPath = issuerUrl.pathname.replace(/\/$/, "");
    const discovery = [
      issuerUrl.origin + "/.well-known/oauth-authorization-server" + issuerPath,
      issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
      issuerUrl.origin + "/.well-known/openid-configuration" + issuerPath,
    ];
    let metadata: any;
    for (const url of [...new Set(discovery)]) {
      metadata = await this.metadata(url, oauth);
      if (metadata) break;
    }
    invariant(
      metadata?.issuer === issuer &&
        (grant !== "code" ||
          metadata.code_challenge_methods_supported?.includes("S256")),
      "OAuth issuer mismatch or S256 PKCE unsupported",
      502,
    );
    invariant(
      grant === "management" ||
        (grant === "device"
          ? metadata.grant_types_supported?.includes(DEVICE_GRANT)
          : !metadata.grant_types_supported ||
            metadata.grant_types_supported.includes("authorization_code")),
      "Authorization-code grant unsupported",
      502,
    );
    const endpointOrigins = new Set([
      issuerUrl.origin,
      ...oauth.allowedEndpointOrigins.map(
        (url) => this.safeUrl(url, oauth).origin,
      ),
    ]);
    for (const endpoint of [
      ...(grant === "code"
        ? [metadata.authorization_endpoint]
        : grant === "device"
          ? [metadata.device_authorization_endpoint]
          : []),
      metadata.token_endpoint,
    ])
      invariant(
        typeof endpoint === "string" &&
          endpointOrigins.has(this.safeUrl(endpoint, oauth).origin),
        "OAuth endpoint outside reviewed origins",
        403,
      );
    const methods = metadata.token_endpoint_auth_methods_supported || [
      "client_secret_basic",
    ];
    const clientMode =
      oauth.clientMetadata &&
      metadata.client_id_metadata_document_supported === true
        ? "metadata"
        : oauth.registration
          ? "dynamic"
          : "pre_registered";
    invariant(
      !oauth.clientMetadata || clientMode !== "pre_registered",
      "Authorization server does not support Client ID Metadata Documents; no explicit fallback is configured",
      400,
    );
    const authMethod =
      (clientMode === "metadata"
        ? oauth.clientMetadata!.authentication.method
        : oauth.registration?.tokenEndpointAuthMethod) ??
      (oauth.clientSecretEnv
        ? methods.includes("client_secret_basic")
          ? "client_secret_basic"
          : "client_secret_post"
        : "none");
    if (clientMode === "metadata" && authMethod === "private_key_jwt") {
      const authentication = oauth.clientMetadata!.authentication;
      invariant(
        authentication.method === "private_key_jwt" &&
          (!metadata.token_endpoint_auth_signing_alg_values_supported ||
            metadata.token_endpoint_auth_signing_alg_values_supported.includes(
              authentication.alg,
            )),
        "Authorization server does not support the configured client assertion signing algorithm",
        400,
      );
    }
    invariant(
      methods.includes(authMethod),
      "Configured OAuth client authentication method unsupported",
      502,
    );
    return {
      metadata,
      issuer,
      endpointOrigins,
      hinted,
      protectedMetadata,
      authMethod,
      clientMode,
    };
  }
  private checkGeneration(target: Target, generation: number) {
    this.lifetime.signal.throwIfAborted();
    invariant(
      (this.generations.get(target.id) || 0) === generation,
      "OAuth configuration or authorization changed during discovery",
      409,
    );
  }
  invalidate(serverId: string) {
    invariant(
      !this.registrations.active(serverId),
      "Disconnect or finish OAuth registration before replacing configuration",
      409,
    );
    this.generations.set(serverId, (this.generations.get(serverId) || 0) + 1);
    for (const [state, flow] of this.flows)
      if (flow.target.id === serverId) this.flows.delete(state);
    this.devices.invalidate(serverId);
    this.challenges.delete(serverId);
  }
  private async client(
    target: Target,
    discovery: Awaited<ReturnType<MCPOAuth["discover"]>>,
  ) {
    if (discovery.clientMode === "metadata") {
      const metadata = target.oauth.clientMetadata!;
      clientMetadataDocument(
        metadata,
        target.oauth.redirectUri,
        metadata.authentication.method === "private_key_jwt" &&
          metadata.authentication.managed
          ? []
          : undefined,
      );
      return {
        clientId: metadata.clientId,
        authMethod: metadata.authentication.method,
      };
    }
    if (discovery.clientMode === "dynamic")
      return this.registrations.ensure(target, {
        issuer: discovery.issuer,
        endpoint: discovery.metadata.registration_endpoint,
        methods: discovery.metadata.token_endpoint_auth_methods_supported || [
          "client_secret_basic",
        ],
        validateEndpoint: (url) => {
          invariant(
            discovery.endpointOrigins.has(
              this.safeUrl(url, target.oauth).origin,
            ),
            "OAuth registration endpoint outside reviewed origins",
            403,
          );
        },
      });
    return {
      clientId: target.oauth.clientId!,
      authMethod: discovery.authMethod,
    };
  }
  async register(target: Target) {
    invariant(
      target.oauth.registration || target.oauth.clientMetadata,
      "Dynamic registration is not enabled",
      403,
    );
    const generation = this.generations.get(target.id) || 0,
      discovery = await this.discover(target, "management");
    this.checkGeneration(target, generation);
    await this.client(target, discovery);
    this.checkGeneration(target, generation);
    return {
      ...(await this.registrationStatus(target)),
      selectedMode: discovery.clientMode,
    };
  }
  async registrationStatus(target: Target) {
    if (target.oauth.clientMetadata)
      return {
        mode: "client_metadata",
        state: "configured",
        clientId: target.oauth.clientMetadata.clientId,
        publicationConfigured: target.oauth.clientMetadata.publish,
        externalHostingVerified: false,
        authMethod: target.oauth.clientMetadata.authentication.method,
        ...(target.oauth.registration
          ? { fallbackRegistration: await this.registrations.status(target) }
          : {}),
      };
    return this.registrations.status(target);
  }
  async resetRegistration(target: Target, acknowledgeUnknown = false) {
    const result = await this.registrations.reset(target, acknowledgeUnknown);
    await this.clear(target.id);
    return result;
  }
  async remoteRegistration(
    target: Target,
    method: "GET" | "PUT" | "DELETE",
    changes?: Record<string, unknown>,
    acknowledgeUnknown = false,
  ) {
    invariant(
      target.oauth.registration,
      "Dynamic registration is not configured",
      400,
    );
    this.invalidate(target.id);
    if (method === "DELETE") await this.clear(target.id);
    const origins = new Set(
      [
        ...target.oauth.allowedIssuers,
        ...target.oauth.allowedEndpointOrigins,
      ].map((value) => this.safeUrl(value, target.oauth).origin),
    );
    return this.registrations.remote(
      target,
      method,
      (url) =>
        invariant(
          origins.has(this.safeUrl(url, target.oauth).origin),
          "Remote registration endpoint outside reviewed origins",
          403,
        ),
      changes,
      acknowledgeUnknown,
    );
  }
  keyStatus(target: Target, stage = false) {
    invariant(
      target.oauth.clientMetadata,
      "Client metadata is not configured",
      400,
    );
    return this.keys.status(target.oauth.clientMetadata, stage);
  }
  deviceStatus(target: Target) {
    return this.devices.status(
      target,
      async (grant) =>
        (await this.load(target))?.deviceGrantId === grant.grantId,
    );
  }
  deviceCancel(target: Target) {
    this.devices.invalidate(target.id);
    this.generations.set(target.id, (this.generations.get(target.id) || 0) + 1);
    return { state: "cancelled" };
  }
  deviceBegin(target: Target) {
    invariant(
      target.oauth.deviceFlow,
      "Device authorization is not enabled by the host",
      403,
    );
    const generation = this.generations.get(target.id) || 0;
    return this.devices.begin(
      target,
      async (signal) => {
        const discovery = await this.discover(target, "device");
        this.checkGeneration(target, generation);
        signal.throwIfAborted();
        const configuredGrants =
          discovery.clientMode === "dynamic"
            ? target.oauth.registration?.grantTypes
            : discovery.clientMode === "metadata"
              ? target.oauth.clientMetadata?.grantTypes
              : undefined;
        invariant(
          discovery.clientMode === "pre_registered" ||
            configuredGrants?.includes(DEVICE_GRANT),
          "Registered client metadata must explicitly include the device grant",
          400,
        );
        const client = await this.client(target, discovery);
        this.checkGeneration(target, generation);
        signal.throwIfAborted();
        const previous = await this.load(target),
          scopes = [
            ...new Set([
              ...(previous?.scope.split(" ").filter(Boolean) || []),
              ...(target.oauth.scopes || []),
              ...(discovery.hinted.scope?.split(" ").filter(Boolean) ||
                (target.oauth.scopes
                  ? []
                  : discovery.protectedMetadata.scopes_supported || [])),
            ]),
          ];
        invariant(
          scopes.length <= 100 &&
            scopes.every(
              (s) =>
                typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s),
            ),
          "Invalid device OAuth scopes",
          502,
        );
        const context: DeviceContext = {
          issuer: discovery.issuer,
          tokenEndpoint: discovery.metadata.token_endpoint,
          authMethod: discovery.authMethod,
          clientId: client.clientId,
          clientMode: discovery.clientMode as DeviceContext["clientMode"],
          scope: scopes.join(" "),
          ...("clientSecret" in client
            ? { clientSecret: client.clientSecret }
            : {}),
        };
        const endpoint = discovery.metadata.device_authorization_endpoint;
        const { body, headers } = await this.form(
          target,
          context,
          { ...(context.scope ? { scope: context.scope } : {}) },
          endpoint,
        );
        const response = await fetch(endpoint, {
          method: "POST",
          body,
          headers,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        invariant(
          response.status === 200 &&
            (response.headers.get("content-type") || "").includes(
              "application/json",
            ),
          "Device authorization request failed",
          502,
        );
        const data = await readJson(response, 1024 * 1024),
          interval = data.interval ?? 5;
        if (typeof data.device_code === "string")
          registerSecret(data.device_code);
        invariant(
          typeof data.device_code === "string" &&
            /^[\x21-\x7e]{1,64000}$/.test(data.device_code) &&
            typeof data.user_code === "string" &&
            /^[\x20-\x7e]{1,200}$/.test(data.user_code) &&
            Number.isSafeInteger(data.expires_in) &&
            data.expires_in > 0 &&
            data.expires_in <= 2592000 &&
            Number.isSafeInteger(interval) &&
            interval >= 1 &&
            interval <= 86400,
          "Invalid device authorization response",
          502,
        );
        for (const uri of [
          data.verification_uri,
          ...(data.verification_uri_complete === undefined
            ? []
            : [data.verification_uri_complete]),
        ])
          invariant(
            typeof uri === "string" &&
              uri.length <= 4096 &&
              discovery.endpointOrigins.has(
                this.safeUrl(uri, target.oauth).origin,
              ),
            "Device verification URI outside reviewed origins",
            403,
          );
        return {
          deviceCode: data.device_code,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          verificationUriComplete: data.verification_uri_complete,
          expiresAt: Date.now() + data.expires_in * 1000,
          interval,
          context,
        };
      },
      () => this.checkGeneration(target, generation),
    );
  }
  devicePoll(target: Target) {
    invariant(
      target.oauth.deviceFlow,
      "Device authorization is not enabled by the host",
      403,
    );
    const generation = this.generations.get(target.id) || 0;
    return this.devices.poll(
      target,
      async (grant, signal) => {
        // Remote management can rotate a dynamic client's secret while the user authorizes the device.
        const registered =
          grant.context.clientMode === "dynamic"
            ? await this.registrations.credentials(target, grant.context.issuer)
            : undefined;
        if (grant.context.clientMode === "dynamic")
          invariant(
            registered?.clientId === grant.context.clientId,
            "Device client registration changed",
            401,
          );
        const token = await this.exchange(
          target,
          {
            ...grant.context,
            ...(registered ? { clientSecret: registered.clientSecret } : {}),
          },
          { grant_type: DEVICE_GRANT, device_code: grant.deviceCode },
          undefined,
          { signal, device: true },
        );
        return { ...token, deviceGrantId: grant.grantId };
      },
      async (token, guard) => {
        this.checkGeneration(target, generation);
        await this.save(target, token, generation, guard);
        this.challenges.delete(target.id);
      },
      async (grant) =>
        (await this.load(target))?.deviceGrantId === grant.grantId,
    );
  }
  deviceWait(target: Target, signal?: AbortSignal) {
    return this.devices.wait(target, () => this.devicePoll(target), signal);
  }
  async begin(target: Target) {
    invariant(
      target.oauth.redirectUri,
      "Authorization-code flow requires a configured callback",
      400,
    );
    const generation = this.generations.get(target.id) || 0,
      discovery = await this.discover(target);
    this.checkGeneration(target, generation);
    const client = await this.client(target, discovery);
    this.checkGeneration(target, generation);
    const { metadata, issuer, hinted, protectedMetadata, authMethod } =
        discovery,
      oauth = target.oauth;
    for (const [state, flow] of this.flows)
      if (flow.expiresAt < Date.now()) this.flows.delete(state);
    invariant(this.flows.size < 32, "Too many pending OAuth flows", 429);
    const previous = await this.load(target);
    const scopes = [
      ...new Set([
        ...(previous?.scope.split(" ").filter(Boolean) || []),
        ...(oauth.scopes || []),
        ...(hinted.scope?.split(" ").filter(Boolean) ||
          (oauth.scopes ? [] : protectedMetadata.scopes_supported || [])),
      ]),
    ];
    invariant(
      scopes.length <= 100 &&
        scopes.every(
          (scope) =>
            typeof scope === "string" &&
            /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
        ),
      "Invalid OAuth scopes",
      502,
    );
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url"),
      expiresAt = Date.now() + 10 * 60 * 1000;
    const flow: Flow = {
      target,
      binding: binding(target),
      verifier,
      issuer,
      tokenEndpoint: metadata.token_endpoint,
      authMethod,
      clientId: client.clientId,
      clientMode: discovery.clientMode as Flow["clientMode"],
      ...("clientSecret" in client
        ? { clientSecret: client.clientSecret }
        : {}),
      issRequired:
        metadata.authorization_response_iss_parameter_supported === true,
      expiresAt,
      scope: scopes.join(" "),
      generation,
    };
    this.checkGeneration(target, generation);
    this.flows.set(state, flow);
    const authorization = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: oauth.redirectUri!,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: target.url,
      ...(flow.scope ? { scope: flow.scope } : {}),
    }))
      authorization.searchParams.set(key, value);
    return {
      authorizationUrl: authorization.href,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  async complete(target: Target, callbackUrl: string) {
    this.lifetime.signal.throwIfAborted();
    const response = new URL(callbackUrl),
      redirect = new URL(target.oauth.redirectUri!),
      state = response.searchParams.get("state") || "",
      flow = this.flows.get(state);
    invariant(
      flow &&
        flow.target.id === target.id &&
        flow.binding === binding(target) &&
        flow.expiresAt > Date.now(),
      "OAuth state absent, expired, reused or bound to another server",
      400,
    );
    invariant(
      response.origin === redirect.origin &&
        response.pathname === redirect.pathname &&
        [...redirect.searchParams].every(
          ([key, value]) => response.searchParams.get(key) === value,
        ),
      "OAuth redirect URI mismatch",
      400,
    );
    this.flows.delete(state);
    for (const key of ["state", "code", "iss", "error"])
      invariant(
        response.searchParams.getAll(key).length <= 1,
        "Duplicate OAuth callback parameter",
      );
    const issuer = response.searchParams.get("iss");
    invariant(
      (issuer !== null || !flow.issRequired) &&
        (issuer === null || issuer === flow.issuer),
      "OAuth authorization response issuer mismatch",
      403,
    );
    invariant(
      !response.searchParams.has("error"),
      "Authorization was denied by the user or server",
      401,
    );
    const code = response.searchParams.get("code");
    invariant(code, "OAuth code missing");
    registerSecret(code);
    const token = await this.exchange(target, flow, {
      grant_type: "authorization_code",
      code,
      code_verifier: flow.verifier,
      redirect_uri: target.oauth.redirectUri!,
    });
    await this.save(target, token, flow.generation);
    this.challenges.delete(target.id);
    return this.status(target);
  }
  private async form(
    target: Target,
    flow: Pick<Flow, "issuer" | "tokenEndpoint" | "authMethod" | "scope"> & {
      clientId?: string;
      clientSecret?: string;
      clientMode?: Flow["clientMode"];
    },
    values: Record<string, string>,
    endpoint = flow.tokenEndpoint,
  ) {
    const clientId = flow.clientId || target.oauth.clientId;
    invariant(clientId, "OAuth client registration required", 401);
    const body = new URLSearchParams({
      ...values,
      client_id: clientId,
      resource: target.url,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (flow.authMethod === "private_key_jwt") {
      invariant(
        target.oauth.clientMetadata &&
          clientId === target.oauth.clientMetadata.clientId,
        "Client metadata no longer matches the token",
        401,
      );
      body.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      body.set(
        "client_assertion",
        await this.assertion(target.oauth.clientMetadata, endpoint),
      );
    } else if (flow.authMethod !== "none") {
      const secret =
        flow.clientSecret ||
        (target.oauth.clientSecretEnv
          ? process.env[target.oauth.clientSecretEnv]
          : undefined);
      invariant(secret, "Missing configured OAuth client secret", 503);
      registerSecret(secret);
      if (flow.authMethod === "client_secret_basic")
        headers.Authorization =
          "Basic " +
          Buffer.from(
            new URLSearchParams({ v: clientId }).toString().slice(2) +
              ":" +
              new URLSearchParams({ v: secret }).toString().slice(2),
          ).toString("base64");
      else body.set("client_secret", secret);
    }
    return { body, headers };
  }
  private async assertion(config: MCPClientMetadata, endpoint: string) {
    return config.authentication.method === "private_key_jwt" &&
      config.authentication.managed
      ? this.keys.assertion(config, endpoint)
      : clientAssertion(config, endpoint);
  }
  async publicMetadata(
    config: MCPClientMetadata,
    redirect?: string,
    published = true,
  ) {
    const document =
      config.authentication.method === "private_key_jwt" &&
      config.authentication.managed
        ? await this.keys.document(config, redirect, published)
        : clientMetadataDocument(config, redirect);
    return {
      document,
      etag: '"' + hash(JSON.stringify(document)) + '"',
      cacheControl: "public, max-age=" + config.cacheMaxAge,
    };
  }
  private async exchange(
    target: Target,
    flow: Pick<Flow, "issuer" | "tokenEndpoint" | "authMethod" | "scope"> & {
      clientId?: string;
      clientSecret?: string;
      clientMode?: Flow["clientMode"];
    },
    values: Record<string, string>,
    previous?: Token,
    options: { signal?: AbortSignal; device?: boolean } = {},
  ) {
    const { body, headers } = await this.form(target, flow, values),
      clientId = flow.clientId || target.oauth.clientId!;
    let response: Response;
    try {
      response = await fetch(flow.tokenEndpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.any([
          this.lifetime.signal,
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(10000),
        ]),
      });
    } catch (e) {
      if (
        options.device &&
        !options.signal?.aborted &&
        !this.lifetime.signal.aborted
      )
        throw Object.assign(new Error("Device token connection failed"), {
          oauthError: "connection_error",
        });
      throw e;
    }
    invariant(
      (response.headers.get("content-type") || "").includes("application/json"),
      "OAuth token response must be JSON",
      502,
    );
    const result = await readJson(response, 1024 * 1024);
    if (!response.ok) {
      if (options.device)
        throw Object.assign(new Error("Device token request failed"), {
          oauthError:
            typeof result?.error === "string"
              ? result.error
              : "invalid_response",
        });
      if (result?.error === "invalid_grant") await this.clear(target.id);
      invariant(
        false,
        "OAuth token exchange failed: " +
          (typeof result?.error === "string"
            ? result.error.slice(0, 100)
            : response.status),
        401,
        "oauth_token_failed",
      );
    }
    const lifetime = result?.expires_in ?? 300;
    invariant(
      typeof result?.access_token === "string" &&
        /^[\x21-\x7e]{1,64000}$/.test(result.access_token) &&
        result.token_type?.toLowerCase() === "bearer" &&
        Number.isFinite(lifetime) &&
        lifetime > 0 &&
        lifetime <= 365 * 24 * 3600,
      "Invalid OAuth token response",
      502,
    );
    invariant(
      result.refresh_token === undefined ||
        (typeof result.refresh_token === "string" &&
          result.refresh_token.length <= 64000),
      "Invalid OAuth refresh token",
      502,
    );
    registerSecret(result.access_token);
    if (result.refresh_token) registerSecret(result.refresh_token);
    return {
      deviceGrantId: previous?.deviceGrantId,
      access: result.access_token,
      refresh: result.refresh_token || previous?.refresh,
      expiresAt: Date.now() + lifetime * 1000,
      scope: typeof result.scope === "string" ? result.scope : flow.scope,
      binding: binding(target),
      issuer: flow.issuer,
      tokenEndpoint: flow.tokenEndpoint,
      authMethod: flow.authMethod,
      clientId,
      clientMode: flow.clientMode,
    } satisfies Token;
  }
  async authorization(target: Target): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    const generation = this.generations.get(target.id) || 0;
    const token = await this.load(target);
    this.lifetime.signal.throwIfAborted();
    invariant(
      token,
      "OAuth authorization required",
      401,
      "oauth_authorization_required",
    );
    invariant(
      (this.generations.get(target.id) || 0) === generation,
      "OAuth authorization was revoked",
      401,
    );
    if (token.expiresAt > Date.now() + 30000) return "Bearer " + token.access;
    invariant(
      token.refresh,
      "OAuth access expired; authorization required",
      401,
      "oauth_authorization_required",
    );
    let pending = this.refreshing.get(target.id);
    if (!pending) {
      pending = (async () => {
        const current = await this.load(target);
        invariant(current, "OAuth authorization was revoked", 401);
        if (current.expiresAt > Date.now() + 30000) return current;
        invariant(current.refresh, "OAuth refresh unavailable", 401);
        const dynamic =
          !!target.oauth.registration && current.clientMode !== "metadata";
        if (current.clientMode === "metadata")
          invariant(
            current.clientId === target.oauth.clientMetadata?.clientId,
            "Client metadata no longer matches the token",
            401,
          );
        const registered = dynamic
          ? await this.registrations.credentials(target, current.issuer)
          : undefined;
        if (dynamic)
          invariant(
            registered && registered.clientId === current.clientId,
            "OAuth registration no longer matches the token",
            401,
          );
        const refreshed = await this.exchange(
          target,
          {
            ...current,
            ...(registered
              ? {
                  clientId: registered.clientId,
                  clientSecret: registered.clientSecret,
                }
              : {}),
          },
          { grant_type: "refresh_token", refresh_token: current.refresh! },
          current,
        );
        await this.save(target, refreshed, generation);
        return refreshed;
      })();
      this.refreshing.set(target.id, pending);
    }
    try {
      const result = await pending;
      invariant(
        (this.generations.get(target.id) || 0) === generation,
        "OAuth authorization was revoked",
        401,
      );
      return "Bearer " + result.access;
    } finally {
      if (this.refreshing.get(target.id) === pending)
        this.refreshing.delete(target.id);
    }
  }
  async clear(serverId: string) {
    this.devices.invalidate(serverId);
    for (const [state, flow] of this.flows)
      if (flow.target.id === serverId) this.flows.delete(state);
    this.generations.set(serverId, (this.generations.get(serverId) || 0) + 1);
    this.challenges.delete(serverId);
    rmSync(this.file(serverId), { force: true });
  }
  close() {
    if (this.lifetime.signal.aborted) return;
    for (const key of new Set([
      ...this.refreshing.keys(),
      ...[...this.flows.values()].map((flow) => flow.target.id),
    ]))
      this.generations.set(key, (this.generations.get(key) || 0) + 1);
    this.flows.clear();
    this.keys.close();
    this.lifetime.abort(new Error("MCP OAuth host closed"));
  }
}
