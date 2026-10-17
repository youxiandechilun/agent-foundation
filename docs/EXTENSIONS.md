# 扩展与源码接口 · 0.11.0

内核提供三种用户扩展：Skill（指令和资源）、Plugin（经信任的原生源码）、MCP（外部标准服务）。宿主开发者还可直接注册工具、解析器、计数器和生命周期集成。扩展不会自行绕过统一权限。

当前目标是单用户可嵌入内核。OAuth 仅在 MCP 明确声明需要外部授权时启用，不作为业务登录；没有配置时不构造 OAuth 服务。Plugin 与 MCP stdio 可独立选择 native、可选 Docker 或可选 Windows AppContainer。强制隔离禁止 native；Windows 的实际源码、只读快照、网络限制、清理与当前 Node/PTY 兼容边界见 [CORE-FOUNDATION.md](CORE-FOUNDATION.md)。Kernel 关闭会排空自己启动的命令与源码 Plugin；MCP 的清理错误会传播，不报告为成功断开。

## Skill：指令、版本与资源

```markdown
---
name: source-review
description: 根据实际文件进行代码审核
version: 1.0.0
capabilities:
  - files.read
---

读取真实项目文件，说明证据和位置。需要时读取 references/checklist.txt。
```

POST /v1/skills 接收：

```json
{
  "source": "---\nname: source-review\ndescription: 根据实际文件审核\n---\n读取 references/checklist.txt。",
  "resources": {
    "references/checklist.txt": "核对错误处理与权限边界",
    "assets/data.bin": { "encoding": "base64", "data": "AAEC" }
  }
}
```

也可传 {directory:"允许目录下的绝对路径"}，目录含 SKILL.md。安装会读取所有资源为持久快照，之后修改原文件不会改变已安装版本；支持 UTF-8 与二进制，记录哈希/字节数/版本。单 SKILL.md 最大 128 KB，资源 bundle 有总量/数量限制，拒绝路径逃逸、重复/大小写碰撞、符号链接及不安全文件。

capabilities 是声明信息，不授予权限。安装后的 Skill 可启停/删除、导出、显式 skillIds 选择，或由 skill_load 按需读取正文。skill_resource_read 读取文本，二进制资源归档为实际资产。scripts 下的文件只作为资源保存，不在安装、选择或读取时自动执行；要执行需交给明确受控的工具/插件。

## 源码 Plugin

JSON 安装 {manifest,files}，或从 extensions.allowedRoots 内的目录安装。目录的 plugin.json 用 files 列出需要的源码。示例：

```json
{
  "schemaVersion": 1,
  "id": "project_note",
  "name": "Project note",
  "version": "1.0.0",
  "entry": "index.mjs",
  "envRefs": {},
  "mediaAdapters": [],
  "tools": [
    {
      "name": "read_note",
      "description": "读取项目说明",
      "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "risk": "read",
      "capabilities": ["files.read"]
    }
  ]
}
```

```javascript
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function execute(name, args, context) {
  if (name !== "read_note") throw Error("Unknown tool");
  return {
    content: [
      {
        type: "text",
        text: await readFile(
          path.join(context.projectRoot, "NOTE.txt"),
          "utf8",
        ),
      },
    ],
  };
}
```

初装 disabled，启用传 {enabled:true,trustedHash:installed.hash}。源码变化需重新复核。执行时不是只检查数据库中的 hash：它重新读取完整安装树，拒绝新增/删除/修改文件，失配后禁用并撤销信任。实际调用使用由已验证字节生成的单次快照，worker 在 import 前再次校验每个文件哈希；调用后清理快照。

工具名 plugin_{pluginId}_{toolName}，最多 64 字符。context 含 projectId/projectRoot/pluginId；返回 ToolResult 或可转成文本的 JSON。每次调用独立进程，无跨调用全局状态保证。媒体扩展可导出 mediaAdapters，详见 MEDIA-ADAPTERS.md。

envRefs 的键是子进程变量名，值是宿主变量名；默认仅保留必要系统路径。源码包最多 200 文件、4 MiB，禁止逃逸、符号链接、原生二进制和自带 node_modules。时间、堆大小、stdout/stderr 和结果均有界；取消会终止进程树。

默认 native 模式是可信原生代码进程，不是 OS 沙箱。0.6.0 可单独选择 extensions.executionBoundary=docker，具体只读挂载、环境与网络限制见 CORE-INTEROPERABILITY.md。经批准的插件内部可以使用 Node 宿主权限；工具能力声明不能隔离恶意代码内部行为。MCP stdio 也有同一执行边界。计划模式禁止运行这些外部原生扩展，即便它们自称只读。

