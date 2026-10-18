import { FoundationClient } from "@local/agent-foundation/client";

// 先启动内核服务，再由调用方提供已有会话 ID 和宿主令牌。
const sessionId = process.argv[2];
const text = process.argv[3];
const token = process.env.AGENT_API_TOKEN;
if (!sessionId || !text || !token)
  throw new Error("需要会话 ID、需求文本和环境变量 AGENT_API_TOKEN");

const client = new FoundationClient(
  process.env.AGENT_API_URL || "http://127.0.0.1:4317",
  token,
);
const { runId } = await client.submit(sessionId, {
  text,
  clientMessageId: crypto.randomUUID(),
});
for await (const event of client.events(runId)) {
  if (event.type === "assistant.message.committed")
    console.log(JSON.stringify(event.data));
  else if (event.type === "approval.requested")
    console.log("等待宿主界面处理审批", JSON.stringify(event.data));
  else if (event.type === "run.completed")
    console.log(JSON.stringify(event.data));
}
