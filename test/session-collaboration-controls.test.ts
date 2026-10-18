import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until } from "./support/wire-server.js";
import { makeTools } from "../src/tools/index.js";
import { applyReasoning } from "../src/providers/reasoning.js";
import type { Session } from "../src/contracts.js";
import type { ModelRequest } from "../src/runtime/types.js";

test("session subagent toggle and inherited agent settings reach actual model requests", async () => {
  const x = await setup((body) => {
    const text = JSON.stringify(body.messages);
    if (text.includes("PARENT INHERIT") && !text.includes('"role":"tool"'))
      return {
        calls: [
          {
            name: "agent_delegate",
            args: { description: "inherit", prompt: "CHILD INHERIT" },
          },
        ],
      };
    return { text: "completed" };
  });
  try {
    x.kernel.agents.put({
      id: "custom",
      name: "自定义",
      mode: "code",
      instructions: "SHARED RESPONSIBILITY",
      reasoningEffort: "high",
    });
    const parent = await x.client.session(x.project.id, "code", undefined, {
      agentId: "custom",
    });
    const run = await x.client.submit(parent.id, { text: "PARENT INHERIT" });
    assert.equal((await x.kernel.wait(run.runId)).status, "completed");
    const child = x.kernel.store
      .list<Session>("sessions")
      .find((s) => s.parentSessionId === parent.id);
    assert.ok(child);
    assert.equal(child.agentId, "custom");
    assert.equal(child.reasoningEffort, "high");
    const childRequest = x.wire.requests.find((r) =>
      JSON.stringify(r.body.messages).includes("CHILD INHERIT"),
    );
    assert.ok(childRequest);
    assert.equal(childRequest.body.reasoning_effort, "high");
    assert.match(
      JSON.stringify(childRequest.body.messages),
      /SHARED RESPONSIBILITY/,
    );
    const disabled = await x.client.session(x.project.id, "office", undefined, {
      subagentsEnabled: false,
    });
    const tools = await makeTools({
      kernel: x.kernel,
      session: disabled,
      runId: "unused",
      routeId: disabled.routeId,
    });
    assert.ok(!tools.some((t) => t.name === "agent_delegate"));
  } finally {
    await x.close();
  }
});

test("delegated sessions cannot exceed their parent's tool or model policies", async () => {
  const x = await setup();
  try {
    x.kernel.agents.put({
      id: "parent",
      name: "只读",
      mode: "code",
      instructions: "read",
      toolAllowlist: ["file_read", "agent_delegate"],
    });
    x.kernel.agents.put({
      id: "child",
      name: "写入",
      mode: "code",
      instructions: "write",
    });
    const parent = x.kernel.createSession(
      x.project.id,
      "code",
      "parent",
      undefined,
      "parent",
    );
    const child = x.kernel.store.put("sessions", {
      ...x.kernel.createSession(
        x.project.id,
        "code",
        "child",
        undefined,
        "child",
      ),
      parentSessionId: parent.id,
    });
    const tools = await makeTools({
      kernel: x.kernel,
      session: child,
      routeId: child.routeId,
      runId: "unused",
    });
    const write = tools.find((t) => t.name === "file_write");
    assert.ok(write);
    assert.equal(
      x.kernel.permissions.evaluate(child, child.routeId, write).effect,
      "deny",
    );
  } finally {
    await x.close();
  }
});

test("fork records source and settings, and explicit conversation grants stay within a project", async () => {
  const x = await setup();
  try {
    const source = await x.session("code");
    x.kernel.updateSession(source.id, {
      subagentsEnabled: false,
      reasoningEffort: "low",
    });
    const submitted = await x.client.submit(source.id, {
      text: "source evidence",
    });
    await x.kernel.wait(submitted.runId);
    const messages = x.kernel.store.transcript(source.id);
    const branch = await x.client.forkSession(source.id, messages.at(-1)?.id);
    assert.equal(branch.forkedFromSessionId, source.id);
    assert.equal(branch.forkedThroughMessageId, messages.at(-1)?.id);
    assert.equal(branch.autonomy, "autonomous");
    assert.equal(branch.subagentsEnabled, false);
    assert.equal(branch.reasoningEffort, "low");
    assert.equal(
      (await x.client.sessionBranches(branch.id)).branches.length,
      2,
    );
    const reader = await x.session("code");
    const toolFor = async () =>
      (
        await makeTools({
          kernel: x.kernel,
          session: x.kernel.store.session(reader.id),
          routeId: reader.routeId,
          runId: "unused",
        })
      ).find((t) => t.name === "session_read");
    await assert.rejects(
      () =>
        toolFor().then((tool) => {
          assert.ok(tool);
          return tool.execute("denied", { sessionId: source.id });
        }),
      /reading grants/,
    );
    const attached = await x.client.submit(reader.id, {
      text: "read referenced conversation",
      contextSessionIds: [source.id],
    });
    await x.kernel.wait(attached.runId);
    const tool = await toolFor();
    assert.ok(tool);
    const result = await tool.execute("read", { sessionId: source.id });
    assert.match(JSON.stringify(result), /source evidence/);
    const otherProject = await x.kernel.createProject("other");
    const unrelated = x.kernel.createSession(otherProject.id);
    await assert.rejects(
      () =>
        x.kernel.submit(reader.id, {
          text: "cross project",
          contextSessionIds: [unrelated.id],
        }),
      /another project/,
    );
  } finally {
    await x.close();
  }
});

