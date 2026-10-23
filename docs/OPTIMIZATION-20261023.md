# 2026-10-23 规范、扩展与容量优化

本轮围绕具体热点与生命周期缺口调整实现，保留三个 SDK 入口、既有 HTTP 路由和 v1 迁移格式。主要减少异步任务无界积压、大字符串与附件副本、重复扫描及多 Kernel 共享状态，并补充真实关闭与取消回归。本文不新增发行版本；版本继续由根 `package.json` 管理。

## 改动与使用边界

### 媒体工作准入

`src/media/manager.ts` 统一媒体创建、排队、执行、恢复和取消的容量管理。准入在新 job 与费用预留写入前完成；已有幂等任务复用不会新增执行。等待中的新任务取消后释放容量，并作废尚未提交且未授权的费用预留。恢复原远端任务的取消仍可能为 `unknown`，不会把本地停止等待解释为远端已取消。

| `limits` 配置 | 默认值 | 口径 |
| --- | ---: | --- |
| `maxConcurrentMediaJobs` | 2 | 同时执行的媒体任务 |
| `maxQueuedMediaJobs` | 16 | 执行槽位之外的等待容量 |
| `maxMediaQueueBytes` | 4194304 | 运行中与等待任务的 job/route 序列化元数据字节总量 |
| `maxConcurrentMigrations` | 1 | 同时进行的迁移操作；HTTP 另以相同上限控制完整传输 |

这些默认值已列入 `config.example.json`。媒体容量不足返回 429 `resource_capacity`。字节预算不覆盖输入资产文件、输出内容或适配器自行保留的数据。不合作的适配器即使已超时，也必须等实际回调结束才释放执行槽位；内核关闭不无限等待该回调，但不能强制终止宿主自定义 I/O。

### 计费结果投递

`src/runtime/cost.ts` 将待投递 charge 状态保存在 SQLite `billing_deliveries`，按有限并发取出处理，避免启动恢复把整个账本变成同时运行的 Promise。同一 charge 保持顺序，其他 charge 可继续投递。最新投递 ID 用于防止较早结果覆盖较新状态，失败和未完成状态可在重启后恢复。

根 SDK 新增 `BillingDeliveryOptions`，通过 `KernelOptions.billingDelivery` 设置：

| 选项 | 默认值 | 含义 |
| --- | ---: | --- |
| `concurrency` | 8 | 同时执行的 `record` 回调 |
| `timeoutMs` | 30000 | 单次结果投递超时，毫秒 |
| `shutdownTimeoutMs` | 5000 | 关闭时等待投递收尾的时间，毫秒 |

`record(charge, outcome, signal?)` 的第三参数可选，既有两参数实现保持兼容。宿主应把信号传给自己的 I/O，并用 `charge.id` 幂等更新。回调忽略取消时继续占用原槽位；超时不是回调已结束的证明。关闭时限只限制投递等待，不是整个 `Kernel.close()` 的总时限，更不是外部操作的强制终止保证。调用前 `authorize`、金额预算和真实结算语义保持独立；取消授权后的迟到结果不会访问已关闭的数据库。

### 每实例协议与宿主所有权

`TextProtocolRegistry` 自带内置协议，允许各宿主注册自己的文本协议；`parseConfig(input, baseDir?, protocols?)` 与 `loadConfig(file, protocols?)` 用对应 registry 校验配置。`new Kernel(config, { textProtocols })` 在构造时复制注册表，后续注销原表不影响已构造实例。运行时路由更新、持久化路由加载、文本供应商、压缩、MCP sampling 和计费 token 语义都使用实例表。两个 Kernel 可以各自使用同名但不同实现的 adapter。

