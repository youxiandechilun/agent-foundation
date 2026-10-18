# Agent 底座执行路径重构与验证

本轮以 2026-10-18 接到任务时的实际工作区为基线，保留此前全部未提交修改。未把之前的查询、缓存、目录整理和 SSE 优化重复计入本轮成果。继续使用既有 TypeScript、Node、SQLite、npm 和 ESM，没有增加运行依赖、替换协议栈或发布远端版本。

工程目录：`C:\Users\32761\Desktop\agent\agent-foundation`

源码基线：`C:\Users\32761\Desktop\agent\agent-foundation\.agent-data-refactor\streamline-20261018-before`

## 规模与两万行目标

统计包含物理空行和注释，文件末尾换行不额外计数；覆盖 TS/MTS/CTS、JS/MJS/CJS、Python、PowerShell、C#、Arduino、HTML 和 Shell。依赖、编译输出、历史快照、临时验证产物、JSON 配置和说明文档不计入。新增测试和正式基准脚本均计入。

| 范围 | 开始 | 结束 | 变化 |
| --- | ---: | ---: | ---: |
| 生产源码 src | 33,535 | 33,516 | −19 |
| 浏览器扩展源码 | 429 | 429 | 0 |
| 测试及辅助代码 | 24,421 | 25,184 | +763 |
| 工程脚本及 SDK 类型样例 | 3,150 | 3,511 | +361 |
| 使用示例 | 545 | 545 | 0 |
| 全部上述自有代码 | 62,080 | 63,185 | +1,105 |

生产源码字节数从 1,133,806 降到 1,132,019，减少 1,787 字节。生产源码与浏览器扩展合计 33,945 行。部分原有密排代码在修改时规范排版，新增边界校验和类型也抵消了删除的重复内容；没有靠删除测试、压缩排版或把代码移到统计范围之外取得数字。

**两万行目标没有达到，全部代码总行数增加。** 单看 src，仍需减少 13,516 行，约为当前源码的 40.3%。目前没有经过验证、能够在保留全部功能及可维护性的前提下完成这一步的方案，不能把本轮的热点性能收益表述成已经大幅精简了整个项目。

主要生产模块占比：扩展系统 8,637 行、可选宿主 5,002 行、core 3,483 行、execution 2,703 行、runtime 2,576 行。协议状态机、授权与任务生命周期、原生执行、浏览器和办公支持承担了其中的大部分功能，单纯移出主目录不会减少总代码量。

## 实际改变

| 范围 | 改变 | 保留或增强的行为 |
| --- | --- | --- |
| 工具调度 | 等待队列从数组改为有序 Set，删除等待项不再线性查找和移动数组 | 资源读写互斥、通配锁、公平性、并发上限、取消与重复释放 |
| 费用 | summary 单遍聚合；文本和媒体共享结算提交流程 | 先记录实际费用，再检查超额；原有事件、错误码和费用返回字段 |
| MCP | 进度 token 索引；集中清理 pending；统一四类目录分页；最多 4 个独立服务器并发读取工具目录 | 目录返回顺序、连接与目录版本绑定、分页限额、重复游标检查和撤权重查 |
| 插件 | IPC 与隔离 stdio 共用 Worker；复用安装校验和哈希；共享目录只设置一次权限 | 两种运行通道均保留；输入按 unknown 校验；快照完整性检查；媒体方法保持 this |
| Provider | 复用内容块序列化；筛选有效文本回退路由 | 连续 Anthropic assistant 合并不再修改历史 providerState；无效的非文本尾部路由不再压制最后文本路由重试 |
| 上下文与文件匹配 | 直接计算 Unicode 码点的 UTF-8 宽度；复用文本提取；逆序命中最后一条忽略规则 | 原有分块边界、补充平面字符、孤立代理项、忽略规则优先级 |
| 会话分支 | ID 和父子邻接索引替代反复扫描 | O(n) 遍历；同项目边界、返回顺序和循环关系终止 |
| 工具与 HTTP | 复用服务 Zod 规则；进程工具以泛型代替局部 any；路径只解析一次；统一路由响应结果 | 名称、权限、资源锁、脱敏与响应状态保持；二进制及 SSE 继续直接输出 |
| 网络 | 网页和浏览器共用保留地址和主机匹配规则；浏览器代理共用连接登记及关闭清理；DNS 回调使用 Node 的明确类型 | 私网拒绝、通配主机、代理认证和连接期授权约束 |
| 记忆检索 | 只保留前 k 个候选的原始记录，最终再反序列化结果；无法进入前 k 的候选不再排序 | 稳定同分顺序、项目/命名空间/过期过滤；维度不匹配的大量记录也会让出事件循环并响应取消 |

