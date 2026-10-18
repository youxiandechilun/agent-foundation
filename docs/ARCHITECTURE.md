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
│  └─ kernel/                 输入构造、历史修复、MCP 宿主和授权纯逻辑
├─ api/                       HTTP 生命周期、认证、SSE 和通用请求处理
│  └─ routes/                 按配置、会话、资源、记忆、扩展、MCP 分组
├─ runtime/                   执行循环、工具注册、调度、钩子、费用与结果
├─ security/                  默认关闭的输入/工具审计、规则扩展与结构化记录
├─ tools/                     内置工具及共用结果包装
├─ storage/                   SQLite、资产、记忆
├─ sessions/                  会话快照、引用工具、迁移与文件检查点
├─ providers/                 模型协议、序列化、流解析和思考参数
├─ transport/                 跨环境 SSE 解码与 Node HTTP 监听
├─ modes/                     工作模式定义与策略
├─ collaboration/             固定团队契约、协调与成员任务
│  └─ internal/               职责审查、派工、状态和团队上下文
├─ execution/                 命令、持久进程、扩展执行宿主与隔离
│  └─ native/                 ConPTY、AppContainer、POSIX PTY 辅助资源
├─ extensions/
│  ├─ skills.ts               Skill 安装、启用和资源
│  ├─ plugins/                Plugin 管理、源码包和 Worker
│  └─ mcp/                    MCP 连接、协议管理和交互
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
