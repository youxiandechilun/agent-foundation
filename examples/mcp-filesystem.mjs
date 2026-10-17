import readline from "node:readline";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
// Minimal real stdio MCP server exposing a bounded, read-only directory.
const root = await realpath(process.argv[2] || process.cwd());
const safe = async (relative) => {
  const target = await realpath(path.resolve(root, relative || "."));
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    throw new Error("Path denied");
  return target;
};
const tools = [
  {
    name: "read_text",
    description: "Read an actual UTF-8 file under the configured root",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list",
    description: "List files under the configured root",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "foundation-example-filesystem", version: "1.0.0" },
      };
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      const value =
        message.params.name === "read_text"
          ? (
              await readFile(await safe(message.params.arguments.path), "utf8")
            ).slice(0, 32000)
          : await readdir(root);
      result = {
        content: [
          {
            type: "text",
            text: typeof value === "string" ? value : JSON.stringify(value),
          },
        ],
      };
    } else if (message.method === "resources/list")
      result = {
        resources: [{ uri: "foundation://files", name: "Root directory" }],
      };
    else if (message.method === "resources/read")
      result = {
        contents: [
          {
            uri: message.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(await readdir(root)),
          },
        ],
      };
    else if (message.method === "prompts/list")
      result = {
        prompts: [
          { name: "review", description: "Review actual project files" },
        ],
      };
    else if (message.method === "prompts/get")
      result = {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Read the available files and identify issues with concrete evidence.",
            },
          },
        ],
      };
    else if (message.method === "ping") result = {};
    else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      continue;
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
    );
  } catch (error) {
    process.stderr.write(String(error) + "\n");
  }
}
