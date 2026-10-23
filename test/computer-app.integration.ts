import { required } from "./support/payloads.js";
import { z } from "zod";
import type { ComputerAction } from "../src/host/computer/manager.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, until } from "./support/wire-server.js";
import { computerIntegration } from "../src/host/applications.js";
const start = (config = {}) =>
  setup(undefined, config, { integrations: [computerIntegration()] });
async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "foundation-computer-fixture-"),
  );
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./support/computer-fixture.ps1", import.meta.url)),
      "-Directory",
      directory,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let error = "";
  child.stderr.on("data", (v) => {
    error += v.toString();
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const target = await until(async () => {
    if (child.exitCode !== null) throw new Error(error || "Fixture stopped");
    try {
      return z
        .object({ windowId: z.string(), processId: z.number().int() })
        .parse(
          JSON.parse(
            await readFile(path.join(directory, "ready.json"), "utf8"),
          ),
        );
    } catch {
      return undefined;
    }
  });
  return {
    target,
    state: async () =>
      until(async () => {
        try {
          return JSON.parse(
            await readFile(path.join(directory, "state.json"), "utf8"),
          );
        } catch {
          return undefined;
        }
      }),
    close: async () => {
      await writeFile(path.join(directory, "close"), "");
      await closed;
      assert.equal(error, "");
    },
  };
}
test(
  "native Windows application pack uses real UI Automation references for targeted values, invoke, toggle and window capture",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await start(),
      app = await fixture();
    try {
      x.config.computer.allowedProcessIds = [app.target.processId];
      const session = await x.session("code"),
        tools = await x.kernel.toolRegistry.resolve({
          kernel: x.kernel,
          session,
          runId: "native",
          routeId: session.routeId,
        });
      assert.ok(tools.some((t) => t.name === "computer_action"));
      assert.ok(!tools.some((t) => /^(office|browser|node)_/.test(t.name)));
      const run = "native-patterns",
        act = <A extends ComputerAction["action"]>(
          args: Record<string, unknown> & { action: A },
        ) =>
          x.kernel.computer.action(run, x.project.id, {
            ...app.target,
            ...args,
          });
      const windows = await act({ action: "windows" });
      assert.ok(
        windows.windows.some((w: any) => w.windowId === app.target.windowId),
      );
      assert.ok(
        windows.windows.every((w: any) => w.processId === app.target.processId),
      );
      const tree = await act({ action: "tree" });
      const editor = tree.elements.find(
          (e: any) => e.automationId === "fixture_editor",
        ),
        button = tree.elements.find(
          (e: any) => e.automationId === "fixture_commit",
        ),
        check = tree.elements.find(
          (e: any) => e.automationId === "fixture_check",
        ),
        password = tree.elements.find(
          (e: any) => e.automationId === "fixture_password",
        );
      assert.ok(editor && button && check && password);
      assert.equal(password.password, true);
      assert.equal(password.value, null);
      assert.ok(!JSON.stringify(tree).includes("fixture-secret"));
      await act({
        action: "set_value",
        elementId: editor.elementId,
        text: "Actual native 中文 value",
      });
      await act({ action: "invoke", elementId: button.elementId });
      await act({ action: "toggle", elementId: check.elementId });
      const state = await app.state();
      assert.equal(state.text, "Actual native 中文 value");
      assert.equal(state.clicks, 1);
      assert.equal(state.checked, true);
      const choice = tree.elements.find((e: any) => e.name === "Choice Beta"),
        branch = tree.elements.find((e: any) => e.name === "Fixture branch");
      assert.ok(
        choice && branch,
        JSON.stringify(
          tree.elements.map((e: any) => ({
            name: e.name,
            patterns: e.patterns,
          })),
        ),
      );
      await act({ action: "select", elementId: choice.elementId });
      await until(async () => (await app.state()).selected === 1 || undefined);
      await act({ action: "expand", elementId: branch.elementId });
      await until(
        async () => (await app.state()).expanded === true || undefined,
      );
      await act({ action: "collapse", elementId: branch.elementId });
      await until(
        async () => (await app.state()).expanded === false || undefined,
      );
      const screenshot = await act({ action: "screenshot" });
      const bytes = await x.kernel.assets.read(
        screenshot.asset.id,
        x.project.id,
      );
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      await assert.rejects(
        act({
          action: "set_value",
          elementId: "uia:99999999",
          text: "must fail",
        }),
        /stale/,
      );
      await assert.rejects(
        act({ action: "tree", processId: app.target.processId + 1 }),
        /not allowed/,
      );
      x.config.computer.allowedProcessIds = [];
      await assert.rejects(
        act({ action: "tree", processId: app.target.processId + 1 }),
        /another process/,
      );
      const snapshot = await act({ action: "tree" });
      assert.equal(
        required(
          snapshot.elements.find((e) => e.automationId === "fixture_editor"),
        ).value,
        "Actual native 中文 value",
      );
    } finally {
      await app.close();
      await x.close();
    }
  },
);

