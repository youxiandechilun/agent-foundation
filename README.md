# Agent Foundation

可嵌入的 TypeScript / Node.js Agent 内核，提供 HTTP / SSE API 和独立客户端，用于构建自己的 AI 助手、开发工具和自动化应用。

项目负责模型调用、持续执行、工具权限、上下文、会话、记忆和扩展管理。开发者通过模型路由、职责提示词、工具和团队配置组合不同 Agent，再接入自己的网页、Electron 或后端服务。当前交付是内核、SDK 和 API，没有成品聊天界面或配置界面。

当前版本 **0.12.1**。源码和验证记录在本仓库维护；npm 包尚未公开发布，授权条款尚未确定，`package.json` 标记为 `private: true`、`UNLICENSED`。

## 适合用来做什么

- **接入自己的产品**：复用执行循环、流式事件和会话存储，在上层实现聊天界面、审批交互和业务流程。
- **构建项目助手**：在指定工作区读取、搜索和修改文件，调用 Git 与命令行程序，并记录工具执行结果。
- **组合不同职责的 Agent**：为角色配置模型、指令、工具范围和记忆空间，启用子 Agent 或固定团队协作。
- **连接外部能力**：通过 Skill、源码 Plugin、MCP 或宿主集成，接入业务服务、浏览器、Windows 桌面和办公文件处理。

## 一次任务如何运行

```text
网页 / Electron / CLI / 其他程序
             │ HTTP + SSE，或进程内 SDK
             ▼
           Kernel
             ├─ 项目、会话、输入队列与持久化
             ├─ 模型路由 → 模型回复 → 工具调用 → 继续执行
             ├─ 工具校验、权限、审批、预算与生命周期钩子
             └─ 上下文、记忆、附件、扩展与 Agent 协作
                         │
             模型服务 / 本机工具 / 外部服务
```

调用方创建项目和会话、提交输入，再订阅运行事件。模型可以多次调用工具并继续工作；一条回复提交后，任务仍可能继续。`assistant.message.delta` 用于显示流式文字，`assistant.message.committed` 表示一条完整回复，`run.completed` 表示本次运行结束。

## 核心能力

| 能力 | 当前实现 |
| --- | --- |
| 模型接入 | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种文本协议；可配置地址、模型、凭据、回退和重试，支持图像输入与结构化输出 |
| 执行与工具 | 持续执行循环、并行工具调度、输入追加与任务转向、取消和恢复；文件、命令、持久进程、Git、网页抓取与可插拔搜索 |
| 权限与审批 | 宿主、项目、模型、模式和扩展的权限共同约束执行；支持逐次审批、资源限制、费用预算，以及默认关闭的内容安全审计 |
| 上下文与存储 | SQLite 项目和会话、附件资产、上下文压缩、会话分叉与迁移、文件检查点和回滚、工具效果日志 |
| 记忆 | 中英文全文检索、命名空间、有效期、修订历史；可选向量检索，自动记忆提案需人工批准后入库 |
| Agent 协作 | 自定义角色、子 Agent 委托、固定团队分工与只读讨论；成员可配置各自模型和职责 |
| 扩展 | 按需加载 Skill、受信任源码 Plugin、MCP stdio / Streamable HTTP；工具、资源、提示词及授权能力的具体范围见扩展文档 |
| 媒体与服务器 | 可选图片/视频适配器、任务轮询与产物管理；可选服务器档案、加密凭据、SSH 命令与 SFTP |

内置 `chat`、`code`、`office` 是工作策略，实际能力还取决于模型、权限和已启用的集成。模型协议与 MCP 客户端由本工程维护，不依赖外部 Agent CLI、模型厂商 SDK 或 MCP SDK；通用库及其许可见依赖清单。

## 从源码开始

要求 Node.js `^22.19.0 || >=24.0.0`、npm 10 或以上，建议使用仍在维护的 Node.js LTS。内核使用 Node 内置 SQLite；不声明支持 Node 23。

