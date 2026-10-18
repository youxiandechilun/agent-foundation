import type { z } from "zod";
import type { ApiContext, ApiResult } from "./shared.js";

type RouteContext = ApiContext & { id: string };
type Action = (context: RouteContext) => unknown;
type Route = Action | { action: Action; status: number };
type RouteKey = `${"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} ${string}`;

/** Exact paths take precedence; :id captures only the resource's entity segment. */
export function apiRoutes(definitions: Record<RouteKey, Route>) {
  const routes = new Map<string, Route>(Object.entries(definitions));
  return async (context: ApiContext): Promise<ApiResult | undefined> => {
    const [version, resource, id = "", ...tail] = context.parts;
    if (version !== "v1") return;
    const key = `${context.method} ${context.parts.slice(1).join("/")}`;
    const route =
      routes.get(key) ??
      (id
        ? routes.get(
            `${context.method} ${[resource, ":id", ...tail].join("/")}`,
          )
        : undefined);
    if (!route) return;
    const action = typeof route === "function" ? route : route.action;
    return {
      data: await action({ ...context, id }),
      ...(typeof route === "function" ? {} : { status: route.status }),
    };
  };
}

export function status(status: number, action: Action): Route {
  return { action, status };
}

/** Schemas are constructed once, while parsing and authorization happen per request. */
export function input<S extends z.ZodType>(
  schema: S,
  action: (context: RouteContext, value: z.output<S>) => unknown,
): Action {
  return async (context) => action(context, schema.parse(await context.json()));
}
