# Agent Foundation API v1 · runtime 0.11.0

统一供网页、Electron、CLI 和其他可信接入端使用。默认内核只有 HTTP JSON / SSE；办公、浏览器、桌面和设备端点属于显式加载的可选宿主集成。本轮不做 UI 或 ESP32。

类型以 src/contracts.ts、src/runtime/types.ts、src/config.ts 为准；浏览器可直接使用独立 src/client.ts。

## 连接与权限边界

默认地址 http://127.0.0.1:4317。GET /health 及显式发布的 MCP Client Metadata/JWKS 可公开读取；管理端点要求 Authorization: Bearer <host-token>。host-token 来自 server.tokenEnv 引用或 dataDir/api-token；它和模型凭据分开。这是可信宿主令牌，不是业务账户登录。OAuth 仅为外部 MCP 授权，未声明 OAuth MCP 时不会初始化授权服务。

持有 host-token 的管理客户端属于可信操作者，可管理路由、策略、扩展、模式、记忆和历史。Agent 工具调用还需通过宿主/模式/项目规则/主路由/实际路由/扩展策略交集。记忆内容的管理 CRUD 是操作者编辑接口；它不是模型绕过 memory.write 的工具入口。服务当前不提供多租户身份隔离。

0.11.0 的 `/v1/capabilities` 增加 deployment（单用户/无账户登录/可选外部授权）与 executionSupport（配置后端、需要实际 probe、Windows 平台支持、隔离 PTY 不支持及启动恢复证据）。`POST /v1/execution/probe` 执行实际后端检查；能力字段不代替 probe。Windows AppContainer 配置、源码与兼容边界见 [CORE-FOUNDATION.md](CORE-FOUNDATION.md)。

跨源客户端加入 server.allowedOrigins。远程部署由 HTTPS 网关处理传输加密；不要把 host-token 放在 URL、模型提示词或不可信网站内。

错误为 {error:{code,message}}。常见状态：400 参数、401 鉴权、403 策略/归属、404 不存在、409 状态/幂等冲突、413 体积、429 并发预算、502/503 外部服务或配置问题。FoundationHttpError 保留 status/code/retryable，写请求不自动重试。

## 项目、模式和会话

| 方法       | 路径                                | 请求或结果                                                            |
| ---------- | ----------------------------------- | --------------------------------------------------------------------- |
| GET        | /health                             | {ok,version,protocol}                                                 |
| GET        | /v1/config                          | 脱敏配置、默认路由、权限、限制                                        |
| GET        | /v1/capabilities                    | 实际协议、模式、工具包、已加载集成、媒体适配器、扩展能力              |
| GET / POST | /v1/projects                        | 列表 / {name,directory?}                                              |
| GET / POST | /v1/modes                           | 列表 / 自定义模式定义                                                 |
| DELETE     | /v1/modes/{id}                      | 删除未被活跃会话引用的自定义模式；内置模式不可替换                    |
| GET / POST | /v1/sessions                        | 列表，可按 projectId 过滤 / {projectId,mode?,name?,routeId?,agentId?} |
| GET        | /v1/sessions/{id}?after=0&limit=100 | {session,messages,cursor,hasMore,runs}；limit 最大 1000               |
| PATCH      | /v1/sessions/{id}                   | 空闲时 {mode?,routeId?,name?,autonomy?,archived?,agentId?}            |
| POST       | /v1/sessions/{id}/fork              | {throughMessageId?}；复制独立会话，不重新执行历史工具                 |
| GET        | /v1/sessions/{id}/export            | {format:"foundation-session-v1",session,messages}                     |
| POST       | /v1/sessions/import                 | {projectId,snapshot,routeId?}；导入为新 assist 会话                   |

directory 必须存在并在 workspaceRoots 内。默认模式 chat/code/office；也接受已注册自定义 ID。office 是附件/文件工作策略，专用办公能力由插件提供。

自定义模式示例：

