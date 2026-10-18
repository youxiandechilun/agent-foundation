# 0.7.0：工具采样、异步任务回调与 OAuth 动态注册

本文记录 0.7.0；0.8.0 任务接收、现代 task 扩展与 CIMD 的当前实现见 [CORE-TASKS-CIMD.md](CORE-TASKS-CIMD.md)。本版只继续开发通用 Agent 底层。默认运行方式仍为 native，Docker 可选；UI、应用级办公处理、浏览器与电脑控制插件、ESP32 不在本轮范围。实现位于本仓库 TypeScript 源码，没有新增 Agent、模型或 MCP SDK。当前状态以 `verification/report.json` 和逐项 `core-acceptance.json` 为准，不将未运行的外部联调计为完成。

## 带工具调用的 sampling

`src/extensions/mcp/sampling.ts` 负责 MCP 消息与内核消息的转换、工具声明校验、历史调用组校验、工具名映射和模型输出校验。`src/core/kernel.ts` 将它接到现有文本路由、权限、上下文预算与成本账本。三种文本协议都支持 `auto`、`required`、`none` 的工具选择。Anthropic 映射为 `auto`、`any`、`none`；配置了手动 extended thinking 时不能强制工具调用。具体厂商模型是否支持强制工具选择，仍须按其真实接口联调。

每个 MCP 服务器必须由宿主显式启用工具采样：

```json
{
  "clientFeatures": {
    "sampling": {
      "routeId": "text",
      "tools": true,
      "maxTools": 32,
      "maxTokens": 1024,
      "maxRequestsPerCall": 4
    }
  }
}
```

`tools` 默认 false。未启用时不声明 `sampling.tools`，收到工具声明或工具历史会在用户确认和模型请求前拒绝。启用后流程如下：

1. MCP 服务端提交 `sampling/createMessage`，包含自己的消息、工具 `inputSchema` 与工具选择。
2. 宿主检查原运行、模式、权限和数量上限，创建一次 sampling 确认。未来客户端通过既有 MCP interaction API 展示和提交确认。
3. 用户接受后重新检查权限。路由只使用宿主配置；服务端的模型偏好不能修改它。每个实际 fallback 路由重新筛选工具、检查权限与上下文窗口。
4. 模型返回 `tool_use`，内核检查工具名、JSON Schema 参数、调用 ID 和工具选择约束，返还给 MCP 服务端。
5. **MCP 服务端执行这些工具**，将 assistant 的 `tool_use` 与 user 的 `tool_result` 送进下一次 sampling。后续采样继续受确认、预算与同一原调用配额限制。

采样工具不会注册进宿主工具表，也不会调用宿主 exec、文件工具或源码插件。带 `/`、中文等名称映射为稳定的供应商安全名称，返回时恢复原名；路由 allowlist 仍使用原始工具名。当前采样路由还必须允许原 MCP 工具调用的权限检查，例如 `mcp_peer_work`；只允许服务器采样工具而禁止原 MCP 工具会拒绝采样。

只发送服务端明确提供的消息，不注入其他本机会话或记忆。支持文本、图片、工具调用和文本/图片/结构化工具结果。用户工具结果消息必须只含结果，并完整对应紧邻的上一组调用；孤立、重复、缺失或混合普通消息的结果会被拒绝。外部 JSON Schema 引用不会联网加载。模型产生的未知工具、无效参数或违背 `required` / `none` 的结果不会传给服务端执行。

工具声明计入上下文预算；采样费用按原 project/session/run 记录为 `mcp-sampling`，共享原运行预算。模型请求结束后再次检查权限，防止请求期间新增 deny 后继续向服务端返回工具调用。确认或模型失败不会伪造结果。

## 异步任务的反向输入

`src/extensions/mcp/tasks/context.ts` 保存连接内的任务来源；`mcp-client.ts` 在收到创建结果的同一个同步处理阶段绑定来源。因此，即使创建响应与反向请求位于同一段 stdio 输出中，也不会丢失权限上下文。上下文使用原 Agent 运行的 AbortSignal，独立于已经结束的创建 RPC。

旧版 `2025-11-25` 任务的反向请求必须带：

```json
{
  "_meta": {
    "io.modelcontextprotocol/related-task": { "taskId": "remote-task-id" }
  }
}
```

反向 sampling/elicitation 可从 stdio、HTTP GET 通知流或其他 POST 的 SSE 流返回；显式任务 ID 优先于承载它的 HTTP 请求。未知、过期、无效或其他连接上的任务不会获取本连接的原运行权限。并行任务各自保持来源，同一任务的 sampling 次数共享原调用配额。

宿主发现 `input_required` 后会提前调用阻塞的 `tasks/result`，同时处理反向请求。原调用的 progressToken 在任务生存期内继续有效。任务结果必须带与 `tasks/result` 参数匹配的关联元数据；任务查询以参数 taskId 为依据，不使用服务端元数据替换查询目标。

取消、TTL、宿主总超时、终态、断开连接或关闭内核都会结束本地回调权限和等待。单连接最多保留 128 个活动任务，最多记录 4096 个曾用任务 ID；超限或重用 ID 会拒绝，宿主可显式重连建立新的连接。无关联元数据的旧 stdio 回调在无法唯一识别原调用时仍拒绝。

本地记录保留 serverId、remoteId 与原运行；重启后未完成任务标为 unknown，可以显式查看、取结果或取消。重启不会恢复原运行的回调权限，不自动重提任务。原调用取消后向远端发出有时限的尽力取消；没有收到可靠结果的外部效果仍按 unknown 处理。

