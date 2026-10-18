import { readFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditFlags,
  parseAudit,
  runCheck,
  writeReport,
} from "./verification.mjs";
const root = fileURLToPath(new URL("..", import.meta.url)),
  out = path.join(root, "verification");
await mkdir(out, { recursive: true });
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const evidenceOnly = process.argv.includes("--evidence-only");
const reportFile = path.join(out, "application-report.json");
// Read evidence before replacing it, but capture missing input so a fresh failed report is still written.
const previous = evidenceOnly
  ? await readFile(reportFile, "utf8").then(
      (text) => ({ text }),
      (error) => ({ error }),
    )
  : undefined;
const commands = [
  ["application-build", [npm, "run", "build:host"]],
  [
    "application-integration",
    [path.join(root, "scripts/run-core-tests.mjs"), "--host"],
  ],
  ["application-dependency-audit", [npm, "audit", "--omit=dev", ...auditFlags]],
  [
    "application-compiled-smoke",
    [path.join(root, "test/smoke-host.compiled.mjs")],
  ],
];
/** @type {import("./verification.mjs").CheckResult[]} */
const checks = [];
const report = {
  version: null,
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  status: "running",
  checks,
  tests: null,
  criteria: [],
  dependencyAudit: null,
  dependencyAuditStatus: "unavailable",
};
await writeReport(reportFile, report);
try {
  report.version = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  if (evidenceOnly) {
    if (!previous || "error" in previous)
      throw previous?.error || new Error("Missing application report");
    const saved = JSON.parse(previous.text);
    if (
      saved.version !== report.version ||
      (saved.status !== undefined &&
        !["passed", "failed"].includes(saved.status)) ||
      !Array.isArray(saved.checks) ||
      !commands.every(
        ([name]) =>
          saved.checks.filter((check) => check?.name === name).length === 1,
      ) ||
      !saved.checks.every(
        (check) =>
          check &&
          typeof check.name === "string" &&
          (check.status === undefined ||
            ["passed", "failed", "unavailable"].includes(check.status)) &&
          (check.exitCode === null || Number.isInteger(check.exitCode)),
      )
    )
      throw new Error(
        "Application report missing current, completed check evidence",
      );
    checks.push(
      ...saved.checks.map((check) => ({
        ...check,
        status:
          check.status === "unavailable"
            ? "unavailable"
            : check.error || check.exitCode !== 0
              ? "failed"
              : (check.status ?? "passed"),
      })),
    );
    const auditCheck = checks.find(
      (check) => check.name === "application-dependency-audit",
    );
    // Process failure takes precedence even when stdout contains a complete JSON response.
    const audit =
      auditCheck.error ||
      auditCheck.exitCode === null ||
      auditCheck.status === "unavailable" ||
      auditCheck.audit?.status === "unavailable"
        ? {
            status: "unavailable",
            vulnerabilities: null,
            error:
              auditCheck.error ||
              auditCheck.audit?.error ||
              "Previous npm audit did not complete; rerun verification",
          }
        : parseAudit(
            await readFile(
              path.join(out, "application-dependency-audit.log"),
              "utf8",
            ),
            auditCheck.exitCode,
          );
    auditCheck.audit = audit;
    auditCheck.status = audit.status;
    report.dependencyAudit = audit.vulnerabilities;
    report.dependencyAuditStatus = audit.status;
  } else {
    for (const [name, args] of commands) {
      const check = await runCheck(root, out, name, args, {
        audit: name === "application-dependency-audit",
      });
      checks.push(check);
      if (check.audit) {
        report.dependencyAudit = check.audit.vulnerabilities;
        report.dependencyAuditStatus = check.audit.status;
      }
      await writeReport(reportFile, report);
    }
  }
  const plan = JSON.parse(
    await readFile(path.join(root, "docs/APPLICATIONS-PLAN.json"), "utf8"),
  );
  if (plan.version !== report.version)
    throw Error("Application plan version mismatch");
  const log = await readFile(
      path.join(out, "application-integration.log"),
      "utf8",
    ),
    passed = new Set([...log.matchAll(/^# Subtest: (.+)$/gm)].map((m) => m[1]));
  const count = Number(log.match(/^# tests (\d+)$/m)?.[1]),
    passCount = Number(log.match(/^# pass (\d+)$/m)?.[1]),
    skips = Number(log.match(/^# skipped (\d+)$/m)?.[1]);
  if (!(count > 0) || !/^# fail 0$/m.test(log))
    throw Error("Application log incomplete");
  report.criteria = plan.acceptance.map((criterion) => ({
    ...criterion,
    status: "not-validated",
  }));
  for (const criterion of report.criteria) {
    if (!criterion.evidence?.length)
      throw Error("Missing application evidence: " + criterion.id);
    for (const item of criterion.evidence) {
      await access(path.join(root, item.file));
      if (!passed.has(item.title))
        throw Error("Missing test title: " + item.title);
    }
    // Native platform gaps stay explicit even when the test runner reports skips.
    criterion.status =
      criterion.id === "computer-native" && process.platform !== "win32"
        ? "environment-not-validated"
        : "passed-local-acceptance";
    if (criterion.id === "release-proof") {
      let rebuilt = true;
      for (const file of [
        "clean-source-rebuild.json",
        "clean-host-source-rebuild.json",
      ]) {
        try {
          const r = JSON.parse(await readFile(path.join(out, file), "utf8"));
          rebuilt &&=
            r.version === report.version &&
            r.passed === true &&
            r.sourceHashesMatch === true;
        } catch {
          rebuilt = false;
        }
      }
      if (!rebuilt) criterion.status = "pending-source-rebuild";
    }
  }

  Object.assign(report, {
    tests: { passed: passCount, failed: 0, skipped: skips, total: count },
    deferredByUser: plan.deferredByUser,
    externalValidation: plan.externalValidation,
    notImplemented: plan.notImplemented,
    boundaries: plan.boundaries,
  });
  report.status = checks.every((check) => check.status === "passed")
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