```json
{
  "id": "review",
  "description": "只读代码审核",
  "instructions": "读取证据并给出问题位置。",
  "toolAllowlist": ["file_read", "file_list", "file_search"],
  "capabilityPolicies": { "files.write": "deny", "exec": "deny" },
  "defaultRouteId": "code-text"
}
```

自定义模式在空闲时修改并持久化。autonomy 为 plan / assist / autonomous；新会话默认 assist。plan 允许可信只读工具和内部 plan_update 状态记录，MCP/原生 Plugin 即使自称 read 也禁止执行。autonomous 仍不能覆盖 deny/ask。

消息分页游标是 SQLite 消息序号；只用于 after，不是消息数组下标。导出是完整会话快照，导入当前限 8 MiB 与 maxSessionMessages，且只允许同项目，避免悄悄丢失附件归属。跨主机/跨项目资产搬迁需单独实现。导入拒绝 system 角色、重复消息、孤立/缺失/重复工具结果；移除不可移植的供应商延续状态/签名，历史工具绝不在导入时运行。运行/审批/效果日志不会被伪造成新会话的执行记录。

## 输入、运行与持续工作

| 方法 | 路径                                     | 请求或结果                                                                         |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| POST | /v1/sessions/{id}/inputs                 | {text?,assetIds?,skillIds?,delivery?,clientMessageId?}；202 {runId,inputId,events} |
| GET  | /v1/runs/{id}                            | 状态、错误、时间                                                                   |
| POST | /v1/runs/{id}/cancel                     | 请求取消；最终状态以结算为准                                                       |
| POST | /v1/runs/{id}/resume                     | 显式继续 failed/cancelled/interrupted 运行；创建新 run                             |
| GET  | /v1/runs/{id}/effects                    | {effects}：工具意图/参数哈希/结果/unknown                                          |
| GET  | /v1/runs/{id}/inbox                      | {inputs}：pending/applied                                                          |
| GET  | /v1/runs/{id}/plan                       | 持久计划                                                                           |
| GET  | /v1/runs/{id}/context                    | 输入预算、输出保留、计数器/精度、压缩状态；未准备则 not-prepared                   |
| GET  | /v1/runs/{id}/events?after=0             | SSE；也接受 Last-Event-ID                                                          |
| GET  | /v1/runs/{id}/events?format=json&after=0 | {events,cursor,status} 轮询                                                        |

delivery=start 要求空闲；steer 在工具之间的安全点插入，跳过尚未开始的旧批次工具并记录对应结果，enqueue 在模型不再调用工具时追加，两者沿用当前 run。一个会话同时只有一个活跃运行。clientMessageId 在会话内幂等，同键不同内容返回 409。

输入先持久化，应用到历史时与 inbox 标记一起事务提交。重启把未完成 run/effect 标为 interrupted/unknown。显式 resume 会接回原 run 的 pending 输入一次，并提醒核对不确定工具效果；不会自动重放旧写操作。默认重复 resume 幂等。

事件信封：

```json
{
  "schemaVersion": 1,
  "id": "ev_...",
  "runId": "run_...",
  "sessionId": "session_...",
  "type": "assistant.message.committed",
  "timestamp": "2026-10-16T00:00:00.000Z",
  "seq": 23,
  "data": {
    "messageId": "message_...",
    "message": {
      "role": "assistant",
      "content": [{ "type": "text", "text": "继续读取文件。" }]
    },
    "step": 1
  }
}
```

典型流程：

```text
input.accepted → run.status(running) → input.applied
→ model-step.started → assistant.message.started
→ assistant.message.delta* → assistant.message.committed
→ tool.dispatched → tool.requested
→ [approval.requested → approval.resolved]
→ tool.started → tool.output* → tool.settled → model-step.completed
→ 后续回复与工具步骤
→ run.status(terminal) → run.completed
```

一条完整回复提交并不结束任务。run.completed 的 status 才表示运行结算；completed 不是语义正确性的自动证明，仍应展示实际验证结果。

