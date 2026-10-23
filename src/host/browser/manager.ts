import { captureRedaction } from "../../core/util.js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type ElementHandle,
  type Frame,
  type Dialog,
} from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../../core/config.js";
import type { Session } from "../../contracts.js";
import { Assets } from "../../storage/assets.js";
import { Store } from "../../storage/store.js";
import { id, invariant, hash, abortable } from "../../core/util.js";
import { BrowserNetwork, validateBrowserUrl } from "./network.js";
import { browserInputFields } from "./input.js";
export { validateBrowserUrl } from "./network.js";

export const browserActionSchema = z
  .object({
    action: z.enum([
      "tabs",
      "new_tab",
      "navigate",
      "inspect",
      "click",
      "double_click",
      "fill",
      "press",
      "scroll",
      "back",
      "forward",
      "reload",
      "upload",
      "download",
      "screenshot",
      "close_tab",
      "select",
      "check",
      "uncheck",
      "hover",
      "wait",
    ]),
    tabId: z.string().max(100).optional(),
    frameId: z.string().max(100).optional(),
    ref: z.string().max(100).optional(),
    ...browserInputFields,
    assetId: z.string().optional(),
    values: z.array(z.string().max(1000)).max(100).optional(),
    state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
    dialog: z
      .object({
        accept: z.boolean(),
        promptText: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserAction = z.infer<typeof browserActionSchema>;
interface Tab {
  id: string;
  page: Page;
  refs: Map<string, ElementHandle>;
  frames: Map<string, Frame>;
  dialog?: BrowserAction["dialog"];
  lastDialog?: { type: string; message: string; accepted: boolean };
  closeListener: () => void;
  dialogListener: (dialog: Dialog) => void;
}
interface BrowserElement {
  ref: string;
  tag: string;
  id: string;
  name: string | null;
  role: string | null;
  type: string | null;
  label: string | null;
  text: string;
}
interface BrowserSession {
  id: string;
  projectId: string;
  owner: string;
  profile?: string;
  context: BrowserContext;
  browser?: Browser;
  external: boolean;
  tabs: Map<string, Tab>;
  network?: BrowserNetwork;
  controller: AbortController;
  pageListener: (page: Page) => void;
}
/** Optional application service. The core does not import Chromium or this module. */
export class BrowserManager {
  private sessions = new Map<string, BrowserSession>();
  private queues = new Map<string, Promise<unknown>>();
  private profiles = new Set<string>();
  private opening = 0;
  private lifetime = new AbortController();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly assets: Assets,
    private authorize?: (projectId: string, action?: BrowserAction) => void,
  ) {
    captureRedaction(this);
  }
  private enabled() {
    this.lifetime.signal.throwIfAborted();
    invariant(
      this.config.browser.enabled && this.config.permissions.browser !== "deny",
      "Browser capability disabled",
      403,
    );
  }
  list(projectId?: string) {
    return [...this.sessions.values()]
      .filter((s) => !projectId || s.projectId === projectId)
      .map((s) => ({
        id: s.id,
        projectId: s.projectId,
        owner: s.owner,
        external: s.external,
        networkEnforcement: s.external
          ? "reviewed-actions-only"
          : "pinned-dns-proxy",
        tabs: [...s.tabs.values()].map((t) => ({
          id: t.id,
          url: t.page.url(),
        })),
      }));
  }
  async open(
    projectId: string,
    owner: string,
    url = "about:blank",
    cdpEndpoint?: string,
    signal?: AbortSignal,
  ) {
    this.enabled();
    this.store.project(projectId);
    this.authorize?.(projectId);
    invariant(
      typeof owner === "string" && owner.length > 0 && owner.length <= 200,
      "Invalid browser owner",
    );
    invariant(
      this.sessions.size + this.opening < this.config.browser.maxSessions,
      "Browser session capacity reached",
      429,
    );
    if (owner !== "direct-user") {
      const source = this.store.find<Session>("sessions", owner);
      if (source)
        invariant(
          source.projectId === projectId,
          "Browser owner belongs to another project",
          403,
        );
    }
    const stop = AbortSignal.any([
      this.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    stop.throwIfAborted();
    this.opening++;
    let context: BrowserContext | undefined,
      browser: Browser | undefined,
      network: BrowserNetwork | undefined,
      profile: string | undefined,
      session: BrowserSession | undefined;
    try {
      await validateBrowserUrl(url, this.config);
      stop.throwIfAborted();
      this.enabled();
      if (cdpEndpoint) {
        invariant(
          this.config.browser.cdpEndpoints.includes(cdpEndpoint),
          "CDP endpoint is not configured",
          403,
        );
        const endpoint = new URL(cdpEndpoint);
        invariant(
          ["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol) &&
            !endpoint.username &&
            !endpoint.password,
          "Invalid reviewed CDP endpoint",
          403,
        );
        browser = await chromium.connectOverCDP(cdpEndpoint, {
          timeout: this.config.browser.timeoutMs,
          noDefaults: true,
        });
        invariant(
          browser.contexts().length,
          "Connected browser has no default context",
        );
        context = browser.contexts()[0];
      } else {
        const candidate = path.join(
          this.config.dataDir,
          "browser-profiles",
          hash(projectId + "\n" + owner),
        );
        invariant(
          !this.profiles.has(candidate),
          "Browser profile is already open",
          409,
        );
        profile = candidate;
        this.profiles.add(profile);
        await mkdir(profile, { recursive: true });
        network = await new BrowserNetwork(this.config, () =>
          this.authorize?.(projectId, { action: "inspect" }),
        ).start();
        stop.throwIfAborted();
        context = await chromium.launchPersistentContext(profile, {
          headless: this.config.browser.headless,
          ...(this.config.browser.executablePath
            ? { executablePath: this.config.browser.executablePath }
            : {}),
          ...(this.config.browser.channel &&
          this.config.browser.channel !== "chromium"
            ? { channel: this.config.browser.channel }
            : {}),
          acceptDownloads: true,
          serviceWorkers: "block",
          proxy: network.proxy,
          args: [
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ],
        });
        context.setDefaultTimeout(this.config.browser.timeoutMs);
        await context.route("**/*", async (route) => {
          try {
            this.authorize?.(projectId);
            await validateBrowserUrl(route.request().url(), this.config);
            await route.continue();
          } catch {
            await route.abort("blockedbyclient").catch(() => undefined);
          }
        });
      }
      stop.throwIfAborted();
      session = {
        id: id("browser"),
        projectId,
        owner,
        profile,
        context,
        browser,
        external: !!browser,
        tabs: new Map(),
        network,
        controller: new AbortController(),
        pageListener: () => undefined,
      };
      const register = (page: Page) => {
        if ([...session!.tabs.values()].some((t) => t.page === page)) return;
        if (session!.tabs.size >= this.config.browser.maxTabs) {
          if (!session!.external) void page.close().catch(() => undefined);
          return;
        }
        const tab: Tab = {
          id: id("tab"),
          page,
          refs: new Map(),
          frames: new Map(),
          closeListener: () => undefined,
          dialogListener: () => undefined,
        };
        tab.closeListener = () => {
          session!.tabs.delete(tab.id);
          void this.clearRefs(tab);
        };
        tab.dialogListener = (dialog) => {
          const response = tab.dialog;
          tab.lastDialog = {
            type: dialog.type(),
            message: dialog.message().slice(0, 4000),
            accepted: response?.accept === true,
          };
          void (
            response?.accept
              ? dialog.accept(response.promptText)
              : dialog.dismiss()
          ).catch(() => undefined);
        };
        page.once("close", tab.closeListener);
        page.on("dialog", tab.dialogListener);
        session!.tabs.set(tab.id, tab);
      };
      session.pageListener = register;
      if (!session.external || this.config.browser.cdpAllowExistingTabs) {
        context.pages().forEach(register);
        context.on("page", register);
      }
      this.sessions.set(session.id, session);
      let tab = [...session.tabs.values()][0];
      if (!tab) {
        const page = await context.newPage();
        register(page);
        tab = [...session.tabs.values()].find((t) => t.page === page)!;
      }
      if (url !== "about:blank")
        await abortable(
          tab.page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: this.config.browser.timeoutMs,
          }),
          stop,
        );
      stop.throwIfAborted();
      return this.list(projectId).find((s) => s.id === session!.id)!;
    } catch (error) {
      if (session)
        await this.closeSession(session.id, projectId).catch(() => undefined);
      else {
        if (browser) await browser.close().catch(() => undefined);
        else await context?.close().catch(() => undefined);
        await network?.close();
        if (profile) this.profiles.delete(profile);
      }
      throw error;
    } finally {
      this.opening--;
    }
  }
  private get(browserId: string, projectId: string, owner?: string) {
    const session = this.sessions.get(browserId);
    invariant(
      session && session.projectId === projectId,
      "Browser not found for project",
      404,
    );
    invariant(
      !owner || session.owner === owner,
      "Browser belongs to another session",
      403,
    );
    return session;
  }
  private async clearRefs(tab: Tab) {
    const refs = [...tab.refs.values()];
    tab.refs.clear();
    await Promise.allSettled(refs.map((e) => e.dispose()));
  }
  private frame(tab: Tab, args: BrowserAction) {
    const frame = args.frameId
      ? tab.frames.get(args.frameId)
      : tab.page.mainFrame();
    invariant(
      frame && !frame.isDetached(),
      "Browser frame is stale or belongs to another tab",
      409,
    );
    return frame;
  }
  private target(tab: Tab, args: BrowserAction) {
    if (args.ref) {
      const element = tab.refs.get(args.ref);
      invariant(
        element,
        "Element reference is stale or belongs to another tab",
        409,
      );
      return element;
    }
    invariant(args.selector, "An element reference or selector is required");
    return this.frame(tab, args).locator(args.selector).first();
  }
  private async snapshot(
    session: BrowserSession,
    tab: Tab,
    args: BrowserAction,
  ) {
    await this.clearRefs(tab);
    const frame = this.frame(tab, args);
    if (frame.url() !== "about:blank")
      await validateBrowserUrl(frame.url(), this.config);
    for (const frame of tab.page.frames())
      if (![...tab.frames.values()].includes(frame))
        tab.frames.set(id("frame"), frame);
    for (const [key, frame] of tab.frames)
      if (frame.isDetached()) tab.frames.delete(key);
    const elements: BrowserElement[] = [],
      query = frame.locator(
        'a,button,input,textarea,select,[role="button"],[role="checkbox"],[contenteditable="true"]',
      );
    const count = Math.min(
      await query.count(),
      this.config.browser.maxElements,
    );
    for (let i = 0; i < count; i++) {
      const element = await query.nth(i).elementHandle();
      if (!element) continue;
      if (!(await element.isVisible())) {
        await element.dispose();
        continue;
      }
      const ref = id("element"),
        data = await element.evaluate((e) => ({
          tag: e.tagName.toLowerCase(),
          id: e.id,
          name: e.getAttribute("name"),
          role: e.getAttribute("role"),
          type: e.getAttribute("type"),
          label: e.getAttribute("aria-label"),
          text: (e.textContent || "").trim().slice(0, 160),
        }));
      tab.refs.set(ref, element);
      elements.push({ ref, ...data });
    }
    return {
      browserId: session.id,
      tabId: tab.id,
      url: tab.page.url(),
      title: await tab.page.title(),
      snapshot: (
        await frame
          .locator("body")
          .ariaSnapshot({ timeout: this.config.browser.timeoutMs })
      ).slice(0, this.config.browser.maxSnapshotChars),
      elements,
      frames: [...tab.frames].map(([id, frame]) => ({
        id,
        url: frame.url(),
        name: frame.name(),
      })),
      ...(tab.lastDialog ? { dialog: tab.lastDialog } : {}),
    };
  }
  action<A extends BrowserAction["action"]>(
    browserId: string,
    projectId: string,
    input: Omit<BrowserAction, "action"> & { action: A },
    signal?: AbortSignal,
    owner?: string,
  ): Promise<BrowserActionResult<A>>;
  action(
    browserId: string,
    projectId: string,
    input: BrowserAction | Record<string, unknown>,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<BrowserActionResult>;
  async action(
    browserId: string,
    projectId: string,
    input: BrowserAction | Record<string, unknown>,
    signal?: AbortSignal,
    owner?: string,
  ) {
    this.enabled();
    const args = browserActionSchema.parse(input);
    this.authorize?.(projectId, args);
    this.get(browserId, projectId, owner);
    signal?.throwIfAborted();
    const previous = this.queues.get(browserId) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        this.enabled();
        this.authorize?.(projectId, args);
        signal?.throwIfAborted();
        const session = this.get(browserId, projectId, owner),
          stop = AbortSignal.any([
            session.controller.signal,
            this.lifetime.signal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(this.config.browser.timeoutMs),
          ]);
        let cleanup: Promise<unknown> | undefined;
        const abort = () => {
          cleanup = this.closeSession(browserId, projectId).catch(
            () => undefined,
          );
        };
        stop.addEventListener("abort", abort, { once: true });
        try {
          const result = await abortable(
            this.perform(session, args, stop),
            stop,
          );
          this.authorize?.(projectId, args);
          return result;
        } finally {
          stop.removeEventListener("abort", abort);
          if (cleanup) await cleanup;
        }
      });
    this.queues.set(browserId, operation);
    void operation
      .finally(() => {
        if (this.queues.get(browserId) === operation)
          this.queues.delete(browserId);
      })
      .catch(() => undefined);
    return operation;
  }
  private async perform(
    session: BrowserSession,
    args: BrowserAction,
    stop: AbortSignal,
  ) {
    if (args.action === "tabs") {
      const listed = this.list(session.projectId).find(
        (s) => s.id === session.id,
      );
      invariant(listed, "Browser session not found", 404);
      return listed;
    }
    if (args.action === "new_tab") {
      invariant(
        session.tabs.size < this.config.browser.maxTabs,
        "Browser tab capacity reached",
        429,
      );
      if (args.url) await validateBrowserUrl(args.url, this.config);
      stop.throwIfAborted();
      const page = await session.context.newPage();
      session.pageListener(page);
      if (args.url)
        await page.goto(args.url, {
          waitUntil: "domcontentloaded",
          timeout: this.config.browser.timeoutMs,
        });
      const tab = [...session.tabs.values()].find((t) => t.page === page)!;
      return this.snapshot(session, tab, { action: "inspect" });
    }
    const tab = args.tabId
      ? session.tabs.get(args.tabId)
      : [...session.tabs.values()][0];
    invariant(tab, "Browser tab not found", 404);
    if (args.action !== "close_tab" && args.action !== "navigate")
      await validateBrowserUrl(tab.page.url(), this.config);
    if (args.frameId)
      await validateBrowserUrl(this.frame(tab, args).url(), this.config);
    const timeout = { timeout: this.config.browser.timeoutMs };
    tab.dialog = args.dialog;
    delete tab.lastDialog;
    try {
      if (args.action === "navigate") {
        invariant(args.url, "URL required");
        await validateBrowserUrl(args.url, this.config);
        await tab.page.goto(args.url, {
          ...timeout,
          waitUntil: "domcontentloaded",
        });
      } else if (args.action === "click" || args.action === "double_click") {
        const element = this.target(tab, args);
        if (args.action === "click") await element.click(timeout);
        else await element.dblclick(timeout);
      } else if (args.action === "fill") {
        invariant(args.text !== undefined, "Text required");
        await this.target(tab, args).fill(args.text, timeout);
      } else if (args.action === "press") {
        invariant(args.key, "Key required");
        if (args.ref || args.selector)
          await this.target(tab, args).press(args.key, timeout);
        else await tab.page.keyboard.press(args.key);
      } else if (args.action === "hover")
        await this.target(tab, args).hover(timeout);
      else if (args.action === "select") {
        invariant(args.values, "Values required");
        await this.target(tab, args).selectOption(args.values, timeout);
      } else if (args.action === "check")
        await this.target(tab, args).check(timeout);
      else if (args.action === "uncheck")
        await this.target(tab, args).uncheck(timeout);
      else if (args.action === "wait") {
        invariant(args.selector, "Wait requires a selector");
        await this.frame(tab, args)
          .locator(args.selector)
          .waitFor({ ...timeout, state: args.state || "visible" });
      } else if (args.action === "scroll")
        await tab.page.mouse.wheel(args.x ?? 0, args.y ?? 600);
      else if (args.action === "back")
        await tab.page.goBack({ ...timeout, waitUntil: "domcontentloaded" });
      else if (args.action === "forward")
        await tab.page.goForward({ ...timeout, waitUntil: "domcontentloaded" });
      else if (args.action === "reload")
        await tab.page.reload({ ...timeout, waitUntil: "domcontentloaded" });
      else if (args.action === "upload") {
        invariant(
          this.config.permissions["files.read"] !== "deny",
          "File uploads are disabled",
          403,
        );
        invariant(args.assetId, "Upload requires an owned asset");
        const asset = this.assets.owned(args.assetId, session.projectId),
          buffer = await this.assets.read(asset.id, session.projectId, stop);
        stop.throwIfAborted();
        await this.target(tab, args).setInputFiles(
          { name: asset.name, mimeType: asset.mime, buffer },
          timeout,
        );
      } else if (args.action === "download") {
        invariant(
          this.config.permissions["files.write"] !== "deny",
          "File downloads are disabled",
          403,
        );
        const waiting = tab.page.waitForEvent("download", timeout);
        void waiting.catch(() => undefined);
        await this.target(tab, args).click(timeout);
        const download = await waiting;
        try {
          const stream = await download.createReadStream();
          invariant(stream, "Browser download unavailable");
          return {
            asset: await this.assets.createStream(
              session.projectId,
              download.suggestedFilename(),
              stream,
              "artifact",
              undefined,
              stop,
            ),
            tabId: tab.id,
          };
        } finally {
          await download.cancel().catch(() => undefined);
          await download.delete().catch(() => undefined);
        }
      } else if (args.action === "screenshot") {
        const bytes =
          args.ref || args.selector
            ? await this.target(tab, args).screenshot(timeout)
            : await tab.page.screenshot({ ...timeout, fullPage: false });
        stop.throwIfAborted();
        return {
          asset: await this.assets.create(
            session.projectId,
            "browser-screenshot.png",
            bytes,
            "artifact",
            "image/png",
            stop,
          ),
          tabId: tab.id,
          url: tab.page.url(),
        };
      } else if (args.action === "close_tab") {
        await tab.page.close();
        return { closed: true, tabId: tab.id };
      } else invariant(args.action === "inspect", "Unsupported browser action");
      stop.throwIfAborted();
      return this.snapshot(session, tab, args);
    } finally {
      delete tab.dialog;
    }
  }
  async closeSession(browserId: string, projectId: string, owner?: string) {
    const session = this.get(browserId, projectId, owner);
    this.sessions.delete(browserId);
    session.controller.abort(new Error("Browser session released"));
    session.context.off("page", session.pageListener);
    for (const tab of session.tabs.values()) {
      tab.page.off("close", tab.closeListener);
      tab.page.off("dialog", tab.dialogListener);
      await this.clearRefs(tab);
    }
    try {
      if (session.external) await session.browser?.close();
      else await session.context.close();
    } finally {
      await session.network?.close();
      if (session.profile) this.profiles.delete(session.profile);
    }
    return { released: true };
  }
  async close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("Browser host closed"));
    await Promise.allSettled(
      [...this.sessions.values()].map((s) =>
        this.closeSession(s.id, s.projectId),
      ),
    );
  }
}
type Performed = Awaited<ReturnType<BrowserManager["perform"]>>;
export type BrowserActionResult<
  A extends BrowserAction["action"] = BrowserAction["action"],
> = A extends "tabs"
  ? Extract<Performed, { tabs: unknown }>
  : A extends "close_tab"
    ? Extract<Performed, { closed: boolean }>
    : A extends "screenshot" | "download"
      ? Extract<Performed, { asset: unknown }>
      : Extract<Performed, { snapshot: string }>;
