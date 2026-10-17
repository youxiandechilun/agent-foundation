# 单用户 Agent 内核与可选系统隔离 · 0.11.0

本轮目标是可以被 Electron、网页宿主或其他程序嵌入的单用户 Agent 内核。继续维护模型循环、工具调度、权限、路由、上下文、会话、附件、记忆、扩展协议、执行与恢复。多租户、账户注册、业务登录、企业组织管理、SSO 和分布式执行集群不属于当前产品目标。已有浏览器、电脑控制、办公工具以可选应用包保留；本轮没有增加 UI，也不开发 ESP32。

## 登录、授权和沙箱分别解决什么

内核不需要用户先注册、登录一个账户。进程内使用 `new Kernel(config)`；使用 HTTP 时，可信客户端带独立的宿主 Bearer token，防止别的网页或本机进程随意调用管理接口。宿主 token 不进入模型上下文，也不代替模型的工具审批。

OAuth 在这里仅用于访问需要第三方授权的 HTTP MCP 服务。例如一个外部服务要求用户授权后才能访问，内核可按该 MCP 声明执行 PKCE、设备授权或注册流程。没有配置任何 OAuth MCP 时，不构造 OAuth 服务、不创建凭据目录、不触发授权请求。现有 OAuth 源码保留为显式启用的协议能力，不继续扩展成业务身份系统。未配置的服务器调用授权接口返回明确错误。

工具权限决定“这次操作是否允许执行”；OS 文件沙箱决定“获准启动的程序可以访问哪些文件”；网络沙箱决定“该程序能否建立网络连接”。仅把命令的 cwd 设置在项目里，不能阻止程序读取用户的其他文件；工具审批本身也不能阻止一个获准执行的程序启动其他进程。因此系统隔离值得作为底座的可选执行后端保留。

## 执行配置与实际支持

| 后端                         | 当前支持                                   | 文件与网络边界                                                                                       | 本机验证                                                            |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `native`，默认               | 单次命令、持久管道、Windows ConPTY         | 当前宿主用户权限；审批与路径校验不构成 OS 沙箱                                                       | 实际进程和终端测试                                                  |
| `windows-appcontainer`，可选 | 单次命令、持久管道、源码 Plugin、MCP stdio | 每次独立 AppContainer token、临时 package SID 文件授权、网络 capability；Job Object 约束进程树和资源 | 当前 Windows 主机实际运行、拒绝访问、取消、退出、崩溃、重启恢复测试 |
| `docker`，可选               | 已有命令、Plugin、MCP stdio 容器宿主源码   | 非 root、只读根、显式挂载、默认无网络、资源限制                                                      | 本机没有 Docker engine；真实容器验收独立列出                        |

Windows AppContainer 的 PTY 组合未实现可用的终端 I/O，本版明确拒绝 `pty: true`，返回 `isolation_feature_unavailable`，不回退 native。原生 ConPTY 仍可使用，但不具有 AppContainer 文件和网络隔离。Linux/macOS 原生文件、网络沙箱未实现；POSIX PTY 源码已有，实机联调仍独立列出。

Docker 不需要安装。默认核心构建、模型调用、会话、路由、上下文、记忆和 native 执行都可以独立运行。只有显式选择 Docker 才调用它，也不会自动安装或拉取镜像。

以下配置片段用于合并到完整的模型/工作区配置中。项目目录应与 dataDir 分开。它只启用执行隔离，不会配置供应商或创建 UI：

```json
{
  "dataDir": ".agent-data",
  "workspaceRoots": ["workspace"],
  "execution": {
    "boundary": "windows-appcontainer",
    "requireIsolation": true,
    "workspaceReadOnly": false,
    "memoryMb": 512,
    "cpus": 1,
    "pidsLimit": 128,
    "windowsSandbox": {
      "network": "none",
      "readOnlyRoots": [],
      "maxRuntimeBytes": 268435456
    }
  },
  "extensions": {
    "executionBoundary": "windows-appcontainer",
    "timeoutMs": 30000
  }
}
```

执行与扩展后端独立选择；`requireIsolation: true` 时，未选择隔离的源码 Plugin/MCP stdio 在启动前拒绝。远程 HTTP MCP 是外部服务，内核不能给远端进程增加本机 OS 沙箱。宿主自己注册的 TypeScript 集成属于可信内核代码。

`POST /v1/execution/probe` 实际启动一个受限进程并检查 token/输出/清理证据，才返回可用。`GET /v1/capabilities` 展示配置、单用户边界、平台支持、尚需探测的状态和明确不支持的 PTY；配置出现在能力表不代表探测已经通过。

## Windows 后端如何工作

宿主从 `src/execution/native/AppContainerHost.cs` 使用 Windows 自带 .NET Framework `csc.exe` 编译助手，缓存文件名包含源码哈希。未启用此后端时不调用编译器；缺少系统支持或编译失败直接报错。

每次调用复制所选 EXE 到私有只读 runtime，单独建立 scratch。只向该次随机 profile 的 package SID 授权审核过的项目/只读依赖目录；禁止授予整个盘、包含内核数据的目录或覆盖 dataDir 的祖先。不对盘根和用户目录增加祖先读取权限，不创建 Everyone 授权，不修改全局防火墙。新增源码没有 Agent、模型、MCP 或 PTY SDK。

