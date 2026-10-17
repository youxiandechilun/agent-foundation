import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, FoundationClient } from "../dist/index.js";
// Live demo connects to the configured host/model. It never creates a synthetic model provider.
const config = await loadConfig(process.argv[2] || "config.json");
const token =
  process.env[config.server.tokenEnv] ||
  (await readFile(path.join(config.dataDir, "api-token"), "utf8")).trim();
const client = new FoundationClient(
  `http://127.0.0.1:${config.server.port}`,
  token,
);
const project = await client.project("Live agent task");
const session = await client.session(project.id, "chat");
const { runId } = await client.submit(session.id, {
  text: process.argv.slice(3).join(" ") || "介绍你当前可以真实调用的工具。",
});
for await (const event of client.events(runId)) {
  if (event.type === "assistant.message.delta")
    process.stdout.write(String(event.data.text));
  else if (
    [
      "approval.requested",
      "tool.started",
      "tool.settled",
      "run.completed",
    ].includes(event.type)
  )
    console.log("\n" + event.type, JSON.stringify(event.data));
}
