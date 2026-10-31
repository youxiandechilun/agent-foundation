import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { parseConfig } from "../src/core/config.js";
import {
  ProviderError,
  canRecoverProviderError,
  type ProviderFailureReason,
} from "../src/providers/sse.js";
import {
  HttpTextProvider,
  RouteRouter,
  retryDelay,
} from "../src/providers/text.js";
import { listenHttp } from "../src/transport/http-listener.js";

const adapters = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
type Adapter = (typeof adapters)[number];
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const text = (adapter: Adapter) => {
  if (adapter === "openai-responses")
    return frame({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "message-1",
      delta: "partial",
    });
  if (adapter === "anthropic-messages")
    return frame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "partial" },
    });
  return frame({ choices: [{ delta: { content: "partial" } }] });
};
const tool = (adapter: Adapter) => {
  if (adapter === "openai-responses")
    return frame({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call-1",
        name: "write",
        arguments: "{",
      },
    });
  if (adapter === "anthropic-messages")
    return (
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "write" },
      }) +
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      })
    );
  return frame({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              function: { name: "write", arguments: "{" },
            },
          ],
        },
      },
    ],
  });
};
const terminal = (adapter: Adapter) => {
  if (adapter === "openai-responses")
    return frame({
      type: "response.completed",
      response: { status: "completed", output: [] },
    });
  if (adapter === "anthropic-messages")
    return frame({ type: "message_delta", delta: { stop_reason: "tool_use" } });
  return frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
};
const streamError = (adapter: Adapter, code: string) => {
  const error = {
    code,
    message: "fixture retry server_error connection reset",
  };
  if (adapter === "openai-responses") return frame({ type: "error", ...error });
  if (adapter === "anthropic-messages")
    return frame({
      type: "error",
      error: { type: code, message: error.message },
    });
  return frame({ error });
};
const success = (adapter: Adapter) => {
  if (adapter === "openai-responses")
    return frame({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "recovered" }],
          },
        ],
      },
    });
  if (adapter === "anthropic-messages")
    return (
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "recovered" },
      }) + frame({ type: "message_delta", delta: { stop_reason: "end_turn" } })
    );
  return frame({
    choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }],
  });
};
async function fixture(
  adapter: Adapter,
  reply: (response: http.ServerResponse) => void,
  verify: (value: {
    provider: HttpTextProvider;
    router: RouteRouter;
    config: ReturnType<typeof parseConfig>;
    requests: () => number;
  }) => Promise<void>,
  timeoutMs = 5000,
) {
  let requests = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _ of request) {
        /* Only consume the fixture request. */
      }
      requests++;
      response.setHeader("Content-Type", "text/event-stream");
      reply(response);
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  const address = await listenHttp(server, { host: "127.0.0.1", port: 0 });
  try {
    const config = parseConfig({
      defaultRoutes: { chat: "text", code: "text", office: "text" },
      routes: {
        text: {
          kind: "text",
          adapter,
          model: "local-fixture",
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs,
          retry: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
        },
      },
    });
    await verify({
      config,
      provider: new HttpTextProvider("text", config.routes.text),
      router: new RouteRouter(config),
      requests: () => requests,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const request = () => ({ routeId: "text", messages: [], tools: [] });
function failure(
  reason: ProviderFailureReason,
  recoverable: boolean,
  started = true,
) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.reason, reason);
    assert.equal(error.started, started);
    assert.equal(canRecoverProviderError(error), recoverable);
    return true;
  };
}

test("recovery only accepts typed transport failures without remote activity", () => {
  for (const reason of ["network", "timeout", "stream_interrupted"] as const) {
    const error = new ProviderError("fixture", 502, true, false, undefined, {
      reason,
    });
    assert.equal(canRecoverProviderError(error), true);
    error.nativeActivity = true;
    assert.equal(canRecoverProviderError(error), false);
  }
  for (const reason of ["http", "protocol", "consumer", "cancelled"] as const)
    assert.equal(
      canRecoverProviderError(
        new ProviderError("terminated", 502, true, false, undefined, {
          reason,
        }),
      ),
      false,
    );
  assert.equal(canRecoverProviderError(new Error("terminated")), false);
  assert.equal(
    canRecoverProviderError(new ProviderError("old-constructor", 502, true)),
    false,
  );
});

