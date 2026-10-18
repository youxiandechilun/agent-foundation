# 可选服务器连接插件

服务器插件由宿主显式注册 `serverIntegration()`，支持密码、私钥及私钥口令、严格的 SSH 主机 SHA256 指纹校验、远程命令、SFTP 与关联服务器的持久事实。默认底座不会自行连接任何服务器。编码、办公模式使用相同工具契约，是否可调用仍由 route allowlist、能力权限和当前会话的项目范围决定。

这是宿主信任的 `KernelIntegration`，工具来源声明为 `builtin / servers`，由 `network`、`exec`、`files`、`memory` 等能力约束；它不使用源码 Plugin 的安装、信任或隔离语义，也不依赖源码 Plugin 总开关。

## 启用

Node.js 兼容范围与 SDK 一致，见 [SDK.md](SDK.md)。`ssh2` 是可选运行依赖，仅实际 SSH 操作时动态加载；使用 `--omit=optional` 安装后，档案和事实管理仍能使用，SSH 操作会明确报告缺少 transport。

使用内置 CLI 时，可通过 `npm start -- --servers` 显式启用插件（先执行 `npm run build`）。宿主集成方式如下：

```ts
import {
  Kernel,
  loadConfig,
  serve,
  serverIntegration,
} from "@local/agent-foundation";

const kernel = new Kernel(await loadConfig("config.json"), {
  integrations: [
    serverIntegration({ timeoutMs: 30000, maxOutputBytes: 64000 }),
  ],
});
const api = await serve(kernel);
// 宿主停止时 await api.close()，同时取消未结束的 SSH/SFTP。
```

可复制的项目示例在 `examples/servers.ts`。可选配置包含 `vaultPath`、`vaultKeyEnv`、`timeoutMs`、`maxOutputBytes`。默认 vault 位于数据目录的 `server-vault/credentials.json`，默认主密钥环境变量为 `AGENT_SERVER_VAULT_KEY`，必须是 32 字节的标准 Base64 字符串。默认命令超时 30 秒、输出上限 64000 字节；单次工具可以缩短超时，不能突破宿主上限。

通过宿主密钥管理系统或启动环境提供主密钥；例如在 PowerShell 为当前进程生成一次密钥：

```powershell
$env:AGENT_SERVER_VAULT_KEY = node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64'))"
```

上面的命令仅演示生成方式。已有 vault 必须恢复原主密钥，不能每次启动重新生成。不得把主密钥写在数据目录、服务器档案、普通记忆、提示词、脚本日志或迁移包中。当前版本不提供主密钥轮换与找回；备份密文和密钥需要由宿主分别管理。JavaScript 字符串不能保证从进程内存中彻底擦除；本模块保护静态存储与接口暴露范围。POSIX 会设置 vault 目录 `0700`、文件 `0600`；Windows 需要宿主为运行账号配置适当 NTFS ACL。

## 宿主管理 API

以下接口继承已有 `/v1` Bearer Token 鉴权，属于同一用户的可信宿主管理面。Agent 没有凭据写入工具，也不应获知 API Token。接口返回普通业务 JSON；错误沿用底座的 `error.code / error.message`。

| 方法与路径                           | 请求或行为                                                               |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `GET /v1/servers`                    | 列出档案；可用 `?projectId=` 筛选                                        |
| `POST /v1/servers`                   | 新建档案，返回 `201`                                                     |
| `GET /v1/servers/:id`                | 档案与最近 100 条事实；可用 `?projectId=` 约束项目                       |
| `PUT /v1/servers/:id`                | 完整替换可编辑档案字段；保留 ID、凭据引用与创建时间                      |
| `DELETE /v1/servers/:id`             | 删除档案、关联事实及对应密文                                             |
| `PUT /v1/servers/:id/credentials`    | 仅宿主提交 `{password?, privateKey?, passphrase?}`；整体替换该服务器凭据 |
| `DELETE /v1/servers/:id/credentials` | 删除凭据密文，清除引用与存在标记                                         |
| `POST /v1/servers/probe`             | 提交 `{host, port?}`，只握手探测公钥并返回 SHA256 指纹和 `trusted:false` |
| `GET /v1/servers/:id/facts`          | 最近 100 条事实；可按项目筛选                                            |
| `POST /v1/servers/:id/facts`         | 宿主提交 `{projectId,text}`，保存未核验的 `user` 来源备注                |

档案请求示例：

