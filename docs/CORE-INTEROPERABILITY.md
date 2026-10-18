# 0.6.0：MCP、可选扩展隔离、会话与资产迁移

本文记录 0.6.0 的互操作能力；0.7.0 继续补齐的工具采样、任务反向回调与动态注册见 [CORE-MCP-OAUTH.md](CORE-MCP-OAUTH.md)。具体通过数量由 `verification/report.json`、`core-acceptance.json` 和 `audit-report.json` 生成。源码和本地测试通过不等于第三方平台或容器环境已联调。

## Docker 保持可选

默认 `execution.boundary = native`、`extensions.executionBoundary = native`。安装、启动、普通会话、原生 Plugin、原生 MCP stdio 和 HTTP MCP 均不要求 Docker。不会自动安装 Docker、启动 daemon 或拉取镜像。

命令/持久进程边界由 `execution.boundary` 控制；源码插件边界由 `extensions.executionBoundary` 控制。MCP stdio 可以在声明中使用 `isolation.boundary` 覆盖扩展默认值。配置 Docker 时要求宿主已经安装可用的 Linux 容器引擎，且指定镜像已经存在；缺失就报错，不回退到 native。

```json
{
  "execution": {
    "boundary": "docker",
    "requireIsolation": true,
    "dockerImage": "node:22-bookworm-slim",
    "dockerNetwork": false,
    "readOnlyRoot": true,
    "dockerUser": "65534:65534",
    "memoryMb": 512,
    "cpus": 1,
    "pidsLimit": 128
  },
  "extensions": { "executionBoundary": "docker" }
}
```

`requireIsolation` 禁止原生命令、原生插件和原生 MCP stdio。为扩展明确配置 Docker 后才允许相应路径。HTTP MCP 是外部服务，部署隔离由该服务负责，内核不将它标记为本机已隔离。

`src/execution/extension-host.ts` 生成容器 argv：非 root、只读根、丢弃 capabilities、no-new-privileges、内存/CPU/PID 限额、受限临时目录、无 Docker socket 和 `--pull=never`。没有 shell 拼接。网络必须同时获得扩展声明和宿主 `dockerNetwork` 许可。

源码 Plugin 的已核验快照和宿主 worker 分开只读挂载。工作区只在工具声明 `files.read`/`files.write` 时挂载；写权限还受 `execution.workspaceReadOnly` 限制。传给插件的 `projectRoot` 改为 `/workspace`。未批准的宿主环境变量不会传进容器；显式 `envRefs` 经临时私有 env 文件传递，避免将密钥值放进 argv，结束时删除文件。Plugin 的 `containerNetwork:true` 会使所有工具同时要求 network 能力。

MCP stdio 的工作区必须位于宿主配置的 workspaceRoots 或 extensions.allowedRoots 内。容器内的命令和参数必须使用容器路径，不能直接使用 Windows 主机的 node.exe 路径：

```json
{
  "id": "project_files",
  "name": "项目 MCP",
  "transport": "stdio",
  "protocol": "auto",
  "command": "node",
  "args": ["/workspace/server.mjs"],
  "isolation": {
    "boundary": "docker",
    "workspaceRoot": "E:/approved/projects/example",
    "readOnly": true,
    "network": false
  }
}
```

原生插件和原生 stdio 仍是经授权的可信宿主代码。cwd、能力声明和 roots 不是原生 OS 沙箱。容器源目录需要容器 UID 可读，工作区写入也需要实际文件系统许可；不会替用户批量改变项目文件权限。

本机没有 Docker，容器内部执行、网络隔离、资源限额与退出清理尚未验收。`npm run test:docker` 使用真实 CLI/daemon，包含源码 Plugin、MCP stdio、命令、持久进程和 PTY，不以假的 docker 可执行文件代替。缺少环境时返回非零并写 `verification/docker-runtime.json`。

## 自维护 MCP 协议实现

新安装声明默认 `protocol:auto`，可明确指定 `modern` 或 `legacy`。低层可嵌入 `MCPClient` 保留 legacy 默认，以兼容直接调用它的旧宿主；新宿主可显式选 auto。旧持久化声明不被静默改成新协议。

| 协议路径                             | 真实实现的机制                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 2026-07-28                           | server/discover、逐请求 _meta、HTTP 路由头、MRTR、POST 订阅流与确认、作用域通知过滤、关闭流取消     |
| 2025-11-25 / 2025-06-18 / 2025-03-26 | initialize/initialized、能力协商、双向 JSON-RPC、HTTP 会话、GET SSE、Last-Event-ID 恢复、取消与进度 |
| 2024-11-05                           | 仅 stdio 的旧版协商；不启用已废弃的独立 HTTP+SSE transport                                          |

