import ts from "typescript";
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  mkdtemp,
  cp,
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
const filter = process.argv
  .find((arg) => arg.startsWith("--filter="))
  ?.slice(9);
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
if (filter) {
  const matching = tests.filter((file) => path.basename(file).includes(filter));
  tests.splice(0, tests.length, ...matching);
}
if (!tests.length) throw Error("No matching test files");
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...tests],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