持久事件带 seq 和 SSE id，按游标重放；文本/推理/参数/命令输出增量 seq=null，不重放。重连后用相同 messageId 的完整消息替换临时内容。FoundationClient.events 自动重连 GET、按持久游标去重，401 等永久错误不重试。POST 不自动重试。断开 SSE 不取消运行。

服务按 write/drain 处理背压，实时积压超过 16 MiB 后断开以便游标恢复。慢客户端可能丢失未持久增量，但可重新获取提交后的完整消息和结果。heartbeat 不属于任务事件。

## 资产与媒体

| 方法 | 路径                              | 请求或结果                                               |
| ---- | --------------------------------- | -------------------------------------------------------- |
| POST | /v1/assets?projectId=...&name=... | 原始 bytes；201 Asset+download                           |
| GET  | /v1/assets?projectId=...          | {assets}                                                 |
| GET  | /v1/assets/{id}                   | 元数据和 SHA-256                                         |
| GET  | /v1/assets/{id}/content           | 原始字节                                                 |
| POST | /v1/jobs                          | {projectId,kind,prompt,routeId?,idempotencyKey,request?} |
| GET  | /v1/jobs 或 /v1/jobs/{id}         | 列表 / 持久 Job                                          |
| POST | /v1/jobs/{id}/cancel              | 请求本地与远端取消，能力不足时保留 unknown               |
| POST | /v1/jobs/{id}/recover             | 仅 unknown 且有 remoteId；查询原任务，不重提             |
| GET  | /v1/media-adapters                | 代码中注册的适配器能力                                   |

单资产默认 50 MiB，每条输入附件合计默认 50 MiB，最多 20 个；文本摘录共享 maxAttachmentText。原始字节保留为资产。默认解析文本，其他格式返回 supported=false，可用 ExtractorRegistry 注册解析器。上传任意文件不等于自动具备 OCR、音视频理解或 Office 格式引擎。

acceptsImages=true 的文本路由可接收 5 MiB 内 PNG/JPEG/WebP/GIF 图像块；其他附件保留元数据/资产引用。跨项目引用拒绝。文件工具拒绝绝对路径、逃逸、符号链接及 Windows ADS/设备路径。

MediaRequest 的 operation/inputAssets/parameters 见 MEDIA-ADAPTERS.md。同项目+幂等键复用原任务，同键不同输入冲突。新任务保存路由配置快照，修改路由后恢复/取消仍用旧地址与模型；凭据只保存变量引用。旧版未保存快照的 Job 只能使用现存路由，不构成跨版本恢复保证。

## 路由与审批

| 方法       | 路径                       | 请求或结果                                          |
| ---------- | -------------------------- | --------------------------------------------------- |
| GET        | /v1/routes                 | 公开路由元数据                                      |
| PUT        | /v1/routes/{id}            | 完整 Route 声明                                     |
| PATCH      | /v1/routes                 | {set?,remove?,defaultRoutes?}；一并校验和原子持久化 |
| DELETE     | /v1/routes/{id}            | 删除未被未归档会话引用的路由，默认引用也需先修改    |
| GET / POST | /v1/policies               | 列出 / 保存规则                                     |
| DELETE     | /v1/policies/{id}          | 删除规则                                            |
| GET        | /v1/approvals              | pending 审批                                        |
| POST       | /v1/approvals/{id}/resolve | {allow:boolean}，只可结算一次                       |

Route 的文本 adapter 为 openai-completions / openai-responses / anthropic-messages；可配置 baseUrl/model/apiKeyEnv/headersEnv/contextWindow/maxOutputTokens/acceptsImages/reasoning/tokenCounterId/requestDefaults/compat/fallbackRouteIds/toolAllowlist/mediaRouteAllowlist/capabilityPolicies。