工具 schema 的预期变化仅为：session_read 增加服务原有的 after=0、limit=10 默认值说明及安全整数上限；server_upload 的 required 字段顺序改变。JSON Schema 校验不应用默认值，不改变调用输入；服务原有 refinement 继续执行。

旧 container-worker 的四处验收来源引用已更新到合并后的 worker；需求与测试证据保持原样。

## 性能测量

同一个 Node v22.22.0 进程比较基线和当前真实编译代码，每版本预热一次，交替执行五轮，取中位数。各场景都断言结果。数字受 JIT、GC、系统负载和文件缓存影响，不作为测试阈值。

| 场景 | 基线中位数 | 当前中位数 |
| --- | ---: | ---: |
| 取消 20,000 个等待项 | 87.34 ms | 23.11 ms |
| 顺序授予 20,000 个等待项 | 164.54 ms | 64.00 ms |
| 40 次汇总 100,000 条费用记录 | 139.10 ms | 42.50 ms |
| 5,000 条记忆、每条约 7.5 KiB、取前 100 条 | 101.66 ms | 75.49 ms |

费用场景调用实际 summary 实现，但以固定内存记录排除数据库 I/O。记忆场景使用真实临时 SQLite 文件和本地 HTTP embedding 服务，前 100 条为并列最高分，随后候选不会改变结果；它刻意测量大量候选不入选时的收益。向量维度较高、候选持续进入前 k 或数据库 I/O 占主导时，比例会不同。以上都不是完整 Agent 任务或真实模型的端到端加速倍率。

## 验证与边界

- 核心基线：419/419；最终核心：430/430，无失败、取消或跳过。
- 最终宿主集成：32/32，无失败、取消或跳过，实际覆盖 Chromium、浏览器扩展、Office 文件、Windows UI Automation 和测试专用窗口的输入控制。
- 核心与宿主构建、编译后核心与宿主冒烟通过；新增测试严格 TypeScript 检查、改动 Worker 与基准脚本的 strict checkJs 通过。
- 三个 SDK 入口的运行时导出为 54/2/4 项、声明导出为 136/3/5 项，前后无增删。能力枚举、模式定义及启用各应用后的工具工厂目录无删除；目录数量不等于每种模式经过权限过滤后都能执行全部工具。
- SDK dry-run 清单通过项目既有清单校验，包含唯一共享插件 Worker；未改写旧发布包，没有对外发布。
- 独立审核覆盖本轮 26 个源码文件差异；3,000 组 Provider 序列化差分、100 组各 120 步的调度随机轨迹通过，未发现需要阻止交付的高置信功能回归。

验证使用本机协议服务，不是付费模型质量评估；不能据此宣称推理质量或实际任务成功率已经提高。只在当前 Windows 与 Node v22.22.0 上执行，本轮没有重测 Linux/macOS、其他 Node 版本、真实外部厂商 MCP/OAuth 或 Docker 运行时。SDK 导出名称和工具目录核对不能证明所有第三方调用的完整签名与行为兼容，也没有重新做离线安装消费者全套验收。

最初受限环境禁止回环网络连接，基线因此出现 EACCES；原失败日志保留，随后允许本机测试服务的完整基线通过。没有为绕过这个环境限制修改生产逻辑。

## 复现和证据

在工程目录运行既有入口：

```powershell
npm run build
npm test
npm run build:host
npm run test:host
node test/smoke.compiled.mjs
node test/smoke-host.compiled.mjs
node scripts/benchmark-runtime-streamline.mjs --baseline=.agent-data-refactor/streamline-20261018-before/dist --current=dist
node scripts/benchmark-memory-ranking.mjs --baseline=.agent-data-refactor/streamline-20261018-before/dist --current=dist
```

主要交付证据：

- 汇总验证报告：`C:\Users\32761\Desktop\agent\agent-foundation\verification\streamline-report.json`
- 规模、文件哈希与本轮变化：`C:\Users\32761\Desktop\agent\agent-foundation\verification\streamline-source-metrics.json`
- 运行时基准：`C:\Users\32761\Desktop\agent\agent-foundation\verification\streamline-runtime-benchmark.json`
- 记忆检索基准：`C:\Users\32761\Desktop\agent\agent-foundation\verification\streamline-memory-benchmark.json`
- SDK 导出与目录兼容核对：`C:\Users\32761\Desktop\agent\agent-foundation\verification\streamline-public-exports.json`
- 独立代码审核：`C:\Users\32761\Desktop\agent\agent-foundation\verification\streamline-review.json`

本轮使用 streamline 前缀区分验证资料；必须使用既有固定输出路径的检查，在保存本轮输出后恢复之前的报告，避免把不同轮次的证据混在一起。个人规则源、技能缓存与历史技能副本均未修改。
