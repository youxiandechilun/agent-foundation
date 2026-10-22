import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FoundationClient, FoundationHttpError } from "../src/client.js";

test("device client methods preserve public states and reject malformed HTTP payloads", async () => {
  const pending = {
    state: "pending",
    userCode: "PUBLIC-CODE",
    verificationUri: "https://example.com/verify",
    verificationUriComplete: "https://example.com/verify?code=PUBLIC-CODE",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    nextPollAt: new Date().toISOString(),
    intervalSeconds: 1,
  };
  let payload: unknown = pending;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new FoundationClient(
    `http://127.0.0.1:${address.port}`,
    "token",
  );
  try {
    const start = await client.beginMCPDeviceAuth("device");
    assert.equal(start.userCode, "PUBLIC-CODE");
    assert.equal(start.verificationUri, pending.verificationUri);
    assert.deepEqual(await client.pollMCPDeviceAuth("device"), pending);

    payload = { state: "idle" };
    assert.equal((await client.mcpDeviceAuth("device")).state, "idle");
    payload = { state: "cancelled" };
    assert.equal(
      (await client.cancelMCPDeviceAuth("device")).state,
      "cancelled",
    );

    for (const state of ["authorized", "denied", "expired", "failed"]) {
      payload = {
        state,
        verificationUri: pending.verificationUri,
        expiresAt: pending.expiresAt,
        intervalSeconds: 1,
      };
      assert.equal((await client.waitMCPDeviceAuth("device")).state, state);
    }

    for (const invalid of [
      { state: "unknown" },
      { ...pending, nextPollAt: undefined },
      { ...pending, intervalSeconds: "1" },
      { ...pending, state: "authorized" },
    ]) {
      payload = invalid;
      await assert.rejects(
        client.pollMCPDeviceAuth("device"),
        (error: unknown) =>
          error instanceof FoundationHttpError &&
          error.status === 502 &&
          error.code === "invalid_response",
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
