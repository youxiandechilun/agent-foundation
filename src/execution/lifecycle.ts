import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const terminations = new WeakMap<ChildProcess, Promise<void>>();

/** Terminate a process tree created by this host. Callers must use detached groups on POSIX. */
export function terminateProcessTree(child: ChildProcess): Promise<void> {
  const existing = terminations.get(child);
  if (existing) return existing;
  const operation = terminate(child);
  terminations.set(child, operation);
  return operation;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killer = spawn(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        killer.kill();
        child.kill();
        resolve();
      }, 3000);
      killer.once("error", () => {
        clearTimeout(timer);
        child.kill();
        resolve();
      });
      killer.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) child.kill();
        resolve();
      });
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
