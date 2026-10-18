import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const counts = z.object({
  info: z.number(),
  low: z.number(),
  moderate: z.number(),
  high: z.number(),
  critical: z.number(),
  total: z.number(),
});
const reportSchema = z.object({
  version: z.string().nullable(),
  checkedAt: z.string(),
  status: z.enum(["passed", "failed"]),
  dependencyAudit: counts.nullable(),
  dependencyAuditStatus: z.enum(["passed", "failed", "unavailable"]),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      exitCode: z.number().nullable(),
      error: z.string().optional(),
      audit: z
        .object({
          status: z.string(),
          vulnerabilities: counts.nullable(),
          error: z.string().optional(),
        })
        .optional(),
    }),
  ),
  error: z.string().optional(),
});
const tap =
  "TAP version 13\n# Subtest: fixture passes\nok 1 - fixture passes\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-verification-"));
  t.after(async () => {
    assert.equal(path.dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of ["scripts", "test", "docs", "verification"])
    await mkdir(path.join(root, directory));
  for (const file of [
    "verification.mjs",
    "verify-release.mjs",
    "verify-applications.mjs",
  ])
    await copyFile(
      path.join(process.cwd(), "scripts", file),
      path.join(root, "scripts", file),
    );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "fixture-current", type: "module" }),
  );
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(path.join(root, "test/fixture.ts"), "// fixture evidence");
  await writeFile(
    path.join(root, "docs/APPLICATIONS-PLAN.json"),
    JSON.stringify({
      version: "fixture-current",
      acceptance: [
        {
          id: "fixture",
          evidence: [{ file: "test/fixture.ts", title: "fixture passes" }],
        },
      ],
    }),
  );
  for (const file of [
    "scripts/verify-source.mjs",
    "scripts/verify-acceptance.mjs",
    "test/smoke.compiled.mjs",
    "test/smoke-host.compiled.mjs",
  ])
    await writeFile(path.join(root, file), 'console.log("fixture completed");');
  await writeFile(
    path.join(root, "scripts/run-core-tests.mjs"),
    `process.stdout.write(${JSON.stringify(tap)});`,
  );
  const npm = path.join(root, "scripts/npm-fixture.mjs");
  await writeFile(
    npm,
    `
const mode = process.env.VERIFICATION_TEST_MODE;
if (process.argv[2] === "audit") {
  process.stderr.write("npm diagnostic on stderr\\n");
  if (mode === "unavailable") {
    console.log(JSON.stringify({message:"registry request timed out", error:{summary:"ETIMEDOUT"}}));
    process.exitCode = 1;
  } else if (mode === "invalid") console.log("{invalid JSON");
  else {
    const total = mode === "vulnerable" ? 1 : 0;
    console.log(JSON.stringify({metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:total,total}}}));
    process.exitCode = total;
  }
} else if (mode === "build-failed" && process.argv.includes("build:host")) {
  process.stdout.write("build output before failure\\n");
  process.stderr.write("build diagnostics\\n"); process.exitCode = 2;
}
`,
  );
  return {
    root,
    async run(kind: "core" | "host", mode: string, evidenceOnly = false) {
      const reportFile = path.join(
        root,
        "verification",
        kind === "core" ? "report.json" : "application-report.json",
      );
      if (!evidenceOnly)
        await writeFile(
          reportFile,
          JSON.stringify({
            version: "stale",
            status: "passed",
            dependencyAudit: { total: 0 },
          }),
        );
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            root,
            "scripts",
            kind === "core" ? "verify-release.mjs" : "verify-applications.mjs",
          ),
          ...(evidenceOnly ? ["--evidence-only"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            npm_execpath: npm,
            VERIFICATION_TEST_MODE: mode,
          },
        },
      );
      assert.equal(result.error, undefined, result.stderr);
      return {
        result,
        report: reportSchema.parse(
          JSON.parse(await readFile(reportFile, "utf8")),
        ),
      };
    },
  };
}

