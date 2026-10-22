import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/wire-server.js";
import type { Message } from "../src/runtime/types.js";

test("later compaction extends the previous summary instead of re-reading the whole history", async () => {
  const x = await setup(() => ({ text: "summary of earlier work" }));
  try {
    x.config.routes.text.contextWindow = 9000;
    x.config.routes.text.maxOutputTokens = 2000;
    const s = await x.session(),
      time = new Date().toISOString();
    x.kernel.store.put("runs", {
      id: "run_incremental",
      sessionId: s.id,
      status: "running",
      createdAt: time,
      updatedAt: time,
    });
    const messages: Message[] = [
      { role: "system", content: "instructions", timestamp: 1 },
    ];
    const add = (i: number) =>
      messages.push({
        role: "user",
        content: `message-${i} ` + "x".repeat(2400),
        timestamp: i + 2,
      });
    for (let i = 0; i < 8; i++) add(i);
    await x.kernel.context.prepare("run_incremental", "text", messages);
    const first = x.wire.requests.length;
    assert.ok(first >= 1, "the first compaction summarizes the history");
    assert.match(JSON.stringify(x.wire.requests[0].body), /message-0 /);

    for (let i = 8; i < 11; i++) add(i);
    const prepared = await x.kernel.context.prepare(
      "run_incremental",
      "text",
      messages,
    );
    const later = x.wire.requests
      .slice(first)
      .map((r) => JSON.stringify(r.body));
    assert.equal(later.length, 1, "one summary call covers the new messages");
    assert.match(later[0], /Earlier continuation summary/);
    assert.doesNotMatch(later[0], /message-0 /);
    assert.match(JSON.stringify(prepared), /continuation_summary/);
    assert.match(JSON.stringify(prepared.at(-1)), /message-10 /);

    // Unchanged history reuses the stored summary without a provider call.
    await x.kernel.context.prepare("run_incremental", "text", messages);
    assert.equal(x.wire.requests.length, first + 1);
  } finally {
    await x.close();
  }
});
