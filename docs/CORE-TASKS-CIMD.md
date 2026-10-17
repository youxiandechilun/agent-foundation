# 0.8.0：客户端异步任务、现代 task 扩展与 CIMD

本版继续开发 Agent 底层。三项能力均在本仓库维护源码，没有引入 MCP、Agent、OAuth 或 JWT SDK。默认 native，Docker 可选；UI、办公格式工具、浏览器/电脑控制插件、ESP32 按用户范围暂缓。验收依据为 `verification/report.json`、`core-acceptance.json` 与 `audit-report.json`，外部环境和未实现功能分列。

## 旧版客户端接收异步任务

适用 MCP `2025-11-25`。服务端可以将 `sampling/createMessage` 或 `elicitation/create` 加上 `task`，由客户端立即返回任务句柄、随后异步处理。它和服务端工具任务使用不同的任务表、连接所有者与生命周期。

```json
{
  "clientFeatures": {
    "elicitation": true,
    "sampling": {
      "routeId": "text",
      "maxTokens": 1024,
      "maxRequestsPerCall": 4
    },
    "tasks": {
      "sampling": true,
      "elicitation": true,
      "maxTasks": 32,
      "maxTtlMs": 300000,
      "pollIntervalMs": 100,
      "pageSize": 20
    }
  }
}
```

`clientFeatures.tasks` 默认为未启用。任务接收对应的 sampling/elicitation 也必须启用；直接使用 MCPClient 时必须提供对应 handler。能力只在旧版初始化中声明，不把旧版接收协议混入现代 task 扩展。

源码 `src/extensions/mcp-task-receiver.ts` 实现：

- 256 位随机任务 ID、逐连接所有权、立即 CreateTaskResult、持久状态、真实后台输入处理。
- `tasks/get`、阻塞式 `tasks/result`、`tasks/list` 与不透明分页 cursor、`tasks/cancel`，状态变更通知及结果关联元数据。
- working / input_required / completed / failed / cancelled；终态不能再次取消。用户确认时为 input_required，确认后回到 working。
- TTL、保留数量上限、输出大小上限、来源取消、断线和关闭处理。持久化创建失败时不执行 handler。

任务仍须绑定真实原调用，不会在原运行结束后继续采样、发起新的用户确认或计费。sampling 配额与成本继续共享原 project/session/run。`tasks/get/result/cancel` 以参数中的 taskId 为依据，忽略不能改变访问目标的关联元数据；其他连接不能用相同 ID 读取此连接任务。

SQLite 表 `mcp-client-tasks` 保存 serverId、connectionId、原运行、状态、时间、结果或错误。重启把未结束任务标为失败，不自动恢复模型请求或用户确认。旧连接任务仅可由可信宿主查看历史，不能凭 ID 在新连接继续执行或读取旧连接的协议结果。

管理入口为 `GET /v1/mcp/:id/client-tasks`；FoundationClient 提供 `mcpClientTasks(serverId)`。这与 `/tasks` 中本机发起的远端任务分开，避免方向和归属混淆。协议已在真实 stdio 及 HTTP/SSE 双向消息中测试。

## 现代独立 task 扩展

适用 MCP `2026-07-28`，扩展标识 `io.modelcontextprotocol/tasks`。显式配置：

```json
{ "clientFeatures": { "taskExtension": true, "elicitation": true } }
```

客户端在每次请求的 capabilities.extensions 中声明扩展；服务端也需要在 discover 中声明。工具调用可以直接返回普通结果，也可以由服务端选择返回 `resultType: "task"` 的平铺句柄。客户端不会把旧版 `task.ttl` 参数加入现代工具调用。

`src/extensions/mcp-modern-tasks.ts` 和 `mcp-client.ts` 实现了完整的本版 requester 流程：

