# 系统提示词与可选安全审计

本文记录当前源码的提示词来源、内容审核范围、配置和扩展契约。安全审计默认关闭；该开关不改变现有身份认证、工具权限、人工审批和执行隔离。

## 现有系统提示词从哪里来

底座已有系统提示词组装能力。`src/core/kernel.ts` 的 `startRun` 按顺序组合通用 Agent 指令、模式和自主程度、项目目录、执行边界、模式指令、`AgentDefinition.instructions`、通用执行约定、技能目录、已选技能与可选的结构化输出要求。`src/runtime/engine.ts` 把它放进首条 `system` 消息；模型协议适配器按协议转换。

- `src/modes/index.ts` 提供 chat/code/office 模式指令。code 模式会读取项目根目录的 `AGENTS.md`、`CLAUDE.md`（受路径与文件大小限制）。自定义模式通过 `ModeRegistry` 注册。
- 单个 Agent 的业务指令通过 `kernel.agents.put({ id, name, mode, instructions, ... })` 或已有 `/v1/agents` 管理接口配置，无需修改 Kernel 内部字符串。
- `src/extensions/skills.ts` 管理安装、启用和选择的技能。显式选择的技能还会进入输入构建结果。
- 团队上下文在模型请求准备时追加；记忆作为带有“不可信数据”说明的上下文提供。附件摘录以 `untrusted_attachment` 标记包装。
- `UserPromptSubmit` 等 Hooks 可以追加上下文或限制行为。它们是受宿主信任的扩展，不是普通用户输入。

这些属于正常的提示词配置和组装。恶意提示词注入则是输入材料试图冒充高优先级指令、覆盖规则或索取内部指令。标记为不可信数据有助于模型区分来源，但不是强制隔离机制。

原有通用提示词中已经包含不泄露宿主凭据、按权限使用工具、未经验证不报告成功等指令。本模块没有新增隐藏的内容拒绝提示词，也不会删除这些既有指令。供应商自身的审核和拒绝行为独立于本地审计开关。

## 模块位置与职责

```text
src/security/
├─ config.ts   配置校验和默认值
├─ types.ts    请求、规则、结果与持久记录契约
├─ rules.ts    内置提示词注入启发式、配置式字面量规则
├─ audit.ts    规则注册、执行时限、错误策略、记录和分页查询
└─ index.ts    模块公开导出
```

Kernel 只负责在输入和工具边界调用审计。HTTP 路由负责参数转换和响应；存储复用 `Store` 的实体查询及索引，记录使用 `security-audits` 类型，不新增数据库引擎、队列、第三方依赖或模型调用。

新规则优先通过宿主 SDK 注册。只有随底座维护的通用规则才放入 `src/security/rules.ts`，具体业务词表、供应商 SDK 和审核模型调用放在宿主扩展中。现有的三个 SDK 包入口保持不变，审计类和类型从根入口导出。

## 配置与默认行为

`config.example.json` 明确关闭审计；旧配置省略这一项也会得到相同默认值：

```json
{
  "securityAudit": {
    "mode": "off",
    "timeoutMs": 1000,
    "onError": "deny",
    "promptInjection": "flag",
    "textRules": []
  }
}
```