```json
{
  "name": "生产应用服务器",
  "host": "192.0.2.10",
  "port": 22,
  "username": "operator",
  "environment": "production",
  "tags": ["api"],
  "projectIds": ["已有项目 ID"],
  "hostFingerprint": "SHA256:由独立可信渠道核对后的43位Base64摘要"
}
```

该示例里的指纹是占位说明，不能直接提交。服务器创建、更新时验证 `projectIds` 均实际存在，且不重复；档案最多 1000 项。SSH 不会自动信任探测到的指纹，宿主应先通过可信渠道核对，再在档案中明确保存。指纹不符则拒绝连接，不自动降级或重试。探测请求在取得公钥后立即拒绝握手，不认证、不执行命令、不写入信任档案。

密码和私钥以 AES-256-GCM 独立随机 IV 加密，使用服务器 ID 与凭据引用作为 AAD。SQLite 只保存档案和 `credentialRef / credentialKinds`，不保存明文凭据。管理 API、Agent 工具和档案导出只提供存在状态与引用。普通会话迁移不会携带服务器凭据；恢复目标必须单独配置插件、服务器档案、密文和外部主密钥。

## Agent 工具与协作

| 工具              | 行为与权限                                                                             |
| ----------------- | -------------------------------------------------------------------------------------- |
| `server_list`     | 列出当前会话项目可访问的服务器；`memory.read`                                          |
| `server_read`     | 档案和当前项目最近 100 条事实；`memory.read`                                           |
| `server_exec`     | 执行 SSH 命令并记录观察结果；`network + exec`，风险为 `execute`                        |
| `server_upload`   | 从当前项目 Asset 覆盖远程绝对路径文件；`network + exec + files.read`，风险为 `execute` |
| `server_download` | 远程文件下载成当前项目 Asset；`network + files.write`，风险为 `read`                   |
| `server_remember` | 保存 `agent` 来源的未核验备注；`memory.write`                                          |

所有工具以 `session.projectId` 检查服务器可访问范围；不能通过工具参数选择另一项目。上传只接受已有且属于当前项目的 `assetId`，不接受宿主文件路径；下载大小受底座 `maxUploadBytes` 限制。远程路径必须为绝对路径，但不模拟远程 chroot。实际远程权限由 SSH 账号和服务器本身决定；本模块未实现 sudo、跳板机、代理、交互式终端、端口转发或多租户凭据授权。

共享调度器使用 `server:<id>` 资源：命令、上传和记忆写入取得写访问，读取和下载取得读访问。因此同一底座内多个 Agent 的部署命令不会同时写同一服务器。宿主更新档案、写入或删除凭据、删除服务器时，会先取消该 Store 中该服务器的已有操作，等本地操作结束后再提交变更；变更期间拒绝开始新操作。取消不能证明远端进程已经停止。另一底座进程及人工 SSH 会话不参与此调度，跨进程部署协调由上层负责。

命令输出合计受字节上限约束，stdout/stderr 按 UTF-8 返回并脱敏已配置的凭据。取消、超时、输出超限或命令发出后断线会停止本地连接，并保留 `unknown` 结果；这不能证明远程进程已退出。观察到远程退出事件才记为 `completed`，`exitCode` 可以为非零；调用方应根据实际退出码判断命令是否成功。认证或主机验证失败记为 `failed`。所有路径都不自动重新执行命令。SFTP 上传被中断时远程文件可能部分写入，不能当作原子部署。

事实存放在独立的 `server-facts` Store 记录中，包含服务器 ID、项目 ID、来源、创建时间。命令观察包含命令、状态、退出码、输出、开始结束时间和截断标记；仅观察到退出的结果带 `verifiedAt`。这只证明观察到的那次命令结果，不保证用户或模型对结果的解释正确。`server_remember` 和宿主备注始终是 `note`，没有 `verifiedAt`，不能自行声称已核验。服务器相关事实不会自动混入其他服务器或另一项目。

## 验证范围与边界

`npm test -- --filter=servers` 使用 `ssh2.Server` 启动本机协议服务，以临时主机密钥和测试凭据验证 API 鉴权、probe 不认证、密码及加密私钥登录、错误密码及口令、错误指纹、项目授权、密文与不回显、取消、断线、输出上限、变更撤销已有操作，以及基于项目 Asset 的 SFTP 往返、取消、路径和大小边界。可选依赖缺失时这些协议集成项明确跳过。它不是实际用户服务器验收，未连接或部署任何真实远程机器。
