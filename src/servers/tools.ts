import type { ToolContext } from "../runtime/registry.js";
import type {
  ToolDefinition,
  ToolResult,
  Capability,
  Risk,
} from "../runtime/types.js";
import { z } from "zod";
import { ServerManager } from "./manager.js";
import {
  serverIdSchema,
  noteSchema,
  execInputSchema,
  uploadInputSchema,
  transferInputSchema,
} from "./types.js";
import { upload, download } from "./transfers.js";
import { toolParameters } from "../runtime/json-schema.js";

const readSchema = z.object({ serverId: serverIdSchema }).strict();
const scopeSchema = readSchema.passthrough();
const emptySchema = z.object({}).strict();
export function serverTools(
  context: ToolContext,
  manager: ServerManager,
): ToolDefinition<unknown>[] {
  const tools: ToolDefinition<unknown>[] = [];
  const add = (
    name: string,
    description: string,
    schema: z.ZodType,
    risk: Risk,
    capabilities: Capability[],
    operation: (
      input: unknown,
      signal?: AbortSignal,
    ) => unknown | Promise<unknown>,
    scope: "list" | "read" | "write",
  ) => {
    tools.push({
      name,
      description,
      parameters: toolParameters(schema),
      risk,
      capabilities,
      source: { kind: "builtin", id: "servers" },
      scheduling: {
        parallelSafe: true,
        resources: (input: unknown) =>
          scope === "list"
            ? [{ key: `servers:${context.session.projectId}`, access: "read" }]
            : [
                {
                  key: `server:${scopeSchema.parse(input).serverId}`,
                  access: scope,
                },
              ],
      },
      execute: async (_callId, input, signal): Promise<ToolResult> => {
        signal?.throwIfAborted();
        const result = await operation(input, signal);
        return {
          content: [
            { type: "text", text: manager.sanitize(JSON.stringify(result)) },
          ],
          details: result,
        };
      },
    });
  };
  add(
    "server_list",
    "List configured servers accessible to this project; credentials are represented only by references and presence.",
    emptySchema,
    "read",
    ["memory.read"],
    (input) => {
      emptySchema.parse(input);
      return { servers: manager.list(context.session.projectId) };
    },
    "list",
  );
  add(
    "server_read",
    "Read server profile and the latest 100 facts for this project. Notes are unverified; command evidence records observed results.",
    readSchema,
    "read",
    ["memory.read"],
    (input) => {
      const args = readSchema.parse(input);
      return manager.read(args.serverId, context.session.projectId);
    },
    "read",
  );
  add(
    "server_exec",
    "Run one SSH command on a server with a pinned SHA256 host key. May change remote state. An unknown result must be inspected before repeating; no automatic retries.",
    execInputSchema,
    "execute",
    ["network", "exec"],
    (input, signal) => manager.exec(context.session.projectId, input, signal),
    "write",
  );
  add(
    "server_remember",
    "Save an unverified agent note for this server and project. Do not include passwords, private keys or passphrases. This tool cannot create verified evidence.",
    noteSchema,
    "write",
    ["memory.write"],
    (input) => {
      const args = noteSchema.parse(input);
      return manager.remember(
        args.serverId,
        context.session.projectId,
        args.text,
      );
    },
    "write",
  );
  add(
    "server_upload",
    "Overwrite an absolute remote file through SFTP from an Asset owned by this project. A failed or interrupted upload may leave a partial file; inspect before repeating.",
    uploadInputSchema,
    "execute",
    ["network", "exec", "files.read"],
    (input, signal) =>
      upload(
        manager,
        context.kernel.assets,
        context.session.projectId,
        input,
        signal,
      ),
    "write",
  );
  add(
    "server_download",
    "Read an absolute remote file through SFTP into an Asset owned by this project; bounded by the upload size limit.",
    transferInputSchema,
    "read",
    ["network", "files.write"],
    (input, signal) =>
      download(
        manager,
        context.kernel.assets,
        context.session.projectId,
        input,
        signal,
      ),
    "read",
  );
  return tools;
}
