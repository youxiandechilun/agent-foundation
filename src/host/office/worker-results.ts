import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
// ExcelJS can return error cells and cached date results as well as scalar cells.
const tableCell = z.union([
  scalar,
  z.object({ error: z.string() }).passthrough(),
  z.date(),
]);
const formula = z.object({
  address: z.string(),
  formula: z.string().optional(),
  cachedResult: tableCell,
  calculation: z.enum(["unavailable", "cached"]),
});
const table = z.object({
  name: z.string(),
  rows: z.array(z.array(tableCell)),
  formulas: z.array(formula).optional(),
  calculation: z.string().optional(),
});
const bytes = z.instanceof(Uint8Array);
const resultSchemas = {
  extract: z.object({
    text: z.string(),
    supported: z.boolean(),
    truncated: z.boolean(),
  }),
  table: z.array(table),
  inspect: z.discriminatedUnion("format", [
    z.object({
      format: z.literal("pdf"),
      pages: z.array(
        z.object({
          page: z.number(),
          width: z.number(),
          height: z.number(),
          rotation: z.number(),
        }),
      ),
    }),
    z.object({
      format: z.enum(["csv", "xlsx"]),
      sheets: z.array(
        z.object({
          name: z.string(),
          rows: z.number(),
          columns: z.number(),
          formulas: z.array(formula),
        }),
      ),
    }),
    z.object({
      format: z.enum(["docx", "pptx"]),
      parts: z.array(
        z.object({
          file: z.string(),
          paragraphs: z.array(
            z.object({ index: z.number(), text: z.string() }),
          ),
          tables: z.number(),
        }),
      ),
    }),
  ]),
  create: z.object({ bytes }),
  edit_sheet: z.object({
    bytes,
    sheet: z.string(),
    range: z.string(),
    cellsWritten: z.number(),
    formulasWritten: z.number(),
    formulasInvalidated: z.number(),
    needsRecalculation: z.boolean(),
  }),
  replace_text: z.object({
    bytes,
    replacements: z.array(z.object({ find: z.string(), matches: z.number() })),
    changedParts: z.array(z.string()),
  }),
  pdf_compose: z.object({ bytes, pages: z.number() }),
  pdf_render: z.object({
    bytes,
    page: z.number(),
    width: z.number(),
    height: z.number(),
  }),
};

export type OfficeOperation = keyof typeof resultSchemas;
export type OfficeJobResults = {
  [Operation in OfficeOperation]: z.output<(typeof resultSchemas)[Operation]>;
};
export type OfficeTable = OfficeJobResults["table"][number];
export type OfficeTableCell = OfficeTable["rows"][number][number];
const typedResultSchemas: {
  [Operation in OfficeOperation]: z.ZodType<OfficeJobResults[Operation]>;
} = resultSchemas;

export function parseOfficeResult<Operation extends OfficeOperation>(
  operation: Operation,
  value: unknown,
): OfficeJobResults[Operation] {
  return typedResultSchemas[operation].parse(value);
}

export const officeWorkerMessageSchema = z.union([
  z.object({ error: z.string() }),
  z.object({ result: z.unknown() }),
]);
