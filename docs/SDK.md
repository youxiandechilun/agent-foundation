# SDK 安装、组合与交付

SDK 以标准 ESM npm 压缩包交付，供 Node.js、Electron 主进程或本地后端调用。发行包包含编译后的 JavaScript、TypeScript 声明、必要运行辅助文件与接入资料，使用方不需要工程的 TypeScript 实现、开发工具链或测试目录。JavaScript 保持正常可读；不采用字节码、混淆或特定 Node 补丁版本绑定。

## 维护目录与使用方边界

```text
agent-foundation/
├─ src/                    内核维护源码，SDK 安装包不附此目录
│  ├─ index.ts              Node 内核公开入口
│  ├─ client.ts             独立 HTTP/SSE 客户端
│  └─ 其他模块              完整职责与阅读顺序见 ARCHITECTURE.md
├─ extensions/              独立扩展资料，如用户浏览器桥接
├─ examples/sdk/            仅使用公开包入口的接入示例
├─ docs/                    当前契约、范围与接入说明
├─ scripts/release/         SDK 打包和独立消费者验收
├─ test/                    工程测试，SDK 安装包不附此目录
├─ dist/                    编译产物及保持原层级的运行资源
├─ verification/            实际执行证据，不装入 SDK
└─ releases/<版本>/         本地交付包、清单与 SHA256
```

完整源码结构和维护边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。0.12.1 将内核、API、存储、会话、工具与可选应用按职责归拢，SDK 的三个公开入口及现有协议保持稳定。拆分文件和类型明确化可能增加导入与声明行数，重复逻辑和无用代码的精简另行按实际结果说明，不以文件移动宣称运行性能提升。

当前包名为 `@local/agent-foundation`，版本由根 `package.json` 统一管理。包保持 `private: true`、`UNLICENSED`；授权条款尚未确定。本地打包和验证均不发布到 npm 或 GitHub，也不代表已授予商用或再分发许可。

0.13.0 修正宿主计费的对账投递、异常缓存计量和授权响应丢失处理。升级时，宿主按 `charge.id` 与必填的 `outcome.revision` 幂等处理，并为 `void` 保留终态记录；生成 `BillingOutcome` 的 TypeScript 使用方需要补充版本号。`CostLedger.drain()` 现在返回投递状态，可用 `deliveryStatus()` 查询未确认工作；业务费用是否待核仍由宿主账本判定。

0.13.1 修正 Responses 流式文本的归属与完成快照校验：文本按输出项及内容块索引合并，核对 item ID，完成快照补齐缺失后缀且不重复输出。同一文本块的矛盾内容仍会中止运行。此修复不改变计费契约，也不会自动重发模型请求或重结历史 `unknown` 账单。

0.14.0 增加可显式开启的模型步骤自动恢复。部分输出后遇到明确的网络中断或供应商请求超时，内核可以在同一 run 中重新生成当前模型步骤，保留此前完整消息及工具结果。默认关闭；配置、计费与事件边界见下文。

## 运行要求

- Node.js `^22.19.0 || >=24.0.0`，使用 ESM。支持 Node 22 维护线的 22.19 及以后版本，以及 Node 24 及以后版本；不声明支持已停止维护的 Node 23。内核使用 `node:sqlite`，部分早期 Node 23 默认不提供该模块。建议使用仍在维护的 Node.js LTS；新主版本仍需先完成验证。
- 声明面向 TypeScript 的 `NodeNext` 模块解析。消费者开发时安装与目标运行环境对应的 `@types/node`，无需安装底座的 TypeScript 实现。
- 核心依赖自动随 npm 安装解析；浏览器、办公格式和 SSH 等依赖保留为可选项。仅使用核心时可以省略这些依赖。
- 命令工具使用宿主已经安装的命令行程序。SDK 不捆绑 Git、Python、PowerShell、浏览器可执行文件或操作系统隔离环境。
- Windows 已有本地执行验证。Linux/macOS 的具体 PTY 和桌面能力验收范围见项目验证材料，不能由 SDK 打包通过推定。

