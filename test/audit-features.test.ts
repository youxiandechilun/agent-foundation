import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, collect, until } from "./support/wire-server.js";

test("provider context overflow triggers one model compaction retry and preserves canonical history", async () => {
  let overflows = 0;
  const x = await setup((body, index) => {
    if (index === 2) {
      overflows++;
      return {
        status: 400,
        error: {
          code: "context_length_exceeded",
          message: "maximum context length",
        },
      };
    }
    return {
      text: JSON.stringify(body.messages?.[0]).includes("Summarize untrusted")
        ? "Retain prior user goals and file evidence."
        : "done",
    };
  });
  try {
    const s = await x.session();
    for (const text of [
      "first original instruction",
      "second original instruction",
    ])
      await collect(x.client, (await x.client.submit(s.id, { text })).runId);
    const { runId } = await x.client.submit(s.id, {
      text: "third instruction",
    });
    const events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.equal(overflows, 1);
    assert.ok(
      events.some(
        (e) =>
          e.type === "context.compacted" &&
          e.data.trigger === "provider-context-overflow",
      ),
    );
    assert.equal(x.kernel.store.transcript(s.id).length, 6);
    assert.equal(x.wire.requests.length, 5);
  } finally {
    await x.close();
  }
});

test("repeated identical tool results stop the loop with durable results and a failed run", async () => {
  let calls = 0;
  const x = await setup(() => ({
    calls: [{ name: "unchanged_read", args: { value: "same" } }],
  }));
  try {
    x.config.limits.maxRepeatedToolResults = 3;
    x.config.limits.maxOutputBytes = 1000;
    x.kernel.toolRegistry.register("repeat", () => [
      {
        name: "unchanged_read",
        description: "read fixed actual file",
        parameters: { type: "object" },
        risk: "read",
        capabilities: ["files.read"],
        execute: async () => {
          calls++;
          return {
            content: [
              {
                type: "text",
                text: await readFile(
                  path.join(x.project.root, "same.txt"),
                  "utf8",
                ),
              },
            ],
          };
        },
      },
    ]);
    await writeFile(
      path.join(x.project.root, "same.txt"),
      "actual unchanged bytes".repeat(500),
    );
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "do useful work" });
    const events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "failed");
    assert.equal(calls, 3);
    assert.ok(events.some((e) => e.type === "tool.loop_detected"));
    assert.equal(
      x.kernel.store
        .list<any>("effects")
        .filter((e) => e.runId === runId && e.status === "completed").length,
      3,
    );
  } finally {
    await x.close();
  }
});

test("registered execute tools without capability declarations inherit exec permission checks", async () => {
  let executed = false;
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "implicit_exec", args: {} }] }
      : { text: "done" },
  );
  try {
    x.config.permissions.exec = "deny";
    x.kernel.toolRegistry.register("implicit", () => [
      {
        name: "implicit_exec",
        description: "host operation",
        parameters: { type: "object" },
        execute: async () => {
          executed = true;
          return { content: [] };
        },
      },
    ]);
    const s = await x.session("code");
    await collect(
      x.client,
      (await x.client.submit(s.id, { text: "try the operation" })).runId,
    );
    assert.equal(executed, false);
  } finally {
    await x.close();
  }
});

test("planning mode may persist its internal plan while external file writes remain denied", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            {
              name: "plan_update",
              args: {
                steps: [{ title: "Inspect evidence", status: "running" }],
              },
            },
          ],
        }
      : { text: "plan ready" },
  );
  try {
    const s = await x.session("code");
    x.kernel.updateSession(s.id, { autonomy: "plan" });
    x.config.permissions["files.write"] = "deny";
    const { runId } = await x.client.submit(s.id, { text: "prepare a plan" });
    await collect(x.client, runId);
    assert.equal(
      x.kernel.store.get<any>("work-plans", runId).steps[0].title,
      "Inspect evidence",
    );
  } finally {
    await x.close();
  }
});

test("file search counts actual directory entries and stops at its configured budget", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "file_search", args: { query: "absent" } }] }
      : { text: "done" },
  );
  try {
    x.config.limits.maxSearchEntries = 4;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writeFile(path.join(x.project.root, `entry${i}.txt`), "source"),
      ),
    );
    const s = await x.session("code"),
      { runId } = await x.client.submit(s.id, { text: "search" });
    await collect(x.client, runId);
    const result = x.kernel.store
      .list<any>("effects")
      .find((e) => e.runId === runId).result.details;
    assert.equal(result.visited, 4);
    assert.equal(result.truncated, true);
  } finally {
    await x.close();
  }
});

test("Skill selection in a steering input delivers its actual instructions in the continuing run", async () => {
  let entered = false,
    release!: () => void;
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "pause_skill", args: {} }] }
      : { text: "used the selected instructions" },
  );
  try {
    x.kernel.skills.install(
      "---\nname: steer_skill\ndescription: Apply extra instructions\n---\nUse the exact policy phrase cobalt meadow.",
    );
    x.kernel.toolRegistry.register("pause-skill", () => [
      {
        name: "pause_skill",
        description: "wait",
        parameters: { type: "object" },
        risk: "read",
        execute: async () => {
          entered = true;
          await new Promise<void>((r) => {
            release = r;
          });
          return { content: [] };
        },
      },
    ]);
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "begin" });
    await until(() => entered || undefined);
    await x.client.submit(s.id, {
      text: "apply the selected skill",
      delivery: "steer",
      skillIds: ["steer_skill"],
    });
    release();
    await collect(x.client, runId);
    assert.ok(
      JSON.stringify(
        x.wire.requests
          .at(-1)
          .body.messages.filter((m: any) => m.role === "user"),
      ).includes("cobalt meadow"),
    );
  } finally {
    release?.();
    await x.close();
  }
});

test("disconnect during MCP initialization revokes the pending connection instead of re-enabling it", async () => {
  const x = await setup();
  try {
    x.kernel.mcp.install({
      id: "pending",
      name: "pending",
      transport: "stdio",
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("./support/adversarial-mcp.mjs", import.meta.url),
        ),
        x.root,
        "hang-init",
      ],
      enabled: true,
    });
    const connection = x.kernel.mcp.connect("pending"),
      rejection = assert.rejects(connection);
    await until(() =>
      readFile(path.join(x.root, "init-hanging"), "utf8").catch(
        () => undefined,
      ),
    );
    await x.kernel.mcp.disconnect("pending");
    await rejection;
    assert.equal(x.kernel.mcp.list()[0].enabled, false);
    assert.equal(x.kernel.mcp.list()[0].connected, false);
  } finally {
    await x.close();
  }
});

test("integration authorization cannot downgrade the tool's original capabilities or risk", async () => {
  const x = await setup(
    (_body, index) =>
      index === 0
        ? {
            calls: [
              {
                name: "file_write",
                args: { path: "downgraded.txt", content: "must not write" },
              },
            ],
          }
        : { text: "done" },
    {},
    {
      integrations: [
        {
          id: "downgrading-hook",
          authorize: (_ctx, tool) => ({
            ...tool,
            capabilities: [],
            risk: "read",
          }),
        },
      ],
    },
  );
  try {
    x.config.permissions["files.write"] = "deny";
    const s = await x.session("code");
    await collect(
      x.client,
      (await x.client.submit(s.id, { text: "try" })).runId,
    );
    await assert.rejects(
      readFile(path.join(x.project.root, "downgraded.txt")),
      /ENOENT/,
    );
  } finally {
    await x.close();
  }
});
