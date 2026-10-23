import { parseAdapterResult } from "../src/media/adapters.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, until } from "./support/wire-server.js";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
test("uncooperative media adapters time out without stranding shutdown or being resubmitted", async () => {
  const x = await setup();
  let submits = 0;
  try {
    x.kernel.media.adapters.register({
      id: "hanging-media",
      capabilities: {
        kinds: ["video"],
        operations: ["generate"],
        cancellation: false,
        recovery: false,
      },
      submit: () => {
        submits++;
        return new Promise(() => {});
      },
    });
    x.config.routes.hanging = {
      ...x.config.routes.text,
      kind: "video",
      adapter: "media-http",
      mediaAdapterId: "hanging-media",
      timeoutMs: 100,
    };
    const job = x.kernel.media.create({
      projectId: x.project.id,
      routeId: "hanging",
      kind: "video",
      prompt: "wait",
      idempotencyKey: "hang-once",
    });
    assert.equal((await x.kernel.media.wait(job.id)).status, "unknown");
    assert.equal(submits, 1);
    await assert.rejects(
      async () => x.kernel.media.recover(job.id),
      /remote IDs/,
    );
  } finally {
    await x.close();
  }
});
test("installed source media plugin receives actual asset bytes and calls its vendor through HTTP", async () => {
  let received: any;
  const vendor = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received = {
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ bytes: pixel }));
  });
  await new Promise<void>((r) => vendor.listen(0, "127.0.0.1", r));
  const x = await setup();
  process.env.TEST_SOURCE_MEDIA_KEY = "test-scoped-media-key";
  try {
    const installed = await x.client.request("POST", "/v1/plugins", {
      manifest: {
        schemaVersion: 1,
        id: "media_source",
        name: "source media",
        version: "1.0.0",
        entry: "index.mjs",
        envRefs: { VENDOR_KEY: "TEST_SOURCE_MEDIA_KEY" },
        mediaAdapters: ["source_image"],
        mediaCapabilities: {
          source_image: {
            kinds: ["image"],
            operations: ["edit"],
            polling: false,
            cancellation: false,
            recovery: false,
          },
        },
      },
      files: {
        "index.mjs": `export const mediaAdapters={source_image:{async submit(request,context){const response=await fetch(context.baseUrl+'/render',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.VENDOR_KEY},body:JSON.stringify({prompt:request.prompt,inputs:context.inputs,key:context.idempotencyKey})});if(!response.ok)throw Error('vendor failed');const data=await response.json();return {status:'completed',outputs:[{type:'image',base64:data.bytes,mime:'image/png'}]};}}};`,
      },
    });
    await x.client.request("PATCH", `/v1/plugins/${installed.id}`, {
      enabled: true,
      trustedHash: installed.hash,
    });
    x.config.routes.plugin_image = {
      ...x.config.routes.text,
      kind: "image",
      adapter: "custom-media",
      mediaAdapterId: "source_image",
      baseUrl: `http://127.0.0.1:${(vendor.address() as any).port}`,
    };
    const asset = await x.kernel.assets.create(
      x.project.id,
      "reference.txt",
      Buffer.from("real reference asset"),
    );
    const job = await x.client.request("POST", "/v1/jobs", {
      projectId: x.project.id,
      kind: "image",
      routeId: "plugin_image",
      prompt: "edit reference",
      idempotencyKey: "source-media-one",
      request: { operation: "edit", inputAssets: [asset.id] },
    });
    const done = await x.kernel.media.wait(job.id);
    assert.equal(done.status, "completed");
    assert.equal(
      Buffer.from(received.body.inputs[0].base64, "base64").toString(),
      "real reference asset",
    );
    assert.equal(
      received.headers.authorization,
      "Bearer test-scoped-media-key",
    );
    assert.equal(
      x.kernel.store.asset((done.output as any).assetIds[0]).mime,
      "image/png",
    );
    assert.equal((await x.kernel.media.cancel(job.id)).status, "completed");
    x.config.permissions.plugin = "deny";
    await assert.rejects(
      x.client.request("POST", "/v1/jobs", {
        projectId: x.project.id,
        kind: "image",
        routeId: "plugin_image",
        prompt: "blocked",
        idempotencyKey: "source-media-blocked",
      }),
      /403/,
    );
  } finally {
    await x.close();
    delete process.env.TEST_SOURCE_MEDIA_KEY;
    vendor.closeAllConnections();
    await new Promise<void>((r) => vendor.close(() => r()));
  }
});

test("registered media adapter invokes its real cancel method without depending on built-in cancelPath configuration", async () => {
  const requests: string[] = [];
  const vendor = http.createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        remoteId: "custom-remote",
        status:
          req.url === "/stop"
            ? "cancelled"
            : req.url === "/start"
              ? "queued"
              : "running",
      }),
    );
  });
  await new Promise<void>((r) => vendor.listen(0, "127.0.0.1", r));
  const x = await setup();
  try {
    x.kernel.media.adapters.register({
      id: "registered_video",
      capabilities: {
        kinds: ["video"],
        operations: ["generate"],
        cancellation: true,
        recovery: true,
      },
      submit: async (_r, c) =>
        parseAdapterResult(await c.request("/start", {})),
      poll: async (_id, _s, c) => parseAdapterResult(await c.request("/state")),
      cancel: async (_id, _s, c) =>
        parseAdapterResult(await c.request("/stop", {})),
      recover: async (_id, _s, c) =>
        parseAdapterResult(await c.request("/state")),
    });
    x.config.routes.registered_video = {
      ...x.config.routes.text,
      kind: "video",
      adapter: "media-http",
      mediaAdapterId: "registered_video",
      baseUrl: `http://127.0.0.1:${(vendor.address() as any).port}`,
      pollIntervalMs: 20,
    };
    const job = x.kernel.media.create({
      projectId: x.project.id,
      kind: "video",
      routeId: "registered_video",
      prompt: "cancel test",
      idempotencyKey: "registered-cancel",
    });
    await until(() => x.kernel.store.job(job.id).remoteId);
    x.config.routes.registered_video.baseUrl = "http://127.0.0.1:1";
    assert.equal((await x.kernel.media.cancel(job.id)).status, "cancelled");
    assert.ok(requests.includes("POST /stop"));
    assert.equal(requests.filter((r) => r === "POST /start").length, 1);
    delete x.config.routes.registered_video;
    assert.equal((await x.kernel.media.cancel(job.id)).status, "cancelled");
  } finally {
    await x.close();
    vendor.closeAllConnections();
    await new Promise<void>((r) => vendor.close(() => r()));
  }
});