`verification/sdk-consumer.json` 记录本次真正运行的 Node 版本。未安装的精确最低版本不会标记为“已验证”。

## 从本地发行包安装

在交付目录找到实际的 `.tgz` 文件；名称、版本和 SHA256 以同目录 `manifest.json` 与 `SHA256SUMS.txt` 为准。安装示例：

```powershell
npm install --omit=optional C:\delivery\local-agent-foundation-0.14.0.tgz
npm install --save-dev typescript @types/node
```

如果已经使用工程自己的 TypeScript 配置和 Node 类型，则沿用它们。首次离线安装还需要 npm 缓存或内网镜像提供核心依赖，单个 `.tgz` 不等于包含 Node 和所有第三方依赖的离线安装器。

包有三个公开入口：

| 入口                             | 用途                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `@local/agent-foundation`        | `Kernel`、配置、Agent、团队、扩展注册与服务入口等                           |
| `@local/agent-foundation/client` | `FoundationClient` HTTP/SSE 客户端，可在支持 fetch 的环境调用已经运行的服务 |
| `@local/agent-foundation/host`   | 显式启用浏览器、桌面、Office 等可选宿主集成                                 |

请使用公开导出，避免依赖 `dist` 内部文件路径；内部目录可以随维护调整。

可选的 `SecurityAudit`、规则类型、`KernelOptions.securityAuditRules` 和 `FoundationClient.securityAudits` 也通过现有入口提供。审计默认关闭，启用方式、业务规则示例和覆盖边界见 [SECURITY-AUDIT.md](SECURITY-AUDIT.md)。源码更新不会自动改写之前已生成的 SDK 压缩包。

## 最小嵌入调用

下面的模型地址只是本机兼容服务示例，应替换为真实可用的供应商配置：

```javascript
import { Kernel, parseConfig } from "@local/agent-foundation";

const config = parseConfig({
  dataDir: "./data/assistant",
  workspaceRoots: ["./workspace"],
  defaultRoutes: { chat: "text", code: "text", office: "text" },
  routes: {
    text: {
      kind: "text",
      adapter: "openai-completions",
      model: "YOUR_MODEL_ID",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  },
});
const kernel = new Kernel(config);
try {
  await kernel.init();
  kernel.agents.put({
    id: "developer",
    name: "开发与验证",
    mode: "code",
    routeId: "text",
    instructions: "根据需求实现，运行必要测试，说明结果与限制。",
    toolAllowlist: [
      "file_list",
      "file_read",
      "file_search",
      "file_glob",
      "file_write",
      "file_patch",
      "exec_run",
      "git_inspect",
      "plan_update",
    ],
  });
  const project = await kernel.createProject("示例项目");
  const session = kernel.createSession(
    project.id,
    "code",
    "开发",
    undefined,
    "developer",
  );
  const { runId } = await kernel.submit(session.id, {
    text: "阅读项目并给出实现建议。",
  });
  const run = await kernel.wait(runId);
  console.log(run.status);
} finally {
  await kernel.close();
}
```

权限默认值仍然生效。允许模型执行命令时，上层系统需要接收和解决审批请求，或在自己的明确授权范围内设置相应策略。提示词和工具白名单不能越过运行时权限。`toolAllowlist` 支持精确名称或整体 `"*"`，不支持 `file_*` 等前缀匹配。

HTTP/SSE 方式可以通过 `serve(kernel, token)` 启动，再使用 `FoundationClient`。CLI 安装后提供 `agent-foundation serve --config <配置文件>`；`config.example.json` 随包交付，实际密钥和本机配置不进入发行包。

完整示例随包位于 `examples/sdk/`。复制到调用方项目，先配置自己的模型地址和可用工作区，再执行：

```powershell
node embedded.mjs C:\my-agent\config.json "阅读项目并给出建议"
node team-service.mjs C:\my-agent\config.json code
# 另一个终端中设置 AGENT_API_TOKEN，再使用服务输出的会话 ID
node http-client.mjs <会话ID> "根据已确认需求完成工作"
```