运行时路由更新要求宿主空闲，结果写入 dataDir/runtime-routes.json，重启加载。PATCH defaultRoutes 可同时切换 chat/code/office/compact/image/video/embedding；可选槽位用 null 清空，必需槽位不可清空。校验失败保持内存和磁盘原状。requestDefaults 不得覆盖核心协议字段。

故障转移只在尚未输出且属于允许重试的临时错误时发生；主路由与实际路由权限取交集。审批绑定 run/调用 ID/工具/参数/项目/执行边界，有期限且不能通配批准未来调用。

原生 exec 和插件是宿主进程，不是 OS 沙箱。Docker runner 仅约束命令工具，并不自动约束源码插件或 MCP 进程。

## 记忆

| 方法   | 路径                                                   | 请求或结果                                                                    |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| GET    | /v1/memories?projectId=...&namespace=...&q=...&limit=8 | 列出或全文搜索                                                                |
| POST   | /v1/memories                                           | {id?,projectId,namespace?,content,tags?,source?,expiresAt?,expectedRevision?} |
| DELETE | /v1/memories/{id}                                      | 删除并留下修订记录                                                            |
| GET    | /v1/memories/{id}/history?projectId=...                | {revisions}                                                                   |
| GET    | /v1/memories/export?projectId=...&namespace=...        | foundation-memory-v1                                                          |
| POST   | /v1/memories/import                                    | {projectId,entries}；事务性                                                   |
| POST   | /v1/memories/merge                                     | {projectId,ids,content}；事务性                                               |
| POST   | /v1/memories/prune                                     | {projectId}；清理过期记录与索引                                               |
| POST   | /v1/memories/{id}/embed                                | 实际 embedding HTTP 调用                                                      |
| POST   | /v1/memories/semantic-search                           | {projectId,query,limit?,namespace?}                                           |
| GET    | /v1/memory-proposals?projectId=...                     | 自动提取的待审提案                                                            |
| POST   | /v1/memory-proposals/{id}/resolve                      | {allow:boolean}；批准才写入长期记忆                                           |

修订冲突返回 409；命名空间/有效期在排序截断前过滤。向量带路由模型/地址/参数版本指纹，路由改变后旧向量不混用；实际运行上下文检索可结合全文与向量。没有 embedding 路由时仍能使用全文检索。

## 扩展与 Agent 定义

| 方法           | 路径                                                                 | 请求或结果                                  |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| GET / POST     | /v1/skills                                                           | 列表 / {source,resources?} 或 {directory}   |
| GET            | /v1/skills/{id}、/export                                             | 内容与资源 / 可重装的 bundle                |
| GET            | /v1/skills/{id}/resource?path=...                                    | 文本或 base64 资源                          |
| PATCH / DELETE | /v1/skills/{id}                                                      | {enabled} / 删除                            |
| GET / POST     | /v1/plugins                                                          | 列表 / {manifest,files} 或 {directory}      |
| PATCH / DELETE | /v1/plugins/{id}                                                     | {enabled,trustedHash?} / 删除               |
| POST           | /v1/plugins/{id}/verify                                              | 重读实际已安装文件并校验                    |
| GET / POST     | /v1/mcp                                                              | 列表 / MCP 声明                             |
| POST           | /v1/mcp/{id}/connect、/disconnect                                    | 连接 / 断开                                 |
| GET            | /v1/mcp/{id}/tools、/resources、/prompts、/templates、/notifications | 真实服务目录 / 已接收通知                   |
| POST           | /v1/mcp/{id}/read-resource                                           | {uri}                                       |
| POST           | /v1/mcp/{id}/get-prompt                                              | {name,arguments?}                           |
| DELETE         | /v1/mcp/{id}                                                         | 断开并删除                                  |
| GET / POST     | /v1/agents                                                           | 列表 / AgentDefinition                      |
| GET / DELETE   | /v1/agents/{id}                                                      | 获取 / 删除                                 |
| POST           | /v1/agents/{id}/start                                                | {projectId,text?,assetIds?,skillIds?,name?} |

