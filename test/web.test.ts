import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/core/config.js";
import { WebClient, htmlToText, proxyFor } from "../src/web/client.js";
import { setup, collect } from "./support/wire-server.js";

const page = (body: string, title = "Doc") =>
  `<!doctype html><html><head><title>${title}</title><style>.x{}</style><script>var secret=1</script></head><body><nav>menu</nav>${body}</body></html>`;

async function site() {
  const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          `<main><h1>Title &amp; more</h1><p>Hello&nbsp;world &#x4e2d;&#25991;</p><ul><li>one</li><li>two</li></ul><p><a href="/next">Next page</a></p><table><tr><td>a</td><td>b</td></tr></table>${"<p>filler text here</p>".repeat(80)}</main>`,
        ),
      );
    } else if (url.pathname === "/gzip") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Encoding": "gzip",
      });
      res.end(zlib.gzipSync(page("<p>compressed body</p>")));
    } else if (url.pathname === "/gbk") {
      res.writeHead(200, { "Content-Type": "text/html; charset=gbk" });
      res.end(
        Buffer.concat([
          Buffer.from("<html><body><p>"),
          Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
          Buffer.from("</p></body></html>"),
        ]),
      );
    } else if (url.pathname === "/redirect") {
      res.writeHead(302, { Location: "/page" });
      res.end();
    } else if (url.pathname === "/loop") {
      res.writeHead(301, { Location: "/loop" });
      res.end();
    } else if (url.pathname === "/to-blocked") {
      res.writeHead(302, { Location: "http://blocked.test/" });
      res.end();
    } else if (url.pathname === "/file.pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.4 fake"));
    } else if (url.pathname === "/big") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(100 * 1024));
    } else if (url.pathname === "/slow") {
      setTimeout(() => res.end("late"), 2500);
    } else if (url.pathname === "/search") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { title: "A", url: "https://a.example/1", content: "first" },
            { title: "B", url: "https://blocked.test/2", content: "hidden" },
            { title: "C", url: "javascript:alert(1)", content: "bad" },
          ],
        }),
      );
    } else if (url.pathname === "/tavily/search") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          echo: JSON.parse(Buffer.concat(chunks).toString()),
          results: [{ title: "T", url: "https://t.example", content: "tav" }],
        }),
      );
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    seen,
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const client = (web: Record<string, unknown> = {}) =>
  new WebClient(
    parseConfig({
      defaultRoutes: { chat: "t", code: "t", office: "t" },
      routes: {
        t: {
          kind: "text",
          adapter: "openai-completions",
          model: "m",
          baseUrl: "http://127.0.0.1:1",
        },
      },
      web: { proxy: "none", ...web },
    }).web,
  );

