import { wireMember } from "../src/core/wire.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Approval } from "../src/contracts.js";
import { setup, collect, until } from "./support/wire-server.js";

async function nativeSetup(...args: Parameters<typeof setup>) {
  const x = await setup(...args);
  x.config.routes.text.adapter = "openai-responses";
  x.config.routes.text.nativeWebSearch = true;
  x.config.permissions.network = "allow";
  return x;
}

function hasSearch(body: unknown) {
  return (
    typeof body === "object" &&
    body !== null &&
    "tools" in body &&
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool: unknown) =>
        typeof tool === "object" &&
        tool !== null &&
        "type" in tool &&
        tool.type === "web_search",
    )
  );
}

test("native search honors host, route, project, mode, agent, ancestor and planning restrictions", async () => {
  for (const restriction of [
    "allow",
    "host",
    "route-policy",
    "route-allowlist",
    "project",
    "mode",
    "agent",
    "ancestor",
    "plan",
  ]) {
    const x = await nativeSetup();
    try {
      if (restriction === "host") x.config.permissions.network = "deny";
      if (restriction === "route-policy")
        x.config.routes.text.capabilityPolicies.network = "deny";
      if (restriction === "route-allowlist")
        x.config.routes.text.toolAllowlist = ["file_read"];
      if (restriction === "project")
        x.kernel.store.put("policies", {
          id: "deny-search",
          projectId: x.project.id,
          capabilities: ["network"],
          tools: ["web_search"],
          effect: "deny",
        });
      let s;
      if (restriction === "mode") {
        x.kernel.modes.put({
          id: "local",
          description: "Local research only",
          instructions: "Use local material",
          capabilityPolicies: { network: "deny" },
        });
        s = x.kernel.createSession(x.project.id, "local");
      } else if (restriction === "agent" || restriction === "ancestor") {
        x.kernel.agents.put({
          id: "local-agent",
          name: "Local agent",
          mode: "chat",
          instructions: "Use local material",
          toolAllowlist: ["memory_search"],
        });
        const parent = x.kernel.createSession(
          x.project.id,
          "chat",
          undefined,
          undefined,
          "local-agent",
        );
        s = restriction === "agent" ? parent : await x.session();
        if (restriction === "ancestor")
          s = x.kernel.store.put("sessions", {
            ...s,
            parentSessionId: parent.id,
          });
      } else s = await x.session();
      if (restriction === "plan")
        x.kernel.updateSession(s.id, { autonomy: "plan" });
      const { runId } = await x.client.submit(s.id, {
        text: "Find current facts",
      });
      const events = await collect(x.client, runId);
      assert.equal(
        (await x.kernel.wait(runId)).status,
        "completed",
        restriction,
      );
      assert.equal(x.wire.requests.length, 1, restriction);
      assert.equal(
        hasSearch(x.wire.requests[0].body),
        restriction === "allow",
        restriction,
      );
      assert.equal(
        events.some(
          (event) => event.type === "model.native-web-search.disabled",
        ),
        restriction !== "allow",
        restriction,
      );
    } finally {
      await x.close();
    }
  }
});

test("native search waits for approval before HTTP and handles approval, refusal and cancellation", async () => {
  for (const action of ["approve", "refuse", "cancel"]) {
    const x = await nativeSetup();
    try {
      x.config.permissions.network = "ask";
      const s = await x.session();
      const { runId } = await x.client.submit(s.id, {
        text: "Search with permission",
      });
      const approval = await until(
        () =>
          x.kernel.store.list<Approval>("approvals", {
            runId,
            status: "pending",
          })[0],
      );
      assert.equal(approval.tool, "web_search");
      assert.equal(wireMember(approval, "args", "native"), true);
      assert.equal(x.wire.requests.length, 0);
      if (action === "cancel") x.kernel.cancel(runId);
      else x.kernel.permissions.resolve(approval.id, action === "approve");
      const events = await collect(x.client, runId);
      assert.equal(
        (await x.kernel.wait(runId)).status,
        action === "cancel" ? "cancelled" : "completed",
      );
      assert.equal(x.wire.requests.length, action === "cancel" ? 0 : 1);
      if (action !== "cancel")
        assert.equal(hasSearch(x.wire.requests[0].body), action === "approve");
      if (action === "refuse")
        assert.ok(
          events.some(
            (event) => event.type === "model.native-web-search.disabled",
          ),
        );
    } finally {
      await x.close();
    }
  }
});

test("approval cannot restore native search after permission is revoked while waiting", async () => {
  const x = await nativeSetup();
  try {
    x.config.permissions.network = "ask";
    const s = await x.session();
    const { runId } = await x.client.submit(s.id, {
      text: "Search after approval",
    });
    const approval = await until(
      () =>
        x.kernel.store.list<Approval>("approvals", {
          runId,
          status: "pending",
        })[0],
    );
    x.config.permissions.network = "deny";
    x.kernel.permissions.resolve(approval.id, true);
    const events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.equal(hasSearch(x.wire.requests[0].body), false);
    assert.ok(
      events.some((event) => event.type === "model.native-web-search.disabled"),
    );
  } finally {
    await x.close();
  }
});

