# 执行循环增强：重试、提示缓存、钩子、子 Agent、结构化输出、续写、回滚与检索

本轮参考 Claude Code（hooks、Task 子代理、请求重试、Anthropic 提示缓存）与 pi（可扩展事件钩子、steer/follow-up 队列）的公开设计，在本工程自有源码中实现，不引入任何 Agent 框架或模型 SDK。所有新能力均保持原有安全不变量：钩子只能收紧或注释，不能授予权限；子 Agent 不能越过父会话的模式、路由与自主级别。

## 1. 模型请求重试

| 项目     | 行为                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 可重试   | 尚未流出任何内容、且非上下文超限的 408/409/429/500/502/503/504/529 以及连接失败                                               |
| 不可重试 | 已开始流式输出（可能已产生可见内容或费用）、4xx 语义错误、上下文超限（走原有一次性压缩重试）                                  |
| 顺序     | 回退链中仍有可用路由时先回退；链上最后一条路由原地重试                                                                        |
| 等待     | 指数退避 `initialDelayMs * 2^n`，±25% 抖动，上限 `maxDelayMs`；服务端 `retry-after-ms`/`Retry-After` 优先，超过上限则直接报错 |
| 事件     | 每次重试发出 `model.retry { routeId, attempt, maxRetries, delayMs, status, error }`                                           |
| 计费     | 每次尝试都单独经过 CostLedger 预留/结算                                                                                       |

配置（每条路由，可省略）：

```json
"retry": { "maxRetries": 2, "initialDelayMs": 1000, "maxDelayMs": 30000 }
```

源码：`src/providers/text.ts`（`RouteRouter`、`retryDelay`）、`src/providers/sse.ts`（`retryAfter`、`TRANSIENT_STATUSES`）。

## 2. Anthropic 提示缓存

`anthropic-messages` 路由默认（`"promptCache": true`）在请求中放置最多 4 个 `cache_control: {"type":"ephemeral"}` 断点：最后一个工具声明、系统提示、最近两条用户侧消息（含 tool_result）的最后一个可缓存块。每步工具循环只需按增量计费读取前缀。

- 只复制被标记的块，不修改会话历史或 `providerState` 中回放的原始块。
- 跳过空文本块与 thinking 块。
- 设 `"promptCache": false` 关闭（例如兼容端点不支持该字段时）。
- 用量中的 `cache_read_input_tokens`/`cache_creation_input_tokens` 已由原有逻辑记入 `usage.cacheRead/cacheWrite` 并参与计价。

源码：`applyCacheBreakpoints`（`src/providers/text.ts`）。

## 3. 生命周期钩子

四个事件，与 Claude Code 命名一致：

| 事件               | 时机                                           | 可做                                                   |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------ |
| `UserPromptSubmit` | 每条用户输入（start/steer/enqueue/恢复）提交前 | 拒绝（不进入记录，inbox 标记 `rejected`）；追加上下文  |
| `PreToolUse`       | 参数校验后、权限检查/审批前                    | 拒绝；改写参数（重新按 schema 校验，仍走完整权限检查） |
| `PostToolUse`      | 工具成功且效果日志落盘后                       | 给模型追加注释（效果日志保存原始结果）                 |
| `Stop`             | 模型无工具调用且无排队输入、即将完成时         | 要求继续，原因作为 `<hook_feedback>` 发回模型          |

安全规则：

- 钩子**不能**放行：改写后的参数仍经过模式、路由、项目规则与审批的完整交集。
- 改写不能改变工具已加的调度资源锁（例如把读路径改到别处），否则拒绝。
- `PreToolUse` 抛错 = 拒绝（失败即关闭）；其它钩子抛错只发 `hook.failed` 事件并继续。
- `Stop` 继续次数受 `hooks.maxStopContinuations`（默认 3）限制，防止无限循环。

事件：`input.rejected`、`hook.denied`、`tool.input.updated`、`hook.continued`、`hook.failed`。

### 3.1 代码注册

```typescript
const kernel = new Kernel(config, {
  integrations: [
    {
      id: "guard",
      hooks: {
        preToolUse: (ctx, call) =>
          call.name === "exec_run" &&
          /rm\s+-rf/.test(JSON.stringify(call.arguments))
            ? { deny: "destructive command" }
            : undefined,
      },
    },
  ],
});
// 或运行时注册，返回注销函数：
const off = kernel.addHooks({
  stop: (ctx, { continuations }) =>
    continuations === 0
      ? { continue: "Run the tests before finishing." }
      : undefined,
});
```

