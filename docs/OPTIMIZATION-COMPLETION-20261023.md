# 2026-10-23 审查问题修复与容量优化

基线为 `6b1a109`。本轮落实规范性、可扩展性、执行效率和内存审查，维持三个 SDK 入口、现有 HTTP 格式、精确语义评分与审计修订契约。最终执行结果记录在 `verification/optimization-completion-20261023/validation.json`。

## 取消与真实资源所有权

`bindHooks()` 将真实 `preToolUse`、`postToolUse` 回调完成状态传递给执行引擎。一次工具执行登记所有实际 Promise，取消调用方的等待不会提前释放调度槽或同资源读写锁。正常结束、迟到成功和迟到失败均只释放一次。命令 hook 的 Promise 在终止操作和子进程 `close` 都结束后才结算。

同一所有权贯通宿主 `integration.authorize` 和安全审计实际规则工作，避免授权或审计内部的取消/超时包装提前结算。进程控制入口的既有调度租约也覆盖审计、授权、审批和执行；真实回调结束前继续占槽。授权上下文现在包含可选取消信号，旧三参数实现保持兼容。原生模型网页搜索继续沿用其既有调度模型，本轮没有把它改为工具调度任务。

回归覆盖 pre/post hook、执行槽/同资源写锁、迟到成功/拒绝共八种组合，另验证真实命令 PID 已退出。取消依然可以及时返回；不响应取消且永不结束的宿主 JavaScript 会继续占用容量，宿主回调应让返回的 Promise 表示真实操作与必要清理已经完成。

## HTTP JSON 准入

同一 Kernel 的 HTTP 服务共享 JSON 解析准入。在分配声明长度的 Buffer 之前检查并发与字节预算。已声明请求预留 `Content-Length`，chunked 请求保守预留该路由的完整上限；同一请求只读取、解析一次。

租约需要解析器、真实处理函数、传输三者均结束才释放。客户端断开会终止请求体读取，但不能使仍保留解析对象的异步宿主处理函数提前归还容量。错误、正常响应、断连及不响应取消的宿主回调均有回归。

新增 `limits` 默认值：

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `maxConcurrentJsonRequests` | 8 | 同时读取、解析或仍由处理函数持有的 JSON 请求 |
| `maxInFlightJsonBytes` | 256 MiB | 上述请求的输入字节预留总量 |
| `maxConcurrentSessionExports` | 2 | 同时打开的会话导出快照 |
| `maxSessionExportBytes` | 128 MiB | 单次会话导出线上 JSON 字节数 |
| `sessionExportTimeoutMs` | 60,000 ms | 导出快照及慢传输的最长等待 |

项目创建、会话创建及会话属性修改采用 64 KiB 请求体上限；普通 JSON 路由继续使用 8 MiB；迁移导入继续沿用原有按 `maxMigrationBytes` 计算的传输上限，同时受总 JSON 预算限制。`429 / resource_capacity` 表示准入不足；单请求超限继续返回 413。

输入字节预留不是 RSS 硬限制。解码字符串、解析对象、响应、SQLite、原生库与宿主自行保留的对象还有额外开销。配置较大的迁移导入时，也应相应规划总 JSON 预算。

## 会话导出

`GET /v1/sessions/:id/export` 保持 `foundation-session-v1`、完整会话元数据与消息顺序，改为独立只读 WAL 快照。会话和消息从同一快照读取，发送前验证完整线上字节数。

会话和记忆导出共用内部流式实现：每批最多 32 条、约 1 MiB 原始 JSON，一条完整记录可以超过批次字节目标。每批 SQLite iterator 在异步让出或网络写入前结束，断连、超时和异常都能关闭快照并释放名额。HTTP 按背压输出，不再构造全量会话对象和完整响应字符串。

发送前的 `COUNT/SUM` 仍为同步 SQL 扫描；JavaScript 超时不能抢占这段工作。慢读快照仍会延后 WAL 回收，超时和并发限制用于限制这类持有。SDK 的完整历史读取接口保持原返回契约。

## 现代 MCP 任务结果保留

现代任务完成或宿主上下文结束后，移除原始参数、`localContext`、监听闭包和活跃 controller 引用。保留结果改为 Buffer 序列化快照，继续支持陈旧快照返回、任务 ID 去重和终态结果不可替换。关闭客户端会清空全部活跃状态、快照和预留。

