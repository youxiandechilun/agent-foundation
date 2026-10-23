import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RegexSearch } from "../src/runtime/regex-search.js";
import { boundedDirectory, walkProject } from "../src/runtime/project-walk.js";
import {
  ResponseBuilder,
  type TextProtocol,
} from "../src/providers/protocol.js";
import { anthropicMessages as protocol } from "../src/providers/protocols/anthropic-messages.js";
import { anthropicMessages } from "../src/providers/serialize.js";
import { estimateTokens } from "../src/runtime/token-counter.js";
import {
  RedactionScope,
  redactSecrets,
  redactJson,
} from "../src/core/redaction.js";
import {
  TextProtocolRegistry,
  findTextProtocol,
} from "../src/providers/registry.js";
import { HttpTextProvider } from "../src/providers/text.js";
import { parseConfig } from "../src/core/config.js";

test("regex search times out without blocking host timers and terminates its worker", async () => {
  const matcher = new RegexSearch("^(a+)+$", false, undefined, 500, 10000);
  try {
    await matcher.match([]);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await assert.rejects(matcher.match(["a".repeat(100) + "!"]), /timed out/);
      assert.ok(ticks > 0, "the host event loop must stay responsive");
      await assert.rejects(matcher.match(["a"]), /timed out/);
    } finally {
      clearInterval(timer);
    }
  } finally {
    await matcher.close();
  }
});

test("regex worker preserves matching semantics, invalid-pattern errors, and cancellation", async () => {
  const normal = new RegexSearch("needle", true);
  try {
    assert.deepEqual(
      await normal.match(
        ["NEEDLE", "other", "needle", "x".repeat(4000) + "needle"],
        2,
      ),
      [0, 2],
    );
  } finally {
    await normal.close();
  }
  const invalid = new RegexSearch("(");
  try {
    await assert.rejects(invalid.match([]), /regular expression|Unterminated/);
  } finally {
    await invalid.close();
  }
  const controller = new AbortController();
  const cancelled = new RegexSearch("^(a+)+$", false, controller.signal, 5000);
  try {
    await cancelled.match([]);
    const work = cancelled.match(["a".repeat(100) + "!"]);
    setTimeout(() => controller.abort(new Error("stop-search")), 20);
    await assert.rejects(work, /stop-search/);
  } finally {
    await cancelled.close();
  }
});

