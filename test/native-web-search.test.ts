import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseConfig, publicConfig, routeSchema } from "../src/core/config.js";
import { HttpTextProvider, RouteRouter } from "../src/providers/text.js";
import { responsesInput } from "../src/providers/serialize.js";
import { textOf, type ModelRequest } from "../src/runtime/types.js";
import { ProviderError } from "../src/providers/sse.js";
import { listenHttp } from "../src/transport/http-listener.js";
import { setup, collect } from "./support/wire-server.js";

const routeInput = {
  kind: "text",
  adapter: "openai-responses",
  model: "protocol-only",
  baseUrl: "http://127.0.0.1:1",
  nativeWebSearch: true,
};
const stream = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const search = {
  type: "web_search_call",
  id: "search_1",
  status: "completed",
  action: {
    type: "search",
    queries: ["release date"],
    sources: [{ type: "url", url: "https://example.com/news", title: "News" }],
  },
};
const annotation = {
  type: "url_citation",
  url: "https://example.com/news",
  title: "News",
  start_index: 0,
  end_index: 4,
};
const message = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "News today", annotations: [annotation] },
  ],
};
const response = {
  id: "resp_1",
  status: "completed",
  output: [search, message],
  usage: { input_tokens: 10, output_tokens: 4 },
};

async function protocol(
  reply: unknown = { status: "completed", output: [] },
  request: Partial<ModelRequest> = {},
  routeOverrides: Record<string, unknown> = {},
  streaming = false,
  run?: (
    provider: HttpTextProvider,
    request: ModelRequest,
    payloads: Record<string, unknown>[],
  ) => Promise<unknown>,
) {
  const payloads: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(
      payload && typeof payload === "object" && !Array.isArray(payload),
    );
    payloads.push(payload as Record<string, unknown>);
    res.writeHead(200, {
      "Content-Type": streaming ? "text/event-stream" : "application/json",
      Connection: "close",
    });
    res.end(streaming ? String(reply) : JSON.stringify(reply));
  });
  const address = await listenHttp(server, { port: 0, host: "127.0.0.1" });
  try {
    const route = routeSchema.parse({
      ...routeInput,
      ...routeOverrides,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const provider = new HttpTextProvider("text", route);
    const input = {
      routeId: "text",
      tools: [],
      messages: [],
      nativeWebSearch: true,
      ...request,
    };
    if (run) await run(provider, input, payloads);
    else return { output: await provider.complete(input), payloads };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("native search is an explicit Responses capability and is exposed in public configuration", () => {
  assert.equal(
    routeSchema.parse({ ...routeInput, nativeWebSearch: undefined })
      .nativeWebSearch,
    false,
  );
  for (const adapter of [
    "openai-completions",
    "anthropic-messages",
    "image-json",
  ])
    assert.equal(
      routeSchema.safeParse({ ...routeInput, adapter }).success,
      false,
    );
  assert.equal(
    routeSchema.safeParse({ ...routeInput, nativeWebSearch: "true" }).success,
    false,
  );
  const config = parseConfig({
    routes: { text: routeInput },
    defaultRoutes: { chat: "text", code: "text", office: "text" },
  });
  assert.equal(publicConfig(config).routes[0].nativeWebSearch, true);
  assert.throws(
    () =>
      parseConfig({
        ...config,
        routes: {
          text: {
            ...routeInput,
            requestDefaults: { tools: [{ type: "web_search" }] },
          },
        },
      }),
    /cannot override tools/,
  );
});

for (const [label, request, route] of [
  ["not authorized", { nativeWebSearch: undefined }, {}],
  ["capability off", {}, { nativeWebSearch: false }],
  ["tool choice none", { toolChoice: "none" }, {}],
  ["route allowlist", {}, { toolAllowlist: ["file_read"] }],
] satisfies [string, Partial<ModelRequest>, Record<string, unknown>][])
  test(`Responses omits hosted search when ${label}`, async () => {
    const result = await protocol(undefined, request, route);
    assert.equal(result?.payloads[0].tools, undefined);
    assert.deepEqual(result?.payloads[0].include, [
      "reasoning.encrypted_content",
    ]);
  });

test("Responses coexists with function tools and sends stable hosted web_search with auto choice", async () => {
  const result = await protocol(undefined, {
    tools: [
      {
        name: "web_search",
        description: "Local search",
        parameters: { type: "object" },
        execute: async () => ({ content: [] }),
      },
    ],
  });
  assert.deepEqual(result?.payloads[0].tools, [
    {
      type: "function",
      name: "web_search",
      description: "Local search",
      parameters: { type: "object" },
    },
    { type: "web_search" },
  ]);
  assert.equal(result?.payloads[0].tool_choice, "auto");
  assert.deepEqual(result?.payloads[0].include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
  ]);
});

test("required choice accepts an authorized hosted tool without function tools", async () => {
  const result = await protocol(undefined, { toolChoice: "required" });
  assert.equal(result?.payloads[0].tool_choice, "required");
  await assert.rejects(
    protocol(undefined, { toolChoice: "required", nativeWebSearch: false }),
    /needs an available tool/,
  );
});

test("provider does not forward raw hosted tools injected after config validation", async () => {
  await protocol(
    undefined,
    { nativeWebSearch: false },
    {},
    false,
    async (provider, request, payloads) => {
      provider.route.requestDefaults.tools = [{ type: "web_search_preview" }];
      const output = await provider.complete(request);
      assert.equal(output.stopReason, "stop");
      assert.equal(payloads[0].tools, undefined);
      assert.equal(output.webSearch, undefined);
    },
  );
});

for (const delivery of ["json", "terminal", "incremental"] as const)
  test(`Responses ${delivery} retains search calls, citations and ordered replay without duplicates`, async () => {
    const events =
      delivery === "incremental"
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "web_search_call",
                id: "search_1",
                status: "in_progress",
              },
            },
            {
              type: "response.web_search_call.completed",
              output_index: 0,
              item_id: "search_1",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: search,
            },
            {
              type: "response.output_text.delta",
              output_index: 1,
              content_index: 0,
              delta: "News today",
            },
            {
              type: "response.output_text.annotation.added",
              output_index: 1,
              content_index: 0,
              annotation_index: 0,
              annotation,
            },
            {
              type: "response.output_item.done",
              output_index: 1,
              item: message,
            },
          ]
        : [];
    const result = await protocol(
      delivery === "json"
        ? response
        : stream(...events, { type: "response.completed", response }),
      {},
      {},
      delivery !== "json",
    );
    assert.ok(result);
    assert.equal(textOf(result.output), "News today");
    assert.equal(result.output.stopReason, "stop");
    assert.deepEqual(result.output.webSearch, {
      calls: [
        {
          id: "search_1",
          status: "completed",
          action: {
            type: "search",
            queries: ["release date"],
            sources: [{ url: "https://example.com/news", title: "News" }],
          },
        },
      ],
      citations: [
        { url: annotation.url, title: "News", startIndex: 0, endIndex: 4 },
      ],
    });
    assert.deepEqual(responsesInput([result.output], "text"), response.output);
    assert.deepEqual(responsesInput([result.output], "fallback"), [
      { role: "assistant", content: "News today" },
    ]);
  });

