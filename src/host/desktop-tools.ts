import { Type } from "typebox";
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopKernel as Kernel } from "./desktop.js";
import type { Session } from "../contracts.js";
import type {
  ToolDefinition,
  Risk,
  Capability,
  ToolResult,
} from "../runtime/types.js";
import { atomicWrite, safePath, invariant, truncate, now } from "../util.js";

export interface ToolContext {
  kernel: Kernel;
  runId: string;
  session: Session;
  routeId: string;
}
const cell = Type.Union([
  Type.String({ maxLength: 10000 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export async function desktopTools(
  ctx: ToolContext,
  features: readonly string[] = ["office", "browser", "computer", "node"],
): Promise<ToolDefinition[]> {
  const { kernel: k, runId, session } = ctx,
    root = k.store.project(session.projectId).root,
    tools: ToolDefinition[] = [],
    runner = k.commands;
  const add = (
    name: string,
    description: string,
    parameters: any,
    risk: Risk,
    capabilities: Capability[],
    execute: (
      args: any,
      signal: AbortSignal | undefined,
      callId: string,
    ) => Promise<any>,
  ) =>
    tools.push({
      name,
      description,
      parameters,
      risk,
      capabilities,
      source: { kind: "builtin", id: "foundation" },
      execute: async (callId, args, signal) => {
        signal?.throwIfAborted();
        const result = await execute(args, signal, callId);
        const response: ToolResult = {
          content: [
            {
              type: "text",
              text: truncate(
                JSON.stringify(result),
                k.config.limits.maxOutputBytes,
              ),
            },
          ],
          details: result,
        };
        const assetId = result?.asset?.id || result?.assetId;
        if (assetId && k.config.routes[ctx.routeId].acceptsImages) {
          const asset = k.assets.owned(assetId, session.projectId);
          if (
            ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              asset.mime,
            ) &&
            asset.size <= 5 * 1024 * 1024
          )
            response.content.push({
              type: "image",
              mimeType: asset.mime,
              data: (await k.assets.read(asset.id, session.projectId)).toString(
                "base64",
              ),
            });
        }
        return response;
      },
    });
  const artifact = (asset: any) => {
    k.store.emit(runId, "artifact.created", {
      asset,
      download: `/v1/assets/${asset.id}/content`,
    });
    return { assetId: asset.id, name: asset.name, bytes: asset.size };
  };
  add(
    "office_inspect",
    "Inspect actual DOCX paragraphs, workbook sheets/formula cache status, PPTX slide order, or PDF page metadata.",
    Type.Object({ assetId: Type.String() }),
    "read",
    ["files.read"],
    (args, signal) => k.office.inspect(session.projectId, args.assetId, signal),
  );
  add(
    "office_edit_sheet",
    "Edit exact XLSX cell ranges while preserving unrelated package parts and styles. Formulas are written for real recalculation; no calculated result is fabricated.",
    Type.Object({
      assetId: Type.String(),
      name: Type.String(),
      sheet: Type.Optional(Type.String()),
      range: Type.String(),
      values: Type.Array(
        Type.Array(Type.Union([cell, Type.Object({ formula: Type.String() })])),
      ),
      expectedSha256: Type.Optional(Type.String()),
    }),
    "write",
    ["files.read", "files.write"],
    async (args, signal) => {
      const result = await k.office.editSpreadsheet(
        session.projectId,
        args,
        signal,
      );
      artifact(result.asset);
      return result;
    },
  );
  add(
    "office_replace_text",
    "Replace literal DOCX/PPTX text across formatting runs. Match count must equal expectedMatches (default one). Preserve all unrelated ZIP entries.",
    Type.Object({
      assetId: Type.String(),
      name: Type.String(),
      parts: Type.Optional(Type.Array(Type.String())),
      replacements: Type.Array(
        Type.Object({
          find: Type.String(),
          replace: Type.String(),
          expectedMatches: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      ),
      expectedSha256: Type.Optional(Type.String()),
    }),
    "write",
    ["files.read", "files.write"],
    async (args, signal) => {
      const result = await k.office.replaceText(
        session.projectId,
        args,
        signal,
      );
      artifact(result.asset);
      return result;
    },
  );
  add(
    "office_pdf_compose",
    "Merge, select/reorder/split and rotate actual PDF pages into a new PDF asset. Inputs remain unchanged.",
    Type.Object({
      name: Type.String(),
      sources: Type.Array(
        Type.Object({
          assetId: Type.String(),
          pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
          rotation: Type.Optional(Type.Integer({ minimum: 0, maximum: 270 })),
        }),
      ),
    }),
    "write",
    ["files.read", "files.write"],
    async (args, signal) => {
      const result = await k.office.composePdf(session.projectId, args, signal);
      artifact(result.asset);
      return result;
    },
  );
  add(
    "office_pdf_preview",
    "Render an actual PDF page to a bounded PNG asset for visual inspection.",
    Type.Object({
      assetId: Type.String(),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      scale: Type.Optional(Type.Number({ minimum: 0.25, maximum: 3 })),
    }),
    "read",
    ["files.read"],
    async (args, signal) => {
      const result = await k.office.renderPdf(
        session.projectId,
        args.assetId,
        args.page,
        args.scale,
        signal,
      );
      artifact(result.asset);
      return result;
    },
  );
  add(
    "office_table",
    "Read actual CSV/XLSX rows and worksheet names. No sample rows are substituted.",
    Type.Object({
      assetId: Type.String(),
      sheet: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    "read",
    ["files.read"],
    async (args, signal) =>
      (
        await k.office.table(
          session.projectId,
          args.assetId,
          args.sheet,
          signal,
        )
      ).map((t) => ({
        name: t.name,
        totalRows: t.rows.length,
        calculation: t.calculation,
        formulas: t.formulas?.filter((f) => {
          const row = Number(String(f.address).match(/\d+$/)?.[0] || 0) - 1;
          return (
            row >= (args.offset || 0) &&
            row < (args.offset || 0) + (args.limit || 100)
          );
        }),
        rows: t.rows.slice(
          args.offset || 0,
          (args.offset || 0) + (args.limit || 100),
        ),
      })),
  );
  add(
    "office_analyze",
    "Compute count/sum/average/min/max from actual named numeric columns, optionally grouped and filtered.",
    Type.Object({
      assetId: Type.String(),
      sheet: Type.Optional(Type.String()),
      valueColumn: Type.String(),
      groupBy: Type.Optional(Type.String()),
      filter: Type.Optional(
        Type.Object({
          column: Type.String(),
          op: Type.Union([
            Type.Literal("eq"),
            Type.Literal("contains"),
            Type.Literal("gt"),
            Type.Literal("lt"),
          ]),
          value: cell,
        }),
      ),
    }),
    "read",
    ["files.read"],
    async (args, signal) => k.office.analyze(session.projectId, args, signal),
  );
  add(
    "office_transform",
    "Filter/select/sort actual source rows and create a new CSV/XLSX asset.",
    Type.Object({
      assetId: Type.String(),
      sheet: Type.Optional(Type.String()),
      name: Type.String(),
      format: Type.Union([Type.Literal("csv"), Type.Literal("xlsx")]),
      select: Type.Optional(Type.Array(Type.String())),
      sort: Type.Optional(
        Type.Object({
          column: Type.String(),
          direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
        }),
      ),
      filter: Type.Optional(
        Type.Object({ column: Type.String(), equals: cell }),
      ),
    }),
    "write",
    ["files.read", "files.write"],
    async (args, signal) =>
      artifact(await k.office.transform(session.projectId, args, signal)),
  );
  add(
    "office_create",
    "Generate a real DOCX/XLSX/CSV/PDF/PPTX from provided content. Derive source values with office_analyze instead of inventing them.",
    Type.Object({
      format: Type.Union(
        ["docx", "xlsx", "csv", "pdf", "pptx"].map((value) =>
          Type.Literal(value),
        ),
      ),
      name: Type.String({ maxLength: 180 }),
      title: Type.String({ maxLength: 1000 }),
      paragraphs: Type.Optional(
        Type.Array(Type.String({ maxLength: 20000 }), { maxItems: 1000 }),
      ),
      rows: Type.Optional(
        Type.Array(Type.Array(cell, { maxItems: 100 }), { maxItems: 10000 }),
      ),
      slides: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            body: Type.Array(Type.String()),
          }),
          { maxItems: 100 },
        ),
      ),
    }),
    "write",
    ["files.write"],
    async (args, signal) =>
      artifact(await k.office.create(session.projectId, args, signal)),
  );
  add(
    "browser_open",
    "Launch a dedicated persistent browser, or attach to an explicitly configured CDP endpoint.",
    Type.Object({
      url: Type.Optional(Type.String()),
      cdpEndpoint: Type.Optional(Type.String()),
    }),
    "control",
    ["browser"],
    async (args, signal) =>
      k.browser.open(
        session.projectId,
        session.id,
        args.url,
        args.cdpEndpoint,
        signal,
      ),
  );
  add(
    "browser_action",
    "Operate an actual managed browser or explicitly paired browser node. Inspect/click/fill/press/scroll/screenshot/upload/download are supported by the managed browser.",
    Type.Object({
      browserId: Type.Optional(Type.String()),
      nodeId: Type.Optional(Type.String()),
      action: Type.String(),
      tabId: Type.Optional(Type.String()),
      frameId: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      assetId: Type.Optional(Type.String()),
      values: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      state: Type.Optional(
        Type.Union(
          ["visible", "hidden", "attached", "detached"].map((v) =>
            Type.Literal(v),
          ),
        ),
      ),
      dialog: Type.Optional(
        Type.Object({
          accept: Type.Boolean(),
          promptText: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
      ),
    }),
    "control",
    ["browser"],
    async (args, signal) => {
      if (args.nodeId) {
        const { nodeId, browserId, ...bridgeArgs } = args;
        const value: any = k.browserBridge
          ? await k.browserBridge.action(
              session.projectId,
              nodeId,
              bridgeArgs,
              signal,
            )
          : await k.nodes.call(
              session.projectId,
              args.nodeId,
              "browser.control",
              bridgeArgs,
              30000,
              signal,
            );
        if (value?.base64) {
          const a = await k.assets.create(
            session.projectId,
            "user-browser.png",
            Buffer.from(value.base64, "base64"),
            "artifact",
            value.mime || "image/png",
            signal,
          );
          return artifact(a);
        }
        return value;
      }
      invariant(args.browserId, "browserId or nodeId required");
      const { browserId, nodeId, ...action } = args;
      const value = await k.browser.action(
        args.browserId,
        session.projectId,
        action,
        signal,
        session.id,
      );
      if (value.asset) artifact(value.asset);
      return value;
    },
  );
  add(
    "browser_close",
    "Close managed browser session or disconnect CDP control without closing user tabs.",
    Type.Object({ browserId: Type.String() }),
    "control",
    ["browser"],
    async (args) =>
      k.browser.closeSession(args.browserId, session.projectId, session.id),
  );
  add(
    "computer_action",
    "Inspect windows/accessibility, invoke native control patterns, capture a window, or send targeted input on Windows. Specify windowId AND processId from windows; elementId from tree. Pointer coordinates are relative to window bounds. Focus explicitly before keyboard/pointer input. Requires exclusive project/run lease.",
    Type.Object({
      action: Type.Union(
        [
          "inspect",
          "windows",
          "tree",
          "screenshot",
          "focus",
          "move",
          "click",
          "drag",
          "type",
          "key",
          "scroll",
          "set_value",
          "invoke",
          "toggle",
          "select",
          "expand",
          "collapse",
        ].map((value) => Type.Literal(value)),
      ),
      x: Type.Optional(Type.Integer()),
      y: Type.Optional(Type.Integer()),
      toX: Type.Optional(Type.Integer()),
      toY: Type.Optional(Type.Integer()),
      windowId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
      processId: Type.Optional(Type.Integer({ minimum: 1 })),
      elementId: Type.Optional(Type.String({ maxLength: 500 })),
      text: Type.Optional(Type.String({ maxLength: 10000 })),
      key: Type.Optional(Type.String({ maxLength: 100 })),
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right")]),
      ),
      delta: Type.Optional(Type.Integer({ minimum: -10000, maximum: 10000 })),
    }),
    "control",
    ["computer"],
    async (args, signal) => {
      const result = await k.computer.action(
        runId,
        session.projectId,
        args,
        signal,
      );
      if (result.asset) artifact(result.asset);
      return result;
    },
  );
  add(
    "node_list",
    "List paired device/browser/computer nodes in the project.",
    Type.Object({}),
    "read",
    [],
    async () => k.nodes.list(session.projectId),
  );
  add(
    "node_call",
    "Execute an actual declared node capability. Queued/running/result states are durable and outcomes are never simulated.",
    Type.Object({
      nodeId: Type.String(),
      capability: Type.String(),
      args: Type.Record(Type.String(), Type.Any()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
    }),
    "control",
    ["node"],
    async (args, signal) =>
      k.nodes.call(
        session.projectId,
        args.nodeId,
        args.capability,
        args.args,
        args.timeoutMs,
        signal,
      ),
  );
  return tools.filter((tool) => features.includes(tool.name.split("_")[0]));
}
