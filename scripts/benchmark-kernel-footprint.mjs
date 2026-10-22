// @ts-check
// 先执行 npm run build；复现：node scripts/benchmark-kernel-footprint.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as idle } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const entry = new URL("../dist/index.js", import.meta.url);
const { values } = parseArgs({
  options: {
    child: { type: "boolean", default: false },
    samples: { type: "string", default: "5" },
    "idle-ms": { type: "string", default: "500" },
    output: { type: "string", default: "verification/kernel-footprint.json" },
    "scratch-root": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
const sampleCount = Number(values.samples);
const idleMs = Number(values["idle-ms"]);
assert.ok(
  Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 50,
);
assert.ok(Number.isInteger(idleMs) && idleMs >= 100 && idleMs <= 10000);

/** 只删除已解析且严格位于指定临时根内的目录。 @param {string} target @param {string} parent */
async function removeScratch(target, parent) {
  const parentPath = await realpath(parent);
  const targetPath = await realpath(target);
  const relative = path.relative(parentPath, targetPath);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative),
    "临时清理路径超出指定根目录",
  );
  await rm(targetPath, { recursive: true, force: true, maxRetries: 3 });
}

async function measure() {
  assert.ok(values["scratch-root"], "子进程需要指定临时根目录");
  assert.equal(typeof global.gc, "function", "子进程需要 --expose-gc");
  const scratch = await mkdtemp(path.join(values["scratch-root"], "sample-"));
  /** @type {import('../src/core/kernel.js').Kernel | undefined} */
  let kernel;
  /** @type {Awaited<ReturnType<typeof import('../src/api/server.js').serve>> | undefined} */
  let api;
  /** @type {unknown[]} */
  const errors = [];
  let sample;
  try {
    const started = performance.now();
    const { Kernel, parseConfig, serve, VERSION } = await import(entry.href);
    const config = parseConfig({
      server: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      dataDir: path.join(scratch, "data"),
      workspaceRoots: [path.join(scratch, "workspace")],
      extensions: { allowedRoots: [path.join(scratch, "extensions")] },
      execution: { boundary: "native" },
      defaultRoutes: { chat: "text", code: "text", office: "text" },
      routes: {
        text: {
          kind: "text",
          adapter: "openai-completions",
          model: "unused-footprint-model",
          baseUrl: "http://127.0.0.1:1/v1",
        },
      },
    });
    kernel = new Kernel(config);
    api = await serve(kernel, "local-footprint-benchmark-token");
    const readyMs = performance.now() - started;
    assert.ok(api.server.listening, "核心 HTTP 服务未就绪");
    await idle(idleMs);
    global.gc();
    const memory = process.memoryUsage();
    const maxRssKiB = process.resourceUsage().maxRSS;
    sample = {
      version: VERSION,
      pid: process.pid,
      readyMs,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      processMaxRssBytes:
        Number.isFinite(maxRssKiB) && maxRssKiB > 0 ? maxRssKiB * 1024 : null,
    };
  } catch (error) {
    errors.push(error);
  }
  try {
    if (api) await api.close();
    else await kernel?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await removeScratch(scratch, values["scratch-root"]);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "核心采样或清理失败");
  assert.ok(sample);
  return { ...sample, cleanup: "passed" };
}

/** @param {number[]} numbers */
function statistics(numbers) {
  const sorted = numbers.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    minimum: sorted[0],
    maximum: sorted.at(-1),
  };
}

async function benchmark() {
  const output = path.resolve(root, values.output);
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "foundation-footprint-"),
  );
  const environment = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const retainedEnvironment = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "TZ",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      retainedEnvironment.has(key.toUpperCase()),
    ),
  );
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: "",
    environment,
    sampleCount,
    idleMs,
    method:
      "串行启动独立 Node 子进程；动态导入 dist/index.js，使用全新 SQLite 数据目录初始化最小核心与端口 0 的 HTTP 服务；固定空闲后显式 GC，再采样。每个子进程关闭内核并清理临时目录。",
    scope:
      "空闲核心服务，默认内存功能配置、native 后端；没有项目、会话、模型调用、工具负载或可选宿主集成。",
    limitations: [
      "readyMs 从动态导入开始计时，包含配置、SQLite 初始化和 HTTP 就绪；不包含 Node 进程创建及本脚本静态导入。",
      "RSS 是采样时整个子进程的驻留内存；heapUsed 与 external 分别描述 V8 堆和关联原生分配，口径不同，不可相加为进程总内存。",
      "processMaxRssBytes 若可用，表示该子进程启动至采样时的历史最大 RSS，并非稳态内存；0 或不可用时记录 null。",
      "结果不含浏览器、办公工作线程、桌面桥接、真实模型请求、长会话及并发负载，不能作为其他产品的速度或内存对比。",
      "显式 GC、磁盘缓存、操作系统和主机其他活动会影响结果；五个样本不代表长期峰值或内存泄漏测试。",
    ],
    entrySha256: "",
    /** @type {Awaited<ReturnType<typeof measure>>[]} */
    samples: [],
    /** @type {Record<string, ReturnType<typeof statistics> | null>} */
    statistics: {},
    /** @type {string[]} */
    errors: [],
  };
  try {
    report.entrySha256 = createHash("sha256")
      .update(await readFile(entry))
      .digest("hex");
    for (let index = 0; index < sampleCount; index++) {
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          filename,
          "--child",
          "--idle-ms",
          String(idleMs),
          "--scratch-root",
          scratch,
        ],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      assert.ok(
        !child.error && child.status === 0,
        `第 ${index + 1} 个子进程失败：${child.error?.message || child.stderr || child.signal || child.status}`,
      );
      const sample = JSON.parse(child.stdout);
      for (const field of [
        "readyMs",
        "rssBytes",
        "heapUsedBytes",
        "externalBytes",
      ])
        assert.ok(
          Number.isFinite(sample[field]) && sample[field] >= 0,
          `无效采样字段 ${field}`,
        );
      assert.equal(sample.cleanup, "passed");
      report.samples.push(sample);
    }
    for (const field of [
      "readyMs",
      "rssBytes",
      "heapUsedBytes",
      "externalBytes",
      "processMaxRssBytes",
    ]) {
      const numbers = report.samples
        .map((sample) => sample[field])
        .filter((value) => value !== null);
      report.statistics[field] = numbers.length ? statistics(numbers) : null;
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.errors.push(String(error));
  }
  try {
    await removeScratch(scratch, os.tmpdir());
  } catch (error) {
    report.status = "failed";
    report.errors.push(String(error));
  }
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  assert.equal(report.status, "passed", report.errors.join("\n"));
  console.log(`核心空闲占用报告：${output}`);
}

try {
  if (values.help)
    console.log(
      "node scripts/benchmark-kernel-footprint.mjs [--samples 5] [--idle-ms 500] [--output verification/kernel-footprint.json]；先执行 npm run build，空闲主机上运行。",
    );
  else if (values.child) console.log(JSON.stringify(await measure()));
  else await benchmark();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
