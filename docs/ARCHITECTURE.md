# 源码结构与阅读顺序

本工程是一个 TypeScript 单包 SDK。公开 npm 入口固定为根入口、`/client` 和 `/host`；源码内部按能力组织，不为每个目录建立独立包或转发入口。

## 目录职责

```text
src/
├─ index.ts                   Node SDK 公开导出
├─ client.ts                  独立 fetch / SSE 客户端
├─ cli.ts                     命令行入口
├─ contracts.ts               跨模块公开数据契约
├─ version.ts                 运行时版本
├─ core/                      内核组装、配置、权限、上下文、Agent 定义
│  └─ kernel/                 输入构造、历史修复、运行装配、MCP 宿主、授权、路由持久化与进程控制运行
├─ api/                       HTTP 生命周期、认证、SSE 和通用请求处理
│  └─ routes/                 按配置、会话、资源、记忆、扩展、MCP 分组
├─ runtime/                   执行循环、工具注册、调度、钩子、费用与结果
├─ security/                  默认关闭的输入/工具审计、规则扩展与结构化记录
├─ tools/                     内置工具及共用结果包装
├─ storage/                   SQLite（每类实体一张表）、资产、记忆
├─ sessions/                  会话快照、引用工具、迁移与文件检查点
├─ providers/                 HTTP 传输、协议注册表、序列化、流解析和思考参数
│  └─ protocols/              各文本协议适配器（OpenAI Chat/Responses、Anthropic）
├─ prompts/                   内核拥有的系统提示词模板
├─ transport/                 跨环境 SSE 解码与 Node HTTP 监听
├─ modes/                     工作模式定义与策略
├─ collaboration/             固定团队契约、协调与成员任务
│  └─ internal/               职责审查、派工、状态和团队上下文
├─ execution/                 命令、持久进程、扩展执行宿主与隔离
│  └─ native/                 ConPTY、AppContainer、POSIX PTY 辅助资源
├─ extensions/
│  ├─ skills.ts               Skill 安装、启用和资源
│  ├─ plugins/                Plugin 管理、源码包和 Worker
│  └─ mcp/                    MCP 连接、协议管理和交互（protocol.ts 为 JSON-RPC 帧与共享类型）
│     ├─ client/              stdio、HTTP/SSE、请求管理、输入关联、订阅、工具目录与现代任务轮询
│     ├─ auth/                OAuth、设备授权、注册、密钥和凭据
│     └─ tasks/               MCP 异步任务
├─ servers/                   服务器档案、凭据、SSH/SFTP 和服务器事实
├─ media/                     媒体任务管理与适配器
├─ web/                       网页抓取、搜索接入与网络策略
└─ host/                      可选应用集成及其工具、API、资源生命周期
   ├─ browser/                浏览器管理、网络策略和用户浏览器桥接
   ├─ computer/               电脑控制及 native 平台辅助资源
   └─ office/                 办公文件管理、API、提取器和 Worker
```

工程根的 `extensions/` 是独立扩展资源，例如浏览器桥接扩展；`src/extensions/` 是扩展系统的实现，两者用途不同。`dist/`、`releases/` 和 `verification/` 分别保存编译结果、交付产物和实际验证证据。

系统提示词来源、可选安全审计模块和规则扩展见 [SECURITY-AUDIT.md](SECURITY-AUDIT.md)。内容审计与 core 的权限/审批职责分开，默认不执行规则。

## 阅读顺序

1. 接入 SDK：先看 `docs/SDK.md` 和 `examples/sdk/`，再按需查看 `src/index.ts` 的公开导出。
2. 理解一次运行：从 `core/kernel.ts` 的提交和运行生命周期进入 `runtime/engine.ts`，再看工具注册、权限与模型协议。
3. 理解 HTTP 接入：从 `api/server.ts` 的认证和分发进入 `api/routes/`；SSE 输出位于 `api/events.ts`。
4. 调整某类能力：优先进入相应模块。工具定义在 `tools/`，团队在 `collaboration/`，服务器在 `servers/`，可选应用在 `host/`。

`core/kernel.ts` 负责组装各能力，不要求所有依赖机械地单向指向 core。其他模块对 Kernel 的上下文引用尽量使用类型导入；实际跨模块交互通过已有公开方法、注册接口和明确依赖完成。

运行状态由 `core/kernel/lifecycle.ts` 集中维护，工具授权约束由 `core/kernel/authorization.ts` 合并；`runtime/engine.ts` 负责对话循环和检查点，`runtime/tool-execution.ts` 负责校验、授权、hook 与外部效果记录。调度器、Schema 校验器和持久化语句分别维护自己的有界或固定集合缓存，不缓存权限判定或数据库记录。具体优化和复现方式见 [OPTIMIZATION.md](OPTIMIZATION.md)。

