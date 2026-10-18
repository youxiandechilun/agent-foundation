import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Run, Session } from "../src/contracts.js";
import type { TeamTask } from "../src/collaboration/types.js";
import { TeamTasks } from "../src/collaboration/internal/tasks.js";
import { setup } from "./support/wire-server.js";

async function fixture(t: TestContext) {
  const x = await setup(() => ({ text: "member completed" }));
  t.after(() => x.close());
  for (const id of ["coordinator", "member"])
    x.kernel.agents.put({
      id,
      name: id,
      mode: "code",
      instructions: `Original ${id} responsibility`,
    });
  const definition = x.kernel.teams.put({
    id: "team",
    name: "Query team",
    mode: "code",
    coordinatorAgentId: "coordinator",
    memberAgentIds: ["member"],
  });
  const root = x.kernel.teams.configure((await x.session("code")).id, {
    teamId: definition.id,
    kind: "task",
    goal: "Verify bounded team queries",
  });
  assert.ok(root.collaboration);
  const time = new Date().toISOString();
  const run = x.kernel.store.put<Run>("runs", {
    id: "root-run",
    sessionId: root.id,
    status: "completed",
    createdAt: time,
    updatedAt: time,
  });
  return {
    ...x,
    root,
    binding: root.collaboration,
    definition,
    time,
    context: {
      kernel: x.kernel,
      session: root,
      runId: run.id,
      routeId: root.routeId,
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function seedTask(x: Fixture, id: string, changes: Partial<TeamTask> = {}) {
  const task: TeamTask = {
    id,
    teamId: x.definition.id,
    projectId: x.root.projectId,
    workspaceRoot: x.project.root,
    rootSessionId: x.root.id,
    rootRunId: "root-run",
    memberAgentId: "member",
    sessionId: x.root.id,
    runId: `${id}-run`,
    binding: x.binding,
    prompt: "history",
    declaredResponsibility: "member",
    optimizedResponsibility: "member",
    refinedResponsibility: "member",
    scope: [],
    deliverable: "history",
    status: "running",
    createdAt: x.time,
    updatedAt: x.time,
    ...changes,
  };
  if (task.runId)
    x.kernel.store.put<Run>("runs", {
      id: task.runId,
      sessionId: task.sessionId,
      status: "completed",
      createdAt: x.time,
      updatedAt: x.time,
    });
  return x.kernel.store.put("team-tasks", task);
}

test("team status counts all matching history but refreshes only the latest 40 in insertion order", async (t) => {
  const x = await fixture(t);
  const tasks = new TeamTasks(x.kernel);
  const own: TeamTask[] = [];
  x.kernel.store.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      own.push(seedTask(x, `own-${1000 - i}`));
      seedTask(x, `old-team-${i}`, { teamId: "old-team" });
      seedTask(x, `other-root-${i}`, { rootSessionId: "other-root" });
    }
  });
  const refresh = t.mock.method(tasks, "refresh");
  const reads = t.mock.method(x.kernel.store, "run");
  const result = await tasks.status(x.context, {});
  assert.ok(result.tasks);
  assert.equal(result.total, 1000);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.tasks.map((task) => task.id),
    own.slice(-40).map((task) => task.id),
  );
  assert.ok(result.tasks.every((task) => task.status === "completed"));
  assert.equal(refresh.mock.calls.length, 40);
  assert.equal(
    reads.mock.calls.filter((call) => call.arguments[0].startsWith("own-"))
      .length,
    80,
  );
  assert.ok(
    reads.mock.calls.every(
      (call) => !/old-team-|other-root-/.test(call.arguments[0]),
    ),
  );
  assert.equal(
    x.kernel.store.get<TeamTask>("team-tasks", own[0].id).status,
    "running",
  );
  assert.equal(
    x.kernel.store.get<TeamTask>("team-tasks", "old-team-999").status,
    "running",
  );
  const detail = await tasks.status(x.context, { taskId: own[0].id });
  assert.equal(detail.task?.status, "completed");

  x.kernel.store.transaction(() => {
    for (const task of own.slice(0, -3))
      x.kernel.store.remove("team-tasks", task.id);
  });
  const small = await tasks.status(x.context, {});
  assert.equal(small.total, 3);
  assert.equal(small.hasMore, false);
  assert.deepEqual(
    small.tasks?.map((task) => task.id),
    own.slice(-3).map((task) => task.id),
  );
  for (const task of own.slice(-3))
    x.kernel.store.remove("team-tasks", task.id);
  const empty = await tasks.status(x.context, {});
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);
  assert.deepEqual(empty.tasks, []);
});

