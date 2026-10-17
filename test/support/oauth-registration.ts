import http from "node:http";
import { createHash } from "node:crypto";
export async function registrationPeer() {
  let origin = "",
    registrations = 0,
    exchanges = 0,
    refreshes = 0;
  const requests: any[] = [],
    grants = new Map<string, URLSearchParams>(),
    clients = new Map<string, any>(),
    refreshTokens = new Map<string, string>();
  const controls: {
    status: number;
    error: string;
    drop: boolean;
    delayMs: number;
    metadataDelay: number;
    endpoint?: string;
    initialToken?: string;
    change?: (data: any) => any;
  } = {
    status: 201,
    error: "invalid_client_metadata",
    drop: false,
    delayMs: 0,
    metadataDelay: 0,
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin),
        parts = [];
      for await (const p of req) parts.push(p);
      const text = Buffer.concat(parts).toString();
      requests.push({ path: url.pathname, headers: req.headers, text });
      const json = (status: number, data: any) => {
        if (res.destroyed) return;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/mcp") {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json(200, {
          resource: origin + "/mcp",
          authorization_servers: [origin],
          scopes_supported: ["read"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (controls.metadataDelay)
          await new Promise((r) => setTimeout(r, controls.metadataDelay));
        return json(200, {
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          registration_endpoint: controls.endpoint ?? origin + "/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === "/register") {
        registrations++;
        if (controls.delayMs)
          await new Promise((r) => setTimeout(r, controls.delayMs));
        if (controls.drop) {
          req.socket.destroy();
          return;
        }
        if (
          controls.initialToken &&
          req.headers.authorization !== "Bearer " + controls.initialToken
        )
          return json(401, { error: "invalid_token" });
        if (controls.status !== 201)
          return json(controls.status, { error: controls.error });
        const meta = JSON.parse(text),
          id = "dynamic:client+/" + registrations,
          secret = "registration-secret:+/=?&" + registrations;
        let data = {
          ...meta,
          client_id: id,
          ...(meta.token_endpoint_auth_method !== "none"
            ? { client_secret: secret, client_secret_expires_at: 0 }
            : {}),
        };
        if (controls.change) data = controls.change(data);
        clients.set(data.client_id, data);
        return json(201, data);
      }
      if (url.pathname === "/authorize") {
        const p = url.searchParams,
          client = clients.get(p.get("client_id")!);
        if (
          !client ||
          !client.redirect_uris.includes(p.get("redirect_uri")) ||
          p.get("code_challenge_method") !== "S256" ||
          p.get("resource") !== origin + "/mcp"
        )
          return json(400, { error: "invalid_request" });
        const code = "registration-code-" + grants.size;
        grants.set(code, p);
        const callback = new URL(p.get("redirect_uri")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", p.get("state")!);
        callback.searchParams.set("iss", origin);
        res.writeHead(302, { Location: callback.href });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        exchanges++;
        const p = new URLSearchParams(text),
          id = p.get("client_id")!,
          client = clients.get(id);
        if (!client) return json(401, { error: "invalid_client" });
        const encode = (v: string) =>
          new URLSearchParams({ v }).toString().slice(2);
        if (
          client.token_endpoint_auth_method === "client_secret_basic" &&
          req.headers.authorization !==
            "Basic " +
              Buffer.from(
                encode(id) + ":" + encode(client.client_secret),
              ).toString("base64")
        )
          return json(401, { error: "invalid_client" });
        if (
          client.token_endpoint_auth_method === "client_secret_post" &&
          p.get("client_secret") !== client.client_secret
        )
          return json(401, { error: "invalid_client" });
        if (p.get("resource") !== origin + "/mcp")
          return json(400, { error: "invalid_target" });
        const refresh = p.get("grant_type") === "refresh_token";
        if (refresh) {
          refreshes++;
          if (refreshTokens.get(p.get("refresh_token")!) !== id)
            return json(400, { error: "invalid_grant" });
          refreshTokens.delete(p.get("refresh_token")!);
        } else {
          const grant = grants.get(p.get("code")!);
          grants.delete(p.get("code")!);
          if (
            !grant ||
            grant.get("client_id") !== id ||
            p.get("redirect_uri") !== grant.get("redirect_uri") ||
            createHash("sha256")
              .update(p.get("code_verifier") || "")
              .digest("base64url") !== grant.get("code_challenge")
          )
            return json(400, { error: "invalid_grant" });
        }
        const next = "registration-refresh-" + exchanges;
        refreshTokens.set(next, id);
        return json(200, {
          access_token: "registration-access-" + exchanges,
          refresh_token: next,
          token_type: "Bearer",
          expires_in: refresh ? 3600 : 1,
          scope: "read",
        });
      }
      json(404, {});
    } catch (e) {
      if (!res.destroyed) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fixture_failure" }));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    requests,
    controls,
    counts: () => ({ registrations, exchanges, refreshes }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
