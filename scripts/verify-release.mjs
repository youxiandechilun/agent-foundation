import { mkdir, readFile } from "node:fs/promises";
import { auditFlags, runCheck, writeReport } from "./verification.mjs";
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
  ["test-types", [npm, "run", "check:tests"]],
  ["lint", [npm, "run", "lint"]],
  ["format", [npm, "run", "format:check"]],
  ["source-independence", [path.join(root, "scripts/verify-source.mjs")]],
  ["core-integration", [path.join(root, "scripts/run-core-tests.mjs")]],
  [
    "production-dependency-audit",
    [npm, "audit", "--omit=dev", "--omit=optional", ...auditFlags],
  ],
  ["compiled-smoke", [path.join(root, "test/smoke.compiled.mjs")]],
  ["acceptance-evidence", [path.join(root, "scripts/verify-acceptance.mjs")]],
];
/** @type {import("./verification.mjs").CheckResult[]} */
const results = [];
const report = {
  version: null,
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  runtime: "foundation-owned",
  status: "running",
  checks: results,
  tests: { passed: 0, failed: 0 },
  dependencyAudit: null,
  dependencyAuditStatus: "unavailable",
  sourceManifest: "source-manifest.json",
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
const reportFile = path.join(output, "report.json");
await writeReport(reportFile, report);
try {
  report.version = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  for (const [name, args] of checks) {
    const check = await runCheck(root, output, name, args, {
      audit: name === "production-dependency-audit",
    });
    results.push(check);
    report.tests.passed += check.tests?.passed || 0;
    report.tests.failed += check.tests?.failed || 0;
    if (check.audit) {
      report.dependencyAudit = check.audit.vulnerabilities;
      report.dependencyAuditStatus = check.audit.status;
    }
    await writeReport(reportFile, report);
  }
  Object.assign(report, {
    lockfileSha256: createHash("sha256")
      .update(await readFile(path.join(root, "package-lock.json")))
      .digest("hex"),
  });
  report.status = results.every((check) => check.status === "passed")
    ? "passed"
    : "failed";
} catch (error) {
  report.status = "failed";
  Object.assign(report, {
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(error);
} finally {
  report.checkedAt = new Date().toISOString();
  await writeReport(reportFile, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}