test(
  "native targeted SendInput keyboard and pointer actions operate on the dedicated fixture and reject out-of-window coordinates",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await start(),
      app = await fixture();
    try {
      const act = <A extends ComputerAction["action"]>(
        args: Record<string, unknown> & { action: A },
      ) =>
        x.kernel.computer.action("input-fixture", x.project.id, {
          ...app.target,
          ...args,
        });
      await act({ action: "focus" });
      const tree = await act({ action: "tree" }),
        editor = tree.elements.find(
          (e: any) => e.automationId === "fixture_editor",
        );
      assert.ok(editor);
      const dx = Math.round(editor.bounds.x - tree.window.left + 15),
        dy = Math.round(editor.bounds.y - tree.window.top + 10);
      await act({ action: "click", x: dx, y: dy });
      await act({ action: "key", key: "CTRL+A" });
      await act({ action: "type", text: "real targeted input 中文" });
      await until(
        async () =>
          (await app.state()).text === "real targeted input 中文" || undefined,
      );
      await assert.rejects(
        act({ action: "click", x: 90000, y: 90000 }),
        /outside target/,
      );
      const button = tree.elements.find(
        (e: any) => e.automationId === "fixture_commit",
      );
      assert.ok(button);
      await act({
        action: "click",
        x: Math.round(button.bounds.x - tree.window.left + 20),
        y: Math.round(button.bounds.y - tree.window.top + 10),
      });
      await until(async () => (await app.state()).clicks === 1 || undefined);
      const panel = tree.elements.find(
          (e: any) => e.automationId === "fixture_panel",
        ),
        px = Math.round(required(panel).bounds.x - tree.window.left + 100),
        py = Math.round(required(panel).bounds.y - tree.window.top + 30);
      const moved = await act({ action: "move", x: px, y: py });
      assert.equal(moved.cursor.x, tree.window.left + px);
      assert.equal(moved.cursor.y, tree.window.top + py);
      await act({ action: "click", x: px, y: py });
      await act({ action: "drag", x: px, y: py, toX: px + 40, toY: py + 20 });
      await act({ action: "scroll", delta: -120 });
      await until(async () => {
        const s = await app.state();
        return (s.downs >= 2 && s.ups >= 2 && s.wheel === -120) || undefined;
      });
    } finally {
      await app.close();
      await x.close();
    }
  },
);

test(
  "computer leases bind project and run, denied/global input fails, cancellation stops native work and emergency stop blocks queues",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await start();
    try {
      const project = x.project.id,
        other = await x.client.project("other");
      await assert.rejects(
        x.kernel.computer.action("run", project, {
          action: "type",
          text: "blocked",
        }),
        /target window/,
      );
      await assert.rejects(
        x.kernel.computer.action("run", project, { action: "screenshot" }),
        /target window/,
      );
      x.kernel.computer.acquire("run", project);
      assert.throws(
        () => x.kernel.computer.acquire("run", other.id),
        /another run or project/,
      );
      assert.throws(
        () => x.kernel.computer.acquire("other", project),
        /another run or project/,
      );
      x.kernel.computer.release("run", other.id);
      assert.equal(x.kernel.computer.status().owner, "run");
      const controller = new AbortController();
      const running = x.kernel.computer.action(
        "run",
        project,
        { action: "inspect" },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(running, /cancelled/);
      const next = x.kernel.computer.action("run", project, {
        action: "inspect",
      });
      const queued = x.kernel.computer.action("run", project, {
        action: "inspect",
      });
      const first = assert.rejects(next, /lease released/),
        second = assert.rejects(queued, /lease released/);
      await x.kernel.computer.emergencyStop();
      await first;
      await second;
      assert.equal(x.kernel.computer.status().queued, 0);
      await assert.rejects(
        x.kernel.computer.action("new", project, { action: "inspect" }),
        /stopped/,
      );
      await x.client.request("POST", "/v1/computer/resume", {});
      const result = await x.client.request("POST", "/v1/computer/action", {
        projectId: project,
        action: "inspect",
      });
      assert.equal(result.ok, true);
      assert.equal(x.kernel.computer.status().owner, undefined);
      x.config.permissions.computer = "deny";
      await assert.rejects(
        x.client.request("POST", "/v1/computer/action", {
          projectId: project,
          action: "inspect",
        }),
        /denied/,
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "active native processes recheck revoked permissions and timeouts without retaining their lease queue",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await start();
    try {
      const running = x.kernel.computer.action("revoke", x.project.id, {
        action: "inspect",
      });
      setTimeout(() => {
        x.config.permissions.computer = "deny";
      }, 40);
      await assert.rejects(running, /disabled/);
      assert.equal(x.kernel.computer.status().queued, 0);
      x.kernel.computer.release("revoke");
      x.config.permissions.computer = "allow";
      x.config.computer.timeoutMs = 100;
      await assert.rejects(
        x.kernel.computer.action("timeout", x.project.id, {
          action: "inspect",
        }),
        /timed out/,
      );
      assert.equal(x.kernel.computer.status().queued, 0);
    } finally {
      await x.close();
    }
  },
);
