import assert from "node:assert/strict";
import { test } from "node:test";
import type { Asset, FoundationEvent } from "../src/contracts.js";
import { setup } from "./support/wire-server.js";

const headers = {
  Authorization: "Bearer test-host-token-12345678901234567890",
};

test("resource routes retain upload status, binary bytes and encoded download filenames", async () => {
  const x = await setup();
  try {
    const name = "附件 空格.bin",
      bytes = Buffer.from([0, 255, 1, 128, 42]);
    const uploaded = await fetch(
      `${x.api.url}/v1/assets?projectId=${x.project.id}&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers,
        body: bytes,
      },
    );
    assert.equal(uploaded.status, 201);
    const value: unknown = await uploaded.json();
    assert.ok(
      value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string",
    );
    const asset = await x.client.request<Asset>(
      "GET",
      `/v1/assets/${value.id}`,
    );
    assert.equal(asset.name, name);
    const download = await fetch(`${x.api.url}/v1/assets/${asset.id}/content`, {
      headers,
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-length"), String(bytes.length));
    assert.equal(download.headers.get("content-type"), asset.mime);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      download.headers.get("content-disposition"),
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  } finally {
    await x.close();
  }
});

test("run routes preserve Last-Event-ID replay for JSON and SSE and missing-session validation order", async () => {
  const x = await setup();
  try {
    const session = await x.session();
    const { runId } = await x.client.submit(session.id, {
      text: "route replay",
    });
    await x.kernel.wait(runId);
    const all = x.kernel.store.replay(runId, 0);
    assert.ok(all.length > 2);
    const after = all[1].seq;
    assert.equal(typeof after, "number");
    const replayHeaders = { ...headers, "Last-Event-ID": String(after) };
    const response = await fetch(
      `${x.api.url}/v1/runs/${runId}/events?format=json`,
      { headers: replayHeaders },
    );
    assert.equal(response.status, 200);
    const replay: unknown = await response.json();
    assert.ok(replay && typeof replay === "object" && "events" in replay);
    assert.deepEqual(replay.events, all.slice(2));
    const stream = await fetch(`${x.api.url}/v1/runs/${runId}/events`, {
      headers: replayHeaders,
    });
    assert.equal(stream.status, 200);
    assert.match(
      stream.headers.get("content-type") || "",
      /^text\/event-stream/,
    );
    const eventIds = [...(await stream.text()).matchAll(/^id: (\d+)$/gm)].map(
      (match) => Number(match[1]),
    );
    assert.deepEqual(
      eventIds,
      all.slice(2).map((event: FoundationEvent) => event.seq),
    );
    for (const [method, suffix] of [
      ["PATCH", ""],
      ["POST", "/inputs"],
    ]) {
      const missing = await fetch(`${x.api.url}/v1/sessions/missing${suffix}`, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: "not json",
      });
      assert.equal(missing.status, 404);
      await missing.json();
    }
  } finally {
    await x.close();
  }
});
