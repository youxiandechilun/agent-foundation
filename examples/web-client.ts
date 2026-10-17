// Transport integration only; no UI is implemented here.
import { FoundationClient } from "../src/client.js";

export async function startTask(
  apiUrl: string,
  token: string,
  droppedFiles: File[],
  onEvent: (event: unknown) => void,
) {
  const client = new FoundationClient(apiUrl, token);
  const project = await client.project("网页接入示例");
  const session = await client.session(project.id, "office");
  // A future drag/drop input can pass every File here. Supported parsers decide how each asset is read.
  const assets = await Promise.all(
    droppedFiles.map((file) => client.upload(project.id, file.name, file)),
  );
  const { runId } = await client.submit(session.id, {
    text: "读取附件并完成文件任务",
    assetIds: assets.map((a) => a.id),
    clientMessageId: crypto.randomUUID(),
  });
  let cursor = 0;
  for await (const event of client.events(runId, cursor)) {
    if (event.seq !== null) cursor = event.seq;
    onEvent(event);
  }
  return { sessionId: session.id, runId, cursor };
}
