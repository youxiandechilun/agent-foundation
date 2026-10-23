# Agent Foundation

把 Agent 能力接进自己的产品：**可嵌入的 TypeScript / Node.js 内核、独立 HTTP / SSE 客户端，以及按需启用的浏览器、桌面和办公集成。**

你决定界面、业务流程、模型、数据保存位置和收费方式；Agent Foundation 提供持续执行、工具调用、权限审批、会话存储与费用记录。适合开发自己的 AI 助手、企业内部工具、付费应用后端和自动化服务。

## 为什么选择这个工程

- **直接嵌入现有 Node.js 应用**：在同一进程创建 `Kernel`，使用自己的工具和业务接口；也可独立运行服务，通过 HTTP / SSE 接入网页、Electron 或其他语言。
- **把产品规则放在自己手中**：模型路由、角色、工作区、审批和计费由宿主配置，项目、会话、附件和执行记录保存到自己的 SQLite 与资产目录。
- **支持按业务账户计费**：项目可绑定账户；每次模型调用前由宿主检查余额或积分，调用后报告用量和结果，接入已有的账户系统。
- **轻量运行、按需扩展**：核心只有四项直接运行依赖，浏览器、Office 与桌面能力单独启用。无需为了运行内核安装另一套 Agent CLI。
- **复用一套执行与审计接口**：文件、命令、MCP、子 Agent 和可选宿主共用会话、权限、审批、资产与事件，方便在产品中展示进度、处理授权和追踪结果。

交付形态是内核、SDK 与 API。面向最终用户的聊天界面、账户页面和业务管理界面由调用方实现。

## 从产品到执行

```text
你的网页 / Electron / 后端 / 自动化服务
                 │ 进程内 SDK，或 HTTP + SSE
                 ▼
               Kernel
                 ├─ 项目、会话、输入队列与 SQLite 存储
                 ├─ 模型路由 → 回复 → 工具调用 → 继续执行
                 ├─ 参数校验、权限、审批、预算与宿主计费
                 └─ 上下文、记忆、资产、扩展与 Agent 协作
                               │
                   模型服务 / 本机工具 / 业务系统
```

创建项目和会话、提交输入、订阅事件，即可接入一次运行。`assistant.message.delta` 用于流式显示，`assistant.message.committed` 表示一条完整回复，`run.completed` 表示整次运行结束。审批请求也通过事件交给你的界面处理。

## 轻量与效率设计

核心直接运行依赖为 **Ajv、TypeBox、YAML、Zod**；SQLite 使用 Node 内置模块。文本协议和 MCP 客户端由本工程维护，核心不依赖外部 Agent CLI、模型厂商 SDK 或 MCP SDK。开发依赖、可选依赖与实际安装体积另计，见 [package.json](package.json)。

- **减少流式处理开销**：增量在引擎内按短时间窗口合并，消息提交复用脱敏后的序列化文本，多个 SSE 订阅者共享事件 JSON。
- **控制慢客户端积压**：HTTP / SSE 按 `write` / `drain` 处理背压，超过队列限制时断开；客户端可按游标恢复持久事件。
- **缓存有范围和生命周期**：SQL 语句、schema 编译和 token 估算使用固定集合、有界缓存或对象生命周期缓存，不缓存权限判定。
- **让 SQLite 处理筛选与汇总**：常用查询使用定向 SQL 和索引，费用汇总在数据库中聚合，明细与消息分页读取，减少全量记录进入 JavaScript 堆。
- **把附加能力留到需要时**：浏览器、桌面和办公库按需安装和装配；办公解析 worker 限制并发、时间与堆大小。可配置历史事件及缓存保留期限。

本机最小核心与 HTTP 服务空闲实测为**百 MiB 级进程占用**：

| 指标                     | 五个独立进程的中位数                    |
| ------------------------ | --------------------------------------- |
| 整进程 RSS               | **115.3 MiB**，五次范围 115.1–115.6 MiB |
| JavaScript `heapUsed`    | **31.6 MiB**                            |
| 动态导入内核至 HTTP 就绪 | **0.340 秒**                            |

测量于 **2026-10-23**，Windows x64 10.0.26200、Intel i5-14600KF、Node.js v22.23.2；五个进程串行启动，各用全新 SQLite，服务就绪后空闲 500ms 并显式 GC。启动时间不含 Node 进程创建和脚本静态导入；未创建项目、会话或调用工具与模型，可选宿主未启用。

结果只描述这个空闲场景，不能外推到浏览器、Office、大数据或并发任务，也没有与竞品做同条件比较。构建后运行 `node scripts/benchmark-kernel-footprint.mjs` 可复现，见 [测量脚本](scripts/benchmark-kernel-footprint.mjs) 与 [原始报告](verification/kernel-footprint.json)。历史 [优化说明](docs/OPTIMIZATION.md) 中的 2026-10-18 模块增量堆数据是另一种口径；存储设计与复现入口见 [存储性能文档](docs/STORAGE-PERFORMANCE.md)。