## 自维护 MCP 客户端

src/extensions/mcp-client.ts 自行实现 JSON-RPC 与传输，不依赖官方 MCP SDK，也不通过其他 Agent CLI 转发。按 MCP 生命周期与 Streamable HTTP 规范维护：

- stdio：argv 启动、环境引用、UTF-8 换行帧、消息/缓冲上限、请求关联、取消、进程树清理。
- 旧版 HTTP：JSON 或 SSE 响应、会话/协议请求头、GET 通知流、事件 ID 恢复、禁止重定向。
- 旧版 initialize/initialized 协商；支持 2025-11-25、2025-06-18、2025-03-26，stdio 还接受 2024-11-05。
- 工具、资源、资源模板、提示词目录；分页游标循环检测；tools/call、resources/read、prompts/get。
- 服务端 ping、进度回调、取消通知、有界通知历史、请求超时与关闭竞争处理。

0.6.0 新增现代 server/discover / MRTR / POST 订阅流，旧版仍走上述生命周期；不可将两种传输规则混用。roots、elicitation、经单次确认的 sampling、required 工具 task、订阅、completion、日志和预注册 OAuth PKCE 已有源码实现。具体配置、能力声明、宿主确认 API、测试边界和未支持 profile 见 [CORE-INTEROPERABILITY.md](CORE-INTEROPERABILITY.md)。未启用或未支持的反向能力明确拒绝。

stdio 配置：

```json
{
  "id": "local_files",
  "name": "项目文件",
  "transport": "stdio",
  "command": "node",
  "args": [
    "E:/agent-foundation/examples/mcp-filesystem.mjs",
    "E:/allowed/project"
  ],
  "envRefs": {},
  "enabled": true,
  "toolAllowlist": ["read_text", "list"],
  "timeoutMs": 30000,
  "maxMessageBytes": 8388608
}
```

HTTP 配置：

```json
{
  "id": "remote_files",
  "name": "远端 MCP",
  "transport": "http",
  "url": "http://127.0.0.1:4320/mcp",
  "headerEnvRefs": { "Authorization": "MCP_HTTP_AUTH" },
  "enabled": true,
  "toolAllowlist": ["*"]
}
```

MCP_HTTP_AUTH 的值是完整 Bearer 头，仅在本机设置。示例服务 examples/mcp-filesystem.mjs 和 examples/mcp-http-filesystem.mjs 也以源码实现，用真实文件读写验证互操作，不需要 MCP SDK。

HTTP 会话过期的当前操作失败并保留不确定效果，不能自动重新 POST；显式重新连接后才能发新操作。SSE 断流可用 Last-Event-ID 进行 GET 恢复。没有事件 ID 或服务端不支持恢复时明确失败，不能以重新提交工具掩盖丢失结果。旧独立 SSE transport 不属于当前协议。

工具名 mcp_{serverId}_{toolName}，按 execute 风险并附加 mcp 能力执行。远端 readOnlyHint 等 annotations 仅作为元数据，不降低宿主权限。MCP 的 prompts/resources 是不可信内容，不自动获得系统指令优先级。

