# 0.9.0：设备授权、远端注册管理与自动签名密钥轮换

本轮继续维护通用 Agent 底座源码，范围限 OAuth 生命周期。没有新增 Agent、模型、OAuth、JWT 或 MCP SDK。使用 Node 自带 HTTP、TLS、密码学和文件系统能力，沿用 Zod 校验。Docker 仍是可选执行后端，默认 native。UI、办公格式处理、浏览器／电脑控制产品插件和 ESP32 不在本轮开发范围。

## 设备流：RFC 8628

设备流由宿主显式设置 `oauth.deviceFlow: true` 后启用。不会在启动、授权失败或过期时自动创建新的设备授权。客户端获得用户码和验证地址，访问授权服务器的验证页面后，底座按协议轮询 token endpoint；底座本身不需要实现登录 UI 或接管浏览器。

支持预注册客户端、RFC 7591 动态客户端和 Client ID Metadata Documents。动态注册与 CIMD 的 `grantTypes` 必须显式包含 `urn:ietf:params:oauth:grant-type:device_code`。只使用设备流的客户端可以不配置回调；同时使用授权码时必须保留回调，并在注册元数据中包含相应 grant。

```json
{
  "id": "device-service",
  "name": "Device authorization service",
  "transport": "http",
  "url": "https://mcp.example/mcp",
  "oauth": {
    "clientId": "YOUR_PRE_REGISTERED_CLIENT_ID",
    "deviceFlow": true,
    "allowedIssuers": ["https://identity.example"],
    "scopes": ["read"]
  }
}
```

该地址和 ID 是配置示例，不能直接调用。发行者必须在白名单内；设备授权、token 和用户验证地址必须属于该发行者或宿主显式允许的 endpoint origin。默认只允许 HTTPS，`allowLoopbackHttp` 只放行明确配置的本机回环 HTTP，不会放行普通远端 HTTP。重定向不自动跟随。

处理规则：

- `interval` 缺省为 5 秒，必须是有效正整数。首次请求也等待该间隔；重复或并发调用不会绕过间隔。
- `authorization_pending` 继续等待；每次 `slow_down` 在已有间隔上增加 5 秒；连接故障将间隔翻倍。
- `access_denied`、`expired_token` 和其他 OAuth 错误结束当前流程，不自动启动新授权。
- 本地过期后不再发送 token 请求。一次进行中的网络请求有 10 秒超时；重启保留保守的下次轮询时间，避免并发重兑。
- 待授权状态、设备码、客户端上下文加密保存，按 MCP 服务与配置绑定。状态接口不返回设备码或凭据；持久化终态时删除记录中的设备码、客户端上下文和用户码。只读状态可以先显示本地过期，实际清理在后续轮询、重新授权、取消或删除时发生。
- 并发轮询共享一次请求。取消、退出登录、替换配置、删除服务或关闭宿主后，迟到结果不能恢复授权。
- 令牌携带内部授权批次标记。若令牌已经提交，而流程最终状态写入失败，重启通过该标记恢复“已授权”，不会再次兑换设备码。

统一客户端可以这样接入：

```typescript
const start = await client.beginMCPDeviceAuth(serverId);
// 接入端向用户展示 start.userCode、start.verificationUri，
// 可选择打开 start.verificationUriComplete；底座不会擅自操作浏览器。
const result = await client.waitMCPDeviceAuth(serverId, abortSignal);
```

也可以调用 `pollMCPDeviceAuth` 做一次轮询；过早调用只返回当前状态。`waitMCPDeviceAuth` 支持取消等待；取消等待不撤销服务器上已经建立的设备授权，彻底结束本地流程需 `cancelMCPDeviceAuth`。嵌入宿主可使用 `MCPOAuth.deviceWait`；远端设备授权、token 的最终撤销由授权服务器能力决定，本轮没有增加 RFC 7009 撤销接口。

## 远端注册管理：RFC 7592

RFC 7591 注册返回 `registration_client_uri` 和 `registration_access_token` 时，两者一起加密保存。管理令牌仅发送到授权服务器给出的、经过 origin 白名单检查的完整管理 URI，不自行拼接 URL，也不混用业务 access token、initial access token 或 client secret。

支持真实远端 GET、PUT 和 DELETE：

| 操作        | 行为                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Read        | GET 当前完整注册；原子接收服务器新发的注册管理令牌与 client secret；后续请求立即使用新凭据                  |
| Update      | 宿主提交 `changes`，底座与加密保存的完整元数据合并，再发送完整 PUT；保留未知扩展字段；`null` 表示删除该字段 |
| Delete      | DELETE 远端客户端，只有收到 204 才清除本地注册并返回 `remoteRegistrationDeleted: true`                      |
| Local reset | 只清除本地状态，始终返回 `remoteRegistrationDeleted: false`                                                 |

