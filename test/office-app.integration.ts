import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { Document, Paragraph, TextRun, Packer } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { setup } from "./support/wire-server.js";
import { officeIntegration } from "../src/host/applications.js";
import { OfficeJobs } from "../src/host/office/jobs.js";
const load = createRequire(import.meta.url);
const { readOfficeArchive } = load("../src/host/office/office-archive.cjs");
const start = (config = {}) =>
  setup(undefined, config, { integrations: [officeIntegration()] });

test("office pack exposes independent tools and authenticated APIs with project, schema and preview-write enforcement", async () => {
  const x = await start();
  try {
    const session = await x.session("office"),
      tools = await x.kernel.toolRegistry.resolve({
        kernel: x.kernel,
        session,
        runId: "office-test",
        routeId: session.routeId,
      });
    assert.ok(tools.some((t) => t.name === "office_edit_sheet"));
    assert.ok(!tools.some((t) => /^(browser|computer|node)_/.test(t.name)));
    const a = await x.client.request("POST", "/v1/office/create", {
      projectId: x.project.id,
      format: "csv",
      name: "api",
      title: "Data",
      rows: [["value"], [4]],
    });
    assert.equal(
      (
        await x.client.request("POST", "/v1/office/analyze", {
          projectId: x.project.id,
          assetId: a.id,
          valueColumn: "value",
        })
      ).groups[0].sum,
      4,
    );
    await assert.rejects(
      x.client.request("POST", "/v1/office/analyze", {
        projectId: x.project.id,
        assetId: a.id,
        valueColumn: "value",
        filter: { column: "value", op: "invalid", value: 1 },
      }),
    );
    const other = await x.client.project("other");
    await assert.rejects(
      x.kernel.office.inspect(other.id, a.id),
      /another project/,
    );
    for (const [operation, tool] of [
      ["compose-pdf", "office_pdf_compose"],
      ["preview-pdf", "office_pdf_preview"],
    ]) {
      x.kernel.store.put("policies", {
        id: tool,
        effect: "deny",
        projectId: x.project.id,
        capabilities: ["files.write"],
        tools: [tool],
      });
      await assert.rejects(
        x.client.office(operation as any, x.project.id, { assetId: a.id }),
        /project policy/,
      );
    }
    x.config.permissions["files.write"] = "deny";
    await assert.rejects(
      x.client.request("POST", "/v1/office/preview-pdf", {
        projectId: x.project.id,
        assetId: a.id,
      }),
      /denied/,
    );
    assert.equal(
      (await fetch(x.api.url + "/v1/office/create", { method: "POST" })).status,
      401,
    );
  } finally {
    await x.close();
  }
});

test("DOCX edits span real styled runs, preserve opaque parts and styles, and enforce exact matches and immutable source digests", async () => {
  const x = await start();
  try {
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: "Hello ", bold: true }),
                  new TextRun({ text: "world", italics: true }),
                ],
              }),
            ],
          },
        ],
      }),
    );
    const zip = await JSZip.loadAsync(bytes);
    zip.file("customXml/provenance.bin", Buffer.from([0, 7, 9, 255]));
    const original = await zip.generateAsync({ type: "nodebuffer" }),
      a = await x.client.upload(x.project.id, "styled.docx", original);
    const output = await x.kernel.office.replaceText(x.project.id, {
      assetId: a.id,
      name: "edited",
      expectedSha256: a.sha256,
      replacements: [{ find: "Hello world", replace: "Updated title" }],
    });
    assert.equal(output.replacements[0].matches, 1);
    const result = await JSZip.loadAsync(
      await x.kernel.assets.read(output.asset.id, x.project.id),
    );
    assert.deepEqual(
      await result.file("customXml/provenance.bin")!.async("nodebuffer"),
      Buffer.from([0, 7, 9, 255]),
    );
    const doc = await result.file("word/document.xml")!.async("string");
    assert.match(doc, /Updated title/);
    assert.match(doc, /<w:b[\s/>]/);
    assert.match(doc, /<w:i[\s/>]/);
    assert.match(
      (await x.kernel.assets.extract(output.asset.id, x.project.id)).text,
      /Updated title/,
    );
    assert.deepEqual(await x.kernel.assets.read(a.id, x.project.id), original);
    const count = x.kernel.store.list("assets").length;
    await assert.rejects(
      x.kernel.office.replaceText(x.project.id, {
        assetId: a.id,
        name: "bad",
        replacements: [{ find: "absent", replace: "x" }],
      }),
      /match count/,
    );
    await assert.rejects(
      x.kernel.office.replaceText(x.project.id, {
        assetId: a.id,
        name: "stale",
        expectedSha256: "0".repeat(64),
        replacements: [{ find: "Hello", replace: "x" }],
      }),
      /digest changed/,
    );
    assert.equal(x.kernel.store.list("assets").length, count);
  } finally {
    await x.close();
  }
});

