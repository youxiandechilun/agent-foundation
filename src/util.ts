import { randomUUID, createHash } from "node:crypto";
import { realpath, lstat, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const explicitSecrets = new Map<string, number>();
function activeSecrets() {
  const time = Date.now();
  for (const [secret, expiresAt] of explicitSecrets)
    if (expiresAt <= time) explicitSecrets.delete(secret);
  return explicitSecrets.keys();
}
/** Internal host handoff for durable process-output redaction; never expose through HTTP. */
export function processSecretSnapshot() {
  return [...activeSecrets()];
}
export function registerSecret(value: string, ttlMs?: number) {
  const expiresAt =
    ttlMs === undefined ? Infinity : Date.now() + Math.max(1, ttlMs);
  if (ttlMs !== undefined) activeSecrets();
  const add = (secret: string) =>
    explicitSecrets.set(
      secret,
      Math.max(explicitSecrets.get(secret) || 0, expiresAt),
    );
  if (value.length >= 8) {
    add(value);
    add(JSON.stringify(value).slice(1, -1));
    const raw = value.replace(/^(Bearer|Basic)\s+/i, "");
    if (raw.length >= 8) {
      add(raw);
      add(JSON.stringify(raw).slice(1, -1));
    }
  }
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function invariant(
  ok: unknown,
  message: string,
  status = 400,
  code = "invalid_request",
): asserts ok {
  if (!ok) throw new AppError(status, code, message);
}
export function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
/** Reject lexical escapes and every existing symlink/junction below the project root. Native exec is separate. */
export async function safePath(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
  invariant(
    !path.isAbsolute(relative) && !relative.includes("\0"),
    "Path must be relative to the project",
  );
  // Windows alternate streams, device aliases and trailing-dot normalization bypass ordinary path checks.
  const parts = relative.replaceAll("\\", "/").split("/");
  invariant(
    !parts.some(
      (p) =>
        p.includes(":") ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p),
    ),
    "Unsafe path segment",
  );
  const actualRoot = await realpath(root);
  const target = path.resolve(actualRoot, relative);
  invariant(
    within(actualRoot, target),
    "Path escapes project",
    403,
    "path_denied",
  );
  let current = actualRoot;
  for (const segment of path
    .relative(actualRoot, target)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      invariant(
        !info.isSymbolicLink(),
        "Symlinks and junctions are not allowed",
        403,
        "path_denied",
      );
      invariant(
        within(actualRoot, await realpath(current)),
        "Resolved path escapes project",
        403,
        "path_denied",
      );
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        break;
      throw error;
    }
  }
  return target;
}
export async function atomicWrite(target: string, data: string | Buffer) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await rename(temp, target);
}
export const truncate = (s: string, max = 24_000) =>
  s.length > max ? `${s.slice(0, max)}\n[truncated; read a smaller range]` : s;
export function errorText(error: unknown) {
  return truncate(
    redactSecrets(error instanceof Error ? error.message : String(error)),
    2000,
  );
}
export function redactSecrets(text: string) {
  for (const value of activeSecrets())
    text = text.replaceAll(value, "[REDACTED]");
  // Remove configured credential values even if an upstream SDK includes them in its error.
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name)
    )
      text = text
        .replaceAll(value, "[REDACTED]")
        .replaceAll(JSON.stringify(value).slice(1, -1), "[REDACTED]");
  }
  return text;
}
export function redactJson<T>(value: T): T {
  return JSON.parse(
    redactSecrets(
      JSON.stringify(value, (_key, item) =>
        typeof item === "string" ? redactSecrets(item) : item,
      ),
    ),
  );
}
export function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Stop waiting promptly while retaining uncertainty about an uncooperative external effect. */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Cancelled"),
      );
    if (signal.aborted) {
      operation.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
