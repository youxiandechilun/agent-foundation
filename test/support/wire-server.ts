import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Kernel } from "../../src/kernel.js";
import { parseConfig } from "../../src/config.js";
import { serve } from "../../src/server.js";
import { FoundationClient } from "../../src/client.js";
import type { FoundationEvent } from "../../src/contracts.js";

export interface Reply {
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
  delayMs?: number;
  finish?: string;
  status?: number;
  error?: { code?: string; type?: string; message: string };
}
export type Responder = (request: any, index: number) => Reply | Promise<Reply>;
export async function wireServer(
  respond: Responder = () => ({ text: "wire response" }),
) {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ url: req.url, body, headers: req.headers });
      const reply = await respond(body, requests.length - 1);
      if (reply.status && reply.status !== 200) {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: reply.error || { message: "wire error" } }),
        );
        return;
      }
      if (reply.delayMs)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, reply.delayMs);
          res.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type: string, data: any) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      if (req.url?.includes("/messages")) {
        event("message_start", {
          message: {
            id: "msg_" + requests.length,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        if (reply.text) {
          event("content_block_start", {
            index: 0,
            content_block: { type: "text", text: "" },
          });
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: reply.text },
          });
          event("content_block_stop", { index: 0 });
        }
        for (const [i, c] of (reply.calls || []).entries()) {
          event("content_block_start", {
            index: i + 1,
            content_block: {
              type: "tool_use",
              id: "call_" + requests.length + "_" + i,
              name: c.name,
              input: {},
            },
          });
          const json = JSON.stringify(c.args),
            half = Math.floor(json.length / 2);
          for (const chunk of [json.slice(0, half), json.slice(half)])
            event("content_block_delta", {
              index: i + 1,
              delta: { type: "input_json_delta", partial_json: chunk },
            });
          event("content_block_stop", { index: i + 1 });
        }
        event("message_delta", {
          delta: {
            stop_reason:
              reply.finish || (reply.calls?.length ? "tool_use" : "end_turn"),
          },
          usage: { output_tokens: 12 },
        });
        event("message_stop", {});
      } else if (req.url?.includes("/responses")) {
        event("response.created", {
          response: { id: "resp_" + requests.length },
        });
        if (reply.text)
          event("response.output_text.delta", { delta: reply.text });
        const output = (reply.calls || []).map((c, i) => ({
          type: "function_call",
          call_id: "call_" + requests.length + "_" + i,
          name: c.name,
          arguments: JSON.stringify(c.args),
        }));
        for (const [i, item] of output.entries())
          event("response.output_item.done", { output_index: i, item });
        event(
          reply.finish === "length"
            ? "response.incomplete"
            : "response.completed",
          {
            response: {
              id: "resp_" + requests.length,
              status: "completed",
              output,
              usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
            },
          },
        );
      } else {
        const chunk = (delta: any, finish_reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: "chat_" + requests.length, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        for (const text of reply.text?.match(/.{1,7}/gu) || [])
          chunk({ content: text });
        for (const [i, c] of (reply.calls || []).entries()) {
          const args = JSON.stringify(c.args),
            half = Math.floor(args.length / 2);
          chunk({
            tool_calls: [
              {
                index: i,
                id: "call_" + requests.length + "_" + i,
                type: "function",
                function: { name: c.name, arguments: args.slice(0, half) },
              },
            ],
          });
          chunk({
            tool_calls: [
              { index: i, function: { arguments: args.slice(half) } },
            ],
          });
        }
        chunk(
          {},
          reply.finish || (reply.calls?.length ? "tool_calls" : "stop"),
        );
        if (body.stream_options?.include_usage)
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } })}\n\n`,
          );
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    requests,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export const token = "test-host-token-12345678901234567890";
export async function setup(
  respond?: Responder,
  overrides: Record<string, unknown> = {},
  host: {
    desktop?: boolean;
    integrations?: import("../../src/runtime/registry.js").KernelIntegration[];
  } = {},
) {
  const wire = await wireServer(respond),
    root = await mkdtemp(path.join(tmpdir(), "foundation-v2-"));
  const config = parseConfig({
    server: { port: 0 },
    dataDir: path.join(root, "data"),
    workspaceRoots: [path.join(root, "project")],
    extensions: { allowedRoots: [path.join(root, "extensions")] },
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "protocol-test-model",
        baseUrl: wire.url + "/v1",
        contextWindow: 128000,
      },
    },
    permissions: {
      exec: "allow",
      media: "allow",
      browser: "allow",
      mcp: "allow",
      plugin: "allow",
      node: "allow",
    },
    browser: { headless: true, allowPrivateNetwork: true },
    ...overrides,
  });
  const integrations = [
    ...(host.integrations || []),
    ...(host.desktop
      ? [(await import("../../src/host/desktop.js")).desktopIntegration()]
      : []),
  ];
  const kernel = new Kernel(config, { integrations }) as Kernel &
      import("../../src/host/desktop.js").DesktopServices,
    api = await serve(kernel, token),
    client = new FoundationClient(api.url, token),
    project = await client.project("test");
  const session = async (
    mode: "chat" | "code" | "office" = "chat",
    routeId?: string,
  ) => {
    const s = await client.session(project.id, mode, routeId);
    await client.request("PATCH", `/v1/sessions/${s.id}`, {
      autonomy: "autonomous",
    });
    return s;
  };
  return {
    wire,
    root,
    config,
    kernel,
    api,
    client,
    project,
    session,
    close: async () => {
      await api.close();
      await wire.close();
    },
  };
}
export async function collect(client: FoundationClient, runId: string) {
  const events: FoundationEvent[] = [];
  for await (const event of client.events(runId)) events.push(event);
  return events;
}
export async function until<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Condition deadline exceeded");
}

export async function setupDesktop(
  respond?: Responder,
  overrides: Record<string, unknown> = {},
) {
  return setup(respond, overrides, { desktop: true });
}
