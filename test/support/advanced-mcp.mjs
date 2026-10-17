import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [root, mode = "sampling", protocol = "modern"] = process.argv.slice(2),
  callbacks = new Map(),
  tasks = new Map();
const related = "io.modelcontextprotocol/related-task";
let serial = 0;
const frame = (m) => JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n",
  send = (m) => process.stdout.write(frame(m)),
  result = (id, r) => send({ id, result: r });
const fail = (id, message) => send({ id, error: { code: -32603, message } });
const invoke = (method, params, taskId) => {
  const id = "input-" + ++serial;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  callbacks.set(id, resolve);
  const message = {
    id,
    method,
    params: {
      ...params,
      ...(taskId ? { _meta: { [related]: { taskId } } } : {}),
    },
  };
  return { message, promise };
};
const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const tool = {
  name: "server.write/文件",
  description: "Writes a file on this MCP server",
  inputSchema: schema,
};
const initial = {
  messages: [
    { role: "user", content: { type: "text", text: "Use the server tool" } },
  ],
  tools: [tool],
  toolChoice: { mode: "required" },
  maxTokens: 100,
};
async function sampling(call, first) {
  let response = first ? { result: first } : undefined;
  if (!response) {
    const cb = invoke("sampling/createMessage", initial);
    send(cb.message);
    response = await cb.promise;
  }
  if (response.error) return fail(call.id, response.error.message);
  const content = Array.isArray(response.result.content)
    ? response.result.content
    : [response.result.content];
  const use = content.find((x) => x.type === "tool_use");
  if (!use || use.name !== tool.name)
    return fail(call.id, "Missing expected server tool");
  writeFileSync(path.join(root, "sampling-effect.txt"), use.input.value);
  const follow = {
    messages: [
      ...initial.messages,
      { role: "assistant", content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: use.id,
            content: [{ type: "text", text: "file was written" }],
            structuredContent: { bytes: Buffer.byteLength(use.input.value) },
          },
        ],
      },
    ],
    tools: [tool],
    toolChoice: { mode: "none" },
    maxTokens: 100,
  };
  if (protocol === "modern")
    return result(call.id, {
      resultType: "input_required",
      requestState: "sampling-step-2",
      inputRequests: {
        next: { method: "sampling/createMessage", params: follow },
      },
    });
  const next = invoke("sampling/createMessage", follow);
  send(next.message);
  const final = await next.promise;
  if (final.error) return fail(call.id, final.error.message);
  writeFileSync(
    path.join(root, "sampling-reply.json"),
    JSON.stringify(final.result),
  );
  return result(call.id, {
    content: [{ type: "text", text: "server tool loop completed" }],
  });
}
async function finishTask(task, cb) {
  const reply = await cb.promise;
  writeFileSync(
    path.join(root, "task-input-" + task.taskId + ".json"),
    JSON.stringify(reply),
  );
  if (task.status === "cancelled") return;
  task.status = reply.error ? "failed" : "completed";
  task.lastUpdatedAt = new Date().toISOString();
  if (!reply.error)
    writeFileSync(
      path.join(root, "task-effect-" + task.taskId + ".txt"),
      reply.result.content?.value || reply.result.content?.text || "accepted",
    );
  task.output = {
    content: [
      {
        type: "text",
        text: reply.error ? reply.error.message : "task callback completed",
      },
    ],
    isError: !!reply.error,
    _meta: { [related]: { taskId: task.taskId } },
  };
  if (task.behavior === "result-no-meta") delete task.output._meta;
  if (task.behavior === "result-foreign")
    task.output._meta[related].taskId = "another-task";
  if (task.progressToken)
    send({
      method: "notifications/progress",
      params: {
        progressToken: task.progressToken,
        progress: 1,
        total: 1,
        _meta: { [related]: { taskId: task.taskId } },
      },
    });
  if (task.waiter) result(task.waiter, task.output);
}
async function taskSampling(task, cb) {
  const reply = await cb.promise;
  if (reply.error) return finishTask(task, { promise: Promise.resolve(reply) });
  const content = Array.isArray(reply.result.content)
      ? reply.result.content
      : [reply.result.content],
    use = content.find((p) => p.type === "tool_use");
  if (task.status === "cancelled") return;
  if (!use)
    return finishTask(task, {
      promise: Promise.resolve({ error: { message: "Missing sampling tool" } }),
    });
  writeFileSync(path.join(root, "task-sampling-effect.txt"), use.input.value);
  const next = invoke(
    "sampling/createMessage",
    {
      ...initial,
      toolChoice: { mode: "none" },
      messages: [
        ...initial.messages,
        { role: "assistant", content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: use.id,
              content: [{ type: "text", text: "async file was written" }],
            },
          ],
        },
      ],
    },
    task.taskId,
  );
  send(next.message);
  return finishTask(task, next);
}
const publicTask = (t) =>
  Object.fromEntries(
    Object.entries(t).filter(
      ([k]) => !["output", "waiter", "behavior", "progressToken"].includes(k),
    ),
  );
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  appendFileSync(path.join(root, "advanced-requests.jsonl"), line + "\n");
  try {
    if (callbacks.has(m.id) && !m.method) {
      const resolve = callbacks.get(m.id);
      callbacks.delete(m.id);
      resolve(m);
      return;
    }
    if (!m.method || m.id === undefined) return;
    if (m.method === "server/discover")
      return protocol === "legacy"
        ? send({
            id: m.id,
            error: { code: -32601, message: "Method not found" },
          })
        : result(m.id, {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          });
    if (m.method === "initialize")
      return result(m.id, {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
          ...(mode === "tasks"
            ? { tasks: { requests: { tools: { call: {} } } } }
            : {}),
        },
        serverInfo: { name: "advanced real peer", version: "1" },
      });
    if (m.method === "tools/list")
      return result(m.id, {
        tools: [
          {
            name: "work",
            inputSchema: { type: "object" },
            ...(mode === "tasks"
              ? { execution: { taskSupport: "required" } }
              : {}),
          },
        ],
      });
    if (m.method === "tools/call" && mode === "sampling") {
      if (protocol === "legacy") return await sampling(m);
      if (!m.params.requestState)
        return result(m.id, {
          resultType: "input_required",
          requestState: "sampling-step-1",
          inputRequests: {
            first: { method: "sampling/createMessage", params: initial },
          },
        });
      if (m.params.requestState === "sampling-step-1")
        return await sampling(m, m.params.inputResponses.first);
      const reply = m.params.inputResponses.next;
      writeFileSync(
        path.join(root, "sampling-reply.json"),
        JSON.stringify(reply),
      );
      return result(m.id, {
        content: [{ type: "text", text: "server tool loop completed" }],
      });
    }
    if (m.method === "tools/call" && mode === "tasks") {
      const task = {
        taskId: "task-" + m.id,
        status: "input_required",
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        ttl: m.params.arguments.ttl ?? 60000,
        pollInterval: 25,
        behavior: m.params.arguments.behavior || "wait",
        progressToken: m.params._meta?.progressToken,
      };
      tasks.set(task.taskId, task);
      if (task.behavior === "immediate") {
        const cb = invoke(
          "elicitation/create",
          { mode: "form", message: "Task input", requestedSchema: schema },
          task.taskId,
        );
        process.stdout.write(
          frame({ id: m.id, result: { task: publicTask(task) } }) +
            frame(cb.message),
        );
        void finishTask(task, cb);
      } else result(m.id, { task: publicTask(task) });
      return;
    }
    if (m.method === "tasks/get")
      return result(m.id, publicTask(tasks.get(m.params.taskId)));
    if (m.method === "tasks/result") {
      const task = tasks.get(m.params.taskId);
      if (task.output) return result(m.id, task.output);
      task.waiter = m.id;
      if (task.behavior !== "immediate") {
        const cb = invoke(
          task.behavior === "sample-tools"
            ? "sampling/createMessage"
            : "elicitation/create",
          task.behavior === "sample-tools"
            ? initial
            : { mode: "form", message: "Task input", requestedSchema: schema },
          task.behavior === "foreign"
            ? "other-task"
            : task.behavior === "no-meta"
              ? undefined
              : task.taskId,
        );
        send(cb.message);
        if (task.behavior === "sample-tools") void taskSampling(task, cb);
        else void finishTask(task, cb);
      }
      return;
    }
    if (m.method === "tasks/cancel") {
      const task = tasks.get(m.params.taskId);
      task.status = "cancelled";
      result(m.id, publicTask(task));
      const cb = invoke(
        "sampling/createMessage",
        {
          messages: [
            { role: "user", content: { type: "text", text: "Late callback" } },
          ],
          maxTokens: 20,
        },
        task.taskId,
      );
      send(cb.message);
      void cb.promise.then((r) =>
        writeFileSync(path.join(root, "late-callback.json"), JSON.stringify(r)),
      );
      return;
    }
    fail(m.id, "Unknown method");
  } catch (e) {
    fail(m.id, String(e));
  }
});
