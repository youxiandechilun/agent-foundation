import type { ChildProcess } from "node:child_process";
import { errorText, hash } from "../../core/util.js";
import { terminateProcessTree } from "../../execution/lifecycle.js";

/** One reply owns settlement, cancellation and cleanup for both worker transports. */
export function observePlugin(
  child: ChildProcess,
  request: Record<string, unknown> & { nonce?: string },
  files: Record<string, string>,
  timeoutMs: number,
  maxResultBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const isolated = request.nonce !== undefined;
    let settled = false,
      outputBytes = 0,
      resultBytes = 0,
      buffer = "";
    const stop = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void terminateProcessTree(child).then(
        () => (error ? reject(error) : resolve(result)),
        (cleanupError: unknown) =>
          reject(
            Object.assign(
              new AggregateError(
                error ? [error, cleanupError] : [cleanupError],
                "Plugin process cleanup failed",
              ),
              { code: "isolation_cleanup_failed" },
            ),
          ),
      );
    };
    const abort = () => stop(new Error("Plugin cancelled"));
    const timer = setTimeout(
      () => stop(new Error("Plugin timed out")),
      timeoutMs,
    );
    const reply = (value: unknown) => {
      if (settled) return;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        if (!isolated) stop(new Error("Invalid plugin response"));
        return;
      }
      const response = value as Record<string, unknown>;
      if (isolated && response.nonce !== request.nonce) return;
      if (
        !isolated &&
        Buffer.byteLength(JSON.stringify(value)) > maxResultBytes
      )
        return stop(new Error("Plugin result too large"));
      stop(
        response.ok ? undefined : new Error(errorText(response.error)),
        response.result,
      );
    };
    const output = (chunk: Buffer) => {
      if (!settled && (outputBytes += chunk.length) > 256000)
        stop(new Error("Plugin output limit exceeded"));
    };
    child.once("error", stop);
    child.once(isolated ? "close" : "exit", (code) =>
      stop(
        new Error(
          `${isolated ? "Isolated plugin" : "Plugin"} exited before result (${code})`,
        ),
      ),
    );
    child.stdin?.on("error", stop);
    child.stderr?.on("data", output);
    if (isolated) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (settled) return;
        if ((resultBytes += Buffer.byteLength(chunk)) > maxResultBytes)
          return stop(new Error("Plugin result too large"));
        buffer += chunk;
        let index: number;
        while (!settled && (index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            reply(JSON.parse(line));
          } catch {
            /* Ignore non-protocol stdout. */
          }
        }
      });
    } else {
      child.stdout?.on("data", output);
      child.on("message", reply);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    try {
      const invocation = {
        ...request,
        integrity: Object.fromEntries(
          Object.entries(files).map(([name, source]) => [name, hash(source)]),
        ),
      };
      if (isolated) child.stdin!.end(JSON.stringify(invocation));
      else
        child.send!(invocation, (error) => {
          if (error) stop(error);
        });
    } catch (error) {
      stop(error);
    }
  });
}
