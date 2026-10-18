import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Session } from "../src/contracts.js";
import type { ToolContext } from "../src/runtime/registry.js";
import { textOf } from "../src/runtime/types.js";
import type { TeamTask, TeamRoleGap } from "../src/collaboration/types.js";
import { setup, until, type Reply } from "./support/wire-server.js";

type Fixture = Awaited<ReturnType<typeof setup>>;
const requestSchema = z
  .object({
    model: z.string(),
    messages: z.array(z.unknown()),
    tools: z
      .array(
        z
          .object({ function: z.object({ name: z.string() }).passthrough() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const request = (body: unknown) => requestSchema.parse(body);
const transcript = (body: unknown) => JSON.stringify(request(body).messages);
const names = (body: unknown) =>
  request(body).tools?.map((tool) => tool.function.name) || [];
const tasks = (x: Fixture) => x.kernel.store.list<TeamTask>("team-tasks");
const reviewedRoles = [
  {
    agentId: "coordinator",
    optimizedResponsibility:
      "Clarify the current bounded goal, coordinate assignments and verify acceptance.",
  },
  {
    agentId: "member-a",
    optimizedResponsibility:
      "Implement the assigned part within its declared write scope and report actual checks.",
  },
  {
    agentId: "member-b",
    optimizedResponsibility:
      "Independently review evidence and discuss unresolved assumptions.",
  },
];
const blockingApprovalGap: TeamRoleGap = {
  responsibility: "Independent production approval",
  reason:
    "The user explicitly requires an authorized independent approval; no configured agent currently has that authority.",
  blocking: true,
  attemptedAssignments: [
    {
      agentId: "coordinator",
      reason:
        "The coordinator cannot approve the work it commissions under the user's explicit separation rule.",
    },
    {
      agentId: "member-a",
      reason: "The implementer cannot approve its own production changes.",
    },
    {
      agentId: "member-b",
      reason:
        "The reviewer lacks the production approval authority required by the user.",
    },
  ],
};
type ProtocolResponder = (
  body: unknown,
  index: number,
) => Reply | Promise<Reply>;
function withRoleReview(respond: ProtocolResponder): ProtocolResponder {
  let reviewed = false;
  return (body, index) => {
    const parsed = request(body);
    if (parsed.model !== "coordinator-model") return respond(body, index);
    if (!reviewed) {
      reviewed = true;
      return {
        calls: [
          {
            name: "team_review_roles",
            args: {
              roles: reviewedRoles,
              gaps: [],
              rationale:
                "The complete roster covers coordination, implementation and independent review for the bounded task.",
            },
          },
        ],
      };
    }
    const reviewCallIds = new Set<string>();
    const callMessage = z
      .object({
        role: z.literal("assistant"),
        tool_calls: z.array(
          z
            .object({
              id: z.string(),
              function: z.object({ name: z.string() }).passthrough(),
            })
            .passthrough(),
        ),
      })
      .passthrough();
    for (const message of parsed.messages) {
      const decoded = callMessage.safeParse(message);
      if (decoded.success)
        for (const call of decoded.data.tool_calls)
          if (call.function.name === "team_review_roles")
            reviewCallIds.add(call.id);
    }
    const messages = parsed.messages.filter((message) => {
      const calls = callMessage.safeParse(message);
      if (
        calls.success &&
        calls.data.tool_calls.some(
          (call) => call.function.name === "team_review_roles",
        )
      )
        return false;
      const result = z
        .object({ role: z.literal("tool"), tool_call_id: z.string() })
        .passthrough()
        .safeParse(message);
      return !result.success || !reviewCallIds.has(result.data.tool_call_id);
    });
    return respond({ ...parsed, messages }, index);
  };
}

async function installTeam(x: Fixture, mode: "code" | "office" = "code") {
  await x.kernel.updateRoutes({
    set: {
      coordinator: { ...x.config.routes.text, model: "coordinator-model" },
      memberA: { ...x.config.routes.text, model: "member-a-model" },
      memberB: { ...x.config.routes.text, model: "member-b-model" },
    },
  });
  for (const [agentId, routeId, responsibility] of [
    [
      "coordinator",
      "coordinator",
      "Coordinate the user's work and collect revisions.",
    ],
    [
      "member-a",
      "memberA",
      "Original responsibility: implement assigned code carefully.",
    ],
    [
      "member-b",
      "memberB",
      "Original responsibility: independently review evidence.",
    ],
  ])
    x.kernel.agents.put({
      id: agentId,
      name: agentId,
      routeId,
      instructions: responsibility,
      mode,
    });
  x.kernel.teams.put({
    id: "team-one",
    name: "Collaborators",
    mode,
    coordinatorAgentId: "coordinator",
    memberAgentIds: ["member-a", "member-b"],
  });
  const session = await x.session(mode);
  return x.kernel.teams.configure(session.id, {
    teamId: "team-one",
    kind: "task",
    goal: "Deliver the user's bounded goal",
    constraints: ["Preserve other contributors' changes"],
    acceptance: ["Report actual evidence"],
    maxTurns: 6,
  });
}
function context(x: Fixture, session: Session, runId: string): ToolContext {
  return { kernel: x.kernel, session, runId, routeId: session.routeId };
}

test("collaboration coordinates distinct models in one workspace without occupying the only tool slot", async () => {
  const x = await setup(
    withRoleReview((body) => {
      const model = request(body).model;
      if (model === "coordinator-model")
        return transcript(body).includes('"role":"tool"')
          ? { text: "Merged evidence from both members for the user." }
          : {
              calls: [
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-a",
                    prompt: "Write the assigned proof file",
                    refinedResponsibility:
                      "Implement and verify the proof file only",
                    scope: ["proof.txt"],
                    deliverable: "Proof file and verification",
                  },
                },
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-b",
                    prompt: "Review the plan independently",
                    scope: [],
                    deliverable: "Review with assumptions",
                  },
                },
              ],
            };
      if (model === "member-a-model")
        return transcript(body).includes('"role":"tool"')
          ? { text: "Member A wrote and verified proof.txt." }
          : {
              calls: [
                {
                  name: "file_write",
                  args: { path: "proof.txt", content: "verified by member A" },
                },
              ],
            };
      return { text: "Member B reviewed the assumptions.", delayMs: 100 };
    }),
    { limits: { maxConcurrentTools: 1, maxAgentDepth: 0 } },
  );
  try {
    const session = await installTeam(x);
    const reference = await x.session("code");
    x.kernel.updateSession(session.id, { readableSessionIds: [reference.id] });
    const { runId } = await x.client.submit(session.id, {
      text: "Please complete this bounded request",
    });
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.equal(tasks(x).length, 2);
    assert.ok(tasks(x).every((task) => task.status === "completed"));
    const rootRequests = x.wire.requests.filter(
      (item) => request(item.body).model === "coordinator-model",
    );
    assert.match(
      transcript(rootRequests.at(-1)?.body),
      /Member A wrote and verified/,
    );
    assert.match(transcript(rootRequests.at(-1)?.body), /Member B reviewed/);
    for (const childRequest of x.wire.requests.filter(
      (item) => request(item.body).model !== "coordinator-model",
    )) {
      assert.ok(!names(childRequest.body).includes("team_dispatch"));
      assert.ok(!names(childRequest.body).includes("agent_delegate"));
    }
    for (const task of tasks(x)) {
      const child = x.kernel.store.session(task.sessionId);
      assert.equal(child.projectId, session.projectId);
      assert.equal(child.parentSessionId, session.id);
      assert.equal(child.teamRootSessionId, session.id);
      assert.equal(child.subagentsEnabled, false);
      assert.equal(child.autonomy, "autonomous");
      assert.equal(child.delegationDepth, 1);
      assert.deepEqual(child.readableSessionIds, [reference.id]);
      assert.equal(
        child.routeId,
        task.memberAgentId === "member-a" ? "memberA" : "memberB",
      );
    }
    const implementation = tasks(x).find(
      (task) => task.memberAgentId === "member-a",
    );
    assert.equal(
      implementation?.refinedResponsibility,
      "Implement and verify the proof file only",
    );
    assert.equal(
      implementation?.declaredResponsibility,
      x.kernel.agents.get("member-a").instructions,
    );
    const memberARequest = x.wire.requests.find(
      (item) => request(item.body).model === "member-a-model",
    );
    assert.ok(
      !transcript(memberARequest?.body).includes(
        x.kernel.agents.get("member-b").instructions,
      ),
      "A member context must not repeat other members' original responsibilities",
    );
    const compactStatus = await x.kernel.teams.status(
      context(x, session, runId),
      {},
    );
    const summary = z
      .object({ tasks: z.array(z.record(z.string(), z.unknown())) })
      .parse(compactStatus);
    assert.ok(
      summary.tasks.every(
        (task) => !("binding" in task) && !("declaredResponsibility" in task),
      ),
      "Bulk status uses task summaries rather than repeating every role snapshot",
    );
    const detail = await x.kernel.teams.status(context(x, session, runId), {
      taskId: implementation?.id,
    });
    assert.equal(
      z
        .object({ task: z.object({ declaredResponsibility: z.string() }) })
        .parse(detail).task.declaredResponsibility,
      implementation?.declaredResponsibility,
    );
    assert.equal(
      tasks(x).find((task) => task.memberAgentId === "member-b")
        ?.refinedResponsibility,
      "Review the plan independently",
    );
    assert.equal(
      await readFile(
        path.join(x.config.workspaceRoots[0], "proof.txt"),
        "utf8",
      ),
      "verified by member A",
    );
  } finally {
    await x.close();
  }
});

test("collaboration can re-review after the latest user explicitly removes blocked work, with exact evidence", async () => {
  const x = await setup((body) =>
    request(body).model === "coordinator-model"
      ? { text: "Waiting for the user's scope decision", delayMs: 10000 }
      : { text: "The local documentation assignment is complete" },
  );
  try {
    const session = await installTeam(x),
      started = await x.client.submit(session.id, {
        text: "Production deployment requires independent approval that the configured agents do not hold.",
      });
    await until(() =>
      x.wire.requests.find(
        (item) => request(item.body).model === "coordinator-model",
      ),
    );
    const ctx = context(x, session, started.runId);
    const blocked = x.kernel.teams.reviewRoles(ctx, {
      roles: reviewedRoles,
      gaps: [blockingApprovalGap],
      rationale:
        "The user's necessary production approval cannot be assigned to the existing authorized roster.",
    });
    assert.equal(blocked.roleReview.status, "needs_user");
    const original = x.kernel.agents.get("member-a").instructions;
    const ordinary = "请继续解释当前问题";
    await x.client.submit(session.id, { text: ordinary, delivery: "steer" });
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles,
          gaps: [],
          rationale: "A normal follow-up cannot remove the blocker.",
        }),
      /user's explicit choice/,
    );
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles,
          gaps: [],
          rationale: "An ordinary question does not cancel production work.",
          scopeChange: {
            userQuote: ordinary,
            reason: "This ordinary question is not a scope reduction.",
            removedResponsibilities: [blockingApprovalGap.responsibility],
          },
        }),
      /ordinary follow-up/,
    );
    const cancellation = "取消生产部署，只生成本地说明文档";
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles,
          gaps: [],
          rationale: "Invented quotation cannot authorize a scope reduction.",
          scopeChange: {
            userQuote: cancellation,
            reason: "The user has not said this.",
            removedResponsibilities: [blockingApprovalGap.responsibility],
          },
        }),
      /latest user input/,
    );
    await x.client.submit(session.id, {
      text: cancellation,
      delivery: "steer",
    });
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles,
          gaps: [],
          rationale:
            "The removed responsibility must exactly cover the old blocker.",
          scopeChange: {
            userQuote: cancellation,
            reason: "The production work was canceled.",
            removedResponsibilities: ["Unrelated responsibility"],
          },
        }),
      /exactly the previously blocking/,
    );
    const reviewed = x.kernel.teams.reviewRoles(ctx, {
      roles: reviewedRoles,
      gaps: [],
      rationale:
        "The user's latest instruction removed production deployment, so independent production approval is no longer necessary for a local document.",
      scopeChange: {
        userQuote: cancellation,
        reason:
          "The user explicitly canceled production deployment and limited the task to a local document.",
        removedResponsibilities: [blockingApprovalGap.responsibility],
      },
    });
    assert.equal(reviewed.roleReview.status, "ready");
    assert.equal(reviewed.roleReview.scopeChange?.userQuote, cancellation);
    assert.equal(
      reviewed.roleReview.scopeChange?.previousReviewRevision,
      blocked.roleReview.revision,
    );
    const result = await x.kernel.teams.dispatch(ctx, {
      agentId: "member-a",
      prompt: "Review the local documentation outline without deploying",
      scope: [],
      deliverable: "Reviewed local documentation outline",
    });
    assert.equal(result.status, "completed");
    assert.equal(x.kernel.agents.get("member-a").instructions, original);
    x.kernel.cancel(started.runId);
    await x.kernel.wait(started.runId);
  } finally {
    await x.close();
  }
});

