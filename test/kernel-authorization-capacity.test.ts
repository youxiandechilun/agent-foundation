import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { setup, until } from "./support/wire-server.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test(
  "a timed-out real audit rule retains its lease after the allowed run completes without publishing a late audit",
  { timeout: 15000 },
  async () => {
    const pending = deferred();
    let started = 0;
    const x = await setup(
      (body) =>
        body.messages.at(-1)?.role === "tool"
          ? { text: "done" }
          : { calls: [{ name: "audit_timeout_mutation", args: {} }] },
      {
        limits: { maxConcurrentTools: 1 },
        securityAudit: { mode: "enforce", timeoutMs: 30, onError: "allow" },
        permissions: { "files.write": "allow", exec: "allow" },
      },
    );
    try {
      x.kernel.securityAudit.register({
        id: "slow-audit-rule",
        stages: ["tool"],
        async evaluate(request) {
          if (
            request.stage === "tool" &&
            request.toolName === "audit_timeout_mutation"
          ) {
            if (started++ === 0) await pending.promise;
          }
          return [];
        },
      });
      x.kernel.toolRegistry.register("audit-timeout-capacity", () => [
        {
          name: "audit_timeout_mutation",
          description: "complete after audit policy permits a timeout",
          parameters: { type: "object" },
          risk: "write",
          capabilities: ["files.write"],
          execute: async () => ({ content: [] }),
        },
      ]);
      const first = await x.client.submit((await x.session("code")).id, {
        text: "first",
      });
      assert.equal((await x.kernel.wait(first.runId)).status, "completed");
      assert.equal(x.kernel.scheduler.state.active, 1);
      const audits = x.kernel.store.list("security-audits", {
        runId: first.runId,
      });
      assert.match(JSON.stringify(audits), /timeout/);
      const second = await x.client.submit((await x.session("code")).id, {
        text: "second",
      });
      await until(() => x.kernel.scheduler.state.queued === 1 || undefined);
      assert.equal(started, 1);
      pending.reject(new Error("late failure after audit timeout"));
      assert.equal((await x.kernel.wait(second.runId)).status, "completed");
      assert.equal(started, 2);
      assert.deepEqual(
        x.kernel.store.list("security-audits", { runId: first.runId }),
        audits,
      );
      await until(() => x.kernel.scheduler.state.active === 0 || undefined);
    } finally {
      pending.resolve();
      await x.close();
      await rm(x.root, { recursive: true, force: true });
    }
  },
);

for (const source of ["integration", "audit"] as const)
  for (const resourceLocks of [false, true])
    for (const lateFailure of [false, true])
      test(
        `real Kernel ${source} authorization retains ${resourceLocks ? "resource write locks" : "execution capacity"} after cancellation until late ${lateFailure ? "rejection" : "completion"}`,
        { timeout: 15000 },
        async () => {
          const pending = deferred();
          const entered = deferred();
          let active = 0,
            peak = 0,
            started = 0,
            executions = 0;
          let firstSignal: AbortSignal | undefined;
          const observe = async (signal: AbortSignal | undefined) => {
            const first = started++ === 0;
            active++;
            peak = Math.max(peak, active);
            try {
              if (first) {
                firstSignal = signal;
                entered.resolve();
                await pending.promise;
              }
            } finally {
              active--;
            }
          };
          const x = await setup(
            (body) =>
              body.messages.at(-1)?.role === "tool"
                ? { text: "done" }
                : { calls: [{ name: "authorized_mutation", args: {} }] },
            {
              limits: { maxConcurrentTools: resourceLocks ? 2 : 1 },
              permissions: { "files.write": "allow", exec: "allow" },
              securityAudit: {
                mode: source === "audit" ? "enforce" : "off",
                timeoutMs: 10000,
              },
            },
            {
              integrations:
                source === "integration"
                  ? [
                      {
                        id: "real-authorization-capacity",
                        async authorize(context, tool) {
                          if (tool.name === "authorized_mutation")
                            await observe(context.signal);
                        },
                      },
                    ]
                  : [],
            },
          );
          try {
            if (source === "audit")
              x.kernel.securityAudit.register({
                id: "capacity-rule",
                stages: ["tool"],
                async evaluate(request, signal) {
                  if (
                    request.stage === "tool" &&
                    request.toolName === "authorized_mutation"
                  )
                    await observe(signal);
                  return [];
                },
              });
            x.kernel.toolRegistry.register("authorization-capacity", () => [
              {
                name: "authorized_mutation",
                description: "record an authorized effect",
                parameters: { type: "object" },
                risk: "write",
                capabilities: ["files.write"],
                scheduling: resourceLocks
                  ? {
                      parallelSafe: true,
                      resources: () => [
                        {
                          key: "shared-authorization-resource",
                          access: "write",
                        },
                      ],
                    }
                  : undefined,
                execute: async () => {
                  executions++;
                  return { content: [] };
                },
              },
            ]);
            const firstSession = await x.session("code");
            const secondSession = await x.session("code");
            const first = await x.client.submit(firstSession.id, {
              text: "first authorized tool",
            });
            await entered.promise;
            x.kernel.cancel(first.runId);
            assert.equal(
              (await x.kernel.wait(first.runId)).status,
              "cancelled",
            );
            assert.equal(firstSignal?.aborted, true);
            assert.equal(active, 1);
            assert.equal(x.kernel.scheduler.state.active, 1);
            assert.equal(executions, 0);
            const second = await x.client.submit(secondSession.id, {
              text: "second authorized tool",
            });
            await until(
              () => x.kernel.scheduler.state.queued === 1 || undefined,
            );
            assert.equal(
              started,
              1,
              "a new real authorization callback cannot bypass the occupied lease",
            );
            if (lateFailure)
              pending.reject(new Error("late authorization failure"));
            else pending.resolve();
            assert.equal(
              (await x.kernel.wait(second.runId)).status,
              "completed",
            );
            assert.equal(started, 2);
            assert.equal(peak, 1);
            assert.equal(executions, 1);
            assert.equal(
              x.kernel.store
                .replay(first.runId)
                .some((event) => event.type === "tool.started"),
              false,
              "a late authorization result never starts the cancelled effect",
            );
            await until(
              () => x.kernel.scheduler.state.active === 0 || undefined,
            );
          } finally {
            pending.resolve();
            await x.close();
            await rm(x.root, { recursive: true, force: true });
          }
        },
      );

