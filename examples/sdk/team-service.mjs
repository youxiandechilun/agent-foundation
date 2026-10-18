import { once } from "node:events";
import { Kernel, loadConfig, serve } from "@local/agent-foundation";

// 运行：node team-service.mjs <config.json> [code|office]
const config = await loadConfig(process.argv[2] || "config.json");
const mode = process.argv[3] || "code";
if (mode !== "code" && mode !== "office")
  throw new Error("团队模式必须为 code 或 office");

const kernel = new Kernel(config);
let api;
try {
  await kernel.init();
  const defaultRoute = config.defaultRoutes[mode];
  for (const agent of [
    {
      id: "sdk-coordinator",
      name: "协调",
      routeId: process.env.SDK_COORDINATOR_ROUTE || defaultRoute,
      instructions:
        "统一接收需求和修改意见，完善已有职责，派工、检查结果并汇总。",
    },
    {
      id: "sdk-planner",
      name: "规划",
      routeId: process.env.SDK_PLANNER_ROUTE || defaultRoute,
      instructions: "理解目标，形成需要的需求、方案、规范与交付条件。",
    },
    {
      id: "sdk-executor",
      name: "执行",
      routeId: process.env.SDK_EXECUTOR_ROUTE || defaultRoute,
      instructions: "按确认的目标实现，完成相应测试、修复与交付检查。",
    },
  ])
    kernel.agents.put({ ...agent, mode, toolAllowlist: ["*"] });
  kernel.teams.put({
    id: "sdk-team",
    name: "示例团队",
    mode,
    coordinatorAgentId: "sdk-coordinator",
    memberAgentIds: ["sdk-planner", "sdk-executor"],
  });
  const project = await kernel.createProject("SDK 团队示例");
  const session = kernel.createSession(project.id, mode, "团队协作");
  kernel.teams.configure(session.id, {
    teamId: "sdk-team",
    kind: "task",
    goal: "通过用户统一入口接收工作要求，再审查职责、派工和汇总。",
    constraints: ["沿用现有成员及共享工作区"],
    acceptance: ["按实际任务验证产出并说明限制"],
    maxTurns: 12,
  });
  api = await serve(kernel);
  console.log(
    JSON.stringify({
      url: api.url,
      projectId: project.id,
      sessionId: session.id,
    }),
  );
  console.log(
    "宿主令牌来自配置的环境变量或 dataDir/api-token；不要将其传给模型。",
  );
  console.log(
    "使用 http-client.mjs 向上面的 sessionId 发送需求；宿主需处理审批事件。",
  );
  const shutdown = new AbortController();
  try {
    await Promise.race([
      once(process, "SIGINT", { signal: shutdown.signal }),
      once(process, "SIGTERM", { signal: shutdown.signal }),
    ]);
  } finally {
    shutdown.abort();
  }
} finally {
  if (api) await api.close();
  else await kernel.close();
}
