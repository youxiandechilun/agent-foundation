import type { StoredMessage } from "../../contracts.js";
import { id } from "../util.js";

/** Supply durable failure results for tool calls interrupted by a stopped host. */
export function repairHistory(history: StoredMessage[]): StoredMessage[] {
  const output: StoredMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.message.role === "system") continue;
    output.push(item);
    if (item.message.role !== "assistant") continue;
    const calls = item.message.content.filter((c) => c.type === "toolCall"),
      results = new Set<string>();
    let j = i + 1;
    while (j < history.length && history[j].message.role === "toolResult") {
      const result = history[j].message;
      if (result.role === "toolResult") results.add(result.toolCallId);
      j++;
    }
    for (const call of calls)
      if (!results.has(call.id))
        output.push({
          id: id("message"),
          runId: item.runId,
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            isError: true,
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text: "Previous host stopped before a durable tool result. Outcome unknown. Inspect effect log and actual state before repeating this operation.",
              },
            ],
          },
        });
  }
  return output;
}
