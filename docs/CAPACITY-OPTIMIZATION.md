# 容量、历史与流式传输

本轮整理覆盖活动历史、资产传输、列表、事件订阅、输入队列、在线清理和 Kernel 脱敏作用域。公开入口保持根 SDK、`/client` 与 `/host`。列表 API 的默认返回量改为有界分页，迁移方式见 [API](API.md)。

## 活动历史

运行装配位于 `core/kernel/engine.ts`。消息按行读取，避免同时保留完整序列化行数组与解析对象数组。摘要完成后，`transcript_contexts` 保存按会话和路由划分的摘要消息与覆盖序号；下一次运行只恢复摘要和其后的消息。引擎在压缩后释放被省略的原始消息引用，消息数预算仍按完整持久历史计算，原始消息和工具效果不删除。

检查点覆盖完整的工具调用/结果组。摘要异步生成期间的历史变更由 generation 校验拦截；覆盖前缀被删除、移动、更新或插入旧序号消息时，SQLite 触发器使相应检查点失效。尾部修复只替换后缀；重启、分叉、导入或权限限制不绕过原有历史修复与授权流程。没有有效检查点的历史仍完整读取并受字节上限约束，首次摘要可能需要处理全部旧内容。

`maxHistoryBytes` 默认 128 MiB，限制需要加载或在引擎中保留的历史数据；不代表整个进程的 RSS 上限。消息数、模型上下文和附件预算继续分别执行。超限应分叉、导出或明确调整配置。

## 资产

HTTP 上传和浏览器下载通过 `Assets.createStream()` 分块写入临时文件，逐块计算 SHA256 与大小；完成后以独占文件名原子发布，再提交元数据。中断、超限或失败会清理临时文件。已知长度预留实际字节，未知长度预留 `maxUploadBytes`，避免大量未知长度传输绕过总预算。

HTTP 下载先生成有界的临时快照并验证完整摘要，验证成功后用背压流输出快照。源文件之后被修改也不会把未验证内容发给调用方。快照使用额外磁盘 I/O，换取稳定的内存和发送前校验；SDK `Assets.read()` 保留返回 Buffer 的契约。快照在传输完成、取消和 Kernel 关闭时释放，启动时清理上次进程留下的已识别临时文件。

## 默认容量

以下均在 `limits` 下配置，字节以实际字节数指定。

| 配置 | 默认值 | 归属 |
| --- | ---: | --- |
| `maxHistoryBytes` | 128 MiB | 单次活动历史 |
| `maxQueuedInputs` | 32 | 每会话待准备输入和每运行待应用输入 |
| `maxQueuedInputBytes` | 16 MiB | 对应队列的序列化输入总量 |
| `maxConcurrentUploads` | 4 | 每 Kernel 同时写入的资产 |
| `maxConcurrentDownloads` | 8 | 每 Kernel 同时读取/验证的资产 |
| `maxInFlightAssetBytes` | 100 MiB | 同时进行的上传与下载预留总量 |
| `maxSseSubscribers` | 128 | 每 Kernel 事件订阅 |
| `maxSseSubscribersPerRun` | 16 | 每运行事件订阅 |
| `maxSseBufferBytes` | 64 MiB | 线上待发送的事件 payload 总量 |
| `maxSseConnectionBytes` | 16 MiB | 每连接待发送 payload |
| `sseDrainTimeoutMs` | 30000 | 慢连接等待 drain 的时间 |

SSE 字节预算包含等待 drain 的当前写入，连接结束后释放；回放读取也按约 1 MiB 分批，单个完整事件可以超过这一批次目标。订阅限制、Node/网络缓冲、解析对象、原生库和可选宿主仍有各自开销，因此这些预算不能相加推导精确 RSS。

## 清理与脱敏

定时清理和初始化清理使用 `Kernel.pruneAsync()`，每批 500 行并在事务之间交还事件循环；同一 Kernel 的重复请求共享一个清理任务。`retentionStatus` 提供完成时间及最近错误，关闭时取消并等待清理结束。`Kernel.prune()` / `Store.prune()` 保留同步返回契约，适合离线维护。事件与摘要的保留天数继续由 `retention` 明确设置，0 表示永久保留。

