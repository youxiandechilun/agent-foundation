# 2026-10-23 全量审查后的优化

基线为 `9a39281`，保留 TypeScript/Node 单包、SQLite、三个 SDK 入口与现有 HTTP 协议。改动对应规范性、扩展性、执行效率和内存占用审查；验证结果以 `verification/optimization-followup-20261023/validation.json` 为准。

## 运行与资源所有权

工具运行取消后可以立即返回，但真实宿主 Promise 未结束时，继续持有原调度槽与资源读写锁；迟到成功或拒绝才释放。授权、hook 和结果处理的真实回调也纳入等待所有权。MCP 的普通逆向请求与任务回调共享最多 16 个真实 handler，取消 RPC 不提前归还实际回调的容量。

不响应取消、永不结束的工具会继续占槽；关闭内核停止等待，无法强制结束任意宿主 JavaScript。工具返回的 Promise 应代表实际操作及必要清理已经完成。相关回归在 `runtime-cancellation-capacity.test.ts`、`mcp-input-capacity.test.ts` 和真实 Kernel 生命周期测试中。

Linux 实测还发现进程 broker 已生成但控制端点尚未发布时的取消窗口：启动所有者现在有界等待端点后执行真实停止与终态确认，broker 忽略停止后的迟到 ready，避免调用方已收到取消而进程随后继续运行。回归验证真实子 PID 已结束，不靠测试延长等待代替清理。

## 存储、检查点与记忆

记忆内容查重使用 `(projectId, namespace, SHA-256(content))` 表达式索引，再比较原文防碰撞。旧库创建索引时建立派生数据，不向公开 MemoryEntry JSON 增加字段。每个 Store 连接注册确定性 `foundation_content_hash()`；外部原始 SQLite 连接修改记忆或执行需要计算索引表达式的完整检查时，应注册同一函数或使用 Store。普通只读 SELECT、quick_check 和 SQLite backup 不要求调用方注册此函数。

同步 `memory.import()` 保留返回值与原子性；新增 `memory.importAsync(projectId, entries, signal?)` 分批校验、脱敏和分词，再同步原子提交。HTTP 导入使用异步准备接口；准备期可取消且不会留下半批记忆、FTS 或 revision。默认最多一个准备任务、准备内容与分词文本合计 16 MiB；直接实例化 MemoryStore 时可用第四个参数 MemoryStoreOptions 调整。最终事务仍包含同步 SQLite 写入，不能视为全程可抢占。

检查点对当前文件分块计算摘要，避免为冲突判断保留整个大文件。capture/revert 追加可选 AbortSignal，默认最多 8 个读取、64 MiB 读取工作集预算，原快照仍有 16 MiB 上限，恢复 blob 时验证内容摘要。预算不等于 RSS 硬限制。

向量保持 Float64、旧三列表布局和精确评分顺序；旁表缓存模长，并在向量写入时失效。旧向量首扫按批建立缓存，缓存写回必须匹配当前 id/model/vector，避免并发更新污染后续评分；WAL 快照冲突时跳过可重建缓存。扫描仍为 O(N×D)，每 256 条让出事件循环，没有引入外部向量数据库或改变结果排序语义。

## HTTP 容量与取消

记忆导出继续返回 `foundation-memory-v1` JSON，但使用独立只读 WAL 快照，按 32 行分批读取原始 JSON 文本并遵守输出背压，不构建全部对象及完整响应字符串。发送前检查累计字节预算；断连或超时关闭快照并归还名额。慢客户端测试验证背压时槽位仍被占用、超时释放快照且 WAL 可以 checkpoint。

新增 limits 默认值：

| 配置 | 默认值 |
| --- | ---: |
| maxConcurrentMemoryExports | 2 |
| maxMemoryExportBytes | 128 MiB |
| memoryExportTimeoutMs | 60,000 ms |
| maxConcurrentMemorySearches | 4 |
| maxPendingNodeTasks | 64 |
| maxNodeTaskBytes | 8 MiB |

语义搜索和单条 embedding HTTP 请求共享搜索容量并传递断连信号。已有异步运行提交仍按其持久运行语义执行。JavaScript 定时器无法抢占 SQLite 同步预检或单页查询，因此导出超时不是同步 SQL 的硬截止。

已发送响应头后的流式失败销毁响应，不再调用正常 `end()`；这样不会在 pipeline 中止后把部分 JSON 响应标记为正常完成。慢客户端回归通过真实 HTTP 前缀及可控写入/排水门闩建立确定性背压，不依赖 Windows/Linux 的 TCP 缓冲区大小。