参考：[传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[取消](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)。

## 宿主源码注册点

通过 kernel.toolRegistry.register(packId,factory) 注册自有工具，返回撤销函数。factory 接收 kernel/runId/session/routeId/signal；每条工具提供 name/description/parameters/risk/capabilities/execute。未声明风险按 execute 处理。撤销后已经解析出的旧工具闭包也拒绝再次执行。

```typescript
const revoke = kernel.toolRegistry.register("my-tools", async (context) => [
  {
    name: "my_probe",
    description: "读取维护者提供的实际数据",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    capabilities: ["files.read"],
    execute: async (_callId, _args, signal) => {
      signal?.throwIfAborted();
      return {
        content: [
          {
            type: "text",
            text: await readOwnedData(context.session.projectId),
          },
        ],
      };
    },
  },
]);
```

readOwnedData 是宿主实现；注册入口不会替开发者自动施加 OS 文件隔离。内置文件工具提供项目路径边界，宿主自有工具应实现其实际作用域。

kernel.assets.extractors.register 注册 AssetExtractor；kernel.context.counters.register 注册 TokenCounter。计数器输入含 route/messages/tools，返回整数并标记 exact 或 estimate，必须匹配实际模型。route.tokenCounterId 指向注册 ID，不存在则运行明确失败。默认 UTF-8 估算不冒充精确计数，分层压缩内部的分块仍采用保守估算。

KernelIntegration 可注入 install/tools/authorize/handle/handlePublic/upgrade/settled/close。handlePublic 和 upgrade 是需要维护者自行鉴权的宿主扩展点，不能把敏感管理操作无条件暴露。通过 new Kernel(config,{integrations:[...]}) 显式装配；默认空集成。

后期办公格式、浏览器、桌面控制应实现为上述边界的应用插件。当前保留 src/host/desktop.ts 作为可选集成参考，最小构建不加载；这不表示已交付产品化插件市场或全部应用工具。

## 0.4.0 扩展约束

MCP 已解析工具在断开、替换连接或收到 tools/list_changed 后失效，需要重新解析目录；旧闭包不能调用新服务器。初始化期间 disconnect 会撤销未完成连接。

宿主工具未声明能力时，execute/write/network/control 分别推导 exec/files.write/network/computer；read 不推导写权限。声明不代替 OS 隔离，宿主开发者仍需为实际行为实现作用域。

authorize 集成只能增加约束：原工具能力取并集、风险不能降低，工具身份和执行函数保持原值。传入参数与安全元数据为冻结副本；新增 deny 在审批完成后再次检查。

settled(runId, signal) 有限时边界（最多 2 秒，或更小的 extensions.timeoutMs）；错误和超时记录为 integration.settlement.failed。close 错误不会跳过其他资源与数据目录租约释放。

插件每次重装创建独立安装目录，即使哈希相同也不会继承旧目录中的额外文件；启用信任须重新复核。GET /v1/plugins/{id}/export 可导出实际校验过的源码。

媒体插件 manifest 需显式声明 mediaCapabilities，例如：

```json
{
  "mediaAdapters": ["vendor_video"],
  "mediaCapabilities": {
    "vendor_video": {
      "kinds": ["video"],
      "operations": ["generate"],
      "polling": true,
      "cancellation": false,
      "recovery": true
    }
  }
}
```

声明 polling/cancellation/recovery 的方法需要实际实现。不同插件不能占用同一个媒体适配器 ID；程序内注册也检查已声明取消/恢复方法的存在。0.3.0 只有 mediaAdapters 字符串列表的旧媒体插件需补声明后重装；不会默认宣称支持全部操作。

## 0.5.0 调度与媒体费用扩展

ToolDefinition.scheduling.parallelSafe 由受信任宿主声明；resources(args) 返回 key/access 读写锁。默认工具全局排他，不采用 MCP 或插件的 readOnlyHint 自动放开并行。ModelRequest 与可嵌入低层 Provider 接口仍可单独使用；Kernel 是统一权限/预算边界，宿主直接调用低层传输时应自行提供相应治理。

MediaAdapter 的 AdapterResult 可返回 billing:{actualUsd,reference}，由已复核适配器翻译真实厂商数据；没有用量时保留未知费用。CostLedger 提供 reserve/settleUsage/settleMedia/reconcile/withScope；不能从模型任意返回文字推断实付金额。强制隔离禁止 native 扩展；0.6.0 可以显式选择 Plugin/MCP stdio 的 Docker 宿主，真实容器验收单独列出。

0.7.0 sampling.tools、旧版异步任务关联反向输入及 OAuth 动态客户端注册均为本仓库维护的源码实现，无新增 SDK。配置、权限、测试证据和未实现项见 [CORE-MCP-OAUTH.md](CORE-MCP-OAUTH.md)。

## 0.8.0 客户端任务与 CIMD

补齐旧版客户端异步 sampling/elicitation 任务接收、现代 io.modelcontextprotocol/tasks 的轮询/输入更新/订阅/取消，以及 Client ID Metadata Documents 与非对称客户端 JWT。持久化、连接/服务绑定、原运行预算与确认、任务结果校验及实际 HTTPS 测试见 [CORE-TASKS-CIMD.md](CORE-TASKS-CIMD.md)。默认 native；Docker 可选。

## 0.9.0 OAuth 生命周期

新增设备授权 RFC 8628、RFC 7592 远端注册 GET/PUT/DELETE、独立加密管理凭据与未知结果恢复，以及 CIMD private_key_jwt 托管多密钥自动轮换。设备流支持回调缺省、轮询退避、跨重启与取消；签名钥先发布再启用，保留旧公钥并清理旧私钥。源码、API、实际 HTTP/HTTPS 测试及明确未实现项见 [CORE-OAUTH-LIFECYCLE.md](CORE-OAUTH-LIFECYCLE.md)。Docker 仍可选，应用 UI/办公/电脑控制/ESP32 仍不在本轮范围。