test("collaboration rejects overlapping active write scopes and a second active assignment for one member", async () => {
  const x = await setup(
    withRoleReview((body) =>
      request(body).model === "coordinator-model"
        ? transcript(body).includes('"role":"tool"')
          ? { text: "Conflict reported to the user." }
          : {
              calls: [
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-a",
                    prompt: "Own src",
                    scope: ["src"],
                    deliverable: "Changes",
                    wait: false,
                  },
                },
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-b",
                    prompt: "Own a nested file",
                    scope: ["src/main.ts"],
                    deliverable: "Changes",
                    wait: false,
                  },
                },
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-a",
                    prompt: "Another task",
                    scope: ["other"],
                    deliverable: "Changes",
                    wait: false,
                  },
                },
              ],
            }
        : { text: "Delayed member output", delayMs: 1500 },
    ),
  );
  try {
    const session = await installTeam(x),
      { runId } = await x.client.submit(session.id, {
        text: "Check shared ownership",
      });
    await x.kernel.wait(runId);
    assert.equal(tasks(x).length, 1);
    const stored = JSON.stringify(x.kernel.store.transcript(session.id));
    assert.match(stored, /Write scope overlaps active team task/);
    assert.match(stored, /already has an active task/);
  } finally {
    await x.close();
  }
});