`ctx` 含 `runId/sessionId/projectId/projectRoot/mode/routeId`。

### 3.2 配置命令钩子

由宿主配置文件声明，视为宿主自身命令（单用户可信宿主），在项目根目录用系统 shell 执行，继承宿主环境，并附加 `AGENT_PROJECT_DIR`。

```json
"hooks": {
  "timeoutMs": 30000,
  "maxStopContinuations": 3,
  "PreToolUse": [{ "matcher": "exec_run|file_write", "command": "node scripts/guard.mjs" }],
  "PostToolUse": [{ "matcher": "file_.*", "command": "node scripts/lint-changed.mjs" }],
  "UserPromptSubmit": [{ "command": "node scripts/inject-context.mjs" }],
  "Stop": [{ "command": "node scripts/require-tests.mjs" }]
}
```

协议（与 Claude Code 兼容的子集）：

- stdin：JSON，含 `hook_event_name`、`run_id`、`session_id`、`project_id`、`cwd`、`mode`、`route_id`，以及事件字段 `prompt` / `tool_name`、`tool_use_id`、`tool_input` / `tool_response` / `last_assistant_message`、`stop_hook_active`。
- 退出码 0：继续；stdout 若是 JSON，可含 `decision: "block"` + `reason`、`hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`、`hookSpecificOutput.updatedInput`、`hookSpecificOutput.additionalContext`。`UserPromptSubmit` 的非 JSON stdout 作为附加上下文。
- 退出码 2：阻止，stderr 为原因（PostToolUse 时作为注释反馈给模型）。
- 其它退出码或超时：非阻塞错误，发 `hook.failed`；PreToolUse 例外，按拒绝处理。
- `matcher` 是对完整工具名的正则；省略或 `*` 匹配全部。
- 输出各限 64 KiB，并经过密钥脱敏。

源码：`src/runtime/hooks.ts`，引擎接入点在 `src/runtime/engine.ts`。

## 4. 子 Agent（`agent_delegate` / `agent_result`）

模型可调用 `agent_delegate { description, prompt, agentId?, background? }` 把独立子任务交给一个上下文全新的子会话。

- **前台**（默认）：等待并返回子 Agent 的最终回答；同一步发出的多个委托并行执行。
- **后台**（`background: true`）：立即返回 `{ runId, status: "running" }`，父 Agent 可以继续工作，之后用 `agent_result { runId, waitMs? }` 查询或等待（最多 10 分钟）。本会话之后的运行也能查询；只能查询本会话派生的子 Agent，否则 403。
- 子会话：同项目、**同模式、同路由、同自主级别**；`agentId` 只能选择与父会话同模式的 Agent 定义（其工具白名单进一步收窄），否则 403。
- 层数：`limits.maxAgentDepth`（默认 1，即子 Agent 不能再委托；最大 5；0 关闭委托）。子会话记录 `parentSessionId` 与 `delegationDepth`。
- 调度：两个工具都声明 `scheduling.detached`，等待期间不占用工具槽位，避免子运行因槽位被父运行占满而死锁。
- 取消：前台子运行随工具调用一起取消；后台子运行在父运行被取消或超时时取消，父运行正常结束后继续运行。
- 并发：子运行占用 `limits.maxConcurrentRuns`，超出时工具返回 429 错误，不排队等待。
- 审批：子运行内需要审批的工具在子运行上发出审批事件；父运行发出 `subagent.started { sessionId, runId, background }` 供客户端订阅，前台完成时发 `subagent.completed`。
- 费用：子运行按自身会话/运行作用域计入预算账本；运行级上限 `maxRunUsd` 不累计子运行。

源码：`src/tools/index.ts`（`agent_delegate`、`agent_result`）、`src/runtime/engine.ts`（detached 调度）。

## 5. 结构化输出

提交运行时附带 JSON Schema，最终结果按它校验后存到运行记录：

```json
POST /v1/sessions/{id}/inputs
{ "text": "提取发票信息", "outputSchema": { "type": "object", "properties": { "total": { "type": "number" } }, "required": ["total"] } }
```