test("teamId entity queries remain parameterized and use the index without changing row order", async (t) => {
  const x = await fixture(t);
  const injected = "team' OR 1=1 --";
  seedTask(x, "normal");
  seedTask(x, "escaped-first", { teamId: injected });
  seedTask(x, "escaped-second", { teamId: injected });
  assert.equal(x.kernel.store.count("team-tasks", { teamId: injected }), 2);
  assert.deepEqual(
    x.kernel.store
      .list<TeamTask>("team-tasks", { teamId: injected })
      .map((task) => task.id),
    ["escaped-first", "escaped-second"],
  );
  assert.equal(x.kernel.store.count("team-tasks", { teamId: [] }), 0);
  const plan = x.kernel.store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT body FROM entities WHERE kind=? AND json_extract(body,'$.teamId') IN (?) ORDER BY rowid LIMIT ? OFFSET ?",
    )
    .all("team-tasks", injected, 40, 0);
  assert.match(JSON.stringify(plan), /entities_teamId/);
});

test("editing an idle team does not refresh or fail on another team's stale task", async (t) => {
  const x = await fixture(t);
  const own = seedTask(x, "own-completed");
  const foreign = seedTask(x, "foreign", { teamId: "foreign-team" });
  x.kernel.store.put("team-tasks", {
    ...foreign,
    runId: "missing-foreign-run",
  });
  const reads = t.mock.method(x.kernel.store, "run");
  assert.equal(
    x.kernel.teams.put({ ...x.definition, name: "Renamed" }).name,
    "Renamed",
  );
  assert.equal(
    x.kernel.store.get<TeamTask>("team-tasks", own.id).status,
    "completed",
  );
  assert.equal(
    x.kernel.store.get<TeamTask>("team-tasks", foreign.id).status,
    "running",
  );
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [own.runId],
  );
});

test("dispatch reuses the member session through bounded parent queries despite unrelated history", async (t) => {
  const x = await fixture(t);
  x.kernel.store.put("runs", {
    ...x.kernel.store.run("root-run"),
    status: "running",
  });
  x.kernel.teams.reviewRoles(x.context, {
    roles: ["coordinator", "member"].map((agentId) => ({
      agentId,
      optimizedResponsibility: `Reviewed ${agentId}`,
    })),
    gaps: [],
    rationale: "The existing roster covers coordination and implementation",
  });
  x.kernel.store.transaction(() => {
    for (let i = 0; i < 1000; i++)
      x.kernel.store.put<Session>("sessions", {
        ...x.root,
        id: `unrelated-${i}`,
      });
    x.kernel.store.put<Session>("sessions", {
      ...x.root,
      id: "archived-child",
      parentSessionId: x.root.id,
      teamRootSessionId: x.root.id,
      teamMemberId: "member",
      archived: true,
    });
    x.kernel.store.put<Session>("sessions", {
      ...x.root,
      id: "foreign-child",
      parentSessionId: x.root.id,
      teamRootSessionId: x.root.id,
      teamMemberId: "member",
      collaboration: { ...x.binding, teamId: "foreign" },
    });
  });
  const lists = t.mock.method(x.kernel.store, "list");
  const assignment = {
    agentId: "member",
    prompt: "Inspect the assigned work",
    scope: [],
    deliverable: "Actual result",
  };
  const first = await x.kernel.teams.dispatch(x.context, assignment);
  const second = await x.kernel.teams.dispatch(x.context, assignment);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(!["archived-child", "foreign-child"].includes(first.sessionId));
  const sessionQueries = lists.mock.calls.filter(
    (call) => call.arguments[0] === "sessions",
  );
  assert.equal(sessionQueries.length, 2);
  assert.ok(
    sessionQueries.every(
      (call) => call.arguments[1]?.parentSessionId === x.root.id,
    ),
  );
  assert.equal(x.wire.requests.length, 2);
});