test("collaboration bounds dispatches per run and lets later user rounds reuse member sessions", async () => {
  let coordinatorRequests = 0;
  const x = await setup(
    withRoleReview((body) => {
      if (request(body).model !== "coordinator-model")
        return { text: "Member round done" };
      coordinatorRequests++;
      return coordinatorRequests % 2 === 0
        ? { text: "Round concluded" }
        : {
            calls: [
              {
                name: "team_dispatch",
                args: {
                  agentId: "member-a",
                  prompt: "First task",
                  scope: [],
                  deliverable: "Answer",
                },
              },
              {
                name: "team_dispatch",
                args: {
                  agentId: "member-b",
                  prompt: "Excess task",
                  scope: [],
                  deliverable: "Answer",
                },
              },
            ],
          };
    }),
  );
  try {
    let session = await installTeam(x);
    session = x.kernel.teams.configure(session.id, {
      teamId: "team-one",
      kind: "task",
      goal: "Deliver the user's bounded goal",
      maxTurns: 1,
    });
    const first = await x.client.submit(session.id, {
      text: "First user round",
    });
    await x.kernel.wait(first.runId);
    assert.equal(tasks(x).length, 1);
    assert.match(
      JSON.stringify(x.kernel.store.transcript(session.id)),
      /dispatch turn limit/,
    );
    const second = await x.client.submit(session.id, {
      text: "Second user round",
    });
    await x.kernel.wait(second.runId);
    assert.equal(tasks(x).length, 2);
    assert.equal(tasks(x)[0].sessionId, tasks(x)[1].sessionId);
    assert.notEqual(tasks(x)[0].rootRunId, tasks(x)[1].rootRunId);
    const result = await x.kernel.teams.status(
      context(x, session, second.runId),
      {},
    );
    const parsed = z
      .object({ tasks: z.array(z.object({ stale: z.boolean() })) })
      .parse(result);
    assert.deepEqual(
      parsed.tasks.map((task) => task.stale),
      [true, false],
    );
  } finally {
    await x.close();
  }
});

