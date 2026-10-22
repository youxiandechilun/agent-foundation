# Agent Foundation 0.12.1

当前源码新增默认关闭的内容安全审计：支持 off/audit/enforce、输入和工具参数检查、结构化记录及宿主规则扩展。现有系统提示词、权限和审批保持各自职责，配置与扩展位置见 [SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)。

可嵌入、可独立部署的通用 Agent 内核，使用本工程维护的 TypeScript 源码。通过职责提示词、模型路由、权限、Skill、Plugin/MCP 与固定团队配置组合不同 Agent。默认运行包含 Agent 调度、模型协议、工具注册与权限、上下文、附件资产、记忆、会话与扩展管理；服务器和应用宿主显式启用。

0.12.1 整理源码模块边界、内核辅助逻辑、HTTP 路由和内置工具，复用结果包装及运行资源清单。源码结构、模块职责和阅读顺序见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。SDK 公开入口、HTTP/工具协议与数据格式保持兼容，实际回归和独立安装结果以当前版本报告为准。

当前工作区进一步优化工具调度、Schema 编译、上下文准备、流式读取与 SQLite 查询，并收敛运行生命周期和工具效果记录。实现边界、行为修正及可复跑基准见 [OPTIMIZATION.md](docs/OPTIMIZATION.md)；本机实际结果保存在 `verification/optimization-report.json`。

2026-10-18 的热点修正补齐事件会话归属、脱敏和工具数组隔离，并使用 SQLite 索引避免重复解析 Run 记录。三版本性能实测、回归结果及成本说明见 [REFACTOR-HOTPATH-FIX.md](docs/REFACTOR-HOTPATH-FIX.md)，原始样本在 `verification/hotpath-fix/`。

0.12.0 收尾已实现的执行循环增强、多 Agent 协作、跨会话引用和服务器插件，统一版本、验收登记与 SDK 交付。当前范围与证据规则见 [RELEASE.md](docs/RELEASE.md)；实际通过数量由相同版本的验证报告生成。配置界面、完整办公编辑器和公式引擎、OCR、专门的 LSP 代码智能与更多平台的桌面控制本次不开发；真实外部环境验证按用户要求暂缓。

0.11.0 收紧为单用户可信宿主，不开发多租户、业务账户登录、企业身份管理或分布式集群。OAuth 只保留为显式启用的外部 MCP 授权，默认不构造授权服务。新增可选 Windows AppContainer 命令、持久管道、源码 Plugin 和 MCP stdio 隔离，以及命令/插件关闭排空、宿主崩溃清理、残留恢复和真实拒绝测试。Docker 继续非必装。配置、工作原理、平台和运行时限制见 [单用户内核与系统隔离](docs/CORE-FOUNDATION.md)。

0.10.0 新增可单独启用的浏览器、Windows 电脑控制和办公应用包，完成实际 Chromium/CDP/扩展、UI Automation/SendInput 和文件格式集成测试。默认构建和启动仍不加载可选应用引擎。chat/code/office 是三种工作策略；在需要的宿主中安装对应应用包。具体支持与边界见 [APPLICATIONS.md](docs/APPLICATIONS.md)。

当前不依赖 pi、OpenAI/Anthropic 模型 SDK、MCP SDK 或外部 Agent CLI。执行循环在 `src/runtime/engine.ts`，三种文本协议在 `src/providers/`，MCP 客户端在 `src/extensions/mcp/client.ts`。仍使用 Ajv、TypeBox、Zod 和 YAML 这些通用库；其版权与许可不因本工程修改而改变，完整依赖由锁文件记录。

## SDK 交付与接入