test("reasoning adapter uses explicit levels and refuses incompatible settings", async () => {
  const x = await setup();
  try {
    const route = x.config.routes.text;
    const request: ModelRequest = { routeId: "text", messages: [], tools: [] };
    const completions: Record<string, unknown> = {};
    applyReasoning(
      completions,
      {
        ...route,
        reasoningEffort: "high",
        supportedReasoningEfforts: ["high", "none"],
      },
      request,
      4096,
    );
    assert.equal(completions.reasoning_effort, "high");
    const disabled: Record<string, unknown> = { reasoning_effort: "high" };
    applyReasoning(
      disabled,
      { ...route, compat: { supportsReasoningEffort: false } },
      { ...request, reasoningEffort: "none" },
      4096,
    );
    assert.ok(!Object.hasOwn(disabled, "reasoning_effort"));
    assert.throws(
      () =>
        applyReasoning(
          {},
          { ...route, supportedReasoningEfforts: ["low"] },
          { ...request, reasoningEffort: "high" },
          4096,
        ),
      /does not support/,
    );
    const responses: Record<string, unknown> = {};
    applyReasoning(
      responses,
      { ...route, adapter: "openai-responses" },
      { ...request, reasoningEffort: "xhigh" },
      4096,
    );
    assert.deepEqual(responses.reasoning, { effort: "xhigh", summary: "auto" });
    const anthropic: Record<string, unknown> = {};
    applyReasoning(
      anthropic,
      { ...route, adapter: "anthropic-messages", reasoningBudgetTokens: 2048 },
      request,
      4096,
    );
    assert.deepEqual(anthropic.thinking, {
      type: "enabled",
      budget_tokens: 2048,
    });
    assert.throws(
      () =>
        applyReasoning(
          {},
          { ...route, adapter: "anthropic-messages" },
          { ...request, reasoningEffort: "high" },
          4096,
        ),
      /requires reasoningBudgetTokens/,
    );
  } finally {
    await x.close();
  }
});

test("references attached by steering are readable in the same live run", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let targetId = "",
    step = 0;
  const x = await setup(async () => {
    step++;
    if (step === 1) {
      await gate;
      return { text: "continue after input" };
    }
    if (step === 2)
      return {
        calls: [{ name: "session_read", args: { sessionId: targetId } }],
      };
    return { text: "read complete" };
  });
  try {
    const source = await x.session("code"),
      reader = await x.session("code");
    targetId = source.id;
    x.kernel.store.appendTranscript(source.id, {
      id: "source-message",
      runId: "old",
      message: {
        role: "user",
        content: "LIVE REFERENCE EVIDENCE",
        timestamp: Date.now(),
      },
    });
    const run = await x.client.submit(reader.id, {
      text: "start reading task",
    });
    await until(() => x.wire.requests.length > 0);
    await x.client.submit(reader.id, {
      text: "attach this conversation and continue",
      delivery: "steer",
      contextSessionIds: [source.id],
    });
    release();
    assert.equal((await x.kernel.wait(run.runId)).status, "completed");
    const result = x.kernel.store
      .transcript(reader.id)
      .find(
        (item) =>
          item.message.role === "toolResult" &&
          item.message.toolName === "session_read",
      );
    assert.ok(result && result.message.role === "toolResult");
    assert.equal(result.message.isError, false);
    assert.match(
      JSON.stringify(result.message.content),
      /LIVE REFERENCE EVIDENCE/,
    );
  } finally {
    release();
    await x.close();
  }
});

test("team settings and explicit user role decisions use the authenticated HTTP API", async () => {
  const x = await setup();
  try {
    for (const agentId of ["coordinator", "executor"])
      x.kernel.agents.put({
        id: agentId,
        name: agentId,
        mode: "code",
        instructions: agentId,
      });
    const team = {
      id: "api-team",
      name: "API team",
      mode: "code" as const,
      coordinatorAgentId: "coordinator",
      memberAgentIds: ["executor"],
    };
    await x.client.putTeam(team);
    assert.equal((await x.client.teams()).teams[0].id, team.id);
    const session = await x.session("code");
    const bound = await x.client.configureCollaboration(session.id, {
      teamId: team.id,
      kind: "task",
      goal: "API task",
    });
    assert.equal(bound.agentId, "coordinator");
    assert.ok(bound.collaboration);
    x.kernel.store.put("sessions", {
      ...bound,
      collaboration: {
        ...bound.collaboration,
        roleReview: {
          status: "needs_user",
          roles: [],
          gaps: [],
          rationale: "test pending state",
          revision: bound.collaboration.revision,
        },
      },
    });
    const resolved = await x.client.resolveTeamRoles(
      session.id,
      "redistribute",
    );
    assert.equal(resolved.collaboration?.roleReview?.status, "awaiting_review");
    const detached = await x.client.configureCollaboration(session.id, null);
    assert.equal(detached.collaboration, undefined);
    await x.client.request("DELETE", `/v1/teams/${team.id}`);
    assert.equal((await x.client.teams()).teams.length, 0);
    const unauthenticated = await fetch(x.api.url + "/v1/teams");
    assert.equal(unauthenticated.status, 401);
  } finally {
    await x.close();
  }
});
