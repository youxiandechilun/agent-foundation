import path from "node:path";
import type { Assets } from "../storage/assets.js";
import { invariant, now } from "../core/util.js";
import type { ServerManager } from "./manager.js";
import { transferInputSchema, uploadInputSchema } from "./types.js";

/** Transfers use owned Assets only; Agent arguments never include host filesystem paths. */
export async function upload(
  manager: ServerManager,
  assets: Assets,
  projectId: string,
  input: unknown,
  signal?: AbortSignal,
) {
  const value = uploadInputSchema.parse(input);
  return manager.withAccess(
    value.serverId,
    projectId,
    signal,
    async (server, grant) => {
      const bytes = await assets.read(value.assetId, projectId, grant);
      const credentials = await manager.credentials(server),
        startedAt = now();
      grant.throwIfAborted();
      return manager.transport.sftp(
        server,
        credentials,
        Math.min(value.timeoutMs ?? manager.timeoutMs, manager.timeoutMs),
        grant,
        async (sftp, stop) => {
          manager.owned(server.id, projectId);
          return new Promise<{
            status: "completed" | "unknown";
            serverId: string;
            remotePath: string;
            bytes: number;
            startedAt: string;
            finishedAt: string;
            error?: string;
          }>((resolve) => {
            let settled = false;
            const finish = (error?: string) => {
              if (settled) return;
              settled = true;
              stop.removeEventListener("abort", abort);
              resolve({
                status: error ? "unknown" : "completed",
                serverId: server.id,
                remotePath: value.remotePath,
                bytes: bytes.length,
                startedAt,
                finishedAt: now(),
                ...(error ? { error: manager.sanitize(error) } : {}),
              });
            };
            const abort = () =>
              finish(
                "Upload cancelled or timed out; inspect the remote file before repeating",
              );
            stop.addEventListener("abort", abort, { once: true });
            sftp.once("close", () =>
              finish(
                "SSH connection lost during upload; remote file may be partial",
              ),
            );
            if (stop.aborted) abort();
            else
              sftp.writeFile(
                value.remotePath,
                bytes,
                { flag: "w", mode: 0o600 },
                (error) => finish(error?.message),
              );
          });
        },
      );
    },
  );
}

export async function download(
  manager: ServerManager,
  assets: Assets,
  projectId: string,
  input: unknown,
  signal?: AbortSignal,
) {
  const value = transferInputSchema.parse(input);
  return manager.withAccess(
    value.serverId,
    projectId,
    signal,
    async (server, grant) => {
      const credentials = await manager.credentials(server),
        startedAt = now();
      grant.throwIfAborted();
      return manager.transport.sftp(
        server,
        credentials,
        Math.min(value.timeoutMs ?? manager.timeoutMs, manager.timeoutMs),
        grant,
        async (sftp, stop) => {
          const bytes = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0,
              settled = false;
            const stream = sftp.createReadStream(value.remotePath);
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              stop.removeEventListener("abort", abort);
              stream.destroy();
              if (error) reject(error);
              else resolve(Buffer.concat(chunks));
            };
            const abort = () =>
              finish(new Error("Download cancelled or timed out"));
            stop.addEventListener("abort", abort, { once: true });
            stream.on("data", (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > assets.config.limits.maxUploadBytes) {
                finish(new Error("Download exceeds asset limit"));
                return;
              }
              chunks.push(chunk);
            });
            // ssh2 may report both an outstanding READ and CLOSE error during teardown.
            stream.on("error", (error: Error) => finish(error));
            stream.once("end", () => finish());
            stream.once("close", () =>
              finish(new Error("SFTP download closed before completion")),
            );
            sftp.once("close", () =>
              finish(new Error("SSH connection lost during download")),
            );
            if (stop.aborted) abort();
          });
          stop.throwIfAborted();
          manager.owned(server.id, projectId);
          invariant(
            bytes.length <= assets.config.limits.maxUploadBytes,
            "Download exceeds asset limit",
            413,
          );
          const asset = await assets.create(
            projectId,
            path.posix.basename(value.remotePath),
            bytes,
            "artifact",
            undefined,
            stop,
          );
          return {
            status: "completed",
            serverId: server.id,
            remotePath: value.remotePath,
            asset,
            startedAt,
            finishedAt: now(),
          };
        },
      );
    },
  );
}