普通 SDK 包提供编译后的 ESM JavaScript、类型声明、运行辅助文件和接入示例。调用方安装本地 `.tgz` 后，通过公开入口组合 Agent，不需要拷贝或修改底座 TypeScript 实现；JavaScript 保持可读，不使用字节码或混淆。授权条款暂未确定，未发布到 npm；源码维护在 [GitHub 仓库](https://github.com/youxiandechilun/agent-foundation)。

```powershell
npm install --omit=optional C:\delivery\local-agent-foundation-0.12.1.tgz
```

公开入口为 `@local/agent-foundation`、`@local/agent-foundation/client`、`@local/agent-foundation/host`。模型、职责、工具、团队及扩展的组合方式和完整示例见 [SDK.md](docs/SDK.md)。维护者使用 `npm run pack:sdk` 生成 `releases/0.12.1/` 下的包、文件清单和 SHA256，再用 `npm run verify:sdk` 在工程目录外验证独立安装；报告分别为 `verification/sdk-package.json` 和 `verification/sdk-consumer.json`。

## 从源码安装与启动

要求 Node `^22.19.0 || >=24.0.0`、npm ≥10，建议使用仍在维护的 LTS。核心使用 Node 内置 SQLite；不声明支持 Node 23，实际验证版本以 SDK 消费者报告为准。

```powershell
npm ci --omit=optional --ignore-scripts
npm run build
npm start
```

编辑 `config.json` 的地址、模型 ID 与凭据环境变量名，再在本机设置对应变量。默认配置不包含密钥，不返回演示答案。缺少供应商配置或密钥时明确报错。默认监听 `http://127.0.0.1:4317`；宿主令牌由 `AGENT_API_TOKEN` 或 dataDir 下生成的 `api-token` 提供。

最小构建无需 Chromium、Electron、Office 库或设备驱动。核心运行依赖只有 package.json 的 dependencies，办公与浏览器库放在 optionalDependencies。

## 核心能力与源码

| 能力               | 当前行为                                                                                                             | 主要源码                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 持续执行循环       | 流式增量、完整回复提交、工具校验/审批/执行/结算、继续下一步；一条回复不自动结束任务；生命周期钩子与子 Agent 委托     | src/runtime/engine.ts、src/runtime/hooks.ts                                |
| 输入与恢复         | start/steer/enqueue、会话内幂等、持久 inbox、取消、超时、崩溃恢复；显式 resume 接回未应用输入                        | src/core/kernel.ts、src/storage/store.ts                                   |
| 文本模型           | 自行实现 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的 HTTP/SSE、工具参数、图像输入和公开推理状态 | src/providers/                                                             |
| 路由管理           | 自定义地址/模型/凭据引用、参数、工具范围、媒体路由、权限；批量原子更新、默认值切换与持久化                           | src/core/config.ts、src/core/kernel.ts                                     |
| 图片/视频扩展      | 统一请求/任务/产物，注册适配器、字段映射、源码插件；幂等、轮询、取消、未知状态恢复、原路由快照                       | src/media/manager.ts、src/media/adapters.ts                                |
| 权限               | 宿主/项目规则/主模型/实际模型/模式/扩展取交集，deny 优先；逐次审批、到期、取消，plan 禁止外部原生扩展执行            | src/core/permissions.ts                                                    |
| 模式与 Agent 定义  | 内置三种策略、自定义模式、工具范围与能力策略；独立 Agent 指令/路由/Skill/步数/记忆空间                               | src/modes/、src/core/agents.ts                                             |
| 固定团队协作       | 用户配置成员模型与职责，协调者统一沟通、优化职责、派工、汇总；共享工作区、只读讨论、运行和费用限制                   | src/collaboration/、src/api/collaboration.ts                               |
| 工具与集成注册     | 可撤销工具工厂、重复名称/能力校验、准备阶段取消、集成生命周期与 HTTP 扩展点                                          | src/runtime/registry.ts                                                    |
| 文件与命令         | 相对项目路径读取/搜索/原子写入/精确编辑、Git、实际子进程；native、可选 Docker、可选 Windows AppContainer 后端        | src/tools/index.ts、src/execution/                                         |
| 附件资产           | 任意字节上传下载、项目归属、SHA-256、总输入预算、共享摘要预算；文本提取与可注入解析器                                | src/storage/assets.ts、src/runtime/extractors.ts                           |
| 上下文管理         | 保留近期完整工具组、分层模型总结、缓存、原始历史保留、工具声明预算、可注册模型计数器与精度标记                       | src/core/context.ts、src/runtime/token-counter.ts                          |
| 记忆               | 中文/英文全文搜索、命名空间/有效期、修订冲突、历史、合并/导入/清理；可选 embedding 与混合检索                        | src/storage/memory.ts                                                      |
| 自动记忆提案       | 自动提取仅产生待审核提案；人工批准后入库；plan 或 memory.write=deny 时不提取                                         | src/core/kernel.ts、src/storage/memory.ts                                  |
| Skill              | YAML 元数据、版本、文本/二进制资源、允许目录快照、哈希、启停、按需加载/读取；资源脚本不会自动执行                    | src/extensions/skills.ts                                                   |
| 源码 Plugin        | 完整源码树校验、信任撤销、单次只读校验快照、worker 二次验哈希、子进程与输出/时间/堆限制                              | src/extensions/plugins/manager.ts、src/extensions/plugins/source-bundle.ts |
| MCP                | 自维护 JSON-RPC、stdio、Streamable HTTP JSON/SSE、协商/会话/分页/取消/进度/通知/重连、工具/资源/提示词               | src/extensions/mcp/client.ts、src/extensions/mcp/manager.ts                |
| 项目与会话         | SQLite 追加式消息、旧数据迁移、分页、归档、分叉、导入/导出；工具效果日志与 pending 输入独立保存                      | src/storage/store.ts、src/sessions/codec.ts                                |
| 会话引用与思考配置 | 显式授权同项目会话读取，分叉保留来源；子 Agent 开关与独立模型思考配置                                                | src/sessions/tools.ts、src/providers/reasoning.ts                          |
| 网页工具           | 有界网页抓取、可读文本与资产；搜索提供商注册、网络地址过滤、代理与额外 CA                                            | src/web/client.ts                                                          |
| 服务器插件         | 显式注册的服务器档案、外部主密钥加密凭据、严格 SSH 指纹、远程命令/SFTP 与服务器事实                                  | src/servers/                                                               |
| 客户端协议         | HTTP JSON、带游标 SSE、背压与有界积压、GET 断线恢复、错误类型、独立 fetch 客户端与 CLI                               | src/api/server.ts、src/api/events.ts、src/client.ts                        |

默认上下文计数是明确标记的 UTF-8 保守估算，并不是所有厂商模型的精确 tokenizer。需要精确计数时，由宿主注册与实际模型对应的 TokenCounter。模型压缩可能丢失细节，原始会话和效果日志保留供追溯。

未知工具效果保留 unknown；恢复不会自动重放可能已经写入、发出或计费的操作。取消不配合 AbortSignal 的扩展只会停止等待，不能撤销已发生的外部效果。

## 嵌入内核或接客户端

```typescript
import { Kernel, loadConfig, serve } from "@local/agent-foundation";
const kernel = new Kernel(await loadConfig("config.json"));
// 在 init 前注册你维护的工具、解析器、计数器或宿主集成。
const api = await serve(kernel);
console.log(api.url);
// 关闭：await api.close();
```

网页或 Electron 渲染层可单独引用客户端入口，它只使用 fetch、Blob、ReadableStream 等通用 API，不导入 Node 内核。令牌由宿主传给可信客户端，不放进模型上下文。

```typescript
import { FoundationClient } from "@local/agent-foundation/client";
const client = new FoundationClient(baseUrl, hostToken);
const project = await client.project("项目");
const session = await client.session(project.id, "code");
const asset = await client.upload(project.id, file.name, file);
const { runId } = await client.submit(session.id, {
  text: "读取附件，完成修改并验证",
  assetIds: [asset.id],
  clientMessageId: crypto.randomUUID(),
});
for await (const event of client.events(runId)) consume(event);
```

file、baseUrl、hostToken 和 consume 由接入端提供。UI 可以立即显示 assistant.message.delta，在 assistant.message.committed 提交一条回复；工具与后续回复仍继续。只有 run.completed 表示本次运行结算。跨源网页地址需加入 server.allowedOrigins。当前是单用户可信宿主机架构，不是多租户隔离服务。

## 可选应用工具

应用包由本工程维护源码，独立入口在 `src/host/applications.ts`，公共导出为 `@local/agent-foundation/host`。支持仅 browser、computer 或 office，并复用底座工具/权限/会话/资产/事件。电脑原生适配器当前仅支持 Windows；未实现 Linux/macOS 原生控制。

```powershell
npm ci --ignore-scripts
npm run browser:install
npm run build:host
node dist/cli.js serve --host desktop
```

也可改用 `--host browser`、`--host computer`、`--host office`。这不会创建客户端 UI。用户浏览器扩展仍需用户在浏览器内逐标签页授权。工具、配置、HTTP/fetch 接口、测试与具体未实现项见 [APPLICATIONS.md](docs/APPLICATIONS.md)。

## 验收与边界

```powershell
npm run verify
pwsh -NoProfile -File scripts/package-source.ps1
pwsh -NoProfile -File scripts/verify-source-package.ps1
```

verify 执行核心构建、源码依赖检查、核心集成测试、核心生产依赖审计、编译产物冒烟与逐项验收证据检查。报告为 `verification/report.json`、`verification/core-acceptance.json` 和日志。仅明确登记的可选服务器测试可因缺少 `ssh2` 跳过，并记录为未验证，不算通过；其他核心跳过、失败或不完整日志使验收失败。源码包重建会在全新目录执行 npm ci --omit=optional、构建、全部核心测试与冒烟，并校验源文件哈希；报告为 `verification/clean-source-rebuild.json`。源码 ZIP 是维护者的重建验证材料，接入端的交付形式以 SDK 说明为准。

回归使用本地协议服务验证三种文本线协议；插件、MCP 进程、文件、命令、SQLite 和 HTTP 实际执行。测试服务仅存在于 test/，生产代码没有固定模型回复或伪造产物分支。测试结论不等于真实付费模型质量或全部第三方服务互操作保证。

当前单独列出的外部验证：真实文本/图片/视频/embedding 供应商、第三方 MCP/OAuth、Docker、POSIX PTY 和跨 OS 实机迁移。UI 与 ESP32 继续暂缓；已有应用插件以独立宿主验收清单为准。默认 native exec/MCP/Plugin 具有宿主用户权限；显式 Windows AppContainer 后端的隔离、拒绝与清理已实测。隔离 PTY、旧版 Node 子管道、复杂 EXE/DLL 工具链以及非 Windows 原生沙箱的限制单列，不能把已测的 Node 工作负载当作全部工具已适配。

逐项清单见 [CORE-ACCEPTANCE.json](docs/CORE-ACCEPTANCE.json)，接口见 [API.md](docs/API.md)，扩展契约见 [EXTENSIONS.md](docs/EXTENSIONS.md)，媒体扩展见 [MEDIA-ADAPTERS.md](docs/MEDIA-ADAPTERS.md)，来源边界见 [SOURCE-BOUNDARY.md](docs/SOURCE-BOUNDARY.md)。

## 0.4.0 源码对照与补强

0.4.0 固定 pi、Codex、OpenClaw 的提交快照进行对照，详见 [CORE-AUDIT.md](docs/CORE-AUDIT.md) 与 [参考快照](docs/AUDIT-REFERENCES.json)。新增 33 项核心回归，逐项状态由真实验收日志生成；未实现能力另列在 CORE-ACCEPTANCE.json，不计入通过项。

新增与修复包括自动记忆权限和备用模型过滤、审批后的撤销复核、授权扩展不能降级原始权限、Git 检查的 exec 权限、MCP 工具撤销与初始化取消、备用模型上下文重算、供应商上下文超限后的单次压缩重试、工具间 steering、重复结果循环停止、工具输出归档、资产摘要核对、单写入内核租约、插件重装修复，以及模型参数和命令输出的持续增量。

一个数据目录只能由一个存活的 Kernel 使用。租约在 SQLite 事务中获取；正常关闭释放，原进程死亡后可恢复。升级时先停止旧版本进程；不同主机共享目录不支持自动抢占。

安全配置发生行为变化：git_inspect 需要 exec 权限；等待审批时新增 deny 仍生效；没有声明能力的宿主执行工具继承 exec 检查。媒体源码插件必须提供 mediaCapabilities，旧版媒体插件需更新 manifest、重装并重新复核源码哈希。0.4.0 采用顺序工具执行；0.5.0 的受信任声明工具可并行，steer 可跳过未开始的批次工具；已开始的外部效果仍需按实际状态核对。

新增 limits.maxRepeatedToolResults（默认 6，0 关闭）和 limits.maxSearchEntries（默认 3000）。重复检测比较同工具、参数和结果，在新用户输入后重置；它是有界防循环策略，无法自动判定所有任务的语义进度。

## 0.5.0 执行底座补齐

新增可重连持久进程、真实 Windows ConPTY、统一进程工具/客户端审批入口、Kernel 级并行工具调度、资源锁，以及按 run/session/project/UTC 日/总额执行的 USD 预留账本。覆盖主模型、回退、压缩、记忆提取、embedding 和媒体；未知费用保留待核对，历史价格快照不随路由改变。

Docker 是可选命令隔离后端，默认 native，无需 Docker 即可使用底座。本机 Windows 管道与 ConPTY 已运行测试；Docker engine 和 POSIX 平台分别列为待验收。强制隔离时不回退原生，也不执行缺少隔离后端的源码 Plugin/MCP stdio。

配置、API、源码位置、真实测试和未实现项详见 [执行与预算说明](docs/CORE-EXECUTION.md)。版本状态以实际 verification 报告为准。

## 0.6.0 MCP 与资产迁移

新增现代/旧版 MCP 协议分支、MRTR、经确认的 sampling/elicitation、roots、资源订阅、required 异步 task、补全与日志，以及源码 OAuth PKCE/加密凭据/刷新。补齐可选 Plugin 与 MCP stdio Docker 宿主；默认仍为 native，缺失 Docker 不影响普通使用。新增包含实际引用附件字节、哈希、ID 映射、回滚与重启恢复的会话迁移包。

配置、API、支持的协议子集与未完成项目见 [CORE-INTEROPERABILITY.md](docs/CORE-INTEROPERABILITY.md)。本轮新增回归数量以 CORE-AUDIT-PLAN.json 为准；Docker 容器运行和外部平台联调不计为已验收。

## 0.7.0 工具采样与动态注册

新增显式启用的 sampling.tools，覆盖三种文本协议、服务端实际工具执行与工具结果续接；旧版异步任务的关联 sampling/elicitation 支持初始 RPC 结束后的反向回调、HTTP 任意流归属、进度、取消与 TTL。OAuth 增加显式 RFC 7591 动态注册、加密客户端凭据、并发去重和结果未知时的持久防重试。具体配置、API、本地验收与仍未实现能力见 [CORE-MCP-OAUTH.md](docs/CORE-MCP-OAUTH.md)。Docker 继续可选，真实供应商与环境受限联调另列。

## 0.8.0 客户端任务与 CIMD

补齐旧版客户端异步 sampling/elicitation 任务接收、现代 io.modelcontextprotocol/tasks 的轮询/输入更新/订阅/取消，以及 Client ID Metadata Documents 与非对称客户端 JWT。持久化、连接/服务绑定、原运行预算与确认、任务结果校验及实际 HTTPS 测试见 [CORE-TASKS-CIMD.md](docs/CORE-TASKS-CIMD.md)。默认 native；Docker 可选。

## 0.9.0 OAuth 生命周期

新增设备授权 RFC 8628、RFC 7592 远端注册 GET/PUT/DELETE、独立加密管理凭据与未知结果恢复，以及 CIMD private_key_jwt 托管多密钥自动轮换。设备流支持回调缺省、轮询退避、跨重启与取消；签名钥先发布再启用，保留旧公钥并清理旧私钥。源码、API、实际 HTTP/HTTPS 测试及明确未实现项见 [CORE-OAUTH-LIFECYCLE.md](docs/CORE-OAUTH-LIFECYCLE.md)。Docker 仍可选，应用 UI/办公/电脑控制/ESP32 仍不在本轮范围。

## 0.10.0 浏览器、电脑控制与办公底层

增加独立应用包、真实浏览器网络代理/元素引用、显式配对的用户浏览器桥接、Windows 窗口/控件/键鼠/截图桥接、串行独占租约与紧急停止，以及资源有界的 Office 格式工作线程、源结构保留编辑、PDF 合成和预览。核心资产写入支持取消，避免部分产物发布。旧 office-worker 和 mammoth 已删除。

`npm run verify:host` 执行宿主构建、真实应用集成、可选依赖审计和编译宿主冒烟；报告是 `verification/application-report.json`。源码包可分别进行最小内核和完整可选宿主的全新目录重建。支持范围与未完成项请以 [应用说明](docs/APPLICATIONS.md) 和 [验收计划](docs/APPLICATIONS-PLAN.json) 为准，不以“所有未来功能全部完成”概括。

## 0.12.0 执行循环与协作能力

本轮继续增加可选多 Agent 团队：用户先选各成员模型并填写职责，协调 Agent 优化整组职责、复用现有成员并承担统一沟通；宽职责可覆盖测试等相关工作，真实职责阻碍才暂停等待用户选择。支持同配置子代理开关、独立思考配置、共享工作区派工、任务与讨论模式、来源可追溯的会话分叉和显式跨会话引用。详见 [COLLABORATION.md](docs/COLLABORATION.md)。另有可选 [服务器连接插件](docs/SERVERS.md)，通过 `npm start -- --servers` 启用，提供服务器档案、外部主密钥加密凭据、SSH/SFTP 和服务器事实；默认启动不连接远端。当前交付为内核与 API，配置界面仍未开发。

参考 Claude Code 与 pi 的公开设计，在自有源码中补齐通用 Agent 底座常用的能力，均不引入外部框架或 SDK：

- **模型请求重试**：未流出内容的 408/409/429/5xx/529 与连接失败按指数退避重试，遵循 `Retry-After`；先走回退链，链尾原地重试；路由级 `retry` 配置，事件 `model.retry`。
- **Anthropic 提示缓存**：默认在工具声明、系统提示与最近两条用户侧消息放置缓存断点（最多 4 个），路由级 `promptCache: false` 关闭。
- **生命周期钩子**：`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`；可通过集成 `hooks`、`kernel.addHooks()` 或配置 `hooks` 命令（Claude Code 兼容的 stdin JSON/退出码协议）接入。钩子只能拒绝、改写（重新校验并仍受权限约束）、注释或要求继续，不能放行。
- **网页抓取与搜索**：内置 `web_fetch`（HTML 转可读文本、分页、GBK、gzip，二进制存为资产）与可插拔 `web_search`（Tavily、Brave、SearXNG 或自定义）；支持 HTTP 代理与 CONNECT、`NO_PROXY`、额外根证书；默认拦截私有网络，直连在连接时校验地址。详见 [CORE-WEB.md](docs/CORE-WEB.md)。
- **子 Agent**：内置 `agent_delegate` 与 `agent_result`，同模式/同路由/同自主级别的全新上下文子会话；可并行、可后台运行后再取结果、可级联取消；委托层数由 `limits.maxAgentDepth` 配置（默认 1），等待期间不占工具槽位。
- **结构化输出**：提交时附 `outputSchema`，模型通过 `submit_result` 提交并按 Schema 校验，不合格会修正重试，结果存于运行记录 `output`。
- **截断续写**：没有工具调用的回复因输出上限被截断时自动续写（`limits.maxOutputContinuations`，默认 3）。
- **文件检查点与回滚**：`file_write`/`file_patch` 写前自动快照；`POST /v1/sessions/{id}/rewind` 恢复文件并以分叉方式回退对话，外部改动视为冲突、默认不覆盖。
- **代码检索**：`file_search` 支持正则、忽略大小写、glob 过滤并遵守 `.gitignore`；新增 `file_glob`。

配置、协议、安全规则与测试范围见 [CORE-AGENT-LOOP.md](docs/CORE-AGENT-LOOP.md)。当前版本登记和验收范围见 [RELEASE.md](docs/RELEASE.md)，通过数量与时间以实际生成的同版本报告为准。
