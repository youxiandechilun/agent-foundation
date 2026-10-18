import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Kernel, parseConfig, serve, VERSION } from "@local/agent-foundation";
import { FoundationClient } from "@local/agent-foundation/client";
import { officeIntegration } from "@local/agent-foundation/host";
import { verifyCli } from "./sdk-cli.mjs";

const cwd = process.cwd();
const packageRoot = fileURLToPath(
  new URL("../", import.meta.resolve("@local/agent-foundation")),
);
assert.equal(
  packageRoot,
  path.join(cwd, "node_modules/@local/agent-foundation/"),
);
const metadata = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
assert.equal(VERSION, metadata.version);
let calls = 0;
const provider = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(body.model, "sdk-protocol-test");
  calls++;
  const delta =
    calls === 1
      ? {
          tool_calls: [
            {
              index: 0,
              id: "sdk-write",
              type: "function",
              function: {
                name: "file_write",
                arguments: JSON.stringify({
                  path: "sdk-result.txt",
                  content: "SDK real file write\n",
                }),
              },
            },
          ],
        }
      : { content: "SDK completed" };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: "sdk", choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const rawConfig = {
  server: { port: 0 },
  dataDir: path.join(cwd, "runtime-data"),
  workspaceRoots: [path.join(cwd, "workspace")],
  extensions: { allowedRoots: [path.join(cwd, "extensions")] },
  permissions: { exec: "allow", plugin: "allow" },
  defaultRoutes: { chat: "text", code: "text", office: "text" },
  routes: {
    text: {
      kind: "text",
      adapter: "openai-completions",
      model: "sdk-protocol-test",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      contextWindow: 128000,
    },
  },
};
const config = parseConfig(rawConfig);
const kernel = new Kernel(config, { integrations: [officeIntegration()] });
let api;
const evidence = {
  node: process.version,
  version: VERSION,
  packageRoot,
  checks: {},
};
try {
  api = await serve(kernel, "sdk-test-token-local-123456789");
  const client = new FoundationClient(
    api.url,
    "sdk-test-token-local-123456789",
  );
  const project = await client.project("Independent SDK consumer");
  kernel.agents.put({
    id: "builder",
    name: "实现与测试",
    mode: "code",
    routeId: "text",
    instructions: "根据请求实现，并运行必要检查。",
    toolAllowlist: [
      "file_write",
      "exec_start",
      "exec_read",
      "exec_write",
      "exec_stop",
    ],
  });
  const session = await client.session(project.id, "code", "text", {
    agentId: "builder",
  });
  kernel.updateSession(session.id, { autonomy: "autonomous" });
  const { runId } = await client.submit(session.id, {
    text: "Write the result through the provided tool.",
  });
  const events = [];
  for await (const event of client.events(runId)) events.push(event);
  const run = await kernel.wait(runId);
  assert.equal(run.status, "completed", run.error);
  assert.equal(
    await readFile(path.join(project.root, "sdk-result.txt"), "utf8"),
    "SDK real file write\n",
  );
  assert.equal(calls, 2);
  assert(events.some((event) => event.type === "tool.started"));
  evidence.checks.modelAndFileWrite = true;
  evidence.checks.httpAndSseClient = true;

  const plugin = await kernel.plugins.install(
    {
      schemaVersion: 1,
      id: "sdk-worker",
      name: "SDK worker",
      version: "1.0.0",
      entry: "index.mjs",
      tools: [
        {
          name: "length",
          description: "Return text length",
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
        "export async function execute(name,args){return {content:[{type:'text',text:String(args.text.length)}]}}",
    },
  );
  kernel.plugins.enable("sdk-worker", true, plugin.hash);
  const tool = kernel.plugins.tools(project.id, project.root)[0];
  assert.equal(
    (await tool.execute("test", { text: "sdk-package" })).content[0].text,
    "11",
  );
  evidence.checks.sourcePluginWorker = true;

  const action = async (name, args) => {
    const submitted = await client.processAction(session.id, name, args);
    const result = await kernel.wait(submitted.runId);
    assert.equal(result.status, "completed", result.error);
    const event = kernel.store
      .replay(submitted.runId)
      .find((entry) => entry.type === "process.action.completed");
    assert(event, `Missing process evidence for ${name}`);
    return event.data.result.details;
  };
  const processRecord = await action("start", {
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      "console.log('sdk-ready');process.stdin.on('data',value=>console.log('sdk-echo:'+value.toString()));setInterval(()=>{},1000)",
    ],
  });
  await action("write", {
    processId: processRecord.id,
    text: "actual-input\n",
  });
  let processOutput = "";
  const deadline = Date.now() + 15000;
  while (
    !processOutput.includes("sdk-echo:actual-input") &&
    Date.now() < deadline
  ) {
    const output = await action("read", {
      processId: processRecord.id,
      waitMs: 250,
    });
    processOutput = output.frames.map((frame) => frame.text).join("");
    if (!processOutput.includes("sdk-echo:actual-input")) await pause(50);
  }
  assert.match(processOutput, /sdk-ready/);
  assert.match(processOutput, /sdk-echo:actual-input/);
  const stopped = await action("stop", { processId: processRecord.id });
  assert.equal(stopped.status, "stopped");
  evidence.checks.persistentExecTools = [
    "exec_start",
    "exec_write",
    "exec_read",
    "exec_stop",
  ];

  const csv = await client.office("create", project.id, {
    format: "csv",
    name: "sdk.csv",
    title: "SDK",
    rows: [["check"], [42]],
  });
  assert(
    csv.id || csv.asset?.id,
    "Packaged Office worker did not return an asset",
  );
  evidence.checks.packagedOfficeWorkerCsv = true;
  await assert.rejects(
    () =>
      client.office("create", project.id, {
        format: "docx",
        name: "sdk.docx",
        title: "SDK",
      }),
    (error) => {
      assert.match(error.message, /docx|optional|dependency|依赖/i);
      evidence.checks.optionalOfficeMissing = error.message;
      return true;
    },
  );
  evidence.checks.cli = await verifyCli(packageRoot, rawConfig);
  evidence.status = "passed";
} finally {
  if (api) await api.close();
  else await kernel.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
await mkdir(path.join(cwd, "evidence"), { recursive: true });
await writeFile(
  path.join(cwd, "evidence/runtime.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