for (const adapter of adapters) {
  for (const started of [false, true])
    for (const code of [
      "insufficient_quota",
      "invalid_request_error",
      "authentication_error",
      "permission_denied",
    ])
      test(`${adapter}: structured ${code} ${started ? "after" : "before"} output neither retries nor recovers`, async () => {
        await fixture(
          adapter,
          (response) =>
            response.end(
              (started ? text(adapter) : "") + streamError(adapter, code),
            ),
          async ({ router, requests, config }) => {
            config.routes.text.fallbackRouteIds = ["fallback"];
            config.routes.fallback = {
              ...config.routes.text,
              fallbackRouteIds: [],
            };
            await assert.rejects(
              router.complete(request()),
              (error: unknown) => {
                failure("http", false, started)(error);
                assert.ok(error instanceof ProviderError);
                assert.equal(error.retryable, false);
                return true;
              },
            );
            assert.equal(requests(), 1);
          },
        );
      });
  test(`${adapter}: known temporary stream rejection before output retains bounded HTTP retry`, async () => {
    let calls = 0;
    await fixture(
      adapter,
      (response) =>
        response.end(
          ++calls === 1
            ? streamError(adapter, "overloaded_error")
            : success(adapter),
        ),
      async ({ router, requests }) => {
        const result = await router.complete(request());
        assert.equal(
          result.content.some(
            (part) => part.type === "text" && part.text === "recovered",
          ),
          true,
        );
        assert.equal(requests(), 2);
      },
    );
  });
  test(`${adapter}: explicit temporary stream rejection after output is not a transport disconnect`, async () => {
    await fixture(
      adapter,
      (response) =>
        response.end(text(adapter) + streamError(adapter, "overloaded_error")),
      async ({ router, requests }) => {
        await assert.rejects(router.complete(request()), (error: unknown) => {
          failure("http", false)(error);
          assert.ok(error instanceof ProviderError);
          assert.equal(error.upstreamStatus, 529);
          return true;
        });
        assert.equal(requests(), 1);
      },
    );
  });
  test(`${adapter}: unknown explicit stream error is never downgraded to missing terminal`, async () => {
    await fixture(
      adapter,
      (response) =>
        response.end(
          text(adapter) + streamError(adapter, "unrecognized_provider_code"),
        ),
      async ({ router, requests }) => {
        await assert.rejects(
          router.complete(request()),
          failure("protocol", false),
        );
        assert.equal(requests(), 1);
      },
    );
  });
  test(`${adapter}: a real socket disconnect after text is recoverable`, async () => {
    let disconnect = () => {};
    await fixture(
      adapter,
      (response) => {
        disconnect = () => response.destroy();
        response.write(text(adapter));
      },
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request(), () => disconnect()),
          failure("stream_interrupted", true),
        );
      },
    );
  });
  test(`${adapter}: partial output followed by EOF is recoverable without request replay`, async () => {
    await fixture(
      adapter,
      (response) => response.end(text(adapter)),
      async ({ router, requests }) => {
        await assert.rejects(
          router.complete(request()),
          failure("stream_interrupted", true),
        );
        assert.equal(requests(), 1);
      },
    );
  });
  test(`${adapter}: partial arguments are never exposed as executable tools`, async () => {
    await fixture(
      adapter,
      (response) => response.end(tool(adapter)),
      async ({ provider }) => {
        await assert.rejects(provider.complete(request()), (error: unknown) => {
          failure("stream_interrupted", true)(error);
          assert.ok(error instanceof ProviderError);
          assert.equal(
            error.partial?.content.some((part) => part.type === "toolCall"),
            false,
          );
          return true;
        });
      },
    );
  });
  test(`${adapter}: malformed SSE JSON after text is a protocol failure`, async () => {
    await fixture(
      adapter,
      (response) => response.end(text(adapter) + "data: {invalid\n\n"),
      async ({ router, requests }) => {
        await assert.rejects(
          router.complete(request()),
          failure("protocol", false),
        );
        assert.equal(requests(), 1);
      },
    );
  });
  test(`${adapter}: malformed completed tool arguments cannot be recovered`, async () => {
    await fixture(
      adapter,
      (response) => response.end(tool(adapter) + terminal(adapter)),
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request()),
          failure("protocol", false),
        );
      },
    );
  });
  test(`${adapter}: an unfinished JSON prefix in the final unterminated frame is recoverable`, async () => {
    await fixture(
      adapter,
      (response) => response.end(text(adapter) + 'data: {"unfinished":"split'),
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request()),
          failure("stream_interrupted", true),
        );
      },
    );
  });
  test(`${adapter}: framing and confirmed terminal status prevent replaying malformed JSON`, async () => {
    for (const tail of ['data: {"unfinished":"split\n\n', "data: {invalid"])
      await fixture(
        adapter,
        (response) => response.end(text(adapter) + tail),
        async ({ provider }) => {
          await assert.rejects(
            provider.complete(request()),
            failure("protocol", false),
          );
        },
      );
    await fixture(
      adapter,
      (response) =>
        response.end(success(adapter) + 'data: {"unfinished":"split'),
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request()),
          failure("protocol", false),
        );
      },
    );
  });
  test(`${adapter}: consumer errors are never mistaken for reconnectable failures`, async () => {
    await fixture(
      adapter,
      (response) => response.end(text(adapter)),
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request(), () => {
            throw new DOMException("fixture consumer", "TimeoutError");
          }),
          failure("consumer", false),
        );
      },
    );
  });
  test(`${adapter}: a socket failure after confirmed completion never replays the model step`, async () => {
    await fixture(
      adapter,
      (response) => {
        response.write(success(adapter));
        setTimeout(() => response.destroy(), 30);
      },
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request()),
          failure("stream_interrupted", false),
        );
      },
    );
  });
  test(`${adapter}: caller timeout after text remains cancellation`, async () => {
    await fixture(
      adapter,
      (response) => {
        response.write(text(adapter));
      },
      async ({ provider }) => {
        const controller = new AbortController();
        await assert.rejects(
          provider.complete(
            request(),
            () => {
              controller.abort(
                new DOMException("caller deadline", "TimeoutError"),
              );
            },
            controller.signal,
          ),
          failure("cancelled", false),
        );
      },
    );
  });
  test(`${adapter}: provider request timeout after text is recoverable`, async () => {
    await fixture(
      adapter,
      (response) => {
        response.write(text(adapter));
      },
      async ({ provider }) => {
        await assert.rejects(
          provider.complete(request()),
          failure("timeout", true),
        );
      },
      1500,
    );
  });
}