test("citation offsets cover multiple output parts and malformed or unsafe references are excluded", async () => {
  const result = await protocol({
    ...response,
    output: [
      search,
      {
        ...message,
        content: [{ type: "output_text", text: "前言😀", annotations: [] }],
      },
      {
        ...message,
        id: "msg_2",
        content: [
          {
            type: "output_text",
            text: "News",
            annotations: [
              annotation,
              { ...annotation, url: "javascript:alert(1)" },
              { ...annotation, end_index: 999 },
            ],
          },
          {
            type: "output_text",
            text: "Next",
            annotations: [{ ...annotation, title: "Next" }],
          },
        ],
      },
    ],
  });
  assert.equal(textOf(result!.output), "前言😀NewsNext");
  assert.deepEqual(
    result!.output.webSearch?.citations.map((c) => [c.startIndex, c.endIndex]),
    [
      [4, 8],
      [8, 12],
    ],
  );
});

test("mixed hosted search and function calls replay every provider item exactly once", async () => {
  const reasoning = {
    type: "reasoning",
    id: "reason",
    encrypted_content: "opaque",
  };
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "file_read",
    arguments: "{}",
    status: "completed",
  };
  const items = [reasoning, search, message, call];
  const result = await protocol({ ...response, output: items });
  assert.equal(result!.output.stopReason, "toolUse");
  assert.deepEqual(responsesInput([result!.output], "text"), items);
});

test("search activity prevents retry and fallback after an interrupted stream", async () => {
  await protocol(
    stream({
      type: "response.web_search_call.in_progress",
      output_index: 0,
      item_id: "search_1",
    }),
    {},
    {},
    true,
    async (provider, request) => {
      const config = parseConfig({
        routes: {
          text: { ...provider.route, fallbackRouteIds: ["fallback"] },
          fallback: provider.route,
        },
        defaultRoutes: { chat: "text", code: "text", office: "text" },
      });
      let routes = 0;
      await assert.rejects(
        new RouteRouter(config, () => {
          routes++;
        }).complete(request),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.started, true);
          assert.equal(
            error.partial?.webSearch?.calls[0].status,
            "in_progress",
          );
          return true;
        },
      );
      assert.equal(routes, 1);
    },
  );
});

test("an upstream cannot silently return an unauthorized hosted search", async () => {
  await assert.rejects(
    protocol(response, { nativeWebSearch: false }),
    /without request authorization/,
  );
});

