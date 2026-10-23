import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./support/wire-server.js";

test("route removal rejects active session references and permits archived references", async () => {
  const x = await setup();
  try {
    x.kernel.agents.list = () => {
      throw new Error(
        "route reference checks must not load the whole agent list",
      );
    };
    const routeId = "removable-route";
    await x.kernel.updateRoutes({
      set: { [routeId]: { ...x.config.routes[x.config.defaultRoutes.chat] } },
    });
    const session = x.kernel.createSession(
      x.project.id,
      "chat",
      "route reference",
      routeId,
    );
    for (const archived of [undefined, false]) {
      x.kernel.store.put("sessions", { ...session, archived });
      await assert.rejects(
        x.kernel.updateRoutes({ remove: [routeId] }),
        /Route is used by a session/,
      );
    }
    x.kernel.updateSession(session.id, { archived: true });
    await x.kernel.updateRoutes({ remove: [routeId] });
    assert.equal(x.config.routes[routeId], undefined);
  } finally {
    await x.close();
  }
});
