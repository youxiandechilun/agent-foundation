# Agent 底座执行效率与可靠性重构记录

日期：2026-10-18。环境：Windows、Node.js v22.22.0、SQLite 3.50.4。工程位置：`C:\Users\32761\Desktop\agent\agent-foundation`。

## 目标与实际范围

本次目标是在保留能力与合法调用契约的前提下，减少重复实现和运行开销，改善取消、并发及异常处理，并评估是否能将维护代码缩减到 20,000 行以内。

**20,000 行目标未达到。** 本轮在既有重构成果上继续优化，没有删除功能、旧测试或平台实现。生产源码的净减行很小，新增正确性处理抵消了大部分去重；新增回归测试使全部维护代码行数增加。本报告不将局部性能提升表述为全局代码精简，也不据此宣称所有行为已得到穷尽验证。

开始时工作区已有大量未提交修改，本轮基线是完整文件快照，不是 Git HEAD：

```text
C:\Users\32761\Desktop\agent\agent-foundation\.agent-data-refactor\consolidation-20261018-before
```

该快照保留源码、测试、脚本、示例、扩展、编译结果、配置、文件哈希与开始时的 Git 状态。基线源码另行重新编译通过，避免用旧编译输出冒充本轮对照。沿用 TypeScript strict、Node、SQLite、ESM 和现有依赖；未升级版本、迁移架构、提交 Git 或发布包。

## 已实现的变化

| 范围        | 具体变化                                                                                      | 保留的边界与实际收益                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| HTTP 路由   | 七组管理路由共用精确路由分发、输入解析与响应状态封装；输入 schema 在模块加载时构建            | 请求仍逐次校验与授权；保留 201/202、下载与 SSE 的处理；已覆盖的多余路径段返回 404，避免误入实体修改操作                  |
| JSON Schema | 按 dialect 复用 Ajv；LRU 上限为 256 项、4 MiB 序列化输入；编译器每 64 次或累计 1 MiB 输入轮换 | 保留 schema 深度、大小、远程引用和异步 schema 限制；不延迟运行开始前的完整校验；清除用户 ID，保留内建元 schema 别名      |
| SQLite      | Memory 复用有界预编译语句；共用 JSON 查询解码与索引清理；迁移回执按项目和幂等键在 SQL 内过滤  | 不缓存数据库记录和授权结果；跨 await 的语义检索游标仍独享 statement；回执查询避免全量反序列化                            |
| 文件检查点  | 分组时追加元素，替代反复复制已有数组                                                          | 分组总开销从 O(n²) 降为 O(n)，保留排序和内容                                                                             |
| MCP         | 同连接、同目录版本的并发目录请求共享在途分页                                                  | 完成后立即移除，下次调用仍访问服务端；调用者独立取消，最后一人退出才取消共享请求；结果深拷贝，版本变化和重连不接纳旧响应 |
| 插件        | native IPC 与隔离 stdio 复用调用结算、超时、取消、输出限制及终止清理                          | 保留 IPC 的 exit 与隔离 stdio 的 close 语义；发送、准备与终止失败有明确拒绝路径；UTF-8 结果按字节限额                    |
| Hook        | 四类 Hook 在运行取消时停止等待，不再启动后续 Hook                                             | 保留已启动 Hook 的清理机会；取消原因不变成普通观察错误或授权拒绝                                                         |
| SSE         | 读指针取代 queue.shift；已消费载荷立即释放；载荷字节数只计算一次                              | 队列维护摊销线性，保留 16 MiB 队列限制、顺序、水位和清理；历史未回放完时溢出先结束连接，避免重连跳过中间事件             |
| 文件补丁    | 两次 indexOf 检查唯一匹配；用替换回调写入新内容                                               | 减少 split 分片分配，保留非重叠匹配语义；`$&`、`$$`、`$'` 等按原文写入                                                   |

路由七个实现文件减少 174 行，共享路由辅助文件增加 42 行，合计净减 132 行。插件 manager 减少 119 行，调用辅助文件增加 116 行，合计净减 3 行。不能只统计被拆出的原文件而忽略新增文件。

## 代码量口径

统计 `src`、`extensions`、`test`、`scripts`、`examples` 中 TS、JS、MJS、CJS、PY、PS1、CS、HTML、SH 等源文件的物理行数，包含空行和注释；文件末尾换行不另算一行。排除依赖、编译输出、文档、JSON 配置、历史快照和临时验证程序。它是上述维护目录的统计，不是磁盘上全部代码副本或实验程序的总量。

