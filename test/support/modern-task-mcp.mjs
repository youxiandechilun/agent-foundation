import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
const [root] = process.argv.slice(2),
  tasks = new Map();
const extension = "io.modelcontextprotocol/tasks",
  send = (m) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"),
  reply = (id, result) => send({ id, result }),
  error = (id, message, code = -32603) =>
    send({ id, error: { code, message } });
const ordinary = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const initial = {
  messages: [
    {
      role: "user",
      content: { type: "text", text: "Use this remote file tool" },
    },
  ],
  tools: [
    {
      name: "write_remote_file",
      description: "Writes on the server",
      inputSchema: ordinary,
    },
  ],
  toolChoice: { mode: "required" },
  maxTokens: 100,
};
function state(task) {
  return {
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...(task.status === "input_required"
      ? { inputRequests: task.inputRequests }
      : {}),
    ...(task.status === "completed" ? { result: task.output } : {}),
    ...(task.status === "failed"
      ? { error: { code: -32603, message: "Actual task protocol error" } }
      : {}),
  };
}
function touch(t, status) {
  t.status = status;
  t.tick++;
  t.updatedAt = new Date(Date.parse(t.createdAt) + t.tick).toISOString();
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  appendFileSync(path.join(root, "modern-task-requests.jsonl"), line + "\n");
  if (m.id === undefined) return;
  try {
    if (m.method === "server/discover")
      return reply(m.id, {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, extensions: { [extension]: {} } },
      });
    if (m.method === "tools/list")
      return reply(m.id, {
        resultType: "complete",
        tools: [{ name: "work", inputSchema: { type: "object" } }],
      });
    if (m.method === "tools/call") {
      const scenario = m.params.arguments.scenario || "input";
      if (scenario === "plain")
        return reply(m.id, {
          resultType: "complete",
          content: [{ type: "text", text: "immediate result" }],
        });
      const task = {
        id: randomUUID(),
        scenario,
        status: ["slow", "ttl", "terminal-change"].includes(scenario)
          ? "working"
          : ["failed"].includes(scenario)
            ? "failed"
            : ["tool-error", "seed", "seed-invalid", "invalid-tool"].includes(
                  scenario,
                )
              ? "completed"
              : "input_required",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tick: 0,
        ttlMs: scenario === "ttl" ? 50 : 60000,
        pollIntervalMs: scenario === "ttl" ? 60 : 15,
        gets: 0,
        updates: 0,
        inputRequests: {
          ask:
            scenario === "sampling"
              ? { method: "sampling/createMessage", params: initial }
              : {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Provide task value",
                    requestedSchema: ordinary,
                  },
                },
        },
        output: {
          content: [{ type: "text", text: "actual final result" }],
          ...(scenario === "tool-error" ? { isError: true } : {}),
        },
      };
      task.updatedAt = task.createdAt;
      tasks.set(task.id, task);
      const { inputRequests, result, error, ...seed } = state(task);
      return reply(m.id, { resultType: "task", ...seed });
    }
    const task = tasks.get(m.params?.taskId);
    if (m.method === "tasks/get") {
      if (!task) return error(m.id, "Task not found", -32602);
      task.gets++;
      if (task.scenario === "duplicate" && task.updates && task.gets > 3)
        touch(task, "completed");
      if (task.scenario === "terminal-change")
        touch(task, task.gets === 1 ? "completed" : "working");
      const value = state(task);
      if (task.scenario === "wrong-id") value.taskId = "wrong-task";
      if (["bad-shape", "seed-invalid"].includes(task.scenario)) {
        value.status = "completed";
        delete value.result;
        delete value.inputRequests;
      }
      if (task.scenario === "invalid-tool")
        value.result = { text: "missing content and structuredContent" };
      return reply(m.id, { resultType: "complete", ...value });
    }
    if (m.method === "tasks/update") {
      if (!task) return error(m.id, "Task not found", -32602);
      task.updates++;
      if (task.scenario === "lost-update") {
        process.exit(3);
        return;
      }
      const responses = m.params.inputResponses;
      if (task.scenario === "sampling" && !task.sampled) {
        const r = responses.ask,
          parts = Array.isArray(r.content) ? r.content : [r.content],
          use = parts.find((p) => p.type === "tool_use");
        writeFileSync(
          path.join(root, "modern-sampling-effect.txt"),
          use.input.value,
        );
        task.sampled = true;
        task.inputRequests = {
          next: {
            method: "sampling/createMessage",
            params: {
              ...initial,
              toolChoice: { mode: "none" },
              messages: [
                ...initial.messages,
                { role: "assistant", content: parts },
                {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      toolUseId: use.id,
                      content: [
                        { type: "text", text: "modern file was written" },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        };
        touch(task, "input_required");
      } else if (task.scenario === "reused") {
        task.inputRequests.ask.params.message =
          "Different request reusing the same key";
        touch(task, "input_required");
      } else if (task.scenario !== "duplicate") {
        const answer =
          responses.ask?.content?.value ||
          responses.next?.content?.text ||
          "done";
        writeFileSync(path.join(root, "modern-task-effect.txt"), answer);
        task.output = { content: [{ type: "text", text: answer }] };
        touch(task, "completed");
      }
      return reply(m.id, { resultType: "complete" });
    }
    if (m.method === "tasks/cancel") {
      if (!task) return error(m.id, "Task not found", -32602);
      writeFileSync(path.join(root, "modern-cancel-requested"), task.id);
      setTimeout(() => touch(task, "cancelled"), 100);
      return reply(m.id, { resultType: "complete" });
    }
    if (m.method === "subscriptions/listen") {
      const ids = m.params.notifications.taskIds || [],
        meta = { "io.modelcontextprotocol/subscriptionId": m.id };
      send({
        method: "notifications/subscriptions/acknowledged",
        params: { notifications: { taskIds: ids }, _meta: meta },
      });
      send({
        method: "notifications/tasks",
        params: {
          ...state(tasks.get(ids[0])),
          taskId: "foreign-not-subscribed",
          _meta: meta,
        },
      });
      if (ids[0])
        send({
          method: "notifications/tasks",
          params: { ...state(tasks.get(ids[0])), _meta: meta },
        });
      return;
    }
    return error(m.id, "Unknown modern method", -32601);
  } catch (e) {
    error(m.id, String(e));
  }
});
