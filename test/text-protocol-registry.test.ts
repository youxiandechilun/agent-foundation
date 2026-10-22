import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { z } from "zod";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/core/config.js";
import { HttpTextProvider } from "../src/providers/text.js";
import {
  registerTextProtocol,
  textProtocolIds,
} from "../src/providers/registry.js";
import type { TextProtocol } from "../src/providers/protocol.js";

const routes = (adapter: string, baseUrl = "http://127.0.0.1:1") => ({
  defaultRoutes: { chat: "t", code: "t", office: "t" },
  routes: { t: { kind: "text", adapter, model: "wire", baseUrl } },
});

test("registered text protocols are routable without changing the provider", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        auth: req.headers["x-test-key"],
        ...JSON.parse(raw),
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          reply: "pong",
          call: { id: "c1", name: "probe", args: '{"n":1}' },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const protocol: TextProtocol = {
    id: "test-json",
    url: (base) => base + "/generate",
    credentials: (key) => ({ "x-test-key": key }),
    body: ({ request, budget }) => ({
      prompt: request.messages.map((m) => m.role).join(","),
      limit: budget,
    }),
    async event(value, response) {
      const event = z
        .object({
          reply: z.string(),
          call: z.object({
            id: z.string(),
            name: z.string(),
            args: z.string(),
          }),
        })
        .parse(value);
      await response.text(event.reply);
      response.calls.set(0, {
        id: event.call.id,
        name: event.call.name,
        json: event.call.args,
      });
      response.usage({ input_tokens: 3, output_tokens: 2 });
      response.finish("stop");
    },
  };
  const unregister = registerTextProtocol(protocol);
  t.after(unregister);
  assert.ok(textProtocolIds().includes("test-json"));
  assert.throws(() => registerTextProtocol(protocol), /Duplicate or invalid/);
  assert.throws(
    () => registerTextProtocol({ ...protocol, id: "custom-media" }),
    /Duplicate or invalid/,
  );

  process.env.TEST_PROTOCOL_KEY = "secret-key";
  t.after(() => delete process.env.TEST_PROTOCOL_KEY);
  const config = parseConfig({
    ...routes(
      "test-json",
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ),
  });
  config.routes.t.apiKeyEnv = "TEST_PROTOCOL_KEY";
  const deltas: string[] = [];
  const message = await new HttpTextProvider("t", config.routes.t).complete(
    {
      routeId: "t",
      tools: [],
      messages: [{ role: "user", content: "ping", timestamp: 1 }],
    },
    (delta) => {
      deltas.push(delta.text);
    },
  );
  assert.deepEqual(seen, [
    { url: "/generate", auth: "secret-key", prompt: "user", limit: 4096 },
  ]);
  assert.deepEqual(deltas, ["pong"]);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content, [
    { type: "text", text: "pong" },
    { type: "toolCall", id: "c1", name: "probe", arguments: { n: 1 } },
  ]);
  assert.equal(message.usage.reported, true);
});

test("text routes must name a registered protocol", () => {
  assert.throws(
    () => parseConfig(routes("missing-protocol")),
    /Unknown text protocol/,
  );
  assert.throws(
    () => parseConfig(routes("media-http")),
    /Unknown text protocol/,
  );
  assert.throws(() => parseConfig(routes("Bad_Adapter")), /adapter/i);
  assert.equal(
    parseConfig(routes("anthropic-messages")).routes.t.adapter,
    "anthropic-messages",
  );
});
