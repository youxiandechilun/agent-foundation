// Runtime compatibility guard, not a security boundary. AppContainer/job enforce isolation.
// Older libuv spins forever creating non-LOCAL child stdio/IPC pipes in AppContainer.
// Preserve working inherited/file-descriptor stdio; reject unsupported capture explicitly.
const cp = require("node:child_process"),
  { syncBuiltinESMExports } = require("node:module");
const [major, minor] = process.versions.uv.split(".").map(Number);
if (major < 1 || (major === 1 && minor < 53)) {
  const unsupported = () => {
    const error = new Error(
      `Node ${process.version} / libuv ${process.versions.uv} cannot create child stdio/IPC pipes in Windows AppContainer. Use inherited/file stdio, a runtime with the upstream AppContainer fix, or an explicitly selected other execution backend.`,
    );
    error.code = "ERR_SANDBOX_RUNTIME_UNSUPPORTED";
    throw error;
  };
  const check = (options) => {
    const stdio = options?.stdio;
    if (stdio === "ignore" || stdio === "inherit") return;
    if (!Array.isArray(stdio)) unsupported();
    for (let i = 0; i < Math.max(3, stdio.length); i++) {
      const value = stdio[i];
      if (i > 2 && value == null) continue;
      if (
        value === "ignore" ||
        value === "inherit" ||
        (Number.isInteger(value) && value >= 0) ||
        (value &&
          typeof value === "object" &&
          Number.isInteger(value.fd) &&
          value.fd >= 0)
      )
        continue;
      unsupported();
    }
  };
  for (const name of ["spawn", "spawnSync"]) {
    const original = cp[name];
    cp[name] = function (command, args, options) {
      check(Array.isArray(args) ? options : args);
      return original.apply(this, arguments);
    };
  }
  for (const name of ["exec", "execSync", "execFile", "execFileSync", "fork"])
    cp[name] = function () {
      unsupported();
    };
  syncBuiltinESMExports();
}