auto 先发只读 discovery，仅在明确的 Method not found 或列出旧版的 UnsupportedProtocolVersion 错误时退回 legacy。超时、断线、鉴权错误和未知错误不会被当作安全回退理由。旧服务器可以直接选 legacy。

现代协议的 `input_required` 只能用于 tools/call、resources/read、prompts/get。内核保持 requestState 原样，为每轮分配新 JSON-RPC ID，输入结果不串入并行请求；总超时、轮数和输入数均有上限。不会通过重发不确定的工具 POST 来恢复断线。现代 HTTP 不打开 GET/DELETE 会话通道，也不发送 Last-Event-ID。

现代 HTTP 实现 Mcp-Method、Mcp-Name 和 x-mcp-header 参数映射；Unicode、控制字符、前后空白和 Base64 标记冲突按规范编码。非法注解工具从目录剔除并记原因。JSON Schema 支持本地 Draft 7 与 2020-12，MCP 未声明方言时使用 2020-12；校验输入和结构化输出，不请求远端 $ref，不做类型强转。

### 客户端输入与权限

默认不启用 roots、elicitation 或 sampling。只有装入对应宿主处理器的能力才向 MCP 服务声明：

```json
{
  "clientFeatures": {
    "roots": [
      { "uri": "file:///E:/approved/projects/example", "name": "当前项目" }
    ],
    "elicitation": true,
    "sampling": {
      "routeId": "text",
      "maxTokens": 1024,
      "maxRequestsPerCall": 4
    }
  }
}
```

roots 逐次校验配置目录，容器 stdio 只返回挂载内的 `/workspace` URI。roots 是宿主显式同意披露的目录信息，不是给进程施加的文件访问 ACL。旧协议支持 roots/list_changed；现代协议每次输入取当前值。

elicitation 支持扁平表单和 URL 请求。表单响应经 schema 校验；URL 仅作为待确认资料返回，内核不自动打开、访问或替用户登录。确认入口是 `GET /v1/mcp-interactions` 与 `POST /v1/mcp-interactions/:id/resolve`，可直接由未来 Electron/网页客户端调用。响应结构为 `{action:"accept"|"decline"|"cancel",content?:{...}}`。结束、取消、超时或重启后的请求不能再次批准。

sampling 必须绑定真实运行中的 Agent 工具调用并获得单次明确确认。使用宿主配置的 routeId，服务端 modelPreferences 不能改变它；限制输出 token 和每次工具调用的采样数量。只发送服务器提交的消息，不隐式读取其他本机会话或记忆。采样经三种已有文本协议、上下文预算和成本账本执行，费用归入原 project/session/run。确认前后均重新检查宿主、主模型、实际降级模型、采样模型和模式限制；deny 不能靠确认覆盖。

旧 stdio 无法为并行服务器回调唯一确认父请求时，拒绝回调，不猜测归属。现代 MRTR 输入天然绑定当前请求。工具执行合约新增可选第五参数 `{routeId}`，由引擎传入实际执行模型，防止嵌套 MCP 调用丢失降级模型权限。

0.7.0 可显式启用 sampling.tools，支持服务器工具循环；仍不声明 context 扩展，不支持音频采样或自动回答用户表单。详见 CORE-MCP-OAUTH.md。

### 订阅、补全、异步任务和恢复

现代订阅使用 subscriptions/listen，验证首条确认、确认过滤器和 subscriptionId；未订阅通知不能撤销目录或混入消息。支持工具/资源/提示词列表变更、指定资源更新、显式取消。旧协议保留 resources/subscribe、unsubscribe 和连接级变更通知。

completion/complete 与 logging/setLevel 由实际服务能力控制。宿主可以补全 prompt/resource 参数并设置日志级别，结果和通知来自实际 MCP peer；缺少能力时明确拒绝。

旧版服务器声明的 required 工具 task 会实际创建远端任务，记录 serverId/remoteId/运行归属，轮询 tasks/get，最终取 tasks/result。支持显式查看、结果与取消 API。取消或断线的不确定结果记 unknown；重启不重提任务，保留远端 ID 等人工检查。0.7.0 已实现旧异步 task 的关联 sampling/elicitation 回调；0.8.0 已实现 client-as-task-receiver，详见 CORE-TASKS-CIMD.md。0.8.0 已加入现代独立 task 扩展。

### HTTP OAuth

自维护 OAuth 源码在 `src/extensions/mcp/auth/oauth.ts`，支持预注册 clientId（0.7.0 另增显式动态注册），可配置保密客户端 env 引用：

```json
{
  "oauth": {
    "clientId": "pre-registered-client",
    "redirectUri": "http://127.0.0.1:43111/callback",
    "allowedIssuers": ["https://auth.example.com"],
    "scopes": ["files:read"],
    "allowLoopbackHttp": true
  }
}
```