活动历史、上传/下载、输入队列和 SSE 的容量约束，以及列表分页迁移见 [容量与效率](docs/CAPACITY-OPTIMIZATION.md)。完整开发质量检查为 `npm run check:quality`，包含测试和示例的严格类型检查。

## 多账户用量与计费接入

已有的 `Project.billingAccount` 与 `KernelOptions.billing` 可把不同项目的模型费用关联到宿主的业务账户。宿主实现 `BillingProvider`，按自己的余额、积分或套餐规则处理每次调用：

1. **调用前授权**：`authorize(charge, signal)` 在文本、embedding 和媒体请求发出前执行。宿主可检查或预留额度；拒绝时内核返回 `billing_refused`。
2. **调用后记录**：`record(charge, outcome)` 接收 `settled`、`void` 或 `unknown`，以及已确认的 token、媒体单位和可用的费用信息。内核另有 USD 费用账本与预算限制。
3. **按同一笔费用幂等更新**：使用稳定的 `charge.id` 作为键；相同费用可能再次报告最新状态，记录失败后可在重启时重投，不能每收到一次回调就重复扣费。

```typescript
// 接入片段：config、workspace 与 billing 由你的宿主提供。
const kernel = new Kernel(config, { billing });
await kernel.init();
const project = await kernel.createProject("客户项目", workspace, {
  billingAccount: "customer-001",
});
// 已有项目也可通过 kernel.setProjectBillingAccount(...) 绑定账户。
```

无用量、请求中断或供应商原生搜索费用不明确时，需要保留待对账状态，再依据实际账单处理。供应商成本与向客户收取的价格可以不同，换算和最终扣款由宿主决定；回调契约见 [计费接口](src/runtime/billing.ts) 与 [架构说明](docs/ARCHITECTURE.md)。

**内置 HTTP 服务仍使用统一的 host token。** 它是可信宿主入口；终端用户登录、充值、套餐管理，以及每个账户可以读取哪些项目和数据，由上层应用实现。多账户费用归属与回调已经具备，完整多租户身份和数据隔离需要在产品层继续建设。

## 与现有 Agent 产品如何选择

本工程的具体优势集中在**业务账户计费、宿主审批策略和现成后台接口的组合**。本次源码核查不能证明模型质量、通用执行循环或内存占用全面领先；SDK、多模型、SQLite 和 MCP 都不是独有能力。

以下按 **2026-10-23** 检出的固定源码比较，完整路径、提交 SHA 和边界见 [源码比较说明](docs/SOURCE-COMPARISON.md)。

