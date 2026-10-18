# 子 Agent、团队协作与会话引用

本文描述当前可调用的内核与 HTTP/客户端接口。工程仍没有配置界面；本轮提供界面后续需要接入的数据、工具、状态和事件。

## 配置与用户流程

先添加 Agent，选择已有文本模型路由和思考配置，再填写职责。每个 Agent 的 `instructions` 是用户原始职责；`routeId` 选择模型、供应商和请求参数，`reasoningEffort` / `reasoningBudgetTokens` 可在 Agent 上覆盖对应思考设置。Agent 仍可配置技能、工具范围、最大步数和记忆命名空间。

会话可单独选择以下能力，两者使用相同项目工作区，不创建 worktree：

| 能力                | 配置与行为                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同配置子 Agent      | `Session.subagentsEnabled` 控制 `agent_delegate`，默认 `true` 兼容已有会话；全局 `limits.maxAgentDepth=0` 可关闭。继承父模式、模型路由、思考设置、自主级别；未指定 Agent 定义时也继承父定义。独立上下文、并行与后台结果收取沿用现有机制。 |
| 自定义多 Agent 团队 | 创建 `TeamDefinition`，选择一个面向用户的协调 Agent 和多个成员；绑定 code 或 office 会话。各成员使用自己的路由和职责，协调 Agent 统一理解需求、优化分工、派发、收取、汇总和接收用户修改。                                                 |

团队不会自行增加成员、修改成员模型或覆盖用户原始职责。用户明确细分时尊重该分工；宽职责则包含相关工作，例如“规划”可覆盖需求、技术栈、规范与结构，“执行”可覆盖实现、测试、修复和交付检查。缺少“测试 Agent”这样的角色名称不会单独构成阻碍。

## 职责检查与真正需要用户选择的情况

第一次派工前，协调 Agent 必须通过 `team_review_roles` 检查整个现有成员集合，提供优化职责与依据。用户原始职责和团队实际采用的优化职责分别保存。每次派工还保存本次具体职责、任务说明、可写范围和交付物，均可追溯。

可以由现有成员承担的遗漏由协调 Agent 补全，无需询问用户。只有必需工作确实无法由当前成员在其允许职责、工具和权限范围内承担，或与用户明确边界冲突时，才记录阻碍并进入 `needs_user`。此时 `team_dispatch` 实际拒绝派工；模型不能自行清空缺项并继续。宿主把用户的明确选择提交为 `redistribute` 或 `add_agents`：前者允许协调 Agent 重新分配并再次检查，后者等待用户添加成员后重新配置团队。普通聊天内容不会被运行时自动当作已批准。

职责检查的有效性按现有成员与用户原始职责核对，普通后续输入可复用已有检查；目标版本单独递增，用于判断旧任务结果是否需要复核。如果用户明确撤掉原来受阻的工作，例如“取消部署，只生成开发文档”，协调 Agent 可提供 `scopeChange`，引用最新用户原文、说明理由并精确列出撤掉的原阻碍职责，重新判断是否还存在阻碍。普通追问、伪造引用和遗漏原阻碍不能通过这条路径；它不授予修改原始职责或扩大权限的权利。优化职责不能授予工具权限，也不能保证模型的语义判断正确。重大缺项是否存在仍由协调模型分析，运行时负责记录、限制成员集合并执行暂停状态。

模型上下文只注入当前需要的信息：成员读取自身优化职责和当前任务，协调者读取成员职责摘要；不会对每个成员反复注入全量原始职责与审查历史。`team_status` 批量返回最近 40 项任务摘要和 `total/hasMore`，指定 `taskId` 可查看该任务的原始、优化和本次细化职责快照。完整记录仍保留，减少重复上下文不删除证据。

## 团队定义与会话设置

先通过既有 `/v1/agents` 创建所引用的 Agent；模型路由必须实际可用，以下 ID 是示例，不是内置成员或模型。

```json
{
  "id": "engineering",
  "name": "开发团队",
  "mode": "code",
  "coordinatorAgentId": "coordinator",
  "memberAgentIds": ["planner", "executor"]
}
```

```json
{
  "teamId": "engineering",
  "kind": "task",
  "goal": "完成用户确认的功能并实际验证",
  "constraints": ["使用当前技术栈和共享工作区"],
  "acceptance": ["功能实现", "完成与变更相称的测试"],
  "maxTurns": 12
}
```

成员数量受配置上限约束，协调模型只能使用已登记成员。每个协调运行受 `maxTurns` 派工次数、既有并发数、时间、步数、工具次数和费用预算限制；不会因为使用多 Agent 就形成无限讨论或无限成员扩张。团队预算仍使用既有 run/session/project/日/总额账本：成员属于独立 run/session，如需整体团队额度应设置 project 或总额预算，不能将协调者单个 run 的额度误认为整个团队额度。

