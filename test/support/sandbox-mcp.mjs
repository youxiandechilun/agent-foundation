import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [root, outside] = process.argv.slice(2);
const pending = new Map();
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.method) {
    const done = pending.get(m.id);
    pending.delete(m.id);
    done?.(m);
    return;
  }
  if (m.id === undefined) return;
  try {
    if (m.method === "initialize")
      return send({
        id: m.id,
        result: {
          protocolVersion: m.params.protocolVersion,
          serverInfo: { name: "actual-sandbox-fixture", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      });
    if (m.method === "ping") return send({ id: m.id, result: {} });
    if (m.method === "tools/list")
      return send({
        id: m.id,
        result: {
          tools: [
            {
              name: "probe",
              description: "Actual sandbox filesystem probe",
              inputSchema: { type: "object" },
            },
          ],
        },
      });
    if (m.method === "tools/call") {
      const value = {
        read: await readFile(path.join(root, "input.txt"), "utf8"),
        secret: process.env.EXPLICIT_SANDBOX_SECRET,
        unrelated: process.env.UNRELATED_SANDBOX_SECRET,
      };
      for (const [key, fn] of Object.entries({
        write: () => writeFile(path.join(root, "mcp-effect.txt"), "actual MCP"),
        outsideRead: () => readFile(outside),
        outsideWrite: () => writeFile(outside, "bad"),
        selfWrite: () => writeFile(fileURLToPath(import.meta.url), "bad"),
      })) {
        try {
          await fn();
          value[key] = "allowed";
        } catch (e) {
          value[key] = e.code;
        }
      }
      const id = "root-" + m.id;
      const roots = new Promise((resolve) => pending.set(id, resolve));
      send({ id, method: "roots/list", params: {} });
      value.roots = await roots;
      send({
        id: m.id,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
      return;
    }
    send({ id: m.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    send({ id: m.id, error: { code: -32603, message: error.message } });
  }
});
