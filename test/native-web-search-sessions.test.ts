import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Kernel } from "../src/core/kernel.js";
import type { Session, StoredMessage } from "../src/contracts.js";
import type { NativeWebSearchResult } from "../src/runtime/types.js";
import type { MigrationReceipt } from "../src/sessions/migration.js";
import { decodeSessionSnapshot } from "../src/sessions/codec.js";
import { listenHttp } from "../src/transport/http-listener.js";
import { setup, collect } from "./support/wire-server.js";

const metadata: NativeWebSearchResult = {
  calls: [
    {
      id: "search_1",
      status: "completed",
      action: {
        type: "search",
        query: "current news",
        queries: ["current news", "release update"],
        sources: [{ url: "https://example.com/news", title: "News" }],
      },
    },
    {
      id: "search_2",
      status: "completed",
      action: { type: "open_page", url: "https://example.com/news" },
    },
  ],
  citations: [
    {
      url: "https://example.com/news",
      title: "News",
      startIndex: 0,
      endIndex: 4,
    },
  ],
};

function snapshot(webSearch: unknown = metadata) {
  return {
    format: "foundation-session-v1",
    session: {
      projectId: "project",
      name: "Search",
      mode: "chat",
      routeId: "text",
    },
    messages: [
      {
        id: "message",
        runId: "run",
        message: {
          role: "assistant",
          model: "model",
          provider: "text",
          content: [{ type: "text", text: "News today" }],
          stopReason: "stop",
          timestamp: 1,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
          },
          webSearch,
        },
      },
    ],
  };
}

function searches(messages: StoredMessage[]) {
  return messages.flatMap(({ message }) =>
    message.role === "assistant" && message.webSearch
      ? [message.webSearch]
      : [],
  );
}