allowLoopbackHttp 只允许回环 HTTP，生产 MCP/issuer/token endpoint 仍须 HTTPS。issuer 与额外 endpoint origin 由宿主审核配置；不向未批准跨域发送 code、verifier、refresh token 或 client secret。protected resource metadata 与 authorization server metadata 按规范发现，检查 resource、issuer 和 S256。对 401/403 challenge 保留 scope 信息，新增授权合并已有 scope。

调用 `POST /v1/mcp/:id/auth-begin` 获得授权 URL；宿主负责让用户登录并把完整回调 URL 提交到 `POST /v1/mcp/:id/auth-complete`。核验一次性 state、精确回调、授权响应 iss、PKCE，授权与换码请求都绑定 resource。授权 URL 不会由内核自动打开。重启会取消未完成授权流程，重新 begin。

令牌用 AES-256-GCM 加密到宿主数据目录，主密钥仅在同一主机；授权按服务器配置与 resource 绑定。支持刷新锁、refresh token 轮换、invalid_grant 清除、撤销与刷新竞态处理。缺失 expires_in 时采用五分钟保守缓存。状态 API 不返回 token，迁移包不包含 vault。0.7.0 已实现 RFC 7591 动态客户端注册。0.8.0 已实现 Client ID Metadata Documents；0.9.0 已增加设备流、RFC 7592 远端注册管理与自动签名密钥轮换，见 CORE-OAUTH-LIFECYCLE.md；特定企业 SSO 仍未实现。本地换码测试不证明第三方平台已接通。

## 会话与资产跨主机迁移

`GET /v1/sessions/:id/migration` 导出 `foundation-migration-v1`；会话必须空闲且导出期间不能变化。包包含经过校验的会话历史、引用到的实际附件/产物字节、元数据、单文件 SHA-256、确定性整体摘要。导出会重新核验归属、文件类型、大小与字节哈希，不复制原电脑上的绝对文件地址作为附件。

`POST /v1/migrations/import` 接收 `{projectId,bundle,key,routeId?}`。目标项目事先在新主机创建。routeId 缺省使用目标主机该模式的默认路由；原主机 Agent 定义、权限、自治级别和密钥不自动导入，新会话为 assist。

导入重新分配 session、asset、message、run、tool-call ID，重写附件文字/URI/结构化数据引用与结构化 projectId，返回映射回执。旧工具调用只作为历史证据保存，不执行、不计入新主机效果日志。供应商 continuation ID、签名和原生延续状态不跨主机复用。

所有字节、引用依赖、消息工具组和摘要先校验；禁止路径穿越、重复资产、非规范 Base64、漏附件、无引用资产与跨项目复用。新文件使用私有 staging，数据库事务提交回执与历史；提交失败删除新文件，持久 intent 日志使重启只清理未提交的资产，不删除已提交资产。key 对目标项目、包和显式路由绑定，重试返回原回执，冲突返回 409。

默认 `limits.maxMigrationBytes = 128 MiB`，按会话编码与附件原始字节合计；单附件仍受 maxUploadBytes 约束，最多 2000 个引用资产。当前是有界的离线 JSON/Base64 包，导入在本机事务内提交，不提供无限流式迁移。SHA-256 用于完整性，不是来源身份签名；导入入口由宿主 Bearer token 授权。

这不是整个项目磁盘备份或多主机实时同步。项目工作目录/Git、未被会话引用的资产、独立记忆库、插件/Skill 安装、MCP 凭据、审批授权、进程/PTY、远端执行租约都不随包复制。记忆已有单独导入导出 API。两套独立数据目录通过本地 HTTP 完成迁移并继续会话已测试，跨 Windows/Linux/macOS 的实际机器传输仍待环境联调。

## 核验方式与规范来源

`npm run verify` 运行生产构建、源码边界、所有本地核心测试、生产依赖审计、编译后 smoke 和按测试标题生成的验收清单。`scripts/verify-source-package.ps1` 解压源码 ZIP，在全新目录只安装核心依赖，重新构建、测试并对比所有工程文件哈希。`npm run test:docker` 是单独的实际环境验收，缺失环境不计通过。

本次协议依据官方版本资料：

- [2026-07-28 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/multi-round-trip-requests) 与 [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- [现代 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) 与 [授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [旧版 sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)、[elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)、[tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

能力声明、配置或规范引用不替代验收。真实模型、真实第三方 MCP/OAuth、Docker、POSIX PTY 和跨 OS 迁移各自保留待联调状态；UI、办公/电脑控制插件、ESP32 按用户要求暂缓。
