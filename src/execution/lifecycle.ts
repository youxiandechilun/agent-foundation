import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Terminate a process tree created by this host. Callers must use detached groups on POSIX. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
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
      killer.once("close", () => {
        clearTimeout(timer);
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