| 配置              | 行为                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mode: "off"`     | 不执行规则、不组装审计专用请求、不写审计记录；现有功能照常运行。                                                              |
| `mode: "audit"`   | 检查并记录结果，规则判定拒绝或执行失败都不因内容策略阻断。                                                                    |
| `mode: "enforce"` | 规则返回 deny，或发生符合 onError 策略的错误时拒绝。                                                                          |
| `promptInjection` | off 关闭内置启发式；flag 仅标记；deny 在 enforce 下可阻断。默认 flag，所以仅开启 enforce 不会把所有注入迹象直接当作拒绝理由。 |
| `onError`         | 规则抛错、超时或返回无效结构时，enforce 按 allow 或 deny 处理。默认 deny；在 off 下不执行，在 audit 下仍只记录。              |
| `timeoutMs`       | 每次审计的总检查时限，范围 10–60,000 毫秒，默认 1,000 毫秒。                                                                  |

配置在构造服务时校验并快照，修改配置文件后需重建/重启 Kernel；不支持直接修改共享配置对象来热更新。规则注册、注销是单独的 SDK 能力，每次检查使用开始时的规则集合。规则可以并行检查同一只读快照，结果按注册顺序记录，任一 deny 不会被其他 allow 覆盖。

开启后每次检查都会写入元数据记录，包括允许结果。因此 audit/enforce 增加检查和 SQLite 写入成本。存储写入失败仍属于基础设施故障，不会伪装为“审计成功”。记录没有自动删除策略，宿主应按实际保留要求管理数据目录。

## 配置业务拒绝规则

以下使用占位词说明接口，应替换为实际业务规则。词表按字面量匹配，不接受任意正则表达式，不调用外部模型。

```json
{
  "securityAudit": {
    "mode": "enforce",
    "promptInjection": "flag",
    "textRules": [
      {
        "id": "restricted-operation",
        "terms": ["RESTRICTED_EXAMPLE"],
        "action": "deny",
        "stages": ["input", "tool"],
        "caseSensitive": false
      }
    ]
  }
}
```

每个词表规则最多 32 个词，每词最多 500 个字符，总共最多 32 条词表规则。`stages` 省略时只检查 input；工具阶段逐项匹配已解码的字符串值和字段名，正确处理 Windows 路径、引号和换行，不跨字段拼接。数字、布尔值等业务判断通过 SDK 规则实现。`caseSensitive` 默认 false。先用 audit 模式检查误判，再按业务需要启用 enforce。

## 覆盖的执行路径

1. **普通输入、steer、enqueue**：在结构/会话校验及输入构建后，创建 run、写入 inbox、更新团队目标之前审核。检查脱敏前的用户文字、实际提取的附件文本摘录和显式技能文本；图片像素不在规则输入中。审计文本仅在内存中使用，与随后按既有规则脱敏保存的消息分开。拒绝时 HTTP 返回 403、错误码 `security_audit_denied` 和通用中文说明，不回显命中原文。已有运行不会因某条追加输入被拒绝而自动取消。
2. **恢复旧任务**：重新审核即将恢复的 pending inbox 文本，避免 off/audit 时积压的输入直接执行。记录沿用旧 inputId，拒绝不创建新 run，也不把旧 inbox 标为已处理。恢复只能检查已经持久化的脱敏文本，不能重建此前被脱敏移除的原文。
3. **模型工具调用**：在工具参数校验与 `PreToolUse` 改写复验后审核实际参数，再进入既有授权/审批和工具执行。缓存工具效果的重放也经过授权回调。记录包括实际路由、runId 和 toolCallId；拒绝作为工具错误反馈，Agent 可以据此调整后续行为。
4. **客户端进程控制**：`Kernel.processAction` 及对应 HTTP `exec_*` 控制入口使用同一检查逻辑，拒绝后控制 run 变为 failed，进程不会启动。

输入审核发生在附件构建之后，因此不能阻止读取/提取附件本身；它阻止的是将被拒绝的提交材料接受为本次任务。附件仅检查实际放入输入的摘录，不假定已扫描完整文件。

此模块不自动扫描所有历史消息、导入会话、检索记忆、网页/工具结果、模型输出或二进制附件，也不替代供应商 moderation。后续受信任的 `UserPromptSubmit` Hook 可追加上下文，本轮 input 记录不代表审核了追加后的完整模型请求。直接使用底层 `ExecutionEngine`、`RouteRouter` 或宿主浏览器/办公管理 API 不会自动经过 Kernel 的输入审核；独立使用方可显式组合 `SecurityAudit.check`，并保留已有权限控制。输入及工具参数审计不等于覆盖全部模型请求的内容防火墙。

## SDK 扩展规则

规则是受宿主信任的进程内代码。配置中的字符串不会自动加载本地文件或执行命令。宿主通过构造参数或显式注册添加规则：

```typescript
import { Kernel, type SecurityAuditRule } from "@local/agent-foundation";

const operationRule: SecurityAuditRule = {
  id: "business-sensitive-export",
  stages: ["tool"],
  evaluate(request, signal) {
    signal.throwIfAborted();
    if (
      request.stage === "tool" &&
      request.toolName === "business_export" &&
      request.arguments.scope === "all-customers"
    ) {
      return [{ code: "bulk_export", severity: "high", action: "deny" }];
    }
    return [];
  },
};

