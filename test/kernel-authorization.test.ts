import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  filterModelContext,
  resolveToolPolicy,
} from "../src/core/kernel/authorization.js";
import type { Session } from "../src/contracts.js";
import type { Permissions } from "../src/core/permissions.js";
import type { Message, ToolDefinition } from "../src/runtime/types.js";
import { setup } from "./support/wire-server.js";

const tool: ToolDefinition = {
  name: "memory_search",
  description: "Search project memory",
  parameters: { type: "object" },
  risk: "read",
  capabilities: ["memory.read"],
  source: { kind: "builtin", id: "foundation" },
  execute: async () => ({ content: [] }),
};

const session: Session = {
  id: "session",
  projectId: "project",
  name: "test",
  mode: "chat",
  routeId: "primary",
  createdAt: "2026-10-18T00:00:00.000Z",
};

test("model context checks each route once per request and immediately observes policy changes", () => {
  const calls: string[] = [];
  const denied = new Set<string>();
  const permissions: Pick<Permissions, "evaluate"> = {
    evaluate(_session, routeId) {
      calls.push(routeId);
      return { effect: denied.has(routeId) ? "deny" : "allow", reasons: [] };
    },
  };
  const publicMessages: Message[] = [
    { role: "system", content: "instructions", timestamp: 1 },
    { role: "user", content: "hello", timestamp: 2 },
  ];
  const messages: Message[] = [
    ...publicMessages,
    ...Array.from({ length: 100 }, (_, i): Message => ({
      role: "system",
      content: String(i),
      timestamp: i,
      requiredCapabilities: ["memory.read", "memory.read"],
    })),
    {
      role: "system",
      content: "unsupported capability",
      timestamp: 3,
      requiredCapabilities: ["exec"],
    },
  ];
  assert.equal(
    filterModelContext(permissions, session, "primary", messages, [tool])
      .length,
    102,
  );
  assert.deepEqual(calls, ["primary"]);
  calls.length = 0;
  assert.equal(
    filterModelContext(permissions, session, "fallback", messages, [tool])
      .length,
    102,
  );
  assert.deepEqual(calls, ["primary", "fallback"]);
  denied.add("fallback");
  assert.deepEqual(
    filterModelContext(permissions, session, "fallback", messages, [tool]),
    publicMessages,
  );
  denied.clear();
  assert.equal(
    filterModelContext(permissions, session, "fallback", messages, [tool])
      .length,
    102,
  );
  assert.deepEqual(
    filterModelContext(permissions, session, "primary", messages, []),
    publicMessages,
  );
});

test("model and process authorization preserve original execution and cumulative restrictions", async () => {
  let calls = 0;
  const x = await setup(
    undefined,
    {},
    {
      integrations: [
        {
          id: "raise-risk",
          authorize(_context, current, args) {
            calls++;
            assert.ok(Object.isFrozen(current));
            assert.ok(Object.isFrozen(current.capabilities));
            assert.ok(Object.isFrozen(args));
            assert.ok(Object.isFrozen(args.nested));
            return {
              ...current,
              risk: "control",
              capabilities: ["network"],
              source: { kind: "plugin", id: "replacement" },
              parameters: {},
              execute: async () => {
                throw new Error("replaced");
              },
            };
          },
        },
        {
          id: "attempt-downgrade",
          authorize(_context, current) {
            assert.equal(current.execute, tool.execute);
            assert.equal(current.parameters, tool.parameters);
            assert.equal(current.source, tool.source);
            assert.equal(current.risk, "control");
            assert.deepEqual(current.capabilities, ["memory.read", "network"]);
            return { ...current, risk: "read", capabilities: [] };
          },
        },
      ],
    },
  );
  try {
    const actualSession = await x.session();
    const context = {
      kernel: x.kernel,
      session: actualSession,
      runId: "authorization-test",
      routeId: "text",
    };
    const args = { nested: { value: 1 } };
    for (const origin of ["model", "control"] as const) {
      const resolved = await resolveToolPolicy(
        context,
        tool,
        args,
        new AbortController().signal,
        origin,
      );
      assert.equal(resolved.risk, "control");
      assert.deepEqual(resolved.capabilities, ["memory.read", "network"]);
      assert.equal(resolved.execute, tool.execute);
      assert.equal(resolved.parameters, tool.parameters);
      assert.equal(resolved.source, tool.source);
    }
    assert.equal(calls, 2);
    assert.equal(
      Object.isFrozen(args),
      false,
      "caller-owned arguments stay writable",
    );
    assert.deepEqual(args, { nested: { value: 1 } });
    await assert.rejects(
      resolveToolPolicy(context, tool, null, new AbortController().signal),
      /must be an object/,
    );
  } finally {
    await x.close();
    await rm(x.root, { recursive: true, force: true });
  }
});

test("authorization hooks reject changed identities and abort uncooperative hook promises", async () => {
  let hang = false;
  const x = await setup(
    undefined,
    {},
    {
      integrations: [
        {
          id: "invalid-hook",
          authorize(_context, current) {
            return hang
              ? new Promise(() => {})
              : { ...current, name: "renamed" };
          },
        },
      ],
    },
  );
  try {
    const actualSession = await x.session();
    const context = {
      kernel: x.kernel,
      session: actualSession,
      runId: "invalid-test",
      routeId: "text",
    };
    await assert.rejects(
      resolveToolPolicy(context, tool, {}, new AbortController().signal),
      /Invalid authorization/,
    );
    await assert.rejects(
      resolveToolPolicy(
        context,
        tool,
        {},
        new AbortController().signal,
        "control",
      ),
      /Invalid control authorization/,
    );
    hang = true;
    const controller = new AbortController();
    const pending = resolveToolPolicy(context, tool, {}, controller.signal);
    controller.abort(new Error("test cancelled"));
    await assert.rejects(pending, /test cancelled/);
  } finally {
    await x.close();
    await rm(x.root, { recursive: true, force: true });
  }
});

test("cached process validators still validate every call and controls retain their own session", async () => {
  const x = await setup();
  try {
    for (const current of [await x.session("code"), await x.session("code")]) {
      assert.throws(
        () => x.kernel.processAction(current.id, "stop", {}),
        /Invalid process arguments/,
      );
      const listing = x.kernel.processAction(current.id, "list", {});
      const completed = await x.kernel.wait(listing.runId);
      assert.equal(completed.status, "completed");
      assert.equal(completed.sessionId, current.id);
      const missing = x.kernel.processAction(current.id, "stop", {
        processId: "not-present",
      });
      assert.equal((await x.kernel.wait(missing.runId)).status, "failed");
      assert.throws(
        () => x.kernel.processAction(current.id, "stop", {}),
        /Invalid process arguments/,
      );
    }
  } finally {
    await x.close();
    await rm(x.root, { recursive: true, force: true });
  }
});
