import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)),
  out = path.join(root, "verification");
await mkdir(out, { recursive: true });
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const checks = process.argv.includes("--evidence-only")
  ? JSON.parse(
      await readFile(path.join(out, "application-report.json"), "utf8"),
    ).checks
  : [];
for (const [name, args] of process.argv.includes("--evidence-only")
  ? []
  : [
      ["application-build", [npm, "run", "build:host"]],
      [
        "application-integration",
        [path.join(root, "scripts/run-core-tests.mjs"), "--host"],
      ],
      ["application-dependency-audit", [npm, "audit", "--omit=dev", "--json"]],
      [
        "application-compiled-smoke",
        [path.join(root, "test/smoke-host.compiled.mjs")],
      ],
    ]) {
  console.log("Checking " + name + "...");
  const began = Date.now(),
    result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  const log = (result.stdout || "") + (result.stderr || "");
  await writeFile(path.join(out, name + ".log"), log);
  checks.push({
    name,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - began,
  });
  if (result.status !== 0) {
    console.error(log);
    throw Error("Application check failed: " + name);
  }
}
const plan = JSON.parse(
    await readFile(path.join(root, "docs/APPLICATIONS-PLAN.json"), "utf8"),
  ),
  manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
if (plan.version !== manifest.version)
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
for (const criterion of plan.acceptance) {
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
          r.version === manifest.version &&
          r.passed === true &&
          r.sourceHashesMatch === true;
      } catch {
        rebuilt = false;
      }
    }
    if (!rebuilt) criterion.status = "pending-source-rebuild";
  }
}
const audit = JSON.parse(
  await readFile(path.join(out, "application-dependency-audit.log"), "utf8"),
);
const report = {
  version: manifest.version,
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  checks,
  tests: { passed: passCount, failed: 0, skipped: skips, total: count },
  criteria: plan.acceptance,
  dependencyAudit: audit.metadata?.vulnerabilities,
  deferredByUser: plan.deferredByUser,
  externalValidation: plan.externalValidation,
  notImplemented: plan.notImplemented,
  boundaries: plan.boundaries,
};
await writeFile(
  path.join(out, "application-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      tests: report.tests,
      criteriaPassed: report.criteria.filter(
        (c) => c.status === "passed-local-acceptance",
      ).length,
      dependencyAudit: report.dependencyAudit,
    },
    null,
    2,
  ),
);
