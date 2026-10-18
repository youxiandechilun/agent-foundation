# 通用底座执行与预算 · 0.5.0

0.11.0 增加可选 Windows AppContainer 后端与命令/插件生命周期排空；原生 ConPTY 仍可用，隔离 PTY 明确拒绝。本文保留 0.5.0 的执行/预算说明；新增配置、实测和 Node 子管道限制以 [CORE-FOUNDATION.md](CORE-FOUNDATION.md) 为准。当前版本范围见 [RELEASE.md](RELEASE.md)；目标是单用户可嵌入内核，多租户和业务登录不属于待办。

本轮范围是持久进程与 PTY、并行工具调度、成本预算、可选的执行隔离。UI、办公与电脑控制产品插件、ESP32 均暂缓。实现、测试通过和外部联调是三个不同状态，最终结果见 verification/report.json 与 CORE-ACCEPTANCE.json。

## Docker 的位置

Docker 是可选的命令隔离后端。底座、模型路由、记忆、会话、调度、预算以及本机持久进程都能直接运行，默认 execution.boundary=native。Electron 或网页客户端不需要携带 Docker。

权限审批决定一项操作能否执行；执行隔离限制获准的程序可以接触的文件、网络和系统资源。本机原生执行拥有当前用户的系统权限。Windows Job Object 的树终止/进程限制也不等于文件和网络沙箱。

Docker 后端只挂载指定项目，使用非 root 用户、只读根文件系统、删除 Linux capabilities、禁止新增权限，默认关闭网络，并限制内存、CPU、进程数；不自动下载镜像。启用 requireIsolation 后，配置和运行失败都不会退回本机执行。没有隔离后端的源码 Plugin 和 MCP stdio 明确拒绝，可使用独立隔离部署的 HTTP MCP。宿主自行注册的 TypeScript 集成依然属于受信任的内核代码。

本机没有 Docker engine，目前只通过参数/策略/拒绝执行验证。`npm run test:docker` 是连接真实引擎和实际容器的验收脚本；缺引擎写 environment-unavailable 并返回非零，不能计为容器运行通过。镜像必须由宿主事先准备。非 root UID/GID 需要对项目有相应读写权限。

## 持久进程与 PTY

Kernel.processes 管理实际进程，提供 start/read/write/resize/stop/list。exec_start、exec_read、exec_write、exec_resize、exec_stop、exec_list 是同一实现的模型工具入口。客户端通过 POST /v1/sessions/{id}/process-actions 调用，同样经过参数校验、模式/路由/项目策略、审批和统一调度，不需要先让模型转发命令。

每个进程有独立 broker。输出使用单调游标、有限环形缓存和持久快照，返回 truncated 表明旧片段已丢弃；累计输出、总寿命和全局进程数量也有限制。stdout/stderr 使用流式 UTF-8 解码。已配置凭据在跨写入分块合并后脱敏再落盘。broker 使用 loopback TCP、每进程秘密、请求与响应 HMAC、随机 nonce、时间窗口和重放拒绝；秘密不在网络请求中传输。

Windows PTY 使用本工程维护的 C# 源码，通过系统 CreatePseudoConsole/ResizePseudoConsole/Job Object API 实现，不使用 node-pty SDK。首次使用通过系统 .NET Framework csc 编译到 dataDir/native；源码会随工程构建复制。普通管道进程只需 Node。

POSIX PTY 使用本工程 Python 源码和标准库 pty/termios/ioctl，需要 Python 3，可通过 execution.posixPython 指定解释器。本轮宿主为 Windows，POSIX 分支尚未进行 Linux/macOS 实机验收。

processShutdown=terminate（默认）在 Kernel 正常关闭时终止受管理进程；preserve 允许下一 Kernel 重连原 broker，保持同一进程和输出游标。总寿命仍由 broker 执行。Kernel、broker 和操作系统重启并不相同：broker 或系统丢失后保留 unknown，不按陈旧 PID 杀进程、不自动重跑命令。已发生的外部效果不能通过“取消”撤销。进程终止 API 只在实际确认终止后返回终态；无法确认则报错。

示例配置（可选字段，未列出的值使用默认）：

```json
{
  "execution": {
    "boundary": "native",
    "requireIsolation": false,
    "maxProcesses": 8,
    "processLifetimeMs": 3600000,
    "processBufferBytes": 262144,
    "processTotalOutputBytes": 16777216,
    "processShutdown": "terminate"
  },
  "limits": { "maxConcurrentTools": 4 }
}
```

客户端的启动请求返回独立 runId，使用现有 SSE/审批接口接收执行结果：

