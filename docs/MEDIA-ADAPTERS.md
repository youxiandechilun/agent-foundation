# 图片 / 视频的统一媒体适配器

图片、视频厂商的字段、上传方式、签名、异步任务不同，因此内核只认统一契约，不把某家厂商的格式固化成产品接口。用户侧统一创建 Job；供应商差异在配置映射、源码适配器或源码插件中实现。

## 统一请求与结果

类型定义：`src/contracts.ts`、`src/media/adapters.ts`。

```typescript
interface MediaRequest {
  schemaVersion: 1;
  kind: "image" | "video";
  operation: "generate" | "edit" | "variation";
  prompt: string;
  inputAssets: string[];
  parameters: {
    width?: number;
    height?: number;
    durationSeconds?: number;
    aspectRatio?: string;
    seed?: number;
    count?: number;
    [key: string]: unknown;
  };
}
interface AdapterResult {
  remoteId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress?: number; // 统一用 0..1；厂商百分比由适配器换算
  outputs?: MediaOutput[];
  error?: string;
  state?: Record<string, unknown>; // 轮询需要的非秘密状态
}
interface MediaOutput {
  type: "image" | "video" | "text";
  mime?: string;
  url?: string;
  base64?: string;
  text?: string;
  assetId?: string;
}
```

prompt/kind 以外层创建 Job 的参数为准；request 传 operation/inputAssets/parameters。调用示例：

```json
{
  "projectId": "project_...",
  "kind": "video",
  "routeId": "my-video",
  "prompt": "让附件中的产品缓慢旋转",
  "idempotencyKey": "客户端生成的稳定唯一键",
  "request": {
    "operation": "generate",
    "inputAssets": ["asset_..."],
    "parameters": { "durationSeconds": 5, "aspectRatio": "16:9" }
  }
}
```

同项目+同幂等键+同内容返回既有 Job；同键改变内容会拒绝，不隐式再次付费提交。输入资产必须属于该项目。

## 三种扩展方式

### 1. JSON HTTP 字段映射

适用于 JSON 提交、HTTP 查询、字段结构不同但没有复杂签名/文件上传协议的厂商：

```json
{
  "kind": "video",
  "adapter": "media-http",
  "model": "实际模型 ID",
  "baseUrl": "https://your-provider.example.invalid/v1",
  "apiKeyEnv": "VIDEO_API_KEY",
  "submitPath": "/tasks",
  "pollPath": "/tasks/{id}",
  "cancelPath": "/tasks/{id}/cancel",
  "allowedOutputHosts": ["your-cdn.example.invalid"],
  "mapping": {
    "requestTemplate": {
      "engine": "{{model}}",
      "input": { "prompt": "{{prompt}}", "settings": "{{parameters}}" }
    },
    "id": "task.id",
    "status": "task.state",
    "progress": "task.progress",
    "outputs": "task.files",
    "statuses": {
      "PENDING": "queued",
      "PROCESSING": "running",
      "SUCCEEDED": "completed",
      "FAILED": "failed",
      "CANCELLED": "cancelled"
    }
  }
}
```

以上是需替换为实际厂商字段的配置示例，`.invalid` 不可作为真实接口。模板完整 `{{parameters}}` 保持对象类型；嵌入字符串内的模板转为字符串。可用字段为 model 和统一请求字段，可通过点号引用如 parameters.width。响应点路径不支持脚本求值；outputs 需要为 URL 字符串、对象或数组，对象字段支持 type/mime/url/base64/b64_json/text。复杂输出转换、上传、HMAC、multipart 或多阶段工作流使用源码适配器。

内置 `image-json` 发送 model/prompt，加 requestDefaults 和 parameters，可选 images data URL；读取 `data:[{b64_json|url}]`，同步完成。需要 response_format 的厂商可在 requestDefaults 设置。它不代表所有图像编辑端点兼容。

内置 `video-job` 读取 `{id,status,progress,output|outputs,error}`，异步查询 pollPath，cancelPath 可选。两者均要求供应商确实实现相应格式，不能只换 baseUrl 就声称已接入。

### 2. 注册源码 MediaAdapter

完整可扩展接口：

```typescript
interface MediaAdapter {
  id: string;
  capabilities: {
    kinds: ("image" | "video")[];
    operations: ("generate" | "edit" | "variation")[];
    cancellation: boolean;
    recovery: boolean;
  };
  submit(
    request: MediaRequest,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
  poll?(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
  cancel?(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
  recover?(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
}
```

context 提供 route、signal、idempotencyKey、request(path,body?,method?)、input(assetId)。input 返回项目校验后的 `{mime,base64,name}`。request 添加路由鉴权和 Idempotency-Key，限制返回体积和超时，拒绝重定向和绝对路径。需要不同传输方式时在可信适配器中使用 fetch，同时保留 signal/幂等/限额规则。

