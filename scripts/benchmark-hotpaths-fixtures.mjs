// @ts-check
import assert from "node:assert/strict";
import http from "node:http";

/** @typedef {{role: string, content?: unknown}} WireMessage */
/** @typedef {{model: string, messages: WireMessage[]}} WireRequest */
/** @param {unknown} value @returns {value is WireRequest} */
function isRequest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "model" in value &&
    typeof value.model === "string" &&
    "messages" in value &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        typeof message.role === "string",
    )
  );
}

/** Real local HTTP/SSE transport, with deterministic model responses derived from prior tool results.
 * @param {string} secret
 */
export async function localProvider(secret) {
  let requests = 0;
  /** @type {Error[]} */
  const errors = [];
  const finalText = `benchmark-complete:3 ${"response ".repeat(64)}`;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      assert.ok(
        !raw.includes(secret),
        "Provider request leaked the benchmark secret",
      );
      /** @type {unknown} */
      const body = JSON.parse(raw);
      assert.ok(isRequest(body));
      requests++;
      const results = body.messages.filter(
        (message) => message.role === "tool",
      );
      assert.ok(results.length <= 2);
      for (let i = 0; i < results.length; i++) {
        assert.equal(typeof results[i].content, "string");
        assert.ok(
          String(results[i].content).startsWith(`total=${i === 0 ? 1 : 3};`),
        );
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      /** @param {Record<string, unknown>} delta @param {string | null} [finish] */
      const event = (delta, finish = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `response-${requests}`, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (results.length < 2) {
        const args = JSON.stringify({ value: results.length + 1 });
        event({
          tool_calls: [
            {
              index: 0,
              id: `call-${requests}`,
              type: "function",
              function: {
                name: "benchmark_accumulate",
                arguments: args.slice(0, 5),
              },
            },
          ],
        });
        event({
          tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }],
        });
        event({}, "tool_calls");
      } else {
        for (let i = 0; i < finalText.length; i += 32)
          event({ content: finalText.slice(i, i + 32) });
        event({}, "stop");
      }
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Benchmark fixture assertion failed" },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    finalText,
    verify: (/** @type {number} */ count) => {
      assert.deepEqual(errors, []);
      assert.equal(requests, count);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** @param {typeof import("../src/core/util.js")} util @param {string[]} secrets @param {boolean} smoke @returns {import("./benchmark-hotpaths-worker.mjs").Scenario} */
export function requestJsonScenario(util, secrets, smoke) {
  const operations = smoke ? 3 : 200;
  const payload = {
    model: "benchmark",
    messages: Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      content: `${i}: ${"x".repeat(256)} ${secrets[i % secrets.length]}`,
    })),
    tools: Array.from({ length: 40 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: "benchmark tool",
        parameters: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: secrets[i % secrets.length],
            },
          },
        },
      },
    })),
  };
  const serialize =
    typeof util.redactJsonText === "function"
      ? util.redactJsonText
      : (/** @type {unknown} */ value) =>
          JSON.stringify(util.redactJson(value));
  let encoded = "";
  return {
    operations,
    parameters: {
      messages: 200,
      tools: 40,
      inputBytes: Buffer.byteLength(JSON.stringify(payload)),
      api:
        typeof util.redactJsonText === "function"
          ? "redactJsonText"
          : "JSON.stringify(redactJson)",
    },
    run: () => {
      for (let i = 0; i < operations; i++) encoded = serialize(payload);
    },
    verify: () => {
      assert.deepEqual(JSON.parse(encoded), util.redactJson(payload));
      for (const secret of secrets) assert.ok(!encoded.includes(secret));
    },
  };
}
