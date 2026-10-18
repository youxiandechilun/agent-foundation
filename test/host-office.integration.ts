import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  setupDesktop as setup,
  collect,
  until,
  wireServer,
} from "./support/wire-server.js";
import { makeTools } from "../src/tools/index.js";
import { parseCsv } from "../src/host/office/manager.js";
import { safePath } from "../src/core/util.js";

test("office reads actual CSV, computes grouped statistics, transforms rows, creates and reparses DOCX/XLSX/PPTX", async () => {
  const x = await setup();
  try {
    const asset = await x.client.upload(
      x.project.id,
      "source.csv",
      Buffer.from('部门,金额,备注\n开发,17,"a,b"\n开发,23,ok\n设计,9,ok\n'),
    );
    const stats = await x.kernel.office.analyze(x.project.id, {
      assetId: asset.id,
      valueColumn: "金额",
      groupBy: "部门",
    });
    assert.equal(stats.groups.find((g) => g.group === "开发")?.sum, 40);
    assert.deepEqual(parseCsv('a,b\r\n"x\ny","a""b"\r\n')[1], ["x\ny", 'a"b']);
    const transformed = await x.kernel.office.transform(x.project.id, {
      assetId: asset.id,
      name: "sorted",
      format: "xlsx",
      filter: { column: "部门", equals: "开发" },
      sort: { column: "金额", direction: "desc" },
    });
    const rows = (await x.kernel.office.table(x.project.id, transformed.id))[0]
      .rows;
    assert.equal(rows.length, 3);
    assert.equal(Number(rows[1][1]), 23);
    assert.match(
      (await x.kernel.assets.extract(transformed.id, x.project.id)).text,
      /开发/,
    );
    for (const format of ["docx", "pptx"] as const) {
      const generated = await x.kernel.office.create(x.project.id, {
        format,
        name: "result",
        title: "实际内容标题",
        paragraphs: ["源数据开发部门合计 40。"],
      });
      const parsed = await x.kernel.assets.extract(generated.id, x.project.id);
      assert.match(parsed.text, /实际内容标题/);
      assert.match(parsed.text, /40/);
    }
  } finally {
    await x.close();
  }
});
