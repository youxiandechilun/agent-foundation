import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";
import { isIP, type Socket, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { readFileSync } from "node:fs";
import { hostMatches, restrictedAddress } from "./network-policy.js";
export { restrictedAddress } from "./network-policy.js";
import type { Config } from "../core/config.js";
import { AppError, invariant, registerSecret } from "../core/util.js";
import { wireObject, wireMember } from "../core/wire.js";

/**
 * Built-in web access for the core: a guarded HTTP(S) client (host allowlist, private-network
 * blocking enforced at connect time, bounded redirects/bytes/time, HTTP proxy with CONNECT),
 * HTML-to-text conversion and pluggable search providers. No browser engine is required.
 */
export type WebConfig = Config["web"];
export interface WebResponse {
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
export interface WebRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Host-configured endpoints (search providers) may live on private networks. */
  trusted?: boolean;
  signal?: AbortSignal;
}
export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}
export interface WebSearchProvider {
  id: string;
  search(
    query: string,
    options: {
      maxResults: number;
      signal: AbortSignal;
      config: WebConfig["search"];
      request: (url: string, init?: WebRequest) => Promise<WebResponse>;
    },
  ): Promise<WebSearchResult[]>;
}
export interface WebPage {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
}

const localName = (host: string) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.endsWith(".local") ||
  host.endsWith(".internal") ||
  !host.includes(".");
/** Proxy for a target per config: "none", an explicit URL, or HTTP(S)_PROXY honouring NO_PROXY. */
export function proxyFor(target: URL, setting: string, env = process.env) {
  if (setting === "none") return undefined;
  let raw = setting;
  if (setting === "env") {
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const bypass = (env.NO_PROXY ?? env.no_proxy ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean);
    if (
      bypass.some(
        (b) =>
          b === "*" ||
          b === host ||
          (b.startsWith("*.") && host.endsWith(b.slice(1))) ||
          (b.startsWith(".") && host.endsWith(b)) ||
          (!b.startsWith(".") && host.endsWith("." + b)),
      )
    )
      return undefined;
    raw =
      (target.protocol === "https:"
        ? (env.HTTPS_PROXY ?? env.https_proxy)
        : undefined) ??
      env.HTTP_PROXY ??
      env.http_proxy ??
      "";
    if (!raw) return undefined;
  }
  const proxy = new URL(raw);
  // SOCKS and other schemes are not implemented; refuse rather than silently connect directly.
  invariant(
    proxy.protocol === "http:" || proxy.protocol === "https:",
    `Unsupported proxy scheme ${proxy.protocol}`,
    502,
  );
  return proxy;
}
const decodeEntities = (text: string) =>
  text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (match, name: string) => {
      if (name[0] === "#") {
        const code =
          name[1] === "x" || name[1] === "X"
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return ENTITIES[name.toLowerCase()] ?? match;
    },
  );
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  times: "×",
  deg: "°",
  euro: "€",
  yen: "¥",
  pound: "£",
};
/** Readable text from HTML: drops non-content elements, keeps headings, lists, links and tables. */
export function htmlToText(html: string, baseUrl?: string) {
  const title = decodeEntities(
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ") ||
      "",
  ).trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|canvas|object|textarea|select)\b[\s\S]*?<\/\1\s*>/gi,
      "",
    );
  const region = (tag: string) =>
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(
      body,
    )?.[1];
  const main = region("main") || region("article");
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 200) body = main;
  else body = region("body") || body;
  body = body
    .replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, "\n")
    .replace(
      /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q, href: string, inner: string) => {
        const label = inner
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!label) return "";
        try {
          const target = new URL(decodeEntities(href), baseUrl);
          return /^https?:$/.test(target.protocol) && target.href !== label
            ? `[${label}](${target.href})`
            : label;
        } catch {
          return label;
        }
      },
    )
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(+n)} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<pre\b[^>]*>/gi, "\n```\n")
    .replace(/<\/pre\s*>/gi, "\n```\n")
    .replace(
      /<\/?(p|div|section|header|tr|table|ul|ol|dl|dt|dd|blockquote|h[1-6]|figure|figcaption|hr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(body)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title || undefined, text };
}
function charsetOf(contentType: string, body: Buffer) {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  const sniffed = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(
    body.subarray(0, 4096).toString("latin1"),
  )?.[1];
  for (const label of [declared, sniffed, "utf-8"])
    if (label)
      try {
        return new TextDecoder(label);
      } catch {
        // Unknown label; try the next candidate.
      }
  return new TextDecoder("utf-8");
}
const textual = (type: string) =>
  /^text\/|[/+](json|xml|javascript|ecmascript|x-yaml|yaml|csv|markdown)\b/i.test(
    type,
  );
