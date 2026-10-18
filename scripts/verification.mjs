import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{info:number,low:number,moderate:number,high:number,critical:number,total:number}} Vulnerabilities */
/** @typedef {{status:"passed"|"failed"|"unavailable",vulnerabilities:Vulnerabilities|null,error?:string}} AuditResult */
/** @typedef {{name:string,status:"passed"|"failed"|"unavailable",exitCode:number|null,durationMs:number,stdoutLog:string,stderrLog:string,error?:string,tests?:{passed:number,failed:number},audit?:AuditResult}} CheckResult */

export const auditFlags = [
  "--json",
  "--fetch-retries=0",
  "--fetch-timeout=15000",
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is Vulnerabilities} */
const isVulnerabilities = (value) =>
  isObject(value) &&
  ["info", "low", "moderate", "high", "critical", "total"].every(
    (key) =>
      typeof value[key] === "number" &&
      Number.isSafeInteger(value[key]) &&
      value[key] >= 0,
  );

/** Only stdout is machine-readable; npm diagnostics must never enter its JSON parser.
 * @param {string} stdout
 * @param {number|null} exitCode
 * @returns {AuditResult}
 */
export function parseAudit(stdout, exitCode) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(stdout);
    if (isObject(value) && value.error)
      throw new Error(
        typeof value.message === "string"
          ? value.message
          : isObject(value.error) &&
              typeof value.error.summary === "string" &&
              value.error.summary
            ? value.error.summary
            : "npm audit 返回错误",
      );
    const counts =
      isObject(value) && isObject(value.metadata)
        ? value.metadata.vulnerabilities
        : undefined;
    if (!isVulnerabilities(counts))
      throw new Error("npm audit 未返回有效漏洞统计");
    return {
      status: exitCode === 0 ? "passed" : "failed",
      vulnerabilities: counts,
    };
  } catch (error) {
    return {
      status: "unavailable",
      vulnerabilities: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {string} root @param {string} output @param {string} name @param {string[]} args
 * @param {{audit?:boolean}} [options] @returns {Promise<CheckResult>}
 */
export async function runCheck(
  root,
  output,
  name,
  args,
  { audit = false } = {},
) {
  console.log("Checking " + name + "...");
  const start = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...(audit ? { timeout: 45000 } : {}),
  });
  const stdout = result.stdout || "",
    stderr = result.stderr || "";
  const error =
    result.error?.message ||
    (result.signal ? `Process terminated: ${result.signal}` : undefined);
  const stdoutLog = name + ".log",
    stderrLog = name + ".stderr.log";
  await Promise.all([
    writeFile(path.join(output, stdoutLog), stdout),
    writeFile(
      path.join(output, stderrLog),
      stderr + (error ? "\n" + error + "\n" : ""),
    ),
  ]);
  const passed = Number(stdout.match(/^# pass (\d+)\r?$/m)?.[1] || 0);
  const failed = Number(stdout.match(/^# fail (\d+)\r?$/m)?.[1] || 0);
  /** @type {AuditResult|undefined} */
  const assessment = audit
    ? error
      ? { status: "unavailable", vulnerabilities: null, error }
      : parseAudit(stdout, result.status)
    : undefined;
  /** @type {CheckResult} */
  const check = {
    name,
    status:
      assessment?.status ??
      (result.status === 0 && !error ? "passed" : "failed"),
    exitCode: result.status,
    durationMs: Date.now() - start,
    stdoutLog,
    stderrLog,
    ...(error ? { error } : {}),
    ...(passed || failed ? { tests: { passed, failed } } : {}),
    ...(assessment ? { audit: assessment } : {}),
  };
  if (check.status !== "passed") console.error(stdout + stderr + (error || ""));
  return check;
}

/** @param {string} file @param {object} report */
export async function writeReport(file, report) {
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
}
