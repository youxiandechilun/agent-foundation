import http from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Kernel,
  parseConfig,
  serve,
  FoundationClient,
  VERSION,
} from "../dist/index.js";
// Test-only wire server. No synthetic model provider is shipped in production source/config.
let calls = 0;
const provider = http.createServer(async (req, res) => {
  for await (const _chunk of req) {
  }
  calls++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta =
    calls === 1
      ? {
          content: "Write source and continue.",
          tool_calls: [
            {
              index: 0,
              id: "compiled-call",
              type: "function",
              function: {
                name: "file_write",
                arguments: JSON.stringify({
                  path: "compiled.mjs",
                  content: "export const result = 47;\n",
                }),
              },
            },
          ],
        }
      : { content: "Completed after tool result." };
  res.end(
    `data: ${JSON.stringify({ id: "compiled", choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const root = fileURLToPath(new URL("..", import.meta.url)),
  data = path.join(root, ".agent-data-tests", randomUUID()),
  out = path.join(root, "demo-output");
await mkdir(out, { recursive: true });
const config = parseConfig({
  server: { port: 0 },
  dataDir: data,
  workspaceRoots: [path.join(data, "workspace")],
  extensions: { allowedRoots: [path.join(data, "extensions")] },
  defaultRoutes: { chat: "text", code: "text", office: "text" },
  routes: {
    text: {
      kind: "text",
      adapter: "openai-completions",
      model: "protocol-test",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      contextWindow: 128000,
    },
  },
  browser: { headless: true, allowPrivateNetwork: true },
});
const kernel = new Kernel(config),
  api = await serve(kernel, "compiled-test-token-1234567890"),
  client = new FoundationClient(api.url, "compiled-test-token-1234567890");
try {
  const project = await client.project("Compiled source smoke"),
    session = await client.session(project.id, "code"),
    { runId } = await client.submit(session.id, { text: "compiled smoke" });
  const events = [];
  for await (const event of client.events(runId)) events.push(event);
  const run = await kernel.wait(runId);
  if (run.status !== "completed") throw Error(run.error);
  const code = await readFile(
    path.join(config.workspaceRoots[0], "compiled.mjs"),
    "utf8",
  );
  if (!code.includes("47")) throw Error("Actual file write failed");
  const asset = await kernel.assets.create(
    project.id,
    "reference.json",
    Buffer.from(JSON.stringify({ actual: 47 })),
  );
  const parsed = await kernel.assets.extract(asset.id, project.id);
  if (!parsed.supported || !parsed.text.includes("47"))
    throw Error("Core attachment parser failed");
  const generated = [
    { name: asset.name, bytes: asset.size, sha256: asset.sha256 },
  ];
  const plugin = await kernel.plugins.install(
    {
      schemaVersion: 1,
      id: "compiled",
      name: "compiled worker test",
      version: "1.0.0",
      entry: "index.mjs",
      tools: [
        {
          name: "length",
          description: "length",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          risk: "read",
        },
      ],
    },
    {
      "index.mjs":
        'export async function execute(name,args){return {content:[{type:"text",text:String(args.text.length)}]}}',
    },
  );
  kernel.plugins.enable("compiled", true, plugin.hash);
  const tool = kernel.plugins.tools(project.id, config.workspaceRoots[0])[0];
  if ((await tool.execute("call", { text: "real" })).content[0].text !== "4")
    throw Error("Compiled plugin worker failed");
  const report = {
    version: VERSION,
    runtime: "foundation-owned",
    model: "test-only HTTP protocol server",
    runStatus: run.status,
    assistantMessages: events.filter(
      (e) => e.type === "assistant.message.committed",
    ).length,
    tools: events.filter((e) => e.type === "tool.started").length,
    generated,
    compiledPluginWorker: true,
    actualCode: code,
  };
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(out, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await api.close();
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
