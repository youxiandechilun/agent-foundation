# 热点优化修正与性能复测

日期：2026-10-18。修复基线：`a5316616db53c9cf80e1c32b06bb09ee6a855722`。更早对照：`eb88ae5f101489a9abca4a2eb00f8bc272cced32`。沿用 Node.js、TypeScript strict、ESM、SQLite 和现有依赖。

## 修正范围

1. **事件会话归属与数据库一致。** 移除 `Store.runSessions` 记录值缓存，改用复用的 prepared statement 从 `runs_session` 部分表达式索引读取 `json_extract(body,'$.sessionId')`。会话值由 SQLite 随 Run 写入和事务维护，避免反复解析完整 Run，也避免其他连接或进程更新、删除 Run 后继续使用旧缓存。实际发出事件时，缺失 Run 仍在事件写入前返回 `404/not_found`。
2. **脱敏值不从缓存恢复。** 事件使用持久化后的会话标识；当原始 `sessionId` 命中 secret 脱敏规则时，事件和回放保持相同脱敏结果。不会从未脱敏入参建立另一份记录缓存。
3. **自定义 provider 的工具数组保持请求隔离。** 保留工具定义缓存，每次请求仅 `slice()` 复制数组。provider 可以继续对可变的 `request.tools` 使用 `splice()` 等操作，后续模型步骤和下一次运行仍能获得完整工具。没有冻结数组或修改公开类型契约。
4. 修正 `Kernel.hooksFor` 的同行挤压格式，并格式化本轮涉及文件。

保留 `a531661` 的 JSON 文本脱敏、免返回副本的 `Store.write()`、成本日期索引和无人订阅时省去临时事件工作的优化。`emitEphemeral()` 无监听器时直接返回、不验证 Run 和载荷，是该版本已有行为；本次一致性保证针对实际发送的事件。

## 功能验证

新增六项回归场景，使用真实 SQLite、Store 和 ExecutionEngine，覆盖另一连接更新和删除、独立进程提交、带转义字符及中文的会话标识、`put`/`write` 的脱敏一致性、嵌套保存点及事务回滚、多步调用与重复运行的工具数组隔离。

验证结果与原始日志保存在 `verification/hotpath-fix/validation.json` 及同目录日志中。存储测试的修前失败和定向结果见 `storage-targeted.json`；该文件明确标注为工具会话结果的结构摘要和摘录，不冒充完整 stdout。

| 检查                                              | 实际结果                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| 核心及宿主 TypeScript 构建                        | 通过                                                                      |
| 两个新测试文件及依赖的 strict / noUnused 类型检查 | 通过                                                                      |
| 核心全量                                          | 461/461，通过；无失败、取消或跳过                                         |
| 宿主路由边界、Office、HTTP/WebSocket 节点集成     | 4/4，通过；无跳过                                                         |
| 核心编译产物冒烟                                  | 通过                                                                      |
| 宿主编译产物冒烟                                  | 通过，包括真实 Chromium、Office worker、Windows bridge inspect 和配对流程 |

本轮没有重跑涉及真实桌面输入的全部宿主用例，也没有调用外部付费模型。宿主冒烟中的 `inspect` 成功不等价于全部原生 UI 输入测试通过。

## 性能方法与边界

同一台 Windows 机器、同一 Node 版本和依赖，分别重新编译 `eb88ae5`、`a531661` 与修复后的源码。两个隔离历史目录的 `node_modules` 均链接到本工作区同一依赖目录，锁文件未变。使用以下可复跑脚本：

- `scripts/benchmark-hotpaths.mjs`：参数、独立进程编排、源文件及编译产物指纹、原始数据和汇总。
- `scripts/benchmark-hotpaths-worker.mjs`：真实 Store 与序列化工作负载、计时、数据库隔离和结果检查。
- `scripts/benchmark-hotpaths-engine.mjs`：本机 HTTP/SSE、生产 HttpTextProvider、ContextManager、ExecutionEngine、工具执行、事件和 transcript。
- `scripts/benchmark-hotpaths-fixtures.mjs`、`scripts/benchmark-hotpaths-report.mjs`：分别提供本机响应及请求数据夹具、文件指纹与统计。

