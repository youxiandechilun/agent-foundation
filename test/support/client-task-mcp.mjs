import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [root, kind = "elicitation"] = process.argv.slice(2),
  incoming = new Map();
let serial = 0;
const send = (m) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"),
  result = (id, r) => send({ id, result: r });
function request(method, params) {
  const id = "server-" + ++serial;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  incoming.set(id, resolve);
  send({ id, method, params });
  return promise;
}
const form = {
    mode: "form",
    message: "Client async task input",
    requestedSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
  sample = {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Answer for this client-side async task",
        },
      },
    ],
    maxTokens: 100,
  };
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  appendFileSync(path.join(root, "client-task-requests.jsonl"), line + "\n");
  if (!m.method && incoming.has(m.id)) {
    incoming.get(m.id)(m);
    incoming.delete(m.id);
    return;
  }
  if (m.id === undefined) return;
  try {
    if (m.method === "server/discover")
      return send({
        id: m.id,
        error: { code: -32601, message: "Legacy peer" },
      });
    if (m.method === "initialize")
      return result(m.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "Client task requestor", version: "1" },
      });
    if (m.method === "tools/list")
      return result(m.id, {
        tools: [{ name: "work", inputSchema: { type: "object" } }],
      });
    if (m.method !== "tools/call") return;
    const args = m.params.arguments,
      scenario = args.scenario || "normal";
    if (scenario === "inspect") {
      const reply = await request("tasks/get", { taskId: args.taskId });
      writeFileSync(
        path.join(root, "foreign-client-task.json"),
        JSON.stringify(reply),
      );
      return result(m.id, {
        content: [
          { type: "text", text: reply.error?.message || "unexpected access" },
        ],
      });
    }
    const ids = [];
    for (let i = 0; i < (scenario === "pagination" ? 3 : 1); i++) {
      const created = await request(
        kind === "sampling" ? "sampling/createMessage" : "elicitation/create",
        {
          ...(kind === "sampling" ? sample : form),
          task: { ttl: args.ttl ?? 5000 },
        },
      );
      if (created.error) {
        writeFileSync(
          path.join(root, "client-task-create-error.json"),
          JSON.stringify(created),
        );
        return result(m.id, {
          content: [{ type: "text", text: created.error.message }],
          isError: true,
        });
      }
      ids.push(created.result.task.taskId);
    }
    writeFileSync(
      path.join(root, "received-client-task-ids.json"),
      JSON.stringify(ids),
    );
    if (scenario === "orphan") {
      result(m.id, {
        content: [{ type: "text", text: "origin returned before task" }],
      });
      await new Promise((r) => setTimeout(r, 60));
      const state = await request("tasks/get", { taskId: ids[0] });
      writeFileSync(
        path.join(root, "orphan-client-task.json"),
        JSON.stringify(state),
      );
      return;
    }
    const pages = [],
      first = await request("tasks/list", {});
    pages.push(first.result);
    while (pages.at(-1)?.nextCursor)
      pages.push(
        (await request("tasks/list", { cursor: pages.at(-1).nextCursor }))
          .result,
      );
    const bad = await request("tasks/list", { cursor: "not-a-real-cursor" });
    writeFileSync(
      path.join(root, "client-task-pages.json"),
      JSON.stringify({ pages, bad }),
    );
    if (scenario === "cancel")
      await request("tasks/cancel", { taskId: ids[0] });
    const values = [];
    for (const taskId of ids) {
      let state;
      for (let i = 0; i < 200; i++) {
        const response = await request("tasks/get", {
          taskId,
          _meta: {
            "io.modelcontextprotocol/related-task": {
              taskId: "ignored-metadata-id",
            },
          },
        });
        if (response.error) {
          state = { status: "failed", error: response.error };
          break;
        }
        state = response.result;
        if (["completed", "failed", "cancelled"].includes(state.status)) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      const output = await request("tasks/result", { taskId });
      values.push({ taskId, state, output });
      if (!output.error)
        writeFileSync(
          path.join(root, "client-task-effect.txt"),
          output.result.content?.value ||
            output.result.content?.text ||
            "accepted",
        );
      if (scenario === "cancel") {
        const repeated = await request("tasks/cancel", { taskId });
        writeFileSync(
          path.join(root, "client-task-terminal-cancel.json"),
          JSON.stringify(repeated),
        );
      }
    }
    writeFileSync(
      path.join(root, "client-task-values.json"),
      JSON.stringify(values),
    );
    return result(m.id, {
      content: [
        {
          type: "text",
          text: values[0].output.error?.message || "client tasks completed",
        },
      ],
      isError: !!values[0].output.error,
    });
  } catch (e) {
    send({ id: m.id, error: { code: -32603, message: String(e) } });
  }
});
