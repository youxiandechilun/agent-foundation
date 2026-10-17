import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/wire-server.js";
import { estimateTokens, estimateTextTokens } from "../src/context.js";
import type { Message } from "../src/runtime/types.js";

test("Chinese context uses UTF-8 weighted budgets and hierarchical consolidation processes the tail segment", async () => {
  const x = await setup((body) => {
    const source = JSON.stringify(body.messages.at(-1));
    return {
      text:
        "summary ".repeat(125) +
        (source.includes("TAIL_MARKER") ? " TAIL_MARKER preserved" : ""),
    };
  });
  try {
    x.config.routes.text.contextWindow = 9000;
    x.config.routes.text.maxOutputTokens = 2000;
    const s = await x.session(),
      time = new Date().toISOString();
    x.kernel.store.put("runs", {
      id: "run_hierarchy",
      sessionId: s.id,
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    assert.ok(estimateTextTokens("中文".repeat(1000)) >= 2000);
    const messages: Message[] = [
      { role: "system", content: "instructions", timestamp: 1 },
    ];
    for (let i = 0; i < 12; i++)
      messages.push({
        role: "user",
        content: "旧资料".repeat(1400) + (i === 11 ? " TAIL_MARKER" : ""),
        timestamp: i + 2,
      });
    messages.push({ role: "user", content: "current request", timestamp: 20 });
    const prepared = await x.kernel.context.prepare(
      "run_hierarchy",
      "text",
      messages,
    );
    assert.match(JSON.stringify(prepared), /TAIL_MARKER preserved/);
    assert.ok(
      x.wire.requests.some((r) =>
        JSON.stringify(r.body.messages[0]).includes(
          "Consolidate continuation summaries",
        ),
      ),
    );
    assert.ok(estimateTokens(prepared) <= 5200);
    assert.equal(messages.length, 14);
    const count = x.wire.requests.length;
    await x.kernel.context.prepare("run_hierarchy", "text", messages);
    assert.equal(x.wire.requests.length, count);
  } finally {
    await x.close();
  }
});
