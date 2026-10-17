# 应用能力底层 · 0.10.0

这版在独立 Agent 内核上增加三个可单独启用的源码应用包：浏览器、Windows 电脑控制、办公格式处理。它们使用同一工具注册、审批、模式和模型权限、项目/会话、资产与事件接口。UI 和 ESP32 继续暂缓。这里定义本版支持的具体行为；没有把未来完整办公软件、所有网站和所有操作系统的支持计为完成。

## 安装与启用

最小内核继续使用 `npm ci --omit=optional --ignore-scripts` 和 `npm run build`，无需 Docker、Chromium 或办公库。启用应用包时安装锁文件中的可选依赖，并准备实际 Chromium：

```powershell
npm ci --ignore-scripts
npm run browser:install
npm run build:host
node dist/cli.js serve --host desktop
```

`--host browser`、`--host computer`、`--host office` 仅安装对应工具包；`--host core` 为默认最小内核。`desktop` 同时启用三个应用包，不包含 Electron 窗口。已安装 Chromium 时可在 `browser.executablePath` 指定路径。Windows 原生桥接使用系统 PowerShell/.NET，办公 PDF 生成功能使用 Chromium；PDF 解析/合成/预览不用连接远端模型。

程序嵌入：

```typescript
import { Kernel, loadConfig, serve } from "./dist/index.js";
import {
  applicationIntegration,
  officeIntegration,
} from "./dist/host/index.js";
const config = await loadConfig("config.json");
const kernel = new Kernel(config, {
  integrations: [
    applicationIntegration({ browser: true, computer: true, office: true }),
  ],
});
const api = await serve(kernel);
// 仅办公时改用 integrations:[officeIntegration()]。
// 结束时 await api.close()，释放浏览器、原生进程、工作线程和连接。
```

包导出路径为 `@local/agent-foundation/host`；需要先执行宿主构建。导入该入口不会加载未选择的格式引擎。核心的 `FoundationClient` 保持只依赖 fetch/Blob 的客户端代码，Electron 和网页不需要导入内核或原生控制模块。

## 浏览器：管理会话与用户浏览器

`src/browser.ts` 管理真实 Chromium、项目与会话归属、持久 profile、标签页、操作队列、快照和元素引用。profile 路径使用项目/拥有者摘要；重复打开不会错误释放已有锁。输入框、按钮、选择框、复选框、iframe、导航历史、等待、显式对话框响应、上传/下载、元素与页面截图均调用真实浏览器。元素引用绑定实际 ElementHandle，每次快照后旧引用失效。取消或超时会关闭管理上下文、使队列停止并释放 profile。

管理浏览器通过 `src/host/browser-network.ts` 的本机鉴权代理连接 HTTP、HTTPS CONNECT 和 WebSocket。DNS 解析后检查所有候选地址，并把通过检查的 IP 直接交给 TCP 连接，避免校验后再次解析。拒绝 URL 凭据、未允许主机、私网/保留地址及其 IPv6 变体；HTTP 代理凭据不转发给目标。当前权限撤销会中断已有连接。QUIC 与非代理 WebRTC UDP 被禁用。这是浏览器网络约束，**不是整个宿主的 OS 沙箱**。

CDP 只允许已配置的端点。默认只控制新建的专用标签页，`browser.cdpAllowExistingTabs:true` 才允许纳入已有标签页。断开连接保留用户浏览器与标签页。外部 CDP 的已有浏览器流量仍由用户浏览器配置控制，返回 `networkEnforcement:"reviewed-actions-only"`。

用户浏览器扩展位于 `extensions/browser-bridge/`。用户在浏览器中显式授权具体标签页；主机单独生成配对节点令牌，不能使用节点令牌访问主机管理 API。每次操作先读取标签页元数据，主机校验目标 URL，扩展再检查标签页授权和已审核 URL。更换连接、撤销标签页或服务端配对会使后续操作失效；连接任务串行，取消与断线后的不确定效果保留 unknown。远程主机连接要求 HTTPS，loopback 可使用 HTTP。没有使用扩展来声称完整拦截用户浏览器的所有网络流量。

扩展当前支持已授权标签页的检查、文本输入、点击/双击、按键、滚动、选择/勾选、悬停、导航/历史、重载、截图和关闭。上传/下载和 iframe/ref 操作目前由管理浏览器提供；扩展不接受未声明操作，也不执行任意模型 JavaScript。扩展源码可由后续 Electron 插件安装流程接入；本版没有开发客户端安装向导。