test("collaboration keeps brainstorming read-only and continues from one user-facing conversation", async () => {
  let coordinatorRequests = 0;
  let rootId = "";
  const x = await setup(
    withRoleReview((body) => {
      if (request(body).model === "coordinator-model") {
        coordinatorRequests++;
        return coordinatorRequests % 2 === 0
          ? { text: "Facts, assumptions, disagreement and next options." }
          : {
              calls: [
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-b",
                    prompt: "Explore an alternative",
                    scope: [],
                    deliverable: "Alternative with evidence",
                  },
                },
              ],
            };
      }
      return transcript(body).includes('"role":"tool"')
        ? { text: "Alternative and its uncertain assumptions." }
        : {
            calls: [
              { name: "team_read", args: { sessionId: rootId } },
              {
                name: "file_write",
                args: {
                  path: "brainstorm-must-not-write.txt",
                  content: "blocked",
                },
              },
            ],
          };
    }),
  );
  try {
    const created = await installTeam(x, "office");
    const session = x.kernel.teams.configure(created.id, {
      teamId: "team-one",
      kind: "brainstorm",
      goal: "Explore a decision",
      maxTurns: 3,
    });
    rootId = session.id;
    const first = await x.client.submit(session.id, {
      text: "Give me options",
    });
    assert.equal((await x.kernel.wait(first.runId)).status, "completed");
    const second = await x.client.submit(session.id, {
      text: "Consider a lower-cost alternative",
    });
    assert.equal((await x.kernel.wait(second.runId)).status, "completed");
    assert.equal(tasks(x).length, 2);
    for (const task of tasks(x))
      assert.equal(task.status, "completed", task.error);
    assert.equal(tasks(x)[0].sessionId, tasks(x)[1].sessionId);
    const current = x.kernel.store.session(session.id);
    assert.equal(current.collaboration?.goal, "Explore a decision");
    assert.equal(
      current.collaboration?.currentRequest,
      "Consider a lower-cost alternative",
    );
    assert.ok(
      (current.collaboration?.revision || 0) > tasks(x)[0].binding.revision,
    );
    assert.match(
      x.kernel.store
        .transcript(tasks(x)[0].sessionId)
        .map((item) => textOf(item.message))
        .join("\n"),
      /"untrusted":true/,
    );
    await assert.rejects(
      readFile(
        path.join(x.config.workspaceRoots[0], "brainstorm-must-not-write.txt"),
      ),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});