最终数据由以下报告记录，每个文件包含行数、字节数及 SHA256，使用同一口径比较本轮开始与结束：

```text
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-source-metrics.json
```

本轮开始时生产目录 `src + extensions` 共 33,945 行，测试、脚本、示例计入后共 63,185 行。即使只看生产目录也高于 20,000 行。继续大幅缩减需要逐模块证明替代实现的功能等价性，当前结果不足以证明这个数字目标可以安全达到；不能用移走源码、排除现有模块或压缩排版宣称达标。

最终统计：

| 范围       | 本轮开始 | 本轮结束 |   变化 |
| ---------- | -------: | -------: | -----: |
| src        |   33,516 |   33,511 |     -5 |
| extensions |      429 |      429 |      0 |
| test       |   25,184 |   26,348 | +1,164 |
| scripts    |    3,511 |    3,511 |      0 |
| examples   |      545 |      545 |      0 |
| 合计       |   63,185 |   64,344 | +1,159 |

生产目录合计 33,940 行，净减 5 行、304 字节；全部上述维护目录由 269 个源文件增至 276 个。新增测试保障本轮边界修复，但这不构成“代码量已经减少”的结果。

## 性能验证方法与解释

基准比较本轮快照与当前实现，不与历史发布报告混算。SQLite 使用实际数据库，SSE 使用生产函数加受控响应门；Schema 使用独立子进程。性能样本只说明相应场景，不是模型生成速度、推理质量或完整 Agent 端到端延迟。

SQLite 五轮交替执行，以下为中位数：

| 场景                         |       基线 |      当前 | 说明         |
| ---------------------------- | ---------: | --------: | ------------ |
| 3,000 次同内容 Memory.put    |  521.88 ms | 409.47 ms | 约减少 21.5% |
| 3,000 次记忆历史读取         |   91.32 ms |  47.33 ms | 约减少 48.2% |
| 1,500 次关键词检索           |  103.95 ms |  71.74 ms | 约减少 31.0% |
| 3,000 条回执下 90 次幂等重试 | 1309.32 ms | 306.05 ms | 约减少 76.6% |

SSE 五轮队列 drain 中位数：10,000 条为 2.49 → 2.35 ms；20,000 条为 517.56 → 1.59 ms；40,000 条为 2094.43 → 3.92 ms；60,000 条为 4802.54 → 5.90 ms。该测量隔离了网络开销，不能解释为 HTTP 吞吐提升同等倍数。旧实现的数组 shift 在积压扩大时成本显著上升，新实现使用读指针处理。

MCP 真实 HTTP 回归中，12 个并发目录调用共享两次分页请求；取消其中一个后其余 11 个成功。完成后再次调用会重新请求，不使用长期目录缓存。测试另覆盖版本变更、全部调用者取消后重试和重连。

Schema 最终基准使用五轮前后交替的独立进程；每个样本内部包含 96 个 schema 冷编译、五次重复目录和 512 个唯一 schema 轮换。独立采样轮数与样本内重复次数分别记录，包含原始样本、硬件、依赖与输入 SHA256。4 MiB 是缓存的序列化输入预算，并不等于 JavaScript 总堆上限。

| Schema 场景（五个独立样本的中位数） |        基线 |        当前 |
| ----------------------------------- | ----------: | ----------: |
| 96 个 schema 冷编译                 |   477.90 ms |   113.43 ms |
| 五次重复目录                        |  1681.24 ms |     7.46 ms |
| 512 个唯一 schema 轮换              |  1600.32 ms |   131.47 ms |
| 目录后 GC 保留堆增量                | 3,412,376 B | 2,332,416 B |
| 轮换后 GC 保留堆增量                | 3,888,584 B | 2,077,184 B |

重复目录的收益与 LRU 从 64 增至 256、测试目录含 96 个 schema 有直接关系；不同目录规模和命中率下需重新测量。轮换与保留堆数据用于检查重复编译的成本和引用保留，不能据此证明长期服务内存绝不会增长。

基准脚本与结果：

```text
C:\Users\32761\Desktop\agent\agent-foundation\.agent-data-refactor\schema-benchmark.mjs
C:\Users\32761\Desktop\agent\agent-foundation\.agent-data-refactor\consolidation-storage-benchmark.mjs
C:\Users\32761\Desktop\agent\agent-foundation\.agent-data-refactor\consolidation-event-queue-benchmark.mjs
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-schema-benchmark.json
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-storage-benchmark.json
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-event-queue-benchmark.json
```

## 正确性与兼容验证

