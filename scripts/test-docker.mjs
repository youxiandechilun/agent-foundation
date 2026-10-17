// Real engine acceptance. No mocked CLI/daemon and no automatic image download.
import { mkdtemp, writeFile, chmod, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Kernel, parseConfig, CommandRunner, VERSION } from "../dist/index.js";

const report = {
  version: VERSION,
  checkedAt: new Date().toISOString(),
  status: "not-run",
  tests: [],
  reason: undefined,
};
const root = await mkdtemp(path.resolve(".agent-data-tests/docker-"));
const workspace = path.join(root, "project");
await mkdir(workspace);
await chmod(workspace, 0o777);
const config = parseConfig({
  dataDir: path.join(root, "data"),
  workspaceRoots: [workspace],
  extensions: {
    executionBoundary: "docker",
    allowedRoots: [path.join(root, "extensions")],
  },
  defaultRoutes: { chat: "t", code: "t", office: "t" },
  routes: {
    t: {
      kind: "text",
      adapter: "openai-completions",
      model: "unused",
      baseUrl: "http://127.0.0.1:1",
    },
  },
  execution: {
    boundary: "docker",
    requireIsolation: true,
    dockerImage: process.env.FOUNDATION_DOCKER_IMAGE || "node:22-bookworm-slim",
  },
});
const runner = new CommandRunner(config);
let kernel;
try {
  try {
    await runner.probe(workspace);
  } catch (e) {
    report.status = "environment-unavailable";
    report.reason = e.message;
    process.exitCode = 2;
  }
  if (report.status !== "environment-unavailable") {
    await writeFile(path.join(root, "host-only.txt"), "host-only-secret");
    await writeFile(path.join(workspace, "input.txt"), "project-input");
    const inspect = await runner.run(
      {
        command: "node",
        args: [
          "-e",
          `const fs=require('node:fs'),os=require('node:os');let outside=false,rootWrite=false;try{fs.readFileSync(${JSON.stringify(path.join(root, "host-only.txt"))});outside=true}catch{}try{fs.writeFileSync('/root-write-denied','no');rootWrite=true}catch{}fs.writeFileSync('/workspace/actual-output.txt','container-write');console.log(JSON.stringify({uid:process.getuid(),outside,rootWrite,interfaces:Object.keys(os.networkInterfaces()),input:fs.readFileSync('/workspace/input.txt','utf8')}))`,
        ],
        cwd: workspace,
        timeoutMs: 15000,
      },
      workspace,
    );
    assert.equal(inspect.exitCode, 0, inspect.stderr);
    const result = JSON.parse(inspect.stdout);
    assert.notEqual(result.uid, 0);
    assert.equal(result.outside, false);
    assert.equal(result.rootWrite, false);
    assert.deepEqual(result.interfaces, ["lo"]);
    assert.equal(result.input, "project-input");
    assert.equal(
      await readFile(path.join(workspace, "actual-output.txt"), "utf8"),
      "container-write",
    );
    report.tests.push(
      "non-root UID, host path isolation, read-only root, network namespace, real workspace read/write",
    );
    kernel = new Kernel(config);
    await kernel.init();
    const project = await kernel.createProject("docker acceptance"),
      session = kernel.createSession(project.id, "code");
    await chmod(project.root, 0o777);
    const plugin = await kernel.plugins.install(
      {
        schemaVersion: 1,
        id: "isolated_acceptance",
        name: "Container acceptance",
        version: "1.0.0",
        entry: "index.mjs",
        tools: [
          {
            name: "inspect",
            description: "Verify actual container filesystem",
            parameters: { type: "object" },
            capabilities: ["files.read", "files.write"],
          },
        ],
      },
      {
        "index.mjs": `import fs from 'node:fs/promises';export async function execute(n,a,c){let sourceWrite=false,rootWrite=false;await fs.readFile('/plugin/index.mjs');try{await fs.writeFile('/plugin/index.mjs','changed');sourceWrite=true}catch{}try{await fs.writeFile('/host-root-write','changed');rootWrite=true}catch{}await fs.writeFile(c.projectRoot+'/plugin-result.txt','actual isolated plugin');return {uid:process.getuid(),sourceWrite,rootWrite,projectRoot:c.projectRoot};}`,
      },
    );
    kernel.plugins.enable(plugin.id, true, plugin.hash);
    const [pluginTool] = kernel.plugins.tools(project.id, project.root);
    const pluginResult = await pluginTool.execute("container-plugin", {});
    assert.notEqual(pluginResult.details.uid, 0);
    assert.equal(pluginResult.details.sourceWrite, false);
    assert.equal(pluginResult.details.rootWrite, false);
    assert.equal(pluginResult.details.projectRoot, "/workspace");
    assert.equal(
      await readFile(path.join(project.root, "plugin-result.txt"), "utf8"),
      "actual isolated plugin",
    );
    report.tests.push(
      "source plugin executes as non-root with readable immutable source and actual scoped workspace output",
    );
    await writeFile(
      path.join(project.root, "mcp-server.mjs"),
      await readFile(
        new URL("../examples/mcp-filesystem.mjs", import.meta.url),
      ),
    );
    kernel.mcp.install({
      id: "container_files",
      name: "Container stdio filesystem",
      transport: "stdio",
      command: "node",
      args: ["/workspace/mcp-server.mjs", "/workspace"],
      isolation: {
        boundary: "docker",
        workspaceRoot: project.root,
        readOnly: true,
      },
    });
    await kernel.mcp.connect("container_files");
    const mcpTools = await kernel.mcp.tools(),
      readTool = mcpTools.find(
        (t) => t.name === "mcp_container_files_read_text",
      );
    assert.ok(readTool);
    assert.equal(
      (await readTool.execute("container-mcp", { path: "plugin-result.txt" }))
        .content[0].text,
      "actual isolated plugin",
    );
    await kernel.mcp.disconnect("container_files");
    report.tests.push(
      "MCP stdio negotiates and executes over a real isolated container with a read-only workspace",
    );
    const p = await kernel.processes.start(session.id, {
      command: "node",
      args: [
        "-e",
        "console.log('container-ready');process.stdin.on('data',b=>console.log('received:'+b.toString()));setInterval(()=>{},1000)",
      ],
    });
    await kernel.processes.write(p.id, session.id, "actual-input\n");
    let seen = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const data = await kernel.processes.read(p.id, session.id, 0, 500);
      if (
        data.frames
          .map((f) => f.text)
          .join("")
          .includes("received:actual-input")
      ) {
        seen = true;
        break;
      }
    }
    assert.ok(seen, "container stdin did not reach actual process");
    await kernel.processes.stop(p.id, session.id);
    report.tests.push(
      "persistent container stdin/output, termination and cleanup",
    );
    const pty = await kernel.processes.start(session.id, {
      command: "node",
      args: [
        "-e",
        "console.log(JSON.stringify({tty:!!process.stdin.isTTY,cols:process.stdout.columns}));setInterval(()=>{},1000)",
      ],
      pty: true,
      cols: 93,
      rows: 31,
    });
    let terminal = false;
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const data = await kernel.processes.read(pty.id, session.id, 0, 500);
      if (
        data.frames
          .map((f) => f.text)
          .join("")
          .includes('"tty":true')
      ) {
        terminal = true;
        break;
      }
    }
    assert.ok(terminal, "no actual container TTY");
    await kernel.processes.stop(pty.id, session.id);
    report.tests.push("actual container PTY");
    report.status = "passed";
  }
} catch (e) {
  report.status = "failed";
  report.reason = String(e.stack || e);
  process.exitCode = 1;
} finally {
  try {
    await kernel?.close();
  } catch (e) {
    report.status = "failed";
    report.reason = String(e);
    process.exitCode = 1;
  }
  await mkdir("verification", { recursive: true });
  await writeFile(
    "verification/docker-runtime.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
