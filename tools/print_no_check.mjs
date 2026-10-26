/* 卷面编号规约自检（2026-10-06 的五条改动）：
 *   ① 顶栏不再有「上传新卷」入口
 *   ② 大题序号按板块位置现算 —— 交换板块后序号自动跟着换
 *   ③ 智能排版：计算题与比大小默认 3 列，其余 1 列
 *   ④ 每道大题内的小题号都从 1 开始（不跨板块连续编）
 *   ⑤ 计算题板块不印小题号
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻，演示模式免登录）
 * 用法：node tools/print_no_check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const CDP_PORT = 9348;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "print-no-"))}`, "about:blank",
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

async function ev(cdp, expr) {
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
  { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

/* 卷面读数：板块标题 / 列数 / 每个板块内的题号列表。
   注意：卷面按 A4 分页后，**同一个板块可能被拆到两页上**（两个 .grid-sec 共用一个
   data-si），所以要先按 data-si 归并，否则读出来的板块数会比 layout 多。 */
const READ = `(function(){
  var by = {}, order = [];
  [].forEach.call(document.querySelectorAll('#sheets .grid-sec'), function(g){
    var k = g.getAttribute('data-si');
    if(!by[k]){ by[k] = {cols:1, no:0, qn:[], n:0}; order.push(k); }
    var o = by[k];
    var m = /repeat\\((\\d+)/.exec(g.style.gridTemplateColumns || '');
    if(m) o.cols = Number(m[1]);
    o.no += g.querySelectorAll('.gitem .qn').length;
    o.n  += g.querySelectorAll('.gitem[data-qid]').length;
    [].forEach.call(g.querySelectorAll('.gitem .qn'), function(x){ o.qn.push(x.textContent.trim()); });
  });
  return JSON.stringify({
    nav: [].map.call(document.querySelectorAll('#topbar nav a'), function(a){ return a.textContent.trim(); }),
    secs: order.map(function(k){ return by[k]; }),
    titles: [].map.call(document.querySelectorAll('#sheets .sec-title'), function(t){ return t.textContent.trim(); })
  });
})()`;
const read = async () => JSON.parse(await ev(cdp, READ));

/* ---------------------------------------------------------------- 自建卷（智能排版） */
await cdp.send("Page.navigate", { url: `${BASE}/print.html?custom=1` });
await sleep(2400);
let st = await read();

check("① 顶栏没有「上传新卷」入口", !st.nav.some((t) => t.indexOf("上传") >= 0), "顶栏 = " + st.nav.join(" / "));
check("② 大题序号按位置生成", JSON.stringify(st.titles) === JSON.stringify(["一、选择题", "二、比大小", "三、计算题", "四、应用题"]),
  st.titles.join(" | "));
check("③ 只有计算题和比大小不是 1 列", JSON.stringify(st.secs.map((s) => s.cols)) === JSON.stringify([1, 3, 3, 1]),
  "列数 = " + st.secs.map((s) => s.cols).join("/"));
check("④ 每个板块的小题号都从 1 起",
  st.secs.every((s) => !s.qn.length || s.qn[0] === "1."),
  st.secs.map((s, i) => `板块${i + 1}:` + (s.qn.join(",") || "无题号")).join("  "));
check("⑤ 计算题板块不印题号", st.secs[2] && st.secs[2].no === 0 && st.secs[2].n > 0,
  `计算题 ${st.secs[2].n} 题 / 题号 ${st.secs[2].no} 个`);

/* ---------------------------------------------------------------- 交换板块后序号自动重排 */
await ev(cdp, "document.getElementById('btn-lay').click();");
await sleep(600);
await ev(cdp, "document.querySelector('#sheets .sec-edit[data-si=\"0\"] [data-act=\"sdown\"]').click();");
await sleep(600);
await ev(cdp, "document.getElementById('btn-lay').click();");     // 退出排版，看干净卷面
await sleep(500);
st = await read();
check("② 交换第一/二大题后序号自动换",
  JSON.stringify(st.titles) === JSON.stringify(["一、比大小", "二、选择题", "三、计算题", "四、应用题"]),
  st.titles.join(" | "));