```powershell
git clone https://github.com/youxiandechilun/agent-foundation.git
cd agent-foundation
npm ci --omit=optional --ignore-scripts
Copy-Item config.json config.local.json
```

编辑 `config.local.json`，至少确认以下配置：

- `routes.text-completions.model`：替换 `YOUR_MODEL_ID`，使用服务实际提供的模型。
- `routes.text-completions.baseUrl` 和 `apiKeyEnv`：填写兼容服务地址与密钥环境变量名。默认使用 `OPENAI_API_KEY`，密钥值放在运行环境中。
- `defaultRoutes`：让需要的工作模式指向已配置的文本路由；更换为 Responses 或 Anthropic 时，同时选择对应 `adapter`。
- `workspaceRoots`：设置允许建立项目的工作区；`dataDir` 单独保存数据库、资产和运行状态。

配置好模型后，在同一个 PowerShell 终端启动：

```powershell
$env:OPENAI_API_KEY = "你的供应商密钥"
npm run build
npm start -- --config config.local.json
```

默认服务地址为 `http://127.0.0.1:4317`，`GET /health` 可检查服务状态。宿主令牌使用 `AGENT_API_TOKEN`，未设置时生成到 `dataDir/api-token`，启动日志会显示其位置。令牌由可信客户端持有；模型密钥和宿主令牌用途不同。

`config.local.json` 已被 Git 忽略。核心安装无需 Docker、Chromium 或办公库；启动服务不会自动打开界面，也不会替代真实模型服务。配置模板还可参考 [config.example.json](config.example.json)。

## 接入自己的应用

### HTTP / SSE 客户端

先按上面的步骤启动服务，再将以下代码保存为仓库根目录的 `client-example.mjs`，在另一个终端执行 `node client-example.mjs`。示例从本地配置读取令牌文件；若服务使用环境变量令牌，客户端终端也需设置相同变量。

```javascript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./dist/index.js";
import { FoundationClient } from "./dist/client.js";

const config = await loadConfig("config.local.json");
const token = process.env[config.server.tokenEnv] ||
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

独立客户端只依赖 `fetch`、`Blob`、`ReadableStream` 等通用 API，可供网页和 Electron 渲染层使用。网页接入时，由宿主提供令牌，将网页来源加入 `server.allowedOrigins`，并处理 `approval.requested` 等事件；完整接口见 [API.md](docs/API.md)。

### 进程内 SDK

也可以在自己的 Node.js 进程中创建内核。以下源码接入示例替代 `npm start`，同一个数据目录同时只能有一个内核运行。

```javascript
import { Kernel, loadConfig, serve } from "./dist/index.js";