基线核心回归 430/430 通过。第一次整体验证的核心回归 453/453、宿主回归 33/33 通过，核心/宿主构建、编译后冒烟和源码独立性检查也通过。之后独立审查发现共享 Ajv 清理时误删内建通用元 schema 别名的问题，已修复并独立复核 8/8 schema 用例；另恢复插件两种传输各自的退出事件语义。

最终源码的核心/宿主构建、完整回归、编译后冒烟与输入哈希由以下独立报告记录。报告运行中标记为 running，只有所有阶段完成才可作为最终结果：

```text
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-final-validation.json
```

最终整轮的两个构建、核心 **455/455**、核心与宿主编译后冒烟通过，验证期间 276 个源文件哈希未变。宿主整轮 **32/33**：原生输入测试出现 `Windows denied foreground focus`；另一次完整宿主复查为 **31/33**，原生 UI Automation 测试文本多出前缀 `l`，输入测试报告目标窗口不在前台。首轮宿主 **33/33** 通过的记录不能替代这两次失败。失败日志完整保留，没有跳过、放宽断言或不断重跑至绿色。

原生控制 manager、PowerShell 入口与该测试在本轮前后 SHA256 一致。桌面焦点变化与外部输入是可能影响，具体触发来源尚不确定；当前不能把宿主验证写成全部通过。复查报告：

```text
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-final-host-recheck.json
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-final-host-tests.log
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-final-host-recheck.log
```

新增用例覆盖精确路径、状态码、下载字节、Hook 取消、schema 缓存与 ID 清理、Memory 查询、幂等回执、插件结果/清理、MCP 并发与 SSE 背压。SSE 测试使用真实 HTTP 慢消费者，验证 40,000 条实时事件、历史回放时 UTF-8 溢出后的重连补齐，以及断开后的订阅和 drain 等待释放。未删除既有测试。

公开 SDK 的根入口、`/client`、`/host` 运行时及声明导出名分别为 54/136、2/3、4/5，对照重新编译的本轮基线没有增删。导出名比较不等同于证明所有下游签名、序列化内容或行为都兼容。隔离消费者验证使用独立临时 npm 包和既有验证脚本，包路径与每项结果见最终汇总报告，不覆盖原发布包。

本轮的变更测试另执行 TypeScript strict/noUnused noEmit，避免把测试 runner 的转译当成严格类型检查；全部本轮变更 TS 文件执行 Prettier 检查。每次失败与修复后的结果独立保存，不用新日志覆盖失败证据。

统一静态检查发现一处基线已存在的测试环境变量类型缺口。完整回归结束后，仅在该测试辅助函数中显式排除 undefined，并用类型谓词收窄，不修改生产逻辑。随后 **11 个变更测试及其导入依赖的 strict/noUnused/noEmit 通过、37 个变更 TS 文件的 Prettier 检查通过、MCP 客户端 6/6 定向回归通过**。最终完整回归之后的文件哈希差异仅有此测试，汇总报告单独列出，不将后续修改隐瞒在整轮输入快照中。

整个既有工作区的 `git diff --check` 仍报告旧的应用验证日志两行尾空白；该日志在本轮开始前已修改，本轮未触碰。源码与本轮文档的定向检查另行记录，保留旧验证日志原文。

验证限制：本机 Windows 和当前 Node 版本；没有在 Linux/macOS、其他 Node 版本或外部厂商实际服务上重跑完整回归，没有执行付费模型推理与 Docker 隔离实测。本机宿主冒烟不等于全部平台和外部应用的认证测试；没有做长期压力、完整 API 组合或完整 Agent 端到端性能验证。

## 复现

在工程根目录运行；会生成本轮验证文件和临时目录，不涉及远端发布：

```powershell
npm run build
npm run build:host
node scripts/run-core-tests.mjs
node scripts/run-core-tests.mjs --host
node test/smoke.compiled.mjs
node test/smoke-host.compiled.mjs
node .agent-data-refactor/consolidation-metrics.mjs
node .agent-data-refactor/consolidation-exports.mjs
node .agent-data-refactor/schema-benchmark.mjs --prepare
node .agent-data-refactor/schema-benchmark.mjs --sample
node .agent-data-refactor/consolidation-storage-benchmark.mjs
node .agent-data-refactor/consolidation-event-queue-benchmark.mjs
```

性能测量应避开并行完整回归。临时基准依赖本机保留的开始快照，其文件不属于 SDK 发布内容。完整交付状态、各报告路径、最终文件规模与哈希以本轮汇总为准：

```text
C:\Users\32761\Desktop\agent\agent-foundation\verification\consolidation-report.json
```