test("directory enumeration stops at capacity and closed handles allow cleanup", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-runtime-directory-"),
  );
  try {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        writeFile(path.join(directory, `file-${i}.txt`), "x"),
      ),
    );
    const listing = await boundedDirectory(directory, 5);
    assert.equal(listing.entries.length, 5);
    assert.equal(listing.truncated, true);
    const seen: string[] = [];
    const result = await walkProject(directory, {
      maxEntries: 5,
      respectGitignore: false,
      onFile: (relative) => {
        seen.push(relative);
        return true;
      },
    });
    assert.equal(result.visited, 5);
    assert.equal(result.truncated, true);
    assert.equal(seen.length, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignore rules are scoped to their directory and oversize inputs fail explicitly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-ignore-"));
  try {
    await writeFile(path.join(directory, ".gitignore"), "*.tmp\n");
    for (let i = 0; i < 5; i++) {
      const child = path.join(directory, `package-${i}`);
      await mkdir(child);
      await writeFile(
        path.join(child, ".gitignore"),
        Array.from({ length: 4096 }, (_, j) => `absent-${j}`).join("\n"),
      );
      await writeFile(path.join(child, "keep.txt"), "yes");
      await writeFile(path.join(child, "ignore.tmp"), "no");
    }
    const seen: string[] = [];
    await walkProject(directory, {
      maxEntries: 1000,
      respectGitignore: true,
      onFile: (relative) => {
        seen.push(relative);
        return true;
      },
    });
    assert.equal(seen.filter((name) => name.endsWith("keep.txt")).length, 5);
    assert.ok(seen.every((name) => !name.endsWith(".tmp")));
    await writeFile(
      path.join(directory, ".gitignore"),
      "x".repeat(256 * 1024 + 1),
    );
    await assert.rejects(
      walkProject(directory, {
        maxEntries: 10,
        respectGitignore: true,
        onFile: () => true,
      }),
      /256 KiB/,
    );
    await writeFile(
      path.join(directory, ".gitignore"),
      Array.from({ length: 4097 }, (_, j) => `absent-${j}`).join("\n"),
    );
    await assert.rejects(
      walkProject(directory, {
        maxEntries: 10,
        respectGitignore: true,
        onFile: () => true,
      }),
      /rule capacity/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Anthropic history stores large content once and replays signed and unknown blocks exactly", async () => {
  const response = new ResponseBuilder("anthropic-messages", "route", "model");
  const secret = "test-secret-for-redaction";
  const items = [
    {
      type: "text",
      text: `prefix ${secret} suffix `.repeat(2000),
      extra: "preserved-text-metadata",
    },
    {
      type: "thinking",
      thinking: "reasoning ".repeat(8000),
      signature: "signed-thinking-value",
    },
    { type: "redacted_thinking", data: "opaque-native-state" },
    {
      type: "tool_use",
      id: "call-1",
      name: "lookup",
      input: { query: "long-query ".repeat(4000) },
      extra: "preserved-tool-metadata",
    },
  ];
  for (const [index, content_block] of items.entries())
    await protocol.event(
      { type: "content_block_start", index, content_block },
      response,
    );
  response.finish("stop");
  response.finalizeCalls();
  protocol.finalize!(response);
  const compact = response.output;
  const legacy = structuredClone(compact);
  legacy.providerState!.items = structuredClone(items);
  assert.deepEqual(
    anthropicMessages([compact], "route"),
    anthropicMessages([legacy], "route"),
  );
  assert.ok(
    JSON.stringify(compact).length < JSON.stringify(legacy).length * 0.6,
  );
  assert.equal(estimateTokens([compact]), estimateTokens([legacy]));
  assert.equal(
    estimateTokens([legacy]),
    Math.ceil(
      (Buffer.byteLength(
        JSON.stringify(anthropicMessages([legacy], "route")[0]),
      ) +
        2) /
        2,
    ),
  );
  const scope = new RedactionScope({ mode: "registered" });
  try {
    scope.register(secret);
    const safeCompact = scope.run(() => redactJson(compact));
    const safeLegacy = scope.run(() => redactJson(legacy));
    assert.deepEqual(
      anthropicMessages([safeCompact], "route"),
      anthropicMessages([safeLegacy], "route"),
      "redaction may change semantic text length without breaking references",
    );
    assert.equal(JSON.stringify(safeCompact).includes(secret), false);
  } finally {
    scope.close();
  }
});

test("coalesced native text segments keep their exact original boundaries", async () => {
  const response = new ResponseBuilder("anthropic-messages", "route", "model");
  const items = [
    { type: "text", text: "a".repeat(2000) },
    { type: "text", text: "b".repeat(2000) },
  ];
  for (const [index, content_block] of items.entries())
    await protocol.event(
      { type: "content_block_start", index, content_block },
      response,
    );
  response.finish("stop");
  protocol.finalize!(response);
  assert.deepEqual(
    anthropicMessages([response.output], "route")[0].content,
    items,
  );
});

test("protocol registries isolate identical adapter IDs, immutable snapshots, and provider assembly", async (t) => {
  const first = new TextProtocolRegistry(),
    second = new TextProtocolRegistry();
  const declaration = (name: string): TextProtocol => ({
    id: "isolated-protocol",
    url: (base) => `${base}/${name}`,
    headers: { "x-host": name },
    body: () => ({ host: name }),
    enableReasoning: (body) => {
      body.reasoner = name;
    },
    async event(_event, response) {
      await response.text(name);
      response.finish("stop");
    },
  });
  const firstDeclaration = declaration("first");
  const removeFirst = first.register(firstDeclaration);
  second.register(declaration("second"));
  const snapshot = first.clone();
  firstDeclaration.headers = { "x-host": "mutated" };
  removeFirst();
  assert.equal(first.find("isolated-protocol"), undefined);
  assert.equal(findTextProtocol("isolated-protocol"), undefined);
  const base = parseConfig({
    defaultRoutes: { chat: "t", code: "t", office: "t" },
    routes: {
      t: {
        kind: "text",
        adapter: "openai-completions",
        model: "m",
        baseUrl: "http://127.0.0.1:1",
      },
    },
  });
  const route = {
    ...base.routes.t,
    adapter: "isolated-protocol",
    reasoningEffort: "low" as const,
  };
  const seen: { url: string; host: string | null; body: unknown }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        host: new Headers(init?.headers).get("x-host"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const request = { routeId: "t", messages: [], tools: [] };
  const [a, b] = await Promise.all([
    new HttpTextProvider("t", route, snapshot).complete(request),
    new HttpTextProvider("t", route, second).complete(request),
  ]);
  assert.deepEqual(a.content, [{ type: "text", text: "first" }]);
  assert.deepEqual(b.content, [{ type: "text", text: "second" }]);
  assert.deepEqual(
    seen.map((entry) => [entry.host, entry.body]),
    [
      ["first", { host: "first", reasoner: "first" }],
      ["second", { host: "second", reasoner: "second" }],
    ],
  );
});

test("protocol snapshots preserve class-based adapters and their method receiver", () => {
  class Adapter implements TextProtocol {
    readonly id = "class-adapter";
    private readonly suffix = "/class";
    url(base: string) {
      return base + this.suffix;
    }
    body() {
      return { suffix: this.suffix };
    }
    async event(_event: unknown, response: ResponseBuilder) {
      await response.text(this.suffix);
      response.finish("stop");
    }
  }
  const registry = new TextProtocolRegistry();
  registry.register(new Adapter());
  assert.equal(
    registry.get("class-adapter").url("http://local"),
    "http://local/class",
  );
});

test("compiled redaction handles overlapping and escaped secrets, expiry, and isolated scopes", async () => {
  const first = new RedactionScope({ mode: "registered" }),
    second = new RedactionScope({ mode: "registered" });
  try {
    first.register("abcdefghij");
    first.register("fghijklmno");
    assert.equal(
      first.run(() => redactSecrets("before abcdefghijklmno after")),
      "before [REDACTED] after",
    );
    const special = 'escaped-"value\\secret';
    first.register(special);
    assert.deepEqual(
      first.run(() => redactJson({ text: special })),
      { text: "[REDACTED]" },
    );
    first.register("temporary-only", 1);
    assert.equal(
      first.run(() => redactSecrets("temporary-only")),
      "[REDACTED]",
    );
    await delay(20);
    assert.equal(
      first.run(() => redactSecrets("temporary-only")),
      "temporary-only",
    );
    assert.equal(
      second.run(() => redactSecrets("abcdefghij")),
      "abcdefghij",
    );
    for (let i = 0; i < 2000; i++) first.register(`rotated-key-${i}-value`);
    assert.equal(
      first.run(() =>
        redactSecrets("rotated-key-0-value rotated-key-1999-value"),
      ),
      "[REDACTED] [REDACTED]",
    );
    assert.equal(
      first.run(() => redactSecrets("unchanged public text")),
      "unchanged public text",
    );
  } finally {
    first.close();
    second.close();
  }
});

test("redaction cache observes environment rotations and late registrations", (t) => {
  const key = "AGENT_OPTIMIZATION_RUNTIME_SECRET";
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  const scope = new RedactionScope({ mode: "registered", environment: [key] });
  try {
    process.env[key] = "environment-first-value";
    assert.equal(
      scope.run(() => redactSecrets("environment-first-value")),
      "[REDACTED]",
    );
    process.env[key] = "environment-second-value";
    assert.equal(
      scope.run(() => redactSecrets("environment-second-value")),
      "[REDACTED]",
    );
    scope.register("newly-added-permanent-secret");
    assert.equal(
      scope.run(() => redactSecrets("newly-added-permanent-secret")),
      "[REDACTED]",
    );
  } finally {
    scope.close();
  }
});