注册例子见 `examples/media-adapter.ts`，其 HTTP 路径、响应转换必须按实际供应商实现：

```typescript
const kernel = new Kernel(config);
kernel.media.adapters.register(myVendorAdapter);
// 路由 adapter=media-http，mediaAdapterId=myVendorAdapter.id。
await serve(kernel);
```

Route 的 mediaAdapterId 优先于其内置 adapter（custom-media 除外）。已编译的自定义类需要由宿主机启动代码注册，默认 CLI 不会随意 import 路径。异步适配器必须返回 remoteId 并实现 poll；恢复实现必须查询既有任务，不能再次 submit。

### 3. 安装源码插件

插件 manifest 声明 `mediaAdapters:["vendor_video"]`，入口导出：

```javascript
export const mediaAdapters = {
  vendor_video: {
    async submit(request, context) {
      // 使用真实供应商调用，并转为 AdapterResult。
      // context.inputs 为 [{assetId,mime,name,base64}]，支持实际编辑/参考输入。
      // 凭据从 manifest.envRefs 引入的 process.env 读取。
    },
    async poll({ remoteId, state }, context) {
      /* 查询既有任务 */
    },
    async cancel({ remoteId, state }, context) {
      /* 供应商真实取消 */
    },
    async recover({ remoteId, state }, context) {
      /* 仅核查，不重新提交 */
    },
  },
};
```

此处是签名说明，方法体需要实际实现；系统没有“缺实现返回成功”的分支。插件每次方法调用在新子进程中执行，不能依赖进程内持久变量；需要保留的数据放 AdapterResult.state。context 包含 baseUrl/model/idempotencyKey/parameters（路由 requestDefaults）/inputs；secret 不应写入返回 state。

路由配置 `adapter:"custom-media",mediaAdapterId:"vendor_video"`。安装后默认禁用，必须复核源码哈希再启用。Agent 调用还需 media 和 plugin 能力同时通过。插件信任/安装过程见 [EXTENSIONS.md](EXTENSIONS.md)。

## 生命周期、取消和恢复

Job 为 queued/running/completed/failed/cancelled/unknown。适配器的状态描述供应商已知结果，unknown 由宿主机在请求丢失、轮询超时、取消结果不明或重启时记录。remoteId/state/progress 持久保存。

completed 必须有实际 outputs。base64 和允许下载域名的 URL 会写为 Asset，保留原 MIME 或根据实际字节探测 PNG/JPEG/WebP/MP4/WebM；未知字节为 application/octet-stream。非允许下载域名的 HTTP(S) URL 仅保留引用，不自动下载；下载不携带模型凭据、不跟随重定向，并遵守 maxUploadBytes。

取消先中止本地传输/轮询，有 remoteId 和适配器 cancel 时再请求远端。只有明确返回 cancelled 才确认远端已取消。同步图片提交超时且没有远端 ID 时无法自动核查，不能伪装取消成功。已经 completed/failed/cancelled 的任务不会因重复 cancel 被改写为 unknown。

`POST /v1/jobs/{id}/recover` 只允许 unknown 且具有 remoteId，适配器必须实现 recover。恢复后持续查询原任务；不会再次 POST 创建任务。供应商不支持取消或无法按幂等键核查时，系统保留这个限制，而不推断停止计费。

新任务同时保存提交时的路由配置快照，恢复和取消使用原端点/模型/路径，不随运行时路由修改而改变；快照只保存凭据变量引用。旧版没有快照的任务仍依赖现存路由。适配器注册实现和源码插件的版本由维护者控制，路由快照并不冻结插件的后续升级。

路由 timeoutMs 约束整个适配器执行，包括提交与轮询。即使自定义异步适配器不配合 AbortSignal，内核也会停止等待并保留不确定状态；这不能撤销其已发生的远端操作。

## 验证范围

`test/media-nodes.test.ts` 用真实 HTTP 协议服务检查提交/轮询/取消/恢复、字段映射、资产保存与避免重复提交。生产代码无测试供应商、固定媒体输出或伪成功分支。当前未配置用户的真实图片/视频凭据，因此协议测试不代表任何具体厂商生成质量或账单行为已验收。

## 0.4.0 验证与能力声明

源码插件同时声明 mediaCapabilities，结构见 EXTENSIONS.md；取消和恢复不再默认全部支持。完成结果拒绝空媒体、仅用文字冒充图像和跨项目 assetId。输入及输出有合计字节预算，base64 必须规范编码；声明的资产读取会核对摘要。

接受有效的远端 URL 是保留供应商引用，不是验证该 URL 的内容或生成质量。实际付费图片/视频供应商仍列为外部未联调。
