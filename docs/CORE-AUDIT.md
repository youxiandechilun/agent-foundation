# 底层 Agent 源码对照与修复审计 · 0.9.0

范围为 Agent 内核及其协议、权限、状态和扩展机制。UI、应用级办公/浏览器/电脑控制插件、ESP32 按用户要求暂缓。真实模型与供应商互操作单独列出。本文描述这一轮检查与修复，不作完整上游产品等价或“没有任何未来缺陷”的声明。

## 对照依据

2026-10-16 固定以下 GitHub 主分支提交，下载源码后进行机制对照。完整 URL、Git blob 和 SHA-256 见 [AUDIT-REFERENCES.json](AUDIT-REFERENCES.json)。第三方源码保存在调研目录，没有复制进本工程运行内核。

| 项目     | 固定提交                                 | 主要对照位置与机制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pi       | 4954d760504c11df9b2cbdc040346107b6a8153d | [agent-loop.ts](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/agent/src/agent-loop.ts)、[types.ts](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/agent/src/types.ts)：循环、完整消息/工具结果、输入队列、取消、执行模式与扩展契约                                                                                                                                                                          |
| Codex    | 6ae8b8aa7c608730d4315d59c5c081897ae02780 | [approvals.rs](https://github.com/openai/codex/blob/6ae8b8aa7c608730d4315d59c5c081897ae02780/codex-rs/core/src/tools/approvals.rs)、[compact.rs](https://github.com/openai/codex/blob/6ae8b8aa7c608730d4315d59c5c081897ae02780/codex-rs/core/src/compact.rs)：中央授权、具体操作绑定、上下文生命周期和错误边界                                                                                                                                                                                         |
| OpenClaw | bf1848705bd90ff1a33d5afe73bc60b0054d3061 | [before-tool-call policy](https://github.com/openclaw/openclaw/blob/bf1848705bd90ff1a33d5afe73bc60b0054d3061/src/agents/agent-tools.before-tool-call.policy.ts)、[conversation policy](https://github.com/openclaw/openclaw/blob/bf1848705bd90ff1a33d5afe73bc60b0054d3061/src/agents/conversation-tool-policy-pipeline.ts)、[command queue](https://github.com/openclaw/openclaw/blob/bf1848705bd90ff1a33d5afe73bc60b0054d3061/src/process/command-queue.ts)：有序权限层、工具准入、会话通道与超时结算 |

参考不是盲目复制。pi 的最小循环、Codex 的宿主执行边界与 OpenClaw 的 Gateway 各有不同职责；本工程采用单用户宿主、受信任声明的并行调度和显式扩展接口。

## 旧验收的真实遗漏

原始 0.3.0 源码包 SHA-256 为 `0F278CD9E0A7B608F052B8CD98F4D7242BA60E1D50240198B9877510FF37B3D5`。首次仅加入四个权限回归后，旧 56 项仍通过，新四项全部失败。基线日志为 `verification/audit-baseline.log`。这说明旧测试覆盖范围不足，不能从旧报告推导全部权限安全。

后续按问题分组保存修复前日志；这些是本轮中间状态的针对性复现，不冒充每次都重新测试了完全未修改的旧发行包。源码快照、测试、最终报告共同构成本轮证据。

## 发现与落地修复

| 类别               | 旧行为或缺口                                         | 当前实现与回归位置                                                                    |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 自动记忆权限       | 直接注入记忆，不检查 memory.read；ask 也会读         | 仅 allow 自动检索，host/route/project/Agent 范围参与判断；audit-permissions           |
| 备用模型的数据边界 | 主模型允许的自动记忆会流向拒绝读取记忆的备用模型     | 记忆成为独立、带能力需求的上下文块，实际模型逐次过滤；audit-runtime                   |
| 审批撤销           | 等待期间新增 deny，原审批仍执行                      | 审批后重新评估当前权限并核对参数摘要；audit-permissions                               |
| 授权扩展降级       | authorize 可清空原能力、降低风险                     | 原能力取并集、风险只升级、身份保留，参数与安全元数据冻结；audit-features              |
| 缺省能力声明       | 原生注册工具不声明 capabilities 时可能避开 exec 策略 | 根据执行风险推导缺省能力，未知声明拒绝；audit-features                                |
| Git 只读标签       | Git 外部 diff/其他辅助程序可在只读标签下运行         | git_inspect 要求 exec，另禁外部 diff/textconv/fsmonitor 等常见路径；audit-permissions |
| MCP 撤销           | 旧工具闭包可调用重新连接后的另一服务器               | 绑定连接与目录版本，断开/替换/list_changed 撤销；audit-permissions                    |
| MCP 初始化竞争     | disconnect 与初始化交错后可能重新 enabled            | 关闭未完成客户端并等连接结算，持久声明保持禁用；audit-features                        |
| 凭据脱敏           | JSON 转义及 effects.result 可留下已知凭据            | 对结构化字符串值及序列化结果脱敏，覆盖模型输入、消息、事件与效果；audit-runtime       |
| 会话额度           | maxSessionMessages 仅在开始时检查                    | 每步与完整工具组提交前检查，不再追加超限消息或再发模型请求；audit-runtime             |
| 备用模型窗口       | 按主模型准备后直接发给更小窗口模型                   | 实际路由重新计数/压缩，放不下明确失败；audit-runtime                                  |
| 供应商超限         | 估算与供应商不一致时直接中断                         | 已识别 context overflow 在无输出时只允许一次分层压缩重试；audit-features              |
| Responses 增量     | 工具参数到 item.done 才可见                          | added/delta/done 请求关联和即时参数事件；audit-runtime                                |
| steering           | 新指令到达仍执行批次中剩余工具                       | 工具间安全点跳过未开始的调用，补配对结果与 skipped 记录；audit-runtime                |
| 无进展循环         | 只依靠总步数和工具数                                 | 可配置同工具/参数/结果重复阈值，新输入重置；大结果按原始摘要检测；audit-features      |
| 数据目录归属       | 第二个进程启动会误恢复第一个活跃进程的记录           | SQLite 事务内核租约；活进程拒绝、死进程原子恢复；audit-storage                        |
| 输入准备           | 解析器悬挂时会话可改，关闭不能取消准备               | 输入控制器、信号、期限、会话忙检查；关闭等待准备结算；audit-data                      |
| 工具输出上限       | details 和外部工具可绕过文本上限                     | 统一验证块与结构，超大结果保存真实 JSON 资产，返回摘要/引用；audit-data               |
| 媒体伪完成         | 空对象、图像文字、他项目 assetId 可标 completed      | 校验输出来源、项目归属、规范 base64 和字节总额；audit-data                            |
| 媒体能力虚报       | 源码插件默认宣称全部操作/取消/恢复                   | manifest 显式 mediaCapabilities，方法与 ID 冲突校验；audit-extensions                 |
| 资产完整性         | 存储字节改变仍以旧摘要下载                           | 读/下载检查常规文件、大小与 SHA-256；audit-data                                       |
| Skill 运行中选择   | steer 输入的 skillIds 被记下却未传递正文             | 接收前验证选择，将真实指令加入持久输入；audit-features                                |
| 搜索工作量         | 主要计目录，没有限制实际文件遍历                     | 实际条目计数、信号检查、达到预算立即停止；audit-features                              |
| 注册撤销           | 旧撤销函数可能删掉后来同名注册                       | 检查注册实例身份，撤销不能影响替代项；audit-runtime                                   |
| 插件重装           | 同哈希目录多出的文件会一直残留                       | 独立安装目录、默认取消信任，可导出经过验证的源码；audit-extensions                    |
| 路由引用           | 删除可破坏模式与 Agent 模板引用                      | 删除前检查可复用定义；audit-extensions                                                |
| 记忆修订           | 删除后复用 ID 会覆盖最早修订，ID 可跨项目重用        | 从审计记录延续版本，保留原记录并禁止改项目归属；audit-data                            |
| 自动检索韧性       | embedding 失败阻断聊天，完整大记忆挤爆指令           | 有界摘录、按 ID 完整读取；自动检索回退全文并发降级事件；audit-data                    |
| 清理生命周期       | 初始化失败、settled 悬挂或 close 抛错可残留资源/租约 | 初始化失败清理、有界结算、错误聚合后仍清理其他资源；audit-extensions                  |
| 命令输出编码       | 多字节跨进程分片产生乱码                             | stdout/stderr 独立 UTF-8 StringDecoder；audit-extensions                              |

以上包含安全缺陷、功能缺口和韧性补强，不把它们统称为安全漏洞。对应实际测试标题、源码和最终状态见 [CORE-ACCEPTANCE.json](CORE-ACCEPTANCE.json) 及 `verification/core-acceptance.json`。

## 假实现检查结论的边界

生产模块没有测试用模型回复、固定图片/视频或把“未实现”直接返回成功的分支。测试协议服务和对抗场景在 test/。源码媒体插件缺失方法会明确失败，错误信息中的 not implemented 不是成功实现。

这轮确实修复了“空媒体也完成”和“能力全部默认 true”两类可造成虚假成功/能力声明的问题。有效 HTTP(S) 输出仍可能只是远端引用，未下载的引用不能当作已验证的媒体字节。run.completed 是运行生命周期结算，任务语义是否正确仍需实际结果证据，不能由框架统一保证。

## 对照后的差异和未完成项

| 项目                                                        | 当前状态                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| 三种文本协议、本地真实 HTTP/SQLite/文件/子进程/MCP 异常回归 | 由最终验收报告确认；测试不证明付费模型质量                        |
| 真实文本/图片/视频/embedding 供应商联调                     | 未运行，单独列项                                                  |
| 全部第三方 MCP 生态互操作                                   | 未穷尽；只声明已实现客户端能力                                    |
| MCP 可选能力与 OAuth                                        | 0.6.0 已实现声明的 profile；其余明确列于 CORE-INTEROPERABILITY.md |
| 并行工具调度、持久 PTY、后台交互进程 API                    | 0.5.0 已实现；Windows ConPTY 与本地持久进程已实测，POSIX 待验收   |
| 跨供应商美元成本预算与账单核对                              | 0.5.0 已实现 USD 预留、实际用量结算、未知费用和人工账单核对       |
| 厂商精确 tokenizer                                          | 没有通用内置实现；默认估算，可注册对应模型计数器                  |
| 原生进程 OS 沙箱、多租户与分布式 Gateway                    | 未实现；原生工具是可信宿主代码，管理接口是单用户权限              |
| Docker runner                                               | 源码存在，本机缺少 engine，未完成容器运行验收                     |
| UI、办公/浏览器/电脑控制产品插件、ESP32                     | 用户要求暂缓，本轮不开发、不计验收                                |

## 复查方法

运行 npm run verify，检查 `verification/report.json`、`verification/core-acceptance.json` 和 `verification/audit-report.json`。本轮新增 33 项回归纳入统一清单，总核心测试应由实际日志统计。源码包在新目录以 npm ci --omit=optional 重建并重跑核心测试，确认默认内核不需要办公/浏览器依赖。

升级前停止旧版进程。git_inspect 的 exec 要求和媒体插件 mediaCapabilities 是有意的接口收紧；旧媒体 manifest 需补声明后重装并重新复核。保留 0.3.0 的源码包摘要与修复前日志，避免用更新后的通过报告覆盖旧问题的复现事实。

## 0.5.0 执行底座专项

本轮在 0.4.0 的 89 项测试之上补充持久进程、PTY、并行调度、成本预算及隔离拒绝路径。新增专项数量由 CORE-AUDIT-PLAN.json 记录，最终总数由真实测试日志生成。详细实现和未完成边界见 [CORE-EXECUTION.md](CORE-EXECUTION.md)。此前 0.4.0 的 33 项修复仍保留在验收清单中；它们不计为本轮新测试。Docker 实际运行和 POSIX PTY 是外部待验收，不能与本机通过项混记。

## 0.6.0 互操作专项

在 0.5.0 的 119 项测试上补齐 MCP 现代/旧版能力、源码 OAuth、可选扩展容器宿主和实际资产迁移。本轮回归标题、源码位置和真实执行证据见 CORE-AUDIT-PLAN.json 与 verification/audit-report.json。进一步发现并修复嵌套 MCP sampling 丢失实际 fallback 模型权限的问题。具体边界和未完成模块见 [CORE-INTEROPERABILITY.md](CORE-INTEROPERABILITY.md)。

0.7.0 sampling.tools、旧版异步任务关联反向输入及 OAuth 动态客户端注册均为本仓库维护的源码实现，无新增 SDK。配置、权限、测试证据和未实现项见 [CORE-MCP-OAUTH.md](CORE-MCP-OAUTH.md)。

## 0.8.0 客户端任务与 CIMD

补齐旧版客户端异步 sampling/elicitation 任务接收、现代 io.modelcontextprotocol/tasks 的轮询/输入更新/订阅/取消，以及 Client ID Metadata Documents 与非对称客户端 JWT。持久化、连接/服务绑定、原运行预算与确认、任务结果校验及实际 HTTPS 测试见 [CORE-TASKS-CIMD.md](CORE-TASKS-CIMD.md)。默认 native；Docker 可选。

## 0.9.0 OAuth 生命周期

新增设备授权 RFC 8628、RFC 7592 远端注册 GET/PUT/DELETE、独立加密管理凭据与未知结果恢复，以及 CIMD private_key_jwt 托管多密钥自动轮换。设备流支持回调缺省、轮询退避、跨重启与取消；签名钥先发布再启用，保留旧公钥并清理旧私钥。源码、API、实际 HTTP/HTTPS 测试及明确未实现项见 [CORE-OAUTH-LIFECYCLE.md](CORE-OAUTH-LIFECYCLE.md)。Docker 仍可选，应用 UI/办公/电脑控制/ESP32 仍不在本轮范围。