注册时冻结声明与静态 headers，类实例方法保留接收者；方法闭包和宿主类实例中的可变状态仍由宿主负责。旧的进程级 `registerTextProtocol` 等辅助函数保留，未注入 registry 的 Kernel 在构造时取得默认表快照。接入示例见 [SDK](SDK.md#每个-kernel-的文本协议)。

应用集成记录所属 Kernel，同实例重复安装幂等、跨实例安装拒绝、已关闭集成不可复用，同名应用服务冲突明确失败。`KernelIntegration.close(kernel?: Kernel)` 使初始化失败后的清理只能作用于所属实例，原有无参关闭实现兼容；server 集成也检查所有权。Office 提取器随服务关闭注销。

浏览器 context 关闭、连接断开和主动关闭走统一幂等清理，解除会话、profile、网络代理、页面监听器及引用。清理完成前保持 profile 占用，避免重开时争用。CDP 外部浏览器仅断开本集成连接，保留原宿主与用户标签页。管理工具和路由没有新增关闭语义。

### 正则与目录遍历

文件正则匹配移到独立 worker，默认单批 1 秒、整个正则搜索 30 秒，超时报告 `search_timeout` 并终止 worker；取消也终止 worker。worker 设置 V8 old/young generation 限额 32/8 MiB，这些不包含 worker 的全部原生、Buffer 和运行时开销。字面搜索保持直接匹配。

目录遍历改用逐项枚举，已访问条目与待处理条目共用 `maxSearchEntries`（默认 3000），不先读取整个巨大目录再截断。ignore 规则只在所属祖先链生效，返回上层时释放子目录规则。深度上限 128，每份 ignore 文件上限 256 KiB 与 4096 条规则，当前祖先链上限 16384 条规则；超限明确报告 `search_capacity`。条目容量耗尽通过截断结果报告，大目录的截断前缀取决于文件系统枚举顺序。现有单文件大小、返回条数、权限与符号链接限制继续生效。

### 消息回放与脱敏

Anthropic 已在通用消息 content 中完整保存的大文本、thinking、signature 或工具输入，原生回放状态可改存内容引用，发送时重建原始块。只有能正确复原且节省空间的块才使用引用，保留原生块顺序、未知字段、签名和不匹配内容；已有包含完整原生块的历史仍可回放。启发式 token 估算不再把这类内部副本当成额外模型输入，实际计费用量仍来自协议与供应商报告。

脱敏使用可复用的多模式匹配结构，凭据注册、过期与环境凭据变化会更新缓存；重叠凭据、转义形式和 Kernel 作用域继续覆盖。缓存避免每条大文本重复逐密钥扫描，不缓存权限判定。首次构建匹配结构的成本与已构建结构的重复匹配分别测量。

### 存储索引与预算合计

`memory_fts_map` 为 memory ID 建立到 FTS rowid 的索引映射。更新和删除直接定位目标行，减少按 FTS 未索引列扫描历史数据；升级旧库时补建映射，保留原有记忆与全文检索语义。分词、嵌入、磁盘写入和大批导入仍有自身成本，不能据单点索引改进宣称整个 import 为 O(N)。

全局已承诺费用由 `cost_ledger_total` 与 INSERT/UPDATE/DELETE 触发器随数据库写入维护，正常全局预算读取无需每次聚合全部费用行。直接 SQL、替换、事务回滚仍通过数据库规则保持一致；初始化与缺失触发器修复会重建合计，整数溢出后的 dirty 状态回退到聚合。带项目、会话、运行或日期筛选的汇总仍执行相应查询，不全部变成常量时间。

媒体幂等查询使用项目/幂等键索引，并增加新行重复检查。旧库已经存在的重复行保留，不自动删历史；任一同键行的请求哈希不同都会冲突，不能选择一条相同记录后忽略其他冲突记录。

### 文本资产与 v1 迁移

纯文本资产摘录按 64 KiB 读取块处理完整文件，只保留有限前缀；UTF-8 跨块字符与末尾代理对保持完整。前缀以外仍执行 NUL 检测与完整大小/SHA-256 校验。读取受下载数量/预留字节、关闭与取消约束。完整校验的 I/O 仍与文件长度有关，SDK `Assets.read()` 仍返回完整 Buffer，自定义解析器仍有独立工作集。

迁移与快照大小校验采用 JSON 片段计数；v1 规范化摘要增量计算，不构造第二份完整规范化字符串。长对象键与字符串均分片，保持旧键排序、转义和 Unicode 语义，并拒绝过深或循环对象。导出先检查附件元数据预算再逐资产读取，导入逐资产 Base64 解码、校验和落到 staging；全部成功后才进入已有的提升/事务提交路径，失败仍清理，重启恢复不会删掉已提交资产。

HTTP 导出以背压发送 JSON 片段，客户端仍读取普通 `foundation-migration-v1` JSON。HTTP 传输名额覆盖读取请求体到发送响应结束；迁移操作另有准入。导出连接断开时信号贯穿 Kernel、迁移收集及资产读取，两种名额都能释放，后续请求可继续执行。SDK 可传 `kernel.exportMigration(sessionId, signal)`。

旧快照/迁移格式、有效摘要、附件归属、脱敏、工具历史校验、失败回滚和不重放历史工具的语义保留。迁移仍持有完整快照与 Base64 字符串，HTTP 导入仍完整读取和解析 JSON，包含同步校验/事务阶段；没有实现可抢占的流式 JSON 导入。`maxMigrationBytes` 默认 128 MiB，约束快照与原始附件大小，并非序列化后 Base64、解析对象或整进程 RSS 的上限。

### CI 与回归范围

宿主 CI 使用能力排除：`npm run test:host -- --exclude-capability=interactive-desktop`。新增普通 `.integration.ts` 文件默认参与；整文件需要真实桌面时声明能力，混合套件只跳过真实桌面用例。浏览器、Office 和不需要交互桌面的集成不再依赖文件名允许列表。

新增回归覆盖不合作回调的槽位占用、幂等与旧库升级、真实 Playwright context 关闭及 CDP 断线、两个真实 Kernel 的集成所有权与协议隔离，以及真实 HTTP 断开时阻塞附件读取收到取消并释放配额。浏览器测试仍需已安装 Chromium；没有运行的真实桌面、远端供应商及生产负载不因本地测试通过而算作已验证。

## 验证与复现

在工程根使用满足 package.json 要求的 Node 环境。运行完整检查：

```powershell
npm run check:quality
npm run build
npm test
npx playwright install chromium
npm run build:host
npm run test:host -- --exclude-capability=interactive-desktop
```

只复现本轮目标回归：

```powershell
node scripts/run-core-tests.mjs --filter=optimization-
npm run test:host -- --filter=optimization-host --exclude-capability=interactive-desktop
```

构建后复现本地合成基准：

```powershell
node scripts/benchmark-optimization-runtime.mjs
node --expose-gc scripts/benchmark-optimization-storage.mjs
node scripts/benchmark-kernel-footprint.mjs
```

运行时基准直接向 stdout 输出 JSON。存储基准与空闲进程基准的采样、临时数据和输出位置以脚本为准；不调用收费模型。SDK 压缩包与独立消费者需另执行 `npm run pack:sdk` 和 `npm run verify:sdk`，源码验证不能证明既有 tarball 已更新。

本轮已完成 `check:quality`、core/host 构建与编译产物 smoke 检查；核心测试 **641/641 通过**，宿主测试 **35 通过、1 个真实桌面用例按能力跳过、0 失败**。核心及包含可选依赖的 npm audit 均报告 0 个漏洞，这是本次依赖审计结果，不是整个产品的安全证明。日志、环境与命令汇总保存在 [validation.json](../verification/optimization-20261023/validation.json)、[核心测试](../verification/optimization-20261023/core-tests.log)、[宿主测试](../verification/optimization-20261023/host-tests.log) 与 [质量检查](../verification/optimization-20261023/quality.log)。SDK 交付与独立消费者验收的最终结果以对应报告为准，不由上述测试数推定。

## 本轮测量

运行时合成基准于 2026-10-23 在 Windows x64、Node v22.23.2 运行，原始数据见 [runtime-benchmark.json](../verification/optimization-20261023/runtime-benchmark.json)。这些是单进程合成测量，不包含长期泄漏、真实供应商吞吐、RSS 或保留堆测量。

| 场景 | 实际观测 | 解释 |
| --- | --- | --- |
| 正则 `^(a+)+$` 匹配 101 字符，基准显式设 500 ms 单批超时 | 503.14 ms 返回 `search_timeout`，期间主线程 10 ms timer 触发 32 次 | 验证超时与主线程可响应；worker 初始化另为 25.77 ms，不是与旧探针的加速比 |
| 单个 64 KiB ASCII Anthropic 文本块 | 存储 JSON 131388 → 65940 字节，回放序列化内容完全相同 | 前值由旧的重复块形态构造；不代表所有消息都能减半 |
| 同一块的启发式 token 估算 | 65695 → 32798 | 是估算器口径变化，不是模型实际 token 或账单减少 |
| 128 KiB 无匹配文本，1000 个合成凭据 | 首次 10.30 ms，5 次样本中位数 0.51 ms | 5 次含首次编译与后续 4 次复用 |
| 同样文本，10000 个合成凭据 | 首次 38.24 ms，5 次样本中位数 0.58 ms | 不外推到全部匹配分布，时间随机器负载/JIT 波动 |

存储基准同日在 Windows x64 10.0.26200、Intel i5-14600KF、Node v22.23.2、SQLite 3.51.3 下运行，使用显式 GC 与本地临时数据，原始结果见 [storage-benchmark.json](../verification/optimization-20261023/storage-benchmark.json)。

| 场景 | 实际观测 | 解释 |
| --- | --- | --- |
| 20032 条媒体 job，复用最后插入的已有幂等任务 | 5 次中位耗时 0.1924 ms，调用前后 `heapUsed` 增量中位 19232 字节 | 一次预热后的本机同步查询，计划命中 `jobs_idempotency`；堆增量不是累计分配量、保留堆或采样峰值 |
| 默认媒体容量，mock adapter 保持待处理直到取消 | 接受 18 项，最多 2 项执行、16 项等待；第 19 项返回 429 | 仅验证本地准入，未测供应商吞吐；关闭后已提交 2 项为 unknown，未提交 16 项为 cancelled |
| 50000 行 FTS，删除不存在的 ID | 旧扫描 5.6106 ms/次 → rowid 映射 0.004145 ms/次 | 同一内存数据库交替运行，5 批、每批 20 次的中位数；隔离索引定位成本，未测完整记忆写入/导入 |

空闲进程复测使用 5 个串行独立进程，全新 SQLite、HTTP 就绪后空闲 500 ms 并显式 GC。中位 RSS 为 **116.34 MiB**，`heapUsed` 为 **31.85 MiB**，动态导入至 HTTP 就绪 **337.20 ms**，见 [kernel-footprint.json](../verification/optimization-20261023/kernel-footprint.json)。与本轮优化前的同场景测量基本持平，不宣称空闲 RSS 下降；这项测量不包含浏览器、Office、任务负载或长期泄漏。既有 [容量专项表](CAPACITY-OPTIMIZATION.md#验证与复现) 保留原测量口径，不替代本轮基准。

内存预算分别限制历史、排队元数据、在途资产与订阅 payload；对象、字符串、Buffer、SQLite、worker、浏览器、原生库及宿主自定义回调还有各自成本。降低特定副本与并发能改善峰值，但这些预算的和不能作为进程总内存硬上限。
