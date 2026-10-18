import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));

/** @param {string} log */
export function parseIntegrationLog(log) {
  const count = (label) =>
    Number(log.match(new RegExp(`^# ${label} (\\d+)\\r?$`, "m"))?.[1]);
  const tests = count("tests"),
    passed = count("pass"),
    skipped = count("skipped");
  if (
    !(tests > 0) ||
    !Number.isInteger(passed) ||
    !Number.isInteger(skipped) ||
    tests !== passed + skipped ||
    count("fail") !== 0 ||
    count("cancelled") !== 0 ||
    count("todo") !== 0
  )
    throw Error("Core integration test log is missing or incomplete");
  const records = [
    ...log.matchAll(/^ok \d+ - (.+?)(?: # (SKIP|TODO)(?: [^\r\n]*)?)?\r?$/gm),
  ];
  const passedTitles = new Set(
    records.filter((match) => !match[2]).map((match) => match[1]),
  );
  const skippedTitles = new Set(
    records.filter((match) => match[2] === "SKIP").map((match) => match[1]),
  );
  if (
    records.length !== tests ||
    passedTitles.size !== passed ||
    skippedTitles.size !== skipped
  )
    throw Error(
      "Core test results do not match their TAP summary or contain duplicate titles",
    );
  return { tests, passed, skipped, passedTitles, skippedTitles };
}

async function main() {
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
  const { passed, skipped, passedTitles, skippedTitles } =
    parseIntegrationLog(log);
  const allowedSkippedTitles = new Set();
  const results = [];
  const criterionIds = new Set();
  for (const criterion of ledger.criteria) {
    if (criterionIds.has(criterion.id))
      throw Error("Duplicate acceptance criterion: " + criterion.id);
    criterionIds.add(criterion.id);
    for (const source of [...criterion.source, criterion.evidence.file])
      await access(path.join(root, source));
    const title = criterion.evidence.title;
    if (criterion.scope === "optional-servers" && skippedTitles.has(title)) {
      allowedSkippedTitles.add(title);
      results.push({ ...criterion, status: "not-tested-optional-dependency" });
    } else if (passedTitles.has(title)) {
      results.push({ ...criterion, status: "passed-local-acceptance" });
    } else {
      throw Error("Missing passing test evidence: " + criterion.id);
    }
  }
  if ([...skippedTitles].some((title) => !allowedSkippedTitles.has(title)))
    throw Error("An unapproved core test was skipped");
  const passedResults = results.filter(
    (result) => result.status === "passed-local-acceptance",
  );
  const report = {
    schemaVersion: 2,
    version: ledger.version,
    checkedAt: new Date().toISOString(),
    coreCriteriaPassed: passedResults.filter(
      (result) => result.scope === "core",
    ).length,
    optionalCriteriaPassed: passedResults.filter(
      (result) => result.scope === "optional-servers",
    ).length,
    criteriaPassed: passedResults.length,
    criteriaNotTested: results.length - passedResults.length,
    testsPassed: passed,
    testsSkipped: skipped,
    criteria: results,
    externalValidation: ledger.externalValidation,
    deferredByUser: ledger.deferredByUser,
    supportedBoundary: ledger.supportedBoundary,
    notImplemented: ledger.notImplemented,
    outOfScope: ledger.outOfScope,
  };
  const auditPlan = JSON.parse(
    await readFile(path.join(root, "docs/CORE-AUDIT-PLAN.json"), "utf8"),
  );
  if (auditPlan.version !== manifest.version)
    throw Error("Audit plan version mismatch");
  const auditResults = results.filter((result) =>
    auditPlan.auditCriteria.includes(result.id),
  );
  if (auditResults.length !== auditPlan.regressionCriteriaCount)
    throw Error("Missing audit regression evidence");
  await writeFile(
    path.join(root, "verification/core-acceptance.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(root, "verification/audit-report.json"),
    JSON.stringify(
      {
        ...auditPlan,
        checkedAt: new Date().toISOString(),
        status: auditResults.some(
          (result) => result.status !== "passed-local-acceptance",
        )
          ? "passed-core-with-optional-not-tested"
          : "passed-this-audit-iteration",
        testsPassed: passed,
        testsSkipped: skipped,
        iterationCriteriaPassed: auditResults.filter(
          (result) => result.status === "passed-local-acceptance",
        ).length,
        iterationCriteriaNotTested: auditResults.filter(
          (result) => result.status !== "passed-local-acceptance",
        ).length,
        coreCriteriaPassed: report.coreCriteriaPassed,
        optionalCriteriaPassed: report.optionalCriteriaPassed,
        externalValidation: ledger.externalValidation,
        deferredByUser: ledger.deferredByUser,
        notImplemented: ledger.notImplemented,
        outOfScope: ledger.outOfScope,
        results: auditResults,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        coreCriteriaPassed: report.coreCriteriaPassed,
        optionalCriteriaPassed: report.optionalCriteriaPassed,
        criteriaNotTested: report.criteriaNotTested,
        testsPassed: passed,
        testsSkipped: skipped,
        externalValidation: report.externalValidation,
        deferredByUser: report.deferredByUser,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
