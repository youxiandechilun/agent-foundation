import assert from "node:assert/strict";
import { test } from "node:test";
import { MCPClientInput } from "../src/extensions/mcp/client/input.js";
import { MCPTaskContexts } from "../src/extensions/mcp/tasks/context.js";
import type { RpcMessage } from "../src/extensions/mcp/protocol.js";

for (const lateFailure of [false, true]) {
  test(`cancelled MCP input handlers retain capacity until late ${lateFailure ? "rejection" : "completion"}`, async () => {
    const lifetime = new AbortController();
    const replies: RpcMessage[] = [];
    const callbacks: {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }[] = [];
    const input = new MCPClientInput({
      pending: new Map(),
      taskContexts: new MCPTaskContexts(),
      signal: lifetime.signal,
      timeout: 10000,
      handlers: {
        "roots/list": () =>
          new Promise((resolve, reject) => {
            callbacks.push({ resolve, reject });
          }),
      },
      protocolVersion: () => "2025-11-25",
      closed: () => lifetime.signal.aborted,
      fail: async (error) => {
        throw error;
      },
      send: async (message) => {
        replies.push(message);
      },
    });
    try {
      for (let id = 1; id <= 16; id++) {
        const response = input.receive({
          jsonrpc: "2.0",
          id,
          method: "roots/list",
        });
        assert.equal(callbacks.length, id);
        input.cancel(id);
        await response;
        assert.match(
          String(replies.at(-1)?.error?.message),
          /Server cancelled client input/,
        );
      }
      await input.receive({ jsonrpc: "2.0", id: 17, method: "roots/list" });
      assert.equal(callbacks.length, 16);
      assert.match(
        String(replies.at(-1)?.error?.message),
        /Too many concurrent client input handlers/,
      );
      // MRTR and task callbacks enter handleInput directly and share the bound.
      await assert.rejects(
        input.handleInput(
          "roots/list",
          {},
          {
            requestId: 18,
            method: "",
            params: {},
            signal: lifetime.signal,
          },
        ),
        /Too many concurrent client input handlers/,
      );
      if (lateFailure) callbacks[0].reject(new Error("late handler failure"));
      else callbacks[0].resolve({ roots: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const accepted = input.receive({
        jsonrpc: "2.0",
        id: 19,
        method: "roots/list",
      });
      assert.equal(callbacks.length, 17);
      input.cancel(19);
      await accepted;
      // A cancelled RPC already received its only response; late settlement
      // releases capacity without sending a second reply or updating state.
      assert.equal(replies.length, 18);
    } finally {
      lifetime.abort();
      for (const callback of callbacks) callback.resolve({ roots: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}

test("synchronously throwing MCP handlers release their admission", async () => {
  const input = new MCPClientInput({
    pending: new Map(),
    taskContexts: new MCPTaskContexts(),
    signal: new AbortController().signal,
    timeout: 1000,
    handlers: {
      "roots/list": () => {
        throw new Error("synchronous host failure");
      },
    },
    protocolVersion: () => "2025-11-25",
    closed: () => false,
    fail: async (error) => {
      throw error;
    },
    send: async () => {},
  });
  for (let id = 0; id < 20; id++)
    await assert.rejects(
      input.handleInput(
        "roots/list",
        {},
        {
          requestId: id,
          method: "",
          params: {},
          signal: new AbortController().signal,
        },
      ),
      /synchronous host failure/,
    );
});