test("mixed streamed and terminal text is completed before citation offsets are exposed", async () => {
  for (const streamed of ["Ne", "News today"])
    for (const indexed of [false, true]) {
      const result = await protocol(
        stream(
          {
            type: "response.output_text.delta",
            delta: streamed,
            ...(indexed ? { output_index: 1, content_index: 0 } : {}),
          },
          {
            type: "response.output_text.done",
            text: "News today",
            output_index: 1,
            content_index: 0,
          },
          { type: "response.completed", response },
        ),
        {},
        {},
        true,
      );
      assert.equal(textOf(result!.output), "News today");
      assert.deepEqual(result!.output.webSearch?.citations, [
        { url: annotation.url, title: "News", startIndex: 0, endIndex: 4 },
      ]);
    }
  const intro = {
    ...message,
    id: "intro",
    content: [{ type: "output_text", text: "Intro", annotations: [] }],
  };
  const result = await protocol(
    stream(
      {
        type: "response.output_text.delta",
        delta: "Intro",
        output_index: 0,
        content_index: 0,
      },
      {
        type: "response.completed",
        response: { ...response, output: [intro, search, message] },
      },
    ),
    {},
    {},
    true,
  );
  assert.equal(textOf(result!.output), "IntroNews today");
  assert.equal(result!.output.webSearch?.citations[0].startIndex, 5);
});

test("citation offsets align with textOf when reasoning splits assistant text parts", async () => {
  const first = {
    ...message,
    id: "first",
    content: [{ type: "output_text", text: "A", annotations: [] }],
  };
  const last = {
    ...message,
    id: "last",
    content: [
      {
        type: "output_text",
        text: "B",
        annotations: [
          { ...annotation, end_index: 1 },
          { ...annotation, end_index: 0 },
        ],
      },
    ],
  };
  const result = await protocol(
    stream(
      {
        type: "response.output_text.delta",
        delta: "A",
        output_index: 0,
        content_index: 0,
      },
      { type: "response.reasoning_summary_text.delta", delta: "thinking" },
      {
        type: "response.output_text.delta",
        delta: "B",
        output_index: 2,
        content_index: 0,
      },
      {
        type: "response.completed",
        response: { ...response, output: [first, search, last] },
      },
    ),
    {},
    {},
    true,
  );
  assert.equal(textOf(result!.output), "A\nB");
  const cite = result!.output.webSearch!.citations[0];
  assert.equal(
    textOf(result!.output).slice(cite.startIndex, cite.endIndex),
    "B",
  );
  assert.deepEqual(result!.output.webSearch!.citations[1], {
    url: annotation.url,
    title: "News",
    startIndex: 2,
    endIndex: 2,
  });
});

test("interrupted search responses never replay function calls missing semantic tool results", async () => {
  const call = {
    type: "function_call",
    call_id: "call_1",
    name: "file_read",
    arguments: "{}",
  };
  await assert.rejects(
    protocol(
      stream(
        { type: "response.output_item.done", output_index: 0, item: search },
        { type: "response.output_item.done", output_index: 1, item: call },
      ),
      {},
      {},
      true,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError && error.partial);
      assert.deepEqual(responsesInput([error.partial], "text"), [search]);
      return true;
    },
  );
});

test("terminal function arguments update a declared call before execution and replay", async () => {
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "probe",
    arguments: '{"value":42}',
  };
  const result = await protocol(
    stream(
      { type: "response.output_item.done", output_index: 0, item: search },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...call, arguments: "" },
      },
      {
        type: "response.completed",
        response: { ...response, output: [search, call] },
      },
    ),
    {},
    {},
    true,
  );
  assert.deepEqual(result!.output.content, [
    { type: "toolCall", id: "call_1", name: "probe", arguments: { value: 42 } },
  ]);
  assert.deepEqual(responsesInput([result!.output], "text"), [search, call]);
});

test("native search cost holds the configured total bound for reconciliation and enforces budgets before HTTP", async () => {
  const x = await setup();
  try {
    x.config.routes.text.adapter = "openai-responses";
    x.config.routes.text.nativeWebSearch = true;
    x.config.permissions.network = "allow";
    x.config.budgets = { enabled: true, maxRunUsd: 1 };
    x.config.routes.text.pricing = {
      currency: "USD",
      inputPerMillion: 0,
      outputPerMillion: 0,
      requestUsd: 0,
    };
    const s = await x.session();
    const first = await x.client.submit(s.id, {
      text: "missing hosted price bound",
    });
    await collect(x.client, first.runId);
    assert.equal((await x.kernel.wait(first.runId)).status, "failed");
    assert.equal(x.wire.requests.length, 0);
    x.config.routes.text.pricing.maxRequestUsd = 0.25;
    const second = await x.client.submit(s.id, {
      text: "priced hosted request",
    });
    await collect(x.client, second.runId);
    assert.equal((await x.kernel.wait(second.runId)).status, "completed");
    const entry = x.kernel.costs.entries({ runId: second.runId })[0];
    assert.equal(entry.status, "unknown");
    assert.equal(entry.reservedMicros, 250000);
    assert.equal(entry.chargedMicros, undefined);
    await x.client.reconcileCost(entry.id, 0.03, "provider-invoice-test");
    assert.equal(
      x.kernel.costs.summary({ runId: second.runId }).chargedMicros,
      30000,
    );
    x.config.budgets.maxRunUsd = 0.01;
    const third = await x.client.submit(s.id, {
      text: "held bound exceeds budget",
    });
    await collect(x.client, third.runId);
    assert.equal((await x.kernel.wait(third.runId)).status, "failed");
    assert.equal(x.wire.requests.length, 1);
  } finally {
    await x.close();
  }
});
