import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { z } from "zod";
import { MCPClient, MCP_MODERN_VERSION } from "../src/extensions/mcp/client.js";
import { setup } from "./support/wire-server.js";

const worker = fileURLToPath(
  new URL("../src/extensions/plugins/worker.mjs", import.meta.url),
);
const replySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  nonce: z.string().optional(),
});
type WorkerRequest = {
  nonce: string;
  root: string;
  entry: string;
  integrity: Record<string, string>;
  operation: "tool" | "media";
  payload: {
    name?: string;
    args?: unknown;
    adapterId?: string;
    method?: string;
    request?: unknown;
    context: { tag: string };
  };
};
async function invokeWorker(
  transport: "ipc" | "stdio",
  request: WorkerRequest,
) {
  const options = { cwd: request.root, windowsHide: true };
  const child =
    transport === "ipc"
      ? fork(worker, [path.join(request.root, request.entry)], {
          ...options,
          silent: true,
        })
      : spawn(process.execPath, [worker], {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        });
  try {
    return await new Promise<z.infer<typeof replySchema>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Plugin fixture timed out")),
        5000,
      );
      const finish = (value: unknown) => {
        clearTimeout(timer);
        try {
          resolve(replySchema.parse(value));
        } catch (error) {
          reject(error);
        }
      };
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      if (transport === "ipc") {
        child.once("message", finish);
        child.send(request);
      } else {
        const chunks: Buffer[] = [];
        child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.once("close", () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        child.stdin!.end(JSON.stringify(request));
      }
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      child.kill();
      await closed;
    }
  }
}

test("plugin IPC and isolated stdio share verified exports and preserve media receiver binding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-shared-worker-"));
  const source = `export function execute(name, args, context) {
    return { name, args, tag: context.tag, frozen: Object.isFrozen(context) };
  }
  export const mediaAdapters = { fixture: { prefix: 'bound', render(request, context) {
    console.info('plugin console must not corrupt protocol');
    return this.prefix + ':' + request + ':' + context.tag;
  } } };`;
  const request: WorkerRequest = {
    nonce: "fixture",
    root,
    entry: "index.mjs",
    integrity: {
      "index.mjs": createHash("sha256").update(source).digest("hex"),
    },
    operation: "tool",
    payload: { name: "echo", args: { value: 7 }, context: { tag: "checked" } },
  };
  try {
    await writeFile(path.join(root, request.entry), source);
    for (const transport of ["ipc", "stdio"] as const) {
      const tool = await invokeWorker(transport, request);
      assert.equal(tool.ok, true);
      assert.deepEqual(tool.result, {
        name: "echo",
        args: { value: 7 },
        tag: "checked",
        frozen: true,
      });
      const media = await invokeWorker(transport, {
        ...request,
        operation: "media",
        payload: {
          adapterId: "fixture",
          method: "render",
          request: "image",
          context: { tag: "checked" },
        },
      });
      assert.equal(media.result, "bound:image:checked");
      const absent = await invokeWorker(transport, {
        ...request,
        integrity: {},
      });
      assert.equal(absent.ok, false);
      assert.match(absent.error!, /Entry missing/);
    }
    await writeFile(path.join(root, request.entry), source + "\n// changed");
    for (const transport of ["ipc", "stdio"] as const) {
      const changed = await invokeWorker(transport, request);
      assert.equal(changed.ok, false);
      assert.match(changed.error!, /integrity/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const requestSchema = z.object({
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z
    .object({
      arguments: z.object({ value: z.number() }).optional(),
      _meta: z.object({ progressToken: z.string().optional() }).optional(),
    })
    .optional(),
});
type Request = z.infer<typeof requestSchema>;

function sendResult(
  response: http.ServerResponse,
  id: Request["id"],
  result: object,
): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
async function protocolPeer(
  handle: (
    message: Request,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
) {
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (message.method === "server/discover")
        sendResult(response, message.id, {
          supportedVersions: [MCP_MODERN_VERSION],
          capabilities: { tools: {} },
        });
      else handle(message, request, response);
    })().catch((error: unknown) =>
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: "http://127.0.0.1:" + address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("MCP concurrent progress routes by token and completed requests release their callbacks", async () => {
  const requests: { message: Request; response: http.ServerResponse }[] = [];
  const rpc = (value: object) =>
    "data: " + JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n\n";
  const peer = await protocolPeer((message, _request, response) => {
    if (message.method === "tools/call") {
      requests.push({ message, response });
      if (requests.length !== 32) return;
      for (const entry of [...requests].reverse()) {
        entry.response.writeHead(200, {
          "Content-Type": "text/event-stream",
        });
        entry.response.end(
          rpc({
            method: "notifications/progress",
            params: {
              progressToken: entry.message.params?._meta?.progressToken,
              progress: entry.message.params?.arguments?.value,
            },
          }) +
            rpc({
              id: entry.message.id,
              result: { content: [{ type: "text", text: "done" }] },
            }),
        );
      }
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const entry of requests)
        response.write(
          rpc({
            method: "notifications/progress",
            params: {
              progressToken: entry.message.params?._meta?.progressToken,
              progress: -1,
            },
          }),
        );
      response.end(rpc({ id: message.id, result: {} }));
    }
  });
  const client = new MCPClient({
    transport: "http",
    protocol: "modern",
    url: peer.url,
    timeoutMs: 5000,
  });
  const progress: unknown[][] = Array.from({ length: 32 }, () => []);
  try {
    await client.connect();
    await Promise.all(
      progress.map((events, value) =>
        client.callTool(
          { name: "echo", arguments: { value } },
          { progress: (event: unknown) => events.push(event) },
        ),
      ),
    );
    assert.deepEqual(
      progress.map(
        (events) =>
          z.object({ progress: z.number() }).parse(events[0]).progress,
      ),
      Array.from({ length: 32 }, (_, index) => index),
    );
    await client.ping();
    assert.ok(progress.every((events) => events.length === 1));
  } finally {
    await client.close();
    await peer.close();
  }
});

test("MCP catalog discovery overlaps independent servers with a bounded fan-out and stable order", async () => {
  const waiting: {
    id: number | string;
    name: string;
    response: http.ServerResponse;
  }[] = [];
  let listed = 0,
    maximum = 0;
  const peer = await protocolPeer((message, request, response) => {
    assert.equal(message.method, "tools/list");
    waiting.push({ id: message.id, name: request.url!.slice(1), response });
    maximum = Math.max(maximum, waiting.length);
    listed++;
    if (listed !== 4 && listed !== 6) return;
    for (const entry of waiting.splice(0).reverse()) {
      sendResult(entry.response, entry.id, {
        tools: [{ name: entry.name, inputSchema: { type: "object" } }],
      });
    }
  });
  const fixture = await setup();
  try {
    for (let index = 0; index < 6; index++) {
      const id = "catalog" + index;
      fixture.kernel.mcp.install({
        id,
        name: id,
        transport: "http",
        protocol: "modern",
        url: peer.url + "/" + id,
        timeoutMs: 3000,
      });
      await fixture.kernel.mcp.connect(id);
    }
    const ordered = fixture.kernel.mcp
      .list()
      .filter((server) => server.enabled && server.connected)
      .map((server) => "mcp_" + server.id + "_" + server.id);
    const tools = await fixture.kernel.mcp.tools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ordered,
    );
    assert.equal(maximum, 4);
    assert.equal(listed, 6);
  } finally {
    await fixture.close();
    await peer.close();
  }
});
