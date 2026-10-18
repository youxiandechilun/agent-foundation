# 执行效率与内部结构优化

## 2026-10-18 后续重构，基线 e096487

本次保留现有 TypeScript 单包、三个 SDK 入口、全部工具与协议能力，未升级依赖。源码计量包含所有生产 TS、JS、MJS、CJS、Python、C#、PowerShell 和 Shell 文件；测试、脚本、扩展资源和示例分别报告，不计入生产源码 20,000 行目标。完整计量见 `C:\Users\32761\Desktop\agent\agent-foundation\verification\refactor-20261018\source-metrics.json`。当前没有达到 20,000 行，局部重复机制的合并不能代表全仓净缩减。

本次变化包括：

- 授权会话列表按 SQLite 复合主键读取，保留原插入顺序、祖先授权和实时撤销；服务器事实查询先筛选服务器/项目，再读取最新 100 条。团队状态只刷新当前可见 40 项，任务详情、调度、编辑和取消仍各自刷新必要状态。
- 会话输入、OAuth 密钥和服务器配置共用按 key 串行的队列。不同服务器配置可以并行；同一个凭据文件的读写由跨 manager 的共享队列串行处理，Windows 文件路径按大小写不敏感规范化。该队列只协调同一进程，符号链接别名和跨进程文件锁不在此次验证范围内。
- 合并可选应用与 reference desktop 的服务组装、权限计算和资源关闭流程。关闭失败时继续释放后续资源，最终汇总错误；HTTP 断开时清理请求信号监听器。
- Responses 终态工具去重改为 Set 查询，保留稀疏输出索引；修复失败状态误报成功。Anthropic 按块维护 thinking 和签名，工具参数只解析一次；Responses reasoning/compaction 在 JSON、SSE 终态和异常部分结果中保留有序回放状态。
- 进程取消、超时和输出超限共用单次进程树终止操作；输出回调异常转换为命令失败；沙箱清理不因取消和异常路径交错而重复执行。Windows 子进程已实际测试，POSIX 路径仍需在对应系统验证。
- MCP 工具目录原子更新整份 metadata，取消、目录通知或连接变更不提交半份目录；移除工具时同步清理旧 schema 与 headers。在途调用保留自己的目录快照。工具、资源、提示词共用分页限额与游标校验，目录返回后仍不缓存结果。
- 记忆提案以最终持久化的脱敏内容查重，避免相同秘密输入产生重复提案。

实际全量测试、构建、严格类型检查和未验证范围见 `C:\Users\32761\Desktop\agent\agent-foundation\verification\refactor-20261018\report.json`。局部性能对照使用两个真实编译目录、独立 SQLite 库、相同合成数据、一次预热和五轮交替采样；计时前后校验结果，原始样本保存到 `C:\Users\32761\Desktop\agent\agent-foundation\verification\refactor-20261018\queries.json`。这些查询倍率不代表完整 Agent 或外部模型推理倍率。

```powershell
Set-Location 'C:\Users\32761\Desktop\agent\agent-foundation'
npm run verify
npm run verify:host
node scripts/benchmark-refactor-queries.mjs --baseline=.agent-data-refactor/streamline-before-dist --current=dist
```

比较基线是开始修改前从 e096487 构建并保留的编译目录；该本机目录不进入 SDK 包。重建基线时必须使用对应提交的源码和锁文件。后续修改后的数据以本次独立报告为准，不沿用下方前期验证的统计。

## 前期优化记录

本轮以开始工作时的 0.12.1 工作区为比较基线，保留此前尚未提交的重构。继续使用现有 TypeScript 单包、三个 SDK 公开入口、工具及 HTTP 协议和 JSON 持久记录；没有升级依赖、迁移技术栈或发布远端版本。

## 执行路径

| 模块 | 变化 | 边界 |
| --- | --- | --- |
| 工具 Schema | 按序列化内容复用已编译校验器；LRU 上限 64 条、键对应 UTF-8 内容总量 4 MiB；每个调用方拥有独立错误状态 | 新内容重新编译；不同 schema 的 `$id` 不共享解析环境；不修改调用方 schema；拒绝异步校验 |
| 工具调度 | 按资源名维护读写计数，扫描队列时累计前驱冲突；获取时复制资源声明 | 保留全局通配锁、并发上限、读共享、写互斥及冲突任务的等待顺序 |
| 上下文准备 | 默认估计器对消息组累计未取整字节权重，避免重复序列化整个保留后缀；最终计数只执行一次 | 图片权重和全局取整保持；自定义计数器仍按完整请求计数；只复用已存在的摘要 |
| SQLite | Store 内固定同步语句惰性复用；记忆内容、历史及提案使用定向查询和部分表达式索引 | 不缓存记录；跨连接读可见；旧 JSON body 保持；旧库首次打开需要构建三个索引 |
| SSE | 客户端和供应商共用浏览器兼容的增量解码器，逐段扫描并收集片段 | 单帧限额与供应商总字节限额保留；支持 LF/CR/CRLF、UTF-8 跨块、取消和 reader 释放 |
| HTTP 监听 | 自动分配端口时检查实际监听端口，遇到 Fetch 禁用端口则关闭监听并有界重选 | 保留显式指定的端口；不重试 HTTP 请求；客户端仍使用原生 Fetch |