1. 保存远端 taskId、原运行、服务配置绑定和初始状态，再轮询 `tasks/get`。轮询遵守服务端 pollIntervalMs、宿主总截止时间及从 createdAt 计算的 ttlMs。
2. 遇到 input_required，对每个 inputRequests 执行相同的确认、权限和采样预算流程，通过 `tasks/update` 提交 inputResponses。
3. 按任务内的输入 key 去重，检查同一 key 是否被换成不同请求；输入次数和总量有界。更新已确认但状态尚未同步时，继续轮询，不重复确认或再次调用模型。更新断线且结果未知时不自动重放。
4. completed 从内嵌 result 读取真实工具结果并校验；failed 保留 JSON-RPC error；工具 `isError: true` 仍是协议层 completed。cancelled 和错误结果不伪造工具成功。
5. 创建响应自称 completed 但尚未取回、验证结果时，本地保持待处理；缺失或错误工具结果记录 unknown 与 remoteStatus，不能算作已验收成功。

`tasks/cancel` 的成功响应只确认取消意图。远端可能仍处于 working，也可能已经完成；本地不把 ack 改写成远端 cancelled。来源取消、TTL 到期会结束本机确认/模型等待并尽力发出有时限的取消；不确定外部效果保存 unknown。关闭/重启保留 taskId，可在同一服务配置下显式查询或取结果；不会自动恢复原运行的输入权限。

现代 `tasks/get/update/cancel` 的 Streamable HTTP 请求设置 Mcp-Method 与按 MCP 规则编码的 Mcp-Name taskId。现代协议没有远端 `tasks/list`、`tasks/result`，公开 taskResult helper 会使用 tasks/get 读取终态；远端任务枚举不会被假实现出来。

支持 `subscriptions/listen` 的 taskIds 过滤器、首条确认、对应 `notifications/tasks` 完整状态校验和取消订阅。未确认、未订阅或来自其他任务的通知不会更新任务状态。终态的状态/结果不能被改回工作中或替换；JSON 属性次序不影响相同结果的判定。

宿主的 `/v1/mcp/:id/tasks` 和 `/task` 管理接口保留本地记录 ID；新增记录带 protocol 和服务配置绑定，修改 MCP URL、命令或 OAuth 归属后不能把旧任务 ID 发到另一服务。`taskExtension` 默认 false，旧版协议和未启用服务器保持原来的调用行为。

当前 task 的自动完成流程仍在原 Agent 工具调用中等待；长任务受该次调用的 timeoutMs 限制。后台任务脱离原运行、重启后自动重新取得用户输入权限、跨主机实时接续执行没有加入本版。

## Client ID Metadata Documents

CIMD 允许客户端使用自己控制的 HTTPS JSON URL 作为 client_id。授权服务器在授权时获取元数据，不需要先创建 DCR 客户端记录。配置示例：

```json
{
  "oauth": {
    "redirectUri": "http://127.0.0.1:43111/callback",
    "allowedIssuers": ["https://auth.example.com"],
    "allowLoopbackHttp": true,
    "clientMetadata": {
      "clientId": "https://agent.example.com/oauth/client.json",
      "clientName": "My Agent",
      "publish": true,
      "cacheMaxAge": 300,
      "authentication": { "method": "none" }
    }
  }
}
```

示例域名不是已经部署的服务。`src/extensions/mcp-client-metadata.ts` 生成 document；`server.ts` 在配置的 pathname 提供无需管理令牌的 GET/HEAD、Content-Type、nosniff、Cache-Control、ETag 和条件 GET。其它管理接口继续要求 Bearer token，预留 API 路径和不一致的文档路径冲突会被拒绝。Host 或转发头不能替换配置中的 client_id。

默认底座 HTTP 监听不变。公网使用时需要由宿主在自己控制的 HTTPS 域名通过反向代理发布该路径，或设置 publish:false 后把导出的 JSON 部署在指定 HTTPS URL。本版提供元数据生成和服务代码，没有自动购买域名、配置公网证书或部署远程站点。

client_id 必须为带非根路径的 HTTPS URL；本 profile 拒绝 query、fragment、用户信息、反斜线及原始/编码点路径段。文档的 client_id 和配置字符串一致，redirect_uris 必须唯一并包含实际 OAuth 回调，禁止 shared-secret 客户端认证或公开私钥。展示用途 URI 限 HTTPS。

