import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  configureRedaction,
  processSecretSnapshot,
  redactJson,
  redactSecrets,
  registerSecret,
} from "../src/core/util.js";
import { parseConfig } from "../src/core/config.js";
import { Kernel } from "../src/core/kernel.js";

const scanned = "FOUNDATION_MODE_SCANNED_SECRET",
  listed = "FOUNDATION_MODE_LISTED_VALUE";

function withEnvironment(t: import("node:test").TestContext) {
  const previous = [process.env[scanned], process.env[listed]];
  process.env[scanned] = "scanned-credential-value";
  process.env[listed] = "listed-credential-value";
  t.after(() => {
    configureRedaction({ mode: "full" });
    [scanned, listed].forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  });
}

test("redaction modes choose which credentials are removed", (t) => {
  withEnvironment(t);
  const registered = `registered-${randomUUID()}`;
  registerSecret(registered, 60_000);
  const text = `${registered} scanned-credential-value listed-credential-value`;

  configureRedaction({ mode: "full" });
  // "LISTED_VALUE" does not look like a credential name, so a full scan skips it.
  assert.equal(
    redactSecrets(text),
    "[REDACTED] [REDACTED] listed-credential-value",
  );

  configureRedaction({ mode: "registered", environment: [listed] });
  assert.equal(
    redactSecrets(text),
    "[REDACTED] scanned-credential-value [REDACTED]",
  );
  assert.deepEqual(redactJson({ [registered]: registered }), {
    "[REDACTED]": "[REDACTED]",
  });
  assert.ok(processSecretSnapshot().includes(registered));

  configureRedaction({ mode: "off" });
  assert.equal(redactSecrets(text), text);
  assert.deepEqual(redactJson({ value: registered }), { value: registered });
  assert.deepEqual(processSecretSnapshot(), []);
});

test("the kernel applies its configured redaction mode", async (t) => {
  withEnvironment(t);
  const root = mkdtempSync(path.join(tmpdir(), "foundation-redaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = (redaction: unknown) =>
    parseConfig({
      dataDir: path.join(root, `data-${randomUUID()}`),
      workspaceRoots: [path.join(root, "project")],
      extensions: { allowedRoots: [path.join(root, "extensions")] },
      defaultRoutes: { chat: "t", code: "t", office: "t" },
      routes: {
        t: {
          kind: "text",
          adapter: "openai-completions",
          model: "m",
          baseUrl: "http://127.0.0.1:9",
        },
      },
      redaction,
    });
  assert.equal(config(undefined).redaction.mode, "full");
  assert.throws(() => config({ mode: "partial" }));
  assert.throws(() =>
    config({ mode: "registered", environment: ["BAD-NAME"] }),
  );

  const kernel = new Kernel(
    config({ mode: "registered", environment: [listed] }),
  );
  try {
    assert.equal(
      kernel.redaction.run(() =>
        redactSecrets("scanned-credential-value listed-credential-value"),
      ),
      "scanned-credential-value [REDACTED]",
    );
  } finally {
    await kernel.close();
  }
});
