import { toolParameters } from "../runtime/json-schema.js";
import {
  officeSheetEditSchema,
  officeReplaceSchema,
  officeAnalyzeSchema,
  officeTransformSchema,
  officeCreateSchema,
  officePdfComposeSchema,
} from "./office/manager.js";
import { computerActionSchema } from "./computer/manager.js";
import { Type } from "typebox";
import type { DesktopKernel as Kernel } from "./desktop.js";
import type { ToolContext as RuntimeToolContext } from "../runtime/registry.js";
import type { ToolDefinition } from "../runtime/types.js";
import { invariant } from "../core/util.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { sentences } from "../prompts/sentences.js";

export type ToolContext = RuntimeToolContext & { kernel: Kernel };
export async function desktopTools(
  ctx: ToolContext,
  features: readonly string[] = ["office", "browser", "computer", "node"],
): Promise<ToolDefinition[]> {
  const { kernel: k, runId, session } = ctx;
  const { tools, add, artifact } = createBuiltinTools(ctx, {
    filesystemScheduling: false,
  });
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
    toolParameters(officeSheetEditSchema),
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
    toolParameters(officeReplaceSchema),
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
    toolParameters(officePdfComposeSchema),
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
    toolParameters(officeAnalyzeSchema),
    "read",
    ["files.read"],
    async (args, signal) => k.office.analyze(session.projectId, args, signal),
  );
  add(
    "office_transform",
    "Filter/select/sort actual source rows and create a new CSV/XLSX asset.",
    toolParameters(officeTransformSchema),
    "write",
    ["files.read", "files.write"],
    async (args, signal) =>
      artifact(await k.office.transform(session.projectId, args, signal)),
  );
  add(
    "office_create",
    "Generate a real DOCX/XLSX/CSV/PDF/PPTX from provided content. Derive source values with office_analyze instead of inventing them.",
    toolParameters(officeCreateSchema),
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
    sentences(
      "Inspect windows/accessibility, invoke native control patterns, capture a window, or send targeted input on Windows.",
      "Specify windowId AND processId from windows; elementId from tree.",
      "Pointer coordinates are relative to window bounds.",
      "Focus explicitly before keyboard/pointer input.",
      "Requires exclusive project/run lease.",
    ),
    toolParameters(computerActionSchema),
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