const kernel = new Kernel(await loadConfig("config.local.json"));
// 自定义工具、解析器与宿主集成在初始化前注册。
const api = await serve(kernel);
console.log(api.url);
process.once("SIGINT", async () => { await api.close(); });
```

本地 SDK 发行包提供三个公开入口：`@local/agent-foundation`（内核）、`@local/agent-foundation/client`（客户端）、`@local/agent-foundation/host`（可选宿主）。拿到实际 `.tgz` 后可在调用方项目安装；当前不要直接从 npm 安装同名包。角色配置、团队组合和完整示例见 [SDK.md](docs/SDK.md) 与 [examples/sdk](examples/sdk)。

## 可选应用集成

浏览器、Windows 电脑控制和办公处理按需启用，复用同一套权限、会话、资产和事件接口。

- **浏览器**：管理 Chromium、连接已配置的 CDP 端点，或通过扩展控制用户明确授权的标签页。
- **Windows 桌面**：窗口和控件检查、截图、键盘鼠标输入；Linux/macOS 原生桌面适配器尚未实现。
- **办公文件**：CSV、XLSX、DOCX、PPTX、PDF 的检查、生成及限定范围编辑。没有完整 Office 编辑器、Excel 公式计算引擎或 OCR。

需要这些集成时，安装可选依赖并执行宿主构建：

```powershell
npm ci --ignore-scripts
npm run browser:install
npm run build:host
node dist/cli.js serve --config config.local.json --host desktop
```

`desktop` 同时启用三个应用包；也可使用 `--host browser`、`--host computer`、`--host office`。浏览器运行和部分 PDF 生成功能需要 Chromium，已有浏览器可按文档配置路径。具体操作、依赖和限制见 [APPLICATIONS.md](docs/APPLICATIONS.md)。服务器集成与媒体适配分别见 [SERVERS.md](docs/SERVERS.md)、[MEDIA-ADAPTERS.md](docs/MEDIA-ADAPTERS.md)。

## 项目结构

```text
src/
├─ core/           Kernel、配置、权限、上下文与 Agent 定义
├─ runtime/        执行引擎、工具调度、钩子与费用管理
├─ providers/      模型协议、路由与流式传输
├─ storage/        SQLite、记忆与附件资产
├─ extensions/     Skill、源码 Plugin 与 MCP
├─ collaboration/  团队与任务协作
├─ api/            HTTP / SSE 服务
├─ host/           可选浏览器、桌面与办公集成
└─ client.ts       独立 HTTP / SSE 客户端
test/              回归与集成测试
examples/sdk/      SDK 接入示例
verification/      已执行检查的报告与日志
docs/              接口、架构和范围说明
```

模块职责和源码阅读顺序见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 验证与使用边界

仓库现有 **0.12.1** 报告记录：核心集成测试 517 项通过，宿主集成测试 33 项通过；两份报告状态均为 `passed`。具体执行时间、Node 版本、检查项及依赖审计结果以 [核心报告](verification/report.json) 和 [宿主报告](verification/application-report.json) 为准。这些是已保存的执行记录，不代表每次源码更新都会自动重新验证。

本地维护可运行 `npm run verify` 验证核心，启用可选应用时运行 `npm run verify:host`。报告包含构建、集成测试、依赖审计和编译产物检查；验证范围见 [RELEASE.md](docs/RELEASE.md)。

- 当前面向**单用户、可信宿主**。未提供多租户账户、业务登录、企业身份管理或分布式集群。
- 默认 `native` 执行具有宿主用户权限。工具权限和路径规则不等于操作系统沙箱；可选 Windows AppContainer、Docker 的支持和验证范围见 [CORE-FOUNDATION.md](docs/CORE-FOUNDATION.md)。
- 本地模型协议服务验证了请求、流式事件和工具交互；真实付费模型质量、第三方 MCP/OAuth、Docker 及跨系统运行仍需按实际环境验证。
- 取消无法撤销已经发生的外部操作；恢复不会自动重放效果未知的写入、发送或计费操作。上下文压缩可能丢失细节，原始会话和效果日志保留供核查。
- 源码可见不代表已授予商用或再分发许可。第三方依赖保留各自版权与许可，来源说明见 [SOURCE-BOUNDARY.md](docs/SOURCE-BOUNDARY.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [SDK 接入](docs/SDK.md) / [HTTP API](docs/API.md) | 安装、公开入口、请求与事件 |
| [架构](docs/ARCHITECTURE.md) / [执行循环](docs/CORE-AGENT-LOOP.md) | 源码职责、工具执行、钩子与恢复 |
| [扩展](docs/EXTENSIONS.md) / [MCP 互操作](docs/CORE-INTEROPERABILITY.md) | Skill、Plugin、MCP、会话迁移 |
| [Agent 协作](docs/COLLABORATION.md) | 子 Agent、团队配置、任务与讨论 |
| [应用集成](docs/APPLICATIONS.md) / [服务器](docs/SERVERS.md) / [媒体](docs/MEDIA-ADAPTERS.md) | 可选工具和运行要求 |
| [权限与隔离](docs/CORE-FOUNDATION.md) / [安全审计](docs/SECURITY-AUDIT.md) | 单用户边界、隔离后端与可选审计 |
| [版本与验收](docs/RELEASE.md) / [逐项能力清单](docs/CORE-ACCEPTANCE.json) | 当前范围、执行证据与未实现项 |