check("② 交换后小题号仍每板块从 1 起",
  st.secs.every((s) => !s.qn.length || s.qn[0] === "1."),
  st.secs.map((s, i) => `板块${i + 1}:` + (s.qn.join(",") || "无题号")).join("  "));

/* ---------------------------------------------------------------- 进排版模式：序号只读但可见 */
await ev(cdp, "document.getElementById('btn-lay').click();");
await sleep(600);
const editNo = await ev(cdp,
  "JSON.stringify([].map.call(document.querySelectorAll('#sheets .sec-edit'),function(e){"
  + "return {no:(e.querySelector('.sec-no')||{}).textContent||'', name:e.querySelector('.sec-tinp').value};}))");
const en = JSON.parse(editNo);
check("② 排版模式里序号只读可见、标题框只放纯名",
  en.every((e, i) => e.no === ["一、", "二、", "三、", "四、"][i] && !/^[一二三四五六七八九十]、/.test(e.name)),
  en.map((e) => e.no + e.name).join(" | "));

/* ------------------------------------------------- 编号方案：是否显示 / 数字形式 / 包裹样式 */
/* 下拉是自绘的 UI.select（无原生 <select>）：点开 → 按 label 点选项 */
const setSel = async (id, label) => {
  const ok = await ev(cdp, `document.getElementById(${JSON.stringify(id)}).querySelector('.dd-btn').click(); true`);
  await sleep(120);
  const hit = await ev(cdp, `(function(){var r=document.getElementById(${JSON.stringify(id)});`
    + `var its=r.querySelectorAll('.dd-it');`
    + `for(var i=0;i<its.length;i++){var n=its[i].querySelector('.dd-name');`
    + `if(n && n.textContent.trim()===${JSON.stringify(label)}){its[i].click();return true;}}`
    + `return false;})()`);
  await sleep(160);
  if (!ok || !hit) throw new Error(`下拉 ${id} 里找不到「${label}」`);
};
const setChk = (id, v) => ev(cdp, `(function(){var c=document.getElementById(${JSON.stringify(id)});`
  + `c.checked=${v ? "true" : "false"};c.dispatchEvent(new Event('change',{bubbles:true}));return c.checked;})()`);
const demo = (id) => ev(cdp, `document.getElementById(${JSON.stringify(id)}).textContent`);

await ev(cdp, "document.getElementById('lay-no').click();");
await sleep(350);
check("⑥ 「编号」面板可展开",
  (await ev(cdp, "document.getElementById('no-panel').style.display !== 'none'")) === true);
check("⑥ 面板内容 = 4 个自绘下拉 + 2 个显示开关 + 2 个预览（无原生 select）",
  (await ev(cdp, "document.querySelectorAll('#no-panel .dd').length")) === 4
  && (await ev(cdp, "document.querySelectorAll('#no-panel select').length")) === 0
  && (await ev(cdp, "document.querySelectorAll('#no-panel input[type=checkbox]').length")) === 2
  && (await ev(cdp, "document.querySelectorAll('#no-panel .no-demo').length")) === 2);
check("⑥ 默认预览：大题「一、二、三」小题「1. 2. 3.」",
  (await demo("no-big-demo")) === "一、 二、 三、 …" && (await demo("no-small-demo")) === "1. 2. 3. …",
  (await demo("no-big-demo")) + " / " + (await demo("no-small-demo")));

/* 大题 → 阿拉伯数字 + 圆括号；小题 → 大写字母 + 无包裹 */
await setSel("no-big-style", "阿拉伯数字 1");
await setSel("no-big-wrap", "（）");
await setSel("no-small-style", "大写字母 A");
await setSel("no-small-wrap", "无");
await sleep(300);
check("⑦ 预览串随下拉实时变",
  (await demo("no-big-demo")) === "（1） （2） （3） …" && (await demo("no-small-demo")) === "A B C …",
  (await demo("no-big-demo")) + " / " + (await demo("no-small-demo")));

await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(900);
await ev(cdp, "document.getElementById('lay-done').click();");
await sleep(500);
st = await read();
check("⑦ 大题序号印成「（1）比大小」",
  JSON.stringify(st.titles) === JSON.stringify(["（1）比大小", "（2）选择题", "（3）计算题", "（4）应用题"]),
  st.titles.join(" | "));