```typescript
const action = await client.processAction(sessionId, "start", {
  command: "node",
  args: ["server.js"],
  pty: true,
  cols: 100,
  rows: 30,
});
for await (const event of client.events(action.runId)) {
  if (event.type === "approval.requested") presentApproval(event);
  if (event.type === "process.action.completed") consume(event.data.result);
}
// result.details 包含实际 process ID；后续 read/write/resize/stop 仍使用该 session。
```

## 并行调度

一个 Kernel 共用一个 ToolScheduler，限制所有模型运行与客户端进程操作的并发。工具默认取得全局排他锁；MCP 的 readOnlyHint、源码插件的自述不会自动授予并行执行。

受信任工具可声明 scheduling.parallelSafe 和资源读写锁。共享读可并行，同资源写与读互斥；等待写的队列不会被后来读请求无限绕过。文件读取与受管理进程读取有内置声明；未声明的写入、命令和扩展保守串行。锁约定约束经过调度器的工具调用，不给已经运行的后台程序提供文件事务。

```typescript
const scheduling = {
  parallelSafe: true,
  resources: (args: { id: string }) => [
    { key: `record:${args.id}`, access: "read" as const },
  ],
};
```

并行批次仍逐调用校验参数和权限。steer 到达后跳过尚未开始的工具；已开始的调用收尾后再处理新输入。跳过、失败和取消都保留匹配的工具结果；不会因为 Promise.all 提前拒绝而遗留在途调用继续写已关闭的 Store。

## 成本预算和账本

价格由宿主配置，不内置任何供应商的实时定价。下面数字仅演示配置格式：

```json
{
  "budgets": {
    "enabled": true,
    "maxRunUsd": 2,
    "maxSessionUsd": 10,
    "maxProjectUsd": 50,
    "maxDayUsd": 100,
    "maxTotalUsd": 1000
  },
  "pricing": {
    "currency": "USD",
    "inputPerMillion": 2,
    "outputPerMillion": 4,
    "cacheReadPerMillion": 0.5,
    "cacheWritePerMillion": 3,
    "requestUsd": 0
  }
}
```

budgets 是 config.json 的顶层字段；pricing 放在相应 routes.{id} 内。启用预算后，未定价路由在发出请求前失败。价格与端点、协议、模型、响应 ID 保存到独立账本，路由后续变更不会改写历史价格。

金额用整数微美元记录，日额度按 UTC。发请求前在 SQLite 事务中预留输入窗口上界和最大输出费用，包含其他在途/未知请求；不能用默认 Token 估算冒充硬金额上限。这个策略较保守，可能在实际短请求很便宜时仍要求较大的可用额度。实际限制依赖宿主价格配置及供应商遵守请求上限；外部超额账单不能由本地代码撤销。

收到完整用量后，按 OpenAI 输入包含缓存、Anthropic 缓存分项的语义结算；供应商报告超过预留上界时保存实际费用、报告超额并停止后续执行。回退、上下文压缩、自动记忆提取和运行内 embedding 继承同一 run/session/project 财务范围。已取消、断线或缺完整用量的调用保留 unknown 和预留款；明确未发送的请求可以 void。重启不会把在途费用清零。

图片/视频路由启用预算时需要 pricing.maxRequestUsd，表示宿主配置的整个任务费用上界，包括轮询。幂等重放不重复预留。适配器可返回 billing:{actualUsd,reference} 进行结算；未提供可信费用则保留待核对。没有自动声称所有厂商的账单接口已经接通。

GET /v1/costs 支持 projectId/sessionId/runId 筛选，返回实付、预留、未定价和明细。POST /v1/costs/{id}/reconcile 接收 actualUsd 与必填账单引用，保存调整前记录与核对历史。当前支持人工/宿主提交账单核对，没有自动抓取所有供应商账单、汇率换算和企业财务记账。

## 本轮边界

- Windows 原生管道、ConPTY、窗口缩放、进程树终止、Kernel 重连、审批、跨会话拒绝、HMAC 与分块脱敏均有真实本机运行测试。
- 调度和预算使用真实 SQLite、HTTP/SSE、本机进程及带确定用量的协议服务；生产代码没有测试服务器或固定回答适配器。
- 真实文本/图片/视频/embedding 供应商、Docker 容器运行、Linux/macOS PTY 分别列为外部待验收。
- 0.5.0 原先缺失的 Plugin/MCP stdio 容器宿主、MCP 扩展和会话引用资产迁移已由 0.6.0 继续开发，当前支持范围见 [CORE-INTEROPERABILITY.md](CORE-INTEROPERABILITY.md)。原生 OS 沙箱、多租户与分布式 Gateway 仍未实现。

实现时核对的系统资料：[Microsoft ConPTY 生命周期](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)、[Microsoft 对重定向标准句柄的说明](https://github.com/microsoft/terminal/discussions/15814)、[Docker run 参数](https://docs.docker.com/reference/cli/docker/container/run)。这些资料用于系统接口语义，不作为本工程运行验收的替代证据。
