import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_ROUTE_SLOTS,
  REQUIRED_ROUTE_SLOTS,
  parseConfig,
  type Config,
  type Route,
} from "../config.js";
import { atomicWrite, invariant } from "../util.js";

export interface RouteChange {
  set?: Record<string, Route>;
  remove?: string[];
  defaultRoutes?: Record<string, string | null>;
}

const routesFile = (config: Config) =>
  path.join(config.dataDir, "runtime-routes.json");

/** Apply routes saved by an earlier updateRoutes; a missing file keeps the configuration. */
export async function loadPersistedRoutes(config: Config): Promise<void> {
  let text: string;
  try {
    text = await readFile(routesFile(config), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const persisted = z
    .object({ routes: z.unknown(), defaultRoutes: z.unknown() })
    .parse(JSON.parse(text));
  const updated = parseConfig({
    ...config,
    routes: persisted.routes,
    defaultRoutes: persisted.defaultRoutes,
  });
  config.routes = updated.routes;
  config.defaultRoutes = updated.defaultRoutes;
}

/**
 * Validate `change` against `config`, persist the result and apply it in place.
 * `inUse` names why a route cannot be removed, or returns undefined when it can.
 */
export async function changeRoutes(
  config: Config,
  change: RouteChange,
  inUse: (routeId: string) => string | undefined,
) {
  const routes = { ...config.routes, ...change.set },
    defaultRoutes: Record<string, string | undefined> = {
      ...config.defaultRoutes,
    };
  for (const name of change.remove || []) {
    const reason = inUse(name);
    invariant(!reason, reason!, 409);
    delete routes[name];
  }
  for (const [slot, value] of Object.entries(change.defaultRoutes || {})) {
    invariant(
      (DEFAULT_ROUTE_SLOTS as readonly string[]).includes(slot),
      "Unknown default route slot",
    );
    if (value === null) {
      invariant(
        !(REQUIRED_ROUTE_SLOTS as readonly string[]).includes(slot),
        "Required default route cannot be removed",
      );
      delete defaultRoutes[slot];
    } else defaultRoutes[slot] = value;
  }
  const validated = parseConfig({ ...config, routes, defaultRoutes });
  await atomicWrite(
    routesFile(config),
    JSON.stringify(
      { routes: validated.routes, defaultRoutes: validated.defaultRoutes },
      null,
      2,
    ),
  );
  config.routes = validated.routes;
  config.defaultRoutes = validated.defaultRoutes;
  return {
    routeIds: Object.keys(validated.routes),
    defaultRoutes: validated.defaultRoutes,
  };
}