AgentDefinition 包含 id/name/instructions/mode/routeId/skillIds/toolAllowlist/maxSteps/memoryNamespace。定义复用同一循环与权限，不会另起一套隐式 Agent SDK。

扩展源码接口和支持的 MCP 能力见 [EXTENSIONS.md](EXTENSIONS.md)。后续办公、浏览器和电脑控制插件应复用这些边界。

## 0.4.0 增补

- GET /v1/memories/{id} 读取未过期记忆；Agent 可用 memory_read 按实际 ID 读取，仍需 memory.read。
- GET /v1/plugins/{id}/export 返回经过安装树校验的 {manifest,files,hash}，供复核与重装。
- 自动记忆注入仅在权限为 allow 时执行，ask 不会自动通过；备用模型单独过滤所需权限。原始用户历史已经包含的信息不构成通用数据防泄漏隔离。
- 自动检索的 embedding 失败可退回全文搜索并发送 memory.retrieval.degraded；显式 semantic-search 仍返回实际失败。
- 记忆摘要受独立预算约束，截断项含 truncated 和 memory_read 引用；原记录保留。
- context_length_exceeded 等已识别上下文错误，在尚未输出时可触发一次分层压缩重试。最新完整消息组仍放不下则明确失败；不会无限重试或执行截断参数。
- tool.skipped 表示新 steering 到达后尚未开始的工具；effect.status 可为 skipped。tool.loop_detected 表示达到配置的相同结果阈值，运行以 failed 结算。
- 会话消息额度在每一步与工具组提交前检查；maxRepeatedToolResults 与 maxSearchEntries 见配置源码。
- 工具文本及 details 共同受输出预算约束；过大结果保存为实际 JSON 资产，返回截断标记与 fullResultAssetId。
- 资产读取与下载会校验原始大小和 SHA-256；发生变化返回 409。媒体完成输出必须含真实字节、HTTP(S) 引用或同项目资产；参考 URL 不等于已下载和解码验证。

## 0.5.0 执行与成本接口

| 方法 | 路径                              | 行为                                                                                                         |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST | /v1/sessions/{id}/process-actions | {action:start/read/write/resize/stop/list, arguments:{…}}；返回 202 和独立 runId，复用审批/SSE/run.completed |
| GET  | /v1/costs                         | 可筛选 projectId/sessionId/runId，包含已结算、预留、未知、未定价和明细                                       |
| POST | /v1/costs/{id}/reconcile          | {actualUsd,reference}，保存核对历史；在途请求不可人工改账                                                    |
| POST | /v1/execution/probe               | 查询当前原生/可选 Docker 执行环境，不安装引擎、不下载镜像                                                    |

进程操作和模型工具共用参数、权限、审批、调度；等待批准不会提前启动程序。process.action.completed.data.result 是普通 ToolResult，details 为实际结果；大结果仍受资产归档规则约束。read 返回 frames/cursor/truncated/state，write 为 UTF-8 文本，resize 要求真实 PTY。

402 用于定价缺失、成本额度不足或超过预留上界。usage.reported 是可选的用量来源标记，旧会话导入仍兼容。价格配置位于 routes.{id}.pricing，金额预算位于 budgets。更多字段与边界见 [CORE-EXECUTION.md](CORE-EXECUTION.md)。

## 0.6.0 MCP 与跨主机迁移