设备任务领取改用 nodeId/status/deadline 索引和定向查询；运行任务存在性检查不加载历史 body。等待结果使用通知，最多每秒兜底复核权限与持久状态。发送失败记录不确定性并释放准入；启动恢复把旧 queued 转为 cancelled、旧 running 转为 unknown，不自动重放真实副作用。

`retention.nodeTaskDays` 默认 0（永久保留）；启用后按批删除过期 completed/failed/cancelled，按 finishedAt 计时，兼容旧记录 createdAt。unknown 结果保留供核查。清理属于可选 NodeManager 的生命周期，避免增加未启用设备宿主的核心工作量。

## 扩展与工程规范

`install(kernel, signal?)` 保留旧单参数实现；安装时间使用 extensions.timeoutMs，关闭时取消初始化。失败会清理已有资源并释放 Store 租约；宿主扩展需要遵守 signal，并在 close 中清理资源。

普通对象通过 `TextProtocolRegistry.register(protocol)` 注册时建立不可变声明，保留自有额外字段和 helper，方法的 this 绑定到快照；既有类实例继续绑定原接收者，兼容私有字段和原型方法。legacy 类实例的可变状态仍由宿主管理。需要独立类实例或可变闭包时使用 `registerFactory(id, factory)`，每个 Kernel/registry clone 创建新实例。工厂不得返回同一对象；需要隔离的闭包应在工厂内部创建，运行时无法自动复制任意闭包。

新增可选 `KernelIntegration.serviceTools`、`ToolRegistry.registerServices()` 与 KernelServices 门面；工具可只依赖项目查询、资产、记忆和权限服务，方便测试注入。原 tools/context.kernel 保留。门面属于可信扩展接口，不是新权限沙箱，也没有替换 SQLite 存储。

生产 src 下的 MJS/CJS worker 纳入 ESLint 与 Prettier。GitHub CI 增加 Ubuntu × Node 22/24 的核心质量、构建、全量核心测试与 SDK 独立消费验证，Windows 继续验证原生宿主；不通过跳过测试掩盖真实跨平台问题。

## 复现与实测

```powershell
npm run check:quality
npm run build:host
npm test
npm run test:host -- --exclude-capability=interactive-desktop
npm run pack:sdk
npm run verify:sdk
node scripts/benchmark-device-queue.mjs --baseline .agent-data-tests/optimization-followup-baseline-dist
node scripts/benchmark-followup-storage.mjs --baseline=.agent-data-tests/optimization-followup-baseline-dist --current=dist --samples=3
node scripts/benchmark-kernel-footprint.mjs --output verification/optimization-followup-20261023/kernel-footprint.json
```

基线目录是修改前保留的编译输出，不进入发布包；其他机器需从基线提交重新构建到独立目录。基准使用本地合成输入、独立进程和 SQLite，不调用付费模型。交替前后执行并保留原始样本；耗时受磁盘、机器负载、JIT 和 GC 影响，局部倍率不代表完整 Agent 吞吐。空闲 RSS、瞬时分配、保留堆和采样峰值口径分别报告，不能据此证明长期没有泄漏。

Windows x64、Node v22.23.2 上的局部对照，每个变体三个独立进程取中位数：

| 场景 | 基线 | 优化后 |
| --- | ---: | ---: |
| 4,000 条唯一短记忆同步导入 | 4,186.33 ms | 655.89 ms |
| 10,000 条无关终态设备历史，一次无任务领取 | 104.35 ms | 0.40 ms |
| 同次设备领取的调用前后堆增量 | 43.95 MiB | 0.11 MiB |
| 128 MiB 当前文件仅判定检查点冲突，采样 RSS 增量 | 128.17 MiB | 1.36 MiB |
| 同次检查的采样 ArrayBuffer 增量 | 128.05 MiB | 0.45 MiB |
| 同次检查的耗时 | 111.88 ms | 126.97 ms |

分块复用读取以一定 I/O 调度开销换取较小内存分配；该大文件场景没有证明耗时下降。五个独立空闲核心进程另测 RSS 中位数 119.08 MiB、heapUsed 32.07 MiB，动态导入至 HTTP 就绪约 405 ms（不含进程创建）。本轮没有证明空闲 RSS 下降；负载内存、可选宿主与长期泄漏仍需按实际业务测量。