缓存均有明确生命周期。Store 的缓存只包含本类使用的固定 SQL，关闭时清理；Schema 缓存按内容淘汰，不保存权限、模型回复或费用结果。Schema 字节上限约束键对应的输入内容，不代表 V8 生成代码、字符串和对象的堆内存总上限。

## 状态与正确性

`core/kernel/lifecycle.ts` 统一输入准备、会话队列、运行占用和取消。关闭先取消所有已知活动，再等待资源退出；清理校验当前所有者，防止旧任务移除新状态。`core/kernel/authorization.ts` 统一授权 hook 合并，风险和能力约束只能增加，原始工具执行函数、来源和 schema 保留。记忆权限只在单次模型请求内复用，新请求重新评估。

`runtime/engine.ts` 负责模型循环与消息提交；`runtime/tool-execution.ts` 负责参数验证、授权、hook 和效果状态。检查点事务成功后才更新内存历史。结构化完成判断只看本批工具结果，历史同名 callId 的成功不能覆盖当前失败。退出前等待已启动的 worker 归还调度资源，授权回调不响应信号时也能停止等待。

SSE 的 `maxFrameChars` 现在按每个事件帧计算；一个网络块包含多条合法帧时不会因总块大小而误拒绝。客户端校验完整 `FoundationEvent` 字段，畸形数据会报错。保留现有的 EOF 未终止事件兼容行为。已取消信号和消费过程中取消都会关闭输入流，同一网络块中的剩余事件不会继续输出。

真实外部副作用不会因为取消而自动撤销。结果未知的效果仍需显式核对，不自动重放。

## 工程检查

TypeScript 继续启用 strict，并增加 `noUnusedLocals`、`noUnusedParameters`。保留公开回调形参位置，未使用的兼容参数使用下划线前缀。没有引入新的运行依赖或格式压缩步骤。

测试辅助服务在初始化、首次 HTTP 请求和关闭失败时均会清理已取得的资源；SSH 测试的外层服务和环境变量也在初始化失败时回收。测试 POST 不进行自动重试。验证机器的动态 TCP 端口范围从 1025 开始，可能分配到 Fetch 禁用端口；已用实际监听 6697 复现 `fetch failed` / `bad port`。原始失败记录缺少 cause，不能把每次历史网络失败都归于该原因。失败诊断记录阶段、端口和错误原因，不记录 token。

验收脚本分别保存 stdout 和 stderr；启动时写入 `running`，完成后更新本轮结果。审计连接失败、输出异常或进程超时会明确标记不可用并保留空漏洞统计，不沿用旧的成功报告。同版本旧宿主报告仍可读取，已有的超时等错误证据不会被后来解析到的 JSON 覆盖。

## 验证与基准复现

常规入口：

```powershell
npm run verify
npm run verify:host
npm run pack:sdk
npm run verify:sdk
```

基准比较两个已编译目录，`--baseline` 指向修改前的 dist。当前实现默认使用工程的 dist；两份代码使用相同 Node、输入、预热次数及五轮中位数。基准仅使用内存流、本地 SQLite 和已缓存摘要，不访问外部模型。

```powershell
node scripts/benchmark-runtime.mjs --baseline=<修改前的dist目录> --output=verification/optimization-runtime-benchmark.json
node scripts/benchmark-scheduler.mjs --baseline=<修改前的dist目录>
```

首次比较所用的原始源码快照在 `.agent-data-tests/optimization-before-20261018`，属于本机验证材料，不进入 SDK 包。锁仲裁脚本交替执行两个实现以减小顺序偏差；综合脚本先执行基线，再执行当前实现。绝对时间会受到机器负载、JIT、GC 和磁盘缓存影响，微基准比例不能替代完整 Agent 的生产性能测量。

按需运行存储或服务生命周期压力场景：

```powershell
$env:FOUNDATION_STORAGE_BENCHMARK = '1'
npm test -- --filter=storage-refactor
Remove-Item Env:FOUNDATION_STORAGE_BENCHMARK
$env:FOUNDATION_FIXTURE_STRESS = '1'
npm test -- --filter=fixture-cleanup
Remove-Item Env:FOUNDATION_FIXTURE_STRESS
```

默认测试不会注册这些压力场景，因此不会用 skip 代替通过。实际结果、源码规模、兼容性检查和未验证范围以 `verification/optimization-report.json` 为准。入口文件变短主要来自职责提取；源码总量包含新增的缓存边界、校验和生命周期代码，不能把入口行数下降等同于全项目代码缩减。