授权发现检查 `client_id_metadata_document_supported: true`，然后把该 HTTPS URL 直接用于授权、换码和刷新。静态 clientId 与 CIMD/动态注册互斥。可同时显式提供 clientMetadata 与 registration：支持 CIMD 的 AS 优先使用 CIMD，不支持时才用明确配置的 DCR fallback；没有 fallback 时直接报错，不静默注册新客户端。DCR 继续保留加密注册和未知 POST 防重试，并补齐 OIDC application_type 的 native/web 选择。

### 非对称客户端认证

可选 private_key_jwt：

```json
{
  "authentication": {
    "method": "private_key_jwt",
    "privateKeyEnv": "AGENT_OAUTH_PRIVATE_KEY",
    "alg": "ES256",
    "kid": "agent-key-1"
  }
}
```

支持 RS256（RSA≥2048）、ES256（P-256）、EdDSA（Ed25519）。从宿主环境读取 PEM 私钥，元数据仅输出公共 JWKS。每次 token 请求生成新的 jti，以及 issuer/subject 为 client_id、audience 为审核 token endpoint、有效期60秒的签名断言。ECDSA 使用 JOSE P1363 格式。若 AS 声明了允许的签名算法，配置必须与之匹配。私钥、client secret、管理 API token 不会进入公开文档。

环境变量单钥方式仍需宿主安排变更。0.9.0 已增加托管多密钥重叠轮换与缓存窗口保护，见 CORE-OAUTH-LIFECYCLE.md；HSM/KMS 和外部 jwks_uri 管理仍未实现。

注册状态中 `publicationConfigured` 表示配置已开启本地发布，`externalHostingVerified:false` 明确表示没有据此证明公网域名可达。用户退出授权不删除公开应用元数据；如需停止发布，通过修改或删除 MCP 声明处理。

## 本地验收与外部边界

本轮新增43项：`mcp-task-interop.test.ts` 31项、`mcp-cimd.test.ts` 12项。覆盖实际文件字节、stdio 子进程、HTTP/SSE、任务持久状态、输入/费用归属、取消、TTL、跨连接拒绝、未知更新防重放、无效“完成”结果拒绝。

CIMD 的 none、RS256、ES256、EdDSA 分别通过实际 HTTPS 元数据获取、授权、PKCE 换码及刷新。测试用 NODE_EXTRA_CA_CERTS 信任专用本地测试 CA，没有关闭 TLS 证书校验。`test/support/tls-fixture.json` 中的测试私钥是公开测试夹具，仅用于本地集成测试，禁止用于生产。模型回复仍由本地可控协议服务产生，不计为真实模型联调。

本版完整回归以 verification 报告为准，源码包还需在全新目录执行仅核心依赖安装、构建、全部测试和哈希核对。Docker 缺失按 environment-unavailable 单列，默认安装、启动与测试不要求 Docker。

尚未实现：sampling 隐式跨会话 context 与音频；特定企业 SSO、HSM/KMS、外部 jwks_uri 等未声明 OAuth 扩展。0.9.0 已增加设备流、RFC 7592 远端注册管理和托管自动多密钥轮换，见 CORE-OAUTH-LIFECYCLE.md。其它未声明 MCP 扩展也不代表已实现。既有原生 OS 沙箱、多租户/分布式 Gateway、跨主机实时合并和完整项目备份继续在未实现清单中。

外部待验收：真实模型供应商、第三方 MCP/AS 生态、公网 CIMD 域名与反向代理部署、真实 Docker 容器、Linux/macOS PTY、跨操作系统实机迁移。UI、办公/浏览器/电脑控制产品插件、ESP32 暂缓。

规范参考：[旧版任务](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)、[现代 Tasks 扩展稳定版](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)、[现代扩展官方 schema](https://github.com/modelcontextprotocol/ext-tasks/tree/main/schema/2026-07-28)、[MCP Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)、[CIMD 草案](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)。实现对照规范重新编写，不运行参考项目的任务 SDK。