for (const started of [false, true])
  test(`Responses failed terminal quota ${started ? "after" : "before"} output is a semantic rejection`, async () => {
    await fixture(
      "openai-responses",
      (response) =>
        response.end(
          (started ? text("openai-responses") : "") +
            frame({
              type: "response.failed",
              response: {
                status: "failed",
                error: { code: "insufficient_quota", message: "fixture quota" },
              },
            }),
        ),
      async ({ router, requests }) => {
        await assert.rejects(
          router.complete(request()),
          failure("http", false, started),
        );
        assert.equal(requests(), 1);
      },
    );
  });

test("Responses failed terminal without an explicit reason is not a reconnectable EOF", async () => {
  await fixture(
    "openai-responses",
    (response) =>
      response.end(
        text("openai-responses") +
          frame({ type: "response.failed", response: { status: "failed" } }),
      ),
    async ({ provider }) => {
      await assert.rejects(
        provider.complete(request()),
        failure("protocol", false),
      );
    },
  );
});

test("empty SSE EOF is a transport interruption before any output", async () => {
  await fixture(
    "openai-completions",
    (response) => response.end(),
    async ({ provider }) => {
      await assert.rejects(
        provider.complete(request()),
        failure("stream_interrupted", true, false),
      );
    },
  );
});
test("real socket failure before headers is classified using typed transport information", async () => {
  await fixture(
    "openai-completions",
    (response) => response.destroy(),
    async ({ provider }) => {
      await assert.rejects(
        provider.complete(request()),
        failure("network", true, false),
      );
    },
  );
});
test("Responses hosted search activity prevents transport recovery", async () => {
  await fixture(
    "openai-responses",
    (response) =>
      response.end(
        frame({
          type: "response.web_search_call.in_progress",
          output_index: 0,
          item_id: "search-1",
        }),
      ),
    async ({ provider, config }) => {
      config.routes.text.nativeWebSearch = true;
      await assert.rejects(
        provider.complete({ ...request(), nativeWebSearch: true }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.nativeActivity, true);
          assert.equal(canRecoverProviderError(error), false);
          return true;
        },
      );
    },
  );
});
test("SSE frame limits remain non-recoverable after partial text", async () => {
  await fixture(
    "openai-completions",
    (response) =>
      response.end(
        text("openai-completions") +
          "data: " +
          "x".repeat(2 * 1024 * 1024 + 1) +
          "\n\n",
      ),
    async ({ provider }) => {
      await assert.rejects(
        provider.complete(request()),
        failure("protocol", false),
      );
    },
  );
});
test("malformed JSON response cannot become a transport retry", async () => {
  await fixture(
    "openai-completions",
    (response) => {
      response.setHeader("Content-Type", "application/json");
      response.end("{invalid");
    },
    async ({ router, requests }) => {
      await assert.rejects(
        router.complete(request()),
        failure("protocol", false, false),
      );
      assert.equal(requests(), 1);
    },
  );
});

