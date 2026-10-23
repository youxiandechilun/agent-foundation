import { z } from "zod";
import {
  readEncryptedText,
  writeEncryptedJson,
} from "../../../storage/encrypted-file.js";
import { rmSync } from "node:fs";
import path from "node:path";
import { hash, invariant, registerSecret } from "../../../core/util.js";
import {
  wireIncludes,
  wireMember,
  wireObject,
  type WireObject,
} from "../../../core/wire.js";
import { readJson } from "../../../providers/sse.js";

export const registrationSchema = z
  .object({
    mode: z.literal("dynamic"),
    clientName: z.string().min(1).max(200).default("Agent Foundation"),
    tokenEndpointAuthMethod: z
      .enum(["none", "client_secret_basic", "client_secret_post"])
      .default("none"),
    applicationType: z.enum(["native", "web"]).optional(),
    grantTypes: z
      .array(
        z.enum([
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ]),
      )
      .min(1)
      .max(3)
      .optional(),
    initialAccessTokenEnv: z.string().min(1).optional(),
    softwareStatementEnv: z.string().min(1).optional(),
  })
  .strict();
type Target = {
  id: string;
  url: string;
  oauth: {
    redirectUri?: string;
    registration?: z.infer<typeof registrationSchema>;
    [k: string]: unknown;
  };
};
/** Registration endpoint and methods as discovered; both are checked before use. */
export interface RegistrationServer {
  issuer: string;
  endpoint: unknown;
  methods: unknown;
  validateEndpoint: (url: string) => void;
}
export interface RegisteredClient {
  binding: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  secretExpiresAt?: number;
  authMethod: string;
  registeredAt: string;
  registrationAccessToken?: string;
  registrationClientUri?: string;
  metadata?: Record<string, unknown>;
}
type Attempt = {
  binding: string;
  issuer: string;
  state: "pending" | "rejected";
  createdAt: string;
  error?: string;
  operation?: "GET" | "PUT" | "DELETE";
};
const targetBinding = (t: Target) =>
  hash(JSON.stringify({ url: t.url, oauth: t.oauth }));
