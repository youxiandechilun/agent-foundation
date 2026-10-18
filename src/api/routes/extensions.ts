import { z } from "zod";
import { invariant } from "../../core/util.js";
import { apiRoutes, input, status } from "../route-table.js";

export const extensionRoutes = apiRoutes({
  "GET skills": ({ k }) => ({ skills: k.skills.list() }),
  "GET skills/:id": ({ k, id }) => k.skills.get(id),
  "GET skills/:id/export": ({ k, id }) => k.skills.export(id),
  "GET skills/:id/resource": ({ k, id, url }) => {
    const name = url.searchParams.get("path");
    invariant(name, "resource path required");
    return k.skills.resource(id, name);
  },
  "POST skills": status(
    201,
    input(
      z
        .object({
          source: z.string().optional(),
          directory: z.string().optional(),
          resources: z
            .record(
              z.string(),
              z.union([
                z.string(),
                z
                  .object({
                    encoding: z.enum(["utf8", "base64"]),
                    data: z.string(),
                  })
                  .strict(),
              ]),
            )
            .optional(),
        })
        .strict(),
      ({ k }, value) => {
        invariant(
          Boolean(value.directory) !== Boolean(value.source),
          "Provide source or directory",
        );
        if (value.directory) return k.skills.installDirectory(value.directory);
        invariant(value.source, "Provide source or directory");
        return k.skills.install(value.source, value.resources);
      },
    ),
  ),
  "PATCH skills/:id": input(
    z.object({ enabled: z.boolean() }).strict(),
    ({ k, id }, value) => k.skills.enable(id, value.enabled),
  ),
  "DELETE skills/:id": ({ k, id }) => {
    k.skills.remove(id);
    return { deleted: true };
  },
  "GET plugins": ({ k }) => ({ plugins: k.plugins.list() }),
  "GET plugins/:id/export": ({ k, id }) => k.plugins.export(id),
  "POST plugins/:id/verify": ({ k, id }) => k.plugins.verify(id),
  "POST plugins": status(201, async ({ k, json }) => {
    const value = await json();
    return value.directory
      ? k.plugins.installDirectory(value.directory)
      : k.plugins.install(value.manifest, value.files);
  }),
  "PATCH plugins/:id": input(
    z
      .object({
        enabled: z.boolean(),
        trustedHash: z.string().optional(),
      })
      .strict(),
    ({ k, id }, value) =>
      k.plugins.enable(id, value.enabled, value.trustedHash),
  ),
  "DELETE plugins/:id": ({ k, id }) => {
    k.plugins.remove(id);
    return { deleted: true };
  },
});
