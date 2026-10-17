import http from "node:http";
import { randomBytes } from "node:crypto";
import { DEVICE_GRANT } from "../../src/extensions/mcp-device.js";

/** Controlled authorization server; every protocol operation uses an actual HTTP socket. */
export async function lifecyclePeer() {
  let origin = "",
    sequence = 0;
  const clients = new Map<string, any>(),
    grants = new Map<string, any>(),
    requests: any[] = [];
  const controls: any = {
    interval: 1,
    expiresIn: 120,
    pollErrors: [],
    pollDelay: 0,
    beginDelay: 0,
    manageDelay: 0,
    manageStatus: 200,
    rotateCredentials: true,
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin),
        chunks = [];
      for await (const p of req) chunks.push(p);
      const text = Buffer.concat(chunks).toString(),
        params = new URLSearchParams(text);
      requests.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.authorization,
        text,
        at: Date.now(),
      });
      const json = (status: number, data: any) => {
        if (!res.destroyed) {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        }
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
          scopes_supported: ["read", "write"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: origin,
          token_endpoint: origin + "/token",
          device_authorization_endpoint:
            controls.deviceEndpoint || origin + "/device",
          registration_endpoint: origin + "/register",
          grant_types_supported: [DEVICE_GRANT, "refresh_token"],
          token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
          ...controls.metadata,
        });
      if (url.pathname === "/register") {
        const data = {
          ...JSON.parse(text),
          client_id: "dynamic-" + ++sequence,
          registration_access_token: "management-secret-" + sequence,
          registration_client_uri: origin + "/clients/" + sequence,
          x_extension: { preserve: "server-added" },
        };
        if (data.token_endpoint_auth_method !== "none") {
          data.client_secret = "client-secret-" + sequence;
          data.client_secret_expires_at = 0;
        }
        if (controls.registerChange) controls.registerChange(data);
        clients.set(data.client_id, data);
        return json(201, data);
      }
      if (url.pathname.startsWith("/clients/")) {
        if (controls.manageDelay)
          await new Promise((r) => setTimeout(r, controls.manageDelay));
        const entry = [...clients.entries()].find(
          ([, v]) =>
            new URL(v.registration_client_uri).pathname === url.pathname,
        );
        if (
          !entry ||
          req.headers.authorization !==
            "Bearer " + entry[1].registration_access_token
        )
          return json(401, { error: "invalid_token" });
        if (controls.manageStatus !== 200)
          return json(controls.manageStatus, {
            error: "invalid_client_metadata",
          });
        const [id, current] = entry;
        if (req.method === "DELETE") {
          clients.delete(id);
          if (controls.manageDrop) {
            req.socket.destroy();
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
        let data = { ...current };
        if (req.method === "PUT") {
          const update = JSON.parse(text);
          if (
            update.client_id !== id ||
            [
              "registration_access_token",
              "registration_client_uri",
              "client_secret_expires_at",
              "client_id_issued_at",
            ].some((k) => k in update)
          )
            return json(400, { error: "invalid_client_metadata" });
          data = {
            ...update,
            client_id: id,
            registration_access_token: current.registration_access_token,
            registration_client_uri: current.registration_client_uri,
            ...(current.client_secret
              ? {
                  client_secret: current.client_secret,
                  client_secret_expires_at: 0,
                }
              : {}),
          };
        }
        if (controls.rotateCredentials) {
          data.registration_access_token = "rotated-management-" + ++sequence;
          if (data.client_secret)
            data.client_secret = "rotated-client-" + sequence;
        }
        if (controls.manageChange) controls.manageChange(data);
        clients.set(id, data);
        if (controls.manageDrop) {
          req.socket.destroy();
          return;
        }
        return json(200, data);
      }
      const authenticate = () => {
        const clientId = params.get("client_id")!,
          client = clients.get(clientId);
        if (!client && clientId !== "public-client") return false;
        const method =
            client?.token_endpoint_auth_method ||
            controls.staticMethod ||
            "none",
          secret = client?.client_secret || controls.staticSecret;
        const encode = (v: string) =>
          new URLSearchParams({ v }).toString().slice(2);
        if (
          method === "client_secret_basic" &&
          req.headers.authorization !==
            "Basic " +
              Buffer.from(encode(clientId) + ":" + encode(secret)).toString(
                "base64",
              )
        )
          return false;
        return (
          method !== "client_secret_post" ||
          params.get("client_secret") === secret
        );
      };
      if (url.pathname === "/device") {
        if (controls.beginDelay)
          await new Promise((r) => setTimeout(r, controls.beginDelay));
        if (!authenticate() || params.get("resource") !== origin + "/mcp")
          return json(401, { error: "invalid_client" });
        const device = "private-device-" + randomBytes(16).toString("hex"),
          user = "USER-" + ++sequence;
        grants.set(device, {
          id: params.get("client_id"),
          user,
          approved: false,
        });
        const data: any = {
          device_code: device,
          user_code: user,
          verification_uri: origin + "/verify",
          verification_uri_complete: origin + "/verify?user_code=" + user,
          expires_in: controls.expiresIn,
        };
        if (controls.interval !== undefined) data.interval = controls.interval;
        if (controls.deviceChange) controls.deviceChange(data);
        return json(200, data);
      }
      if (url.pathname === "/verify") {
        for (const grant of grants.values())
          if (grant.user === url.searchParams.get("user_code"))
            grant.approved = true;
        return json(200, { approved: true });
      }
      if (url.pathname === "/token") {
        if (controls.pollDelay)
          await new Promise((r) => setTimeout(r, controls.pollDelay));
        if (controls.pollDrop) {
          req.socket.destroy();
          return;
        }
        if (!authenticate() || params.get("resource") !== origin + "/mcp")
          return json(401, { error: "invalid_client" });
        if (params.get("grant_type") !== "refresh_token") {
          if (params.get("grant_type") !== DEVICE_GRANT)
            return json(400, { error: "unsupported_grant_type" });
          const grant = grants.get(params.get("device_code")!);
          if (!grant || grant.id !== params.get("client_id"))
            return json(400, { error: "expired_token" });
          const error =
            controls.pollErrors.shift() ||
            (!grant.approved ? "authorization_pending" : undefined);
          if (error) return json(400, { error });
          grants.delete(params.get("device_code")!);
        }
        return json(200, {
          access_token: "device-access-" + ++sequence,
          refresh_token: "device-refresh-" + sequence,
          token_type: "Bearer",
          expires_in: params.get("grant_type") === "refresh_token" ? 3600 : 1,
          scope: "read write",
        });
      }
      json(404, {});
    } catch {
      if (!res.destroyed) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"fixture_failure"}');
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    controls,
    requests,
    clients,
    grants,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
