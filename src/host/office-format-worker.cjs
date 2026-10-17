const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readOfficeArchive } = require("./office-archive.cjs");
const load = createRequire(workerData.requireFrom),
  { args, limits, operation } = workerData;
const check = (value, message) => {
  if (!value) throw Error(message);
};
function parseCsv(source) {
  const rows = [];
  let row = [],
    text = "",
    quoted = false,
    cells = 0;
  const field = () => {
    row.push(text);
    text = "";
    check(++cells <= limits.maxCells, "CSV cell limit exceeded");
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        text += '"';
        i++;
      } else if (!text || quoted) quoted = !quoted;
      else text += c;
    } else if (c === "," && !quoted) field();
    else if ((c === "\r" || c === "\n") && !quoted) {
      if (c === "\r" && source[i + 1] === "\n") i++;
      field();
      rows.push(row);
      row = [];
    } else text += c;
  }
  check(!quoted, "Unterminated CSV quoted field");
  if (text || row.length) {
    field();
    rows.push(row);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}
function xml(bytes) {
  const { DOMParser } = load("@xmldom/xmldom"),
    source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  check(!/<!DOCTYPE|<!ENTITY/i.test(source), "XML entities are forbidden");
  return new DOMParser({
    onError: (level, message) => {
      throw Error("Invalid Office XML: " + level + ": " + message);
    },
  }).parseFromString(source, "application/xml");
}
const nodes = (root, name) =>
  Array.from(root.getElementsByTagNameNS("*", name));
const textOf = (root) =>
  nodes(root, "t")
    .map((t) => t.textContent || "")
    .join("");
const serialize = (root) =>
  new (load("@xmldom/xmldom").XMLSerializer)().serializeToString(root);
