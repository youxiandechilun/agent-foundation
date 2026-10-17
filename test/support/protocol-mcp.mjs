import { createInterface } from "node:readline";
import { appendFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
const [root, mode = "modern"] = process.argv.slice(2),
  incoming = new Map(),
  tasks = new Map(),
  ambiguous = [];
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value }),
  error = (id, message, code = -32603) =>
    send({ id, error: { code, message } });
const sample = {
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Only this server question" },
      },
    ],
    maxTokens: 80,
    modelPreferences: { hints: [{ name: "UNTRUSTED_MODEL_HINT" }] },
  },
};
const inputs = {
  roots: { method: "roots/list", params: {} },
  form: {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Choose the output text",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string", minLength: 1 } },
        required: ["value"],
      },
    },
  },
};
const definitions = [
  {
    name: "work",
    description: "Actual local protocol peer",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
        sample: { type: "boolean" },
        loop: { type: "boolean" },
        delay: { type: "number" },
      },
    },
    ...(mode === "legacy-task"
      ? { execution: { taskSupport: "required" } }
      : {}),
  },
];
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  try {
    await appendFile(
      path.join(root, "requests.jsonl"),
      JSON.stringify(m) + "\n",
    );
    if (!m.method) {
      const next = incoming.get(m.id);
      incoming.delete(m.id);
      if (next) await next(m);
      return;
    }
    if (m.method === "notifications/cancelled") {
      await writeFile(
        path.join(root, "cancelled.json"),
        JSON.stringify(m.params),
      );
      return;
    }
    if (m.method === "notifications/roots/list_changed") {
      await writeFile(path.join(root, "roots-changed"), "yes");
      return;
    }
    if (m.id === undefined) return;
    if (m.method === "server/discover") {
      if (mode.startsWith("legacy"))
        return error(m.id, "Method not found", -32601);
      return result(m.id, {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: {
          tools: {},
          resources: {},
          completions: {},
          logging: {},
        },
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "local modern peer",
            version: "1",
          },
        },
      });
    }
    if (m.method === "initialize")
      return result(m.id, {
        protocolVersion: m.params.protocolVersion,
        capabilities: {
          tools: {},
          resources: { subscribe: true },
          ...(mode === "legacy-task"
            ? { tasks: { requests: { tools: { call: {} } } } }
            : {}),
        },
        serverInfo: { name: "local legacy peer", version: "1" },
      });
    if (m.method === "tools/list") return result(m.id, { tools: definitions });
    if (m.method === "completion/complete")
      return result(m.id, {
        completion: {
          values: [m.params.argument.value + "-completed"],
          hasMore: false,
        },
      });
    if (m.method === "logging/setLevel") {
      send({
        method: "notifications/message",
        params: { level: m.params.level, data: "actual peer diagnostic" },
      });
      return result(m.id, {});
    }
    if (m.method === "subscriptions/listen") {
      const meta = { "io.modelcontextprotocol/subscriptionId": m.id };
      send({
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: meta, notifications: m.params.notifications },
      });
      if (m.params.notifications.toolsListChanged)
        send({
          method: "notifications/tools/list_changed",
          params: { _meta: meta },
        });
      send({
        method: "notifications/resources/updated",
        params: { _meta: meta, uri: "file:///not-subscribed" },
      });
      return;
    }
    if (["resources/subscribe", "resources/unsubscribe"].includes(m.method))
      return result(m.id, {});
    if (m.method === "tasks/get")
      return result(m.id, tasks.get(m.params.taskId));
    if (m.method === "tasks/cancel") {
      const task = tasks.get(m.params.taskId);
      task.status = "cancelled";
      return result(m.id, task);
    }
    if (m.method === "tasks/result") {
      const task = tasks.get(m.params.taskId);
      if (task.status !== "completed") return error(m.id, task.status);
      return result(m.id, {
        _meta: {
          "io.modelcontextprotocol/related-task": { taskId: m.params.taskId },
        },
        content: [
          {
            type: "text",
            text: await readFile(path.join(root, "task-effect.txt"), "utf8"),
          },
        ],
      });
    }
    if (m.method === "tools/call") {
      if (mode === "legacy-task") {
        if (!m.params.task) return error(m.id, "Task augmentation required");
        const task = {
          taskId: "remote-task-" + m.id,
          status: "working",
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          ttl: 60000,
          pollInterval: 25,
        };
        tasks.set(task.taskId, task);
        setTimeout(async () => {
          if (task.status !== "cancelled") {
            await writeFile(
              path.join(root, "task-effect.txt"),
              m.params.arguments.value || "task output",
            );
            task.status = "completed";
          }
        }, m.params.arguments.delay || 80);
        return result(m.id, { task });
      }
      if (mode.startsWith("legacy")) {
        if (mode === "legacy-ambiguous") {
          ambiguous.push(m);
          if (ambiguous.length === 2) {
            const messages = ambiguous.splice(0).map((request) => {
              const callbackId = "callback-" + request.id;
              incoming.set(callbackId, async (reply) =>
                error(request.id, reply.error?.message || "unexpected input"),
              );
              return JSON.stringify({
                jsonrpc: "2.0",
                id: callbackId,
                ...sample,
              });
            });
            process.stdout.write(messages.join("\n") + "\n");
          }
          return;
        }
        const requests = m.params.arguments.sample ? { sample } : inputs,
          entries = Object.entries(requests),
          responses = {};
        const next = async (index) => {
          if (index === entries.length) {
            await writeFile(
              path.join(root, "effect.json"),
              JSON.stringify(responses),
            );
            return result(m.id, {
              content: [{ type: "text", text: JSON.stringify(responses) }],
            });
          }
          const [key, request] = entries[index],
            callbackId = "server-" + m.id + "-" + key;
          incoming.set(callbackId, async (response) => {
            if (response.error) return error(m.id, response.error.message);
            responses[key] = response.result;
            await next(index + 1);
          });
          send({ id: callbackId, ...request });
        };
        return next(0);
      }
      if (!m.params._meta?.["io.modelcontextprotocol/protocolVersion"])
        throw new Error("Missing per-request metadata");
      if (m.params.arguments.loop)
        return result(m.id, {
          resultType: "input_required",
          requestState: "opaque-loop",
        });
      if (m.params.requestState === undefined)
        return result(m.id, {
          resultType: "input_required",
          requestState: "opaque/状态/==",
          inputRequests: m.params.arguments.sample ? { sample } : inputs,
        });
      if (m.params.requestState !== "opaque/状态/==")
        throw new Error("Client modified opaque requestState");
      await writeFile(
        path.join(root, "effect.json"),
        JSON.stringify(m.params.inputResponses),
      );
      return result(m.id, {
        resultType: "complete",
        content: [
          { type: "text", text: JSON.stringify(m.params.inputResponses) },
        ],
      });
    }
    if (m.method === "ping") return result(m.id, {});
    return error(m.id, "Unknown method", -32601);
  } catch (e) {
    error(m.id, String(e));
  }
});