| 方法   | 路径                              | 请求与真实行为                                                                                                                     |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /v1/sessions/{id}/migration       | 空闲会话、实际引用附件字节、SHA-256 与映射所需信息；foundation-migration-v1                                                        |
| POST   | /v1/migrations/import             | {projectId,bundle,key,routeId?}；原子导入到目标项目，返回 sessionId/assetMap/messageMap/runMap/toolCallMap；不执行历史工具         |
| GET    | /v1/migrations?projectId=…        | 本机迁移回执及幂等记录                                                                                                             |
| GET    | /v1/mcp-interactions?serverId=…   | 宿主待确认/已结束的 sampling 与 elicitation；模型不能自动批准                                                                      |
| POST   | /v1/mcp-interactions/{id}/resolve | {action:accept/decline/cancel,content?:{…}}；按 schema 校验，检查待处理状态                                                        |
| PUT    | /v1/mcp/{id}/roots                | {roots:[{uri,name?}]}；校验配置允许目录，旧版发送 roots/list_changed                                                               |
| POST   | /v1/mcp/{id}/subscribe            | {toolsListChanged?,promptsListChanged?,resourcesListChanged?,resourceSubscriptions?}；现代协议等首条确认再返回；旧版只支持资源 URI |
| POST   | /v1/mcp/{id}/unsubscribe          | {id,uri?}；现代取消指定订阅，旧版使用 id:legacy 并提供 URI                                                                         |
| GET    | /v1/mcp/{id}/tasks                | 本机发起的远端任务、remoteId、运行归属及状态                                                                                       |
| POST   | /v1/mcp/{id}/task                 | {id,action:get/result/cancel}；id 为本机任务记录 ID，不接受跨服务器替换                                                            |
| POST   | /v1/mcp/{id}/complete             | {ref,argument,context?}；按服务声明执行提示词/资源参数补全                                                                         |
| PUT    | /v1/mcp/{id}/logging              | {level:debug/info/notice/warning/error/critical/alert/emergency}                                                                   |
| GET    | /v1/mcp/{id}/auth                 | OAuth 授权/过期/scope 状态，不含 token                                                                                             |
| POST   | /v1/mcp/{id}/auth-begin           | 返回 authorizationUrl/expiresAt，宿主负责让用户登录                                                                                |
| POST   | /v1/mcp/{id}/auth-complete        | {callbackUrl}；检查 state、issuer、redirect、PKCE 后保存加密 token                                                                 |
| DELETE | /v1/mcp/{id}/auth                 | 断开本机连接并清除本机授权；不是远端厂商的账户删除或全局 token 撤销                                                                |

事件新增 `mcp.input_requested`、`mcp.input_resolved`。它们使用原运行的 SSE，可在回复与工具执行之间请求用户输入，确认后继续当前工具与运行。GET 待处理记录也适用于 UI 尚未接入的宿主程序。未来 Electron/网页客户端可使用 FoundationClient 的 exportMigration/importMigration/mcpInteractions/resolveMCPInteraction/beginMCPOAuth/completeMCPOAuth 方法。

MCP 声明新增 protocol、clientFeatures、isolation、oauth；默认执行仍为 native，Docker 仅在显式选用时启动。旧 `/sessions/{id}/export` 和 `/sessions/import` 保持同项目轻量快照语义，跨主机请使用新的 migration 接口。迁移默认合计 128 MiB；完整配置、真实测试和未完成 profile 见 [CORE-INTEROPERABILITY.md](CORE-INTEROPERABILITY.md)。

## 0.7.0 sampling.tools、任务回调与动态注册

| 方法   | 路径                      | 行为                                                                               |
| ------ | ------------------------- | ---------------------------------------------------------------------------------- |
| GET    | /v1/mcp/{id}/registration | 动态注册状态、公开 clientId / issuer / authMethod / secretExpiresAt；不返回凭据    |
| POST   | /v1/mcp/{id}/register     | 显式注册或复用加密注册，不打开授权页面、不创建用户授权流程                         |
| DELETE | /v1/mcp/{id}/registration | JSON `{acknowledgeUnknown?:boolean}`；断开、重置本地注册及 token；不注销远端客户端 |

`auth-begin` 在显式配置 `oauth.registration.mode:dynamic` 时先取得注册，然后返回既有 PKCE 授权 URL。固定 clientId 与动态注册互斥。支持 `none`、`client_secret_basic`、`client_secret_post`；环境变量引用 `initialAccessTokenEnv`、`softwareStatementEnv` 只在注册 POST 中使用。

