import { Kernel, loadConfig } from "@local/agent-foundation";

// 运行：node embedded.mjs <config.json> [需求文本]
const configFile = process.argv[2] || "config.json";
const text = process.argv[3] || "阅读项目文件，说明结构和建议。";
const kernel = new Kernel(await loadConfig(configFile));
try {
  await kernel.init();
  kernel.agents.put({
    id: "sdk-reader",
    name: "项目分析",
    mode: "code",
    instructions: "根据实际文件回答问题，说明依据与不确定项。",
    toolAllowlist: ["file_list", "file_read", "file_search", "file_glob"],
    memoryNamespace: "sdk-reader",
  });
  const project = await kernel.createProject("SDK 示例");
  const session = kernel.createSession(
    project.id,
    "code",
    "分析项目",
    undefined,
    "sdk-reader",
  );
  kernel.updateSession(session.id, { subagentsEnabled: false });
  const { runId } = await kernel.submit(session.id, { text });
  const run = await kernel.wait(runId);
  for (const event of kernel.store.replay(runId)) {
    if (event.type === "assistant.message.committed")
      console.log(JSON.stringify(event.data));
  }
  console.log(JSON.stringify({ runId, status: run.status, error: run.error }));
  if (run.status !== "completed") process.exitCode = 1;
} finally {
  await kernel.close();
}