// config 由 parseConfig/loadConfig 构建；默认 off 仍不会调用 operationRule。
const kernel = new Kernel(config, { securityAuditRules: [operationRule] });
// 也可 kernel.securityAudit.register(另一条规则)，返回注销函数。
```

`SecurityAuditRequest` 是 input/tool 可辨识联合；每条规则最多返回 32 个 finding，含内置规则的注册总数最多 64。finding 只允许固定代码、严重程度和 flag/deny，不接受任意说明、摘录或原始异常。服务验证结果结构并复制/冻结规则输入，防止检查器改写后续执行参数。

外部审核服务适配器由宿主实现为异步 `evaluate`，应将 AbortSignal 交给 fetch 等操作，不在结果中回传正文或凭据。服务自身不向第三方传送内容。超时和外部取消会结束等待，取消不记录为一次“审核失败”，迟到的 Promise 结果不会补写或推翻既有判定。JavaScript 进程内时限不能强行中断同步死循环；不可信代码或高成本计算应由宿主使用 Worker/进程隔离。

## 记录与查询

```http
GET /v1/sessions/{sessionId}/security-audits?limit=100&offset=0
Authorization: Bearer <host-token>
```

返回 `{ records, total, limit, offset }`，默认每页 100，最大 200；先确认会话存在，并限定同会话、同项目记录。查询复用现有 Bearer 身份认证。记录按新到旧排列，offset 分页不是跨页快照，并发新增时后续页可能重复或偏移。SDK 可调用 `kernel.securityAudit.list(sessionId, page)`，HTTP 客户端可调用 `client.securityAudits(sessionId, page)`。

记录包含关联标识、模式、阶段、allow/deny、规则命中及检查耗时（不含记录写盘时间）。错误仅记录 error、invalid_result、timeout 等分类。输入被拒绝时尚无 runId，使用 sessionId/inputId 查询；工具记录有 runId/toolCallId，并发布持久 `security.audit` 事件，可由既有 SSE/JSON 重放读取。`/v1/capabilities` 提供模式和阶段信息。

审计实体不保存输入原文、工具参数、命中词片段或异常堆栈，并复用 Store 的凭据脱敏。规则 ID 和 finding code 应使用固定、不含业务数据的标识。此约定只针对新增审计记录；正常会话、inbox 和已有 `tool.requested` 事件仍按原有功能保存必要执行数据，不能据此认为整个数据目录不含正文。

## 验证与性能复现

行为回归位于 `test/security-audit.test.ts` 和 `test/security-audit-integration.test.ts`，使用原有入口：

```powershell
npm run check
npm run check:host
node scripts/run-core-tests.mjs --filter=security-audit
node scripts/run-core-tests.mjs
```

`scripts/benchmark-security-audit.mjs` 对已编译旧版本与当前版本运行相同 Kernel 场景：一次输入、三个本机 HTTP/SSE 模型步骤、两个读工具。各组在独立进程中预热，轮换 baseline/off/audit/enforce 顺序；开启组使用提示词注入启发式和一条词表规则，并验证真实记录数量。脚本不构建、不切换分支，不测外部模型推理和网络时延。

```powershell
node scripts/benchmark-security-audit.mjs --baseline-dist=<旧版本编译目录> --current-dist=dist --rounds=8
```

执行时不要并行运行构建、测试或其他性能基准。实际检查结果、原始样本及编译产物指纹见 `verification/security-audit/`；未记录的环境不能标为已验证。

## 2026-10-18 实际验证

基线提交为 `f1af89195ca9574a7d24da98d80805cdf5b0a3cf`。完整命令、退出码和日志见 [validation.json](../verification/security-audit/validation.json)，样本和环境见 [benchmark.json](../verification/security-audit/benchmark.json)，源码指纹、指标和证据 SHA256 见 [report.json](../verification/security-audit/report.json)。

- 核心全量 484/484 通过，零失败、取消和跳过；其中本轮新增单元测试 13 项、HTTP 集成测试 10 项。
- 宿主定向集成 4/4 通过；核心/宿主构建、编译产物冒烟通过。宿主冒烟实际覆盖 Chromium、Office worker、Windows bridge inspect 和配对。
- 新测试严格类型检查、性能脚本 checkJs 和变更代码格式检查通过。独立复审发现的工具字符串转义漏检、脱敏前输入审核遗漏均已修复，并加入回归。
- 未重跑全部原生桌面输入、真实外部付费模型和 SDK 打包；既有发行包没有重新生成。

性能测试环境为 Windows、Node v22.22.0。共 8 轮、32 个独立进程，每进程 6 次预热、24 次计时，共计 768 次计时运行。表中为每组“批次总耗时 / 24”的中位数；开启组同时检查输入和两个工具，并验证每次运行产生 3 条审计记录。

| 版本/模式    | 每次运行中位耗时 | 相对旧版本 |       相对当前 off |
| ------------ | ---------------: | ---------: | -----------------: |
| 旧版本       |         38.90 ms |          — |                  — |
| 当前 off     |         38.63 ms |      -0.7% |                  — |
| 当前 audit   |         41.46 ms |      +6.6% | +7.3%，约 +2.82 ms |
| 当前 enforce |         41.26 ms |      +6.1% | +6.8%，约 +2.63 ms |

off 与旧版本差异很小，按基本持平处理，不作为稳定提速证据。样本中存在局部波动，全部原始样本保留，未删除离群轮次。这里测的是本机确定性模型服务，不包含外部推理或公网延迟，也未覆盖启动成本和所有任务类型。

本轮增加安全审计能力，生产代码 `src + extensions` 从 33,982 行变为 34,577 行，其中独立安全模块 442 行。计量包含空行/注释，排除依赖、构建、配置、文档和验证数据；包含测试、脚本、示例时合计 67,504 行。此前 20,000 行目标尚未达到，没有通过删除能力或压缩排版宣称完成。
