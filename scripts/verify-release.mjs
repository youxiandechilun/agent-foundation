import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url)),
  output = path.join(root, "verification");
await mkdir(output, { recursive: true });
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const checks = [
  ["build", [npm, "run", "build"]],
  ["source-independence", [path.join(root, "scripts/verify-source.mjs")]],
  ["core-integration", [path.join(root, "scripts/run-core-tests.mjs")]],
  [
    "production-dependency-audit",
    [npm, "audit", "--omit=dev", "--omit=optional", "--json"],
  ],
  ["compiled-smoke", [path.join(root, "test/smoke.compiled.mjs")]],
  ["acceptance-evidence", [path.join(root, "scripts/verify-acceptance.mjs")]],
];
const results = [];
for (const [name, args] of checks) {
  console.log("Checking " + name + "...");
  const start = Date.now(),
    r = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  const log = (r.stdout || "") + (r.stderr || "");
  await writeFile(path.join(output, name + ".log"), log);
  const passed = Number(log.match(/# pass (\d+)/)?.[1] || 0),
    failed = Number(log.match(/# fail (\d+)/)?.[1] || 0);
  results.push({
    name,
    status: r.status === 0 ? "passed" : "failed",
    exitCode: r.status,
    durationMs: Date.now() - start,
    ...(passed || failed ? { tests: { passed, failed } } : {}),
  });
  if (r.status !== 0) console.error(log);
}
const audit = JSON.parse(
  await readFile(path.join(output, "production-dependency-audit.log"), "utf8"),
);
const report = {
  version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
    .version,
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  runtime: "foundation-owned",
  checks: results,
  tests: {
    passed: results.reduce((n, r) => n + (r.tests?.passed || 0), 0),
    failed: results.reduce((n, r) => n + (r.tests?.failed || 0), 0),
  },
  dependencyAudit: audit.metadata?.vulnerabilities,
  sourceManifest: "source-manifest.json",
  lockfileSha256: createHash("sha256")
    .update(await readFile(path.join(root, "package-lock.json")))
    .digest("hex"),
  validationBoundary: {
    paidModelQualityTest: false,
    textProtocols:
      "three real HTTP/SSE parsers tested against protocol servers",
    optionalHostIntegrations:
      "application plugins have separate actual-host acceptance in application-report.json; default core stays independent",

    esp32: "deferred by user",
    docker:
      "optional command, source-plugin and stdio hosts implemented; real Docker runtime acceptance is separate in docker-runtime.json",
    mcp: "declared modern/legacy profiles and OAuth exercised over real local stdio/HTTP/SSE; external vendor compatibility not exhaustive",
    oauth:
      "RFC 8628 device authorization, RFC 7592 registration management and managed multi-key JWT rotation exercised against local HTTP and trusted HTTPS peers; one rotation test waits the real 60-second publication window; external identity providers and public HTTPS hosting not validated",
    migration:
      "independent data directories, real binary assets and restart recovery tested; live cross-OS machine transfer not run",
    posixPty:
      "POSIX bridge source implemented; Linux/macOS runtime validation not run on this Windows host",
    nativePty:
      "Windows ConPTY exercised against actual terminal input, resizing and process exit",
    windowsIsolation:
      "Optional AppContainer backend tested with real commands, persistent pipes, source plugins, stdio MCP, verified child tokens, private-file and network denials, process limits, cancellation, owner crash, ACL revocation and restart recovery. Isolated PTY remains unavailable; legacy Node child stdio/IPC pipes are explicitly rejected. DLL and complex toolchain compatibility is not exhaustive.",
    deployment:
      "Single-user embedded kernel; no application account login or multi-tenant target. OAuth is optional external MCP authorization and is not instantiated without an explicit server declaration.",
    financials:
      "Configured USD prices, real protocol usage, reservations and operator reconciliation; live vendor invoices not reconciled",
  },
};
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ checks: results, tests: report.tests }, null, 2));
if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