export const isHtml = (type: string) =>
  /text\/html|application\/xhtml/i.test(type);

export class WebClient {
  private providers = new Map<string, WebSearchProvider>();
  private cache = new Map<string, { at: number; page: WebPage }>();
  private ca?: string[];
  constructor(readonly config: WebConfig) {
    for (const provider of BUILTIN_PROVIDERS)
      this.providers.set(provider.id, provider);
  }
  /** Register a search provider (e.g. a regional engine); select it with web.search.provider. */
  registerSearchProvider(provider: WebSearchProvider) {
    invariant(
      /^[a-zA-Z0-9._-]{1,64}$/.test(provider.id) &&
        !this.providers.has(provider.id),
      "Duplicate or invalid search provider ID",
    );
    this.providers.set(provider.id, provider);
    return () =>
      this.providers.get(provider.id) === provider &&
      this.providers.delete(provider.id);
  }
  get searchAvailable() {
    return (
      this.config.enabled && this.providers.has(this.config.search.provider)
    );
  }
  private trustRoots() {
    if (!this.config.extraCaFile) return undefined;
    this.ca ??= [
      ...tls.rootCertificates,
      readFileSync(this.config.extraCaFile, "utf8"),
    ];
    return this.ca;
  }
  /** Validates scheme, credentials and host lists; returns the normalized host. */
  private check(url: URL, trusted: boolean) {
    invariant(
      (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password,
      "Web access requires HTTP(S) without URL credentials",
      403,
      "web_denied",
    );
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (trusted) return host;
    invariant(
      hostMatches(this.config.allowedHosts, host) &&
        !hostMatches(this.config.blockedHosts, host),
      `Web host ${host} is not allowed`,
      403,
      "web_denied",
    );
    if (!this.config.allowPrivateNetwork)
      invariant(
        isIP(host) ? !restrictedAddress(host) : !localName(host),
        `Private or reserved network address ${host} is blocked`,
        403,
        "web_denied",
      );
    return host;
  }
  /** One request with manual, re-validated redirects. */
  async request(raw: string, init: WebRequest = {}): Promise<WebResponse> {
    invariant(raw.length <= 16384, "URL is too long", 400);
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(this.config.timeoutMs),
    ]);
    let url = new URL(raw),
      method = init.method || "GET",
      body = init.body;
    for (let hop = 0; ; hop++) {
      this.check(url, Boolean(init.trusted));
      const response = await this.send(url, method, init, body, signal);
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location) {
        invariant(
          hop < this.config.maxRedirects,
          `Too many redirects (>${this.config.maxRedirects})`,
          502,
        );
        url = new URL(location, url);
        if (response.status !== 307 && response.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return { ...response, url: url.href };
    }
  }
  private send(
    url: URL,
    method: string,
    init: WebRequest,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Omit<WebResponse, "url">> {
    const allowPrivate =
      Boolean(init.trusted) || this.config.allowPrivateNetwork;
    const proxy = proxyFor(url, this.config.proxy);
    const headers: Record<string, string> = {
      "User-Agent": this.config.userAgent,
      Accept:
        "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      ...init.headers,
    };
    if (body !== undefined)
      headers["Content-Length"] = String(Buffer.byteLength(body));
    // Connect-time check: the address actually dialled is the one validated (no DNS rebinding).
    const lookup: LookupFunction = (hostname, options, callback) =>
      dnsLookup(hostname, { ...options, all: true }, (error, list) => {
        if (error) return callback(error, []);
        if (
          !list.length ||
          (!allowPrivate && list.some((a) => restrictedAddress(a.address)))
        )
          return callback(
            new AppError(
              403,
              "web_denied",
              `Private or reserved network address for ${hostname} is blocked`,
            ),
            [],
          );
        if (options?.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
      });
    return new Promise((resolve, reject) => {
      const fail = (error: unknown) =>
        reject(
          error instanceof AppError
            ? error
            : signal.aborted && !init.signal?.aborted
              ? new AppError(
                  504,
                  "web_timeout",
                  `Web request timed out after ${this.config.timeoutMs} ms`,
                )
              : error,
        );
      const finish = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.config.maxBytes) {
            res.destroy();
            return fail(
              new AppError(
                413,
                "web_too_large",
                `Response exceeds ${this.config.maxBytes} bytes`,
              ),
            );
          }
          chunks.push(chunk);
        });
        res.once("error", fail);
        res.once("end", () => {
          try {
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: this.decode(
                Buffer.concat(chunks),
                res.headers["content-encoding"],
              ),
            });
          } catch (error) {
            fail(error);
          }
        });
      };
      const options: https.RequestOptions & tls.ConnectionOptions = {
        method,
        headers,
        signal,
        agent: false,
        ca: this.trustRoots(),
        // Some servers (e.g. baidu.com) reset TLS connections that do not offer ALPN.
        ALPNProtocols: ["http/1.1"],
        servername: isIP(url.hostname) ? undefined : url.hostname,
      };
      if (!proxy) {
        const req = (url.protocol === "https:" ? https : http).request(
          url,
          { ...options, lookup },
          finish,
        );
        req.once("error", fail);
        req.end(body);
        return;
      }
      const proxyHeaders: Record<string, string> = {};
      if (proxy.username)
        proxyHeaders["Proxy-Authorization"] =
          "Basic " +
          Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64");
      const proxyModule = proxy.protocol === "https:" ? https : http;
      if (url.protocol === "http:") {
        const req = proxyModule.request(
          {
            host: proxy.hostname,
            port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
            method,
            path: url.href,
            headers: { ...headers, Host: url.host, ...proxyHeaders },
            signal,
            agent: false,
          },
          finish,
        );
        req.once("error", fail);
        req.end(body);
        return;
      }
      const port = url.port || "443";
      const connect = proxyModule.request({
        host: proxy.hostname,
        port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: `${url.hostname}:${port}`,
        headers: { Host: `${url.hostname}:${port}`, ...proxyHeaders },
        signal,
        agent: false,
      });
      connect.once("error", fail);
      connect.once("connect", (res, socket: Socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return fail(
            new AppError(
              502,
              "web_proxy",
              `Proxy CONNECT failed with ${res.statusCode}`,
            ),
          );
        }
        const secure = tls.connect({
          socket,
          servername: isIP(url.hostname) ? undefined : url.hostname,
          ca: this.trustRoots(),
          // Some servers (e.g. baidu.com) reset TLS connections that do not offer ALPN.
          ALPNProtocols: ["http/1.1"],
        });
        secure.once("error", fail);
        const req = https.request(
          url,
          // No agent: with one (even agent:false) Node ignores createConnection and dials directly.
          { ...options, agent: undefined, createConnection: () => secure },
          finish,
        );
        req.once("error", fail);
        req.end(body);
      });
      connect.end();
    });
  }
  private decode(body: Buffer, encoding?: string) {
    const limit = { maxOutputLength: this.config.maxBytes };
    switch ((encoding || "").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(body, limit);
      case "deflate":
        return zlib.inflateSync(body, limit);
      case "br":
        return zlib.brotliDecompressSync(body, limit);
      default:
        return body;
    }
  }
  /** Fetch a URL; text formats are converted, others are returned as bytes for asset storage. */
  async fetch(raw: string, signal?: AbortSignal) {
    invariant(this.config.enabled, "Web access is disabled", 403, "web_denied");
    const key = new URL(raw).href,
      cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.config.cacheTtlMs)
      return { page: cached.page, cached: true as const };
    const response = await this.request(raw, { signal });
    const contentType = String(
      response.headers["content-type"] || "application/octet-stream",
    );
    if (!textual(contentType) && !(response.status >= 400))
      return { binary: response, contentType };
    const decoded = charsetOf(contentType, response.body).decode(response.body);
    const converted = isHtml(contentType)
      ? htmlToText(decoded, response.url)
      : { title: undefined, text: decoded };
    const page: WebPage = {
      url: response.url,
      status: response.status,
      contentType: contentType.split(";")[0].trim(),
      title: converted.title,
      text: converted.text,
    };
    if (response.status < 400 && this.config.cacheTtlMs > 0) {
      this.cache.set(key, { at: Date.now(), page });
      while (this.cache.size > 32)
        this.cache.delete(this.cache.keys().next().value!);
    }
    return { page, cached: false as const };
  }
  async search(
    query: string,
    maxResults: number | undefined,
    signal?: AbortSignal,
  ) {
    invariant(this.config.enabled, "Web access is disabled", 403, "web_denied");
    const settings = this.config.search,
      provider = this.providers.get(settings.provider);
    invariant(
      provider,
      `Search provider ${settings.provider} is not available`,
      503,
    );
    if (settings.apiKeyEnv && process.env[settings.apiKeyEnv])
      registerSecret(process.env[settings.apiKeyEnv]!);
    const results = await provider.search(query, {
      maxResults: Math.min(
        maxResults || settings.maxResults,
        settings.maxResults,
      ),
      signal: signal || new AbortController().signal,
      config: settings,
      request: (url, init = {}) =>
        this.request(url, {
          ...init,
          trusted: true,
          signal: init.signal || signal,
        }),
    });
    return results
      .filter((r) => {
        try {
          const host = new URL(r.url).hostname.toLowerCase();
          return (
            /^https?:$/.test(new URL(r.url).protocol) &&
            !hostMatches(this.config.blockedHosts, host)
          );
        } catch {
          return false;
        }
      })
      .slice(0, settings.maxResults);
  }
}
const apiKey = (config: WebConfig["search"]) => {
  invariant(
    config.apiKeyEnv,
    "Search provider needs web.search.apiKeyEnv",
    503,
  );
  const key = process.env[config.apiKeyEnv];
  invariant(
    key,
    `Missing environment variable ${config.apiKeyEnv}`,
    503,
    "credentials_missing",
  );
  return key;
};
const json = (response: WebResponse) => {
  invariant(
    response.status >= 200 && response.status < 300,
    `Search provider HTTP ${response.status}: ${response.body.toString("utf8").slice(0, 300)}`,
    502,
  );
  const value: unknown = JSON.parse(response.body.toString("utf8"));
  const record = wireObject(value);
  invariant(record, "Search provider returned an invalid JSON object", 502);
  return record;
};
const resultRows = (value: unknown) => {
  if (value === undefined || value === null) return [];
  invariant(
    Array.isArray(value),
    "Search provider results must be an array",
    502,
  );
  return value.map((row: unknown) => {
    const record = wireObject(row);
    invariant(record, "Search provider returned an invalid result", 502);
    return record;
  });
};
const BUILTIN_PROVIDERS: WebSearchProvider[] = [
  {
    id: "tavily",
    async search(query, { maxResults, config, request, signal }) {
      const value = json(
        await request(`${config.baseUrl || "https://api.tavily.com"}/search`, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey(config)}`,
          },
          body: JSON.stringify({
            query,
            max_results: maxResults,
            search_depth: "basic",
          }),
        }),
      );
      return resultRows(value.results).map((r) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        snippet: r.content ? String(r.content) : undefined,
        publishedAt: r.published_date ? String(r.published_date) : undefined,
      }));
    },
  },
  {
    id: "brave",
    async search(query, { maxResults, config, request, signal }) {
      const url = new URL(
        `${config.baseUrl || "https://api.search.brave.com"}/res/v1/web/search`,
      );
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const value = json(
        await request(url.href, {
          signal,
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey(config),
          },
        }),
      );
      return resultRows(wireMember(value.web, "results")).map((r) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        snippet: r.description
          ? htmlToText(String(r.description)).text
          : undefined,
        publishedAt:
          r.page_age || r.age ? String(r.page_age || r.age) : undefined,
      }));
    },
  },
  {
    id: "searxng",
    async search(query, { maxResults, config, request, signal }) {
      invariant(config.baseUrl, "SearXNG needs web.search.baseUrl", 503);
      const url = new URL(`${config.baseUrl.replace(/\/$/, "")}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const headers: Record<string, string> = { Accept: "application/json" };
      if (config.apiKeyEnv) headers.Authorization = `Bearer ${apiKey(config)}`;
      const value = json(await request(url.href, { signal, headers }));
      return resultRows(value.results)
        .slice(0, maxResults)
        .map((r) => ({
          title: String(r.title || ""),
          url: String(r.url || ""),
          snippet: r.content ? String(r.content) : undefined,
          publishedAt: r.publishedDate ? String(r.publishedDate) : undefined,
        }));
    },
  },
];