HTTP JSON 管理路由通过 `api/route-table.ts` 统一分发，精确路径优先；路由输入 Schema 在模块加载时构造，请求解析与授权仍逐次执行，文件下载和 SSE 保留专用处理。JSON Schema 校验按 dialect 复用并轮换 Ajv 编译器，用户 schema 注册项在每次编译后清理；Memory 的同步查询复用有界 statement，跨异步等待的语义检索游标使用独立 statement。MCP 仅合并同连接、同目录版本的在途目录请求，结果完成后不缓存；SSE 用读指针处理积压队列，历史尚未回放完时发生溢出会结束连接，让客户端从最后成功发送的游标重连。本轮实现、计量口径与验证限制见 [REFACTOR-CONSOLIDATION.md](REFACTOR-CONSOLIDATION.md)。

## 运行装配、协议与存储

- `Kernel.startRun` 只负责生命周期：`prepareEngine` 读取历史、筛选工具、检索记忆并生成提示词，`createEngine` 构造执行引擎，`settleRun` 通知集成并结算。历史加载、工具筛选与记忆上下文位于 `core/kernel/run-setup.ts`。
- 文本模型协议实现 `providers/protocol.ts` 的 `TextProtocol`，由 `providers/registry.ts` 按 `route.adapter` 查找。宿主在加载配置前调用 `registerTextProtocol` 即可接入新协议，`HttpTextProvider` 只负责传输、错误和部分结果。协议事件与 JSON 响应从 `unknown` 解析，内置协议的字段校验集中在 `providers/protocols/wire.ts`；不透明的厂商回放字段继续保留。自定义协议须先校验输入，再调用 `ResponseBuilder`。
- `MCPClient` 保留连接协商、公开调用与关闭编排；`extensions/mcp/client/` 按传输、请求生命周期、输入来源、订阅、工具 schema 和现代任务轮询拆分。跨模块 JSON 使用 `core/wire.ts` 读取未知字段，经过校验的工具声明、结果和 JSON-RPC 帧使用具体类型。
- 权限规则通过工具声明的 `capabilities`、`roles`（`plan-state`）与按参数补充约束的 `constrain` 判断，不依赖工具名称。启动子 Agent 的工具声明 `agent` 能力（宿主默认 allow，可在 `permissions.agent` 改为 ask/deny），团队会话据此拒绝绕过派工的委托。`tools/index.ts` 汇总工具时拒绝扩展工具冒用 `builtin/foundation` 来源或与已有工具重名，因此声明可以被信任。
- 提示词按句写在 `prompts/` 与各模块的 `sentences(...)` 中，拼接结果与原单行文本一致。
- 宿主计费通过 `KernelOptions.billing`（`runtime/billing.ts` 的 `BillingProvider`）接入：每次模型、embedding 和媒体调用发出前调用 `authorize`，宿主可抛错拒绝（如积分不足），内核作废预留并以 `billing_refused` 失败；最终结果经 `record` 报告不含缓存的输入、输出、缓存读写 token 或媒体计费单位，按 `charge.id` 幂等，未确认的结果在重启后重新投递。项目的 `billingAccount` 随每笔费用传给宿主；媒体单位按标准化请求估算，适配器或插件可在 `billing.units` 中报告实际值。内核的 USD 账本和预算保持原样。
- Agent 定义的 `systemPrompt` 替换默认身份与工作规则；运行事实、模式说明、Skill 和三条安全规则（不可信数据、不泄露凭据、宿主审批）始终保留。未设置时提示词与此前逐字节一致。
- 上下文压缩的保留与省略选择不变；缓存未命中时，若会话上一次的摘要覆盖当前省略内容的前缀，只总结“上一摘要 + 新省略的消息”，不再每步重新总结全部旧历史。省略内容与前缀的哈希在一次序列化中求出。token 估算按消息对象缓存序列化长度（历史消息提交后不再修改），整段历史的估算变为求和。
- 凭据脱敏由配置 `redaction.mode` 控制（进程级，内核构造时应用）：`full`（默认）在每次操作时加入已注册凭据和所有名称像凭据的环境变量；`registered` 只用已注册凭据（路由密钥、鉴权请求头等）和 `redaction.environment` 列出的变量，不枚举环境，开销很低；`off` 完全关闭，包括进程输出脱敏，凭据可能以明文写入数据库和发给模型。服务器插件保险库对自身 SSH 凭据的脱敏不受此开关影响。
- 脱敏在没有凭据时直接序列化，短于最短凭据的字符串跳过逐值替换，环境变量值的 JSON 转义形式按值缓存；每次操作仍重新枚举环境变量。事件写入复用脱敏后的数据文本，不再重复序列化。
- 实体按类型存放在 `e_<kind>` 表中，只为实际使用的过滤字段建立表达式索引；旧数据库打开时在一个事务内从 `entities` 迁移，未知类型的行保存在 `entities_legacy`。会话历史替换只重写变化之后的消息。
- 存储热点进一步优化包括 `effects.projectId` 索引、同步历史替换内的脱敏上下文、数据库触发器维护的历史计数、内部数组行读取和按缺失对象修复 schema；设计与验证边界见 [STORAGE-PERFORMANCE.md](STORAGE-PERFORMANCE.md)。

