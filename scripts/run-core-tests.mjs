import ts from "typescript";
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  mkdtemp,
  cp,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = path.join(root, ".agent-data-tests");
await mkdir(scratch, { recursive: true });
const output = await mkdtemp(path.join(scratch, "compiled-tests-"));
const host = process.argv.includes("--host"),
  browserOnly = process.argv.includes("--browser");
const tests = [];
const filters = process.argv
  .filter((arg) => arg.startsWith("--filter="))
  .map((arg) => arg.slice(9));
async function compile(directory) {
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name),
      source = path.join(root, relative);
    if (entry.isDirectory()) {
      await compile(relative);
      continue;
    }
    // Focused runs compile their selected test files plus shared helpers.
    if (
      directory === "test" &&
      entry.name.endsWith(".test.ts") &&
      filters.length &&
      !filters.some((filter) => entry.name.includes(filter))
    )
      continue;
    const target = path.join(output, relative.replace(/\.ts$/, ".js"));
    await mkdir(path.dirname(target), { recursive: true });
    if (entry.name.endsWith(".ts")) {
      const result = ts.transpileModule(await readFile(source, "utf8"), {
        fileName: relative,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          esModuleInterop: true,
        },
      });
      const errors = (result.diagnostics || []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      if (errors.length)
        throw Error(
          ts.formatDiagnosticsWithColorAndContext(errors, {
            getCanonicalFileName: (f) => f,
            getCurrentDirectory: () => root,
            getNewLine: () => "\n",
          }),
        );
      await writeFile(target, result.outputText);
      if (
        directory === "test" &&
        (browserOnly
          ? entry.name === "browser.integration.ts"
          : host
            ? entry.name.endsWith(".integration.ts")
            : entry.name.endsWith(".test.ts"))
      )
        tests.push(target);
    } else if (/\.(mjs|cjs|ps1|json|cs|py)$/.test(entry.name))
      await copyFile(source, target);
  }
}
// tsc checks the production core separately. Test source is transpiled with TypeScript,
// so --omit=optional installs do not need an optional esbuild binary or an SDK loader.
for (const directory of ["src", "test", "examples"]) await compile(directory);
if (host || browserOnly)
  await cp(
    path.join(root, "extensions/browser-bridge"),
    path.join(output, "extensions/browser-bridge"),
    { recursive: true },
  );
tests.sort();
if (process.argv.includes("--compile-only")) {
  console.log(output);
  process.exit(0);
}
if (filters.length) {
  const matching = tests.filter((file) =>
    filters.some((filter) => path.basename(file).includes(filter)),
  );
  tests.splice(0, tests.length, ...matching);
}
if (!tests.length) throw Error("No matching test files");
// Files run one at a time by default; --concurrency=N runs N test files in parallel.
const concurrency =
  process.argv
    .find((arg) => arg.startsWith("--concurrency="))
    ?.slice("--concurrency=".length) || "1";
if (!/^[1-9]\d*$/.test(concurrency)) throw Error("Invalid --concurrency");
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "--test-timeout=180000",
    `--test-concurrency=${concurrency}`,
    ...tests,
  ],
  { cwd: root, stdio: "inherit" },
);
// Compiled copies are only needed while tests run; --keep retains them for debugging.
if (!process.argv.includes("--keep"))
  await rm(output, { recursive: true, force: true, maxRetries: 3 });
else console.log(`Compiled tests kept at ${output}`);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
