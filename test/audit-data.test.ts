import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setup, collect, until } from "./support/wire-server.js";

test("automatic memory excerpts are bounded and failed semantic retrieval falls back with an explicit event", async () => {
  const x = await setup();
  try {
    const content = "bounded fact ".repeat(2000);
    const memory = x.kernel.memory.put({ projectId: x.project.id, content });
    x.config.routes.embedding = {
      ...x.config.routes.text,
      kind: "embedding",
      adapter: "openai-embeddings",
      baseUrl: "http://127.0.0.1:1",
    };
    x.config.defaultRoutes.embedding = "embedding";
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "bounded fact" });
    const events = await collect(x.client, runId);
    assert.equal((await x.kernel.wait(runId)).status, "completed");
    assert.ok(events.some((e) => e.type === "memory.retrieval.degraded"));
    const body = JSON.stringify(x.wire.requests[0].body);
    assert.ok(body.includes("bounded fact") && body.includes(memory.id));
    assert.ok(!body.includes(content));
    assert.equal(
      (await x.client.request("GET", `/v1/memories/${memory.id}`)).content,
      content,
    );
    assert.equal(x.kernel.memory.get(memory.id, x.project.id).content, content);
  } finally {
    await x.close();
  }
});

test("recreating a deleted memory preserves prior revisions and cannot reassign another project's ID", async () => {
  const x = await setup();
  try {
    const memory = x.kernel.memory.put({
      projectId: x.project.id,
      content: "original durable fact",
    });
    x.kernel.memory.remove(memory.id, x.project.id);
    const next = x.kernel.memory.put({
      id: memory.id,
      projectId: x.project.id,
      content: "recreated fact",
    });
    assert.equal(next.revision, 3);
    const history = x.kernel.memory.history(memory.id, x.project.id);
    assert.equal(history.length, 3);
    assert.equal(
      history.find((r) => r.revision === 1)!.entry.content,
      "original durable fact",
    );
    x.kernel.memory.remove(memory.id, x.project.id);
    const other = await x.kernel.createProject("another");
    assert.throws(
      () =>
        x.kernel.memory.put({
          id: memory.id,
          projectId: other.id,
          content: "cross project reassignment",
        }),
      /another project/,
    );
  } finally {
    await x.close();
  }
});

test("media cannot claim completion with an empty payload, text-only image, or another project's asset", async () => {
  const x = await setup();
  try {
    const other = await x.kernel.createProject("other");
    const foreign = await x.kernel.assets.create(
      other.id,
      "foreign.png",
      Buffer.from("foreign bytes"),
    );
    for (const [index, output] of [
      { type: "image" },
      { type: "image", text: "pretend image" },
      { type: "image", assetId: foreign.id },
    ].entries()) {
      const id = "invalid_media_" + index;
      x.kernel.media.adapters.register({
        id,
        capabilities: {
          kinds: ["image"],
          operations: ["generate"],
          cancellation: false,
          recovery: false,
        },
        submit: async () => ({ status: "completed", outputs: [output as any] }),
      });
      x.config.routes[id] = {
        ...x.config.routes.text,
        kind: "image",
        adapter: "media-http",
        mediaAdapterId: id,
      };
      const job = x.kernel.media.create({
        projectId: x.project.id,
        kind: "image",
        routeId: id,
        prompt: "actual image required",
        idempotencyKey: id,
      });
      assert.notEqual(
        (await x.kernel.media.wait(job.id)).status,
        "completed",
        id,
      );
    }
  } finally {
    await x.close();
  }
});

test("asset reads and HTTP downloads reject changed bytes instead of returning a mismatched digest", async () => {
  const x = await setup();
  try {
    const asset = await x.kernel.assets.create(
      x.project.id,
      "data.txt",
      Buffer.from("original bytes"),
    );
    await writeFile(x.kernel.assets.file(asset.id), "modified bytes");
    await assert.rejects(
      x.kernel.assets.read(asset.id, x.project.id),
      /integrity|digest|changed/i,
    );
    const response = await fetch(x.api.url + `/v1/assets/${asset.id}/content`, {
      headers: { Authorization: "Bearer test-host-token-12345678901234567890" },
    });
    assert.equal(response.status, 409);
  } finally {
    await x.close();
  }
});

test("oversized tool output is archived and replaced by an explicit bounded reference, including details", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { calls: [{ name: "large_output", args: {} }] }
      : { text: "read the saved output if necessary" },
  );
  try {
    x.config.limits.maxOutputBytes = 4000;
    x.kernel.toolRegistry.register("large", () => [
      {
        name: "large_output",
        description: "return real large data",
        parameters: { type: "object" },
        risk: "read",
        capabilities: [],
        execute: async () => ({
          content: [
            { type: "text", text: "record ".repeat(15000) },
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            },
          ],
          details: { records: "detail ".repeat(15000) },
        }),
      },
    ]);
    const s = await x.session(),
      { runId } = await x.client.submit(s.id, { text: "read large result" });
    await collect(x.client, runId);
    const effect = x.kernel.store
      .list<any>("effects")
      .find((e) => e.runId === runId);
    assert.ok(Buffer.byteLength(JSON.stringify(effect.result)) < 8000);
    assert.equal(effect.result.details.truncated, true);
    assert.ok(effect.result.content.some((part: any) => part.type === "image"));
    const bytes = await x.kernel.assets.read(
      effect.result.details.fullResultAssetId,
      x.project.id,
    );
    const original = JSON.parse(bytes.toString());
    assert.equal(original.content[0].text, "record ".repeat(15000));
    assert.equal(original.details.records, "detail ".repeat(15000));
  } finally {
    await x.close();
  }
});

test("attachment preparation is cancelable during shutdown and keeps the session configuration stable", async () => {
  const x = await setup();
  let entered = false;
  try {
    x.kernel.assets.extractors.register({
      id: "blocked",
      supports: () => true,
      extract: async () => {
        entered = true;
        return new Promise(() => {});
      },
    });
    const asset = await x.kernel.assets.create(
      x.project.id,
      "blocked.bin",
      Buffer.from([1, 2, 3]),
    );
    const s = await x.session();
    const submit = x.kernel.submit(s.id, { assetIds: [asset.id] });
    const observed = submit.then(
      () => "accepted",
      () => "rejected",
    );
    await until(() => entered || undefined);
    assert.throws(
      () => x.kernel.updateSession(s.id, { mode: "code" }),
      /prepar|running|busy|active/i,
    );
    await x.kernel.close();
    assert.equal(await observed, "rejected");
  } finally {
    await x.close();
  }
});
