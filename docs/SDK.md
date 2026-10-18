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
npm install --omit=optional C:\delivery\local-agent-foundation-0.12.1.tgz
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