正式采样使用六轮；三个版本轮换并反转顺序，覆盖六种排列。每个版本、场景、轮次启动独立 Node 子进程，先预热一次；每次预热和正式计时使用独立的新 SQLite 文件。建库、数据准备、事后结果断言和清理不计入耗时，执行工作计入。本机 HTTP 夹具在请求处理中的解析、校验和响应生成也计入 Engine 时间。计时前显式 GC；采样串行，不与本轮构建或测试并行。保存每个样本、预热数据、中位数、最小值、最大值、运行环境和源码/脚本 SHA256。

场景包括 200 条消息和 40 个工具的请求序列化、64 个 Run 下的持久及临时事件、小 Run（512 字节输入）与较大 Run（64 KiB 输入）、含幂等重试的 transcript 追加，以及三模型步骤、两次真实工具执行的本机 Agent 流程。

**这些结果不代表真实模型推理或公网请求提速。** 本机 Agent 场景没有外部模型推理延迟，也没有完整 Kernel 授权、原生桌面输入或所有业务能力。无人订阅事件场景测量的是消除不可观察工作的收益，不能外推为整个 Agent 的倍速。RSS 前后值不是峰值内存；本报告不据此宣称峰值内存下降。

耗时变化以相同规模的中位数比较：耗时降低比例为 `1 - 新耗时 / 旧耗时`；吞吐倍数为 `旧耗时 / 新耗时`。两者含义不同，不混用百分比。

## 最终实测结果

环境：Windows x64、Intel Core i7-12700H、Node.js v22.22.0、SQLite 3.50.4。最终采样共 162 个独立进程，全部结果断言和前后文件指纹检查通过。下表单位为每批次毫秒，均为六轮中位数。

| 场景与工作量                                    | 优化前 eb88ae5 | 用户版本 a531661 | 本次最终版 | 相对优化前耗时 | 相对用户版本耗时 |
| ----------------------------------------------- | -------------: | ---------------: | ---------: | -------------- | ---------------- |
| 请求 JSON 脱敏序列化，200 次                    |         136.86 |            94.33 |      98.25 | 减少 28.2%     | 增加 4.2%        |
| 持久事件，小 Run，2,000 次                      |       1,028.57 |           975.94 |   1,000.03 | 减少 2.8%      | 增加 2.5%        |
| 持久事件，64 KiB Run，2,000 次                  |       1,243.24 |           979.71 |   1,006.51 | 减少 19.0%     | 增加 2.7%        |
| 有订阅临时事件，小 Run，5,000 次                |         361.41 |           323.52 |     353.81 | 减少 2.1%      | 增加 9.4%        |
| 有订阅临时事件，64 KiB Run，5,000 次            |         716.23 |           314.99 |     348.17 | 减少 51.4%     | 增加 10.5%       |
| 无订阅临时事件，小 Run，5,000 次                |         376.73 |             0.66 |       0.72 | 减少 99.81%    | 增加 7.9%        |
| 无订阅临时事件，64 KiB Run，5,000 次            |         712.51 |             0.62 |       0.67 | 减少 99.91%    | 增加 8.1%        |
| Transcript，1,000 条追加及 250 次幂等重试       |         554.94 |           551.63 |     549.88 | 减少 0.9%      | 减少 0.3%        |
| 本机 Agent，10 次运行，每次 3 步及 2 次工具调用 |         274.02 |           251.43 |     250.73 | 减少 8.5%      | 减少 0.3%        |

相对用户版本，本机 Agent 流程与 transcript 追加基本持平，不能把约 0.3% 的中位数差异认定为稳定改进。Agent 六轮范围分别为：优化前 264.60–287.77ms、用户版本 241.77–292.47ms、最终版 241.15–267.83ms。

请求序列化和无订阅快速返回路径在 `a531661` 与最终版之间没有修改；这些路径的差异属于本轮样本观测，不能归因于本次代码提速或退化。无订阅批次不足 1ms，百分比尤其容易放大微小计时波动。其相对更早版本的收益来自用户已有优化，本轮予以保留。

有订阅事件现在每条都读取数据库中正确的会话归属，替代不能可靠失效的内存缓存。相对用户版本，5,000 条事件的批次耗时增加约 30–33ms，折合每条约 6–7 微秒。索引让大 Run 不再为此反复解析完整 JSON，保留了相对优化前的大部分收益，但本轮没有实现所有路径全面提速。

原始样本、中位数及最小/最大值见 `verification/hotpath-fix/benchmark.json`；汇总及文件哈希见 `report.json`、`artifact-hashes.json`。首轮 SQL 投影版和最终索引版分别采样，不能将两轮中位数之差当作严格的同批次因果估计。

## 索引方案的验证与成本

