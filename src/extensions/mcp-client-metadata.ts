import { z } from "zod";
import {
  createPrivateKey,
  createPublicKey,
  sign,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { invariant, registerSecret, hash } from "../util.js";
export function clientMetadataURL(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid client metadata URL");
  }
  const path = value.replace(/^https:\/\/[^/]+/, "").split(/[?#]/)[0];
  invariant(
    url.protocol === "https:" &&
      url.pathname !== "/" &&
      path.startsWith("/") &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      !value.includes("\\"),
    "Client metadata ID requires an HTTPS URL with a non-root path and no query, credentials or fragment",
  );
  invariant(
    !path.split("/").some((p) => [".", ".."].includes(decodeURIComponent(p))),
    "Client metadata URL cannot contain dot segments",
  );
  return url;
}
const metadataUrl = z
  .string()
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      clientMetadataURL(value);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
    }
  });
export const clientMetadataSchema = z
  .object({
    clientId: metadataUrl,
    clientName: z.string().min(1).max(200),
    redirectUris: z.array(z.string().url().max(2048)).min(1).max(20).optional(),
    clientUri: z.string().url().optional(),
    logoUri: z.string().url().optional(),
    tosUri: z.string().url().optional(),
    policyUri: z.string().url().optional(),
    publish: z.boolean().default(true),
    cacheMaxAge: z.number().int().min(0).max(3600).default(300),
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
    authentication: z
      .discriminatedUnion("method", [
        z.object({ method: z.literal("none") }).strict(),
        z
          .object({
            method: z.literal("private_key_jwt"),
            privateKeyEnv: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .optional(),
            alg: z.enum(["RS256", "ES256", "EdDSA"]),
            kid: z.string().min(1).max(200).optional(),
            managed: z
              .object({
                rotationIntervalSeconds: z
                  .number()
                  .int()
                  .min(120)
                  .max(31536000)
                  .default(86400),
                prepublishSeconds: z
                  .number()
                  .int()
                  .min(60)
                  .max(86400)
                  .default(600),
                retainSeconds: z
                  .number()
                  .int()
                  .min(120)
                  .max(86400)
                  .default(3600),
              })
              .strict()
              .optional(),
          })
          .strict(),
      ])
      .default({ method: "none" }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const auth = value.authentication;
    if (auth.method === "private_key_jwt") {
      if (
        auth.managed
          ? !!auth.privateKeyEnv || !!auth.kid || !value.publish
          : !auth.privateKeyEnv || !auth.kid
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Choose an environment key with kid, or managed keys with built-in publication",
        });
      if (
        auth.managed &&
        (auth.managed.prepublishSeconds < value.cacheMaxAge + 60 ||
          auth.managed.rotationIntervalSeconds <=
            auth.managed.prepublishSeconds)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Key prepublication must cover metadata cache plus 60 seconds and fit within the rotation interval",
        });
    }
    if (
      value.grantTypes &&
      new Set(value.grantTypes).size !== value.grantTypes.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate client grant types" });
  });
export type MCPClientMetadata = z.infer<typeof clientMetadataSchema>;
function metadataKey(config: MCPClientMetadata): { key: KeyObject; jwk: any } {
  invariant(
    config.authentication.method === "private_key_jwt",
    "Asymmetric client authentication is not configured",
  );
  const authentication = config.authentication,
    material = authentication.privateKeyEnv
      ? process.env[authentication.privateKeyEnv]
      : undefined;
  invariant(
    material,
    "Missing client metadata private key environment variable",
    503,
  );
  registerSecret(material);
  let key: KeyObject;
  try {
    key = createPrivateKey(material);
  } catch {
    throw new Error("Invalid client metadata private key");
  }
  invariant(
    authentication.alg === "RS256"
      ? key.asymmetricKeyType === "rsa" &&
          (key.asymmetricKeyDetails?.modulusLength || 0) >= 2048
      : authentication.alg === "ES256"
        ? key.asymmetricKeyType === "ec" &&
          key.asymmetricKeyDetails?.namedCurve === "prime256v1"
        : key.asymmetricKeyType === "ed25519",
    "Client assertion algorithm does not match the configured key",
  );
  const jwk = createPublicKey(key).export({ format: "jwk" });
  return {
    key,
    jwk: {
      ...jwk,
      alg: authentication.alg,
      kid: authentication.kid,
      use: "sig",
    },
  };
}
export function clientMetadataDocument(
  config: MCPClientMetadata,
  redirectUri?: string,
  publicKeys?: any[],
) {
  clientMetadataURL(config.clientId);
  const grants = config.grantTypes || ["authorization_code", "refresh_token"],
    redirects = config.redirectUris || (redirectUri ? [redirectUri] : []);
  invariant(
    (!grants.includes("authorization_code") ||
      (!!redirectUri && redirects.includes(redirectUri))) &&
      new Set(redirects).size === redirects.length,
    "Client metadata redirect URIs must uniquely include the configured OAuth callback",
  );
  for (const value of redirects) {
    const url = new URL(value);
    invariant(
      !url.username &&
        !url.password &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))),
      "Client metadata callback requires HTTPS or loopback HTTP",
    );
  }
  const document: any = {
    client_id: config.clientId,
    client_name: config.clientName,
    ...(redirects.length ? { redirect_uris: redirects } : {}),
    grant_types: grants,
    response_types: grants.includes("authorization_code") ? ["code"] : [],
    token_endpoint_auth_method: config.authentication.method,
  };
  for (const [field, value] of [
    ["client_uri", config.clientUri],
    ["logo_uri", config.logoUri],
    ["tos_uri", config.tosUri],
    ["policy_uri", config.policyUri],
  ])
    if (value) {
      const url = new URL(value);
      invariant(
        url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash,
        "Client metadata presentation URLs require HTTPS",
      );
      document[field!] = value;
    }
  if (config.authentication.method === "private_key_jwt") {
    invariant(
      publicKeys || !config.authentication.managed,
      "Managed client keys require the OAuth key manager",
    );
    document.jwks = { keys: publicKeys || [metadataKey(config).jwk] };
  }
  return document;
}
export function clientAssertion(
  config: MCPClientMetadata,
  tokenEndpoint: string,
  managedKey?: { key: KeyObject; kid: string },
  now = Date.now(),
) {
  invariant(
    config.authentication.method === "private_key_jwt",
    "Client assertion authentication is not configured",
  );
  const { key } = managedKey || metadataKey(config),
    authentication = config.authentication,
    time = Math.floor(now / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({
      typ: "JWT",
      alg: authentication.alg,
      kid: managedKey?.kid || authentication.kid,
    }),
    payload = encode({
      iss: config.clientId,
      sub: config.clientId,
      aud: tokenEndpoint,
      iat: time,
      exp: time + 60,
      jti: randomBytes(24).toString("base64url"),
    }),
    input = header + "." + payload;
  const signature = sign(
    authentication.alg === "EdDSA" ? null : "sha256",
    Buffer.from(input),
    {
      key,
      ...(authentication.alg === "ES256"
        ? { dsaEncoding: "ieee-p1363" as const }
        : {}),
    },
  ).toString("base64url");
  const assertion = input + "." + signature;
  // A fresh assertion is created for every request; do not retain all historical JWTs indefinitely.
  registerSecret(assertion, 120000);
  return assertion;
}
export function publicMetadataResponse(
  config: MCPClientMetadata,
  redirectUri: string,
) {
  const document = clientMetadataDocument(config, redirectUri);
  return {
    document,
    etag: '"' + hash(JSON.stringify(document)) + '"',
    cacheControl: "public, max-age=" + config.cacheMaxAge,
  };
}