/** RFC 7591 client storage. An uncertain POST is never automatically replayed, including after restart. */
export class MCPRegistrations {
  private pending = new Map<
    string,
    { binding: string; promise: Promise<RegisteredClient> }
  >();
  private resetting = new Set<string>();
  private managing = new Map<
    string,
    {
      method: string;
      promise: Promise<Awaited<ReturnType<MCPRegistrations["manage"]>>>;
    }
  >();
  constructor(
    private root: string,
    private key: () => Promise<Buffer>,
    private lifetime: AbortSignal,
  ) {}
  active(id: string) {
    return (
      this.pending.has(id) || this.resetting.has(id) || this.managing.has(id)
    );
  }
  private file(id: string, kind: "client" | "attempt") {
    invariant(/^[a-zA-Z0-9_-]{1,40}$/.test(id), "Invalid OAuth server ID");
    return path.join(this.root, id + ".registration-" + kind + ".json");
  }
  private async load<T>(
    target: Target,
    kind: "client" | "attempt",
  ): Promise<T | undefined> {
    const bound = targetBinding(target);
    const text = await readEncryptedText(
      this.identity(target.id, kind, bound),
      this.key,
      {
        maxBytes: 1024 * 1024,
        mismatch: "missing",
      },
    );
    if (text === undefined) return;
    const result = JSON.parse(text);
    invariant(
      result.binding === bound,
      "OAuth registration binding mismatch",
      500,
    );
    if (result.clientSecret) registerSecret(result.clientSecret);
    if (result.registrationAccessToken)
      registerSecret(result.registrationAccessToken);
    return result as T;
  }
  private async save(
    target: Target,
    kind: "client" | "attempt",
    value: RegisteredClient | Attempt,
  ) {
    this.lifetime.throwIfAborted();
    await writeEncryptedJson(
      this.identity(target.id, kind, value.binding),
      this.key,
      value,
      () => this.lifetime.throwIfAborted(),
    );
  }
  private identity(id: string, kind: "client" | "attempt", binding: string) {
    return {
      file: this.file(id, kind),
      binding,
      aad: id + "\n" + binding + "\nregistration-" + kind,
    };
  }
  async credentials(target: Target, issuer?: string) {
    this.lifetime.throwIfAborted();
    invariant(
      !this.managing.has(target.id),
      "OAuth registration management is in progress",
      409,
    );
    const attempt = await this.load<Attempt>(target, "attempt");
    invariant(
      !attempt?.operation || attempt.state !== "pending",
      "Remote registration outcome unknown; explicitly reconcile before using client credentials",
      409,
    );
    const value = await this.load<RegisteredClient>(target, "client");
    if (value) {
      invariant(
        !issuer || value.issuer === issuer,
        "Registered OAuth client issuer changed; explicit reset required",
        409,
      );
      invariant(
        !value.secretExpiresAt || value.secretExpiresAt > Date.now(),
        "Registered OAuth client secret expired; explicit reset required",
        401,
      );
    }
    return value;
  }
  async status(target: Target) {
    const value = await this.load<RegisteredClient>(target, "client"),
      attempt = await this.load<Attempt>(target, "attempt");
    return {
      mode: target.oauth.registration ? "dynamic" : "pre_registered",
      state: value
        ? "registered"
        : this.active(target.id)
          ? "registering"
          : attempt?.state === "pending"
            ? "outcome_unknown"
            : attempt?.state || "unregistered",
      clientId: value?.clientId,
      issuer: value?.issuer,
      authMethod: value?.authMethod,
      secretExpiresAt: value?.secretExpiresAt
        ? new Date(value.secretExpiresAt).toISOString()
        : undefined,
      expired: !!value?.secretExpiresAt && value.secretExpiresAt <= Date.now(),
      remoteManagement: !!(
        value?.registrationAccessToken && value.registrationClientUri
      ),
      managementState: this.managing.has(target.id)
        ? "in_progress"
        : attempt?.operation
          ? attempt.state === "pending"
            ? "outcome_unknown"
            : attempt.state
          : undefined,
      managementOperation: attempt?.operation,
      metadata: value?.metadata
        ? this.publicMetadata(value.metadata)
        : undefined,
    };
  }
  ensure(target: Target, metadata: RegistrationServer) {
    invariant(
      !this.resetting.has(target.id) && !this.managing.has(target.id),
      "OAuth registration reset is in progress",
      409,
    );
    const existing = this.pending.get(target.id),
      bound = targetBinding(target);
    if (existing) {
      invariant(
        existing.binding === bound,
        "OAuth registration configuration changed while in flight",
        409,
      );
      return existing.promise;
    }
    const promise = this.register(target, metadata);
    this.pending.set(target.id, { binding: bound, promise });
    void promise
      .finally(() => {
        if (this.pending.get(target.id)?.promise === promise)
          this.pending.delete(target.id);
      })
      .catch(() => undefined);
    return promise;
  }
  private async register(target: Target, metadata: RegistrationServer) {
    const existing = await this.credentials(target, metadata.issuer);
    if (existing) return existing;
    const config = target.oauth.registration;
    invariant(config, "Dynamic registration is not enabled", 403);
    invariant(
      wireIncludes(metadata.methods, config.tokenEndpointAuthMethod),
      "Configured dynamic client authentication unsupported",
      502,
    );
    const endpoint = metadata.endpoint;
    invariant(
      typeof endpoint === "string",
      "Authorization server has no registration endpoint",
      400,
    );
    metadata.validateEndpoint(endpoint);
    const attempt = await this.load<Attempt>(target, "attempt");
    invariant(
      attempt?.state !== "pending",
      "OAuth registration outcome unknown; inspect the authorization server and explicitly reset before retrying",
      409,
      "oauth_registration_unknown",
    );
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: WireObject = {
        client_name: config.clientName,
        ...(target.oauth.redirectUri
          ? { redirect_uris: [target.oauth.redirectUri] }
          : {}),
        grant_types: config.grantTypes || [
          "authorization_code",
          "refresh_token",
        ],
        response_types: (config.grantTypes || ["authorization_code"]).includes(
          "authorization_code",
        )
          ? ["code"]
          : [],
        token_endpoint_auth_method: config.tokenEndpointAuthMethod,
        application_type:
          config.applicationType ||
          (!target.oauth.redirectUri ||
          ["127.0.0.1", "localhost", "[::1]"].includes(
            new URL(target.oauth.redirectUri).hostname,
          )
            ? "native"
            : "web"),
      };
    const envSecret = (ref: string) => {
      const value = process.env[ref];
      invariant(
        value,
        "Missing OAuth registration environment variable: " + ref,
        503,
      );
      registerSecret(value);
      return value;
    };
    if (config.initialAccessTokenEnv) {
      const value = envSecret(config.initialAccessTokenEnv);
      invariant(
        /^[\x21-\x7e]{1,64000}$/.test(value),
        "Invalid registration initial access token",
      );
      headers.Authorization = "Bearer " + value;
    }
    if (config.softwareStatementEnv)
      body.software_statement = envSecret(config.softwareStatementEnv);
    const intent: Attempt = {
      binding: targetBinding(target),
      issuer: metadata.issuer,
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    await this.save(target, "attempt", intent);
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(10000)]),
    });
    invariant(
      (response.headers.get("content-type") || "").includes("application/json"),
      "OAuth registration response must be JSON; outcome unknown",
      502,
    );
    const data = await readJson(response, 1024 * 1024);
    if (response.status !== 201) {
      const rejection = wireMember(data, "error");
      if (
        [400, 401, 403].includes(response.status) &&
        typeof rejection === "string" &&
        /^[a-z_]{1,80}$/.test(rejection)
      )
        await this.save(target, "attempt", {
          ...intent,
          state: "rejected",
          error: rejection,
        });
      invariant(
        false,
        "OAuth registration failed (HTTP " +
          response.status +
          "); inspect registration status before retrying",
        502,
        "oauth_registration_failed",
      );
    }
    const value = this.parseClient(
      target,
      data,
      intent,
      body,
      metadata.validateEndpoint,
    );
    await this.save(target, "client", value);
    rmSync(this.file(target.id, "attempt"), { force: true });
    return value;
  }
  private publicMetadata(metadata: Record<string, unknown>) {
    const allowed = new Set([
      "client_name",
      "redirect_uris",
      "grant_types",
      "response_types",
      "token_endpoint_auth_method",
      "application_type",
      "scope",
      "contacts",
      "client_uri",
      "logo_uri",
      "tos_uri",
      "policy_uri",
      "jwks_uri",
    ]);
    return Object.fromEntries(
      Object.entries(metadata).filter(([k]) => allowed.has(k.split("#")[0])),
    );
  }
  private parseClient(
    target: Target,
    document: unknown,
    intent: Attempt,
    requested: WireObject,
    validateEndpoint: (url: string) => void,
    previous?: RegisteredClient,
  ): RegisteredClient {
    const data = wireObject(document);
    invariant(
      data,
      "Invalid remote registration document; outcome unknown",
      502,
    );
    const config = target.oauth.registration!;
    const method = data.token_endpoint_auth_method ?? "client_secret_basic";
    const clientId = data.client_id;
    invariant(
      typeof clientId === "string" && /^[\x21-\x7e]{1,2048}$/.test(clientId),
      "Invalid dynamically registered client ID; outcome unknown",
      502,
    );
    invariant(
      !previous || previous.clientId === clientId,
      "Remote registration changed client ID; outcome unknown",
      502,
    );
    invariant(
      method === config.tokenEndpointAuthMethod,
      "Registration changed the configured client authentication; outcome unknown",
      502,
    );
    const redirects = data.redirect_uris,
      requestedRedirects = requested.redirect_uris;
    invariant(
      !target.oauth.redirectUri ||
        (Array.isArray(redirects) &&
          redirects.includes(target.oauth.redirectUri) &&
          Array.isArray(requestedRedirects) &&
          redirects.length === requestedRedirects.length &&
          requestedRedirects.every((v) => redirects.includes(v))),
      "Registration redirect URI mismatch; outcome unknown",
      502,
    );
    for (const field of ["grant_types", "response_types"] as const) {
      const actual = data[field],
        expected = requested[field];
      invariant(
        Array.isArray(actual) &&
          Array.isArray(expected) &&
          actual.length === expected.length &&
          expected.every((v) => actual.includes(v)),
        "Registration changed " + field + "; outcome unknown",
        502,
      );
    }
    const secret = data.client_secret,
      expiresAt = data.client_secret_expires_at;
    invariant(
      method === "none" ||
        (typeof secret === "string" && /^[\x21-\x7e]{1,64000}$/.test(secret)),
      "Missing registered OAuth client secret; outcome unknown",
      502,
    );
    invariant(
      (secret === undefined && expiresAt === undefined) ||
        (typeof expiresAt === "number" &&
          Number.isSafeInteger(expiresAt) &&
          expiresAt >= 0 &&
          expiresAt <= 253402300799),
      "Invalid registered secret expiration; outcome unknown",
      502,
    );
    const accessToken = data.registration_access_token,
      clientUri = data.registration_client_uri;
    // Register credentials before any validation error can be rendered by the host.
    if (typeof accessToken === "string") registerSecret(accessToken);
    if (typeof secret === "string") registerSecret(secret);
    invariant(
      (clientUri === undefined &&
        accessToken === undefined &&
        !previous?.registrationClientUri) ||
        (typeof clientUri === "string" &&
          typeof accessToken === "string" &&
          /^[\x21-\x7e]{1,64000}$/.test(accessToken)),
      "Incomplete remote registration management credentials; outcome unknown",
      502,
    );
    if (typeof clientUri === "string" && clientUri) validateEndpoint(clientUri);
    const excluded = new Set([
      "client_id",
      "client_secret",
      "client_secret_expires_at",
      "client_id_issued_at",
      "registration_access_token",
      "registration_client_uri",
    ]);
    // The checks above guarantee a string secret whenever the method needs one.
    const value: RegisteredClient = {
      binding: intent.binding,
      issuer: intent.issuer,
      clientId,
      ...(method !== "none" && typeof secret === "string"
        ? { clientSecret: secret }
        : {}),
      ...(typeof expiresAt === "number" && expiresAt
        ? { secretExpiresAt: expiresAt * 1000 }
        : {}),
      // Equal to the configured method, checked above.
      authMethod: String(method),
      registeredAt: previous?.registeredAt || new Date().toISOString(),
      registrationAccessToken:
        typeof accessToken === "string" ? accessToken : undefined,
      registrationClientUri:
        typeof clientUri === "string" ? clientUri : undefined,
      metadata: Object.fromEntries(
        Object.entries(data).filter(([k]) => !excluded.has(k)),
      ),
    };
    if (value.clientSecret) registerSecret(value.clientSecret);
    return value;
  }
  remote(
    target: Target,
    method: "GET" | "PUT" | "DELETE",
    validateEndpoint: (url: string) => void,
    changes?: Record<string, unknown>,
    acknowledgeUnknown = false,
  ) {
    const previous = this.managing.get(target.id);
    if (previous && method === "GET" && previous.method === method)
      return previous.promise;
    invariant(
      !this.active(target.id),
      "Another OAuth registration operation is in progress",
      409,
    );
    const promise = this.manage(
      target,
      method,
      validateEndpoint,
      changes,
      acknowledgeUnknown,
    );
    this.managing.set(target.id, { method, promise });
    void promise
      .finally(() => {
        if (this.managing.get(target.id)?.promise === promise)
          this.managing.delete(target.id);
      })
      .catch(() => undefined);
    return promise;
  }
  private async manage(
    target: Target,
    method: "GET" | "PUT" | "DELETE",
    validateEndpoint: (url: string) => void,
    changes?: Record<string, unknown>,
    acknowledgeUnknown = false,
  ) {
    this.lifetime.throwIfAborted();
    const current = await this.load<RegisteredClient>(target, "client"),
      old = await this.load<Attempt>(target, "attempt");
    invariant(
      current?.registrationAccessToken && current.registrationClientUri,
      "Authorization server did not issue RFC 7592 management credentials",
      400,
    );
    invariant(
      old?.state !== "pending" || (acknowledgeUnknown && method === "GET"),
      "Remote registration outcome unknown; inspect the server, then explicitly acknowledge a reconciliation read",
      409,
      "oauth_registration_unknown",
    );
    validateEndpoint(current.registrationClientUri);
    const metadata: WireObject = structuredClone(current.metadata || {});
    if (method === "PUT") {
      invariant(
        changes &&
          typeof changes === "object" &&
          !Array.isArray(changes) &&
          JSON.stringify(changes).length <= 128000,
        "Invalid registration metadata changes",
      );
      const forbidden = new Set([
        "client_id",
        "client_secret",
        "registration_access_token",
        "registration_client_uri",
        "client_secret_expires_at",
        "client_id_issued_at",
        "__proto__",
        "constructor",
        "prototype",
      ]);
      for (const [k, v] of Object.entries(changes)) {
        invariant(
          !forbidden.has(k),
          "Registration credential fields cannot be changed directly",
          403,
        );
        if (v === null) delete metadata[k];
        else
          Object.defineProperty(metadata, k, {
            value: v,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      // Reuse the registration compatibility validator without changing credentials.
      this.parseClient(
        target,
        {
          ...metadata,
          client_id: current.clientId,
          client_secret: current.clientSecret,
          ...(current.clientSecret
            ? {
                client_secret_expires_at: current.secretExpiresAt
                  ? current.secretExpiresAt / 1000
                  : 0,
              }
            : {}),
          registration_client_uri: current.registrationClientUri,
          registration_access_token: current.registrationAccessToken,
        },
        {
          binding: current.binding,
          issuer: current.issuer,
          state: "pending",
          createdAt: new Date().toISOString(),
        },
        current.metadata ?? {},
        validateEndpoint,
        current,
      );
    }
    const intent: Attempt = {
      binding: targetBinding(target),
      issuer: current.issuer,
      state: "pending",
      operation: method,
      createdAt: new Date().toISOString(),
    };
    await this.save(target, "attempt", intent);
    const response = await fetch(current.registrationClientUri, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + current.registrationAccessToken,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "PUT"
        ? { body: JSON.stringify({ ...metadata, client_id: current.clientId }) }
        : {}),
      redirect: "error",
      signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(10000)]),
    });
    if (method === "DELETE" && response.status === 204) {
      await response.body?.cancel();
      this.lifetime.throwIfAborted();
      rmSync(this.file(target.id, "client"), { force: true });
      rmSync(this.file(target.id, "attempt"), { force: true });
      return {
        state: "unregistered" as const,
        remoteRegistrationDeleted: true,
      };
    }
    if ([400, 401, 403, 404, 405].includes(response.status)) {
      await response.body?.cancel();
      await this.save(target, "attempt", {
        ...intent,
        state: "rejected",
        error: "http_" + response.status,
      });
      invariant(
        false,
        "Remote registration operation rejected (HTTP " + response.status + ")",
        502,
        "oauth_registration_failed",
      );
    }
    invariant(
      method !== "DELETE" &&
        response.status === 200 &&
        (response.headers.get("content-type") || "").includes(
          "application/json",
        ),
      "Remote registration response invalid; outcome unknown",
      502,
    );
    const data = await readJson(response, 1024 * 1024);
    const value = this.parseClient(
      target,
      data,
      intent,
      method === "PUT" ? metadata : (current.metadata ?? {}),
      validateEndpoint,
      current,
    );
    await this.save(target, "client", value);
    rmSync(this.file(target.id, "attempt"), { force: true });
    return {
      state: "registered" as const,
      remoteManagement: true,
      clientId: value.clientId,
      metadata: this.publicMetadata(value.metadata!),
    };
  }
  async reset(target: Target, acknowledgeUnknown = false) {
    invariant(
      !this.active(target.id),
      "Cannot reset OAuth registration while a request is in flight",
      409,
    );
    this.resetting.add(target.id);
    try {
      const client = await this.load<RegisteredClient>(target, "client"),
        attempt = await this.load<Attempt>(target, "attempt");
      invariant(
        attempt?.state !== "pending" ||
          (client && !attempt.operation) ||
          acknowledgeUnknown,
        "Inspect the remote client and acknowledge unknown registration before local reset",
        409,
      );
      rmSync(this.file(target.id, "client"), { force: true });
      rmSync(this.file(target.id, "attempt"), { force: true });
      return { state: "unregistered", remoteRegistrationDeleted: false };
    } finally {
      this.resetting.delete(target.id);
    }
  }
  remove(id: string) {
    invariant(
      !this.active(id),
      "Cannot remove registration while in flight",
      409,
    );
    rmSync(this.file(id, "client"), { force: true });
    rmSync(this.file(id, "attempt"), { force: true });
  }
}