test("collaboration denies unrelated conversation reads and member redispatch", async () => {
  const x = await setup(() => ({ text: "done" }));
  try {
    const session = await installTeam(x),
      first = await x.client.submit(session.id, { text: "Root round" });
    await x.kernel.wait(first.runId);
    const foreign = await x.session("code");
    x.kernel.teams.configure(foreign.id, {
      teamId: "team-one",
      kind: "task",
      goal: "Different conversation",
    });
    assert.throws(
      () =>
        x.kernel.teams.read(context(x, session, first.runId), {
          sessionId: foreign.id,
        }),
      /another team conversation/,
    );
    const child = x.kernel.createSession(
      session.projectId,
      "code",
      "member",
      "memberA",
      "member-a",
    );
    const stored = x.kernel.store.put("sessions", {
      ...child,
      collaboration: session.collaboration,
      teamRootSessionId: session.id,
      teamMemberId: "member-a",
      parentSessionId: session.id,
      subagentsEnabled: false,
    });
    const memberRun = await x.kernel.submit(stored.id, {
      text: "Member round",
    });
    await x.kernel.wait(memberRun.runId);
    assert.ok(
      !x.kernel.teams
        .tools(context(x, stored, memberRun.runId))
        .some((tool) => tool.name === "team_dispatch"),
    );
    await assert.rejects(
      x.kernel.teams.dispatch(context(x, stored, memberRun.runId), {
        agentId: "member-b",
        prompt: "redispatch",
        scope: [],
        deliverable: "Answer",
      }),
      /Only the coordinating root/,
    );
  } finally {
    await x.close();
  }
});

test("collaboration marks earlier member work stale after accepted steering and preserves the initial goal", async () => {
  let rootRequests = 0;
  const x = await setup(
    withRoleReview((body) => {
      if (request(body).model !== "coordinator-model")
        return { text: "Old task evidence", delayMs: 700 };
      rootRequests++;
      return rootRequests === 1
        ? {
            calls: [
              {
                name: "team_dispatch",
                args: {
                  agentId: "member-a",
                  prompt: "Original assignment",
                  scope: [],
                  deliverable: "Evidence",
                  wait: false,
                },
              },
            ],
          }
        : {
            text: "Acknowledged the latest request",
            delayMs: rootRequests === 2 ? 500 : 0,
          };
    }),
  );
  try {
    const session = await installTeam(x),
      started = await x.client.submit(session.id, {
        text: "Initial user request",
      });
    await until(() => tasks(x)[0]?.runId);
    const steering = await x.client.submit(session.id, {
      text: "Change the priority and avoid the original assumption",
      delivery: "steer",
      clientMessageId: "steering-once",
    });
    assert.equal(steering.runId, started.runId);
    const after = x.kernel.store.session(session.id).collaboration?.revision;
    await x.client.submit(session.id, {
      text: "Change the priority and avoid the original assumption",
      delivery: "steer",
      clientMessageId: "steering-once",
    });
    assert.equal(
      x.kernel.store.session(session.id).collaboration?.revision,
      after,
      "idempotent steering must not increment revision twice",
    );
    await x.kernel.wait(started.runId);
    const task = tasks(x)[0];
    assert.ok(task.runId);
    await x.kernel.wait(task.runId);
    const result = await x.kernel.teams.status(
      context(x, session, started.runId),
      { taskId: task.id },
    );
    assert.equal(
      z.object({ task: z.object({ stale: z.boolean() }) }).parse(result).task
        .stale,
      true,
    );
    assert.equal(
      x.kernel.store.session(session.id).collaboration?.goal,
      "Deliver the user's bounded goal",
    );
  } finally {
    await x.close();
  }
});