`embedded.mjs` 展示单 Agent 只读调用。`team-service.mjs` 创建“协调、规划、执行”三个可配置角色，仅启动服务、不自动提交工作；`SDK_COORDINATOR_ROUTE`、`SDK_PLANNER_ROUTE`、`SDK_EXECUTOR_ROUTE` 环境变量选择配置中已经存在的文本模型路由，未设置时使用当前模式的默认路由。将 `code` 改为 `office` 可创建办公团队；办公文件格式操作还需显式安装对应宿主集成。`http-client.mjs` 展示用户始终向同一个会话提交需求与读取事件，审批由接入端处理。`kind: "brainstorm"` 的只读讨论设置、细分职责和会话分支接入见 [COLLABORATION.md](COLLABORATION.md)。

## 以配置组合不同 Agent

上层系统保存自己的模型路由、角色定义、权限和扩展清单，再调用 SDK 即可；不需要修改内核实现。

| 配置积木       | SDK 接入位置                                                            | 作用                               |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| 模型与思考投入 | `parseConfig({ routes, defaultRoutes })`、Agent 的 `routeId` 和思考参数 | 各角色可选不同的兼容模型服务       |
| 职责系统提示词 | `kernel.agents.put({ instructions, ... })`                              | 定义角色任务边界和输出要求         |
| 工具范围       | Agent 的 `toolAllowlist`、宿主权限与策略                                | 组合只读、编辑、执行等能力         |
| Skill          | `kernel.skills`、Agent 的 `skillIds`                                    | 复用领域知识与处理流程             |
| 工具插件       | `kernel.plugins.install(...)`、`enable(...)`                            | 以独立插件补充业务工具             |
| MCP            | `kernel.mcp` 的注册管理接口                                             | 连接已实现的外部工具服务           |
| 自定义宿主集成 | `new Kernel(config, { integrations })`                                  | 注册工具、生命周期钩子和管理接口   |
| 多 Agent 团队  | `kernel.teams.put(...)`、`configure(...)`                               | 配置协调者、成员和任务或讨论模式   |
| 记忆与会话     | Agent 的 `memoryNamespace`、会话 API                                    | 组织角色信息、分支与显式跨会话读取 |

团队职责允许“规划＋执行”这样的粗分，协调者复用既有成员承担测试等必要工作。用户主动细分时保留其边界，不自动增加成员。相关状态及语义限制见 [COLLABORATION.md](COLLABORATION.md)。

扩展的配置格式、可信来源、哈希确认及启用方式以 [EXTENSIONS.md](EXTENSIONS.md) 为准。服务器档案、加密凭据和 SSH/SFTP 的可选集成见 [SERVERS.md](SERVERS.md)。

已有模型协议、工具与扩展足够时，配置可以完成组合。新增业务系统接口通常需要编写独立 Plugin、MCP 服务或宿主集成；这部分代码位于调用方或扩展中，内核可以保持不变。私有且不兼容的模型协议需要兼容网关或相应适配。SDK 是单用户可信宿主内核，多租户身份和账号隔离由上层系统实现。

## 模型请求重试与步骤恢复

文本路由的 `retry` 处理尚未产生输出的瞬态失败：默认最多重试 2 次，初始等待 1 秒，指数退避并加入随机抖动，等待不超过 30 秒；首次请求不计入重试次数。408、409、429、500、502、503、504、529 等临时状态可进入该策略；明确的凭据、参数、额度耗尽、协议或消费回调错误不重试。供应商请求已产生输出后，路由不会直接重发或回退到其他路由。

需要处理中途断流的宿主可以显式设置：

```javascript
const config = parseConfig({
  // routes、defaultRoutes 等沿用宿主配置
  limits: {
    modelRecovery: {
      maxRetries: 3,
      initialDelayMs: 2000,
      maxDelayMs: 20000,
      maxElapsedMs: 300000,
    },
  },
});
```