test("native search combines primary and fallback policies using the actual route capability", async () => {
  for (const restriction of [
    "none",
    "primary",
    "fallback",
    "unsupported-primary",
  ]) {
    const x = await nativeSetup((_body, index) =>
      index === 0 ? { status: 503 } : { text: "fallback answer" },
    );
    try {
      x.config.routes.secondary = {
        ...x.config.routes.text,
        model: "fallback-model",
        capabilityPolicies:
          restriction === "fallback" ? { network: "deny" } : {},
        fallbackRouteIds: [],
      };
      x.config.routes.text.fallbackRouteIds = ["secondary"];
      if (restriction === "primary")
        x.config.routes.text.capabilityPolicies.network = "deny";
      if (restriction === "unsupported-primary")
        x.config.routes.text.nativeWebSearch = false;
      const s = await x.session();
      const { runId } = await x.client.submit(s.id, {
        text: "Search using an available model",
      });
      await collect(x.client, runId);
      assert.equal(
        (await x.kernel.wait(runId)).status,
        "completed",
        restriction,
      );
      assert.equal(x.wire.requests.length, 2, restriction);
      assert.equal(x.wire.requests[1].body.model, "fallback-model");
      assert.equal(
        hasSearch(x.wire.requests[1].body),
        restriction === "none" || restriction === "unsupported-primary",
        restriction,
      );
    } finally {
      await x.close();
    }
  }
});

test("a retry rechecks native search policies before the next HTTP attempt", async () => {
  let revoke: (() => void) | undefined;
  const x = await nativeSetup((_body, index) => {
    if (index !== 0) return { text: "answer without search" };
    revoke?.();
    return { status: 503 };
  });
  try {
    x.config.routes.text.retry = {
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 5,
    };
    revoke = () => {
      x.config.permissions.network = "deny";
    };
    const s = await x.session();
    const { runId } = await x.client.submit(s.id, {
      text: "Search before retry",
    });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.equal(x.wire.requests.length, 2);
    assert.equal(hasSearch(x.wire.requests[0].body), true);
    assert.equal(hasSearch(x.wire.requests[1].body), false);
  } finally {
    await x.close();
  }
});

test("native search obeys integration authorization and does not swallow unrelated failures", async () => {
  for (const action of ["deny", "error"]) {
    let checked = false;
    const x = await nativeSetup(
      undefined,
      {},
      {
        integrations: [
          {
            id: "native-network-policy",
            authorize: (_context, tool, args) => {
              if (tool.name !== "web_search" || args.native !== true) return;
              checked = true;
              if (action === "error")
                throw new Error("integration unavailable");
              return {
                ...tool,
                capabilities: [...(tool.capabilities || []), "files.write"],
              };
            },
          },
        ],
      },
    );
    try {
      x.config.permissions["files.write"] = "deny";
      const s = await x.session();
      const { runId } = await x.client.submit(s.id, {
        text: "Search through policy",
      });
      await collect(x.client, runId);
      assert.equal(checked, true);
      assert.equal(
        (await x.kernel.wait(runId)).status,
        action === "deny" ? "completed" : "failed",
      );
      assert.equal(x.wire.requests.length, action === "deny" ? 1 : 0);
      if (action === "deny")
        assert.equal(hasSearch(x.wire.requests[0].body), false);
    } finally {
      await x.close();
    }
  }
});

test("native search is security audited before the HTTP request", async () => {
  const x = await nativeSetup(undefined, {
    securityAudit: {
      mode: "enforce",
      promptInjection: "off",
      textRules: [
        {
          id: "deny-native",
          terms: ["native"],
          stages: ["tool"],
          action: "deny",
        },
      ],
    },
  });
  try {
    const s = await x.session();
    const { runId } = await x.client.submit(s.id, {
      text: "Find current facts",
    });
    const events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "failed");
    assert.equal(x.wire.requests.length, 0);
    assert.ok(
      events.some(
        (event) =>
          event.type === "security.audit" && event.data.decision === "deny",
      ),
    );
  } finally {
    await x.close();
  }
});

test("internal compaction and memory extraction do not inherit native search capability", async () => {
  const x = await nativeSetup((body, index) => {
    if (index === 2)
      return {
        status: 400,
        error: {
          code: "context_length_exceeded",
          message: "maximum context length",
        },
      };
    if (body.model === "internal-model")
      return {
        text: JSON.stringify(body.input).includes("Extract only explicit")
          ? '{"memories":[]}'
          : "Retain original goals and verified evidence.",
      };
    return { text: "done" };
  });
  try {
    x.config.routes.internal = {
      ...x.config.routes.text,
      model: "internal-model",
    };
    x.config.defaultRoutes.compact = "internal";
    const s = await x.session();
    for (const text of [
      "first instruction",
      "second instruction",
      "third instruction",
    ])
      await collect(x.client, (await x.client.submit(s.id, { text })).runId);
    x.config.memory.autoExtract = true;
    const { runId } = await x.client.submit(s.id, {
      text: "final instruction",
    });
    await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    const internal = x.wire.requests.filter(
      (request) => request.body.model === "internal-model",
    );
    assert.ok(internal.length >= 2);
    assert.ok(internal.every((request) => !hasSearch(request.body)));
    assert.ok(
      internal.some((request) =>
        JSON.stringify(request.body.input).includes("Summarize untrusted"),
      ),
    );
    assert.ok(
      internal.some((request) =>
        JSON.stringify(request.body.input).includes("Extract only explicit"),
      ),
    );
  } finally {
    await x.close();
  }
});