test("HTML becomes readable text with headings, lists, links and entities", () => {
  const { title, text } = htmlToText(
    page(
      `<main><h2>Intro</h2><p>a &lt;b&gt; &#39;c&#39;</p><ul><li>x</li></ul><a href="/rel">Rel</a><table><tr><th>k</th><td>v</td></tr></table>${"<p>long enough content</p>".repeat(12)}</main><footer>foot</footer><textarea style="display:none">&lt;style&gt;.hidden{}&lt;/style&gt;</textarea>`,
      "T &amp; T",
    ),
    "https://site.example/dir/",
  );
  assert.equal(title, "T & T");
  assert.match(text, /^## Intro/m);
  assert.match(text, /a <b> 'c'/);
  assert.match(text, /^- x$/m);
  assert.match(text, /\[Rel\]\(https:\/\/site\.example\/rel\)/);
  assert.match(text, /\| k \| v/);
  assert.doesNotMatch(text, /secret|menu|foot|\.x\{\}|hidden/);
});

test("proxy selection honours NO_PROXY and refuses unsupported schemes", () => {
  const env = {
    HTTPS_PROXY: "http://127.0.0.1:7897",
    HTTP_PROXY: "http://127.0.0.1:7898",
    NO_PROXY: "localhost,.corp.example,*.docker.internal",
  };
  const t = (u: string, s = "env", e: any = env) =>
    proxyFor(new URL(u), s, e)?.href;
  assert.equal(t("https://a.example/"), "http://127.0.0.1:7897/");
  assert.equal(t("http://a.example/"), "http://127.0.0.1:7898/");
  assert.equal(t("http://localhost/"), undefined);
  assert.equal(t("https://x.corp.example/"), undefined);
  assert.equal(t("https://y.docker.internal/"), undefined);
  assert.equal(t("https://a.example/", "none"), undefined);
  assert.equal(t("https://a.example/", "env", {}), undefined);
  assert.equal(
    t("https://a.example/", "http://p.example:8080"),
    "http://p.example:8080/",
  );
  assert.throws(
    () => t("https://a.example/", "env", { HTTPS_PROXY: "socks5://h:1" }),
    /Unsupported proxy scheme/,
  );
});

test("fetch converts HTML, decodes gzip and GBK, follows bounded redirects and caches", async () => {
  const s = await site();
  try {
    const web = client({ allowPrivateNetwork: true });
    const first = await web.fetch(`${s.base}/redirect`);
    assert.equal(first.page!.url, `${s.base}/page`);
    assert.equal(first.page!.title, "Doc");
    assert.match(first.page!.text, /^# Title & more/m);
    assert.match(first.page!.text, /Hello world 中文/);
    assert.match(first.page!.text, /- one\n- two/);
    assert.match(
      first.page!.text,
      /\[Next page\]\(http:\/\/127\.0\.0\.1:\d+\/next\)/,
    );
    const again = await web.fetch(`${s.base}/redirect`);
    assert.equal(again.cached, true);
    assert.match(
      (await web.fetch(`${s.base}/gzip`)).page!.text,
      /compressed body/,
    );
    assert.match((await web.fetch(`${s.base}/gbk`)).page!.text, /中文/);
    const missing = await web.fetch(`${s.base}/nothing`);
    assert.equal(missing.page!.status, 404);
    const pdf = await web.fetch(`${s.base}/file.pdf`);
    assert.equal(pdf.contentType, "application/pdf");
    assert.equal(pdf.binary!.body.toString(), "%PDF-1.4 fake");
    await assert.rejects(web.fetch(`${s.base}/loop`), /Too many redirects/);
  } finally {
    await s.close();
  }
});

test("private networks, blocked hosts, redirects, size and time are enforced", async () => {
  const s = await site();
  try {
    const guarded = client();
    await assert.rejects(
      guarded.fetch(`${s.base}/page`),
      /Private or reserved/,
    );
    await assert.rejects(
      guarded.fetch(`http://localhost:${s.port}/page`),
      /Private or reserved/,
    );
    await assert.rejects(guarded.fetch("http://[::1]/"), /Private or reserved/);
    await assert.rejects(guarded.fetch("file:///etc/passwd"), /HTTP\(S\)/);
    await assert.rejects(
      guarded.fetch("http://user:pw@a.example/"),
      /without URL credentials/,
    );
    const open = client({
      allowPrivateNetwork: true,
      blockedHosts: ["blocked.test"],
      maxBytes: 64 * 1024,
      timeoutMs: 1000,
    });
    await assert.rejects(
      open.fetch(`${s.base}/to-blocked`),
      /blocked.test is not allowed/,
    );
    await assert.rejects(open.fetch(`${s.base}/big`), /exceeds 65536 bytes/);
    await assert.rejects(open.fetch(`${s.base}/slow`), /timed out/);
    const allowlisted = client({
      allowPrivateNetwork: true,
      allowedHosts: ["*.example"],
    });
    await assert.rejects(allowlisted.fetch(`${s.base}/page`), /not allowed/);
  } finally {
    await s.close();
  }
});

test("HTTP proxy: absolute-form requests, CONNECT tunnels with extra CA, proxy auth", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./support/tls-fixture.json", import.meta.url),
      "utf8",
    ),
  );
  const secure = https.createServer(
    { key: fixture.key, cert: fixture.cert },
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("tls through tunnel");
    },
  );
  let handshakes = 0;
  secure.on("secureConnection", () => handshakes++);
  await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
  const securePort = (secure.address() as net.AddressInfo).port;
  const log: string[] = [];
  const proxy = http.createServer((req, res) => {
    log.push(
      `${req.method} ${req.url} ${req.headers["proxy-authorization"] || ""}`,
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<p>via proxy</p>");
  });
  const tunnels = new Set<net.Socket>();
  proxy.on("connect", (req, socket) => {
    tunnels.add(socket as net.Socket);
    log.push(`CONNECT ${req.url}`);
    const port = Number(req.url!.split(":").at(-1));
    const upstream = net.connect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  const dir = await mkdtemp(path.join(tmpdir(), "web-ca-")),
    ca = path.join(dir, "ca.pem");
  await writeFile(ca, fixture.cert);
  try {
    const viaProxy = client({
      proxy: `http://u%40x:p%3Aw@127.0.0.1:${proxyPort}`,
    });
    const plain = await viaProxy.fetch("http://docs.example.test/a?b=1");
    assert.match(plain.page!.text, /via proxy/);
    assert.equal(
      log[0],
      `GET http://docs.example.test/a?b=1 Basic ${Buffer.from("u@x:p:w").toString("base64")}`,
    );
    await assert.rejects(
      viaProxy.fetch("http://127.0.0.1:9/"),
      /Private or reserved/,
      "IP literals are checked before reaching the proxy",
    );
    const tunnel = client({
      proxy: `http://127.0.0.1:${proxyPort}`,
      allowPrivateNetwork: true,
      extraCaFile: ca,
    });
    const tlsPage = await tunnel.fetch(`https://localhost:${securePort}/s`);
    assert.equal(tlsPage.page!.text, "tls through tunnel");
    assert.ok(log.includes(`CONNECT localhost:${securePort}`));
    assert.equal(
      handshakes,
      1,
      "the request travelled inside the tunnel, not on a direct connection",
    );
    const untrusted = client({
      proxy: `http://127.0.0.1:${proxyPort}`,
      allowPrivateNetwork: true,
    });
    await assert.rejects(untrusted.fetch(`https://localhost:${securePort}/s2`));
  } finally {
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections();
    secure.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => secure.close(() => r()));
  }
});

