import {
  Kernel,
  parseConfig,
  serve,
  type Config,
  type Session,
  type AgentDefinition,
  type TeamBinding,
  type TeamBindingInput,
  type KernelIntegration,
} from "@local/agent-foundation";
import { FoundationClient } from "@local/agent-foundation/client";
import {
  applicationIntegration,
  type ApplicationOptions,
} from "@local/agent-foundation/host";

const config: Config = parseConfig({
  routes: {
    text: {
      kind: "text",
      adapter: "openai-completions",
      model: "model",
      baseUrl: "http://localhost:11434/v1",
    },
  },
  defaultRoutes: { chat: "text", code: "text", office: "text" },
});
const hostOptions: ApplicationOptions = { office: true };
const integration: KernelIntegration = applicationIntegration(hostOptions);
const kernel = new Kernel(config, { integrations: [integration] });
const definition: AgentDefinition = {
  id: "writer",
  name: "Writer",
  instructions: "Write and check.",
  mode: "code",
  routeId: "text",
  skillIds: [],
  toolAllowlist: ["file_write"],
  maxSteps: 64,
  memoryNamespace: "writer",
};
kernel.agents.put(definition);
const bindingInput: TeamBindingInput = {
  teamId: "team",
  kind: "task",
  goal: "Complete delivery",
};
const binding: TeamBinding = {
  ...bindingInput,
  constraints: [],
  acceptance: [],
  maxTurns: 12,
  revision: 1,
};
const project = await kernel.createProject("consumer");
const session: Session = kernel.createSession(
  project.id,
  "code",
  "SDK",
  undefined,
  definition.id,
);
const api = await serve(kernel, "type-test-local-token-123456");
const client = new FoundationClient(api.url, "type-test-local-token-123456");
await client.submit(session.id, { text: binding.goal });
await api.close();