test("collaboration cancels background member runs with the coordinator", async () => {
  const x = await setup(
    withRoleReview((body) =>
      request(body).model === "coordinator-model"
        ? transcript(body).includes('"role":"tool"')
          ? { text: "Still coordinating", delayMs: 5000 }
          : {
              calls: [
                {
                  name: "team_dispatch",
                  args: {
                    agentId: "member-a",
                    prompt: "Long work",
                    scope: [],
                    deliverable: "Evidence",
                    wait: false,
                  },
                },
              ],
            }
        : { text: "Member result", delayMs: 5000 },
    ),
  );
  try {
    const session = await installTeam(x),
      root = await x.client.submit(session.id, {
        text: "Start a long bounded task",
      });
    const childRunId = await until(() => tasks(x)[0]?.runId);
    x.kernel.cancel(root.runId);
    assert.equal((await x.kernel.wait(root.runId)).status, "cancelled");
    assert.equal((await x.kernel.wait(childRunId)).status, "cancelled");
  } finally {
    await x.close();
  }
});

test("collaboration requires whole-roster review and a host decision before missing responsibilities can be reassigned", async () => {
  const x = await setup((body) =>
    request(body).model === "coordinator-model"
      ? { text: "Waiting for role review", delayMs: 10000 }
      : { text: "Reviewed responsibility applied" },
  );
  try {
    const session = await installTeam(x),
      started = await x.client.submit(session.id, {
        text: "The user requires authorized independent production approval with an explicit separation rule.",
      });
    await until(() =>
      x.wire.requests.find(
        (item) => request(item.body).model === "coordinator-model",
      ),
    );
    const ctx = context(x, session, started.runId);
    const rootRequest = x.wire.requests.find(
      (item) => request(item.body).model === "coordinator-model",
    );
    assert.ok(
      !names(rootRequest?.body).includes("agent_delegate"),
      "A team coordinator must use reviewed team dispatch only",
    );
    const forgedDelegate = {
      name: "agent_delegate",
      description: "Forged legacy delegation entry",
      parameters: { type: "object" },
      risk: "read" as const,
      capabilities: [],
      source: { kind: "builtin" as const, id: "foundation" },
      execute: async () => ({ content: [] }),
    };
    assert.equal(
      x.kernel.permissions.evaluate(
        x.kernel.store.session(session.id),
        session.routeId,
        forgedDelegate,
      ).effect,
      "deny",
    );
    const assignment = {
      agentId: "member-a",
      prompt: "Verify the delivery plan",
      scope: [],
      deliverable: "Verified plan",
    };
    await assert.rejects(
      x.kernel.teams.dispatch(ctx, assignment),
      /whole-team responsibility review/,
    );
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles.slice(1),
          gaps: [],
          rationale: "Incomplete roster",
        }),
      /entire unique team roster/,
    );
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles,
          gaps: [
            {
              ...blockingApprovalGap,
              attemptedAssignments:
                blockingApprovalGap.attemptedAssignments.slice(1),
            },
          ],
          rationale: "A role title alone is insufficient evidence.",
        }),
      /every existing agent/,
    );
    const review = x.kernel.teams.reviewRoles(ctx, {
      roles: reviewedRoles,
      gaps: [blockingApprovalGap],
      rationale:
        "The explicit independent approval requirement cannot currently be covered by any configured agent.",
    });
    assert.equal(review.roleReview.status, "needs_user");
    assert.equal(
      x.kernel.permissions.evaluate(
        x.kernel.store.session(session.id),
        session.routeId,
        {
          ...forgedDelegate,
          name: "file_write",
          risk: "write",
          capabilities: ["files.write"],
        },
      ).effect,
      "deny",
      "Unresolved blocking gaps also prevent the coordinator from bypassing the pause with direct writes",
    );
    await assert.rejects(
      x.kernel.teams.dispatch(ctx, assignment),
      /Blocking gaps require an explicit user decision/,
    );
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles: reviewedRoles,
          gaps: [],
          rationale: "The model tries to clear its own question",
        }),
      /user's explicit choice/,
    );
    x.kernel.teams.updateGoal(
      session.id,
      "A normal follow-up is not an explicit role choice",
    );
    assert.equal(
      x.kernel.store.session(session.id).collaboration?.roleReview?.status,
      "needs_user",
    );
    const decided = x.kernel.teams.resolveRoleReview(session.id, {
      decision: "redistribute",
    });
    assert.equal(decided.collaboration?.roleReview?.status, "awaiting_review");
    await assert.rejects(
      x.kernel.teams.dispatch(ctx, assignment),
      /whole-team responsibility review/,
    );
    const roles = reviewedRoles.map((role) =>
      role.agentId === "member-b"
        ? {
            ...role,
            optimizedResponsibility:
              "Review the implementation and validate the deployment plan with evidence.",
          }
        : role,
    );
    assert.equal(
      x.kernel.teams.reviewRoles(ctx, {
        roles,
        gaps: [],
        rationale:
          "The user chose redistribution; member B now covers deployment validation within its review responsibility.",
      }).roleReview.status,
      "ready",
    );
    const result = await x.kernel.teams.dispatch(ctx, assignment);
    assert.equal(result.status, "completed");
    assert.equal(
      result.optimizedResponsibility,
      reviewedRoles[1].optimizedResponsibility,
    );
    assert.equal(
      x.kernel.agents.get("member-b").instructions,
      "Original responsibility: independently review evidence.",
    );
    const memberRequest = x.wire.requests.find(
      (item) => request(item.body).model === "member-a-model",
    );
    assert.match(
      transcript(memberRequest?.body),
      /Reviewed responsibility for your role/,
    );
    assert.match(
      transcript(memberRequest?.body),
      /Implement the assigned part within its declared write scope/,
    );
    x.kernel.teams.reviewRoles(ctx, {
      roles,
      gaps: [blockingApprovalGap],
      rationale: "A later explicit approval restriction again blocks coverage.",
    });
    x.kernel.teams.recordRoleDecision(session.id, "add_agents");
    assert.equal(
      x.kernel.store.session(session.id).collaboration?.roleReview?.decision,
      "add_agents",
    );
    assert.throws(
      () =>
        x.kernel.teams.reviewRoles(ctx, {
          roles,
          gaps: [],
          rationale:
            "The model cannot bypass waiting for the host to add an agent.",
        }),
      /user's explicit choice/,
    );
    await assert.rejects(
      x.kernel.teams.dispatch(ctx, assignment),
      /Blocking gaps require an explicit user decision/,
    );
    x.kernel.cancel(started.runId);
    await x.kernel.wait(started.runId);
  } finally {
    await x.close();
  }
});

