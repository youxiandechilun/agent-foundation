// Deliberately small consumer-owned baseline. Additive APIs remain compatible;
// removals or incompatible signatures of these supported paths fail packaging CI.
import {
  Kernel,
  serve,
  type BillingProvider,
  type Config,
  type FoundationEvent,
  type Input,
  type KernelIntegration,
  type Mode,
  type Project,
  type Run,
  type Session,
} from "@local/agent-foundation";
import { FoundationClient } from "@local/agent-foundation/client";
import {
  applicationIntegration,
  browserIntegration,
  computerIntegration,
  officeIntegration,
} from "@local/agent-foundation/host";

type Assert<Compatible extends true> = Compatible;
// Function properties enforce strict parameter compatibility.
interface KernelContract {
  init: () => Promise<void>;
  close: () => Promise<void>;
  createProject: (
    name: string,
    directory?: string,
    options?: { billingAccount?: string },
  ) => Promise<Project>;
  createSession: (
    projectId: string,
    mode?: Mode,
    name?: string,
    routeId?: string,
    agentId?: string,
  ) => Session;
  submit: (sessionId: string, input: Input) => Promise<{ runId: string }>;
  wait: (runId: string) => Promise<Run>;
}
interface ClientContract {
  request: <T = unknown>(
    method: string,
    route: string,
    data?: unknown,
    signal?: AbortSignal,
  ) => Promise<T>;
  project: (name: string, directory?: string) => Promise<Project>;
  session: (
    projectId: string,
    mode?: Mode,
    routeId?: string,
  ) => Promise<Session>;
  submit: (sessionId: string, input: Input) => Promise<{ runId: string }>;
  events: (
    runId: string,
    after?: number,
    signal?: AbortSignal,
  ) => AsyncIterable<FoundationEvent>;
}

export type KernelCompatibility = Assert<
  Kernel extends KernelContract ? true : false
>;
export type ClientCompatibility = Assert<
  FoundationClient extends ClientContract ? true : false
>;
export const kernelConstructor: new (
  config: Config,
  options?: { integrations?: KernelIntegration[]; billing?: BillingProvider },
) => KernelContract = Kernel;
export const clientConstructor: new (
  baseUrl: string,
  token: string,
) => ClientContract = FoundationClient;
export const serveContract: (
  kernel: Kernel,
  token?: string,
) => Promise<{ url: string; close(): Promise<void> }> = serve;

// Existing hosts with one-argument install/two-argument billing callbacks remain valid.
export const legacyIntegration: KernelIntegration = {
  id: "legacy-contract",
  install(_kernel) {},
  close() {},
};
export const legacyBilling: BillingProvider = {
  async authorize(_charge, _signal) {},
  async record(_charge, _outcome) {},
};
export const hostFactories: ((options?: {
  browser?: boolean;
  computer?: boolean;
  office?: boolean;
}) => KernelIntegration)[] = [
  applicationIntegration,
  browserIntegration,
  computerIntegration,
  officeIntegration,
];

// Keep representative caller input independent of today's inferred Config schema.
export const projectInput: Input = {
  text: "consumer input",
  clientMessageId: "stable-id",
  delivery: "start",
  assetIds: [],
};
export type ConfigCompatibility = Assert<
  Config extends {
    dataDir: string;
    workspaceRoots: string[];
    defaultRoutes: { chat: string; code: string; office: string };
  }
    ? true
    : false
>;