`kind="brainstorm"` 用于讨论。协调与成员只能研究、读取和讨论，写文件、执行命令和外部修改会被权限层拒绝。用户下一次输入可以继续下一轮讨论，复用成员历史；每轮仍有上限。

## API、客户端与工具

| 方法与路径                                   | 契约                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `GET /v1/teams`                              | 团队列表                                                |
| `POST /v1/teams`                             | 校验并保存团队定义                                      |
| `GET /v1/teams/:id`                          | 读取团队                                                |
| `DELETE /v1/teams/:id`                       | 删除无绑定且无活动任务的团队                            |
| `GET /v1/sessions/:id/collaboration`         | 当前团队设置或 `null`                                   |
| `PUT /v1/sessions/:id/collaboration`         | 绑定或调整团队；需会话及成员任务空闲                    |
| `DELETE /v1/sessions/:id/collaboration`      | 停用团队；需空闲                                        |
| `POST /v1/sessions/:id/role-review/decision` | `{decision:"redistribute"                               | "add_agents"}`，记录用户选择 |
| `PATCH /v1/sessions/:id`                     | 支持 `subagentsEnabled`、思考设置、`readableSessionIds` |
| `POST /v1/sessions/:id/inputs`               | 原有输入契约加 `contextSessionIds`、`teamRoleDecision`  |

`FoundationClient` 提供 `putTeam/teams/configureCollaboration/resolveTeamRoles`；原有 `session()` 第四个参数可传子代理开关、Agent ID 和思考设置。用户选择也可与下一条输入一起提交 `teamRoleDecision`，无需分别给多个成员发消息。

团队工具是 `team_review_roles`、`team_dispatch`、`team_status`、`team_read`。只有协调者能审查和派工，成员可以读取同一团队会话的任务与历史，不能另起团队或扩张成员集合。启用团队的会话关闭普通 `agent_delegate` 入口，避免绕过职责检查、成员模型、派工次数和范围记录。`team_dispatch` 复用该成员在本团队的子会话；后台结果由协调者查询。目标变化后任务结果以 `stale` 标记，不能未经复核就当作当前目标已完成。

`scope` 是项目相对文件或目录列表；空列表表示只读任务。运行时拒绝空范围任务的写与执行操作，拒绝活动任务的重叠写范围，并对 `file_write/file_patch` 校验目标路径。具有写范围时，原生命令或扩展不能仅凭声明范围获得操作系统级路径限制；它们仍服从原有权限、审批和执行边界。所有成员共享工作区，用户明确不需要工作区隔离。

成员有效权限同时受到父会话、主路由、实际模型路由、Agent 定义、模式与宿主策略约束，不能因为换了模型就放宽父会话权限。团队事件 `team.task.started/completed` 包含关联任务、成员会话和 run ID；用户客户端可在一个会话里展示进度与审批，无需用户分别对话。

## 分支与读取其他会话

原有 `POST /v1/sessions/:id/fork` 继续支持按消息分叉；现在保存 `forkedFromSessionId/forkedThroughMessageId` 并继承会话设置和自主级别。`GET /v1/sessions/:id/branches` 可读取相关分支关系。分叉复制历史，不重新执行工具，不恢复历史文件状态；文件恢复仍使用已有 rewind/checkpoint 能力。

Agent 可用 `session_list/session_read` 读取当前会话、分支来源及用户显式挂载的参考会话。宿主通过输入 `contextSessionIds` 或设置 `readableSessionIds` 授权，同一项目限制仍然生效；不得跨项目引用。团队内历史使用 `team_read`，不能读取其他团队会话。引用历史标记为不可信资料，不把旧会话里的命令或角色标签当作当前授权。`session_read` 分页返回文本，不返回原始图片和模型私有推理。

## 思考设置和验证边界

OpenAI 两种适配器把 `reasoningEffort` 写为各自协议字段；路由可配置 `supportedReasoningEfforts` 限制可选值。各模型实际支持范围仍需按供应商配置，底座没有实时能力发现。Anthropic 传统思考使用 `reasoningBudgetTokens`，必须小于输出上限；只有实际支持 adaptive thinking 的模型才设置 `compat.adaptiveThinking=true` 并选择其支持的 effort，不能把所有模型都当作支持所有等级。

`npm test -- --filter=collaboration` 使用本地模型协议服务、真实 SQLite 和文件操作检查多路由、职责审查与用户决定、宽职责分工、轮次、共享范围冲突、会话复用、旧结果、取消和只读讨论；并非付费模型协作质量或所有任务不偏离的保证。服务器插件的凭据、SSH/SFTP 与事实管理见 [SERVERS.md](SERVERS.md)。
