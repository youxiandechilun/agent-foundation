import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, until } from "./support/wire-server.js";

test("canonical media requests support image bytes, async video, mapped fields, cancellation and unknown-job recovery without resubmission", async () => {
  const submissions: any[] = [];
  let complete = false;
  const provider = http.createServer(async (req, res) => {
    let body: any = {};
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST")
      submissions.push({
        url: req.url,
        body,
        key: req.headers["idempotency-key"],
      });
    if (req.url === "/images")
      res.end(
        JSON.stringify({
          data: [
            {
              b64_json:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            },
          ],
        }),
      );
    else if (req.url === "/video" && req.method === "POST")
      res.end(JSON.stringify({ id: "remote-1", status: "queued" }));
    else if (req.url === "/video/remote-1/cancel")
      res.end(JSON.stringify({ id: "remote-1", status: "cancelled" }));
    else if (req.url === "/video/remote-1")
      res.end(
        JSON.stringify({
          id: "remote-1",
          status: complete ? "completed" : "running",
          progress: 0.5,
          output: complete
            ? { url: "https://cdn.example.invalid/actual-reference.mp4" }
            : undefined,
        }),
      );
    else if (req.url === "/mapped")
      res.end(
        JSON.stringify({
          task: {
            key: "mapped-1",
            state: "DONE",
            outputs: [{ url: "https://cdn.example.invalid/mapped.png" }],
          },
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(provider.address() as any).port}`;
  const x = await setup();
  try {
    x.config.routes.image = {
      ...x.config.routes.text,
      kind: "image",
      adapter: "image-json",
      baseUrl: base,
      submitPath: "/images",
    };
    x.config.routes.video = {
      ...x.config.routes.text,
      kind: "video",
      adapter: "video-job",
      baseUrl: base,
      submitPath: "/video",
      pollPath: "/video/{id}",
      cancelPath: "/video/{id}/cancel",
      pollIntervalMs: 10,
      timeoutMs: 120,
    };
    x.config.defaultRoutes.image = "image";
    x.config.defaultRoutes.video = "video";
    const image = await x.client.request("POST", "/v1/jobs", {
      projectId: x.project.id,
      kind: "image",
      prompt: "wire image",
      idempotencyKey: "image-key",
      request: {
        operation: "generate",
        inputAssets: [],
        parameters: { width: 512 },
      },
    });
    const done = await x.kernel.media.wait(image.id);
    assert.equal(done.status, "completed");
    assert.equal(
      x.kernel.store.asset((done.output as any).assetIds[0]).mime,
      "image/png",
    );
    assert.equal(submissions[0].body.width, 512);
    const duplicate = await x.client.request("POST", "/v1/jobs", {
      projectId: x.project.id,
      kind: "image",
      prompt: "wire image",
      idempotencyKey: "image-key",
      request: {
        operation: "generate",
        inputAssets: [],
        parameters: { width: 512 },
      },
    });
    assert.equal(duplicate.id, image.id);
    const video = x.kernel.media.create({
      projectId: x.project.id,
      kind: "video",
      prompt: "async",
      idempotencyKey: "video-key",
    });
    const unknown = await x.kernel.media.wait(video.id);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.remoteId, "remote-1");
    complete = true;
    const videoRoute = x.config.routes.video;
    x.config.routes.video = { ...videoRoute, baseUrl: "http://127.0.0.1:1" };
    x.kernel.media.recover(video.id);
    assert.equal((await x.kernel.media.wait(video.id)).status, "completed");
    assert.equal(submissions.filter((s) => s.url === "/video").length, 1);
    x.config.routes.video = videoRoute;
    complete = false;
    const cancelled = x.kernel.media.create({
      projectId: x.project.id,
      kind: "video",
      prompt: "cancel",
      idempotencyKey: "cancel-key",
    });
    await until(() => x.kernel.store.job(cancelled.id).remoteId);
    assert.equal(
      (await x.kernel.media.cancel(cancelled.id)).status,
      "cancelled",
    );
    x.config.routes.mapped = {
      ...x.config.routes.image,
      adapter: "media-http",
      submitPath: "/mapped",
      mapping: {
        requestTemplate: {
          engine: "{{model}}",
          description: "{{prompt}}",
          options: "{{parameters}}",
        },
        id: "task.key",
        status: "task.state",
        outputs: "task.outputs",
        progress: "task.progress",
        statuses: { DONE: "completed" },
      },
    };
    const mapped = x.kernel.media.create({
      projectId: x.project.id,
      kind: "image",
      prompt: "field mapping",
      routeId: "mapped",
      idempotencyKey: "mapped-key",
    });
    assert.equal((await x.kernel.media.wait(mapped.id)).status, "completed");
    assert.equal(
      submissions.find((s) => s.url === "/mapped").body.description,
      "field mapping",
    );
  } finally {
    await x.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