test("search providers: SearXNG, Tavily and registered providers with filtering", async () => {
  const s = await site();
  process.env.WEB_TEST_SEARCH_KEY = "search-key-123456";
  try {
    const searx = client({
      blockedHosts: ["blocked.test"],
      search: { provider: "searxng", baseUrl: s.base },
    });
    assert.ok(searx.searchAvailable);
    const results = await searx.search("agents", undefined);
    assert.deepEqual(
      results.map((r) => r.url),
      ["https://a.example/1"],
    );
    assert.match(String(s.seen.at(-1)!.url), /format=json/);
    const tavily = client({
      search: {
        provider: "tavily",
        baseUrl: `${s.base}/tavily`,
        apiKeyEnv: "WEB_TEST_SEARCH_KEY",
        maxResults: 3,
      },
    });
    const t = await tavily.search("q", 10);
    assert.equal(t[0].snippet, "tav");
    assert.equal(
      s.seen.at(-1)!.headers.authorization,
      "Bearer search-key-123456",
    );
    const custom = client({ search: { provider: "mine" } });
    assert.equal(custom.searchAvailable, false);
    custom.registerSearchProvider({
      id: "mine",
      search: async (query, { maxResults }) =>
        Array.from({ length: 5 }, (_, i) => ({
          title: `${query} ${i}`,
          url: `https://r.example/${i}`,
        })).slice(0, maxResults),
    });
    assert.ok(custom.searchAvailable);
    assert.equal((await custom.search("x", 2)).length, 2);
    assert.equal(client().searchAvailable, false);
  } finally {
    delete process.env.WEB_TEST_SEARCH_KEY;
    await s.close();
  }
});

test("web_fetch and web_search tools run through policy, paging and asset storage", async () => {
  const s = await site();
  const x = await setup(
    (_body, index) =>
      [
        {
          calls: [
            {
              name: "web_fetch",
              args: { url: `${s.base}/page`, maxChars: 500 },
            },
            { name: "web_fetch", args: { url: `${s.base}/file.pdf` } },
            { name: "web_search", args: { query: "agents" } },
          ],
        },
        {
          calls: [
            {
              name: "web_fetch",
              args: { url: `${s.base}/page`, offset: 500, maxChars: 500 },
            },
          ],
        },
        { text: "done" },
        { calls: [{ name: "web_fetch", args: { url: `${s.base}/gzip` } }] },
      ][index] || { text: "done" },
    {
      permissions: {
        exec: "allow",
        media: "allow",
        browser: "allow",
        mcp: "allow",
        plugin: "allow",
        node: "allow",
        network: "allow",
      },
      web: {
        proxy: "none",
        allowPrivateNetwork: true,
        search: { provider: "searxng", baseUrl: s.base },
      },
    },
  );
  try {
    const session = await x.session("chat"),
      r = await x.client.submit(session.id, { text: "research" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const names = x.wire.requests[0].body.tools.map(
      (t: any) => t.function.name,
    );
    assert.ok(names.includes("web_fetch") && names.includes("web_search"));
    const settled = events
      .filter((e) => e.type === "tool.settled")
      .map((e) => (e.data.result as any).details);
    const first = settled.find((d) => d.offset === 0 && d.title),
      second = settled.find((d) => d.offset === 500),
      pdf = settled.find((d) => d.assetId),
      search = settled.find((d) => d.results);
    assert.equal(first.title, "Doc");
    assert.equal(first.text.length, 500);
    assert.equal(first.nextOffset, 500);
    assert.equal(
      x.kernel.assets.owned(pdf.assetId, x.project.id).mime,
      "application/pdf",
    );
    assert.equal(search.results.length, 2, "non-HTTP result URLs are dropped");
    assert.equal(second.cached, true);
    assert.ok(second.text.length > 0);
    x.config.permissions.network = "deny";
    const denied = await x.client.submit(session.id, { text: "again" });
    const deniedEvents = await collect(x.client, denied.runId);
    assert.ok(
      deniedEvents.some(
        (e) => e.type === "tool.settled" && e.data.isError === true,
      ),
    );
  } finally {
    await x.close();
    await s.close();
  }
});
