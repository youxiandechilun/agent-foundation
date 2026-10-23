import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, collect } from "./support/wire-server.js";
import { safePath } from "../src/core/util.js";

test("persistent CJK/English memory search, updates, namespaces, deletion and project isolation", async () => {
  const x = await setup();
  try {
    const a = x.kernel.memory.put({
      projectId: x.project.id,
      content: "用户偏好使用深色主题，默认使用中文回答。",
      tags: ["界面"],
      namespace: "preferences",
    });
    const b = x.kernel.memory.put({
      projectId: x.project.id,
      content: "Project compiles with TypeScript and pnpm.",
      tags: ["stack"],
    });
    assert.ok(
      x.kernel.memory
        .search(x.project.id, "深色主题")
        .some((m) => m.id === a.id),
    );
    assert.ok(
      x.kernel.memory
        .search(x.project.id, "TypeScript")
        .some((m) => m.id === b.id),
    );
    assert.equal(
      x.kernel.memory.search(x.project.id, "TypeScript", 10, "preferences")
        .length,
      0,
    );
    x.kernel.memory.put({ ...a, content: "用户偏好浅色主题。" });
    assert.equal(
      x.kernel.memory
        .search(x.project.id, "深色主题")
        .some((m) => m.id === a.id),
      false,
    );
    x.kernel.memory.remove(a.id, x.project.id);
    assert.equal(x.kernel.memory.list(x.project.id).length, 1);
    const p = await x.client.project("other");
    assert.equal(x.kernel.memory.search(p.id, "TypeScript").length, 0);
  } finally {
    await x.close();
  }
});
test("skills install/enable/load and custom agent definitions are used in real provider requests", async () => {
  const x = await setup();
  try {
    const skill = await x.client.request("POST", "/v1/skills", {
      source:
        "---\nname: evidence\ndescription: cite actual files\n---\nInclude exact source file names in reports.",
    });
    assert.equal(skill.id, "evidence");
    await x.client.request("POST", "/v1/agents", {
      id: "reviewer",
      name: "Reviewer",
      mode: "code",
      instructions: "REVIEWER_MARKER",
      skillIds: ["evidence"],
      toolAllowlist: ["file_read"],
      maxSteps: 4,
      memoryNamespace: "review",
    });
    const result = await x.client.request("POST", "/v1/agents/reviewer/start", {
      projectId: x.project.id,
      text: "review",
    });
    await collect(x.client, result.runId);
    assert.equal((await x.kernel.wait(result.runId)).status, "completed");
    assert.match(JSON.stringify(x.wire.requests[0].body), /REVIEWER_MARKER/);
    assert.match(
      JSON.stringify(x.wire.requests[0].body),
      /exact source file names/,
    );
    assert.deepEqual(
      x.wire.requests[0].body.tools.map((t: any) => t.function.name),
      ["file_read"],
    );
    await x.client.request("PATCH", "/v1/skills/evidence", { enabled: false });
    assert.throws(() => x.kernel.skills.instructions(["evidence"]), /disabled/);
  } finally {
    await x.close();
  }
});
test("native plugin source executes in a child process, source hash approval and disable are enforced", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          text: "transform",
          calls: [
            { name: "plugin_text_upper", args: { text: "actual plugin" } },
          ],
        }
      : { text: "done" },
  );
  try {
    const plugin = await x.client.request("POST", "/v1/plugins", {
      manifest: {
        schemaVersion: 1,
        id: "text",
        name: "text utility",
        version: "1.0.0",
        entry: "index.mjs",
        tools: [
          {
            name: "upper",
            description: "uppercase text",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            risk: "read",
            capabilities: [],
          },
        ],
      },
      files: {
        "index.mjs":
          'export async function execute(name,args){ return {content:[{type:"text",text:args.text.toUpperCase()}],details:{value:args.text.toUpperCase()}}; }',
      },
    });
    await assert.rejects(
      x.client.request("PATCH", "/v1/plugins/text", {
        enabled: true,
        trustedHash: "wrong",
      }),
      /403/,
    );
    await x.client.request("PATCH", "/v1/plugins/text", {
      enabled: true,
      trustedHash: plugin.hash,
    });
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "upper" });
    const events = await collect(x.client, runId);
    const result: any = events.find(
      (e) => e.type === "tool.settled" && e.data.name === "plugin_text_upper",
    )?.data.result;
    assert.equal(result.details.value, "ACTUAL PLUGIN");
    await x.client.request("PATCH", "/v1/plugins/text", { enabled: false });
    assert.equal(
      x.kernel.plugins.tools(x.project.id, x.config.workspaceRoots[0]).length,
      0,
    );
  } finally {
    await x.close();
  }
});
test("actual stdio MCP child reads files, resources and prompts and contributes tools to the agent", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          text: "read MCP",
          calls: [
            { name: "mcp_files_read_text", args: { path: "source.txt" } },
          ],
        }
      : { text: "done" },
  );
  try {
    await writeFile(
      path.join(x.config.workspaceRoots[0], "source.txt"),
      "actual filesystem content",
    );
    const server = fileURLToPath(
      new URL("../examples/mcp-filesystem.mjs", import.meta.url),
    );
    await x.client.request("POST", "/v1/mcp", {
      id: "files",
      name: "actual filesystem",
      transport: "stdio",
      command: process.execPath,
      args: [server, x.config.workspaceRoots[0]],
      enabled: true,
    });
    const catalog = await x.client.request("GET", "/v1/mcp/files/tools");
    assert.ok(catalog.tools.some((t: any) => t.name === "read_text"));
    const s = await x.session("code"),
      { runId } = await x.client.submit(s.id, { text: "read source" }),
      events = await collect(x.client, runId);
    const result: any = events.find(
      (e) => e.type === "tool.settled" && e.data.name === "mcp_files_read_text",
    )?.data.result;
    assert.match(result.content[0].text, /actual filesystem content/);
    assert.equal(
      (
        await x.client.request<{ resources: { uri: string }[] }>(
          "GET",
          "/v1/mcp/files/resources",
        )
      ).resources.length,
      1,
    );
    assert.equal(
      (
        await x.client.request<{ prompts: { name: string }[] }>(
          "GET",
          "/v1/mcp/files/prompts",
        )
      ).prompts[0].name,
      "review",
    );
    await x.client.request("POST", "/v1/mcp/files/disconnect", {});
    assert.equal(x.kernel.mcp.list()[0].connected, false);
  } finally {
    await x.close();
  }
});
test("model summary compaction uses a provider, preserves original history and caches durable summaries", async () => {
  const x = await setup(() => ({
    text: "Preserved goals, actual file IDs, decisions and pending work.",
  }));
  try {
    x.config.routes.text.contextWindow = 12000;
    x.config.routes.text.maxOutputTokens = 2000;
    const s = await x.session();
    const time = new Date().toISOString();
    x.kernel.store.put("runs", {
      id: "run_compact",
      sessionId: s.id,
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    const messages: any[] = [
      { role: "system", content: "instructions", timestamp: 1 },
    ];
    for (let i = 0; i < 18; i++) {
      messages.push({
        role: "user",
        content: `request ${i} ` + "source ".repeat(500),
        timestamp: i + 2,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `actual result ${i}` }],
        timestamp: i + 2,
      });
    }
    const output = await x.kernel.context.prepare(
      "run_compact",
      "text",
      messages,
    );
    assert.ok(output.length < messages.length);
    assert.match(JSON.stringify(output), /Preserved goals/);
    assert.ok(x.wire.requests.length > 0);
    const count = x.wire.requests.length;
    await x.kernel.context.prepare("run_compact", "text", messages);
    assert.equal(x.wire.requests.length, count);
    assert.equal(messages.length, 37);
    assert.ok(
      x.kernel.store
        .replay("run_compact")
        .some(
          (e) =>
            e.type === "context.compacted" &&
            e.data.strategy === "model-summary",
        ),
    );
  } finally {
    await x.close();
  }
});
test("filesystem paths, unknown binary assets and argument validation preserve boundaries", async () => {
  const x = await setup();
  try {
    await assert.rejects(
      safePath(x.config.workspaceRoots[0], "../escape", true),
    );
    await assert.rejects(
      safePath(x.config.workspaceRoots[0], "file:stream", true),
    );
    await assert.rejects(safePath(x.config.workspaceRoots[0], "NUL", true));
    const asset = await x.client.upload(
      x.project.id,
      "firmware.unknown",
      Buffer.from([0, 1, 2]),
    );
    assert.equal(
      (await x.kernel.assets.extract(asset.id, x.project.id)).supported,
      false,
    );
    const second = await x.client.project("second");
    assert.throws(
      () => x.kernel.assets.owned(asset.id, second.id),
      /another project/,
    );
  } finally {
    await x.close();
  }
});
