import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  root,
  verification,
  readJson,
  writeJson,
  sha256,
  command,
  assert,
} from "./shared.mjs";
import { installConsumer } from "./consumer-install.mjs";
import { supportsNode } from "./node-version.mjs";

async function options() {
  const result = { nodes: [], package: undefined };
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index];
    assert(["--package", "--node"].includes(name), `Unknown argument: ${name}`);
    const value = process.argv[++index];
    assert(value, `Missing value for ${name}`);
    if (name === "--package") result.package = path.resolve(value);
    else result.nodes.push(value);
  }
  if (process.env.SDK_NODE_BINARIES) {
    const binaries = JSON.parse(process.env.SDK_NODE_BINARIES);
    assert(
      Array.isArray(binaries) &&
        binaries.every((value) => typeof value === "string"),
      "SDK_NODE_BINARIES must be a JSON array of absolute executable paths",
    );
    result.nodes.push(...binaries);
  }
  if (!result.nodes.length) result.nodes.push(process.execPath);
  result.nodes = [...new Set(result.nodes)];
  assert(
    result.nodes.every(path.isAbsolute),
    "Node executable paths must be absolute",
  );
  if (!result.package) {
    const pack = await readJson(path.join(verification, "sdk-package.json"));
    assert(
      pack.status === "passed",
      "Run npm run pack:sdk before consumer verification",
    );
    result.package = pack.tarball;
  }
  assert(
    result.package.endsWith(".tgz"),
    "A local npm .tgz package is required",
  );
  return result;
}

const report = {
  checkedAt: new Date().toISOString(),
  status: "failed",
  published: false,
  checks: [],
};
try {
  const settings = await options();
  const metadata = await readJson(path.join(root, "package.json"));
  const directory = await mkdtemp(path.join(tmpdir(), "agent-foundation-sdk-"));
  const relative = path.relative(root, directory);
  assert(
    relative.startsWith("..") || path.isAbsolute(relative),
    "Consumer must be outside the repository tree",
  );
  report.package = settings.package;
  report.sha256 = await sha256(settings.package);
  report.version = metadata.version;
  report.consumerDirectory = directory;
  report.engines = metadata.engines;
  for (const [index, binary] of settings.nodes.entries()) {
    const version = command(binary, ["--version"]).stdout.trim();
    const consumer = path.join(directory, String(index + 1));
    console.log(`Checking isolated SDK consumer with ${version}...`);
    const entry = { binary, node: version, consumer, status: "failed" };
    report.checks.push(entry);
    try {
      const packageRoot = await installConsumer(
        consumer,
        settings.package,
        metadata,
      );
      if (!supportsNode(version, metadata.engines.node)) {
        const diagnostic = await verifyUnsupported(
          binary,
          consumer,
          packageRoot,
        );
        Object.assign(entry, {
          status: "unsupported",
          expectedRejection: true,
          unsupportedRuntimeDiagnostic: diagnostic,
        });
        continue;
      }
      const portable = command(
        binary,
        ["--experimental-loader", "./sdk-client-loader.mjs", "sdk-client.mjs"],
        { cwd: consumer },
      );
      await writeFile(
        path.join(consumer, "client.log"),
        portable.stdout + portable.stderr,
      );
      entry.portableClientWithoutNodeBuiltins = true;
      entry.exampleSyntaxChecks = [];
      for (const example of await readdir(
        path.join(packageRoot, "examples/sdk"),
      )) {
        if (!example.endsWith(".mjs")) continue;
        command(
          binary,
          ["--check", path.join(packageRoot, "examples/sdk", example)],
          { cwd: consumer },
        );
        entry.exampleSyntaxChecks.push(example);
      }
      const typecheck = command(
        binary,
        [
          path.join(root, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "false",
          "--target",
          "ES2023",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--types",
          "node",
          "sdk-types.mts",
        ],
        { cwd: consumer },
      );
      await writeFile(
        path.join(consumer, "types.log"),
        typecheck.stdout + typecheck.stderr,
      );
      const runtime = command(binary, ["sdk-consumer.mjs"], {
        cwd: consumer,
        timeout: 120_000,
      });
      await writeFile(
        path.join(consumer, "runtime.log"),
        runtime.stdout + runtime.stderr,
      );
      await writeFile(
        path.join(verification, `sdk-consumer-${version}.log`),
        runtime.stdout + runtime.stderr,
      );
      const evidence = await readJson(
        path.join(consumer, "evidence/runtime.json"),
      );
      Object.assign(entry, {
        status: "passed",
        strictTypes: true,
        runtime: evidence,
      });
    } catch (error) {
      entry.error = error.stack || String(error);
      await writeFile(path.join(consumer, "failure.log"), entry.error);
      console.error(entry.error);
    }
  }
  report.status =
    report.checks.some((entry) => entry.status === "passed") &&
    report.checks.every(
      (entry) =>
        entry.status === "passed" ||
        (entry.status === "unsupported" && entry.expectedRejection),
    )
      ? "passed"
      : "failed";
  report.validationBoundary = {
    supportedRuntimeVersions: report.checks
      .filter((entry) => entry.status === "passed")
      .map((entry) => entry.node),
    unsupportedRuntimeVersions: report.checks
      .filter((entry) => entry.status === "unsupported")
      .map((entry) => entry.node),
    minimumExactRuntimeTested: report.checks.some(
      (entry) => entry.node === "v22.19.0",
    ),
    externalProviders: false,
    remoteServers: false,
    dockerRuntime: false,
    optionalDependencies:
      "Deliberately omitted; core, lazy host import, CSV worker and missing DOCX dependency diagnostic checked locally.",
    typescriptCompiler:
      "Repository development compiler; package and all referenced declaration dependencies resolved from isolated consumer node_modules.",
  };
  console.log(
    JSON.stringify(
      {
        status: report.status,
        package: report.package,
        runtimes: report.checks.map(({ node, status }) => ({ node, status })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  report.error = error.stack || String(error);
  console.error(report.error);
} finally {
  await writeJson(path.join(verification, "sdk-consumer.json"), report);
  if (report.status !== "passed") process.exitCode = 1;
}

async function verifyUnsupported(binary, consumer, packageRoot) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    binary,
    [
      path.join(packageRoot, "dist/cli.js"),
      "serve",
      "--config",
      "missing.json",
    ],
    {
      cwd: consumer,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    },
  );
  const output = result.stdout + result.stderr;
  assert(
    result.status !== 0 &&
      /22\.19|unsupported.*node|node.*version|node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/i.test(
        output,
      ),
    `Unsupported Node unexpectedly started or gave unrelated error: ${output}`,
  );
  return output.trim();
}
