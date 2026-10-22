# 源码对比与选择依据

核查日期：2026-10-23。本次读取官方源码与本工程实现，比较接入步骤、状态模型和现成接口；没有安装、构建或运行三个对照项目，没有进行同机速度、内存、模型质量或任务成功率测试。

**Agent Foundation 目前可证明的选择价值，集中在自建应用的业务接入：客户账户费用授权、预算与费用状态、宿主权限约束、持久审批，以及统一的业务实体和 HTTP/SSE 接口。** SDK、多模型、工具循环、SQLite、MCP 和可修改源码都是多个项目的共同能力，不能单独证明本工程更优。

## 固定比较范围

| 工程             | 本次读取的官方提交                                                                                             | 许可与范围                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Agent Foundation | [`6bad02c`](https://github.com/youxiandechilun/agent-foundation/tree/6bad02cf2cc946b7e565ee177bbfb597bbf3aedf) | 核心、API、宿主接口、测试；当前 `private: true`、`UNLICENSED`      |
| pi               | [`74f4686`](https://github.com/earendil-works/pi/tree/74f46864025c68504cd10c89eeb626b7e3d64cea)                | Agent、Coding Agent、模型层、durable、MCP 与扩展示例；MIT          |
| Z.ai ZCode       | [`3c5b227`](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab)                    | bootstrap、core、adapters、客户端与服务接口；Apache-2.0            |
| DeepSeek Harness | [`687f282`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)     | TS/Python SDK、AgentLoop、base profile、会话、账户与 LLM 服务；MIT |

下文结论限定于这些源码和调用路径。其他项目可以通过扩展或后续改动实现相同能力；“本工程已经接好”与“对方无法实现”是不同结论。

## 1. 自有客户计费：现成的前置授权与费用状态

本工程的实际调用链为：

```text
Project.billingAccount
    → 创建带账户归属的费用预留，检查运行/会话/项目/日期/总额预算
    → BillingProvider.authorize：宿主检查或预留自己的客户额度
    → 发出模型、Embedding 或媒体请求
    → 持久化费用与用量，record(charge, outcome) 通知宿主
    → 失败通知可重投；未知费用保留预留并按相应接口对账
```

`BillingCharge.id` 是稳定的幂等键；账户在预留时固定下来，之后修改项目账户不会改变既有费用归属。宿主可以把自己的积分、余额或套餐规则放入 `authorize`，并按 `charge.id` 更新收费记录。原生搜索即使有 token usage，也保留待对账状态；其实际金额对账后会以同一计费 ID 再通知宿主，同一 ID 的通知按顺序投递。

本工程证据：[账户与回调契约](../src/runtime/billing.ts)、[账户绑定](../src/core/kernel.ts)、[预算、预留、通知与对账](../src/runtime/cost.ts)、[宿主计费测试](../test/billing-extensions.test.ts)、[原生搜索失败、重启与对账测试](../test/native-web-search-billing.test.ts)。

| 对照工程已有实现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 本工程在此场景能省下的工作                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| pi 已有 [用量与费用汇总](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/src/core/usage-totals.ts#L23)，durable 也有 [请求前后钩子](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/durable/src/harness/types.ts#L859)及其[实际调用](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/durable/src/harness/generation.ts#L218)。                                                                                               | 接自己的客户积分系统时，已经有账户归属、调用前授权、费用状态、预算预留及回调重投契约，不必从通用钩子开始设计这一层。                |
| ZCode 已有 [SQLite 用量记录](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts#L25-L60)、[Z.AI 套餐余额请求](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/model-provider/zaiStartPlanBilling.ts#L63-L112)，以及每次模型尝试的 [acquire/release 准入端口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/contracts/src/model/index.ts#L53-L95)。 | 本工程直接面向宿主自己的商业账户，提供 `authorize/record` 与 USD 费用状态；供应商套餐余额、并发准入与客户账务不必混在同一个接口里。 |
| DeepSeek 已有 [官方账户钱包查询](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/account-controller/src/index.ts#L29-L37)、[累计用量投影](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/token-meter/src/usage-projection.ts#L110-L150)，LLM 请求可由 [middleware 包装](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L1166-L1179)。                                     | 自有客户账户的前置额度检查、幂等回告和持久费用状态已有明确契约，可以直接接到现有商户系统；不需要先从流式 middleware 设计完整接点。  |

这个优势不等于内核自带支付或多租户平台。登录、充值、积分价格、余额事务和终端用户数据授权仍由宿主提供。供应商真实扣费也不能单凭本地预留额保证；应按供应商限制与实际账单设置和核对。

## 2. 宿主权限与持久审批：业务策略已有统一入口

本工程将宿主、模式、实际模型路由、项目和祖先会话的 `deny/ask/allow` 取最严格组合；审批记录持久化，审批返回后复核策略撤销。对于把 Agent 放进业务产品的团队，具体收益是宿主拒绝策略可以持续约束工具执行，不必在各工具、模型和界面中分别维护一套放行逻辑。

证据：[策略组合与审批复核](../src/core/permissions.ts)、[授权范围约束](../src/core/kernel/authorization.ts)、[审批 API](../src/api/routes/resources.ts)。这描述工具策略与执行前检查，不等于终端用户多租户授权，也不等于 OS 沙箱。

- **pi 也能阻断工具。** [beforeToolCall](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/agent/src/types.ts#L319) 与[实际执行位置](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/agent/src/agent-loop.ts#L735)允许宿主检查调用；还有[危险命令确认示例](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/examples/extensions/permission-gate.ts#L13)及[项目可信度管理](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/src/core/trust-manager.ts#L30)。本工程的价值是上述业务策略和审批状态已经统一实现。
- **ZCode 的模式语义不同。** 它的 [PermissionService](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/permission/service.ts#L101-L183)有 Plan、危险规则、`alwaysAsk` 和项目策略；普通工具在非 Plan 的 `yolo/guarded` 模式下，存在先于项目 deny 检查的放行分支，前置强制询问与危险规则有例外。它还有[可取消和超时的审批代理](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/permission/broker.ts#L41-L138)。本工程选择宿主策略始终参与最严格组合，适合需要统一业务拒绝规则的调用方；不能由模式差异推导整体安全排名。
- **DeepSeek 也有审批记录和拒绝处理。** [user-approval](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/user-approval/src/index.ts#L215-L297)记录请求与决定，缺失或失败的批准通道会拒绝操作。本工程的优势是现有 Kernel、审批 API 和策略范围的组合，不是独有审批能力。

Windows 本机还有一项可区分的现成能力：本工程的 [执行后端](../src/execution/process.ts)与[隔离适配](../src/execution)包含 AppContainer 路径，强制隔离时拒绝回到 native，隔离 PTY 不支持时明确失败。pi 所查 [SandboxManager 扩展示例](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/examples/extensions/sandbox/index.ts#L145)在 [Darwin/Linux 初始化](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/examples/extensions/sandbox/index.ts#L251)，另有 [Gondolin 微虚拟机示例](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/examples/extensions/gondolin/index.ts#L1)。这只能证明所查 Windows 集成路径的差异，不能代表对方所有可用隔离方案。

## 3. Node 集成和客户端：减少哪一层桥接

本工程的 `Kernel` [直接创建核心服务](../src/core/kernel.ts)，工具、权限和计费回调可调用宿主 Node 函数；[独立客户端](../src/client.ts)使用 fetch、JSON 与游标 SSE，管理的是同一套项目、运行、审批、资产和费用状态。[SDK 指南](SDK.md)还提供本地打包与独立消费者接入流程；当前 npm 尚未公开发布。

| 已核对的具体路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 选择本工程时的实际差异                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek 官方 [TS SDK](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/index.ts#L1-L12)通过 [spawn 启动 dsh](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/client.ts#L211-L218)，并[校验版本配对](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/launch.ts#L55-L65)；[Python 封装](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/python/sdk/src/deepseek_harness/api.py#L47-L94)也持有并复用运行时子进程。                                                                                              | 已有 Node 业务服务可直接导入本工程 Kernel，省去该官方 SDK 路径的运行时子进程、stdio JSON-RPC 和版本配对管理。DeepSeek 内部 [AgentLoop 本身是可组合 Service](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L340-L388)，仍可另行装配进程内运行时。 |
| ZCode 已公开导出 [createZCodeApp](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/index.ts#L1-L18)，构造时[接收 ProviderRegistry](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts#L163-L181)，支持注入模型、存储与权限；独立客户端使用 [WebSocket、SocketProtocol 和 ChannelClient](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/client/src/websocket.ts#L62-L108)。bootstrap 是 [private workspace 包](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/package.json#L1-L41)，仓库同时有 HTTP 服务。 | 本工程把独立 `/v1` JSON/SSE 管理面和 fetch 客户端作为集中入口，适合已有网页或其他语言服务直接接入，减少适配该产品 RPC 服务访问器的工作。不能说 ZCode 没有 SDK、HTTP 或进程内入口。                                                                                                                                                     |
| pi 的 [createAgentSession](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/src/core/sdk.ts#L191)可直接嵌入；同时提供 [stdin JSONL RPC 模式](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L808)。                                                                                                                                                                                                                                                                                                                                                                                                                              | 进程内 SDK 不是本工程对 pi 的独有优势。这里的收益是本工程已有项目、审批、费用、媒体与资产 API；是否能减少工作取决于调用方需要哪些具体实体和接口。                                                                                                                                                                                      |

上述进程边界不能换算为节省多少内存或耗时。

## 4. 存储：现成业务实体与可替换后端的取舍

本工程 [entity-query](../src/storage/entity-query.ts)包含项目、审批、费用、媒体等实体，[Store](../src/storage/store.ts)用 SQLite 保存业务实体、消息与运行事件，并提供定向查询、分页和费用聚合。需要把“客户账户的项目、运行、审批和费用”关联起来时，这套实体和 API 已存在；新增业务仍需在宿主实施授权与查询边界。

- **DeepSeek 标准 base profile**采用 [JSONL 持久后端](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/index.ts#L1-L6)；[profile 组合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L138-L161)中的 SQLite 是[可丢弃的查询读模型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query-sqlite/src/index.ts#L69-L89)。本工程的单库业务实体关联更直接；对方的事件源、派生索引与可替换持久化服务更灵活。没有测试证明哪种更快。
- **pi Coding Agent**有 [JSONL 会话树](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/src/core/session-manager.ts#L975)，**pi-durable 同时有 [SQLite 表结构](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/durable/src/storage/sqlite/schema.ts#L9)**及[事务与恢复约定](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/durable/src/session/session.ts#L100)。它的会话树与多种存储后端是优势；本工程的选择价值是应用实体和管理接口已有统一实现。
- **ZCode**已经使用 [node:sqlite 会话存储及迁移](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts#L226-L276)。SQLite、持续工具循环和会话管理不能作为本工程独有卖点。

## 5. 依赖、性能与产品完成度

本工程核心直接运行依赖是 Ajv、TypeBox、YAML、Zod，自行维护三种文本协议与 MCP 客户端，并[动态导入可选宿主](../src/host/integration.ts)。这让依赖和协议维护的范围更明确，同时也要求本工程自己承担兼容性维护。

pi 的 [模型包](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/ai/package.json#L69)接入更多供应商 SDK，同时真实实现了 [lazy 加载](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/ai/src/api/lazy.ts#L88)。DeepSeek 将 LLM、循环、会话等组合为 Cordis 服务，支持[profile 热重载](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L27-L32)，可以使用 [pi-ai 适配](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-pi-ai/package.json#L42-L46)。ZCode 具有[成品桌面入口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/package.json#L1-L27)、官方账户服务与[插件市场接口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/index.ts#L43-L58)。这些都是对方的实际长处。

因此，此次不能得出以下比较结论：

- 本工程比三个项目整体更快、更省内存，或模型回答更好。
- 依赖更少就代表整个进程 RSS 更低，或者 SDK 使用子进程就一定更慢。
- 自己实现协议就代表兼容性、安全性或生态覆盖更全面。
- 已有 `billingAccount` 就代表内置了完整多用户身份、支付与租户隔离。

本工程的 [footprint 报告](../verification/kernel-footprint.json)仅证明指定 Windows/Node 环境中的空闲核心场景。比较其他工程时，应分别选择可比的最小内核与完整应用场景，再统一模型、任务、采样与进程统计口径。

许可方面，pi 和 DeepSeek 为 MIT，ZCode 为 Apache-2.0；本工程当前为 `UNLICENSED/private`。对需要第三方复用与分发的人，三者的明确开源许可目前是优势；本次没有修改本工程授权。

## Claude Code 的比较范围

本次没有获得并审查 Claude Code 完整运行时源码。其 [公开 Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)也提供工具、权限、会话、hooks 和费用追踪，不能以“它只有 CLI、不能嵌入”作比较。对 Claude Code 的判断限于公开接口和运行方式，不与以上三个开源项目的源码核对混为同一种证据。

本工程适合的选择理由可以具体写为：**已有 Node.js 产品，需要直接接自己的客户账户、审批和业务数据，希望采用一套已经组合好的 Kernel 与 HTTP/SSE 契约。** 选择现成编码工作区、广泛供应商适配、插件生态或通用持久任务时，也应认真评估其他项目。