不确定注册返回 `outcome_unknown`，后续 begin/register 以 409 拒绝自动重复 POST；核查远端状态后才传 `acknowledgeUnknown:true` 重置。注册进行中重置或替换配置返回 409。reset 的 `remoteRegistrationDeleted:false` 不是远端删除成功。FoundationClient 提供 `registerMCPOAuth`、`mcpRegistration`、`resetMCPRegistration`。

sampling 的 `clientFeatures.sampling.tools` 默认 false；显式 true 后声明 sampling.tools。新增 maxTools（默认32，上限64）；现有每次 token、每原调用次数、确认、权限与费用约束继续生效。服务端工具在服务端执行，工具结果再经 sampling 输入，宿主不会将它变为本地 exec。

异步任务的相关 sampling/elicitation 使用 `io.modelcontextprotocol/related-task` 元数据绑定原运行；通过原有 `/v1/mcp-interactions` 与 resolve API 确认，支持跨 HTTP 流返回。`tasks/result` 必须带匹配的结果元数据；错误或缺失不能视为成功。取消/TTL/断线后不能恢复已结束的确认。

源码、配置、安全限制、真实本地测试与外部待验收项见 [CORE-MCP-OAUTH.md](CORE-MCP-OAUTH.md)。

## 0.8.0 客户端任务、现代 task 和 CIMD

| 方法       | 路径                                    | 行为                                                                |
| ---------- | --------------------------------------- | ------------------------------------------------------------------- |
| GET        | /v1/mcp/{id}/client-tasks               | 客户端接收的异步 sampling/elicitation 任务历史；与远端工具任务分开  |
| POST       | /v1/mcp/{id}/subscribe                  | 增加 `taskIds:string[]`，要求任务属于该服务器配置，等待首条订阅确认 |
| GET / HEAD | 配置的 clientMetadata.clientId pathname | 无需管理令牌的公开元数据，支持 ETag / Cache-Control / 条件 GET      |

MCP 声明增加 `clientFeatures.tasks`（旧版客户端任务接收）与 `clientFeatures.taskExtension`（现代 requester）。均需显式启用。任务接收方向支持 get/result/list/cancel；现代扩展使用 get/update/cancel 与内嵌结果，没有远端任务枚举。FoundationClient 增加 mcpClientTasks；原有任务和 interaction API 继续用于原运行内的用户确认及采样。

`GET /v1/mcp/{id}/tasks` 的现代任务记录含 protocol:modern、remoteId、remoteStatus、服务配置绑定和原运行。取消 ack 只代表请求已接收，unknown 与真实远端 cancelled 分开。服务配置变更后查询旧绑定返回403；不会发送旧任务ID到另一服务。

OAuth 声明增加 clientMetadata，包含 clientId（HTTPS URL）、clientName、redirectUris?、publish、cacheMaxAge 和 authentication。支持 none 或 private_key_jwt（privateKeyEnv/alg/kid）；可与显式 registration 共同配置作为不支持 CIMD 时的 fallback，与固定 clientId 互斥。auth-begin 先验证 AS 能力，再返回既有 PKCE 授权 URL。registration 状态返回配置模式及 publicationConfigured，不代表已验证公网部署。

模块、完整配置、真实 HTTPS/stdio/HTTP 测试与未完成项见 [CORE-TASKS-CIMD.md](CORE-TASKS-CIMD.md)。

## 0.9.0 OAuth 生命周期

设备授权、远端注册管理、托管签名密钥的 HTTP 路由与 FoundationClient 方法见 [CORE-OAUTH-LIFECYCLE.md](CORE-OAUTH-LIFECYCLE.md#http-与源码接口)。全部管理接口仍需要宿主 Bearer token；公开 CIMD 仅含公钥。

## 0.10.0 可选应用接口

独立 browser/computer/office 应用包、HTTP/fetch 方法、模型工具、项目与会话归属、取消和紧急停止接口见 [APPLICATIONS.md](APPLICATIONS.md)。默认最小内核不安装这些路由。