check("⑧ 小题号印成大写字母（每板块都从 A 起）",
  st.secs.every((s) => !s.qn.length || s.qn[0] === "A")
  && st.secs.some((s) => s.qn.length > 1 && s.qn[1] === "B"),
  st.secs.map((s, i) => `板块${i + 1}:` + (s.qn.join(",") || "无题号")).join("  "));
check("⑧ 计算题默认仍不印（题型默认没被全局开关顶掉）",
  st.secs[2].no === 0 && st.secs[2].n > 0, `计算题 ${st.secs[2].n} 题 / 题号 ${st.secs[2].no} 个`);

/* 板块行上的 # 按钮：单独给计算题开小题号 */
await ev(cdp, "document.getElementById('btn-lay').click();");
await sleep(500);
await ev(cdp, "document.querySelector('#sheets .sec-edit[data-si=\"2\"] [data-act=\"sno\"]').click();");
await sleep(500);
await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(900);
await ev(cdp, "document.getElementById('lay-done').click();");
await sleep(500);
st = await read();
check("⑨ 板块行 # 可给单个大题开小题号（计算题 6 题 → A..F）",
  st.secs[2].qn.length === st.secs[2].n && st.secs[2].qn[0] === "A",
  `计算题 ${st.secs[2].n} 题 / 题号 ${st.secs[2].qn.join(",")}`);

/* 刷新：编号方案与板块级开关都要从 layout 里读回来 */
await cdp.send("Page.navigate", { url: `${BASE}/print.html?custom=1` });
await sleep(2600);
st = await read();
check("⑩ 刷新后编号方案仍在（大题「（1）」）",
  st.titles[0] === "（1）比大小", st.titles.join(" | "));
check("⑩ 刷新后板块级小题号开关仍在（计算题有号）",
  st.secs[2].qn.length > 0, `计算题题号 ${st.secs[2].qn.join(",") || "无"}`);

/* 关掉「显示」：两类序号都该整卷消失 */
await ev(cdp, "document.getElementById('btn-lay').click();");
await sleep(500);
await ev(cdp, "document.getElementById('lay-no').click();");
await sleep(300);
await setChk("no-big-show", false);
await setChk("no-small-show", false);
await sleep(400);
await ev(cdp, "document.getElementById('lay-done').click();");
await sleep(500);
st = await read();
check("⑪ 关掉「显示」后大题序号整卷消失",
  JSON.stringify(st.titles) === JSON.stringify(["比大小", "选择题", "计算题", "应用题"]),
  st.titles.join(" | "));
check("⑪ 关掉「显示」后小题序号也整卷消失",
  st.secs.every((s) => s.no === 0), st.secs.map((s) => s.no).join("/"));

/* 收尾：编号改回默认 + 恢复智能排版，别把演示数据留在半路 */
await ev(cdp, "document.getElementById('btn-lay').click();");
await sleep(400);
await ev(cdp, "document.getElementById('lay-no').click();");
await sleep(300);
await setChk("no-big-show", true);
await setSel("no-big-style", "中文数字 一");
await setSel("no-big-wrap", "、");
await setChk("no-small-show", true);
await setSel("no-small-style", "阿拉伯数字 1");
await setSel("no-small-wrap", ".");
await sleep(350);
await ev(cdp, "document.getElementById('lay-auto').click();");
await sleep(1000);
await ev(cdp, "document.getElementById('lay-done').click();");    // 退出排版才看得到 .sec-title
await sleep(500);
st = await read();
check("⑫ 恢复智能排版后回到「一、选择题 / 小题 1.」",
  JSON.stringify(st.titles) === JSON.stringify(["一、选择题", "二、比大小", "三、计算题", "四、应用题"])
  && st.secs.every((s) => !s.qn.length || s.qn[0] === "1.")
  && st.secs[2].no === 0, st.titles.join(" | ") + "  " + st.secs[0].qn.join(","));

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "\n        " + c.detail : ""}`);
}
console.log(bad === 0 ? "\n全部通过" : `\n${bad} 项未通过`);
chrome.kill();
process.exit(bad === 0 ? 0 : 1);
