import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setup } from "./support/wire-server.js";

test("native search capability round-trips through route APIs and persists atomically", async () => {
  const x = await setup();
  try {
    const route = {
      ...x.kernel.config.routes.text,
      adapter: "openai-responses",
      nativeWebSearch: true,
    };
    await x.client.request("PUT", "/v1/routes/text", route);
    for (const url of ["/v1/routes", "/v1/config"]) {
      const result = await x.client.request<{
        routes: { id: string; nativeWebSearch: boolean }[];
      }>("GET", url);
      assert.equal(
        result.routes.find((r) => r.id === "text")?.nativeWebSearch,
        true,
      );
    }
    const file = path.join(x.kernel.config.dataDir, "runtime-routes.json");
    const before = await readFile(file, "utf8");
    assert.match(before, /"nativeWebSearch": true/);
    await assert.rejects(
      x.client.request("PUT", "/v1/routes/text", {
        ...route,
        adapter: "openai-completions",
      }),
    );
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(x.kernel.config.routes.text.nativeWebSearch, true);
    await x.client.request("PATCH", "/v1/routes", {
      set: { text: { ...route, nativeWebSearch: false } },
    });
    assert.equal(x.kernel.config.routes.text.nativeWebSearch, false);
    assert.match(await readFile(file, "utf8"), /"nativeWebSearch": false/);
  } finally {
    await x.close();
  }
});