function relationship(files, base, relationshipFile) {
  const relations = new Map();
  if (!files.has(relationshipFile)) return relations;
  for (const r of nodes(xml(files.get(relationshipFile)), "Relationship")) {
    if (r.getAttribute("TargetMode") === "External") continue;
    const target = r.getAttribute("Target") || "",
      resolved = target.startsWith("/")
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(base, target));
    check(
      !resolved.startsWith("../") && !resolved.includes("\\"),
      "Unsafe Office relationship",
    );
    relations.set(r.getAttribute("Id"), resolved);
  }
  return relations;
}
function sheets(files) {
  const book = xml(files.get("xl/workbook.xml")),
    relations = relationship(files, "xl", "xl/_rels/workbook.xml.rels");
  return nodes(book, "sheet").map((s) => {
    const relationshipId = Array.from(s.attributes).find(
        (a) => a.localName === "id",
      )?.value,
      file = relations.get(relationshipId);
    check(file && files.has(file), "Worksheet relationship missing");
    return { name: s.getAttribute("name"), file };
  });
}
function slides(files) {
  const presentation = xml(files.get("ppt/presentation.xml")),
    relations = relationship(files, "ppt", "ppt/_rels/presentation.xml.rels");
  return nodes(presentation, "sldId").map((s) => {
    const rid = Array.from(s.attributes).find(
        (a) => a.localName === "id" && a.prefix,
      )?.value,
      file = relations.get(rid);
    check(file && files.has(file), "Slide relationship missing");
    return file;
  });
}
async function zipOutput(bytes, changes) {
  const JSZip = load("jszip"),
    zip = await JSZip.loadAsync(bytes);
  for (const [file, value] of changes) {
    if (value === null) zip.remove(file);
    else zip.file(file, typeof value === "string" ? value : Buffer.from(value));
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
function cellAddress(address) {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
  check(m, "Invalid spreadsheet cell address");
  let col = 0;
  for (const c of m[1]) col = col * 26 + c.charCodeAt(0) - 64;
  const row = Number(m[2]);
  check(col <= 16384 && row <= 1048576, "Cell address exceeds XLSX limits");
  return { col, row };
}
function columnName(index) {
  let s = "";
  while (index) {
    index--;
    s = String.fromCharCode(65 + (index % 26)) + s;
    index = Math.floor(index / 26);
  }
  return s;
}
function range(value) {
  const parts = value.toUpperCase().replaceAll("$", "").split(":");
  check(parts.length <= 2, "Invalid spreadsheet range");
  const start = cellAddress(parts[0]),
    end = cellAddress(parts[1] || parts[0]);
  check(
    end.row >= start.row &&
      end.col >= start.col &&
      (end.row - start.row + 1) * (end.col - start.col + 1) <= limits.maxCells,
    "Spreadsheet range exceeds limits",
  );
  return { start, end };
}
async function table(bytes) {
  if (args.ext === ".csv")
    return [{ name: "CSV", rows: parseCsv(bytes.toString("utf8")) }];
  readOfficeArchive(bytes, limits);
  const ExcelJS = load("exceljs"),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes, {
    ignoreNodes: ["drawing", "picture", "extLst"],
  });
  let total = 0;
  return book.worksheets
    .filter((s) => !args.sheet || s.name === args.sheet)
    .map((sheet) => {
      check(
        (total += sheet.rowCount * sheet.columnCount) <= limits.maxCells,
        "Workbook dimensions exceed processing limit",
      );
      const rows = [],
        formulas = [];
      for (let r = 1; r <= sheet.rowCount; r++) {
        const row = [];
        for (let c = 1; c <= sheet.columnCount; c++) {
          const cell = sheet.getCell(r, c),
            v = cell.value;
          if (
            v &&
            typeof v === "object" &&
            (v.formula !== undefined || v.sharedFormula !== undefined)
          ) {
            formulas.push({
              address: cell.address,
              formula: cell.formula || v.formula,
              cachedResult: v.result ?? null,
              calculation: v.result === undefined ? "unavailable" : "cached",
            });
            row.push(v.result ?? null);
          } else
            row.push(
              v instanceof Date
                ? v.toISOString()
                : v?.richText
                  ? v.richText.map((v) => v.text).join("")
                  : (v?.text ?? v ?? null),
            );
        }
        rows.push(row);
      }
      return {
        name: sheet.name,
        rows,
        formulas,
        calculation: formulas.length ? "cached-or-unavailable" : "not-required",
      };
    });
}
async function replaceText(bytes) {
  const files = readOfficeArchive(bytes, limits),
    allowed =
      args.ext === ".docx"
        ? [
            "word/document.xml",
            ...Array.from(files.keys()).filter((n) =>
              /^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(n),
            ),
          ]
        : slides(files);
  const selected = args.parts || allowed;
  check(
    selected.length && selected.every((p) => allowed.includes(p)),
    "Text replacement part is not supported",
  );
  const documents = selected.map((file) => ({
      file,
      doc: xml(files.get(file)),
    })),
    counts = [];
  let textBudget = documents.reduce(
    (total, item) => total + textOf(item.doc).length,
    0,
  );
  check(
    textBudget <= limits.maxTextChars,
    "Office text editing budget exceeded",
  );
  for (const replacement of args.replacements) {
    let matches = 0;
    for (const { doc } of documents)
      for (const paragraph of nodes(doc, "p")) {
        const runs = nodes(paragraph, "t");
        let offset = 0;
        const positions = runs.map((node) => {
          const start = offset;
          offset += (node.textContent || "").length;
          return { node, start, end: offset };
        });
        const text = runs.map((n) => n.textContent || "").join(""),
          indices = [];
        let found = 0;
        while ((found = text.indexOf(replacement.find, found)) !== -1) {
          indices.push(found);
          found += replacement.find.length;
          check(indices.length <= 100000, "Too many text replacements");
        }
        matches += indices.length;
        textBudget +=
          indices.length *
          (replacement.replace.length - replacement.find.length);
        check(
          textBudget <= limits.maxTextChars,
          "Office text replacement output budget exceeded",
        );
        for (const start of indices.reverse()) {
          const end = start + replacement.find.length,
            first = positions.find((p) => p.end > start),
            last = positions.find((p) => p.end >= end);
          check(first && last, "Text replacement boundary mismatch");
          if (first === last)
            first.node.textContent =
              (first.node.textContent || "").slice(0, start - first.start) +
              replacement.replace +
              (first.node.textContent || "").slice(end - first.start);
          else {
            const firstIndex = positions.indexOf(first),
              lastIndex = positions.indexOf(last);
            first.node.textContent =
              (first.node.textContent || "").slice(0, start - first.start) +
              replacement.replace;
            for (let i = firstIndex + 1; i < lastIndex; i++)
              positions[i].node.textContent = "";
            last.node.textContent = (last.node.textContent || "").slice(
              end - last.start,
            );
          }
          for (const p of positions)
            if (/^\s|\s$/.test(p.node.textContent || ""))
              p.node.setAttributeNS(
                "http://www.w3.org/XML/1998/namespace",
                "xml:space",
                "preserve",
              );
        }
      }
    check(
      matches === (replacement.expectedMatches ?? 1),
      "Text replacement match count differs from expected count",
    );
    counts.push({ find: replacement.find, matches });
  }
  return {
    bytes: await zipOutput(
      bytes,
      new Map(documents.map(({ file, doc }) => [file, serialize(doc)])),
    ),
    replacements: counts,
    changedParts: selected,
  };
}
async function editSheet(bytes) {
  const files = readOfficeArchive(bytes, limits),
    worksheets = sheets(files),
    sheet =
      worksheets.find((s) => s.name === args.sheet) ||
      (!args.sheet ? worksheets[0] : undefined);
  check(sheet, "Worksheet not found");
  const area = range(args.range),
    height = area.end.row - area.start.row + 1,
    width = area.end.col - area.start.col + 1;
  check(
    args.values.length === height &&
      args.values.every((row) => row.length === width),
    "Range and values dimensions differ",
  );
  check(
    area.end.row * area.end.col <= limits.maxCells,
    "Result worksheet dimensions exceed processing limit",
  );
  const doc = xml(files.get(sheet.file)),
    root = doc.documentElement,
    ns = root.namespaceURI,
    qualified = (name) => (root.prefix ? root.prefix + ":" + name : name),
    make = (name) => doc.createElementNS(ns, qualified(name));
  const data = nodes(doc, "sheetData")[0];
  check(data, "Worksheet sheetData missing");
  let formulaCount = 0;
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const rowNumber = area.start.row + r,
        column = area.start.col + c,
        address = columnName(column) + rowNumber,
        value = args.values[r][c];
      let row = Array.from(data.childNodes).find(
        (n) =>
          n.nodeType === 1 &&
          n.localName === "row" &&
          Number(n.getAttribute("r")) === rowNumber,
      );
      if (!row) {
        row = make("row");
        row.setAttribute("r", rowNumber);
        const next = Array.from(data.childNodes).find(
          (n) => n.nodeType === 1 && Number(n.getAttribute("r")) > rowNumber,
        );
        data.insertBefore(row, next || null);
      }
      let cell = Array.from(row.childNodes).find(
        (n) =>
          n.nodeType === 1 &&
          n.localName === "c" &&
          n.getAttribute("r") === address,
      );
      if (!cell) {
        cell = make("c");
        cell.setAttribute("r", address);
        const next = Array.from(row.childNodes).find(
          (n) =>
            n.nodeType === 1 &&
            n.localName === "c" &&
            cellAddress(n.getAttribute("r")).col > column,
        );
        row.insertBefore(cell, next || null);
      }
      for (const merged of nodes(doc, "mergeCell")) {
        const span = range(merged.getAttribute("ref"));
        check(
          !(
            rowNumber >= span.start.row &&
            rowNumber <= span.end.row &&
            column >= span.start.col &&
            column <= span.end.col
          ) ||
            (rowNumber === span.start.row && column === span.start.col),
          "Cannot edit a non-master merged cell",
        );
      }
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      cell.removeAttribute("t");
      if (value === null) continue;
      if (typeof value === "object") {
        const expression = value.formula.replace(/^=/, "");
        check(
          expression.length > 0 &&
            expression.length <= 10000 &&
            !/(https?:|file:|\[[^\]]+\][^!]*!|\b(WEBSERVICE|HYPERLINK|RTD|DDE)\s*\()/i.test(
              expression,
            ),
          "External or unsafe formulas are not accepted",
        );
        const f = make("f");
        f.textContent = expression;
        cell.appendChild(f);
        formulaCount++;
      } else if (typeof value === "string") {
        cell.setAttribute("t", "inlineStr");
        const inline = make("is"),
          text = make("t");
        text.setAttributeNS(
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          "preserve",
        );
        text.textContent = value;
        inline.appendChild(text);
        cell.appendChild(inline);
      } else {
        if (typeof value === "boolean") cell.setAttribute("t", "b");
        const v = make("v");
        v.textContent =
          typeof value === "boolean" ? (value ? "1" : "0") : String(value);
        cell.appendChild(v);
      }
    }
  const dimension = nodes(doc, "dimension")[0];
  if (dimension) {
    const previous = range(dimension.getAttribute("ref") || "A1");
    dimension.setAttribute(
      "ref",
      `A1:${columnName(Math.max(previous.end.col, area.end.col))}${Math.max(previous.end.row, area.end.row)}`,
    );
  }
  const changes = new Map([[sheet.file, serialize(doc)]]);
  let formulasInvalidated = 0;
  for (const worksheet of worksheets) {
    const updated =
      worksheet.file === sheet.file ? doc : xml(files.get(worksheet.file));
    for (const formula of nodes(updated, "f")) {
      const cell = formula.parentNode;
      for (const v of Array.from(cell.childNodes).filter(
        (n) => n.nodeType === 1 && n.localName === "v",
      ))
        cell.removeChild(v);
      formulasInvalidated++;
    }
    if (worksheet.file === sheet.file || nodes(updated, "f").length)
      changes.set(worksheet.file, serialize(updated));
  }
  const book = xml(files.get("xl/workbook.xml"));
  let calc = nodes(book, "calcPr")[0];
  if (!calc) {
    calc = book.createElementNS(book.documentElement.namespaceURI, "calcPr");
    book.documentElement.appendChild(calc);
  }
  calc.setAttribute("fullCalcOnLoad", "1");
  calc.setAttribute("forceFullCalc", "1");
  changes.set("xl/workbook.xml", serialize(book));
  changes.set("xl/calcChain.xml", null);
  for (const file of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) {
    if (!files.has(file)) continue;
    const d = xml(files.get(file));
    for (const n of nodes(
      d,
      file.endsWith(".rels") ? "Relationship" : "Override",
    ))
      if (
        (n.getAttribute("Type") || "").endsWith("/calcChain") ||
        n.getAttribute("PartName") === "/xl/calcChain.xml"
      )
        n.parentNode.removeChild(n);
    changes.set(file, serialize(d));
  }
  return {
    bytes: await zipOutput(bytes, changes),
    sheet: sheet.name,
    range: args.range,
    cellsWritten: height * width,
    formulasWritten: formulaCount,
    formulasInvalidated,
    needsRecalculation: formulasInvalidated > 0,
  };
}
async function pdf(bytes) {
  const { PDFDocument } = load("pdf-lib");
  const document = await PDFDocument.load(bytes, { ignoreEncryption: false });
  check(document.getPageCount() <= limits.maxPages, "PDF page limit exceeded");
  return document;
}
async function main() {
  const bytes = args.bytes ? Buffer.from(args.bytes) : undefined;
  if (operation === "table") return table(bytes);
  if (operation === "replace_text") return replaceText(bytes);
  if (operation === "edit_sheet") return editSheet(bytes);
  if (operation === "inspect") {
    if (args.ext === ".pdf") {
      const document = await pdf(bytes);
      return {
        format: "pdf",
        pages: document.getPages().map((p, i) => ({
          page: i + 1,
          ...p.getSize(),
          rotation: p.getRotation().angle,
        })),
      };
    }
    if (args.ext === ".csv" || args.ext === ".xlsx") {
      const data = await table(bytes);
      return {
        format: args.ext.slice(1),
        sheets: data.map((s) => ({
          name: s.name,
          rows: s.rows.length,
          columns: s.rows.reduce((max, row) => Math.max(max, row.length), 0),
          formulas: s.formulas || [],
        })),
      };
    }
    const files = readOfficeArchive(bytes, limits),
      parts = args.ext === ".docx" ? ["word/document.xml"] : slides(files);
    let chars = 0;
    return {
      format: args.ext.slice(1),
      parts: parts.map((file) => {
        const d = xml(files.get(file)),
          paragraphs = nodes(d, "p").map((p, index) => ({
            index,
            text: textOf(p),
          }));
        chars += paragraphs.reduce((n, p) => n + p.text.length, 0);
        check(
          chars <= limits.maxTextChars,
          "Office inspection text limit exceeded",
        );
        return { file, paragraphs, tables: nodes(d, "tbl").length };
      }),
    };
  }
  if (operation === "extract") {
    const maximum = Math.min(args.limit, limits.maxTextChars);
    let text = "";
    if (args.ext === ".pdf") {
      const pdfjs = await import(
          pathToFileURL(load.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href
        ),
        task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          isEvalSupported: false,
          disableFontFace: true,
          useSystemFonts: false,
          standardFontDataUrl:
            path
              .join(
                path.dirname(load.resolve("pdfjs-dist/package.json")),
                "standard_fonts",
              )
              .replaceAll("\\", "/") + "/",
        });
      try {
        const doc = await task.promise;
        check(doc.numPages <= limits.maxPages, "PDF page limit exceeded");
        for (let n = 1; n <= doc.numPages && text.length <= maximum; n++) {
          const page = await doc.getPage(n),
            content = await page.getTextContent();
          text +=
            `\nPage ${n}\n` +
            content.items.map((v) => v.str || "").join(" ") +
            "\n";
          page.cleanup();
        }
      } finally {
        await task.destroy();
      }
    } else if (args.ext === ".xlsx" || args.ext === ".csv") {
      for (const sheet of await table(bytes)) {
        text += `\nSheet: ${sheet.name}\n`;
        for (const row of sheet.rows) {
          text += row.map((v) => String(v ?? "")).join("\t") + "\n";
          if (text.length > maximum) break;
        }
        if (text.length > maximum) break;
      }
    } else {
      const files = readOfficeArchive(bytes, limits),
        parts = args.ext === ".docx" ? ["word/document.xml"] : slides(files);
      for (const part of parts) {
        text +=
          `\n${part}\n` +
          nodes(xml(files.get(part)), "p")
            .map(textOf)
            .join("\n");
        if (text.length > maximum) break;
      }
    }
    return {
      text: text.slice(0, maximum),
      supported: true,
      truncated: text.length > maximum,
    };
  }
  if (operation === "pdf_compose") {
    const { PDFDocument, degrees } = load("pdf-lib"),
      output = await PDFDocument.create();
    for (const source of args.sources) {
      const doc = await pdf(Buffer.from(source.bytes));
      check(
        !doc.getForm().getFields().length,
        "PDF composition of interactive forms requires explicit flattening outside this profile",
      );
      const indices = (
        source.pages || doc.getPageIndices().map((i) => i + 1)
      ).map((i) => {
        check(
          Number.isInteger(i) && i >= 1 && i <= doc.getPageCount(),
          "PDF page is out of range",
        );
        return i - 1;
      });
      check(
        output.getPageCount() + indices.length <= limits.maxPages,
        "Composed PDF page limit exceeded",
      );
      for (const page of await output.copyPages(doc, indices)) {
        if (source.rotation !== undefined)
          page.setRotation(
            degrees((page.getRotation().angle + source.rotation) % 360),
          );
        output.addPage(page);
      }
    }
    return { bytes: await output.save(), pages: output.getPageCount() };
  }
  if (operation === "pdf_render") {
    const canvas = load("@napi-rs/canvas");
    global.DOMMatrix ||= canvas.DOMMatrix;
    global.ImageData ||= canvas.ImageData;
    global.Path2D ||= canvas.Path2D;
    const pdfjs = await import(
        pathToFileURL(load.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href
      ),
      task = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        useSystemFonts: true,
        standardFontDataUrl:
          path
            .join(
              path.dirname(load.resolve("pdfjs-dist/package.json")),
              "standard_fonts",
            )
            .replaceAll("\\", "/") + "/",
      });
    try {
      const document = await task.promise;
      check(
        document.numPages <= limits.maxPages && args.page <= document.numPages,
        "PDF page is out of range",
      );
      const page = await document.getPage(args.page),
        viewport = page.getViewport({ scale: args.scale || 1 });
      check(
        viewport.width * viewport.height <= 16000000,
        "PDF preview pixel limit exceeded",
      );
      const surface = canvas.createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({ canvasContext: surface.getContext("2d"), viewport })
        .promise;
      return {
        bytes: surface.toBuffer("image/png"),
        page: args.page,
        width: surface.width,
        height: surface.height,
      };
    } finally {
      await task.destroy();
    }
  }
  if (operation === "create") {
    const a = args.document;
    check(
      (a.rows || []).reduce((n, r) => n + r.length, 0) <= limits.maxCells,
      "Generated document cell limit exceeded",
    );
    if (a.format === "csv") {
      const csv = (a.rows || [[a.title]])
        .map((row) =>
          row
            .map((value) => {
              let text = String(value ?? "");
              if (typeof value === "string" && /^[\t\r\n ]*[=+@-]/.test(text))
                text = "'" + text;
              return /[",\r\n]/.test(text)
                ? '"' + text.replaceAll('"', '""') + '"'
                : text;
            })
            .join(","),
        )
        .join("\r\n");
      return { bytes: Buffer.from("\uFEFF" + csv) };
    }
    if (a.format === "xlsx") {
      const ExcelJS = load("exceljs"),
        book = new ExcelJS.Workbook(),
        sheet = book.addWorksheet("Sheet1");
      sheet.addRows(a.rows || [[a.title]]);
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.columns.forEach((c) => {
        c.width = 24;
      });
      return { bytes: await book.xlsx.writeBuffer() };
    }
    if (a.format === "docx") {
      const d = load("docx"),
        children = [
          new d.Paragraph({ text: a.title, heading: d.HeadingLevel.TITLE }),
          ...(a.paragraphs || []).map((text) => new d.Paragraph(text)),
        ];
      if (a.rows?.length)
        children.push(
          new d.Table({
            rows: a.rows.map(
              (row) =>
                new d.TableRow({
                  children: row.map(
                    (value) =>
                      new d.TableCell({
                        children: [new d.Paragraph(String(value ?? ""))],
                      }),
                  ),
                }),
            ),
          }),
        );
      return {
        bytes: await d.Packer.toBuffer(
          new d.Document({ sections: [{ children }] }),
        ),
      };
    }
    if (a.format === "pptx") {
      const module = load("pptxgenjs"),
        ppt = new (module.default || module)();
      ppt.layout = "LAYOUT_WIDE";
      ppt.author = "Agent Foundation";
      ppt.title = a.title;
      for (const data of a.slides?.length
        ? a.slides
        : [{ title: a.title, body: a.paragraphs || [] }]) {
        const slide = ppt.addSlide();
        slide.addText(data.title, {
          x: 0.6,
          y: 0.4,
          w: 12,
          h: 0.8,
          fontSize: 28,
          bold: true,
          color: "172033",
        });
        slide.addText(data.body.join("\n"), {
          x: 0.6,
          y: 1.5,
          w: 12,
          h: 5.4,
          fontSize: 18,
          color: "243247",
          valign: "top",
        });
      }
      return { bytes: await ppt.write({ outputType: "nodebuffer" }) };
    }
    throw Error("Unsupported document generation format");
  }
  throw Error("Unsupported Office worker operation");
}
main().then(
  (result) => parentPort.postMessage({ result }),
  (error) => parentPort.postMessage({ error: String(error.message || error) }),
);
