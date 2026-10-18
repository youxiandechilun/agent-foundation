# Responses 原生联网搜索

文本路由支持 `nativeWebSearch` 能力字段，默认 `false`。只有 `kind: "text"`、`adapter: "openai-responses"` 的路由可以设为 `true`。它对应模型配置界面中的“原生联网搜索 / Native web search”选项；当前仓库提供底座配置和 API，没有模型设置前端。

OpenAI 官方文档：[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。当前使用稳定工具类型 `web_search`。支持哪些托管工具取决于供应商、模型和端点，不能仅凭模型名称推断；第三方 Responses 兼容服务仍需实际联调。

## 配置

在支持原生搜索的路由中加入能力声明，网络权限沿用宿主现有配置：

```json
{
  "routes": {
    "responses": {
      "kind": "text",
      "adapter": "openai-responses",
      "model": "YOUR_MODEL_ID",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "nativeWebSearch": true
    }
  },
  "permissions": {
    "network": "ask"
  }
}
```

这是一段配置补充，合并到现有配置中，并按需要将会话或默认路由指向 `responses`。不需要为了启用搜索更换现有模型。`config.example.json` 提供默认关闭的示例。

`GET /v1/config` 与 `GET /v1/routes` 返回各路由的 `nativeWebSearch`。`PUT /v1/routes/{id}`、`PATCH /v1/routes` 使用同一校验规则，并沿用现有空闲时更新、原子持久化机制。客户端可以直接将该字段绑定到能力复选框。

## 调用与权限

能力声明与单次授权分别控制：

1. Agent 每次请求前，确认实际路由已声明支持、工具选择不是 `none`。
2. 使用现有 `web_search` 工具名称、`network` 能力及风险，检查宿主、模式、Agent、祖先会话、项目策略、主路由和实际备用路由的限制。现有 `toolAllowlist` 与 `policy.tools` 中的 `web_search` 同时约束本地及托管搜索。
3. `ask` 通过现有审批接口，在 HTTP 请求前等待。审批参数包含 `native: true`、路由 ID 和模型 ID；授权范围是本次模型请求内由上游自主决定的搜索，可能包含多次检索或打开页面。审批拒绝或权限撤销时，本次请求不提供托管搜索；运行取消则不发送请求。安全审计或宿主集成发生错误时保留失败状态。
4. 允许后，将 `{ "type": "web_search" }` 与普通 function 工具一起发送。默认 `tool_choice: "auto"`，模型自主判断是否搜索；能力开关打开不保证每次使用搜索。

备用模型、临时失败重试和上下文修复重试，每次发送新 HTTP 请求前都重新授权。已经开始搜索的中断请求不会自动重试或切换备用模型，避免重复外部效果。`plan` 自主级别沿用现有只读工具限制，不自动获得联网能力。

原有本地 `web_search` function 工具继续可用，其配置仍受 `web` 配置和本地实现约束。托管搜索由模型供应商执行，不经过本地 `WebClient` 的代理、域名和私网检查；应在确认供应商的网络策略后声明能力。不能通过 `requestDefaults.tools` 注入托管工具，核心配置禁止覆盖工具集合。

内部上下文摘要、自动记忆提取和 MCP sampling 没有 Agent 的原生搜索授权入口，即使使用支持搜索的路由，也不会自动开启搜索。

直接使用底层 `HttpTextProvider` / `RouteRouter` 的受信宿主代码，必须自行授权后显式设置 `ModelRequest.nativeWebSearch: true`；省略该标记时不启用。`toolChoice: "none"` 总是关闭托管搜索。通用 `required` 只要求使用某个可用工具，并不专门强制搜索。

## 输出与引用

`AssistantMessage.webSearch` 保存规范化的搜索调用和 URL 引用：

```json
{
  "calls": [
    {
      "id": "search_1",
      "status": "completed",
      "action": {
        "type": "search",
        "queries": ["查询内容"],
        "sources": [{ "url": "https://example.com/news", "title": "来源标题" }]
      }
    }
  ],
  "citations": [
    {
      "url": "https://example.com/news",
      "title": "来源标题",
      "startIndex": 0,
      "endIndex": 4
    }
  ]
}
```

引用位置对应 `textOf(assistant)`，采用 JavaScript 字符串索引，区间为左闭右开。规范化时排除不安全的 URL 协议与无效索引。JSON、终态 SSE、增量 SSE 都走同一处理，终态快照替换重复增量，避免来源重复。

完整回复通过现有 `assistant.message.committed` 事件和会话记录提供这些字段；客户端展示联网结果时，应显示清晰、可点击的引用。当前没有新增搜索进度事件或前端引用组件。搜索调用不会作为本地 function 交给工具调度器执行。

同一路由的原生输出按顺序保存在 `providerState`，后续 Responses 请求重放搜索、推理、消息与 function 调用，避免重复文本和重复工具调用。切换路由时不重放其他路由的供应商状态。中断输出不重放未形成语义工具调用的原始 function 项，避免产生缺少结果的调用。会话导出、导入及便携迁移保留经校验的搜索元数据。

## 费用与验证范围

原生搜索可能包含独立工具费用。token usage 不能证明总费用已经结清；原生搜索请求的账本记录保留为 `unknown`，由现有费用对账接口按供应商账单结算，即使本次模型最终没有搜索也保守保留该请求的预留。

启用 `budgets.enabled` 时，路由还必须声明 `pricing.maxRequestUsd`。预留额取该请求费用上限与最大 token 费用估算中的较大值，预算不足或缺失上限时在 HTTP 前失败。该值是操作者声明的费用预留上限，不会变成供应商端的强制扣费上限；应根据供应商限制和实际账单设置，并及时对账。预算关闭时也不会把托管工具费伪装成已结算的 token 费。

本次验证使用真实本地 HTTP/SSE、数据库、审批与会话迁移路径，覆盖协议和权限行为；没有调用真实付费模型，不能据此宣称特定供应商端点已经通过联网搜索联调。
