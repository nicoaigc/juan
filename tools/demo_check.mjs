/* 本地演示模式自检：真点一遍「卷面排版」——
 * 打开 print.html?custom=1 -> 点「排版」-> 拖一题跨板块 -> 保存 -> 读 localStorage 断言落盘。
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻）
 * 用法：node tools/demo_check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const CDP_PORT = 9347;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "demo-check-"))}`, "about:blank",
], { stdio: "ignore" });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiters.has(m.id)) {
        const { res, rej } = c.waiters.get(m.id);
        c.waiters.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiters.set(id, { res, rej }));
  }
}

async function evalJs(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

let target;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch { /* 还没起来 */ }
  if (!target) await sleep(250);
}
if (!target) { chrome.kill(); throw new Error("Chrome 调试端口没起来"); }

const cdp = await CDP.connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); }

/* 卷面按 A4 分页后，同一板块可能跨页（多个 .grid-sec 共用一个 data-si）——
   凡是数"板块数 / 板块题数"都要先按 data-si 归并。 */
const GC = `(function(){
  var s = {};
  [].forEach.call(document.querySelectorAll('#sheets .grid-sec'), function(g){
    var k = g.getAttribute('data-si');
    s[k] = (s[k] || 0) + g.querySelectorAll('.gitem[data-qid]').length;
  });
  return Object.keys(s).sort(function(a,b){ return a - b; }).length;
})()`;
const GD = `(function(){
  var s = {};
  [].forEach.call(document.querySelectorAll('#sheets .grid-sec'), function(g){
    var k = g.getAttribute('data-si');
    s[k] = (s[k] || 0) + g.querySelectorAll('.gitem[data-qid]').length;
  });
  return JSON.stringify(Object.keys(s).sort(function(a,b){ return a - b; }).map(function(k){ return s[k]; }));
})()`;

// 1) 打开自建卷卷面
await cdp.send("Page.navigate", { url: `${BASE}/print.html?custom=1` });
await sleep(2200);
check("演示模式已激活", await evalJs(cdp, "!!window.__LOCAL_DEMO__"));
check("卷面已渲染", await evalJs(cdp, "document.querySelectorAll('#sheets .gitem[data-qid]').length") > 0,
  "题数=" + await evalJs(cdp, "document.querySelectorAll('#sheets .gitem[data-qid]').length"));

// 2) 进排版模式
await evalJs(cdp, "document.getElementById('btn-lay').click();");
await sleep(500);
const nSec = await evalJs(cdp, "document.querySelectorAll('#sheets .sec-edit').length");
check("排版控件出现", nSec > 0, "板块数=" + nSec);

// 3) 拖一题跨板块（第 2 个板块首题 -> 第 1 个板块首题之前）
const before = await evalJs(cdp, GD);
await evalJs(cdp, `(function(){
  var dt=new DataTransfer();
  var src=document.querySelector('#sheets .grid-sec[data-si="1"] .gitem[data-qid]');
  var tgt=document.querySelector('#sheets .grid-sec[data-si="0"] .gitem[data-qid]');
  if(!src||!tgt) return "no-node";
  var r=tgt.getBoundingClientRect();
  src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
  tgt.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+4,clientY:r.top+4}));
  tgt.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+4,clientY:r.top+4}));
  return "ok";
})();`);
await sleep(500);
const after = await evalJs(cdp, GD);
check("拖拽后题数分布变化", before !== after, before + " -> " + after);

// 4) 就地改列数 + 标题
await evalJs(cdp, `(function(){
  var c=document.querySelector('#sheets .sec-edit[data-si="0"] .ccol[data-set="1"]'); if(c) c.click();
  var t=document.querySelector('.sec-tinp'); if(t){t.value='一、选择题（改过标题）';t.dispatchEvent(new Event('input',{bubbles:true}));}
})();`);
await sleep(400);
check("出现未保存标记", await evalJs(cdp, "getComputedStyle(document.getElementById('lay-dirty')).display") !== "none");

// 5) 保存 -> 应写进 localStorage
await evalJs(cdp, "document.getElementById('lay-save').click();");
await sleep(1200);
const saved = await evalJs(cdp, "localStorage.getItem('sj-demo-customs-v1') || ''");
let lay = null;
try { lay = JSON.parse(saved).filter((c) => String(c.id) === "1")[0]?.layout; } catch { /* 见断言 */ }
check("排版已写入 localStorage",
  !!(lay && lay.sections && lay.sections.length),
  lay ? lay.sections.map((s) => `${s.title} ${s.cols}列 ${s.ids.length}题`).join(" | ") : "未读到 layout");

// 6) 刷新后仍在（持久化真的生效）
await cdp.send("Page.navigate", { url: `${BASE}/print.html?custom=1` });
await sleep(2200);
check("刷新后仍是排版后的结果",
  await evalJs(cdp, GC) === (lay?.sections?.length ?? -1),
  "板块数=" + await evalJs(cdp, GC));

// 7) 组卷台保存 -> 留在本页继续编辑（选题与排版同一页，不再跳走）
await cdp.send("Page.navigate", { url: `${BASE}/compose.html` });
await sleep(2000);
await evalJs(cdp, `document.getElementById('c-title').value='自检新卷';
  for(var i=0;i<3;i++){var bs=document.querySelectorAll('[data-add]');
    for(var j=0;j<bs.length;j++){if(bs[j].textContent.trim()==='加入'){bs[j].click();break;}}}`);
await sleep(400);
check("组卷台里卷面就是编辑画布",
  await evalJs(cdp, "document.querySelectorAll('#sheets .sec-edit').length") > 0
  && await evalJs(cdp, "document.querySelectorAll('#sheets .qbar .ico').length") > 0,
  "板块数=" + await evalJs(cdp, "document.querySelectorAll('#sheets .sec-edit').length"));
await evalJs(cdp, "document.getElementById('lay-save').click();");
await sleep(2000);
check("保存后留在组卷台（URL 带上 id，可继续编辑）",
  (await evalJs(cdp, "location.href")).indexOf("compose.html?id=") >= 0,
  await evalJs(cdp, "location.href"));
check("新卷已落盘 localStorage",
  (await evalJs(cdp, "localStorage.getItem('sj-demo-customs-v1') || ''")).includes("自检新卷"));

// 收尾：把自检造的卷删掉，别污染用户要试的环境
await evalJs(cdp, "localStorage.setItem('sj-demo-customs-v1', JSON.stringify(JSON.parse(localStorage.getItem('sj-demo-customs-v1')).filter(function(c){return c.title!=='自检新卷';})));");

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "   (" + c.detail + ")" : ""}`);
}
console.log(bad === 0 ? "\n全部通过" : `\n${bad} 项未通过`);
chrome.kill();
process.exit(bad === 0 ? 0 : 1);
