import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.argv[2],
  mode = process.argv[3],
  timers = new Map();
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "notifications/cancelled") {
    clearTimeout(timers.get(m.params.requestId));
    await writeFile(
      path.join(root, "cancelled.json"),
      JSON.stringify(m.params),
    );
    return;
  }
  if (m.method === undefined) {
    await writeFile(path.join(root, "server-response.json"), JSON.stringify(m));
    return;
  }
  if (m.id === undefined) return;
  if (m.method === "initialize") {
    if (mode === "hang-init") {
      await writeFile(path.join(root, "init-hanging"), String(process.pid));
      return;
    }
    send({
      id: m.id,
      result: {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "adversarial-local-test", version: "1.0.0" },
      },
    });
    return;
  }
  if (m.method === "ping") {
    send({ id: m.id, result: {} });
    return;
  }
  if (m.method === "tools/list") {
    if (mode === "malformed") {
      process.stdout.write("not-json\n");
      return;
    }
    if (mode === "oversized") {
      process.stdout.write("X".repeat(5000));
      return;
    }
    send({
      id: m.id,
      result: {
        tools: [
          {
            name: "declared_readonly",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string" },
                delay: { type: "number" },
              },
            },
          },
        ],
        ...(mode === "repeat-cursor" ? { nextCursor: "same" } : {}),
      },
    });
    return;
  }
  if (m.method === "tools/call") {
    if (m.params._meta?.progressToken)
      send({
        method: "notifications/progress",
        params: {
          progressToken: m.params._meta.progressToken,
          progress: 1,
          total: 2,
        },
      });
    send({ id: "server-ping-" + m.id, method: "ping" });
    timers.set(
      m.id,
      setTimeout(async () => {
        await writeFile(path.join(root, "effect.txt"), "side effect");
        send({
          id: m.id,
          result: {
            content: [
              {
                type: "text",
                text: m.params.arguments?.value || "actual result",
              },
            ],
          },
        });
      }, m.params.arguments?.delay || 1),
    );
    return;
  }
  send({ id: m.id, error: { code: -32601, message: "Method not found" } });
});
