import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Kernel } from "../src/kernel.js";
import { Store } from "../src/store.js";
import { parseConfig } from "../src/config.js";

test("another live kernel cannot recover active runs; a dead owner's lease is recovered atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-owner-"));
  const raw = {
    dataDir: path.join(root, "data"),
    workspaceRoots: [path.join(root, "workspace")],
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        baseUrl: "http://127.0.0.1:1",
        model: "not-invoked",
      },
    },
  };
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./support/lease-owner.mjs", import.meta.url)),
      JSON.stringify(raw),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stderr.resume();
  let ready = false;
  const exited = new Promise<void>((r) => child.once("close", () => r()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("child did not acquire store")),
        5000,
      );
      child.stdout.on("data", (data) => {
        if (data.toString().includes("owned")) {
          clearTimeout(timer);
          ready = true;
          resolve();
        }
      });
      child.once("error", reject);
    });
    assert.equal(ready, true);
    assert.throws(
      () => new Kernel(parseConfig(raw)),
      /owned|locked|another|writer/i,
    );
    const observer = new Store(raw.dataDir);
    try {
      assert.equal(observer.run("child_active").status, "running");
    } finally {
      observer.close();
    }
    child.kill("SIGKILL");
    await exited;
    const recovered = new Kernel(parseConfig(raw));
    try {
      assert.equal(recovered.store.run("child_active").status, "interrupted");
    } finally {
      await recovered.close();
    }
    const next = new Kernel(parseConfig(raw));
    await next.close();
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});
