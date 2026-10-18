import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MCPClient, type MCPTool } from "../src/extensions/mcp/client.js";
import { setup } from "./support/wire-server.js";

interface CatalogReply {
  tools: MCPTool[];
  nextCursor?: string;
  notify?: boolean;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const oldTool: MCPTool = {
  name: "echo",
  inputSchema: {
    type: "object",
    required: ["region"],
    properties: {
      region: { type: "string", "x-mcp-header": "region" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["count"],
    properties: { count: { type: "integer" } },
  },
};
const nextTool: MCPTool = {
  name: "echo",
  inputSchema: {
    type: "object",
    required: ["token"],
    properties: {
      token: { type: "integer", "x-mcp-header": "token" },
    },
  },
};
async function fixture(
  protocol: "legacy" | "modern" = "modern",
  authorization?: () => Promise<string>,
) {
  const calls: http.IncomingHttpHeaders[] = [];
  let nextTask = 0;
  const peer = {
    lists: 0,
    page: async (_cursor?: string): Promise<CatalogReply> => ({
      tools: [oldTool],
    }),
    call: async (): Promise<unknown> => ({
      structuredContent: { count: "unvalidated" },
    }),
  };
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(
        value &&
          typeof value === "object" &&
          "method" in value &&
          typeof value.method === "string",
      );
      if (!("id" in value)) {
        response.writeHead(202).end();
        return;
      }
      const params =
        "params" in value && value.params && typeof value.params === "object"
          ? value.params
          : {};
      let result: unknown;
      if (value.method === "server/discover")
        result = {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        };
      else if (value.method === "initialize")
        result = {
          protocolVersion:
            "protocolVersion" in params ? params.protocolVersion : undefined,
          capabilities: {
            tools: { listChanged: true },
            tasks: { requests: { tools: { call: {} } } },
          },
          serverInfo: { name: "catalog", version: "1" },
        };
      else if (value.method === "tools/list") {
        peer.lists++;
        const cursor =
          "cursor" in params && typeof params.cursor === "string"
            ? params.cursor
            : undefined;
        const page = await peer.page(cursor);
        result = { tools: page.tools, nextCursor: page.nextCursor };
        if (page.notify) {
          response.setHeader("Content-Type", "text/event-stream");
          response.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
          );
        }
      } else if (value.method === "tools/call" && "task" in params) {
        result = {
          task: {
            taskId: `catalog-task-${++nextTask}`,
            status: "working",
            ttl: 10000,
          },
        };
      } else if (value.method === "tasks/get") {
        result = {
          taskId: "taskId" in params ? params.taskId : undefined,
          status: "completed",
          ttl: 10000,
        };
      } else if (value.method === "tasks/result") {
        const content = await peer.call();
        assert.ok(content && typeof content === "object");
        result = {
          ...content,
          _meta: {
            "io.modelcontextprotocol/related-task": {
              taskId: "taskId" in params ? params.taskId : undefined,
            },
          },
        };
      } else {
        calls.push(request.headers);
        result = await peer.call();
      }
      const reply = JSON.stringify({ jsonrpc: "2.0", id: value.id, result });
      if (response.headersSent) response.end(`data: ${reply}\n\n`);
      else
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(reply);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new MCPClient({
    transport: "http",
    protocol,
    authorization,
    url: `http://127.0.0.1:${address.port}/mcp`,
  });
  await client.connect();
  return {
    client,
    url: `http://127.0.0.1:${address.port}/mcp`,
    peer,
    calls,
    close: async () => {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("complete MCP catalogs remove stale validators and headers without caching results", async () => {
  const x = await fixture();
  try {
    await x.client.toolCatalog();
    assert.throws(
      () => x.client.callTool({ name: "echo", arguments: {} }),
      /input violates/,
    );
    await assert.rejects(
      x.client.callTool({ name: "echo", arguments: { region: "old" } }),
      /structured output/,
    );
    assert.equal(x.calls.at(-1)?.["mcp-param-region"], "old");
    x.peer.page = async () => ({ tools: [] });
    await x.client.toolCatalog();
    await x.client.callTool({ name: "echo", arguments: { region: "removed" } });
    assert.equal(x.calls.at(-1)?.["mcp-param-region"], undefined);
    assert.equal(x.peer.lists, 2);
    x.peer.page = async () => ({ tools: [nextTool] });
    await x.client.listTools();
    await x.client.callTool({ name: "echo", arguments: { token: 7 } });
    assert.equal(x.calls.at(-1)?.["mcp-param-token"], "7");
    assert.equal(x.calls.at(-1)?.["mcp-param-region"], undefined);
    x.peer.page = async () => ({
      tools: [
        {
          name: "echo",
          inputSchema: {
            type: "object",
            required: ["token"],
            properties: {
              token: { type: "integer", "x-mcp-header": 1 },
            },
          },
        },
      ],
    });
    assert.deepEqual((await x.client.toolCatalog()).tools, []);
    await x.client.callTool({ name: "echo", arguments: {} });
    assert.equal(x.calls.at(-1)?.["mcp-param-token"], undefined);
  } finally {
    await x.close();
  }
});

test("cancelled, rejected and successful paginated MCP catalogs commit metadata atomically", async () => {
  const x = await fixture();
  const entered = deferred(),
    release = deferred(),
    controller = new AbortController();
  try {
    await x.client.toolCatalog();
    x.peer.page = async (cursor) => {
      if (!cursor) return { tools: [nextTool], nextCursor: "next" };
      entered.resolve();
      await release.promise;
      return { tools: [] };
    };
    const pending = x.client.toolCatalog({ signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled|abort/i);
    await entered.promise;
    await assert.rejects(
      x.client.callTool({ name: "echo", arguments: { region: "kept" } }),
      /structured output/,
    );
    assert.equal(x.calls.at(-1)?.["mcp-param-region"], "kept");
    controller.abort();
    await rejected;
    release.resolve();
    await assert.rejects(
      x.client.toolCatalog({
        validate: () => {
          throw Error("host catalog revoked");
        },
      }),
      /host catalog revoked/,
    );
    assert.throws(
      () => x.client.callTool({ name: "echo", arguments: { token: 1 } }),
      /input violates/,
    );
    const complete = x.peer.page;
    x.peer.page = async () => ({ tools: [nextTool], nextCursor: "repeated" });
    await assert.rejects(x.client.toolCatalog(), /repeated/);
    assert.throws(
      () => x.client.callTool({ name: "echo", arguments: { token: 1 } }),
      /input violates/,
    );
    x.peer.page = complete;
    await x.client.toolCatalog();
    await x.client.callTool({ name: "echo", arguments: { token: 2 } });
    assert.equal(x.calls.at(-1)?.["mcp-param-token"], "2");
  } finally {
    release.resolve();
    await x.close();
  }
});

test("MCP list-change notifications reject in-progress metadata before commit", async () => {
  const x = await fixture("legacy");
  try {
    await x.client.toolCatalog();
    x.peer.page = async () => ({ tools: [nextTool], notify: true });
    await assert.rejects(x.client.toolCatalog(), /catalog changed/);
    assert.throws(
      () => x.client.callTool({ name: "echo", arguments: { token: 1 } }),
      /input violates/,
    );
    assert.ok(
      x.client
        .notifications()
        .some((event) => event.method === "notifications/tools/list_changed"),
    );
  } finally {
    await x.close();
  }
});

test("in-flight MCP calls retain their schema and header bindings across catalog refresh", async () => {
  const entered = deferred(),
    release = deferred();
  let block = false;
  const x = await fixture("modern", async () => {
    if (block) {
      block = false;
      entered.resolve();
      await release.promise;
    }
    return "Bearer catalog-test";
  });
  try {
    await x.client.toolCatalog();
    x.peer.call = async () => ({ structuredContent: { count: 1 } });
    block = true;
    const pending = x.client.callTool({
      name: "echo",
      arguments: { region: "original" },
    });
    await entered.promise;
    x.peer.page = async () => ({
      tools: [
        {
          ...nextTool,
          outputSchema: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "string" } },
          },
        },
      ],
    });
    await x.client.toolCatalog();
    release.resolve();
    await pending;
    assert.equal(x.calls.at(-1)?.["mcp-param-region"], "original");
    assert.equal(x.calls.at(-1)?.["mcp-param-token"], undefined);
    await assert.rejects(
      x.client.callTool({ name: "echo", arguments: { token: 3 } }),
      /structured output/,
    );
    assert.equal(x.calls.at(-1)?.["mcp-param-token"], "3");
  } finally {
    release.resolve();
    await x.close();
  }
});

for (const change of ["removed", "changed"] as const) {
  for (const valid of [false, true]) {
    test(
      `legacy required task ${valid ? "accepts valid" : "rejects invalid"} original output after its tool is ${change}`,
      { timeout: 10000 },
      async () => {
        const x = await setup(),
          peer = await fixture("legacy");
        const entered = deferred(),
          release = deferred();
        try {
          peer.peer.page = async () => ({
            tools: [{ ...oldTool, execution: { taskSupport: "required" } }],
          });
          x.kernel.mcp.install({
            id: "catalog-task",
            name: "catalog-task",
            transport: "http",
            protocol: "legacy",
            url: peer.url,
          });
          await x.kernel.mcp.connect("catalog-task");
          const [tool] = await x.kernel.mcp.tools();
          assert.ok(tool);
          peer.peer.call = async () => {
            entered.resolve();
            await release.promise;
            return { structuredContent: { count: valid ? 1 : "INVALID" } };
          };
          const pending = tool.execute("snapshot-task", { region: "original" });
          const checked = valid
            ? pending.then((result) => {
                assert.deepEqual(result.details, { count: 1 });
              })
            : assert.rejects(pending, /structured output/);
          await entered.promise;
          peer.peer.page = async () => ({
            tools:
              change === "removed"
                ? []
                : [
                    {
                      ...oldTool,
                      outputSchema: {
                        type: "object",
                        required: ["count"],
                        properties: { count: { type: "string" } },
                      },
                    },
                  ],
          });
          await x.kernel.mcp.catalog("catalog-task");
          release.resolve();
          await checked;
          assert.equal(
            x.kernel.mcp.tasks("catalog-task")[0].status,
            valid ? "completed" : "unknown",
          );
        } finally {
          release.resolve();
          await peer.close();
          await x.close();
        }
      },
    );
  }
}