| 项目与固定源码                                                                                                                                                                           | 已核实的实现，以及本工程减少的接入工作                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pi** · [`74f4686` SDK 导出](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/coding-agent/src/index.ts#L254-L264)                           | 已有进程内 SDK、MCP、权限钩子、按需供应商加载，也可通过 pi-durable 使用 SQLite。本工程把项目账户归属、宿主收费回调、多级 USD 预算、对账与实体 HTTP API 直接组合，减少自建这些业务接口的工作；Pi 的扩展和存储选择仍有优势。                                         |
| **Z.ai ZCode** · [`3c5b227` 应用入口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts#L163-L181)  | 已有可注入端口的 Node 应用 API、SQLite 会话、客户端/服务端、套餐余额与用量统计。本工程提供标准 HTTP JSON / 游标 SSE、宿主权限交集及通用计费状态链路，适合自己实现业务产品；ZCode 的成品界面和插件市场更完整。                                                      |
| **DeepSeek Harness** · [`687f282` SDK 启动契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/launch.ts#L50-L75) | 官方 TypeScript / Python SDK 默认通过配套运行时子进程运行，内部 AgentLoop 也可进程内组合；标准 profile 用 JSONL 持久化，SQLite 是可丢弃的 FTS 读模型。本工程公开 Kernel 可直接进程内运行，将项目、会话、审批和费用放进同一业务存储，接自有客户账户时少写跨层适配。 |

选择本工程时，可以直接复用以下部分：

1. **接入自己的收费规则**：`Project.billingAccount` 关联业务账户，`authorize` 在请求前检查额度，`record` 报告用量与状态；支持运行、会话、项目、日期和总额预算，费用未知时保留预留额并按实际账单对账，通知可幂等重投。见 [计费契约](src/runtime/billing.ts)、[费用账本](src/runtime/cost.ts)。
2. **直接建设产品后台**：复用项目、会话、资产、输入队列、审批和费用 API，通过 HTTP / SSE 或同进程 SDK 接入。统一存储与事件契约减少自行组合状态同步的工作，见 [HTTP API](docs/API.md)、[Kernel 公开入口](src/index.ts)。
3. **把宿主限制落实到执行**：宿主、项目、模式、实际模型与祖先会话取最严格权限，审批后复核撤销；需要本机隔离时可选 Windows AppContainer。见 [权限实现](src/core/permissions.ts)、[隔离范围](docs/CORE-FOUNDATION.md)。这些机制已组合在内核中，其他项目也可通过扩展实现相近需求。

对方在成品 UI、插件生态、存储自由度或明确的开源许可方面各有强处；本工程当前为 `UNLICENSED`，复用许可尚未确定。没有同条件的跨项目性能测试，不能据依赖数量或空闲核心数据作速度、内存排名。

**Claude Code / Claude Agent SDK** 仅核查了[公开 SDK 接口](https://code.claude.com/docs/en/agent-sdk/overview)，缺少完整运行时源码，未纳入上述三个开源项目同等级的源码结论。

## 能力一览

| 能力         | 当前实现                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型与执行   | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；模型路由、回退与重试、图像输入、结构化输出、持续工具循环、并行调度、追加输入、取消与恢复 |
| 工具与权限   | 文件、命令、持久进程、Git、网页抓取与可插拔搜索；宿主/项目/模式/路由/扩展策略共同约束，支持审批、预算和效果日志                                         |
| 存储与上下文 | SQLite 项目、会话、费用与历史；附件资产、压缩、分叉、迁移、检查点与回滚                                                                                 |
| 记忆与协作   | 中英文全文检索、可选向量检索、命名空间与待审记忆提案；角色配置、子 Agent、团队派工与只读讨论                                                            |
| 扩展与宿主   | Skill、可信源码 Plugin、MCP stdio / Streamable HTTP；可选浏览器、Windows 桌面、办公文件、媒体适配器、SSH / SFTP                                         |

Responses 原生联网搜索默认关闭，需路由与请求显式启用，并通过网络权限及审批。供应商执行搜索并返回搜索记录、URL 引用；其请求不经过本地网页工具的网络过滤，也可能产生独立工具费用。详见 [原生联网搜索](docs/NATIVE-WEB-SEARCH.md)。

## 从源码开始

要求 Node.js `^22.19.0 || >=24.0.0`、npm 10+，建议使用仍在维护的 Node.js LTS。核心使用 `node:sqlite`，不声明支持 Node 23。

```powershell
git clone https://github.com/youxiandechilun/agent-foundation.git
cd agent-foundation
npm ci --omit=optional --ignore-scripts
Copy-Item config.json config.local.json
```

编辑 `config.local.json`：

- 将 `routes.text-completions.model` 的 `YOUR_MODEL_ID` 换成服务提供的实际模型，配置 `baseUrl` 和密钥环境变量名 `apiKeyEnv`。
- 让 `defaultRoutes` 指向已配置路由；使用 Responses 或 Anthropic 时选择对应 `adapter`。
- 配置允许建立项目的 `workspaceRoots`，用 `dataDir` 单独保存数据库、资产与运行状态。

在同一 PowerShell 终端启动：

```powershell
$env:OPENAI_API_KEY = "你的供应商密钥"
npm run build
npm start -- --config config.local.json
```

默认地址 `http://127.0.0.1:4317`，健康检查为 `GET /health`。`AGENT_API_TOKEN` 可提供宿主令牌；未设置时生成到 `dataDir/api-token`，启动日志显示位置。模型密钥和宿主令牌用途不同。`config.local.json` 已被 Git 忽略，其他配置可参考 [config.example.json](config.example.json)。

核心启动无需 Docker、Chromium 或办公库，不会自动打开聊天界面；实际任务需要可用模型服务。

## 接入自己的应用

### HTTP / SSE 客户端

服务启动后，把下面代码保存为仓库根目录的 `client-example.mjs`，执行 `node client-example.mjs`。如果服务使用环境变量令牌，客户端终端也要设置该变量。

```javascript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./dist/index.js";
import { FoundationClient } from "./dist/client.js";

const config = await loadConfig("config.local.json");
const token =
  process.env[config.server.tokenEnv] ||
  (await readFile(path.join(config.dataDir, "api-token"), "utf8")).trim();
const client = new FoundationClient("http://127.0.0.1:4317", token);
const project = await client.project("示例项目");
const session = await client.session(project.id, "chat");
const { runId } = await client.submit(session.id, {
  text: "你好，请介绍你可用的能力。",
  clientMessageId: crypto.randomUUID(),
});
for await (const event of client.events(runId)) {
  console.log(event.type, event.data);
}
```

客户端只依赖 `fetch`、`Blob`、`ReadableStream` 等通用 API，可用于网页及 Electron 渲染层。可信宿主应保管 host token；面向多用户的网页通过自己的后端鉴权和转发，避免把管理令牌直接交给终端用户。直连场景还需配置 `server.allowedOrigins` 并处理 `approval.requested`，见 [HTTP API](docs/API.md)。

### 进程内 SDK

也可以直接运行内核，无需先启动 HTTP 服务。以下示例在源码仓库根目录执行；同一数据目录同时只运行一个内核。

```javascript
import { Kernel, loadConfig } from "./dist/index.js";

const kernel = new Kernel(await loadConfig("config.local.json"));
try {
  await kernel.init();
  const project = await kernel.createProject("我的助手");
  const session = kernel.createSession(project.id, "chat");
  const { runId } = await kernel.submit(session.id, { text: "你好" });
  console.log(await kernel.wait(runId));
} finally {
  await kernel.close();
}
```

已有 Node 服务还可通过 `serve(kernel)` 暴露 HTTP API；自定义工具、解析器、集成和计费在初始化前注册。完整角色与团队示例见 [SDK 指南](docs/SDK.md)、[SDK 示例](examples/sdk)。

SDK 发行包有三个入口：`@local/agent-foundation`、`@local/agent-foundation/client`、`@local/agent-foundation/host`。拿到实际 `.tgz` 后在调用方安装；npm 尚未公开发布同名包，不要直接从公共 npm 安装。

## 按需启用应用能力

- **浏览器**：管理 Chromium、连接 CDP，或通过扩展控制用户明确授权的标签页。
- **Windows 桌面**：窗口与控件检查、截图、键盘鼠标操作；其他系统的原生桌面适配器尚未实现。
- **办公文件**：CSV、XLSX、DOCX、PPTX、PDF 的检查、生成及限定编辑。没有完整 Office 编辑器、Excel 公式计算引擎或 OCR。

```powershell
npm ci --ignore-scripts
npm run browser:install
npm run build:host
node dist/cli.js serve --config config.local.json --host desktop
```

`desktop` 启用上述三个应用包，也可选择 `--host browser`、`--host computer` 或 `--host office`。浏览器及部分 PDF 生成功能需要 Chromium；已有浏览器可按文档配置路径。安装与限制见 [应用集成](docs/APPLICATIONS.md)，其他可选能力见 [服务器](docs/SERVERS.md)、[媒体适配](docs/MEDIA-ADAPTERS.md)。

## 验证与运行边界

- [核心报告](verification/report.json) 与 [宿主报告](verification/application-report.json) 保存实际检查结果，阅读时核对报告时间、环境与对应源码。维护入口为 `npm run verify`、`npm run verify:host`，验收范围见 [交付文档](docs/RELEASE.md)。
- 默认 `native` 执行具有宿主用户权限，工具权限与路径规则不等于 OS 沙箱。可选 Windows AppContainer、Docker 的实际支持范围见 [权限与隔离](docs/CORE-FOUNDATION.md)。
- 真实付费模型质量、供应商计费、第三方 MCP/OAuth、Docker 和跨系统运行，需要在部署环境验证；本地协议测试通过不能替代这些检查。
- 取消不能撤销已经发生的外部操作；恢复不会自动重放效果未知的写入、发送或计费。压缩可能丢失细节，原始会话与效果记录供核查。
- 授权条款尚未确定，包标记为 `private: true`、`UNLICENSED`；源码可见不等于已授予商用或再分发许可。第三方来源及许可见 [源码边界](docs/SOURCE-BOUNDARY.md)。

## 文档导航

| 文档                                                                                      | 内容                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------- |
| [SDK](docs/SDK.md) / [API](docs/API.md)                                                   | 安装、公开入口、请求与事件            |
| [架构](docs/ARCHITECTURE.md) / [Agent 执行循环](docs/CORE-AGENT-LOOP.md)                  | 源码职责、工具执行、hooks、费用与恢复 |
| [原生搜索](docs/NATIVE-WEB-SEARCH.md) / [联网工具](docs/CORE-WEB.md)                      | 供应商搜索、权限、引用及费用边界      |
| [扩展](docs/EXTENSIONS.md) / [MCP 互操作](docs/CORE-INTEROPERABILITY.md)                  | Skill、Plugin、MCP、会话迁移          |
| [Agent 协作](docs/COLLABORATION.md)                                                       | 角色、子 Agent、团队、任务与讨论      |
| [应用](docs/APPLICATIONS.md) / [服务器](docs/SERVERS.md) / [媒体](docs/MEDIA-ADAPTERS.md) | 可选能力和依赖                        |
| [权限](docs/CORE-FOUNDATION.md) / [安全审计](docs/SECURITY-AUDIT.md)                      | 可信宿主、执行隔离与可选内容审计      |
| [验收](docs/RELEASE.md) / [能力清单](docs/CORE-ACCEPTANCE.json)                           | 范围、执行证据与待验证项              |