`limits.modelRecovery` 默认 `{ maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 10000, maxElapsedMs: 90000 }`。`maxRetries` 是单个 run 累计恢复上限；`maxElapsedMs` 是当前逻辑模型步骤从首次可恢复失败开始的恢复窗口，包含等待与重新请求耗时。等待按指数增长并受 `maxDelayMs` 限制；恢复窗口、原 run 总时限和取消信号共同约束在途请求。未输出的失败仍只走路由策略，不叠加步骤恢复次数。

步骤恢复仅接受已开始输出、且明确标记为 `network`、`timeout` 或 `stream_interrupted` 的供应商故障。内核丢弃本次未完成草稿、工具参数和供应商延续状态，使用新的 `messageId` 从已提交上下文重新生成当前步骤；此前完成的工具批次不会由恢复机制重跑。存在状态不确定的写工具效果或已启动供应商原生搜索时停止恢复。语义矛盾、协议损坏、宿主增量回调异常、凭据或额度错误、预算不足、取消与总时限不会作为网络故障反复重试。对于启用恢复且符合条件的故障，次数或窗口耗尽后也不会将截断草稿提交到会话。

每次真实请求继续通过原路由与 `CostLedger`，产生独立费用 ID；前一次 `unknown` 费用保留占用并等待业务对账，不能因重连成功而清零。预算不足时停止。恢复在工具调度前进行，并不提供跨供应商、跨调用 ID 的通用 exactly-once 保证，也不等同于进程重启后自动续跑。

根入口公开 `ProviderError`、`ProviderFailureReason` 和 `canRecoverProviderError`，供自定义协议明确分类。宿主不得仅按 HTTP 502 或异常文字推断部分输出可安全恢复。事件及前端草稿处理见 [API.md](API.md) 的输入与运行部分。

## 每个 Kernel 的文本协议

根入口公开 `TextProtocolRegistry` 与 `TextProtocol`。注册协议后，先用同一 registry 校验配置，再传入 Kernel；以下为接入片段，`customProtocol` 是宿主实现的 `TextProtocol`：

```typescript
import { Kernel, TextProtocolRegistry, loadConfig, parseConfig } from "@local/agent-foundation";

const protocols = new TextProtocolRegistry();
const unregister = protocols.register(customProtocol);
const config = await loadConfig("./config.json", protocols);
// 内存配置的对应形式：parseConfig(input, baseDir, protocols)
const kernel = new Kernel(config, { textProtocols: protocols });
unregister(); // 只改变原 registry；已构造的 kernel 保留自己的注册表快照。
await kernel.init();
// 宿主退出时：await kernel.close()
```

`parseConfig(input, baseDir?, protocols?)` 的 registry 是第三参数，`loadConfig(file, protocols?)` 是第二参数。每个 registry 自带内置协议，内置 ID 及保留的媒体/embedding ID 不能被覆盖。不同 Kernel 可以在各自 registry 中使用相同的自定义 ID；Kernel 构造时复制注册表，之后注销原 registry 的条目不会改变该 Kernel。运行时路由更新、持久化路由恢复、文本请求、上下文压缩、MCP sampling 和计费 token 语义都使用所属实例的协议。

普通对象通过 `register(protocol)` 注册时，复制其自有声明字段与静态 headers，方法的 `this` 绑定到冻结快照，保留自有 helper 与额外字段。既有类实例注册继续保留原实例接收者，兼容私有字段和原型方法；该兼容路径的实例状态仍由宿主管理。需要每个 Kernel 独立的类实例或可变闭包时，使用 `registerFactory(id, factory)`；每次注册表克隆和 Kernel 装配都由工厂创建新实例。工厂必须返回新对象，需要隔离的闭包状态也应在工厂内部创建；注册表无法自动复制任意外部对象。既有 `registerTextProtocol()` 与 `textProtocolIds()` 保留进程级默认注册方式；未指定 `textProtocols` 的 Kernel 在构造时取得该默认表的快照。自定义协议应在解析配置和构造 Kernel 之前注册。

