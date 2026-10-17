let socket,
  reconnectTimer,
  generation = 0,
  queue = Promise.resolve();
const attached = new Set(),
  activeTasks = new Map();
function checkedUrl(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only HTTP(S) without URL credentials is allowed");
  return url;
}
async function guard(tabId, stop, expectedUrl) {
  stop?.throwIfAborted();
  const { allowedTabs = [] } = await chrome.storage.local.get("allowedTabs");
  if (!Number.isSafeInteger(tabId) || !allowedTabs.includes(tabId))
    throw new Error("Tab was not explicitly allowed by the user");
  const tab = await chrome.tabs.get(tabId);
  checkedUrl(tab.url);
  if (expectedUrl && tab.url !== expectedUrl)
    throw new Error(
      "Tab navigated after host review; inspect it before retrying",
    );
  stop?.throwIfAborted();
  return tab;
}
async function command(tabId, method, params = {}, stop, expectedUrl) {
  await guard(tabId, stop, expectedUrl);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
async function target(args, stop) {
  const { allowedTabs = [] } = await chrome.storage.local.get("allowedTabs");
  const tabId = Number(args.tabId ?? allowedTabs.at(-1));
  await guard(tabId, stop, args.expectedUrl);
  if (args.action === "context") return tabId;
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
    try {
      await command(tabId, "Page.enable", {}, stop, args.expectedUrl);
    } catch (error) {
      attached.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw error;
    }
  }
  return tabId;
}
async function evaluate(tabId, expression, stop, expectedUrl) {
  const result = await command(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    stop,
    expectedUrl,
  );
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  stop?.throwIfAborted();
  return result.result.value;
}
async function act(args, stop) {
  if (args.action === "tabs") {
    const { allowedTabs = [] } = await chrome.storage.local.get("allowedTabs");
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => allowedTabs.includes(t.id) && /^https?:/.test(t.url))
      .map((t) => ({ id: t.id, title: t.title, url: t.url }));
  }
  const tabId = await target(args, stop);
  if (args.action === "context") {
    const tab = await guard(tabId, stop);
    return { tabId, url: tab.url, title: tab.title };
  }
  const expectedUrl = args.expectedUrl;
  const cmd = (method, params = {}, reviewed = true) =>
    command(tabId, method, params, stop, reviewed ? expectedUrl : undefined);
  const evalCode = (source, reviewed = true) =>
    evaluate(tabId, source, stop, reviewed ? expectedUrl : undefined);
  const selector = JSON.stringify(args.selector);
  let navigation = false;
  if (args.action === "navigate") {
    const url = checkedUrl(args.url);
    const result = await cmd("Page.navigate", { url: url.href });
    if (result.errorText) throw new Error(result.errorText);
    navigation = true;
  } else if (["click", "double_click", "hover"].includes(args.action)) {
    const box = await evalCode(
      `(()=>{const e=document.querySelector(${selector});if(!e)throw Error('Element missing');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)throw Error('Element has no clickable bounds');const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))throw Error('Element is obscured');return{x,y}})()`,
    );
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
    });
    if (args.action !== "hover")
      for (
        let count = 1;
        count <= (args.action === "double_click" ? 2 : 1);
        count++
      ) {
        await cmd("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: count,
        });
        await cmd(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: box.x,
            y: box.y,
            button: "left",
            clickCount: count,
          },
          false,
        );
      }
  } else if (args.action === "fill") {
    await evalCode(
      `(()=>{const e=document.querySelector(${selector});if(!e)throw Error('Element missing');if(e.disabled||e.readOnly)throw Error('Element is disabled or read-only');e.focus();e.select?.();return true})()`,
    );
    await cmd("Input.insertText", { text: String(args.text ?? "") });
  } else if (["select", "check", "uncheck"].includes(args.action)) {
    await evalCode(
      `(()=>{const e=document.querySelector(${selector});if(!e)throw Error('Element missing');if(e.disabled)throw Error('Element is disabled');const action=${JSON.stringify(args.action)};if(action==='select'){if(e.tagName!=='SELECT')throw Error('Select element required');const values=${JSON.stringify(args.values || [])};if(values.some(v=>![...e.options].some(o=>o.value===v)))throw Error('Option missing');for(const o of e.options)o.selected=values.includes(o.value);}else{if(e.tagName!=='INPUT'||!['checkbox','radio'].includes(e.type))throw Error('Checkbox or radio required');if(e.checked!==(action==='check'))e.click();}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    );
  } else if (args.action === "press") {
    const keys = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
    };
    const key = String(args.key),
      windowsVirtualKeyCode =
        keys[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    if (!windowsVirtualKeyCode) throw Error("Unsupported key");
    await cmd("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      windowsVirtualKeyCode,
    });
    await cmd(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key, windowsVirtualKeyCode },
      false,
    );
  } else if (args.action === "scroll")
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 300,
      y: 300,
      deltaX: Number(args.x || 0),
      deltaY: Number(args.y ?? 600),
    });
  else if (args.action === "screenshot") {
    const image = await cmd("Page.captureScreenshot", { format: "png" });
    stop?.throwIfAborted();
    return { mime: "image/png", base64: image.data, tabId };
  } else if (args.action === "reload") {
    await cmd("Page.reload");
    navigation = true;
  } else if (args.action === "back" || args.action === "forward") {
    const history = await cmd("Page.getNavigationHistory");
    const entry =
      history.entries[history.currentIndex + (args.action === "back" ? -1 : 1)];
    if (!entry) throw Error("No browser history entry");
    checkedUrl(entry.url);
    await cmd("Page.navigateToHistoryEntry", { entryId: entry.id });
    navigation = true;
  } else if (args.action === "close_tab") {
    await chrome.tabs.remove(tabId);
    return { closed: true, tabId };
  } else if (args.action !== "inspect")
    throw new Error("Unsupported browser action");
  // Navigation and page-triggered changes may replace the document. Host reviews the next action again.
  const snapshot = await evalCode(
    `({url:location.href,title:document.title,text:document.body?.innerText.slice(0,20000),elements:[...document.querySelectorAll('a,button,input,textarea,select')].slice(0,100).map(e=>({tag:e.tagName,id:e.id,name:e.getAttribute('name'),text:e.textContent?.trim().slice(0,120)}))})`,
    !navigation && args.action === "inspect",
  );
  return { ...snapshot, tabId, networkEnforcement: "reviewed-actions-only" };
}
async function detachAll() {
  for (const tabId of [...attached])
    await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
}
async function disconnect(clear = true) {
  generation++;
  clearTimeout(reconnectTimer);
  const previous = socket;
  socket = undefined;
  previous?.close();
  for (const task of activeTasks.values())
    task.abort(new Error("Browser bridge disconnected"));
  activeTasks.clear();
  await detachAll();
  if (clear) await chrome.storage.local.remove(["connection", "allowedTabs"]);
}
async function connect() {
  clearTimeout(reconnectTimer);
  const { connection } = await chrome.storage.local.get("connection");
  if (!connection) return;
  const base = checkedUrl(connection.baseUrl);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw Error("Remote browser bridges require HTTPS");
  if (
    !/^node_[a-f0-9-]+$/.test(connection.nodeId) ||
    !/^[a-f0-9]{64}$/.test(connection.token)
  )
    throw Error("Invalid bridge credentials");
  await disconnect(false);
  const session = generation;
  const url = new URL("/v1/nodes/channel", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () =>
    current.send(
      JSON.stringify({
        type: "auth",
        nodeId: connection.nodeId,
        token: connection.token,
      }),
    );
  current.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "cancel") {
      activeTasks
        .get(message.taskId)
        ?.abort(new Error("Browser task cancelled by host"));
      void detachAll();
      return;
    }
    if (message.type !== "task") return;
    const task = message.task,
      controller = new AbortController();
    activeTasks.set(task.id, controller);
    queue = queue
      .catch(() => {})
      .then(async () => {
        try {
          if (session !== generation)
            throw Error("Browser connection was replaced");
          controller.signal.throwIfAborted();
          if (Date.parse(task.deadline) <= Date.now())
            throw Error("Browser task deadline expired");
          if (task.capability !== "browser.control")
            throw Error("Unsupported node capability");
          const remaining = Date.parse(task.deadline) - Date.now();
          const timer = setTimeout(
            () => controller.abort(new Error("Browser task timed out")),
            Math.max(1, remaining),
          );
          try {
            const result = await act(task.args, controller.signal);
            controller.signal.throwIfAborted();
            if (session === generation && current.readyState === WebSocket.OPEN)
              current.send(
                JSON.stringify({
                  type: "result",
                  taskId: task.id,
                  ok: true,
                  result,
                }),
              );
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          if (session === generation && current.readyState === WebSocket.OPEN)
            current.send(
              JSON.stringify({
                type: "result",
                taskId: task.id,
                ok: false,
                error: error.message,
              }),
            );
        } finally {
          activeTasks.delete(task.id);
        }
      });
  };
  current.onclose = async (event) => {
    if (socket !== current) return;
    if (event.code === 1008) {
      await disconnect(true);
      return;
    }
    await disconnect(false);
    reconnectTimer = setTimeout(() => {
      void connect().catch(() => {});
    }, 3000);
  };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(""))
  ) {
    respond({ ok: false, error: "Extension page required" });
    return false;
  }
  (async () => {
    if (message.type === "connect") {
      const connection = message.connection;
      checkedUrl(connection.baseUrl);
      const tab = await chrome.tabs.get(message.tabId);
      checkedUrl(tab.url);
      const { connection: previous, allowedTabs = [] } =
        await chrome.storage.local.get(["connection", "allowedTabs"]);
      const same =
        previous?.nodeId === connection.nodeId &&
        previous?.baseUrl === connection.baseUrl &&
        previous?.token === connection.token;
      await chrome.storage.local.set({
        connection,
        allowedTabs: [
          ...new Set([...(same ? allowedTabs : []), message.tabId]),
        ],
      });
      await connect();
      respond({ ok: true });
    } else if (message.type === "revoke-tab") {
      const { allowedTabs = [] } =
        await chrome.storage.local.get("allowedTabs");
      await chrome.storage.local.set({
        allowedTabs: allowedTabs.filter((id) => id !== message.tabId),
      });
      attached.delete(message.tabId);
      await chrome.debugger.detach({ tabId: message.tabId }).catch(() => {});
      respond({ ok: true });
    } else if (message.type === "disconnect") {
      await disconnect();
      respond({ ok: true });
    } else respond({ ok: false, error: "Unsupported extension message" });
  })().catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
chrome.debugger.onDetach.addListener(async (target, reason) => {
  attached.delete(target.tabId);
  if (reason === "canceled_by_user") {
    const { allowedTabs = [] } = await chrome.storage.local.get("allowedTabs");
    await chrome.storage.local.set({
      allowedTabs: allowedTabs.filter((id) => id !== target.tabId),
    });
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  const { allowedTabs = [] } = await chrome.storage.local.get("allowedTabs");
  await chrome.storage.local.set({
    allowedTabs: allowedTabs.filter((id) => id !== tabId),
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.allowedTabs)
    for (const id of [...attached])
      if (!(changes.allowedTabs.newValue || []).includes(id)) {
        attached.delete(id);
        void chrome.debugger.detach({ tabId: id }).catch(() => {});
      }
});
chrome.runtime.onStartup.addListener(() => {
  void connect().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  void connect().catch(() => {});
});
chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState > WebSocket.OPEN)
    void connect().catch(() => {});
});
void connect().catch(() => {});
