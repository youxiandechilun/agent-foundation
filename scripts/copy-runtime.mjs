import { copyFile, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/execution/native/", import.meta.url), {
  recursive: true,
});
for (const name of [
  "process-broker.mjs",
  "native/ConPtyHost.cs",
  "native/AppContainerHost.cs",
  "native/node-appcontainer-guard.cjs",
  "native/pty_host.py",
])
  await copyFile(
    new URL("../src/execution/" + name, import.meta.url),
    new URL("../dist/execution/" + name, import.meta.url),
  );
await mkdir(new URL("../dist/extensions/", import.meta.url), {
  recursive: true,
});
for (const name of ["plugin-worker.mjs", "plugin-container-worker.mjs"])
  await copyFile(
    new URL("../src/extensions/" + name, import.meta.url),
    new URL("../dist/extensions/" + name, import.meta.url),
  );

if (process.argv.includes("--host")) {
  await mkdir(new URL("../dist/host/", import.meta.url), { recursive: true });
  for (const name of ["office-format-worker.cjs", "office-archive.cjs"])
    await copyFile(
      new URL("../src/host/" + name, import.meta.url),
      new URL("../dist/host/" + name, import.meta.url),
    );
  await mkdir(new URL("../dist/platform/", import.meta.url), {
    recursive: true,
  });
  for (const name of ["windows-computer.ps1", "windows-computer.cs"])
    await copyFile(
      new URL("../src/platform/" + name, import.meta.url),
      new URL("../dist/platform/" + name, import.meta.url),
    );
}