助手以 suspended 状态创建 AppContainer 子进程，加入 Job Object，读取实际 token，确认 AppContainer 标记和 package SID 相同后才恢复运行。句柄继承限于 stdin/stdout/stderr。Job 对子孙进程施加进程数、内存和 CPU 限制，并配置最后句柄关闭时终止整棵进程树。实际进程数限制测试包含继承和 detached 子进程；内存/CPU 参数接入了系统 Job API，但不宣称完成所有应用负载下的压力验收。

网络默认 `none`，不赋予网络 capability。`internet` 是显式启用的广泛互联网访问，不是按域名的细粒度白名单；仍受 Windows AppContainer 对 loopback/私有网络的限制。不创建系统 loopback 例外。项目中已有 junction 指向外部私有目录时，实际访问仍被系统拒绝，且外部目录 ACL 不变。

本机另行对同一个公网 TCP 端点做了正反对照：宿主可达，`none` 收到系统 `EACCES`，`internet` 实际可连接，两个 profile 都确认清理。证据在 `verification/windows-sandbox-network.json`。复现命令为 `npm run test:windows-network`；它只建立 TCP 连接，不发送模型请求、凭据或 HTTP 内容。该测试显式依赖公网环境，不加入普通离线核心回归；公网不可达时记录 environment-unavailable 并返回非零。

只读项目由 OS 拒绝写入。可写项目允许修改其中的子文件，但不授予替换授权根的 Delete 权限。插件审核快照和 worker 源码分别只读授权，worker 再次核对哈希。MCP roots 只能声明已挂载的审核工作区，Windows 返回真实 file URI，Docker 才映射到 `/workspace`。

只转发显式声明的扩展环境变量，另有 Windows 启动所需的最少系统字段。秘密不放入命令行参数或 manifest；含环境变量的单次请求在启动子进程前删除。AppContainer 仍能访问 Windows 本身授权给应用容器的系统资源；它不是一个屏蔽全部系统路径的虚拟机，也不能防御同一用户下的恶意可信宿主或 OS 漏洞。

## 进程与清理的确认

正常退出、取消、超时和终止都会关闭受限 Job、等待实际活动进程归零、撤销本次 SID 授权、删除 profile/runtime/请求文件，并持久写入 `cleanupConfirmed`。不确定清理不能当作成功。MCP 关闭的清理错误向上传播并记录为 error，避免显示为正常断开。

助手监测真实父进程的存活句柄。Windows libuv 默认在 Node 退出时先杀死其普通子进程，因此受信任的助手独立于该 libuv Job 启动，留出撤销 ACL 的机会；受限任务仍在助手创建的 Job 中。助手自身被强杀时，Job 最后句柄关闭会结束任务；下次 Kernel 初始化扫描私有 journal，回收残留。它用 PID 与创建时间识别仍存活的助手，保留独立持久 broker 的有效执行，不凭陈旧 PID 重放或终止未知程序。

Kernel 拥有共享 `commands` 服务和 Plugin 调用生命周期。正常关闭时取消并等待自己的命令、插件和隔离清理，然后才释放 Store 与单写入租约。`processShutdown=preserve` 的持久进程由 broker 继续管理，重启连接到原进程，不重新执行命令。

## 当前 Node 兼容性限制

本机 Node 22.23.2 所带 libuv 在 AppContainer 内创建普通子进程 stdio/IPC 管道时会卡住。已用真实调用重现，并核对 Node/libuv 的上游问题和修复。源码预加载 `node-appcontainer-guard.cjs` 对旧 libuv 明确拒绝这类调用，错误为 `ERR_SANDBOX_RUNTIME_UNSUPPORTED`；继承标准流、ignore 和已有文件描述符可用，子孙进程继续受 OS 隔离。

这个预加载文件只是兼容保护，不是沙箱；不修改用户安装的 Node，也不把 JavaScript 包装冒充系统安全。新的运行时即使版本包含上游修复，也需要实际探测。npm、语言服务、构建器等大量依赖子管道的软件，不能据此认定已在 AppContainer 下全面可用。

Node 加载器会读取盘根/父目录的 realpath 元数据。为避免扩大祖先目录权限，仅在私有 Node runtime 设置 `--preserve-symlinks --preserve-symlinks-main`，这会改变符号链接模块的去重/解析语义。选定 EXE 只复制自身；依赖相邻 DLL、外部运行时和源码包的程序需由宿主显式提供只读依赖目录或选择其他后端。本轮主要实际运行 Node 工作负载，不承诺所有任意 EXE 都能直接搬进私有目录运行。

## 验收方式与后续范围

本轮新增 Windows 系统隔离、生命周期、单用户/OAuth 惰性加载和 MCP 清理回归。最终通过数量以 `verification/report.json` 与 `core-acceptance.json` 为准；每项都关联实际测试标题。全新源码包验证重新 npm ci、构建、跑核心测试和冒烟，比较源码哈希；可选应用宿主另行重建回归。

后续有明确边界的内核工作包括：隔离 PTY、更多语言/构建运行时的 AppContainer 兼容、Linux/macOS 原生隔离后端、精确模型计数器注册与供应商实测。真实文本/图片/视频/embedding 模型、第三方 MCP/OAuth、真实 Docker 和跨 OS 实机迁移单列。业务登录、多租户、企业身份管理和分布式集群已移出当前目标，不再作为“底座还欠的模块”堆叠。

实现依据为微软 [AppContainer 隔离说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[profile 创建 API](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[进程快照父进程字段](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w)，以及 [Node AppContainer 管道问题](https://github.com/nodejs/node/issues/66374)、[libuv 进程宿主实现](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)。这些资料解释平台机制；本工程测试记录用于证明本机实际行为。
