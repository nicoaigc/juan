/* 打开组件测试页，分别点开下拉 / 日历 / 确认框并截图。 */
import { readFileSync, writeFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9346";
const PAGE = "file:///D:/workspace/ai/shijuan/.workbuddy/tmp/ui_components_test.html";

const targets = await (await fetch(CDP + "/json/list")).json();
let page = targets.find(t => t.type === "page" && !/devtools/.test(t.url));
if (!page) {
  page = await (await fetch(CDP + "/json/new?" + encodeURIComponent("about:blank"), { method: "PUT" })).json();
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pend = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}
async function shot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log("saved", file);
}
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: PAGE });
await new Promise(r => setTimeout(r, 800));

// 1. 点开下拉（⚠️ UI.select 会把占位元素就地替换掉，只能按 .dd 类名找）
await evalJs(`document.querySelector(".dd .dd-btn").click(); true`);
await new Promise(r => setTimeout(r, 200));
await shot("D:/workspace/ai/shijuan/.workbuddy/tmp/ui_test_dd.png");

// 2. 收起下拉，点开日历
await evalJs(`document.body.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true})); true`);
await evalJs(`document.getElementById("dt").click(); true`);
await new Promise(r => setTimeout(r, 200));
await shot("D:/workspace/ai/shijuan/.workbuddy/tmp/ui_test_cal.png");

// 3. 收起日历，弹确认框
await evalJs(`document.getElementById("show-confirm").click(); true`);
await new Promise(r => setTimeout(r, 300));
await shot("D:/workspace/ai/shijuan/.workbuddy/tmp/ui_test_modal.png");

// 4. 验证 confirm 交互：点确定 resolve true；Esc resolve false
await evalJs(`window.__r = "pending"; UI.confirm({title:"t"}).then(v => window.__r = v); true`);
await new Promise(r => setTimeout(r, 100));
await evalJs(`document.querySelector(".modal [data-ok]").click(); true`);
await new Promise(r => setTimeout(r, 300));
console.log("confirm resolves:", await evalJs(`window.__r`));

process.exit(0);