test("a non-streaming JSON response cut off within valid syntax is a transport interruption", async () => {
  await fixture(
    "openai-completions",
    (response) => {
      response.setHeader("Content-Type", "application/json");
      response.end('{"choices":[{"message":{"content":"split');
    },
    async ({ provider }) => {
      await assert.rejects(
        provider.complete(request()),
        failure("stream_interrupted", true, false),
      );
    },
  );
});
test("complete JSON without terminal status is a protocol failure even after text", async () => {
  await fixture(
    "openai-completions",
    (response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ choices: [{ message: { content: "partial" } }] }),
      );
    },
    async ({ provider }) => {
      await assert.rejects(
        provider.complete(request()),
        failure("protocol", false),
      );
    },
  );
});
test("HTTP exhausted quota neither retries nor falls back", async () => {
  await fixture(
    "openai-completions",
    (response) => {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "insufficient_quota", message: "fixture quota" },
        }),
      );
    },
    async ({ router, requests, config }) => {
      config.routes.text.fallbackRouteIds = ["fallback"];
      config.routes.fallback = { ...config.routes.text, fallbackRouteIds: [] };
      await assert.rejects(
        router.complete(request()),
        failure("http", false, false),
      );
      assert.equal(requests(), 1);
    },
  );
});
test("jitter never exceeds the configured maximum delay", () => {
  const error = new ProviderError("busy", 503);
  assert.equal(
    retryDelay(
      error,
      2,
      { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 1000 },
      () => 1,
    ),
    1000,
  );
});
test("model recovery defaults off and accepts bounded strict configuration", () => {
  const base = {
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "fixture",
        baseUrl: "http://127.0.0.1:1",
      },
    },
  };
  assert.deepEqual(parseConfig(base).limits.modelRecovery, {
    maxRetries: 0,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    maxElapsedMs: 300000,
  });
  assert.deepEqual(
    parseConfig({
      ...base,
      limits: {
        modelRecovery: {
          maxRetries: 3,
          initialDelayMs: 2000,
          maxDelayMs: 20000,
          maxElapsedMs: 300000,
        },
      },
    }).limits.modelRecovery,
    {
      maxRetries: 3,
      initialDelayMs: 2000,
      maxDelayMs: 20000,
      maxElapsedMs: 300000,
    },
  );
  for (const modelRecovery of [
    { maxRetries: 11 },
    { initialDelayMs: 20000, maxDelayMs: 1000 },
    { maxElapsedMs: 0 },
    { maxRetries: 2, unexpected: true },
  ])
    assert.throws(() => parseConfig({ ...base, limits: { modelRecovery } }));
});