## Windows 原生控制

`src/computer.ts` 是资源和权限管理器，`src/platform/windows-computer.cs` 与 `.ps1` 是自行维护的 Win32/UI Automation 桥接源码。没有调用其他 Agent、桌面控制 SDK 或远端桌面服务。支持窗口枚举、窗口/进程核对、受限控件树、Value/Invoke/Toggle/Selection/ExpandCollapse 模式、窗口截图、显式聚焦，以及真实 SendInput 键盘、鼠标和拖动。

操作先获取项目 + run 独占租约，按全局队列串行执行；并发上限、租约到期、当前权限、允许进程、输出预算、超时和取消均有检查。工作进程使用受限环境，模型密钥不随环境继承。截图写入所属项目资产。紧急停止中断当前进程与队列并锁住控制入口，只有管理 API 显式 resume 后恢复。已经发送的原生输入不能通用撤销；Windows UIPI、锁屏、提升权限和不支持 UIA 的程序可以明确失败，不能伪造成功。

除 inspect/windows 外，默认同时要求 `windowId` 与 `processId`；截图默认针对窗口。控件操作的 `elementId` 来自 tree，过期或超出窗口树的引用失败。键鼠输入前必须由调用方明确 focus，原生桥接复核前台窗口。坐标相对于窗口矩形，并检查是否越界或被其他窗口遮挡；全局输入/全屏截图必须分别显式开启。

```json
{
  "computer": {
    "enabled": true,
    "allowGlobalInput": false,
    "allowDesktopCapture": false,
    "allowedProcessIds": [],
    "leaseMs": 120000,
    "timeoutMs": 15000,
    "maxElements": 200,
    "maxDepth": 6,
    "maxQueuedActions": 16
  }
}
```

空 `allowedProcessIds` 表示不加进程白名单，仍执行窗口/进程绑定和 computer 权限。测试实际启动专用 WinForms 窗口，验证控件读写、按钮、复选框、PNG、键鼠输入和越界拒绝；关闭夹具时恢复原前台窗口和指针。**Linux/macOS 原生适配器尚未实现**，不是已实现但未实测的能力；当前平台不支持时返回 501。

## 办公处理与不可变产物

`src/office.ts` 管理源资产、SHA-256、操作与输出归属；`src/host/office-jobs.ts` 创建有并发、时间、堆和栈限制的实际工作线程，传入已校验的字节，不让工作线程重新打开源文件。`office-format-worker.cjs` 维护格式操作协议与编辑逻辑。原文件不覆盖，每次编辑产生新资产，并返回 sourceAssetId、编辑统计、所需重新计算状态；可用 expectedSha256 拒绝过期编辑。

| 格式 | 本版实际支持                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| CSV  | 引号/换行解析、读取/分页、筛选/排序/选列、分组统计、生成；生成文本防公式注入并保留真实负数                             |
| XLSX | 工作表与公式状态检查、真实行列读取、统计/变换、新建；按 A1 区域修改文字/数值/布尔/空值/公式，保留原样式与未知 ZIP 部件 |
| DOCX | 主体段落/表格检查、文本提取、新建文档；跨文字 run 的精确替换，可指定正文/页眉/页脚/脚注/尾注部件，保留样式及未改部件   |
| PPTX | 通过 presentation relationships 读取真实页面顺序、文本检查/提取、新建；精确文字替换与未改媒体部件保留                  |
| PDF  | 实际生成、文本提取、页数/尺寸/旋转检查；选页、排序、重复、合并、旋转和 PNG 预览                                        |

XLSX 编辑清除所有工作表的公式缓存与旧 calcChain，并声明 fullCalcOnLoad/forceFullCalc。它**没有实现 Excel 公式计算引擎**；新公式输出 needsRecalculation，读取结果标记 cached 或 unavailable。新写入外部访问公式被拒绝，合并区域非主单元格不接受修改。源文件已有的链接与未知格式部件按原文件保留；这不是恶意文档净化器。PDF 交互表单合并明确拒绝，直到将来提供显式表单展平策略。

`office-archive.cjs` 在通用库处理前检查 ZIP 目录/本地头、真实解压字节、CRC、重复与危险路径、数量/扩展上限、宏和 XML DTD/entity。修改后的 XML 使用 DOM 解析/序列化，替换次数必须与预期一致。PDF 预览有像素与页数上限。工作线程资源限制不等于 OS 隔离；原生 canvas 内存也不全受 JS 堆上限约束。

