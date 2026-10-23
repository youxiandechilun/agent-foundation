import { Kernel, loadConfig, serve } from "../src/index.js";
import { serverIntegration } from "../src/servers/index.js";

/**
 * 可选启用入口。启动前由宿主进程环境提供 AGENT_SERVER_VAULT_KEY。
 * 本例仅启动本机管理 API；不会创建服务器档案、写入凭据或连接远程服务器。
 */
export async function startWithServers(configFile = "config.json") {
  const config = await loadConfig(configFile);
  const kernel = new Kernel(config, {
    integrations: [
      serverIntegration({ timeoutMs: 30000, maxOutputBytes: 64000 }),
    ],
  });
  try {
    return await serve(kernel);
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
