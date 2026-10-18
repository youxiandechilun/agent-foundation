# 内置网页抓取与搜索

核心内置 `web_fetch` 与 `web_search` 两个工具，不依赖浏览器引擎、Playwright 或任何外部 SDK。需要执行 JavaScript、登录或点击交互的页面，仍使用可选浏览器应用包（`--host browser`）或 MCP。

## 工具

| 工具         | 参数                              | 返回                                                                                         |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `web_fetch`  | `url`，可选 `offset`、`maxChars`  | 最终 URL、状态码、标题、可读文本（标题/列表/表格/绝对链接）、`totalChars`、`nextOffset` 分页 |
| `web_search` | `query`，可选 `maxResults`（≤20） | 标题、URL、摘要、发布时间；仅在配置了搜索服务时提供                                          |

- HTML 转为可读文本：去掉 script/style/head/nav/footer/表单/隐藏 textarea 等；优先取 `<main>`/`<article>`。
- JSON、XML、纯文本、CSV、Markdown 原样返回。
- PDF、图片、Office 等二进制内容存为项目资产，返回 `assetId`，再用 `asset_read` 提取；图片在支持图像的路由上会直接附给模型。
- 字符集：按响应头或 `<meta charset>` 解码，支持 GBK/GB2312/Big5 等。
- 解压 gzip/deflate/br，解压后同样受字节上限约束。
- 同一 URL 的文本结果缓存 15 分钟（`cacheTtlMs`），分页读取不会重复请求。
- 两个工具的 risk 都是 `network`、能力是 `network`，受 `permissions.network`（默认 `ask`）、模式、路由和项目规则共同约束；plan 自主级别下不可用。

## 配置

```json
"web": {
  "enabled": true,
  "proxy": "env",
  "allowedHosts": ["*"],
  "blockedHosts": [],
  "allowPrivateNetwork": false,
  "timeoutMs": 20000,
  "maxBytes": 5242880,
  "maxRedirects": 5,
  "maxChars": 40000,
  "cacheTtlMs": 900000,
  "search": { "provider": "none", "maxResults": 8 }
}
```

### 代理

- `"env"`（默认）：使用 `HTTPS_PROXY` / `HTTP_PROXY`，遵守 `NO_PROXY`（支持 `*`、`.example.com`、`*.example.com`）。
- `"none"`：直连。
- 也可写成代理地址，如 `"http://user:pass@127.0.0.1:7890"`。
- 支持 HTTP 代理（HTTPS 目标走 CONNECT 隧道，TLS 在本机校验）。不支持 SOCKS，遇到会报错而不是静默直连。
- 企业 TLS 中间人代理：`extraCaFile` 指向 PEM 根证书，追加到系统默认根证书之后。

### 私有网络防护

默认禁止访问私有/保留地址（127/8、10/8、172.16/12、192.168/16、169.254/16、100.64/10、198.18/15、::1、fc00::/7、fe80::/10 等）以及 `localhost`、`*.local`、`*.internal`、无点主机名。

- **直连**：在建立 TCP 连接时检查实际拨号的解析地址，防止 DNS 重绑定。
- **经代理**：IP 字面量和本地主机名在发出前拦截；域名由代理解析，本机不再检查解析结果（代理常用 fake-ip，本地解析无意义）。如果代理本身能访问内网，私有网络防护依赖代理规则。
- 每次重定向都重新校验协议、主机白/黑名单和私有网络规则，最多 `maxRedirects` 次。
- 禁止 URL 内嵌账号密码，仅允许 http/https。
- 需要访问内网时设 `"allowPrivateNetwork": true`。
- 本机未设代理、但用了 fake-ip DNS（解析到 198.18.x.x）时，直连会被拦截：请配置 `proxy`，或开启 `allowPrivateNetwork`。

### 搜索服务

| provider  | 需要                                     | 说明                                                              |
| --------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `tavily`  | `apiKeyEnv`                              | `POST {baseUrl or https://api.tavily.com}/search`                 |
| `brave`   | `apiKeyEnv`                              | `GET {baseUrl or https://api.search.brave.com}/res/v1/web/search` |
| `searxng` | `baseUrl`，可选 `apiKeyEnv`              | 自建实例，需在 SearXNG 设置里启用 `json` 输出格式                 |
| 自定义    | `kernel.web.registerSearchProvider(...)` | 任何搜索服务，注册后在配置里填其 `id`                   |

```json
"search": { "provider": "tavily", "apiKeyEnv": "TAVILY_API_KEY", "maxResults": 8 }
```

搜索服务地址是宿主配置的可信端点，可以位于内网（例如自建 SearXNG），不受 `allowPrivateNetwork` 限制；返回结果中非 http(s) 链接和 `blockedHosts` 中的站点会被过滤。API 密钥按环境变量名引用，注册为密钥后在日志与事件中脱敏。

```typescript
kernel.web.registerSearchProvider({
  id: "my-engine",
  async search(query, { maxResults, request, signal }) {
    const response = await request(
      `https://search.internal/api?q=${encodeURIComponent(query)}`,
      { signal },
    );
    return JSON.parse(response.body.toString()).items.slice(0, maxResults);
  },
});
```

## 限制

- 不执行 JavaScript：依赖前端渲染的单页应用只能得到初始 HTML。这类页面请用浏览器应用包。
- 不处理 Cookie 和登录态。
- HTML 转文本基于规则，不是完整的 DOM 解析，复杂版面可能保留少量导航文字。

源码：`src/web/client.ts`，工具定义在 `src/tools/index.ts`。测试：`test/web.test.ts`（本地 HTTP/HTTPS 服务、真实 HTTP 代理与 CONNECT 隧道、GBK、gzip、重定向、私有网络、大小与超时限制、搜索服务、工具权限与分页）。另外通过本机 HTTP 代理实测抓取了 example.com、baidu.com、zh.wikipedia.org、gov.cn、nodejs.org；未对 Tavily/Brave 真实服务联调。