test("PPTX inspection follows presentation relationships and source-preserving edits retain images and slide order", async () => {
  const x = await start();
  try {
    const a = await x.kernel.office.create(x.project.id, {
      format: "pptx",
      name: "slides",
      title: "Deck",
      slides: [
        { title: "First marker", body: ["Body A"] },
        { title: "Second marker", body: ["Body B"] },
      ],
    });
    const zip = await JSZip.loadAsync(
      await x.kernel.assets.read(a.id, x.project.id),
    );
    const xml = await zip.file("ppt/presentation.xml")!.async("string");
    const ids = xml.match(/<p:sldId\b[^>]*\/>/g)!;
    zip.file(
      "ppt/presentation.xml",
      xml.replace(ids.join(""), [...ids].reverse().join("")),
    );
    zip.file("ppt/media/preserved.bin", Buffer.from("actual opaque media"));
    const source = await x.client.upload(
      x.project.id,
      "reordered.pptx",
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const inspect = await x.kernel.office.inspect(x.project.id, source.id);
    assert.ok("parts" in inspect);
    assert.match(JSON.stringify(inspect.parts[0]), /Second marker/);
    const output = await x.kernel.office.replaceText(x.project.id, {
      assetId: source.id,
      name: "updated",
      replacements: [{ find: "Body B", replace: "Revised body" }],
    });
    const result = await JSZip.loadAsync(
      await x.kernel.assets.read(output.asset.id, x.project.id),
    );
    assert.equal(
      await result.file("ppt/media/preserved.bin")!.async("string"),
      "actual opaque media",
    );
    assert.match(
      (await x.kernel.assets.extract(output.asset.id, x.project.id)).text,
      /Revised body/,
    );
  } finally {
    await x.close();
  }
});

test("XLSX range edits preserve styles and unknown parts, invalidate formula caches and report recalculation honestly", async () => {
  const x = await start();
  try {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("Budget");
    sheet.addRows([
      ["Item", "Cost", "Total"],
      ["A", 2, { formula: "B2*2", result: 4 }],
      ["B", 3],
    ]);
    sheet.getCell("B2").numFmt = "0.00";
    sheet.getCell("B2").font = { bold: true };
    sheet.mergeCells("E1:F1");
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    zip.file("customXml/preserved.bin", Buffer.from("keep"));
    const original = await zip.generateAsync({ type: "nodebuffer" }),
      a = await x.client.upload(x.project.id, "budget.xlsx", original);
    const result = await x.kernel.office.editSpreadsheet(x.project.id, {
      assetId: a.id,
      sheet: "Budget",
      name: "changed",
      range: "B2:C2",
      values: [[7, { formula: "B2*3" }]],
    });
    assert.equal(result.needsRecalculation, true);
    assert.equal(result.formulasWritten, 1);
    assert.equal(result.cellsWritten, 2);
    const output = await x.kernel.assets.read(result.asset.id, x.project.id),
      edited = await JSZip.loadAsync(output);
    assert.equal(
      await edited.file("customXml/preserved.bin")!.async("string"),
      "keep",
    );
    assert.deepEqual(
      await edited.file("xl/styles.xml")!.async("nodebuffer"),
      await zip.file("xl/styles.xml")!.async("nodebuffer"),
    );
    assert.match(
      await edited.file("xl/workbook.xml")!.async("string"),
      /forceFullCalc="1"/,
    );
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(output as any);
    assert.equal(parsed.getWorksheet("Budget")!.getCell("B2").value, 7);
    assert.equal(parsed.getWorksheet("Budget")!.getCell("B2").font.bold, true);
    assert.equal(parsed.getWorksheet("Budget")!.getCell("C2").formula, "B2*3");
    assert.equal(
      parsed.getWorksheet("Budget")!.getCell("C2").result,
      undefined,
    );
    const table = (
      await x.kernel.office.table(x.project.id, result.asset.id)
    )[0];
    assert.ok(
      table.formulas!.some(
        (f) =>
          f.address === "C2" &&
          f.calculation === "unavailable" &&
          f.cachedResult === null,
      ),
    );
    await assert.rejects(
      x.kernel.office.editSpreadsheet(x.project.id, {
        assetId: a.id,
        name: "bad",
        range: "F1",
        values: [[1]],
      }),
      /merged cell/,
    );
    await assert.rejects(
      x.kernel.office.editSpreadsheet(x.project.id, {
        assetId: a.id,
        name: "bad",
        range: "A1:B1",
        values: [[1]],
      }),
      /dimensions differ/,
    );
    await assert.rejects(
      x.kernel.office.editSpreadsheet(x.project.id, {
        assetId: a.id,
        name: "bad",
        range: "A2",
        values: [[{ formula: 'WEBSERVICE("https://example.com")' }]],
      }),
      /unsafe formula/,
    );
    assert.deepEqual(await x.kernel.assets.read(a.id, x.project.id), original);
  } finally {
    await x.close();
  }
});

test("PDF generation, page composition, rotation, extraction and raster preview execute on actual PDFs", async () => {
  const x = await start();
  try {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    for (const text of ["Page Alpha", "Page Beta"])
      doc.addPage([300, 400]).drawText(text, { x: 30, y: 300, font, size: 18 });
    const a = await x.client.upload(
      x.project.id,
      "source.pdf",
      Buffer.from(await doc.save()),
    );
    const composed = await x.kernel.office.composePdf(x.project.id, {
      name: "composed",
      sources: [{ assetId: a.id, pages: [2, 1, 2], rotation: 90 }],
    });
    assert.equal(composed.pages, 3);
    const parsed = await PDFDocument.load(
      await x.kernel.assets.read(composed.asset.id, x.project.id),
    );
    assert.equal(parsed.getPage(0).getRotation().angle, 90);
    assert.match(
      (await x.kernel.assets.extract(composed.asset.id, x.project.id)).text,
      /Page Beta/,
    );
    const preview = await x.kernel.office.renderPdf(
      x.project.id,
      composed.asset.id,
      1,
      1,
    );
    const png = await x.kernel.assets.read(preview.asset.id, x.project.id);
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(preview.width, 400);
    assert.equal(preview.height, 300);
    const generated = await x.kernel.office.create(x.project.id, {
      format: "pdf",
      name: "generated",
      title: "Actual generated PDF",
      paragraphs: ["Generated contents"],
    });
    assert.match(
      (await x.kernel.assets.extract(generated.id, x.project.id)).text,
      /Generated contents/,
    );
    await assert.rejects(
      x.kernel.office.composePdf(x.project.id, {
        name: "bad",
        sources: [{ assetId: a.id, pages: [3] }],
      }),
      /out of range/,
    );
  } finally {
    await x.close();
  }
});

test("Office ZIP preflight rejects actual CRC damage, expanded data, XML entities, duplicate names and macros", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "<root>" + "large".repeat(3000) + "</root>");
  const raw = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
  });
  assert.throws(
    () => readOfficeArchive(raw, { maxArchiveBytes: 100 }),
    /limits/,
  );
  const damaged = Buffer.from(raw);
  damaged[damaged.indexOf(Buffer.from("large"))] ^= 1;
  assert.throws(() => readOfficeArchive(damaged), /CRC/);
  zip.file(
    "word/document.xml",
    '<!DOCTYPE root [<!ENTITY x "unsafe">]><root>&x;</root>',
  );
  const entities = await zip.generateAsync({ type: "nodebuffer" });
  assert.throws(() => readOfficeArchive(entities), /entities/);
  zip.file("word/document.xml", "<root/>");
  zip.file("word/vbaProject.bin", "macro");
  const macro = await zip.generateAsync({ type: "nodebuffer" });
  assert.throws(() => readOfficeArchive(macro), /Macro/);
  const dup = new JSZip();
  dup.file("word/a.xml", "a");
  dup.file("word/b.xml", "b");
  const duplicate = Buffer.from(
    await dup.generateAsync({ type: "nodebuffer" }),
  );
  for (
    let p = 0;
    (p = duplicate.indexOf(Buffer.from("word/b.xml"), p)) !== -1;
    p += 10
  )
    duplicate.write("word/a.xml", p);
  assert.throws(() => readOfficeArchive(duplicate), /duplicate/);
});