## 本轮效率与规范整理

- 事件：流式增量在引擎内按 32ms 合并为一个事件（所属会话仍逐次读取，因为其他连接可能修改或删除 run）；事件只在有订阅者时序列化线上文本，SSE 各订阅者复用同一份 JSON（`Store.eventJson`）。
- 消息提交：引擎对每条消息只脱敏、序列化一次，transcript 行与 `assistant.message.committed` 事件复用该文本。
- 上下文：系统消息在一次运行内复用同一对象，团队说明拼接结果按输入缓存；工具 schema 的 token 权重按工具对象缓存（`estimateToolTokens`）。
- 查询：团队、路由、模式相关的会话检查改为带过滤的 SQL 查询，并为 `collaboration.teamId`、`teamRootSessionId`、`team-tasks.teamId` 建表达式索引；费用汇总在 SQLite 中聚合，明细分页返回。导出迁移用 `transcriptVersion`（条数与序号）判断会话是否变化，不再整段解析与哈希。
- 记忆向量新写入为 float64 BLOB，检索时一次遍历同时求点积与范数；旧 JSON 文本行仍可读取，重新嵌入时转换。
- 保留：`retention.eventDays` / `cacheDays` 默认 0（不删除）；开启后按批删除已结束运行的事件日志、未被引用的压缩摘要和运行上下文记录，并执行 `PRAGMA optimize`。
- 规范：`npm run lint`（ESLint + typescript-eslint）与 `npm run format:check`；src 中的显式 `any` 为错误，外部输入在适配边界校验后使用，测试和示例保留原有 lint 配置。`ToolDefinition` 默认参数类型为 `unknown`，具体工具使用与其参数 schema 一致的泛型；执行入口仍逐次校验 schema。`RouteRouter.create(config, options)` 与 `Kernel.routerFor(scope)` 取代内部的位置参数构造。

## 维护边界

- SDK 调用方使用公开 npm 入口；内部文件路径随维护调整。HTTP 路径、工具名称与参数、权限、事件和持久格式由既有契约约束。
- 可选浏览器和办公实现保留在 `host/`，默认内核不静态加载这些引擎；独立客户端也不导入 Node 内核。
- `host/applications.ts` 和 `host/desktop.ts` 保留各自公开入口，共用 `host/integration.ts` 的安装、授权和资源关闭流程；reference profile 仍提供原有节点工具和节点回调，applications profile 仍按选项启用浏览器桥接、电脑或办公能力。
- `runtime/keyed-queue.ts` 提供按资源串行的队列，供会话输入、OAuth 密钥及服务器配置复用；共享凭据文件按规范化路径串行读写。`core/util.ts` 的资源关闭器按依赖顺序尝试所有关闭操作，并汇总错误。
- MCP 完整工具目录先收集分页，再一次性提交输入/输出校验器及参数 headers；连接、目录版本或取消信号变化时不提交。目录分页限额集中在 `extensions/mcp/catalog.ts`，在途调用使用自己的 metadata 快照。
- 工具结果、图片回传和产物事件共用内置工具包装；运行资源路径由 `scripts/runtime-files.mjs` 统一提供给复制脚本和包检查。
- 模块内部不为单个函数增加无用途的入口、基类或转发服务；明确的私有实现放在所属模块下。
- 历史 CommonJS Worker 在本轮只调整所在目录，保持实现内容；新增和重构的模块使用 ESM。

0.12.1 的结构整理与重复代码精简保持原有产品能力；当前源码另外加入可选安全审计，行为和验证以专门说明为准。大内核的运行编排仍是后续可继续改善的部分；提取有明确输入输出的逻辑，不为满足文件行数机械拆散状态机。结构指标与实际回归结果由对应验证报告记录。
