import { Type } from "typebox";
import type { ToolContext } from "../runtime/registry.js";
import type { ToolDefinition } from "../runtime/types.js";
import { executionCapabilities } from "./process.js";

export function processTools({
  kernel: k,
  session,
  runId,
}: ToolContext): ToolDefinition[] {
  const execCaps = executionCapabilities(k.config);
  const make = (
    name: string,
    description: string,
    parameters: Record<string, any>,
    read: boolean,
    execute: (args: any, signal?: AbortSignal) => Promise<any>,
  ): ToolDefinition => ({
    name: `exec_${name}`,
    description,
    parameters,
    risk: read ? "read" : "execute",
    capabilities: execCaps,
    source: { kind: "builtin", id: "foundation" },
    scheduling: read
      ? {
          parallelSafe: true,
          resources: (p) => [
            { key: `process:${p.processId || session.id}`, access: "read" },
          ],
        }
      : undefined,
    execute: async (_call, args, signal) => {
      signal?.throwIfAborted();
      const result = await execute(args, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
  return [
    make(
      "start",
      "Start a persistent process or real PTY. Read/write/resize/stop it with its processId.",
      Type.Object({
        command: Type.String({ minLength: 1, maxLength: 2000 }),
        args: Type.Array(Type.String({ maxLength: 10000 }), { maxItems: 100 }),
        cwd: Type.Optional(Type.String()),
        pty: Type.Optional(Type.Boolean()),
        cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })),
        rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 300 })),
        timeoutMs: Type.Optional(
          Type.Integer({ minimum: 100, maximum: 86400000 }),
        ),
      }),
      false,
      (args, signal) =>
        k.processes.start(session.id, { ...args, runId }, signal),
    ),
    make(
      "read",
      "Read managed output after a cursor; bounded wait, truncation and actual process status.",
      Type.Object({
        processId: Type.String(),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })),
        waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
      }),
      true,
      (args, signal) =>
        k.processes.read(
          args.processId,
          session.id,
          args.cursor,
          args.waitMs,
          signal,
        ),
    ),
    make(
      "write",
      "Write UTF-8 input or control characters to an existing process/PTY.",
      Type.Object({
        processId: Type.String(),
        text: Type.String({ maxLength: 65536 }),
      }),
      false,
      (args, signal) =>
        k.processes.write(args.processId, session.id, args.text, signal),
    ),
    make(
      "resize",
      "Resize the actual PTY window.",
      Type.Object({
        processId: Type.String(),
        cols: Type.Integer({ minimum: 2, maximum: 500 }),
        rows: Type.Integer({ minimum: 2, maximum: 300 }),
      }),
      false,
      (args) =>
        k.processes.resize(args.processId, session.id, args.cols, args.rows),
    ),
    make(
      "stop",
      "Terminate the managed process tree and confirm its terminal state.",
      Type.Object({ processId: Type.String() }),
      false,
      (args) => k.processes.stop(args.processId, session.id),
    ),
    make(
      "list",
      "List processes owned by this session.",
      Type.Object({}),
      true,
      () => k.processes.list(session.id),
    ),
  ];
}