宿主扩展可选择 `KernelIntegration.serviceTools` / `ToolRegistry.registerServices()`，使用公开的 `ServiceToolContext` 与只读 `KernelServices` 门面，减少对完整 Kernel 的依赖；旧 `tools` 与 `context.kernel` 继续支持。`install(kernel, signal?)` 的可选信号在安装超时或内核关闭时中止；安装时限复用 `extensions.timeoutMs`。工具取消后仍未结束的实际 Promise 会继续持有调度槽与资源锁，工具实现应让其 Promise 覆盖实际 I/O 与清理的完整生命周期。记忆异步准备、流式导出及新增容量配置见 [后续优化说明](OPTIMIZATION-FOLLOWUP-20261023.md)。

`kernel.memory.pruneExpiredAsync(projectId, { batchSize?, signal? })` 提供在线分批清理；`kernel.memory.semanticSearchWithStats(...)` 保持精确评分并返回扫描诊断；`kernel.store.storageStats(signal?)` / `client.storageStats(signal?)` 显式统计持久数据容量。`MCPClientOptions.maxTaskSnapshotBytes` 默认 64 MiB，约束现代任务结果及预留；达到容量会在新工具请求发送前拒绝，关闭后释放快照。完整边界与兼容验证见 [审查问题修复与容量优化](OPTIMIZATION-COMPLETION-20261023.md)。

## 计费投递与容量

`BillingProvider.record(charge, outcome, signal?)` 增加可选取消信号，既有两参数实现仍可使用。根入口导出 `BillingDeliveryOptions`，通过 Kernel 选项配置：

```typescript
const kernel = new Kernel(config, {
  billing,
  billingDelivery: {
    concurrency: 8,
    timeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
  },
});
```

以上也是默认值，针对结果投递 `record`，不限制授权回调 `authorize`。待投递结果保存在 SQLite，最多按并发数取出执行，同一 `charge.id` 顺序投递。`BillingOutcome.revision` 是单笔费用的持久递增版本：首次为 1，新结果（包括普通文本的人工对账）递增，失败重投及重启恢复保持原版本。宿主应在同一事务中按 `charge.id` 校验账户和费用归属，只接受高于已应用版本的结果；相同版本重复请求返回已有确认，较旧版本不得覆盖新结果。内核将费用状态、投递版本和待投递记录放在同一事务中保存。

`BillingOutcome` 的 `responseId` 为可用的供应商响应标识，`reason` 说明待核或作废原因。`tokens.input` 不含缓存 token；OpenAI 等包含缓存的输入口径必须满足 `cacheRead + cacheWrite <= input`，所有分类计数必须为非负安全整数。异常原始用量保留在费用记录中，向宿主投递 `unknown` 且省略 `tokens`；有价格和无价格路由均执行该检查。无价格路由若提供了有效用量，宿主仍可按 `settled` 和规范化 token 自行定价。

授权回调抛错（包括宿主已经预占但响应丢失）或在回调完成前取消时，供应商请求尚未发出，因此费用为 `void`，内核仍持久投递结果，供宿主释放可能存在的预占。取消会等待授权 Promise 返回后再报告；如果内核关闭时授权还未结束，则保留 `authorizing` 状态，重启恢复为 `void` 后投递。宿主必须将同一 `charge.id` 的授权与结果更新串行化或使用数据库事务，并保留 `void` 终态幂等记录：较晚到达的授权不得重新预占。这也覆盖跨进程重启仍在网络中传输的旧授权请求。SDK 不会重新调用同一笔费用的 `authorize`；业务重试产生新的费用 ID。