for (const source of ["integration", "audit"] as const)
  for (const lateFailure of [false, true])
    test(
      `real process control ${source} authorization retains its lease until late ${lateFailure ? "rejection" : "completion"}`,
      { timeout: 15000 },
      async () => {
        const pending = deferred();
        const entered = deferred();
        let active = 0,
          peak = 0,
          started = 0;
        const observe = async () => {
          const first = started++ === 0;
          active++;
          peak = Math.max(peak, active);
          try {
            if (first) {
              entered.resolve();
              await pending.promise;
            }
          } finally {
            active--;
          }
        };
        const x = await setup(
          undefined,
          {
            limits: { maxConcurrentTools: 1 },
            securityAudit: {
              mode: source === "audit" ? "enforce" : "off",
              timeoutMs: 10000,
            },
          },
          {
            integrations:
              source === "integration"
                ? [
                    {
                      id: "control-authorization-capacity",
                      async authorize(_context, tool) {
                        if (tool.name === "exec_list") await observe();
                      },
                    },
                  ]
                : [],
          },
        );
        try {
          if (source === "audit")
            x.kernel.securityAudit.register({
              id: "control-capacity-rule",
              stages: ["tool"],
              async evaluate(request) {
                if (
                  request.stage === "tool" &&
                  request.toolName === "exec_list"
                )
                  await observe();
                return [];
              },
            });
          const session = await x.session("code");
          const first = x.kernel.processAction(session.id, "list", {});
          await entered.promise;
          x.kernel.cancel(first.runId);
          assert.equal((await x.kernel.wait(first.runId)).status, "cancelled");
          assert.equal(active, 1);
          assert.equal(x.kernel.scheduler.state.active, 1);
          const second = x.kernel.processAction(session.id, "list", {});
          await until(() => x.kernel.scheduler.state.queued === 1 || undefined);
          assert.equal(started, 1);
          if (lateFailure)
            pending.reject(new Error("late control authorization failure"));
          else pending.resolve();
          assert.equal((await x.kernel.wait(second.runId)).status, "completed");
          assert.equal(started, 2);
          assert.equal(peak, 1);
          assert.equal(
            x.kernel.store
              .replay(first.runId)
              .some((event) => event.type === "process.action.completed"),
            false,
          );
          await until(() => x.kernel.scheduler.state.active === 0 || undefined);
        } finally {
          pending.resolve();
          await x.close();
          await rm(x.root, { recursive: true, force: true });
        }
      },
    );
