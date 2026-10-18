/** Relative paths shared by the build copier and SDK package validation. */
export const CORE_RUNTIME_FILES = [
  "execution/process-broker.mjs",
  "execution/native/ConPtyHost.cs",
  "execution/native/AppContainerHost.cs",
  "execution/native/node-appcontainer-guard.cjs",
  "execution/native/pty_host.py",
  "extensions/plugins/worker.mjs",
];

export const HOST_RUNTIME_FILES = [
  "host/office/format-worker.cjs",
  "host/office/office-archive.cjs",
  "host/computer/native/windows-computer.ps1",
  "host/computer/native/windows-computer.cs",
];