- 运行内增加 `submit_result` 工具，参数就是该 Schema（非 object 根的 Schema 自动包成 `{ result }`，`$defs` 上提）。系统提示要求完成时调用它。
- 参数不符合 Schema 时作为工具错误返回，模型据此修正后重试。
- 合法调用立即结束运行，结果写入 `GET /v1/runs/{id}` 的 `output`，并发出 `run.output` 事件。
- 模型不调用就结束时，最多提醒 2 次，仍不调用则运行失败（422）。
- `submit_result` 只记录结果、无副作用，因此不受模式、Agent 定义和路由工具白名单限制；仍受计划模式等其它规则约束。
- 仅 `delivery: "start"` 接受 `outputSchema`；Schema 不可引用外部地址。
- 带 `outputSchema` 的运行以 `submit_result` 作为结束条件，不调用 Stop 钩子。

源码：`src/runtime/structured-output.ts`、`src/core/kernel.ts`、`src/runtime/engine.ts`（`finishTool`）。

## 6. 输出被截断时自动续写

模型因达到输出上限停止（`length` / `max_tokens` / `incomplete`）、且回复中没有工具调用时，引擎自动追加一条续写提示再请求一次，最多 `limits.maxOutputContinuations` 次（默认 3，设 0 关闭）。每次发出 `model.continued` 事件。截断发生在工具调用中时仍然报错，因为参数可能不完整，不能执行。

## 7. 文件检查点与回滚

`file_write` / `file_patch` 写入前自动保存原文件（按 SHA-256 去重，存于 `dataDir/checkpoints`，单文件上限 16 MiB），写入后记录新内容哈希。

```json
POST /v1/sessions/{id}/rewind
{ "beforeMessageId": "message_…", "files": true, "conversation": true, "force": false }
```

- 用 `beforeMessageId`（回到该消息之前）或 `throughMessageId`（保留到该消息）二选一。
- **文件**：把该点之后由本会话文件工具改过的文件恢复到改动前；当时新建的文件会被删除。
- **冲突**：文件在 Agent 最后一次写入后又被别的途径改过（人工编辑、`exec_run`、其它会话），默认不覆盖，列入 `conflicts`；`force: true` 强制恢复。
- **对话**：通过分叉实现，返回新会话，原会话记录完整保留。设 `conversation: false` 只恢复文件。
- 已回滚的检查点不会重复应用；可以先回到较近的点，再回到更早的点。
- 返回 `{ files: { restored, deleted, conflicts, unchanged }, session, rewoundMessages }`。`GET /v1/sessions/{id}/checkpoints` 列出检查点。
- 不跟踪：`exec_run`、插件、MCP 等对文件的改动，以及子 Agent 会话中的写入（它们记在子会话上）。

源码：`src/sessions/checkpoints.ts`、`Kernel.rewind`。

## 8. 代码检索

- `file_search`：新增 `regex`、`ignoreCase`、`glob`（如 `*.ts`、`src/**/*.test.ts`）、`includeIgnored` 参数；默认遵守根目录与各级子目录的 `.gitignore` 和 `.git/info/exclude`（支持 `!` 取反、`/` 锚定、目录规则、`**`）。始终跳过 `.git`、`node_modules`、`.agent-data` 和符号链接。
- `file_glob`：按通配符查找文件，按修改时间从新到旧，最多返回 500 个；不含 `/` 的模式匹配任意层级的文件名。

源码：`src/runtime/project-walk.ts`。

## 验证

`test/agent-loop.test.ts`、`test/subagents.test.ts`、`test/run-control.test.ts`、`test/project-search.test.ts`、`test/checkpoints.test.ts` 使用本地协议服务和真实文件/子进程执行：重试与 Retry-After、重试上限、缓存断点数量与不可变性、三种钩子决策、改写参数的重新校验与权限拒绝、配置命令钩子退出码/JSON 协议、钩子崩溃的失败关闭、并行子 Agent 在单工具槽位下不死锁、模式越权拒绝、级联取消、后台子 Agent 与跨会话查询拒绝、多层委托上限、截断续写及上限、截断工具调用不执行、结构化输出的校验/包装/提醒/白名单豁免、.gitignore 规则与 glob、检查点恢复/删除/冲突/强制/不重复应用。未对真实 Anthropic 缓存命中率与真实限流头做外部联调。