test("core verifier separates audit JSON from stderr and replaces stale success after registry failure", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("core", "unavailable");
  assert.equal(result.status, 1);
  assert.equal(report.version, "fixture-current");
  assert.equal(report.status, "failed");
  assert.equal(report.dependencyAuditStatus, "unavailable");
  assert.equal(report.dependencyAudit, null);
  assert.equal(report.checks.length, 6);
  const stdout = await readFile(
    path.join(x.root, "verification/production-dependency-audit.log"),
    "utf8",
  );
  assert.doesNotThrow(() => JSON.parse(stdout));
  assert.doesNotMatch(stdout, /npm diagnostic/);
  assert.match(
    await readFile(
      path.join(x.root, "verification/production-dependency-audit.stderr.log"),
      "utf8",
    ),
    /npm diagnostic/,
  );
});

test("a zero-exit subprocess with invalid audit JSON still fails and writes unavailable", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("core", "invalid");
  assert.equal(result.status, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.dependencyAudit, null);
  assert.equal(report.dependencyAuditStatus, "unavailable");
});

test("audit findings remain failed with the actual vulnerability count", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("core", "vulnerable");
  assert.equal(result.status, 1);
  assert.equal(report.dependencyAuditStatus, "failed");
  assert.equal(report.dependencyAudit?.critical, 1);
  assert.equal(report.dependencyAudit?.total, 1);
});

test("valid audit JSON with stderr diagnostics can pass without contaminating the report", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("core", "clean");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, "passed");
  assert.equal(report.dependencyAuditStatus, "passed");
  assert.equal(report.dependencyAudit?.total, 0);
});

test("host build failure writes the current failed report and still records remaining checks", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("host", "build-failed");
  assert.equal(result.status, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.checks.length, 4);
  assert.equal(report.checks[0].exitCode, 2);
  assert.equal(report.dependencyAuditStatus, "passed");
});

test("host registry failure remains unavailable with no invented zero vulnerabilities", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("host", "unavailable");
  assert.equal(result.status, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.dependencyAuditStatus, "unavailable");
  assert.equal(report.dependencyAudit, null);
});

test("evidence-only without an existing host report writes a failed current report", async (t) => {
  const x = await fixture(t),
    { result, report } = await x.run("host", "clean", true);
  assert.equal(result.status, 1);
  assert.equal(report.version, "fixture-current");
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /ENOENT/);
  assert.equal(report.dependencyAudit, null);
});

test("missing host acceptance inputs cannot leave the previous successful report intact", async (t) => {
  const x = await fixture(t);
  await rm(path.join(x.root, "docs/APPLICATIONS-PLAN.json"));
  const { result, report } = await x.run("host", "clean");
  assert.equal(result.status, 1);
  assert.equal(report.version, "fixture-current");
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /ENOENT/);
  assert.equal(report.checks.length, 4);
});

test("evidence-only accepts same-version legacy reports with no report or check status", async (t) => {
  const x = await fixture(t),
    initial = await x.run("host", "clean");
  assert.equal(initial.result.status, 0);
  await writeFile(
    path.join(x.root, "verification/application-report.json"),
    JSON.stringify({
      ...initial.report,
      status: undefined,
      checks: initial.report.checks.map((check) => ({
        ...check,
        status: undefined,
      })),
    }),
  );
  const { result, report } = await x.run("host", "clean", true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, "passed");
  assert.equal(report.dependencyAuditStatus, "passed");
  assert.ok(report.checks.every((check) => check.status === "passed"));
});

test("evidence-only preserves audit process errors and unavailable states despite complete stdout", async (t) => {
  const x = await fixture(t),
    initial = await x.run("host", "clean");
  for (const failure of [
    { status: "failed", exitCode: null, error: "spawnSync ETIMEDOUT" },
    { status: "unavailable", exitCode: 0, error: undefined },
  ]) {
    await writeFile(
      path.join(x.root, "verification/application-report.json"),
      JSON.stringify({
        ...initial.report,
        status: "failed",
        checks: initial.report.checks.map((check) =>
          check.name === "application-dependency-audit"
            ? { ...check, ...failure, audit: undefined }
            : check,
        ),
      }),
    );
    const { result, report } = await x.run("host", "clean", true);
    assert.equal(result.status, 1);
    assert.equal(report.dependencyAuditStatus, "unavailable");
    assert.equal(report.dependencyAudit, null);
    const audit = report.checks.find(
      (check) => check.name === "application-dependency-audit",
    );
    assert.equal(audit?.status, "unavailable");
    assert.equal(audit?.audit?.vulnerabilities, null);
    if (failure.error) assert.equal(audit?.audit?.error, failure.error);
  }
});