test("Office worker cancellation, bounded capacity, closing and CSV formula-neutralization do real work without publishing cancelled output", async () => {
  const x = await start({ office: { maxConcurrentJobs: 1 } });
  try {
    const jobs = new OfficeJobs(x.config),
      stop = new AbortController();
    const running = jobs.execute(
      "create",
      {
        document: {
          format: "xlsx",
          title: "Large",
          rows: Array.from({ length: 10000 }, (_, i) => [i, "payload"]),
        },
      },
      stop.signal,
    );
    await assert.rejects(
      jobs.execute("create", { document: { format: "csv", title: "Other" } }),
      /capacity/,
    );
    stop.abort();
    await assert.rejects(running, /cancelled/);
    await jobs.close();
    await assert.rejects(jobs.execute("create", {}), /closed/);
    const a = await x.kernel.office.create(x.project.id, {
      format: "csv",
      name: "neutral",
      title: "",
      rows: [["=1+1", " \t@SUM(A1)", -3]],
    });
    const text = (await x.kernel.assets.read(a.id, x.project.id)).toString(
      "utf8",
    );
    assert.match(text, /'=1\+1/);
    assert.match(text, /' \t@SUM/);
    assert.match(text, /,-3$/);
    const cancelled = new AbortController();
    cancelled.abort();
    const count = x.kernel.store.list("assets").length;
    await assert.rejects(
      x.kernel.office.create(
        x.project.id,
        { format: "xlsx", name: "cancelled", title: "" },
        cancelled.signal,
      ),
    );
    assert.equal(x.kernel.store.list("assets").length, count);
  } finally {
    await x.close();
  }
});
test("office edits recheck exact tool policy and source-read authorization after actual worker processing before publishing a derived asset", async () => {
  const x = await start();
  try {
    const a = await x.kernel.office.create(x.project.id, {
      format: "xlsx",
      name: "source",
      title: "Data",
      rows: [["Value"], [3]],
    });
    const jobs = (x.kernel.office as any).jobs,
      execute = jobs.execute.bind(jobs);
    const request = {
      assetId: a.id,
      name: "blocked",
      range: "A2",
      values: [[7]],
    };
    jobs.execute = async (...args: any[]) => {
      const result = await execute(...args);
      x.config.permissions["files.read"] = "deny";
      return result;
    };
    await assert.rejects(
      x.kernel.office.editSpreadsheet(x.project.id, request),
      /disabled/,
    );
    assert.equal(x.kernel.store.list("assets").length, 1);
    x.config.permissions["files.read"] = "allow";
    jobs.execute = async (...args: any[]) => {
      const result = await execute(...args);
      x.kernel.store.put("policies", {
        id: "revoke-edit",
        effect: "deny",
        projectId: x.project.id,
        capabilities: ["files.write"],
        tools: ["office_edit_sheet"],
      });
      return result;
    };
    await assert.rejects(
      x.kernel.office.editSpreadsheet(x.project.id, request),
      /project policy/,
    );
    assert.equal(x.kernel.store.list("assets").length, 1);
  } finally {
    await x.close();
  }
});
