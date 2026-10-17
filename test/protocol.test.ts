import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseConfig } from "../src/config.js";
import { HttpTextProvider } from "../src/providers/text.js";
import {
  completionsMessages,
  responsesInput,
  anthropicMessages,
} from "../src/providers/serialize.js";
import { sse } from "../src/providers/sse.js";

test("SSE decoder handles split UTF-8, CRLF and multiline frames", async () => {
  const bytes = Buffer.from(
    'event: text\r\ndata: {"value":\r\ndata: "中文"}\r\n\r\n',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i++)
        controller.enqueue(bytes.subarray(i, i + 1));
      controller.close();
    },
  });
  const events = [];
  for await (const event of sse(new Response(stream))) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].data).value, "中文");
});
test("tool screenshots reach all three vision wire formats after a complete tool result batch", () => {
  const config = parseConfig({
    defaultRoutes: { chat: "t", code: "t", office: "t" },
    routes: {
      t: {
        kind: "text",
        adapter: "openai-completions",
        model: "wire",
        baseUrl: "http://127.0.0.1:12345",
      },
    },
  });
  const history: any[] = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "a", name: "screen", arguments: {} },
        { type: "toolCall", id: "b", name: "read", arguments: {} },
      ],
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "a",
      toolName: "screen",
      content: [
        { type: "text", text: "screenshot" },
        { type: "image", mimeType: "image/png", data: "YWJj" },
      ],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "b",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const c = completionsMessages(history, config.routes.t);
  assert.deepEqual(
    c.map((m) => m.role),
    ["assistant", "tool", "tool", "user"],
  );
  assert.match(JSON.stringify(c[3]), /image_url/);
  assert.match(JSON.stringify(responsesInput(history, "t")), /input_image/);
  assert.match(JSON.stringify(anthropicMessages(history, "t")), /base64/);
});
test("Anthropic native thinking signatures, redacted blocks and tool JSON survive round trips", async () => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type: string, data: any) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    event("message_start", {
      message: { id: "signed", usage: { input_tokens: 4, output_tokens: 0 } },
    });
    if (requests.length === 1) {
      event("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "API reasoning text" },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "signature_delta", signature: "opaque-signature" },
      });
      event("content_block_start", {
        index: 1,
        content_block: { type: "redacted_thinking", data: "opaque-redacted" },
      });
      event("content_block_start", {
        index: 2,
        content_block: {
          type: "tool_use",
          id: "call-sign",
          name: "read",
          input: {},
        },
      });
      event("content_block_delta", {
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"path":"x"}' },
      });
      event("message_delta", {
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 8 },
      });
    } else {
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "done" },
      });
      event("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      });
    }
    event("message_stop", {});
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const config = parseConfig({
      defaultRoutes: { chat: "t", code: "t", office: "t" },
      routes: {
        t: {
          kind: "text",
          adapter: "anthropic-messages",
          model: "protocol",
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
          reasoning: true,
        },
      },
    });
    const provider = new HttpTextProvider("t", config.routes.t);
    const initial: any = { role: "user", content: "read", timestamp: 1 };
    const first = await provider.complete({
      routeId: "t",
      messages: [initial],
      tools: [],
    });
    assert.equal(first.stopReason, "toolUse");
    await provider.complete({
      routeId: "t",
      messages: [
        initial,
        first,
        {
          role: "toolResult",
          toolCallId: "call-sign",
          toolName: "read",
          content: [{ type: "text", text: "actual" }],
          isError: false,
          timestamp: 2,
        },
      ],
      tools: [],
    });
    const blocks = requests[1].messages.find(
      (m: any) => m.role === "assistant",
    ).content;
    assert.equal(blocks[0].signature, "opaque-signature");
    assert.equal(blocks[1].data, "opaque-redacted");
    assert.deepEqual(blocks[2].input, { path: "x" });
    assert.equal(requests[0].thinking.type, "enabled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