test("collaboration reuses broad planning and execution roles for testing without inventing agents or repeating review", async () => {
  let coordinatorRequests = 0;
  const roles = [
    {
      agentId: "coordinator",
      optimizedResponsibility:
        "Plan requirements, technology choices, project structure and conventions; coordinate delivery.",
    },
    {
      agentId: "member-a",
      optimizedResponsibility:
        "Execute implementation, run tests, fix defects and verify delivery within the assigned scope.",
    },
  ];
  const x = await setup((body) => {
    const parsed = request(body);
    if (parsed.model === "coordinator-model") {
      coordinatorRequests++;
      if (coordinatorRequests === 1)
        return {
          calls: [
            {
              name: "team_review_roles",
              args: {
                roles,
                gaps: [
                  {
                    responsibility: "Dedicated test specialist",
                    reason:
                      "Optional specialization; the execution role already includes testing and fixes.",
                    blocking: false,
                    attemptedAssignments: [
                      {
                        agentId: "member-a",
                        reason:
                          "Execution owns implementation, testing, fixes and delivery validation.",
                      },
                    ],
                  },
                ],
                rationale:
                  "The existing planning and execution roles already cover the full delivery workflow.",
              },
            },
          ],
        };
      if (coordinatorRequests === 2 || coordinatorRequests === 4)
        return {
          calls: [
            {
              name: "team_dispatch",
              args: {
                agentId: "member-a",
                prompt: "Run the actual validation test and report its stdout",
                refinedResponsibility:
                  "Run and verify the requested test as part of the execution responsibility",
                scope: ["tests"],
                deliverable: "Passing test with evidence",
              },
            },
            ...(coordinatorRequests === 4
              ? [
                  {
                    name: "team_dispatch",
                    args: {
                      agentId: "invented-tester",
                      prompt: "Create a specialist",
                      scope: [],
                      deliverable: "Unrequested specialization",
                    },
                  },
                ]
              : []),
          ],
        };
      return { text: "Execution tested and verified the delivery." };
    }
    const last = z
      .object({ role: z.string() })
      .passthrough()
      .parse(parsed.messages.at(-1));
    return last.role === "user"
      ? {
          calls: [
            {
              name: "exec_run",
              args: {
                command: process.execPath,
                args: [
                  "-e",
                  "require('node:assert/strict').equal(2 + 2, 4); console.log('execution-role-test-passed')",
                ],
              },
            },
          ],
        }
      : {
          text: "The execution role ran the test successfully: execution-role-test-passed.",
        };
  });
  try {
    const created = await installTeam(x);
    x.kernel.teams.put({
      ...x.kernel.teams.get("team-one"),
      memberAgentIds: ["member-a"],
    });
    const session = x.kernel.teams.configure(created.id, {
      teamId: "team-one",
      kind: "task",
      goal: "Plan and execute the delivery, including its tests",
    });
    const originalInstructions = x.kernel.agents.get("member-a").instructions;
    const first = await x.client.submit(session.id, {
      text: "Execute and test the planned work",
    });
    assert.equal((await x.kernel.wait(first.runId)).status, "completed");
    assert.equal(tasks(x).length, 1);
    assert.equal(tasks(x)[0].status, "completed");
    assert.equal(
      x.kernel.store.session(session.id).collaboration?.roleReview?.status,
      "ready",
    );
    const second = await x.client.submit(session.id, {
      text: "Run the same verification after my ordinary follow-up",
    });
    assert.equal((await x.kernel.wait(second.runId)).status, "completed");
    assert.equal(tasks(x).length, 2);
    assert.equal(tasks(x)[1].status, "completed");
    assert.equal(tasks(x)[0].sessionId, tasks(x)[1].sessionId);
    const reviewCalls = x.kernel.store
      .transcript(session.id)
      .flatMap((item) =>
        item.message.role === "assistant" ? item.message.content : [],
      )
      .filter(
        (part) => part.type === "toolCall" && part.name === "team_review_roles",
      );
    assert.equal(
      reviewCalls.length,
      1,
      "Ordinary user follow-ups reuse the completed roster review",
    );
    const executions = x.kernel.store
      .transcript(tasks(x)[1].sessionId)
      .filter(
        (item) =>
          item.message.role === "toolResult" &&
          item.message.toolName === "exec_run",
      );
    assert.equal(executions.length, 2);
    for (const executed of executions) {
      assert.equal(executed.message.role, "toolResult");
      if (executed.message.role !== "toolResult")
        throw new Error("Expected a persisted test execution result");
      assert.equal(executed.message.isError, false, textOf(executed.message));
      const evidence = z
        .object({ exitCode: z.number(), stdout: z.string() })
        .passthrough()
        .parse(executed.message.details);
      assert.equal(evidence.exitCode, 0);
      assert.match(evidence.stdout, /execution-role-test-passed/);
    }
    assert.match(
      x.kernel.store
        .transcript(tasks(x)[1].sessionId)
        .map((item) => textOf(item.message))
        .join("\n"),
      /execution-role-test-passed/,
    );
    assert.equal(
      x.kernel.agents.get("member-a").instructions,
      originalInstructions,
    );
    assert.equal(x.kernel.agents.list().length, 3);
    assert.ok(
      !x.kernel.agents.list().some((agent) => agent.id === "invented-tester"),
    );
    assert.match(
      x.kernel.store
        .transcript(session.id)
        .map((item) => textOf(item.message))
        .join("\n"),
      /not a registered member/,
    );
  } finally {
    await x.close();
  }
});