第一轮只删除值缓存、直接 SQL 投影的方案已经通过功能验证，但 64 KiB Run 的有订阅临时事件中位耗时为 675.82ms/5,000 次，仍包含反复解析 Run JSON 的开销。该轮原始数据保留在 `verification/hotpath-fix/benchmark-projection.json`，不是最终版本的性能结论。

随后在隔离数据库验证部分索引 `runs_session(id,json_extract(body,'$.sessionId')) WHERE kind='runs'`。默认 planner 即使经过 `ANALYZE` 仍选择实体主键，所以事件归属查询显式使用 `INDEXED BY runs_session`。SQLite VM 显示结果直接来自索引列，没有执行 `json_extract` 的 Function，也没有读取完整 body。完整 SQL、查询计划、VM、原始样本与边界检查见 `verification/hotpath-fix/index-probe.json`。

六轮局部微基准中，10,000 次大 Run 归属查询由 628.67ms 降到 44.41ms；小 Run 由 64.33ms 降到 51.97ms。该比例只解释新增索引解决的重复 JSON 解析开销，不能当作整个 Agent 提速。

索引也有成本：同一实验中，400 次 Run 写入的小记录耗时增加约 2.1%，较大记录增加约 9.4%；64 条 Run 的索引增加 4,096 字节，首次构建分别耗时约 0.66ms 和 6.24ms。已有数据库会在首次打开新版 Store 时创建该索引，首次启动和额外写入成本不计入后面的事件读基准。大型历史库的构建耗时尚未测量。

## 复跑入口

准备两个历史源码目录并安装相同锁文件依赖，分别用各自的 `tsconfig.core.json` 构建到 `dist`；当前版本运行 `npm run build`。历史目录不在当前源码树内覆盖文件。

```powershell
node scripts/benchmark-hotpaths.mjs --help
node scripts/benchmark-hotpaths.mjs --version=eb88ae5=before/dist --source=eb88ae5=before/src --version=a531661=remote/dist --source=a531661=remote/src --version=fixed=dist --source=fixed=src --rounds=6 --output=verification/hotpath-fix/benchmark.json
```

这里 `before` 和 `remote` 为复跑者准备的历史目录；脚本只读取显式指定的目录，不自动检出、构建或覆盖源码。`--smoke` 仅用于小规模正确性检查，不是正式性能证据。

功能检查入口：

```powershell
npm run build
npm run build:host
node scripts/run-core-tests.mjs
node scripts/run-core-tests.mjs --host --filter=host-route-boundaries --filter=host-office --filter=host-nodes
node test/smoke.compiled.mjs
node test/smoke-host.compiled.mjs
node node_modules/typescript/bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --esModuleInterop --target ES2023 --module NodeNext --moduleResolution NodeNext test/storage-event-consistency.test.ts test/runtime-tool-isolation.test.ts
node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --strict scripts/benchmark-hotpaths.mjs scripts/benchmark-hotpaths-worker.mjs scripts/benchmark-hotpaths-engine.mjs scripts/benchmark-hotpaths-fixtures.mjs scripts/benchmark-hotpaths-report.mjs
```

## 代码量口径

统计 `src`、`extensions`、`test`、`scripts`、`examples` 中 TS、MTS、CTS、JS、MJS、CJS、PY、SH、PS1、CS、INO、HTML 的物理行数，包含空行和注释。依赖、编译输出、文档、JSON 配置和临时快照不计入。新增测试和基准脚本仍计入维护代码，不能只统计被删除的缓存代码。

| 范围       | 用户版本 a531661 | 本次最终版 |   变化 |
| ---------- | ---------------: | ---------: | -----: |
| src        |           33,558 |     33,553 |     -5 |
| extensions |              429 |        429 |      0 |
| test       |           26,348 |     26,629 |   +281 |
| scripts    |            3,515 |      4,554 | +1,039 |
| examples   |              545 |        545 |      0 |
| 合计       |           64,395 |     65,710 | +1,315 |

生产目录 `src + extensions` 由 33,987 行降至 **33,982 行**，净减少 5 行。六项边界回归与可复跑基准增加了维护代码；这次没有删除已有测试或功能，也不将新增验证代码排除后宣称全仓缩小。逐文件行数、字节数和 SHA256 见 `verification/hotpath-fix/source-metrics.json`。

20,000 行目标尚未达到；本轮是热点修正及可复现测量，不能据此断言未来结构优化一定可以或不可能达到该目标。