每个 Kernel 拥有独立的 `RedactionScope`，包含配置、自动注册的凭据和环境转义缓存。服务入口及异步续体在所属作用域中执行，后创建的 Kernel 不覆盖先前实例的策略，关闭后释放自身凭据。自定义工具的凭据可用 `kernel.redaction.register(value, ttlMs?)` 注册到实例。源码宿主显式在 Kernel 外调用内部工具函数 `registerSecret()` 时继续表示全局宿主注册；独立工具函数的默认配置仍可通过 `configureRedaction()` 管理。

## 验证与复现

`npm run check:quality` 覆盖生产代码、测试和示例的严格类型、lint 和格式；`npm test` 覆盖运行时回归。`test/resource-limits.test.ts` 覆盖检查点失效与恢复、文件取消/快照/关闭、列表游标、在线清理让出执行、输入与 SSE 预算及多 Kernel 脱敏。

Windows 的配置根目录可以通过目录别名访问：原生命令和插件快照在可信宿主中使用一致的真实根路径，工作区内部的符号链接和 junction 仍被拒绝。沙箱在确认子进程停止后，对临时文件的共享/锁冲突最多重试 8 秒，其他清理错误继续使清理失败；真实文件锁回归确认 `cleanupConfirmed` 只能在临时运行目录消失后记录。ACL 回归比较所有者、权限条目及保护位，仅排除 Windows 写回时维护的自动继承状态位，参见 [Microsoft ControlFlags](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.controlflags)。

测试运行器显式采用 TAP 输出并设置 180,000 ms 测试超时，避免不同 Node 版本的默认报告格式影响证据解析，以及失败用例长时间占用 CI。Docker 缺失场景使用受控的命令搜索路径，不依赖维护者或 CI 机器是否安装 Docker。

空闲核心仍用 `node scripts/benchmark-kernel-footprint.mjs` 采样。容量负载使用 `npm run bench:capacity`，结果写入 `verification/capacity-benchmark.json`。测量使用本地合成数据，不调用付费模型，不把空闲 RSS、JavaScript 堆或 Buffer 指标混为一个口径，也不作为长期泄漏或可选宿主峰值的证明。

2026-10-23 在同一台 Windows x64、i5-14600KF、Node v22.23.2 主机复测。容量数据为三个独立进程的中位数，空闲数据为五个进程的中位数；修复前原始数据保存在容量报告的 `baseline` 中。

| 场景与指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 19,900 条历史恢复耗时，有有效摘要检查点 | 65.02 ms，全量读取 | 1.71 ms，摘要与 200 条尾部消息 |
| 同场景恢复后保留堆 | 23.72 MiB | 0.25 MiB |
| jobs 列表耗时，数据库有 19,900 条记录 | 44.07 ms，全量响应 | 0.62 ms，默认首屏 100 条 |
| jobs 列表分配堆 | 43.59 MiB | 0.25 MiB |
| 50 MiB 上传的 ArrayBuffer 增量 | 结束时 112.69 MiB | 采样峰值 32.04 MiB，结束时 18.24 MiB |
| 清理 50,000 条事件造成的最长事件循环停顿 | 644.17 ms | 23.25 ms |
| 空闲核心 RSS | 114.12 MiB | 115.28 MiB |

历史比较依赖有效检查点；摘要内容为固定合成数据，摘要生成本身的模型耗时和质量不在测量范围内。没有检查点时，本轮完整历史恢复实测 95.39 ms、分配堆 35.15 MiB、保留堆 24.74 MiB；位置追踪和逐行解析降低瞬时分配，但增加了首次读取的时间和部分常驻元数据。另一个真实执行引擎的合成测试从 19,900 条压到 202 条活动消息，数据库保留全部 19,902 条记录（包括新输入与回复）；三次采样都用 WeakRef 确认被省略的原始消息可在显式 GC 后回收，释放堆的中位数为 22.91 MiB。列表比较表示默认每次请求的工作量减少，调用方应继续按游标读取后续页。上传修复前只测请求体缓冲，修复后包含落盘和摘要计算，两个耗时不能直接比较；ArrayBuffer 数值也受 GC 时机影响。清理前测 timer 延迟，修复后测 setImmediate 最大间隔，均反映主线程暂停，但不是实时延迟保证。

完整校验结果和验证范围记录在 `verification/capacity-validation.json`，可复现数据见 `verification/capacity-benchmark.json` 与 `verification/kernel-footprint.json`。