可选库 Playwright、ws、docx、ExcelJS、PptxGenJS、pdfjs-dist、pdf-lib、JSZip、xmldom、canvas 分别提供浏览器/传输/通用格式与渲染能力。应用调度、权限、代理、桥接、编辑逻辑、资产协议和工作进程源码由本工程维护；第三方库原许可保留。旧的简单 office-worker 和 mammoth 依赖已删除。

## 统一接口与事件

应用包在 `/v1/applications` 报告启用的功能。所有管理接口仍要求主机 Bearer token 与允许的 Origin；项目 deny 和宿主 deny 生效。模型工具还经过主模型/实际模型/模式/来源插件/逐次审批的原有权限交集。直接管理 API 是用户操作入口，没有关联模型路由和会话模式，不把它当作匿名模型工具入口。

| 接口                                                                        | 行为                                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| POST /v1/browser，GET /v1/browser                                           | 创建/列出管理浏览器或显式 CDP 连接                                                             |
| POST /v1/browser/{id}/action，DELETE /v1/browser/{id}                       | 操作/关闭所属项目浏览器                                                                        |
| POST /v1/browser/bridge/pair                                                | 创建仅 browser.control 的配对节点，令牌只返回一次                                              |
| GET /v1/browser/bridge                                                      | 列出连接状态，不返回令牌或其摘要                                                               |
| POST /v1/browser/bridge/{nodeId}/action，DELETE /v1/browser/bridge/{nodeId} | 审核后操作/撤销配对                                                                            |
| WS /v1/nodes/channel                                                        | 专用节点令牌鉴权，任务/结果/取消；不授予主机管理权限                                           |
| GET /v1/computer，POST /v1/computer/action                                  | 状态与真实原生操作                                                                             |
| POST /v1/computer/stop，POST /v1/computer/resume                            | 管理员紧急停止/显式恢复                                                                        |
| POST /v1/office/{operation}                                                 | inspect、create、table、analyze、transform、edit-sheet、replace-text、compose-pdf、preview-pdf |

修改类 body 带 projectId。Node ID、Browser ID、Asset ID 都执行项目归属检查；模型浏览器还绑定 session.id。断开直接 HTTP 客户端会中止其当前应用操作，取消/超时不会继续发布部分资产。关闭浏览器、撤销配对和紧急停止仍能用于清理已撤销权限的资源。

`FoundationClient` 增加 applications、browserOpen/browserAction/browserClose、browserPair/browserBridgeAction/browserRevoke、computerAction/computerStop/computerResume 和 office 方法。已有 client.submit/events 不变；模型工作流仍可连续提交多条回复并继续调用工具。office/browser/computer 的产物进入共享资产库，模型侧发出 artifact.created，继承主事件流与会话效果日志。

## 验收与未覆盖范围

```powershell
npm run verify
npm run verify:host
pwsh -NoProfile -File scripts/package-source.ps1
pwsh -NoProfile -File scripts/verify-source-package.ps1
pwsh -NoProfile -File scripts/verify-source-package.ps1 -HostApplications
```

打包与重建脚本要求 PowerShell 7（pwsh）；原生电脑桥接使用 Windows 自带 PowerShell。核心与宿主报告分别为 verification/report.json 和 application-report.json；逐项依据为 docs/CORE-ACCEPTANCE.json、APPLICATIONS-PLAN.json 以及各自验收报告。宿主实际执行本机 Chromium、已加载的 Chrome 扩展、WebSocket、Win32/UIA/SendInput、格式文件解析/修改、PDF 合成与渲染。模型在测试中使用本地 HTTP/SSE 协议服务，不能据此宣称真实模型策略、推理质量或账单已经验证。

单独列出的限制：真实模型供应商、生产网站/登录/验证码/下载兼容性、实际安装用户浏览器的扩展安装分发、Microsoft Office/LibreOffice 公式重算与全格式视觉保真、Linux/macOS 原生适配器、Docker 引擎及跨 OS 实机迁移。未实现完整办公编辑器/公式引擎/OCR/任意文档转换；未实现原生 OS 沙箱、多租户或分布式控制租约。UI 与 ESP32 继续不开发。持续迭代以具体行为和实际验收作为完成依据。

实现参考的底层接口：[Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)、[Chrome 扩展测试](https://playwright.dev/docs/chrome-extensions)、[Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[UI Automation ValuePattern](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/add-content-to-a-text-box-using-ui-automation)、[pdf-lib PDFDocument](https://pdf-lib.js.org/docs/api/classes/pdfdocument)。
