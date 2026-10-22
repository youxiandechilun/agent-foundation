import { test } from "node:test";
import assert from "node:assert/strict";
import { MCPToolCatalog } from "../src/extensions/mcp/client/tool-catalog.js";
import {
  MCPTaskReceiver,
  MCPTaskReceiverError,
  type MCPReceivedTask,
} from "../src/extensions/mcp/tasks/receiver.js";
import { RELATED_TASK } from "../src/extensions/mcp/tasks/context.js";
import { wireMember, type WireObject } from "../src/extensions/mcp/protocol.js";

test("MCP tool catalogs reject malformed named fields before exposing tool definitions", () => {
  const invalid: WireObject[] = [
    { description: 7 },
    { description: null },
    { inputSchema: [] },
    { inputSchema: null },
    { outputSchema: [] },
    { outputSchema: false },
    { outputSchema: null },
    { execution: 1 },
    { execution: [] },
    { execution: null },
    { execution: { taskSupport: "sometimes" } },
    { execution: { taskSupport: true } },
  ];
  for (const fields of invalid) {
    const catalog = new MCPToolCatalog(() => {});
    assert.throws(
      () =>
        catalog.accept(
          {
            tools: [
              { name: "example", inputSchema: { type: "object" }, ...fields },
            ],
          },
          false,
        ),
      /Invalid MCP tool list/,
      JSON.stringify(fields),
    );
  }
});

test("MCP catalog validation preserves extension fields and enforces valid output schemas", () => {
  const catalog = new MCPToolCatalog(() => {});
  const { tools } = catalog.accept(
    {
      nextCursor: "next-page",
      tools: [
        {
          name: "example",
          description: "Example tool",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
          execution: { taskSupport: "optional", "vendor/timeout": 100 },
          "vendor/display": { color: "blue" },
        },
      ],
    },
    false,
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0].description, "Example tool");
  assert.deepEqual(tools[0].execution, {
    taskSupport: "optional",
    "vendor/timeout": 100,
  });
  assert.deepEqual(tools[0]["vendor/display"], { color: "blue" });
  assert.throws(
    () =>
      catalog.validateResult("example", { structuredContent: { answer: 7 } }),
    /structured output violates its catalog schema/,
  );
  assert.deepEqual(
    catalog.validateResult("example", { structuredContent: { answer: "yes" } })
      .structuredContent,
    { answer: "yes" },
  );
  for (const taskSupport of [undefined, "forbidden", "required"]) {
    assert.equal(
      catalog.accept(
        {
          tools: [
            {
              name: "other",
              inputSchema: { type: "object" },
              execution: { taskSupport },
            },
          ],
        },
        false,
      ).tools.length,
      1,
    );
  }
});

test("MCP client tasks fail malformed handler results and release their execution signal", async () => {
  for (const value of ["done", 1, false, null, undefined, ["done"]]) {
    const records: MCPReceivedTask[] = [];
    const receiver = new MCPTaskReceiver(
      { elicitation: true, persist: (record) => records.push(record) },
      async () => {},
      10000,
    );
    const lifetime = new AbortController();
    let executionSignal: AbortSignal | undefined;
    try {
      const { task } = receiver.create(
        "elicitation/create",
        { task: { ttl: 1000 } },
        {
          requestId: 1,
          method: "tools/call",
          params: {},
          signal: lifetime.signal,
        },
        async (context) => {
          executionSignal = context.signal;
          return value;
        },
      );
      await assert.rejects(
        receiver.handle(
          "tasks/result",
          { taskId: task.taskId },
          lifetime.signal,
        ),
        (error: unknown) =>
          error instanceof MCPTaskReceiverError &&
          error.code === -32603 &&
          error.message === "Invalid client task result",
      );
      const status = await receiver.handle(
        "tasks/get",
        { taskId: task.taskId },
        lifetime.signal,
      );
      assert.equal(wireMember(status, "status"), "failed");
      assert.equal(records.at(-1)?.status, "failed");
      assert.equal(records.at(-1)?.result, undefined);
      assert.equal(executionSignal?.aborted, true);
    } finally {
      receiver.close();
    }
  }
});

test("MCP client task object results retain their payload and extension metadata", async () => {
  const receiver = new MCPTaskReceiver(
    { elicitation: true },
    async () => {},
    10000,
  );
  const lifetime = new AbortController();
  try {
    const { task } = receiver.create(
      "elicitation/create",
      { task: { ttl: 1000 } },
      {
        requestId: 1,
        method: "tools/call",
        params: {},
        signal: lifetime.signal,
      },
      async () => ({
        action: "accept",
        content: { answer: "yes" },
        _meta: { "vendor/audit": "kept" },
        "vendor/result": [1, 2],
      }),
    );
    assert.deepEqual(
      await receiver.handle(
        "tasks/result",
        { taskId: task.taskId },
        lifetime.signal,
      ),
      {
        action: "accept",
        content: { answer: "yes" },
        _meta: {
          "vendor/audit": "kept",
          [RELATED_TASK]: { taskId: task.taskId },
        },
        "vendor/result": [1, 2],
      },
    );
    assert.equal(
      wireMember(
        await receiver.handle(
          "tasks/get",
          { taskId: task.taskId },
          lifetime.signal,
        ),
        "status",
      ),
      "completed",
    );
  } finally {
    receiver.close();
  }
});
