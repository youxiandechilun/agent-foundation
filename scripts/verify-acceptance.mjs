import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const ledger = JSON.parse(
  await readFile(path.join(root, "docs/CORE-ACCEPTANCE.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
if (ledger.version !== manifest.version)
  throw Error("Acceptance ledger version does not match source");
const log = await readFile(
  path.join(root, "verification/core-integration.log"),
  "utf8",
);
const testCount = Number(log.match(/^# tests (\d+)$/m)?.[1]);
if (
  !(testCount > 0) ||
  !/^# fail 0$/m.test(log) ||
  !log.includes(`# pass ${testCount}`)
)
  throw Error("Core integration test log is missing or incomplete");
const passedTitles = new Set(
  [...log.matchAll(/^# Subtest: (.+)$/gm)].map((m) => m[1]),
);
const results = [];
for (const criterion of ledger.criteria) {
  for (const source of [...criterion.source, criterion.evidence.file])
    await access(path.join(root, source));
  if (!passedTitles.has(criterion.evidence.title))
    throw Error("Missing passing test evidence: " + criterion.id);
  results.push({ ...criterion, status: "passed-local-acceptance" });
}
const report = {
  schemaVersion: 1,
  version: ledger.version,
  checkedAt: new Date().toISOString(),
  coreCriteriaPassed: results.length,
  testsPassed: testCount,
  criteria: results,
  externalValidation: ledger.externalValidation,
  deferredByUser: ledger.deferredByUser,
  supportedBoundary: ledger.supportedBoundary,
  notImplemented: ledger.notImplemented,
  outOfScope: ledger.outOfScope,
};
await writeFile(
  path.join(root, "verification/core-acceptance.json"),
  JSON.stringify(report, null, 2),
);
const auditPlan = JSON.parse(
  await readFile(path.join(root, "docs/CORE-AUDIT-PLAN.json"), "utf8"),
);
if (auditPlan.version !== manifest.version)
  throw Error("Audit plan version mismatch");
const auditResults = results.filter((result) =>
  auditPlan.auditCriteria.includes(result.id),
);
if (auditResults.length !== auditPlan.newRegressionTests)
  throw Error("Missing audit regression evidence");
await writeFile(
  path.join(root, "verification/audit-report.json"),
  JSON.stringify(
    {
      ...auditPlan,
      checkedAt: new Date().toISOString(),
      status: "passed-this-audit-iteration",
      testsPassed: testCount,
      newAuditTestsPassed: auditResults.length,
      coreCriteriaPassed: results.length,
      results: auditResults,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      coreCriteriaPassed: results.length,
      testsPassed: testCount,
      externalValidation: report.externalValidation,
      deferredByUser: report.deferredByUser,
    },
    null,
    2,
  ),
);