`MCPClientOptions.maxTaskSnapshotBytes` 默认为 64 MiB，计入快照字节及每任务 4 KiB 元数据预留。现代 tasks 扩展协商成功后，新的 `tools/call` 在发送前预留 `maxMessageBytes + 4 KiB`；普通即时结果或失败请求归还未认领预留。活跃及 unknown 任务保留最大预留，已验证终态缩减为实际快照字节。原 4,096 个累计任务 ID 上限保留。

默认 8 MiB 消息上限下，空池可同时接受 7 个最坏预留。协商任务扩展后的普通工具调用也需要先预留，因为发送前不能确定服务器会返回即时结果还是任务；高并发独立客户端可按内存规划调整 `maxTaskSnapshotBytes`。

池满会在发出新工具副作用之前返回 `resource_capacity`；可调整容量或显式重连。已完成任务后续 metadata 增大且超过剩余空间时，更新明确失败并保持最后已验证快照与持久事件不变。单个序列化任务快照也受 `maxMessageBytes` 限制。预算不包括暂态解析对象或宿主自行保存的数据。

快照在创建、更新的状态提交和回调通知前完成编码与预算验证，释放时直接转移已验证快照。数字使用等值的短 JSON 表示，避免合法短指数帧重新编码成较长小数后在释放阶段才超限；字符串和键不参与数字替换。客户端关闭在调用任何宿主回调前登记同一个完成 Promise，任务通知、在途请求、传输、宿主清理和授权缓存清理逐项尝试；回调或某项清理抛错不跳过后续资源，错误聚合后保留 `isolation_cleanup_failed` 语义，重复关闭复用同一结果。

必要结果由 V8 堆转为 Buffer 的部分不能算作同等总内存节省。对照报告同时保留 RSS、heapUsed、external、arrayBuffers 与关闭后的回收情况，见 `mcp-memory.json`。

## 记忆清理与存储游标

新增 `MemoryStore.pruneExpiredAsync(projectId, { batchSize?, signal? })`，默认每批 100 条，可设 1–1,000 条。批间交还事件循环，同项目重复在途请求返回 `memory_prune_capacity`。HTTP 清理使用该入口并传递取消信号；原同步 SDK 方法保留。

每批在事务中完成修订、实体、FTS 和向量处理，失败批次整体回滚。取消保留此前已提交批次。清理使用开始时的截止时间和记录水位，避免并发新增记录使清理任务无限延长。删除当前记忆后继续保留历史全文属于原审计契约。

实体表统一使用 `seq INTEGER PRIMARY KEY AUTOINCREMENT`，继续以数值 `rowid` 游标分页；删除尾行或清空表后，不再向后续新记录复用序号。旧库在事务中显式复制 `rowid → seq`，保留当前有效游标、正文、索引、触发器和视图。外键检查在事务外临时关闭，重建完成后在提交前执行 `foreign_key_check`，最后恢复约束，避免 DROP 触发宿主子表级联删除。

非标准自定义实体列明确返回 `storage_schema_conflict`，原表和值保持不变，避免自动重建时静默丢列。物理表布局属于内部实现，原始 SQL 写入应明确列名。升级前已删除且没有持久记录的最高游标水位无法推导恢复；本轮保证升级后序号不会再次复用。

路由删除的 Agent、未归档会话引用检查使用有索引的存在性查询，不再构建完整实体列表。

## 数据容量与语义扫描诊断

新增显式、需要 HTTP token 的 `GET /v1/storage/stats`，SDK 可调用 `kernel.store.storageStats(signal?)`，独立客户端可调用 `client.storageStats(signal?)`。

统计包含各实体、消息、事件和向量表的行数、JSON/向量/文本字节，数据库文件、WAL、SHM、页数与空闲页，以及资产、检查点、迁移暂存目录的文件数与字节。每个 Store 同时最多一项统计，独立只读快照每批 256 行，批间让出并可取消。目录遍历最多同时打开一个枚举句柄，深度上限 64、待处理目录上限 4,096，超限返回 `storage_stats_capacity`。

目录统计在 SQL 扫描后采样，不是文件系统原子快照。静态符号链接只计数不跟随；诊断不作为阻止恶意并发目录替换的安全边界。本轮不自动删除审计、检查点或被引用资产，统计用于制定显式归档和保留策略。

新增 `semanticSearchWithStats()` 返回 `{ memories, stats }`，包含扫描行数、实际评分行数、向量字节、维度与本地扫描耗时。`semanticSearch()` 的原返回值、Float64 精确评分、同分顺序和取消语义保持不变。扫描仍为 O(N×D)，规模基准用于判断何时需要额外向量索引，不声称引入 ANN 或改变检索排序。

## 构造回滚、能力发现与工程门禁

