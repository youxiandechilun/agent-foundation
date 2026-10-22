import { z } from "zod";
import path from "node:path";
import type { Browser } from "playwright";
import { Assets } from "../../storage/assets.js";
import type { Config } from "../../core/config.js";
import { invariant } from "../../core/util.js";
import { OfficeJobs } from "./jobs.js";
import type { OfficeTable, OfficeTableCell } from "./worker-results.js";
export type Cell = string | number | boolean | null;
const cell = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const officeCreateSchema = z
  .object({
    format: z.enum(["docx", "xlsx", "csv", "pdf", "pptx"]),
    name: z.string().min(1).max(180),
    title: z.string().max(1000),
    paragraphs: z.array(z.string().max(20000)).max(1000).optional(),
    rows: z.array(z.array(cell).max(500)).max(100000).optional(),
    slides: z
      .array(
        z
          .object({
            title: z.string().max(1000),
            body: z.array(z.string().max(20000)).max(100),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export const officeSheetEditSchema = z
  .object({
    assetId: z.string(),
    sheet: z.string().max(100).optional(),
    range: z
      .string()
      .regex(
        /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?$/,
      ),
    values: z
      .array(
        z
          .array(
            z.union([
              cell,
              z.object({ formula: z.string().min(1).max(10000) }).strict(),
            ]),
          )
          .max(500),
      )
      .max(100000),
    name: z.string().min(1).max(180),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const officeReplaceSchema = z
  .object({
    assetId: z.string(),
    name: z.string().min(1).max(180),
    replacements: z
      .array(
        z
          .object({
            find: z.string().min(1).max(10000),
            replace: z.string().max(10000),
            expectedMatches: z.number().int().min(0).max(100000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    parts: z.array(z.string().max(500)).min(1).max(1000).optional(),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const officeAnalyzeSchema = z
  .object({
    assetId: z.string(),
    sheet: z.string().max(100).optional(),
    valueColumn: z.string().max(1000),
    groupBy: z.string().max(1000).optional(),
    filter: z
      .object({
        column: z.string().max(1000),
        op: z.enum(["eq", "contains", "gt", "lt"]),
        value: cell,
      })
      .strict()
      .optional(),
  })
  .strict();
export const officeTransformSchema = z
  .object({
    assetId: z.string(),
    sheet: z.string().max(100).optional(),
    name: z.string().min(1).max(180),
    format: z.enum(["csv", "xlsx"]),
    select: z.array(z.string().max(1000)).min(1).max(500).optional(),
    sort: z
      .object({
        column: z.string().max(1000),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .optional(),
    filter: z
      .object({ column: z.string().max(1000), equals: cell })
      .strict()
      .optional(),
  })
  .strict();
export const officePdfComposeSchema = z
  .object({
    name: z.string().min(1).max(180),
    sources: z
      .array(
        z
          .object({
            assetId: z.string(),
            pages: z
              .array(z.number().int().min(1))
              .min(1)
              .max(10000)
              .optional(),
            rotation: z
              .union([
                z.literal(0),
                z.literal(90),
                z.literal(180),
                z.literal(270),
              ])
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const html = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (!value || quoted) quoted = !quoted;
      else value += c;
    } else if (c === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((c === "\r" || c === "\n") && !quoted) {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += c;
  }
  invariant(!quoted, "Unterminated CSV quoted field");
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}
/** Source-owned job protocol, immutable asset provenance and format edits, with bounded parsing workers. */
export class Office {
  private jobs: OfficeJobs;
  private renderers = new Set<Browser>();
  private rendererCount = 0;
  private lifetime = new AbortController();
  constructor(
    readonly assets: Assets,
    readonly config: Config,
    private authorize?: (
      projectId: string,
      write: boolean,
      toolName?: string,
    ) => void,
  ) {
    this.jobs = new OfficeJobs(config);
  }
  private allowed(
    write = false,
    projectId?: string,
    toolName = "office_action",
  ) {
    this.lifetime.signal.throwIfAborted();
    invariant(
      this.config.permissions[write ? "files.write" : "files.read"] !== "deny",
      "Office file capability disabled",
      403,
    );
    if (projectId) this.authorize?.(projectId, write, toolName);
  }
  private async source(
    projectId: string,
    assetId: string,
    signal?: AbortSignal,
    expected?: string,
  ) {
    this.allowed(false, projectId);
    const asset = this.assets.owned(assetId, projectId);
    invariant(
      !expected || expected === asset.sha256,
      "Source asset digest changed",
      409,
    );
    const bytes = await this.assets.read(assetId, projectId, signal);
    return { asset, bytes, ext: path.extname(asset.name).toLowerCase() };
  }
  private stop(signal?: AbortSignal) {
    return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
  }
  async extract(
    projectId: string,
    assetId: string,
    limit: number,
    signal?: AbortSignal,
  ) {
    this.allowed(false, projectId, "office_extract");
    const source = await this.source(projectId, assetId, signal);
    const result = await this.jobs.execute(
      "extract",
      { ...source, limit },
      this.stop(signal),
    );
    this.allowed(false, projectId, "office_extract");
    return result;
  }
  async table(
    projectId: string,
    assetId: string,
    sheet?: string,
    signal?: AbortSignal,
  ): Promise<OfficeTable[]> {
    this.allowed(false, projectId, "office_table");
    const source = await this.source(projectId, assetId, signal);
    invariant(
      [".csv", ".xlsx"].includes(source.ext),
      "Table operations support CSV and XLSX",
    );
    const tables = await this.jobs.execute(
      "table",
      { ...source, sheet },
      this.stop(signal),
    );
    invariant(tables.length > 0, "Worksheet not found", 404);
    this.allowed(false, projectId, "office_table");
    return tables;
  }
  async inspect(projectId: string, assetId: string, signal?: AbortSignal) {
    this.allowed(false, projectId, "office_inspect");
    const source = await this.source(projectId, assetId, signal);
    invariant(
      [".csv", ".xlsx", ".docx", ".pptx", ".pdf"].includes(source.ext),
      "Unsupported office format",
    );
    const details = await this.jobs.execute(
      "inspect",
      source,
      this.stop(signal),
    );
    this.allowed(false, projectId, "office_inspect");
    return {
      assetId,
      sha256: source.asset.sha256,
      ...details,
    };
  }
  async analyze(
    projectId: string,
    args: z.input<typeof officeAnalyzeSchema>,
    signal?: AbortSignal,
  ) {
    this.allowed(false, projectId, "office_analyze");
    args = officeAnalyzeSchema.parse(args);
    const tables = await this.table(
        projectId,
        args.assetId,
        args.sheet,
        signal,
      ),
      rows = tables[0].rows;
    invariant(rows.length, "Table empty");
    const headers = rows[0].map(String);
    invariant(
      new Set(headers).size === headers.length,
      "Table contains duplicate column names",
    );
    const valueIndex = headers.indexOf(args.valueColumn),
      groupIndex = args.groupBy ? headers.indexOf(args.groupBy) : -1;
    invariant(
      valueIndex >= 0 && (!args.groupBy || groupIndex >= 0),
      "Requested column does not exist",
    );
    let body = rows.slice(1);
    if (args.filter) {
      const f = args.filter,
        index = headers.indexOf(f.column);
      invariant(index >= 0, "Filter column missing");
      body = body.filter((row) =>
        f.op === "eq"
          ? String(row[index]) === String(f.value)
          : f.op === "contains"
            ? String(row[index]).includes(String(f.value))
            : f.op === "gt"
              ? Number(row[index]) > Number(f.value)
              : Number(row[index]) < Number(f.value),
      );
    }
    const groups = new Map<
      string,
      {
        count: number;
        sum: number;
        correction: number;
        min: number;
        max: number;
      }
    >();
    for (const row of body) {
      const value = row[valueIndex];
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        typeof value === "boolean"
      )
        continue;
      const text = String(value).trim();
      if (
        typeof value !== "number" &&
        !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)
      )
        continue;
      const number =
        typeof value === "number" ? value : Number(text.replaceAll(",", ""));
      if (!Number.isFinite(number)) continue;
      const key = args.groupBy ? String(row[groupIndex] ?? "") : "all",
        g = groups.get(key) || {
          count: 0,
          sum: 0,
          correction: 0,
          min: number,
          max: number,
        };
      const adjusted = number - g.correction,
        total = g.sum + adjusted;
      g.correction = total - g.sum - adjusted;
      g.sum = total;
      g.count++;
      g.min = Math.min(g.min, number);
      g.max = Math.max(g.max, number);
      invariant(Number.isFinite(total), "Numeric aggregation overflow");
      groups.set(key, g);
    }
    return {
      sourceAssetId: args.assetId,
      sheet: tables[0].name,
      totalDataRows: body.length,
      calculation: tables[0].calculation,
      groups: [...groups].map(([group, g]) => ({
        group,
        count: g.count,
        sum: g.sum,
        average: g.sum / g.count,
        min: g.min,
        max: g.max,
      })),
    };
  }
  async transform(
    projectId: string,
    args: z.input<typeof officeTransformSchema>,
    signal?: AbortSignal,
  ) {
    this.allowed(true, projectId, "office_transform");
    args = officeTransformSchema.parse(args);
    const tables = await this.table(
      projectId,
      args.assetId,
      args.sheet,
      signal,
    );
    invariant(tables[0].rows.length, "Table empty");
    const headers = tables[0].rows[0].map(String);
    invariant(
      new Set(headers).size === headers.length,
      "Table contains duplicate column names",
    );
    let body = tables[0].rows.slice(1);
    if (args.filter) {
      const index = headers.indexOf(args.filter.column);
      invariant(index >= 0, "Filter column missing");
      body = body.filter(
        (r) => String(r[index]) === String(args.filter!.equals),
      );
    }
    if (args.sort) {
      const index = headers.indexOf(args.sort.column),
        direction = args.sort.direction === "asc" ? 1 : -1;
      invariant(index >= 0, "Sort column missing");
      body.sort(
        (a, b) =>
          direction *
          (typeof a[index] === "number" && typeof b[index] === "number"
            ? (a[index] as number) - (b[index] as number)
            : String(a[index] ?? "").localeCompare(String(b[index] ?? ""))),
      );
    }
    let result: OfficeTableCell[][] = [headers, ...body];
    if (args.select) {
      const indexes = args.select.map((c) => {
        const index = headers.indexOf(c);
        invariant(index >= 0, "Selected column missing");
        return index;
      });
      result = result.map((r) => indexes.map((i) => r[i]));
    }
    return this.create(
      projectId,
      officeCreateSchema.parse({
        format: args.format,
        name: args.name,
        title: tables[0].name,
        rows: result,
      }),
      signal,
      true,
    );
  }
  async create(
    projectId: string,
    input: z.input<typeof officeCreateSchema>,
    signal?: AbortSignal,
    requireRead = false,
  ) {
    this.allowed(true, projectId, "office_create");
    this.assets.store.project(projectId);
    const args = officeCreateSchema.parse(input),
      stop = this.stop(signal);
    stop.throwIfAborted();
    invariant(
      (args.rows || []).reduce((n, r) => n + r.length, 0) <=
        this.config.office.maxCells,
      "Generated document cell limit exceeded",
    );
    invariant(
      JSON.stringify(args).length <= this.config.office.maxTextChars,
      "Generated document text limit exceeded",
    );
    let bytes: Buffer;
    if (args.format !== "pdf") {
      const generated = await this.jobs.execute(
        "create",
        { document: args },
        stop,
      );
      bytes = Buffer.from(generated.bytes);
    } else {
      invariant(
        this.rendererCount < this.config.office.maxConcurrentJobs,
        "PDF renderer capacity reached",
        429,
      );
      this.rendererCount++;
      const renderStop = AbortSignal.any([
        stop,
        AbortSignal.timeout(this.config.office.timeoutMs),
      ]);
      let browser: Browser | undefined;
      const abort = () => {
        void browser?.close();
      };
      renderStop.addEventListener("abort", abort, { once: true });
      try {
        const { chromium } = await import("playwright");
        renderStop.throwIfAborted();
        browser = await chromium.launch({
          headless: true,
          ...(this.config.browser.executablePath
            ? { executablePath: this.config.browser.executablePath }
            : {}),
          timeout: this.config.office.timeoutMs,
        });
        this.renderers.add(browser);
        renderStop.throwIfAborted();
        const context = await browser.newContext({
          javaScriptEnabled: false,
          serviceWorkers: "block",
        });
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(this.config.office.timeoutMs);
        const table = args.rows?.length
          ? `<table>${args.rows.map((row) => `<tr>${row.map((v) => `<td>${html(String(v ?? ""))}</td>`).join("")}</tr>`).join("")}</table>`
          : "";
        await page.setContent(
          `<meta charset="utf-8"><style>body{font-family:Arial,'Microsoft YaHei',sans-serif;font-size:12pt;line-height:1.6}h1{font-size:24pt}table{border-collapse:collapse;width:100%}td{border:1px solid #aaa;padding:6px}tr{break-inside:avoid}</style><h1>${html(args.title)}</h1>${(args.paragraphs || []).map((p) => `<p>${html(p)}</p>`).join("")}${table}`,
        );
        bytes = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
        });
        renderStop.throwIfAborted();
      } finally {
        renderStop.removeEventListener("abort", abort);
        if (browser) {
          await browser.close();
          this.renderers.delete(browser);
        }
        this.rendererCount--;
      }
    }
    stop.throwIfAborted();
    if (requireRead) {
      this.allowed(false, projectId, "office_transform");
      this.allowed(true, projectId, "office_transform");
    }
    this.allowed(true, projectId, "office_create");
    return this.assets.create(
      projectId,
      args.name.replace(/\.(docx|xlsx|csv|pdf|pptx)$/i, "") + "." + args.format,
      bytes,
      "artifact",
      undefined,
      stop,
    );
  }
  async editSpreadsheet(
    projectId: string,
    input: z.input<typeof officeSheetEditSchema>,
    signal?: AbortSignal,
  ) {
    this.allowed(true, projectId, "office_edit_sheet");
    const args = officeSheetEditSchema.parse(input),
      source = await this.source(
        projectId,
        args.assetId,
        signal,
        args.expectedSha256,
      );
    invariant(
      source.ext === ".xlsx",
      "Source-preserving spreadsheet edits require XLSX",
    );
    const stop = this.stop(signal),
      { bytes, ...details } = await this.jobs.execute(
        "edit_sheet",
        { ...source, ...args },
        stop,
      );
    stop.throwIfAborted();
    this.allowed(false, projectId, "office_edit_sheet");
    this.allowed(true, projectId, "office_edit_sheet");
    return {
      ...details,
      sourceAssetId: source.asset.id,
      asset: await this.assets.create(
        projectId,
        args.name.replace(/\.xlsx$/i, "") + ".xlsx",
        Buffer.from(bytes),
        "artifact",
        undefined,
        stop,
      ),
    };
  }
  async replaceText(
    projectId: string,
    input: z.input<typeof officeReplaceSchema>,
    signal?: AbortSignal,
  ) {
    this.allowed(true, projectId, "office_replace_text");
    const args = officeReplaceSchema.parse(input),
      source = await this.source(
        projectId,
        args.assetId,
        signal,
        args.expectedSha256,
      );
    invariant(
      [".docx", ".pptx"].includes(source.ext),
      "Source-preserving text edits require DOCX or PPTX",
    );
    const stop = this.stop(signal),
      { bytes, ...details } = await this.jobs.execute(
        "replace_text",
        { ...source, ...args },
        stop,
      );
    stop.throwIfAborted();
    this.allowed(false, projectId, "office_replace_text");
    this.allowed(true, projectId, "office_replace_text");
    return {
      ...details,
      sourceAssetId: source.asset.id,
      asset: await this.assets.create(
        projectId,
        args.name.replace(/\.(docx|pptx)$/i, "") + source.ext,
        Buffer.from(bytes),
        "artifact",
        undefined,
        stop,
      ),
    };
  }
  async composePdf(
    projectId: string,
    input: {
      name: string;
      sources: { assetId: string; pages?: number[]; rotation?: number }[];
    },
    signal?: AbortSignal,
  ) {
    this.allowed(true, projectId, "office_pdf_compose");
    const args = officePdfComposeSchema.parse(input),
      sources = [];
    let size = 0;
    for (const item of args.sources) {
      const source = await this.source(projectId, item.assetId, signal);
      invariant(source.ext === ".pdf", "PDF composition requires PDF assets");
      size += source.bytes.length;
      invariant(
        size <= this.config.limits.maxInputAssetBytes,
        "PDF input budget exceeded",
        413,
      );
      sources.push({ ...item, bytes: source.bytes });
    }
    const stop = this.stop(signal),
      result = await this.jobs.execute("pdf_compose", { sources }, stop);
    stop.throwIfAborted();
    this.allowed(false, projectId, "office_pdf_compose");
    this.allowed(true, projectId, "office_pdf_compose");
    return {
      pages: result.pages,
      sourceAssetIds: args.sources.map((s) => s.assetId),
      asset: await this.assets.create(
        projectId,
        args.name.replace(/\.pdf$/i, "") + ".pdf",
        Buffer.from(result.bytes),
        "artifact",
        "application/pdf",
        stop,
      ),
    };
  }
  async renderPdf(
    projectId: string,
    assetId: string,
    page = 1,
    scale = 1,
    signal?: AbortSignal,
  ) {
    this.allowed(true, projectId, "office_pdf_preview");
    const source = await this.source(projectId, assetId, signal);
    invariant(
      source.ext === ".pdf" &&
        Number.isInteger(page) &&
        page >= 1 &&
        Number.isFinite(scale) &&
        scale >= 0.25 &&
        scale <= 3,
      "Invalid PDF preview request",
    );
    const stop = this.stop(signal),
      { bytes, ...details } = await this.jobs.execute(
        "pdf_render",
        { ...source, page, scale },
        stop,
      );
    stop.throwIfAborted();
    this.allowed(false, projectId, "office_pdf_preview");
    this.allowed(true, projectId, "office_pdf_preview");
    return {
      ...details,
      sourceAssetId: assetId,
      asset: await this.assets.create(
        projectId,
        `page-${page}.png`,
        Buffer.from(bytes),
        "artifact",
        "image/png",
        stop,
      ),
    };
  }
  async close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("Office plugin closed"));
    await this.jobs.close();
    await Promise.allSettled([...this.renderers].map((b) => b.close()));
    this.renderers.clear();
  }
}
