const form = document.querySelector("form");
chrome.storage.local.get(["connection"]).then(({ connection }) => {
  if (connection)
    for (const key of ["baseUrl", "nodeId", "token"])
      form.elements[key].value = connection[key] || "";
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = Object.fromEntries(new FormData(form));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({
    type: "connect",
    connection,
    tabId: tab.id,
  });
  document.querySelector("#status").textContent = result.ok
    ? "已保存连接，当前标签页已授权。浏览器会显示调试权限提示。"
    : result.error;
});
document.querySelector("#disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  document.querySelector("#status").textContent = "已断开";
});
