# 源码与依赖边界 · 0.12.1

本文说明维护源码和第三方依赖的边界；当前版本范围及证据规则以 [RELEASE.md](RELEASE.md) 为准。下方带版本号的小节保留对应版本的实施背景，不作为当前功能总表。

执行内核、模型协议、MCP 客户端、权限、上下文、路由、会话、记忆、Skill/Plugin 管理由本工程维护的源代码实现。既不固定使用 pi-agent-core，也不运行其他产品的 CLI、编译内核或代理 SDK。MCP SDK 已从依赖和锁文件移除，协议传输实现见 src/extensions/mcp/client.ts。

“自己的源码”指这些模块可以在本工程直接阅读、修改、构建和测试；不表示 TypeScript、Node、通用开源依赖或参考项目的版权转归本工程。也不以批量改名作为实现完成的依据。

## 参考项目与实现对应

| 公开项目/资料                                                                                                                                                                    | 参考的机制                                         | 本工程实现                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| [pi](https://github.com/earendil-works/pi)                                                                                                                                       | 简洁循环、回复后继续工具、输入队列、中止           | runtime/engine.ts 与自有消息/工具契约；当前无 pi 源码包或依赖 |
| [Codex](https://github.com/openai/codex)                                                                                                                                         | 任务/步骤/消息生命周期、服务接入、审批、可观察执行 | HTTP/SSE、效果日志、持久输入、权限交集、命令 runner           |
| [OpenClaw](https://github.com/openclaw/openclaw)                                                                                                                                 | 多入口和通用工具扩展、媒体任务                     | 自有宿主接口、工具/媒体注册机制；设备工作按用户要求暂缓       |
| [ZCode](https://github.com/zai-org/ZCode)                                                                                                                                        | 模式、模型配置、附件、工具与回复交替               | 模式注册、路由配置、资产输入、持续事件流                      |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)                                                                                                              | 工具流水线、插件、事件与会话                       | 源码插件生命周期、工具 registry、持久运行效果                 |
| [Hermes Agent/Desktop](https://github.com/NousResearch/hermes-agent)                                                                                                             | 通用助手、长期记忆、客户端与工具分离               | 记忆全文/向量/混合检索、提案审核、独立内核服务                |
| Claude Code 产品行为与公开扩展资料                                                                                                                                               | 项目指令、工作中汇报、持续执行、压缩               | 项目指令、模型总结与自己的循环；未使用所谓泄露的专有源码      |
| OpenAI / Anthropic 官方 API                                                                                                                                                      | 三种线协议、工具调用、图像输入与公开推理状态       | 自行实现 HTTP 请求、SSE 和序列化，不依赖模型 SDK              |
| [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 与[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) | JSON-RPC、stdio、Streamable HTTP、版本/会话/取消   | 自维护源码客户端和管理器；没有 MCP SDK 运行依赖               |

这是设计参考与当前实现位置的对应表，不表示上述产品完整内核、沙箱、UI 或所有特性被移植。当前 MCP 支持的能力以 EXTENSIONS.md 为准，未声明的可选协议能力不算完成。

## 第三方库

默认核心运行依赖：Ajv（JSON Schema 验证）、TypeBox（schema 构建）、Zod（管理接口与配置验证）、YAML（Skill 元数据）。Node 内置模块提供 HTTP、fetch、进程和 SQLite。开发依赖是 TypeScript、Prettier 和类型声明。

可选应用集成依赖：Playwright、ws、docx、ExcelJS、pdfjs-dist、PptxGenJS、pdf-lib、JSZip、xmldom、canvas。服务器集成另使用可选 `ssh2` transport。它们只在显式启用对应集成时使用。旧的 mammoth 依赖与简单 office-worker 已删除。当前并未把这些通用库改写成项目私有实现。

npm run verify:source 检查生产源码中的禁止框架引用、锁文件内 Agent/模型/MCP SDK、生产 fixture 分支，并为源码、配置、文档、脚本与示例生成 SHA-256 清单。它是可复查的构建检查，不是代码原创性或法律权属证明。

## 验证范围

核心测试验证真实 HTTP/SQLite/文件/进程与本地协议交互。真实付费供应商质量、第三方 MCP 生态全面互操作、跨平台全部主机环境不由这些测试自动证明。

默认 native 命令、MCP stdio 和可信源码 Plugin 不属于 OS 沙箱。0.11.0 新增源码维护的可选 Windows AppContainer 后端，覆盖命令、持久管道和扩展的实际隔离/拒绝/清理；隔离 PTY 与旧 Node 子管道限制明确列出。Docker 仍是可选边界，本机缺少 engine，未宣称容器环境验收通过。浏览器/办公/Windows 电脑控制作为可选源码应用包单独验收；UI 与 ESP32 暂缓。

## 0.5.0 系统接口与可选隔离

持久进程 broker、调度器和成本账本由工程源码维护。Windows ConPTY 采用 src/execution/native/ConPtyHost.cs 和系统 API，首次用系统 csc 编译；POSIX 采用 pty_host.py 与 Python 标准库。编译产物位于运行数据目录，不冒充本工程维护的系统编译器。核心没有新增 Agent、模型、MCP 或 PTY SDK 依赖。

Docker 是宿主选择的执行服务，不是默认运行依赖；没有在本机安装 Docker。其容器运行验收未通过环境前不能宣称沙箱已全面验证。0.6.0 已补齐 Plugin 与 MCP stdio 可选容器宿主；requireIsolation 禁止 native 路径。真实容器验收单独列项，详见 CORE-INTEROPERABILITY.md。

0.7.0 sampling.tools、旧版异步任务关联反向输入及 OAuth 动态客户端注册均为本仓库维护的源码实现，无新增 SDK。配置、权限、测试证据和未实现项见 [CORE-MCP-OAUTH.md](CORE-MCP-OAUTH.md)。

## 0.8.0 客户端任务与 CIMD

补齐旧版客户端异步 sampling/elicitation 任务接收、现代 io.modelcontextprotocol/tasks 的轮询/输入更新/订阅/取消，以及 Client ID Metadata Documents 与非对称客户端 JWT。持久化、连接/服务绑定、原运行预算与确认、任务结果校验及实际 HTTPS 测试见 [CORE-TASKS-CIMD.md](CORE-TASKS-CIMD.md)。默认 native；Docker 可选。

## 0.9.0 OAuth 生命周期

新增设备授权 RFC 8628、RFC 7592 远端注册 GET/PUT/DELETE、独立加密管理凭据与未知结果恢复，以及 CIMD private_key_jwt 托管多密钥自动轮换。设备流支持回调缺省、轮询退避、跨重启与取消；签名钥先发布再启用，保留旧公钥并清理旧私钥。源码、API、实际 HTTP/HTTPS 测试及明确未实现项见 [CORE-OAUTH-LIFECYCLE.md](CORE-OAUTH-LIFECYCLE.md)。Docker 仍可选，应用 UI/办公/电脑控制/ESP32 仍不在本轮范围。

## 0.10.0 应用底层

浏览器生命周期、IP 校验与鉴权网络代理、用户浏览器配对与任务桥接、Win32/UIA 原生 C#/PowerShell 源码、项目/run 独占租约和停止，以及 Office ZIP 校验/有界工作线程/DOM 编辑/资产协议由本工程维护。格式读写、浏览器驱动、PDF 与 Canvas 渲染使用有锁文件和原许可证的通用开源库。代码及本地实际验收见 [APPLICATIONS.md](APPLICATIONS.md)；不声称所有第三方库原创或用户已完成外部平台联调。
