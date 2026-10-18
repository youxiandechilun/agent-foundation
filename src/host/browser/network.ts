import http from "node:http";
import net, { isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import {
  hostMatches,
  restrictedAddress as restrictedBrowserAddress,
} from "../../web/network-policy.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../../core/config.js";
import { invariant, registerSecret } from "../../core/util.js";

export { restrictedAddress as restrictedBrowserAddress } from "../../web/network-policy.js";
export function browserURL(url: string, config: Config) {
  invariant(url.length <= 16384, "Browser URL is too long");
  const parsed = new URL(url);
  invariant(
    ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password,
    "Browser requires HTTP(S) without URL credentials",
    403,
  );
  invariant(
    config.browser.enabled &&
      config.permissions.browser !== "deny" &&
      config.permissions.network !== "deny",
    "Browser network is disabled",
    403,
  );
  const host = parsed.hostname.toLowerCase(),
    allowed = config.browser.allowedHosts;
  invariant(hostMatches(allowed, host), "Browser host is not allowed", 403);
  return parsed;
}
export async function resolveBrowserURL(url: string, config: Config) {
  const parsed = browserURL(url, config),
    host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  browserURL(url, config);
  invariant(
    addresses.length &&
      (config.browser.allowPrivateNetwork ||
        addresses.every((a) => !restrictedBrowserAddress(a.address))),
    "Private or reserved browser network is disabled",
    403,
  );
  return { url: parsed, addresses };
}
export async function validateBrowserUrl(url: string, config: Config) {
  if (url === "about:blank") return;
  await resolveBrowserURL(url, config);
}
/** Managed Chromium routes TCP through this host-local proxy. The checked DNS result is the connect address. */
export class BrowserNetwork {
  private server = http.createServer();
  private sockets = new Set<Socket>();
  private connections = new Set<Socket>();
  private closed = false;
  private destinations = new Map<Socket, string>();
  private password = randomBytes(32).toString("base64url");
  private readonly proxyAuthorization = Buffer.from(
    "Basic " + Buffer.from("foundation:" + this.password).toString("base64"),
  );
  private monitor?: ReturnType<typeof setInterval>;
  url = "";
  get proxy() {
    return {
      server: this.url,
      username: "foundation",
      password: this.password,
    };
  }
  constructor(
    private config: Config,
    private authorize?: () => void,
  ) {
    registerSecret(this.password);
    registerSecret(this.proxyAuthorization.toString().slice(6));
  }
  private track(socket: Socket, url?: string) {
    invariant(
      !this.closed &&
        this.sockets.size < this.config.browser.maxConnections * 2,
      "Browser connection capacity reached",
      429,
    );
    this.sockets.add(socket);
    if (url) {
      this.destinations.set(socket, url);
      this.connections.add(socket);
    }
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.destinations.delete(socket);
      this.connections.delete(socket);
    });
    socket.on("error", () => undefined);
    return socket;
  }
  async start() {
    this.server.on("connection", (socket) => {
      try {
        this.track(socket);
      } catch {
        socket.destroy();
      }
    });
    this.server.on("request", (request, response) => {
      void this.request(request, response);
    });
    this.server.on("connect", (request, socket, head) => {
      void this.connect(request, socket as Socket, head);
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.upgrade(request, socket as Socket, head);
    });
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 30000;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
    this.monitor = setInterval(() => {
      for (const [socket, url] of this.destinations)
        try {
          this.authorize?.();
          browserURL(url, this.config);
          invariant(
            this.config.browser.allowPrivateNetwork ||
              !socket.remoteAddress ||
              !restrictedBrowserAddress(socket.remoteAddress),
            "Browser address is no longer allowed",
            403,
          );
        } catch {
          socket.destroy();
        }
    }, 250);
    this.monitor.unref();
    return this;
  }
  private async request(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    let outgoing: http.ClientRequest | undefined;
    try {
      if (!this.authorized(request)) {
        response.writeHead(407, {
          "Proxy-Authenticate": 'Basic realm="Foundation browser"',
        });
        response.end();
        return;
      }
      invariant(!this.closed, "Browser proxy closed", 503);
      this.authorize?.();
      const { url, addresses } = await resolveBrowserURL(
        request.url || "",
        this.config,
      );
      invariant(url.protocol === "http:", "HTTPS must use CONNECT", 403);
      invariant(
        this.connections.size < this.config.browser.maxConnections,
        "Browser proxy capacity reached",
        429,
      );
      const address = addresses[0];
      this.authorize?.();
      const headers: http.OutgoingHttpHeaders = {
        ...request.headers,
        host: url.host,
      };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      delete headers["connection"];
      outgoing = http.request(
        {
          hostname: address.address,
          family: address.family,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: request.method,
          headers,
          agent: false,
        },
        (upstream) => {
          response.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      outgoing.on("socket", (socket) => {
        try {
          this.track(socket, url.href);
        } catch {
          socket.destroy();
        }
      });
      outgoing.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      outgoing.setTimeout(this.config.browser.timeoutMs, () =>
        outgoing?.destroy(new Error("Browser proxy timeout")),
      );
      request.once("aborted", () => outgoing?.destroy());
      response.once("close", () => outgoing?.destroy());
      request.pipe(outgoing);
    } catch {
      outgoing?.destroy();
      if (!response.headersSent)
        response.writeHead(403, { Connection: "close" });
      response.end("Browser request blocked by host policy");
    }
  }
  private async connect(
    request: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) {
    let upstream: Socket | undefined;
    try {
      if (!this.authorized(request)) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Foundation browser"\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      const authority = request.url || "";
      this.authorize?.();
      invariant(!/[\s/@?#]/.test(authority), "Invalid CONNECT authority", 403);
      const { url, addresses } = await resolveBrowserURL(
        "https://" + authority + "/",
        this.config,
      );
      invariant(
        !this.closed &&
          this.connections.size < this.config.browser.maxConnections,
        "Browser proxy unavailable",
        503,
      );
      this.authorize?.();
      upstream = net.connect({
        host: addresses[0].address,
        family: addresses[0].family,
        port: Number(url.port || 443),
      });
      this.track(upstream, url.href);
      upstream.setTimeout(60000, () => upstream?.destroy());
      upstream.once("connect", () => {
        if (this.closed || socket.destroyed) {
          upstream?.destroy();
          return;
        }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream!.write(head);
        socket.pipe(upstream!);
        upstream!.pipe(socket);
      });
      socket.once("close", () => upstream?.destroy());
      upstream.once("close", () => socket.destroy());
    } catch {
      upstream?.destroy();
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }
  private authorized(request: http.IncomingMessage) {
    const actual = Buffer.from(request.headers["proxy-authorization"] || "");
    return (
      actual.length === this.proxyAuthorization.length &&
      timingSafeEqual(actual, this.proxyAuthorization)
    );
  }
  private async upgrade(
    request: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) {
    let upstream: Socket | undefined;
    try {
      this.authorize?.();
      invariant(
        this.authorized(request),
        "Browser proxy authentication required",
        401,
      );
      invariant(
        request.url?.startsWith("ws://"),
        "Invalid WebSocket proxy request",
        403,
      );
      const { url, addresses } = await resolveBrowserURL(
        request.url!.replace(/^ws:/, "http:"),
        this.config,
      );
      invariant(
        !this.closed &&
          this.connections.size < this.config.browser.maxConnections,
        "Browser proxy unavailable",
        503,
      );
      this.authorize?.();
      upstream = net.connect({
        host: addresses[0].address,
        family: addresses[0].family,
        port: Number(url.port || 80),
      });
      this.track(upstream, url.href);
      upstream.once("connect", () => {
        if (this.closed || socket.destroyed) {
          upstream?.destroy();
          return;
        }
        const headers: http.OutgoingHttpHeaders = {
          ...request.headers,
          host: url.host,
        };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        upstream!.write(
          `GET ${url.pathname + url.search} HTTP/1.1\r\n` +
            Object.entries(headers)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => k + ": " + (Array.isArray(v) ? v.join(", ") : v))
              .join("\r\n") +
            "\r\n\r\n",
        );
        if (head.length) upstream!.write(head);
        socket.pipe(upstream!);
        upstream!.pipe(socket);
      });
      socket.once("close", () => upstream?.destroy());
      upstream.once("close", () => socket.destroy());
    } catch {
      upstream?.destroy();
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.monitor) clearInterval(this.monitor);
    for (const socket of this.sockets) socket.destroy();
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