## OAuth 动态客户端注册

`src/extensions/mcp/auth/registration.ts` 实现 RFC 7591；`mcp-oauth.ts` 复用它完成发现、PKCE、换码和刷新。已有预注册 `clientId` 配置继续有效。动态注册是显式选项，和固定 clientId / clientSecretEnv 互斥。

```json
{
  "id": "my_server",
  "name": "My MCP server",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "oauth": {
    "redirectUri": "http://127.0.0.1:43111/callback",
    "allowedIssuers": ["https://auth.example.com"],
    "allowLoopbackHttp": true,
    "registration": {
      "mode": "dynamic",
      "clientName": "My Agent",
      "tokenEndpointAuthMethod": "none"
    }
  }
}
```

示例域名不是已配置的实际服务。默认认证方式为 public client 的 `none`；也可显式选 `client_secret_basic` 或 `client_secret_post`。如授权服务要求初始访问令牌或 software statement，填写 `initialAccessTokenEnv` / `softwareStatementEnv` 引用本机环境变量。初始令牌只发送给经过检查的注册 endpoint，不用于 MCP 请求或 metadata 发现。

注册只使用审核 issuer 的 metadata 中给出的 `registration_endpoint`。HTTPS、精确 issuer/resource、额外 endpoint origin allowlist 和显式回环 HTTP 规则继续生效；不会自动跟随注册跳转。注册内容限定到配置的 redirect URI、authorization_code / refresh_token、code response 和所选客户端认证方式。201 响应必须返回一致的注册参数及有效 clientId；保密客户端还必须提供有效 secret。改变回调 URI、认证方式或 grant 类型的响应会被拒绝。

同一配置的并发注册合并为一次 POST。客户端 ID、secret 和有效期使用 AES-256-GCM 加密存储在宿主 OAuth vault，AAD 区分 token、注册凭据和注册意图，按 resource/配置/issuer 绑定。状态 API 不返回 secret。退出授权只清除令牌和未完成授权状态，保留注册，避免下次登录重复创建客户端；会话迁移不会带走这些凭据。

注册 POST 发出前先写入持久意图。网络断开、5xx、不符合规范的 201 或本地提交失败都可能表示远端已注册，状态保持 `outcome_unknown`；重启后也不会自动重发。收到明确的 400/401/403 注册错误且包含合法 error 码时记 `rejected`，之后由调用方显式重试。已注册 secret 过期也需要显式处理，不通过自动创建新客户端掩盖问题。

| 接口                              | 行为                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /v1/mcp/:id/registration`    | 返回 registered / registering / unregistered / rejected / outcome_unknown 与公开客户端信息 |
| `POST /v1/mcp/:id/register`       | 只注册或读取已有注册，不打开浏览器、不开始用户授权                                         |
| `POST /v1/mcp/:id/auth-begin`     | 显式动态配置下先取得注册，再返回 PKCE 授权 URL                                             |
| `DELETE /v1/mcp/:id/registration` | 本地重置注册及授权；JSON `{ "acknowledgeUnknown": false }`                                 |

对 `outcome_unknown` 做本地重置，调用方需要先核查授权服务器，再明确传 `acknowledgeUnknown: true`。这是防止不确定 POST 重复执行的 API 条件，不会由内核自动批准。在注册进行中拒绝重置或替换配置；配置发现期间被替换则停止旧流程。关闭宿主会中止网络请求，迟到结果不会恢复授权或提交凭据。

重置响应包含 `remoteRegistrationDeleted: false`，本地删除不等于已经在授权服务注销；0.9.0 新增的 RFC 7592 远端删除使用另一个明确的 API，见 CORE-OAUTH-LIFECYCLE.md。

## 验收证据与剩余范围

本轮新增 39 项回归：`test/mcp-advanced.test.ts` 24 项、`test/mcp-registration.test.ts` 15 项。它们实际运行 stdio 子进程、HTTP/SSE 与授权服务，核验真实文件字节、消息、加密文件和预算记录；本地模型协议服务使用确定性回复，**不计为真实供应商模型联调**。在 0.6.0 的 153 项基础上，完整测试数量和结果由本版 verification 报告生成。

另外保留原有权限、持久进程/ConPTY、并行调度、成本账本、扩展隔离拒绝路径、资产迁移与崩溃恢复回归。源码 ZIP 的独立目录安装、构建、核心测试和工程文件 SHA-256 核对由 `scripts/verify-source-package.ps1` 执行。

0.8.0 已实现 client-as-task-receiver、现代独立 task 扩展和 Client ID Metadata Documents。仍未实现：sampling.context 隐式跨会话上下文、音频采样及特定企业 SSO 扩展。0.9.0 设备流、RFC 7592 和自动签名钥轮换见 CORE-OAUTH-LIFECYCLE.md。原生 OS 沙箱、多租户、跨主机实时同步和完整项目备份仍在既有未实现清单内。

外部验证单列：真实文本/图片/视频/embedding 供应商；第三方 MCP/OAuth 平台兼容性；真实 Docker 容器；Linux/macOS PTY；跨操作系统实机迁移。Docker 缺失会由独立验证记录为 environment-unavailable，不影响默认底座运行，也不会混入本地通过数量。

协议参考：[MCP Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)、[MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)、[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html)。现代 MCP 的 DCR 是兼容性选项；0.8.0 已加入 Client ID Metadata Documents，见 CORE-TASKS-CIMD.md。