超时发出取消信号并记录失败；如果回调忽略信号，在它真正结束前保留槽位，避免超时重叠导致无限并发。`await kernel.costs.drain(timeoutMs?)` 返回 `BillingDeliveryStatus`，也可调用 `kernel.costs.deliveryStatus()` 查询：`pending` 为尚未确认的授权或待投递结果数，`failed` 为最近投递失败或超时的费用数，`active` 为仍在执行的结果回调数（包含忽略取消的回调）。三项均为 0 才表示当前投递全部确认；`drain()` 返回本身不代表成功，失败结果在重启恢复时重投。已确认的 `unknown` 仍需业务对账，不能仅根据投递完成就删除需要对账的持久数据。查询应在 `Kernel.close()` 之前执行。

关闭最多等待 `shutdownTimeoutMs` 的投递收尾并取消剩余投递，尚未完成的状态可在重启后恢复。这个时限只限定内核等待，不会强制停止宿主 I/O，也不是整个 `Kernel.close()` 的总时限。

`limits` 另外提供媒体并发/队列字节与迁移并发约束。媒体默认同时执行 2 个、额外等待 16 个，运行中与等待任务的序列化元数据共用 4 MiB 预算；迁移默认同时 1 个操作。`kernel.exportMigration(sessionId, signal?)` 可取消异步附件读取；迁移仍返回完整的 v1 包对象。默认值、内存口径及取消边界见 [容量与效率](CAPACITY-OPTIMIZATION.md)。

## 宿主集成生命周期

每个 Kernel 应独立创建有状态的 application/server 集成。应用集成重复安装到同一 Kernel 会复用安装结果，安装到另一个 Kernel 会拒绝；第二个实例的初始化失败与关闭不能关闭第一个实例持有的服务。集成已关闭后不再允许安装，重复注册同名应用服务会明确失败。`KernelIntegration.close(kernel?: Kernel)` 接收发起关闭的所属实例，已有无参实现兼容；自定义有状态集成也应遵守所有权和幂等关闭约束。

浏览器 context 意外关闭、连接断开和主动关闭共用幂等清理，释放会话、profile 占用、网络资源与监听器；清理完成后才允许复用占用的 profile。CDP 接入外部浏览器时仅断开本集成连接，保留原浏览器与用户标签页。Office 提取器随所属集成注销。宿主相关工具与 HTTP 路由契约保持不变，实际平台依赖见 [APPLICATIONS.md](APPLICATIONS.md)。

## 打包与本地验收

维护者在工程根运行：

```powershell
npm run pack:sdk
$env:SDK_NODE_BINARIES = '["C:\\Program Files\\nodejs\\node.exe","G:\\nvm\\v24.15.0\\node.exe"]'
npm run verify:sdk
```

不设置矩阵变量时使用当前 Node；也可以使用 `npm run verify:sdk -- --package <绝对路径.tgz> --node <绝对路径node.exe>`。变量中的路径仅是本机示例，调用方应使用实际安装路径。验证不会下载或切换全局 Node。

`pack:sdk` 安全清理当前工程的 `dist` 后执行完整宿主构建，只将白名单文件写入 `releases/<版本>/`。文件包括 npm tarball、清单和 SHA256；不附开发源码目录、源码映射、本机配置、运行数据、日志或测试。

`verify:sdk` 将 tarball 复制到独立消费者目录，通过 npm 离线安装核心依赖，省略可选依赖和安装脚本。随后检查三入口导入、严格类型编译、真实本地 HTTP/SSE 模型协议与文件写入、源码插件 worker、持久进程工具、CLI 启动、CSV worker 和缺失可选 DOCX 依赖的错误提示。验证使用本地协议服务，未调用收费模型或远端服务器。

报告分别写入 `verification/sdk-package.json` 和 `verification/sdk-consumer.json`。消费者位于系统临时目录下独立的 `agent-foundation-sdk-<本次编号>/`，具体路径记录在报告中，安装日志与执行证据一并保留；目录不在源码工程内，避免沿父目录意外读取工程的开发依赖。仅“打包成功”不能代替消费者运行验证；真实供应商、远端服务器、Docker 及未安装的平台运行时不在此次收尾验收范围。
