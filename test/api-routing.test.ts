import assert from "node:assert/strict";
import { test } from "node:test";
import { FoundationHttpError } from "../src/client.js";
import type { MemoryEntry } from "../src/contracts.js";
import { setup } from "./support/wire-server.js";

test("exact management routes reject unknown suffixes without changing resources", async () => {
  const x = await setup();
  try {
    const skill = await x.client.request<{ id: string }>("POST", "/v1/skills", {
      source:
        "---\nname: preserved\ndescription: routing fixture\n---\nKeep the original instructions.",
    });
    const plugin = await x.client.request<{ id: string }>(
      "POST",
      "/v1/plugins",
      {
        manifest: {
          schemaVersion: 1,
          id: "preserved",
          name: "preserved",
          version: "1.0.0",
          entry: "index.mjs",
        },
        files: {
          "index.mjs": "export async function execute(){return {content:[]}}",
        },
      },
    );
    const memory = await x.client.request<MemoryEntry>("POST", "/v1/memories", {
      projectId: x.project.id,
      content: "Preserve this memory.",
    });
    await x.client.request("POST", "/v1/agents", {
      id: "preserved",
      name: "preserved",
      mode: "chat",
      instructions: "Preserve this agent.",
    });
    await x.client.request("POST", "/v1/modes", {
      id: "preserved",
      description: "routing fixture",
      instructions: "Preserve this mode.",
    });
    await x.client.request("POST", "/v1/policies", {
      id: "preserved",
      effect: "allow",
      capabilities: ["files.read"],
    });
    await x.client.request("PUT", "/v1/routes/preserved", x.config.routes.text);
    const resources = [
      ["skills", skill.id],
      ["plugins", plugin.id],
      ["memories", memory.id],
      ["agents", "preserved"],
      ["modes", "preserved"],
      ["policies", "preserved"],
      ["routes", "preserved"],
    ];
    const notFound = (error: unknown) =>
      error instanceof FoundationHttpError && error.status === 404;
    for (const [resource, id] of resources) {
      for (const suffix of ["unknown", "export/unknown"]) {
        await assert.rejects(
          x.client.request("DELETE", `/v1/${resource}/${id}/${suffix}`),
          notFound,
        );
      }
    }
    await assert.rejects(
      x.client.request("PATCH", `/v1/skills/${skill.id}/unknown`, {
        enabled: false,
      }),
      notFound,
    );
    assert.equal(x.kernel.skills.get(skill.id).enabled, true);
    assert.equal(
      x.kernel.memory.get(memory.id, x.project.id).content,
      memory.content,
    );
    assert.equal(x.kernel.agents.get("preserved").id, "preserved");
    assert.equal(x.kernel.modes.get("preserved").id, "preserved");
    assert.ok(x.kernel.store.find("policies", "preserved"));
    assert.ok(x.config.routes.preserved);
    assert.equal((await x.kernel.plugins.verify(plugin.id)).verified, true);
    for (const [resource, id] of resources) {
      await x.client.request("DELETE", `/v1/${resource}/${id}`);
    }
    assert.equal(x.kernel.store.find("memories", memory.id), undefined);
    assert.equal(x.kernel.store.find("policies", "preserved"), undefined);
    assert.equal(x.config.routes.preserved, undefined);
  } finally {
    await x.close();
  }
});

test("static routes win over IDs, response status and fresh validation remain intact", async () => {
  const x = await setup();
  try {
    const memory = await x.client.request<MemoryEntry>("POST", "/v1/memories", {
      projectId: x.project.id,
      content: "Exported content",
    });
    const exported = await x.client.request<{
      format: string;
      memories: MemoryEntry[];
    }>("GET", `/v1/memories/export?projectId=${x.project.id}`);
    assert.equal(exported.format, "foundation-memory-v1");
    assert.equal(exported.memories[0].id, memory.id);
    await assert.rejects(
      x.client.request("POST", "/v1/memories/import", {
        projectId: x.project.id,
        entries: [],
        extra: true,
      }),
      (error: unknown) =>
        error instanceof FoundationHttpError && error.status === 400,
    );
    await assert.rejects(
      x.client.request("GET", "/v1/memories/import"),
      (error: unknown) =>
        error instanceof FoundationHttpError && error.status === 404,
    );
    const session = await x.session();
    const before = x.kernel.store.count("sessions");
    for (const suffix of ["fork/extra", "role-review/extra/decision"]) {
      await assert.rejects(
        x.client.request("POST", `/v1/sessions/${session.id}/${suffix}`, {}),
        (error: unknown) =>
          error instanceof FoundationHttpError && error.status === 404,
      );
    }
    assert.equal(x.kernel.store.count("sessions"), before);
    const fork = await x.client.request<{ id: string }>(
      "POST",
      `/v1/sessions/${session.id}/fork`,
      {},
    );
    assert.notEqual(fork.id, session.id);
    const response = await fetch(x.api.url + "/v1/agents", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-host-token-12345678901234567890",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "response-status",
        name: "response-status",
        mode: "chat",
        instructions: "fixture",
      }),
    });
    assert.equal(response.status, 201);
    await response.json();
    x.config.permissions["memory.write"] = "deny";
    const proposal = x.kernel.store.put("memory-proposals", {
      id: "proposal",
      projectId: x.project.id,
      status: "pending",
    });
    await assert.rejects(
      x.client.request("POST", `/v1/memory-proposals/${proposal.id}/resolve`, {
        allow: true,
      }),
      (error: unknown) =>
        error instanceof FoundationHttpError && error.status === 403,
    );
    assert.equal(
      x.kernel.store.get<{ status: string }>("memory-proposals", proposal.id)
        .status,
      "pending",
    );
  } finally {
    await x.close();
  }
});