Kernel 在获取 Store 租约前校验计费投递参数。整个服务组装统一回滚 Store 和脱敏作用域，计费恢复放到组装最后，失败后同进程可立即重建。Store 自身初始 PRAGMA、函数注册、schema 与迁移失败也会关闭连接。

`/v1/capabilities.textProtocols` 来自当前 Kernel 的实际协议注册表。浏览器桥接 JavaScript 纳入 ESLint/Prettier；SDK 隔离消费验证加入紧凑的调用方类型契约，检查三个公开入口与旧宿主回调签名兼容。Linux CI 增加与 Windows 一致的非交互宿主集成，安装 Chromium 及系统依赖。

## 验证与复现

本机 Windows x64、Node v22.23.2、i5-14600KF 上，每个变体三个独立进程取中位数。JSON 场景为 16 个声明 8 MiB、实际发送 1 字节的请求；会话为 19,900 条、每条 1 KiB；清理为 1,000 条、每条 1 KiB 过期记忆。

| 场景与指标 | 基线 | 优化后 |
| --- | ---: | ---: |
| JSON 实际读体 / 拒绝请求数 | 16 / 0 | 8 / 8 |
| JSON 保持期间 ArrayBuffer 增量 | 128.00 MiB | 64.00 MiB |
| 会话导出采样 heap 峰值增量 | 50.87 MiB | 15.14 MiB |
| 会话导出最大事件循环间隔 | 125.07 ms | 33.34 ms |
| 会话导出总耗时 | 124.09 ms | 105.73 ms |
| 记忆清理最大事件循环间隔 | 90.39 ms | 17.81 ms |
| 记忆清理总耗时 | 90.17 ms | 113.58 ms |

导出线上字节数均为 22,086,865；清理均删除 1,000 条、保留 2,000 条完整修订并清空 FTS。分批清理增加调度开销，改善的是事件循环响应性。JSON 场景未触碰大部分预分配页，采样 RSS 增量为 0.691 → 0.555 MiB，不能把 Buffer 预分配减半解释为 RSS 同比下降。原始数据与计量限制见 [benchmark.json](../verification/optimization-completion-20261023/benchmark.json)。

MCP 场景为 128 个任务，每个结果 256 KiB、参数 64 KiB、宿主上下文 64 KiB。完成释放后的中位 heapUsed 从 55.41 降至 7.32 MiB，同时 arrayBuffers 从 0.02 增至 32.05 MiB；约 32 MiB 必要结果移至 Buffer，约 16 MiB 无用参数与上下文释放。采样 RSS 为 105.53 → 84.18 MiB；优化后关闭快照池回到基线附近，详见 [mcp-memory.json](../verification/optimization-completion-20261023/mcp-memory.json)。

最终编译产物的五个独立空闲核心进程另测 RSS 中位数 117.01 MiB、heapUsed 32.26 MiB，动态导入至 HTTP 就绪约 337 ms。该场景没有业务负载或可选宿主，见 [kernel-footprint.json](../verification/optimization-completion-20261023/kernel-footprint.json)；空闲测量的轻微波动不作为负载内存优化收益。

语料规模诊断使用 18 个独立进程，覆盖 1,000/5,000/20,000 条与 128/512 维。20,000 条精确扫描中位耗时分别为 103.74/203.53 ms，最大事件循环间隔中位数约 3.78/7.17 ms。它描述当前 O(N×D) 扫描成本，详见 [memory-scaling.json](../verification/optimization-completion-20261023/memory-scaling.json)。

```powershell
npm run check:quality
npm run build:host
npm test
npm run test:host -- --exclude-capability=interactive-desktop
npm run pack:sdk
npm run verify:sdk
node scripts/benchmark-optimization-completion.mjs --baseline=.agent-data-tests/optimization-complete-baseline-dist --current=dist
node scripts/benchmark-mcp-task-retention.mjs --baseline=.agent-data-tests/optimization-complete-baseline-dist --current=dist --samples=3
node scripts/benchmark-memory-scaling.mjs
node scripts/benchmark-kernel-footprint.mjs --output verification/optimization-completion-20261023/kernel-footprint.json
```

基线编译目录不进入发布包；其他机器需从 `6b1a109` 独立构建。基准使用新进程、本地合成数据及本地 HTTP 夹具，不调用付费或外部模型。计时、瞬时分配、保留堆、Buffer 与 RSS 分别记录；主机负载、JIT、GC 和文件缓存都会影响结果，局部数据不能外推生产吞吐、长期峰值或长期无泄漏。