PUT 包含现有 `client_id`，移除 `registration_access_token`、`registration_client_uri`、`client_id_issued_at`、`client_secret_expires_at`，也不回传 client secret。宿主不能通过 changes 注入或覆盖凭据。为维持底座已审核的授权范围，本版注册管理不允许 changes 改变既有认证方法、grant/response 类型或回调集合；这类配置变化需要新客户端身份或显式重置流程。客户端名、展示 URL、contacts、scope 和其他非受保护扩展可修改。

管理操作会断开对应 MCP 连接并使旧授权流程失效；远端删除还会清除本地 access/refresh token。管理、注册、重置、配置替换与服务删除存在互斥保护。只接受注册时的同一 client ID；返回的新管理 URI 也必须通过原有 origin 白名单。

每次管理请求（包括可能轮换凭据的 GET）发出前保存加密意图。网络中断、5xx、非法成功响应、凭据不完整、身份改变等结果记为 `managementState: outcome_unknown`，不自动重发，不继续使用可能已经失效的 client secret。明确的 400/401/403/404/405 拒绝记为 rejected，允许宿主显式重试。

结果未知时，宿主先在授权服务器检查，再调用 `readMCPRegistration(serverId, true)` 显式进行一次恢复读取。若服务端已经轮换管理令牌而响应完全丢失，旧令牌可能无法恢复，必须由服务端运维恢复凭据，或检查远端后显式本地重置。本实现不能推断或伪造一个已经丢失的远端管理令牌。

RFC 7592 的凭据轮换时机由授权服务器决定。本地能自动接收和保存远端新凭据，不宣称能强制所有服务器轮换共享 secret。

## 自动多密钥轮换：private_key_jwt

为 CIMD 增加宿主管理的签名密钥环，同时保留原有 `privateKeyEnv + kid` 的单钥配置方式。配置两种方式之一，不能混用。自动密钥环要求内置元数据发布开启；可以由生产 HTTPS 反向代理转发底座的公开 JSON 路径。

```json
{
  "clientId": "https://agent.example/oauth/client.json",
  "clientName": "My Agent",
  "publish": true,
  "cacheMaxAge": 300,
  "authentication": {
    "method": "private_key_jwt",
    "alg": "ES256",
    "managed": {
      "rotationIntervalSeconds": 86400,
      "prepublishSeconds": 600,
      "retainSeconds": 3600
    }
  }
}
```

支持 RS256（RSA 2048）、ES256（P-256）与 EdDSA（Ed25519）。宿主自行生成私钥，AES-256-GCM 加密保存到宿主 vault；公开文档只包含公钥 JWK，状态接口不返回私钥。

密钥环分别保存当前签名钥、待启用钥和保留中的旧公钥。30 秒后台调度器推进轮换，签名、公开文档及状态请求也推进相同状态；重启从同一加密状态恢复。临近轮换时先生成下一把钥。只有公开 JWKS 的 GET 实际发生后，才开始预发布等待；HEAD、仅生成密钥或查看状态不会被算成已经发布。预发布至少覆盖 `cacheMaxAge + 60` 秒，轮换周期必须长于该等待窗口。

窗口结束后使用新 kid 签名，立刻从当前状态移除旧私钥，只保留旧公钥至少 120 秒，以覆盖已签发的 60 秒 JWT 及时间偏差。保留期结束后清理旧公钥。并发签名、发布和轮换按客户端身份串行化，最多一个待启用钥；对保留数量设置上限，避免频繁手动轮换无限增长。旧钥尚在保留期时，不能无限提前轮换。

手动 `rotateMCPOAuthKeys` 只提前安排一把下一代密钥，也必须经过真实发布和等待；不会立即切断旧钥。`mcpOAuthKeys` 返回 active/pending kid、等待发布状态、启用时间和保留期限。

同一 client metadata ID 的多个发布者必须保持配置一致，禁止用冲突配置覆盖同一路径。切换托管/环境变量密钥来源或签名算法需要新的 metadata client ID，防止旧缓存对应的身份被突然替换。删除或替换配置后，后台不再推进被移除配置的轮换。

每个请求生成带独立 jti 的短 JWT，iss/sub 绑定 client ID，aud 绑定接收端点；设备授权与 token 请求分别使用各自端点 audience。不把私钥、access/refresh token、管理令牌或已生成的 JWT 注入模型上下文。短断言的脱敏缓存有 120 秒保留期并自动清理，避免每次请求的不同 JWT 在长期宿主中无限积累；原有长期凭据的脱敏规则保持有效。

