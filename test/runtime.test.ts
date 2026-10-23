import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setup, collect, until } from "./support/wire-server.js";
import type { Approval } from "../src/contracts.js";

test("own runtime commits replies before actual tools and continues; durable effects and input IDs", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          text: "先写函数，然后继续验证。",
          calls: [
            {
              name: "file_write",
              args: {
                path: "add.mjs",
                content: "export const add=(a,b)=>a+b;",
              },
            },
          ],
        }
      : index === 1
        ? {
            text: "执行真实断言。",
            calls: [
              {
                name: "exec_run",
                args: {
                  command: process.execPath,
                  args: [
                    "--input-type=module",
                    "-e",
                    'const {add}=await import("./add.mjs");if(add(4,7)!==11)throw Error("bad");console.log(add(4,7))',
                  ],
                },
              },
            ],
          }
        : { text: "验证结果已返回。" },
  );
  try {
    const session = await x.session("code"),
      submitted = await x.client.submit(session.id, {
        text: "implement",
        clientMessageId: "id-1",
      }),
      events = await collect(x.client, submitted.runId);
    assert.equal((await x.kernel.wait(submitted.runId)).status, "completed");
    assert.equal(
      events.filter((e) => e.type === "assistant.message.committed").length,
      3,
    );
    assert.ok(
      events.findIndex((e) => e.type === "assistant.message.committed") <
        events.findIndex((e) => e.type === "tool.started"),
    );
    const result: any = events.find(
      (e) => e.type === "tool.settled" && e.data.name === "exec_run",
    )?.data.result;
    assert.equal(result.details.stdout.trim(), "11");
    assert.match(
      await readFile(path.join(x.config.workspaceRoots[0], "add.mjs"), "utf8"),
      /add/,
    );
    assert.equal(
      x.kernel.store
        .list<any>("effects")
        .filter((e) => e.runId === submitted.runId && e.status === "completed")
        .length,
      2,
    );
    assert.equal(
      x.kernel.store.get<any>("inbox", submitted.inputId).status,
      "applied",
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "input.applied" && e.data.inputId === submitted.inputId,
      ),
    );
    assert.equal(
      (
        await x.client.submit(session.id, {
          text: "implement",
          clientMessageId: "id-1",
        })
      ).runId,
      submitted.runId,
    );
    await assert.rejects(
      x.client.submit(session.id, {
        text: "different",
        clientMessageId: "id-1",
      }),
      /409/,
    );
    const replay = await x.client.request(
      "GET",
      `/v1/runs/${submitted.runId}/events?format=json&after=0`,
    );
    assert.equal(replay.events.at(-1)!.type, "run.completed");
    assert.ok(replay.events.every((e: any) => e.seq !== null));
  } finally {
    await x.close();
  }
});
for (const adapter of [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  test(`own ${adapter} wire serializer/parser and tools`, async () => {
    const x = await setup((_body, index) =>
      index === 0
        ? { text: "读取项目。", calls: [{ name: "file_list", args: {} }] }
        : { text: "完成。" },
    );
    try {
      x.config.routes.text.adapter = adapter;
      const s = await x.session("code");
      const { runId } = await x.client.submit(s.id, { text: "inspect" });
      const events = await collect(x.client, runId);
      assert.equal(
        (await x.kernel.wait(runId)).status,
        "completed",
        x.kernel.store.run(runId).error,
      );
      assert.equal(x.wire.requests.length, 2);
      assert.equal(
        events.filter((e) => e.type === "tool.settled" && !e.data.isError)
          .length,
        1,
      );
      assert.equal(
        events.filter((e) => e.type === "assistant.message.committed").length,
        2,
      );
      const second = x.wire.requests[1].body;
      assert.match(
        JSON.stringify(second),
        adapter === "openai-responses"
          ? /function_call_output/
          : adapter === "anthropic-messages"
            ? /tool_result/
            : /tool_call_id/,
      );
    } finally {
      await x.close();
    }
  });
test("approval, planning mode, model/project policy intersection block side effects", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          text: "request command",
          calls: [
            {
              name: "exec_run",
              args: {
                command: process.execPath,
                args: ["-e", 'console.log("approved")'],
              },
            },
          ],
        }
      : { text: "finish" },
  );
  try {
    const s = await x.client.session(x.project.id, "code"),
      { runId } = await x.client.submit(s.id, { text: "run" });
    const approval = await until(() =>
      x.kernel.store.list<Approval>("approvals").find((a) => a.runId === runId),
    );
    assert.equal(x.kernel.store.run(runId).status, "waiting_approval");
    assert.ok(
      !x.kernel.store.replay(runId).some((e) => e.type === "tool.started"),
    );
    await x.client.request("POST", `/v1/approvals/${approval.id}/resolve`, {
      allow: true,
    });
    await x.kernel.wait(runId);
    await assert.rejects(
      x.client.request("POST", `/v1/approvals/${approval.id}/resolve`, {
        allow: true,
      }),
      /409/,
    );
    x.kernel.store.put("policies", {
      id: "deny-writes",
      effect: "deny",
      projectId: x.project.id,
      capabilities: ["files.write"],
    });
    const tool: any = {
      name: "file_write",
      risk: "write",
      capabilities: ["files.write"],
    };
    assert.equal(
      x.kernel.permissions.evaluate(
        { ...x.kernel.store.session(s.id), autonomy: "autonomous" },
        "text",
        tool,
      ).effect,
      "deny",
    );
    assert.equal(
      x.kernel.permissions.evaluate(
        { ...x.kernel.store.session(s.id), autonomy: "plan" },
        "text",
        tool,
      ).effect,
      "deny",
    );
  } finally {
    await x.close();
  }
});
test("steer/enqueue run continuity, cancel, fork and session export", async () => {
  const x = await setup((_body, index) => ({
    text: `reply-${index}`,
    delayMs: index === 0 ? 180 : 10,
  }));
  try {
    const s = await x.session(),
      first = await x.client.submit(s.id, { text: "first" });
    await until(
      () =>
        x.kernel.store
          .replay(first.runId)
          .some((e) => e.type === "model-step.started") || undefined,
    );
    await x.client.submit(s.id, { text: "steering", delivery: "steer" });
    await x.client.submit(s.id, { text: "follow-up", delivery: "enqueue" });
    await collect(x.client, first.runId);
    assert.equal((await x.kernel.wait(first.runId)).status, "completed");
    assert.equal(
      x.kernel.store.transcript(s.id).filter((m) => m.message.role === "user")
        .length,
      3,
    );
    const fork = await x.client.request(
      "POST",
      `/v1/sessions/${s.id}/fork`,
      {},
    );
    assert.equal(
      x.kernel.store.transcript(fork.id).length,
      x.kernel.store.transcript(s.id).length,
    );
    const next = await x.client.submit(s.id, { text: "cancel" });
    x.kernel.cancel(next.runId);
    assert.equal((await x.kernel.wait(next.runId)).status, "cancelled");
    assert.equal(
      (await x.client.request("GET", `/v1/sessions/${fork.id}/export`)).format,
      "foundation-session-v1",
    );
  } finally {
    await x.close();
  }
});
test("auth, CORS, unknown model keys and malformed inputs return explicit errors", async () => {
  const x = await setup();
  try {
    assert.equal((await fetch(x.api.url + "/v1/config")).status, 401);
    assert.equal(
      (
        await fetch(x.api.url + "/health", {
          headers: { Origin: "https://invalid.example" },
        })
      ).status,
      403,
    );
    const s = await x.session();
    await assert.rejects(x.client.submit(s.id, { text: "" }), /400/);
    x.config.routes.text.apiKeyEnv = "UNCONFIGURED_REAL_MODEL_KEY";
    await assert.rejects(x.client.submit(s.id, { text: "real" }), /503/);
  } finally {
    await x.close();
  }
});
