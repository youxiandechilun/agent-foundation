import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
export async function trustedOAuthWorker(
  worker: string,
  args: string[],
  timeoutMs = 20000,
) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-oauth-tls-"));
  try {
    const fixture = JSON.parse(
        await readFile(new URL("./tls-fixture.json", import.meta.url), "utf8"),
      ),
      cert = path.join(root, "test-ca.pem");
    await writeFile(cert, fixture.cert);
    return await new Promise<any>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL(worker, import.meta.url)), ...args],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("OAuth TLS worker timed out"));
      }, timeoutMs);
      child.stdout.on("data", (p) => (out += p));
      child.stderr.on("data", (p) => (err += p));
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(Error(err));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error(out + err));
        }
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
