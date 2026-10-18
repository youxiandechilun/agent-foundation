import { z } from "zod";
import type { IncomingMessage } from "node:http";
import type { Kernel } from "../../core/kernel.js";
import type { Office } from "./manager.js";
import { hostApplicationAccess } from "../access.js";
import { invariant } from "../../core/util.js";
export async function officeManagement(
  kernel: Kernel & { office: Office },
  req: IncomingMessage,
  url: URL,
  json: () => Promise<any>,
  signal?: AbortSignal,
) {
  if (!url.pathname.startsWith("/v1/office/") || req.method !== "POST") return;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) return;
  const operation = parts[2];
  invariant(
    [
      "inspect",
      "create",
      "table",
      "analyze",
      "transform",
      "edit-sheet",
      "replace-text",
      "compose-pdf",
      "preview-pdf",
    ].includes(operation),
    "Unknown Office operation",
    404,
  );
  const { projectId, ...args } = z
    .object({ projectId: z.string() })
    .passthrough()
    .parse(await json());
  const write = [
    "create",
    "transform",
    "edit-sheet",
    "replace-text",
    "compose-pdf",
    "preview-pdf",
  ].includes(operation);
  hostApplicationAccess(
    kernel,
    projectId,
    [
      ...(operation === "create" ? [] : ["files.read" as const]),
      ...(write ? ["files.write" as const] : []),
    ],
    operation === "compose-pdf"
      ? "office_pdf_compose"
      : operation === "preview-pdf"
        ? "office_pdf_preview"
        : "office_" + operation.replaceAll("-", "_"),
  );
  const office = kernel.office;
  if (operation === "inspect")
    return {
      data: await office.inspect(
        projectId,
        z.string().parse(args.assetId),
        signal,
      ),
    };
  if (operation === "create")
    return {
      data: await office.create(projectId, args as any, signal),
      status: 201,
    };
  if (operation === "table") {
    const v = z
      .object({
        assetId: z.string(),
        sheet: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(100),
      })
      .strict()
      .parse(args);
    return {
      data: (await office.table(projectId, v.assetId, v.sheet, signal)).map(
        (s) => ({
          ...s,
          formulas: s.formulas?.filter((f) => {
            const row = Number(String(f.address).match(/\d+$/)?.[0] || 0) - 1;
            return row >= v.offset && row < v.offset + v.limit;
          }),
          totalRows: s.rows.length,
          rows: s.rows.slice(v.offset, v.offset + v.limit),
        }),
      ),
    };
  }
  if (operation === "analyze")
    return { data: await office.analyze(projectId, args as any, signal) };
  if (operation === "transform")
    return {
      data: await office.transform(projectId, args as any, signal),
      status: 201,
    };
  if (operation === "edit-sheet")
    return {
      data: await office.editSpreadsheet(projectId, args as any, signal),
      status: 201,
    };
  if (operation === "replace-text")
    return {
      data: await office.replaceText(projectId, args as any, signal),
      status: 201,
    };
  if (operation === "compose-pdf")
    return {
      data: await office.composePdf(projectId, args as any, signal),
      status: 201,
    };
  const v = z
    .object({
      assetId: z.string(),
      page: z.number().int().min(1).default(1),
      scale: z.number().min(0.25).max(3).default(1),
    })
    .strict()
    .parse(args);
  return {
    data: await office.renderPdf(projectId, v.assetId, v.page, v.scale, signal),
  };
}
