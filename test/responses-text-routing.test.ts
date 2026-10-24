import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { parseConfig } from "../src/core/config.js";
import { RouteRouter } from "../src/providers/text.js";
import { ProviderError } from "../src/providers/sse.js";
import { listenHttp } from "../src/transport/http-listener.js";

const message = (text: string) => ({
  type: "message",
  id: "message-0",
  content: [{ type: "output_text", text }],
});

for (const source of ["snapshot", "buffered-delta"] as const)
  test(`Responses ${source} integrity failure never retries or falls back`, async () => {
    let requests = 0;
    const events = [
      source === "snapshot"
        ? {
            type: "response.output_item.done",
            output_index: 0,
            item: message("A"),
          }
        : {
            type: "response.output_text.delta",
            output_index: 1,
            content_index: 0,
            item_id: "message-1",
            delta: "A",
          },
      {
        type: "response.completed",
        response: {
          id: "offline-response",
          output: [message("B")],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      },
    ];
    const server = http.createServer(async (request, response) => {
      for await (const _ of request) {
        /* Do not capture request content. */
      }
      requests++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      );
    });
    const address = await listenHttp(server, { host: "127.0.0.1", port: 0 });
    try {
      const route = {
        kind: "text",
        adapter: "openai-responses",
        model: "offline-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 10 },
      };
      const config = parseConfig({
        defaultRoutes: { chat: "text", code: "text", office: "text" },
        routes: {
          text: { ...route, fallbackRouteIds: ["fallback"] },
          fallback: route,
        },
      });
      const router = new RouteRouter(config);
      await assert.rejects(
        router.complete({ routeId: "text", messages: [], tools: [] }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.match(
            error.message,
            /Responses terminal text differs from streamed text/,
          );
          assert.equal(error.started, true);
          assert.equal(error.partial?.usage.reported, true);
          assert.equal(error.partial?.usage.input, 3);
          assert.equal(error.partial?.usage.output, 4);
          assert.equal(error.partial?.responseId, "offline-response");
          return true;
        },
      );
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
