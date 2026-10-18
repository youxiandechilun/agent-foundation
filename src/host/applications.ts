import type { KernelIntegration } from "../runtime/registry.js";
import { createApplicationIntegration } from "./integration.js";
export { browserCapabilities, hostApplicationAccess } from "./access.js";

export interface ApplicationOptions {
  browser?: boolean;
  computer?: boolean;
  office?: boolean;
}

/** Importing this entry does not load optional application engines. */
export function applicationIntegration(
  options: ApplicationOptions = {},
): KernelIntegration {
  return createApplicationIntegration(options, "applications");
}
export const browserIntegration = () =>
  applicationIntegration({ browser: true, computer: false, office: false });
export const computerIntegration = () =>
  applicationIntegration({ browser: false, computer: true, office: false });
export const officeIntegration = () =>
  applicationIntegration({ browser: false, computer: false, office: true });