async function searchedSession() {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* Consume the request before answering. */
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "response_search",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "reason",
            encrypted_content: "opaque-native-state",
            summary: [],
          },
          ...metadata.calls.map((call) => ({
            type: "web_search_call",
            ...call,
          })),
          {
            type: "message",
            id: "answer",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "News today",
                annotations: metadata.citations.map((citation) => ({
                  type: "url_citation",
                  url: citation.url,
                  title: citation.title,
                  start_index: citation.startIndex,
                  end_index: citation.endIndex,
                })),
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    );
  });
  const address = await listenHttp(server, { host: "127.0.0.1", port: 0 });
  const closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const x = await setup().catch(async (error: unknown) => {
    await closeServer();
    throw error;
  });
  try {
    Object.assign(x.config.routes.text, {
      adapter: "openai-responses",
      nativeWebSearch: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    x.config.permissions.network = "allow";
    const session = await x.session();
    const { runId } = await x.client.submit(session.id, {
      text: "Search current news",
    });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.deepEqual(searches(x.kernel.store.transcript(session.id)), [
      metadata,
    ]);
    return {
      x,
      session,
      close: async () => {
        await x.close();
        await closeServer();
      },
    };
  } catch (error) {
    await x.close();
    await closeServer();
    throw error;
  }
}

test("session codec preserves native search evidence and rejects malformed, unsafe or oversized metadata", () => {
  assert.deepEqual(searches(decodeSessionSnapshot(snapshot(), 10).messages), [
    metadata,
  ]);
  const legacy = snapshot();
  legacy.messages[0].message.webSearch = undefined;
  assert.doesNotThrow(() => decodeSessionSnapshot(legacy, 10));
  const citation = metadata.citations[0];
  const invalid: unknown[] = [
    { ...metadata, extra: true },
    { ...metadata, calls: [{ id: "" }] },
    { ...metadata, calls: [{ id: "search", status: 1 }] },
    {
      ...metadata,
      calls: [{ id: "search", action: { type: "search", queries: [1] } }],
    },
    {
      ...metadata,
      calls: [
        { id: "search", action: { type: "open_page", url: "file:///secret" } },
      ],
    },
    {
      ...metadata,
      calls: [
        {
          id: "search",
          action: { type: "search", sources: [{ url: "javascript:alert(1)" }] },
        },
      ],
    },
    { ...metadata, citations: [{ ...citation, url: "data:text/html,unsafe" }] },
    { ...metadata, citations: [{ ...citation, startIndex: -1 }] },
    { ...metadata, citations: [{ ...citation, endIndex: 0.5 }] },
    {
      ...metadata,
      citations: [{ ...citation, endIndex: Number.MAX_SAFE_INTEGER + 1 }],
    },
    { ...metadata, citations: [{ ...citation, startIndex: 5, endIndex: 4 }] },
    { ...metadata, citations: [{ ...citation, title: "x".repeat(40001) }] },
    {
      ...metadata,
      calls: Array.from({ length: 10001 }, () => ({ id: "search" })),
    },
    { ...metadata, citations: Array.from({ length: 10001 }, () => citation) },
  ];
  for (const [index, value] of invalid.entries())
    assert.throws(
      () => decodeSessionSnapshot(snapshot(value), 10),
      /./,
      `case ${index}`,
    );
  assert.throws(() => decodeSessionSnapshot(snapshot(), 10, 100), /byte limit/);
});

test("native search sessions round-trip through HTTP export and import without losing citations or replaying searches", async () => {
  const fixture = await searchedSession();
  const { x, session } = fixture;
  try {
    const exported = await x.client.request<{
      format: "foundation-session-v1";
      session: Session;
      messages: StoredMessage[];
    }>("GET", `/v1/sessions/${session.id}/export`);
    assert.deepEqual(searches(exported.messages), [metadata]);
    const imported = await x.client.request<Session>(
      "POST",
      "/v1/sessions/import",
      {
        projectId: x.project.id,
        snapshot: exported,
      },
    );
    const history = x.kernel.store.transcript(imported.id);
    assert.deepEqual(searches(history), [metadata]);
    assert.equal(imported.autonomy, "assist");
    assert.ok(!JSON.stringify(history).includes("opaque-native-state"));
    const assistant = history.find(
      ({ message }) => message.role === "assistant",
    )?.message;
    assert.ok(assistant?.role === "assistant");
    assert.equal(assistant.providerState, undefined);
    assert.equal(assistant.responseId, undefined);
    x.config.routes.text.nativeWebSearch = false;
    x.config.routes.text.baseUrl = x.wire.url + "/v1";
    const { runId } = await x.client.submit(imported.id, {
      text: "Continue using the cited evidence",
    });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.equal(x.wire.requests.length, 1);
    assert.ok(
      !JSON.stringify(x.wire.requests[0].body).includes("web_search_call"),
    );
    assert.ok(
      !JSON.stringify(x.wire.requests[0].body).includes('"type":"web_search"'),
    );
    assert.deepEqual(searches(x.kernel.store.transcript(imported.id)), [
      metadata,
    ]);
  } finally {
    await fixture.close();
  }
});

test("portable migration preserves native search evidence across independent hosts and permits continuation", async () => {
  const source = await searchedSession();
  const target = await setup();
  try {
    const bundle = await source.x.client.request<
      Awaited<ReturnType<Kernel["exportMigration"]>>
    >("GET", `/v1/sessions/${source.session.id}/migration`);
    assert.deepEqual(searches(bundle.payload.snapshot.messages), [metadata]);
    assert.ok(!JSON.stringify(bundle).includes("opaque-native-state"));
    const imported = await target.client.request<MigrationReceipt>(
      "POST",
      "/v1/migrations/import",
      {
        projectId: target.project.id,
        bundle,
        key: "native-web-search-evidence",
        routeId: "text",
      },
    );
    const history = target.kernel.store.transcript(imported.sessionId);
    assert.deepEqual(searches(history), [metadata]);
    assert.equal(target.wire.requests.length, 0);
    assert.equal(target.kernel.store.list("effects").length, 0);
    const { runId } = await target.client.submit(imported.sessionId, {
      text: "Continue using this source",
    });
    await collect(target.client, runId);
    assert.equal((await target.kernel.wait(runId)).status, "completed");
    assert.equal(target.wire.requests.length, 1);
    assert.ok(
      !JSON.stringify(target.wire.requests[0].body).includes("web_search_call"),
    );
    assert.deepEqual(
      searches(target.kernel.store.transcript(imported.sessionId)),
      [metadata],
    );
  } finally {
    await source.close();
    await target.close();
  }
});