自动轮换限上述 OAuth 客户端签名密钥。宿主 vault 的主加密密钥仍是单主机密钥，不自动轮换；HSM/KMS、外部 jwks_uri 托管、多主机共用密钥环及特定企业 SSO 尚未实现。

## HTTP 与源码接口

以下管理路由均要求宿主 Bearer token；公开元数据 JSON 路径不要求宿主 token。

| 方法与路径                               | 用途                                                                | FoundationClient                      |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| POST `/v1/mcp/:id/auth-device`           | 发起设备授权                                                        | beginMCPDeviceAuth                    |
| GET `/v1/mcp/:id/auth-device`            | 查看设备授权状态                                                    | mcpDeviceAuth                         |
| POST `/v1/mcp/:id/auth-device-poll`      | 按限速轮询一次                                                      | pollMCPDeviceAuth / waitMCPDeviceAuth |
| DELETE `/v1/mcp/:id/auth-device`         | 取消本地设备流程                                                    | cancelMCPDeviceAuth                   |
| POST `/v1/mcp/:id/registration-read`     | 远端 GET；body `{ "acknowledgeUnknown": false }`                    | readMCPRegistration                   |
| PUT `/v1/mcp/:id/registration-remote`    | 完整元数据 PUT；body `{ "changes": { "client_name": "New name" } }` | updateMCPRegistration                 |
| DELETE `/v1/mcp/:id/registration-remote` | 远端 DELETE                                                         | deleteMCPRegistration                 |
| GET `/v1/mcp/:id/auth-keys`              | 托管签名钥状态                                                      | mcpOAuthKeys                          |
| POST `/v1/mcp/:id/auth-keys-rotate`      | 安排下一把钥                                                        | rotateMCPOAuthKeys                    |

原 `/registration` 查询与本地 DELETE 重置接口、`auth-begin`/`auth-complete` PKCE 接口保持原有用途。Read 使用宿主 POST 路由，因为授权服务器 GET 可以轮换凭据；底座对远端实际执行 GET。

主要源码：`src/extensions/mcp/auth/device.ts`、`mcp-keyring.ts`、`oauth-vault.ts`、`mcp-registration.ts`、`mcp-client-metadata.ts`、`mcp-oauth.ts`，以及 MCP manager、管理 API、便携 fetch 客户端的接入。可导入的配置示例位于维护者源码工程的 `examples/mcp-oauth-lifecycle.json`，不随 SDK 包提供。

## 测试和未验收边界

新增测试位于 `test/mcp-device.test.ts`、`mcp-registration-management.test.ts` 和 `mcp-keyring.test.ts`。使用实际 HTTP/HTTPS socket、文件系统、AES/JWK/JWT 签名和本工程的 fetch 客户端，不包含生产演示回复。

设备流覆盖回调缺省、默认间隔、真实 slow_down 等待、连接故障退避、拒绝/过期、并发取消、重启恢复、最终状态写入失败、DCR 三种认证，以及 CIMD none / 托管 private_key_jwt 的受信 HTTPS 授权和刷新。RFC 7592 覆盖完整 PUT、扩展字段保留、凭据轮换、删除、未知结果、重启和配置互斥。

轮换测试既有注入时钟验证完整长期状态周期，也有实际等待 60 秒的 HTTPS 测试，授权服务器真实校验切换前后的 JWT 并完成 PKCE 和 refresh。测试 CA、证书和私钥仅是公开测试夹具，不能当成生产 TLS 凭据。具体通过数与逐项证据以维护者工作区中的 `verification/core-acceptance.json` 和 `verification/report.json` 为准；验证报告不放入 SDK 安装包。

单独列出未验收事项：真实模型供应商与费用/质量、第三方 OAuth/企业身份平台、真实公网 HTTPS 元数据部署、Docker 实际容器、Linux/macOS PTY 和实际不同操作系统机器迁移。它们不因本地协议测试通过而标记为完成。

仍未实现的底座扩展包括：特定企业 SSO、HSM/KMS/主加密密钥轮换、外部 jwks_uri 管理、RFC 7009 远端 token 撤销、RFC 7662 introspection、OIDC 身份登录层；MCP 隐式跨会话 sampling context/音频；多租户/分布式 Gateway、跨主机实时合并及完整项目备份。Windows AppContainer 等已有执行隔离的当前范围见 [CORE-EXECUTION.md](CORE-EXECUTION.md)。未声明的 OAuth/MCP profile 均不表示已实现。

规范依据：[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html)、[RFC 7592](https://www.rfc-editor.org/rfc/rfc7592.html)、[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html)、[RFC 7523](https://www.rfc-editor.org/rfc/rfc7523.html)。前版 CIMD 与 MCP task profile 见 [CORE-TASKS-CIMD.md](CORE-TASKS-CIMD.md)。
