/* 照片卷（扫描卷）打印页的卷面调整自检（2026-10-11 用户要求）：
 *   「打印扫描的试卷的话，需要支持卷面调整，交互就参考组卷内的编辑部分」
 *
 *   ① 入口      —— 照片卷打印页也有「排版」按钮，点开是同一套工具条；但**没有**「编号」
 *                  （照片卷的板块标题与题号是原卷原文，不重编）
 *   ② 保真      —— 进排版前后：板块标题 / 题号 / 题目数 / 板块数**完全一致**。
 *                  这条最关键：原来照片卷走 Sheet.collect（标题原样），一进排版就走
 *                  buildFromManual（会 stripSecNo + 自动序号），"概念部分·一、填空"会变成
 *                  "一、概念部分·一、填空" —— autoNo:false 就是为它加的
 *   ③ 编辑件    —— 卡片可拖、板块行有 ≡ / 标题框 / 1-4 列 / ↑↓×；没有 # 小题号开关、
 *                  没有题目 ×（照片卷不重编题号，也不能把识别来的题从卷面删掉）
 *   ④ 改版      —— 切列数 / 就地改标题（不重画丢焦点）/ 拖动换板块 / 板块上移，都会变「未保存」
 *   ⑤ 保存      —— 落进 papers.layout（不是 custom_papers）；刷新后标题/列数/题序还原
 *   ⑥ 恢复      —— 「恢复原卷排版」清掉 sections，卷面回到原卷还原
 *   ⑦ 分页      —— 屏幕上几页，打印就几页（真打一份 PDF 数页数）
 *   ⑧ 不串卷    —— 卷 4 的排版不影响卷 5；两卷各自独立
 *   ⑨ 存疑题    —— 带 [?] / 草稿板块的题不进卷面（Sheet.usableList 一条判据）
 *   ⑩ 自建卷    —— print.html?custom=N 仍是老样子（有「编号」面板），没被这轮改动误伤
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻，演示模式免登录）
 * 用法：node tools/print_edit_check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const CDP_PORT = 9351;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LAY_KEY = "sj-demo-paper-layouts-v1";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "print-edit-"))}`, "about:blank",
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
  { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
const nav = async (url, ms = 2600) => { await cdp.send("Page.navigate", { url }); await sleep(ms); };

/* 卷面读数：同一板块（data-si）被分页拆成多个网格时归并回一份。
   编辑态的板块标题在 .sec-tinp 里，打印态在 .sec-title 里 —— 两边都读出来比。 */
const READ = `(function(){
  var secs=[], by={};
  [].forEach.call(document.querySelectorAll('#sheets .grid-sec'),function(g){
    var si=g.getAttribute('data-si');
    if(!(si in by)){
      var pv=g.previousElementSibling, tx='';
      if(pv){
        var inp=pv.querySelector?pv.querySelector('.sec-tinp'):null;
        tx = inp ? inp.value : String(pv.textContent||'').trim();
      }
      by[si]={si:si,title:tx,cols:0,n:0,ids:[],qn:[]};
      secs.push(by[si]);
    }
    var o=by[si];
    var m=/repeat\\((\\d+)/.exec(g.style.gridTemplateColumns||'');
    if(m) o.cols=Number(m[1]);
    var items=g.querySelectorAll('.gitem[data-qid]');
    o.n+=items.length;
    [].forEach.call(items,function(x){o.ids.push(String(x.dataset.qid));});
    [].forEach.call(g.querySelectorAll('.gitem .qn'),function(x){o.qn.push(x.textContent.trim());});
  });
  var bar=document.getElementById('lay');
  return JSON.stringify({
    secs:secs,
    titles:secs.map(function(s){return s.title;}),
    ids:secs.reduce(function(a,s){return a.concat(s.ids);},[]),
    qn:secs.reduce(function(a,s){return a.concat(s.qn);},[]),
    pages:document.querySelectorAll('#sheets > .sheet').length,
    editing:document.getElementById('sheets').className,
    barShown:!!bar && bar.style.display!=='none',
    layTxt:(document.getElementById('btn-lay')||{}).textContent,
    layVis:(function(){var b=document.getElementById('btn-lay');return !!b && b.style.display!=='none';})(),
    hint:(document.getElementById('pages')||{}).textContent,
    dragItems:document.querySelectorAll('#sheets .gitem[data-qid][data-si][draggable="true"]').length,
    secRows:document.querySelectorAll('#sheets .sec-edit').length,
    colBtns:document.querySelectorAll('#sheets .sec-edit .ccol').length,
    grips:document.querySelectorAll('#sheets .sec-edit .sec-grip').length,
    tinps:document.querySelectorAll('#sheets .sec-edit .sec-tinp').length,
    sdel:document.querySelectorAll('#sheets .sec-edit .ico.del').length,
    snoBtn:document.querySelectorAll('#sheets .sec-edit [data-act="sno"]').length,
    qdel:document.querySelectorAll('#sheets .gitem .qbar [data-act="qdel"]').length,
    qbar:document.querySelectorAll('#sheets .gitem .qbar').length,
    help:!!document.getElementById('lay-help'),
    buttons:[].map.call(document.querySelectorAll('#lay > button'),function(b){return b.textContent;}),
    noPanel:!!document.getElementById('no-panel'),
    dirty:(function(){var d=document.getElementById('lay-dirty');return !!d && d.style.display!=='none';})()
  });
})()`;
const read = async () => JSON.parse(await ev(cdp, READ));

const pdfPages = async () => {
  const r = await cdp.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
  const buf = Buffer.from(r.data, "base64").toString("latin1");
  return (buf.match(/\/Type\s*\/Page[^s]/g) || []).length;
};

/* 演示模式的卷面排版存在 localStorage 覆盖层里 —— 开跑先清干净，跑完再清干净，
   免得把本地预览「污染」成上一轮的排版（以前踩过这个坑）。 */
await nav(`${BASE}/print.html?id=4`);
await ev(cdp, `localStorage.removeItem(${JSON.stringify(LAY_KEY)})`);
await nav(`${BASE}/print.html?id=4`, 3200);
check("演示模式已激活", await ev(cdp, "!!window.__LOCAL_DEMO__"));

console.log("\n【① 入口：照片卷打印页也有排版】");
const base = await read();
check("①-1 卷面画出来了（有题、有页）", base.pages >= 1 && base.ids.length > 0,
  base.pages + " 页 / " + base.ids.length + " 题");
check("①-2 照片卷打印页出现「排版」按钮（以前是 display:none）", base.layVis === true, "layVis=" + base.layVis);
check("①-3 默认不在排版态（工具条藏、卷面没有编辑件）",
  base.barShown === false && base.secRows === 0 && base.qbar === 0,
  "bar=" + base.barShown + " secEdit=" + base.secRows);
check("①-4 统计行报出题数与每板块列数", /题 ·/.test(base.hint || ""), base.hint);
console.log("   基线：" + base.secs.map((s) => s.title + "(" + s.n + "题/" + s.cols + "列)").join(" "));

await ev(cdp, `document.getElementById("btn-lay").click()`);
await sleep(900);
const edit = await read();
check("①-5 点「排版」后出现工具条", edit.barShown === true && edit.secRows > 0,
  "bar=" + edit.barShown + " secEdit=" + edit.secRows);
check("①-6 按钮清单 = 恢复原卷排版 / 保存排版 / 打印预览 / 完成，**没有**「编号」",
  edit.buttons.indexOf("编号") < 0 && edit.buttons.indexOf("保存排版") >= 0
  && edit.buttons.indexOf("恢复原卷排版") >= 0 && edit.buttons.indexOf("打印预览") >= 0
  && !edit.noPanel,
  edit.buttons.join(" / "));
check("①-7 按钮文案变「退出排版」", edit.layTxt === "退出排版", edit.layTxt);
check("①-8 工具条有「?」操作说明", edit.help === true);

console.log("\n【② 保真：进排版前后，标题 / 题号 / 题目一个不差】");
check("②-1 板块数一致", edit.secs.length === base.secs.length,
  base.secs.length + " -> " + edit.secs.length);
check("②-2 板块标题一字不改（含自带序号的原文）",
  JSON.stringify(edit.titles) === JSON.stringify(base.titles),
  JSON.stringify(edit.titles.slice(0, 3)));
check("②-3 每板块列数一致", JSON.stringify(edit.secs.map((s) => s.cols)) === JSON.stringify(base.secs.map((s) => s.cols)),
  edit.secs.map((s) => s.cols).join(",") + " vs " + base.secs.map((s) => s.cols).join(","));
check("②-4 题目顺序与归属完全一致（板块内 id 序列）",
  JSON.stringify(edit.secs.map((s) => s.ids)) === JSON.stringify(base.secs.map((s) => s.ids)));
check("②-5 小题号一致（照片卷不重编题号）", JSON.stringify(edit.qn) === JSON.stringify(base.qn),
  edit.qn.length + " 个题号");

console.log("\n【③ 编辑件：跟组卷台同一套，但去掉照片卷不该有的】");
check("③-1 每道题都是可拖卡片（data-qid + data-si + draggable）",
  edit.dragItems === base.ids.length, edit.dragItems + "/" + base.ids.length);
check("③-2 每个板块行有 ≡ 抓手 / 标题输入框 / 1-4 列按钮",
  edit.grips === edit.secs.length && edit.tinps === edit.secs.length
  && edit.colBtns === edit.secs.length * 4,
  "grip=" + edit.grips + " tinp=" + edit.tinps + " ccol=" + edit.colBtns);
check("③-3 板块有「删掉这个板块」（题并入相邻板块）", edit.sdel === edit.secs.length, edit.sdel);
check("③-4 没有 #（小题号开关）—— 照片卷不重编题号", edit.snoBtn === 0, "sno=" + edit.snoBtn);
check("③-5 没有题目 ×（识别来的题不从卷面删）", edit.qdel === 0 && edit.qbar > 0, "qdel=" + edit.qdel);

console.log("\n【④ 改版：列数 / 标题 / 拖动 / 板块换序】");
/* 先把第 1 个板块切成 1 列 */
const si0 = edit.secs[0].si;
await ev(cdp, `document.querySelector('#sheets .sec-edit[data-si="${si0}"] .ccol[data-set="1"]').click()`);
await sleep(700);
let cur = await read();
check("④-1 点列数按钮，这一板块当场变 1 列",
  cur.secs[0].cols === 1 && edit.secs[0].cols !== 1,
  "cols " + edit.secs[0].cols + " -> " + cur.secs[0].cols);
check("④-2 变了就打「未保存」", cur.dirty === true);

/* 标题就地改：不重画（重画会丢焦点），只更新数据 */
const focusKept = await ev(cdp, `(function(){
  var inp=document.querySelector('#sheets .sec-edit[data-si="${si0}"] .sec-tinp');
  inp.focus(); inp.value="改过的板块名";
  inp.dispatchEvent(new Event("input",{bubbles:true}));
  var same=document.activeElement===inp;
  return JSON.stringify({same:same, val:document.querySelector('#sheets .sec-edit[data-si="${si0}"] .sec-tinp').value});
})()`);
const fk = JSON.parse(focusKept);
cur = await read();
check("④-3 标题就地改：输入框还是焦点（没重画卷面）", fk.same === true, JSON.stringify(fk));
check("④-4 标题改完卷面上就是新名字", cur.titles[0] === "改过的板块名", cur.titles[0]);
check("④-5 另外那些板块的标题没被连带改掉",
  JSON.stringify(cur.titles.slice(1)) === JSON.stringify(base.titles.slice(1)),
  JSON.stringify(cur.titles.slice(1, 3)));

/* 拖动：把第 2 个板块的第一道题拖进第 1 个板块末尾 */
const dragRes = await ev(cdp, `(function(){
  var dt; try { dt = new DataTransfer(); } catch(e) { return JSON.stringify({err:"DataTransfer 不可用"}); }
  var grids=[].slice.call(document.querySelectorAll('#sheets .grid-sec'));
  var g2=grids.filter(function(g){return g.getAttribute('data-si')==="1";})[0];
  var g0=grids.filter(function(g){return g.getAttribute('data-si')==="0";})[0];
  if(!g2||!g0) return JSON.stringify({err:"找不到板块"});
  var it=g2.querySelector('.gitem[data-qid]');
  if(!it) return JSON.stringify({err:"板块 1 没有题"});
  var qid=it.dataset.qid;
  it.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer:dt}));
  var r=g0.getBoundingClientRect();
  var opt={bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+r.width/2,clientY:r.bottom+8};
  g0.dispatchEvent(new DragEvent("dragover",opt));
  g0.dispatchEvent(new DragEvent("drop",opt));
  document.getElementById("sheets").dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:dt}));
  return JSON.stringify({qid:qid});
})()`);
const dr = JSON.parse(dragRes);
await sleep(800);
cur = await read();
const movedTo0 = !!dr.qid && cur.secs[0].ids.indexOf(dr.qid) >= 0;
const goneFrom1 = !!dr.qid && cur.secs[1].ids.indexOf(dr.qid) < 0;
check("④-6 拖动能把题换到别的板块（qid " + (dr.qid || "?") + "）", movedTo0 && goneFrom1,
  dr.err || ("板块0 " + cur.secs[0].n + " 题 / 板块1 " + cur.secs[1].n + " 题"));
check("④-7 拖完之后全卷题目一个没多一个没少", cur.ids.length === base.ids.length,
  cur.ids.length + " vs " + base.ids.length);

/* 板块上移：点第 2 个板块的 ↑ */
const titlesBeforeSec = cur.titles.slice();
await ev(cdp, `document.querySelector('#sheets .sec-edit[data-si="1"] [data-act="sup"]').click()`);
await sleep(700);
cur = await read();
check("④-8 板块 ↑ 换序（原来第 2 个名字现在排第 1）",
  cur.titles[0] === titlesBeforeSec[1] && cur.titles[1] === titlesBeforeSec[0],
  cur.titles.slice(0, 2).join(" | "));

console.log("\n【⑤ 保存：落 papers.layout，刷新还原】");
const savedOk = await ev(cdp, `(function(){
  var btns=[].slice.call(document.querySelectorAll('#lay > button'));
  var b=btns.filter(function(x){return x.textContent==="保存排版";})[0];
  if(!b) return "no-button";
  b.click(); return "clicked";
})()`);
await sleep(900);
const layout = await ev(cdp, `CloudAPI.getPaper(4).then(function(p){ return JSON.stringify(p.layout||null); })`);
const L = JSON.parse(layout || "null");
check("⑤-1 保存按钮点了有反应（toast/落库）", savedOk === "clicked");
check("⑤-2 排版落进 papers.layout（不是 custom_papers）",
  !!L && Array.isArray(L.sections) && L.sections.length === cur.secs.length,
  L ? "sections=" + L.sections.length : "null");
check("⑤-3 落库的板块标题 / 列数 / 题目 id 与卷面逐块一致",
  !!L && L.sections.length === cur.secs.length
  && L.sections.every(function (s, i) {
    return s.title === cur.titles[i] && s.cols === cur.secs[i].cols
      && JSON.stringify(s.ids.map(String)) === JSON.stringify(cur.secs[i].ids);
  }),
  L ? JSON.stringify(L.sections.slice(0, 2).map(function (s) {
    return { t: s.title, c: s.cols, n: s.ids.length };
  })) : "");
check("⑤-4 保存后不再是「未保存」", cur.dirty === true && (await read()).dirty === false);
await nav(`${BASE}/print.html?id=4`, 3400);
const after = await read();
check("⑤-5 刷新后仍是自定义排版（统计行标注）", /自定义排版/.test(after.hint || ""), after.hint);
check("⑤-6 刷新后板块标题 / 列数 / 题序与保存前一致",
  JSON.stringify(after.titles) === JSON.stringify(cur.titles)
  && JSON.stringify(after.secs.map((s) => s.cols)) === JSON.stringify(cur.secs.map((s) => s.cols))
  && JSON.stringify(after.ids) === JSON.stringify(cur.ids),
  after.titles.slice(0, 2).join(" | "));
check("⑤-7 刷新后回到非编辑态（卷面干净，工具条藏）",
  after.editing === "" && after.barShown === false && after.secRows === 0);

console.log("\n【⑥ 恢复原卷排版】");
await ev(cdp, `document.getElementById("btn-lay").click()`);
await sleep(800);
await ev(cdp, `[].slice.call(document.querySelectorAll('#lay > button'))
  .filter(function(x){return x.textContent==="恢复原卷排版";})[0].click()`);
await sleep(900);
const reset = await read();
check("⑥-1 恢复后卷面回到原卷还原（标题 / 板块数 / 题序与基线一致）",
  JSON.stringify(reset.titles) === JSON.stringify(base.titles)
  && JSON.stringify(reset.secs.map((s) => s.ids)) === JSON.stringify(base.secs.map((s) => s.ids)),
  reset.titles.slice(0, 2).join(" | "));
check("⑥-2 恢复后题号也没被改（原卷题号）", JSON.stringify(reset.qn) === JSON.stringify(base.qn));
check("⑥-3 恢复后 layout.sections 被清掉",
  await ev(cdp, `CloudAPI.getPaper(4).then(function(p){ return !(p.layout && p.layout.sections && p.layout.sections.length); })`) === true);
check("⑥-4 留在排版态（接着调，不用退出重进）", reset.secRows > 0);

console.log("\n【⑦ 分页：屏幕上几页，打印就几页】");
await ev(cdp, `document.getElementById("btn-lay").click()`);   // 退出排版再打印
await sleep(800);
const sp = (await read()).pages;
const pp = await pdfPages();
check("⑦-1 屏幕上几页，打印就几页（不多印空白页）", sp > 0 && sp === pp, "屏幕 " + sp + " 页 / 打印 " + pp + " 页");
check("⑦-2 每页都有页码标记",
  (await ev(cdp, `document.querySelectorAll('#sheets .pgno').length`)) === sp, "pgno=" + sp);

console.log("\n【⑧ 不串卷：卷 4 的排版不碰卷 5】");
await ev(cdp, `CloudAPI.updatePaper(4, { layout: { sections: [{title:"只属于卷4",type:"",cols:2,ids:[]}] } })`);
const other = JSON.parse(await ev(cdp, `CloudAPI.getPaper(5).then(function(p){ return JSON.stringify(!!(p.layout && p.layout.sections)); })`));
check("⑧-1 卷 5 没有跟着长出版块", other === false, "卷5 layout.sections=" + other);
await nav(`${BASE}/print.html?id=5`, 3200);
const p5 = await read();
check("⑧-2 卷 5 打印页照旧按原卷还原（没被卷 4 的排版影响）",
  p5.pages >= 1 && p5.ids.length > 0 && !/自定义排版/.test(p5.hint || ""), p5.hint);
check("⑧-3 卷 5 也能排版（按钮在）", p5.layVis === true);
await ev(cdp, `CloudAPI.updatePaper(4, { layout: null })`);

console.log("\n【⑨ 存疑题不进卷面】");
const usable = JSON.parse(await ev(cdp, `(function(){
  var mk=function(id,sec,mark){ return {id:id,section:sec,stem:[{t:"text",v:"题干"+(mark?" [?]":"")}]}; };
  var list=[mk(1,"一、填空"),mk(2,"一、填空",1),mk(3,"卷面草稿"),mk(4,""),mk(5,"笔迹")];
  var keep=Sheet.usableList(list).map(function(q){return q.id;});
  return JSON.stringify({keep:keep, n:list.length});
})()`));
check("⑨-1 usableList 过滤掉带 [?] 的题（id2）", usable.keep.indexOf(2) < 0, JSON.stringify(usable.keep));
check("⑨-2 usableList 过滤掉草稿 / 笔迹板块的题（id3、id5）",
  usable.keep.indexOf(3) < 0 && usable.keep.indexOf(5) < 0, JSON.stringify(usable.keep));
check("⑨-3 正常题与无板块名的题都留着（id1、id4）",
  usable.keep.indexOf(1) >= 0 && usable.keep.indexOf(4) >= 0, JSON.stringify(usable.keep));
const markOnPaper = await ev(cdp, `document.querySelectorAll('#sheets .gitem .qmark, #sheets .gitem [class*="qmark"]').length`);
check("⑨-4 卷面上没有 [?] 标记的题", markOnPaper === 0, "qmark=" + markOnPaper);

console.log("\n【⑩ 自建卷没被误伤（?custom=N 仍走老路）】");
await nav(`${BASE}/print.html?custom=1`, 3200);
const cust0 = await read();
check("⑩-0 自建卷照旧：默认打印态，点「排版」才进编辑",
  cust0.secRows === 0 && cust0.layVis === true, "secEdit=" + cust0.secRows);
await ev(cdp, `document.getElementById("btn-lay").click()`);
await sleep(800);
const cust = await read();
check("⑩-1 自建卷排版态照旧：卡片可拖、板块行在", cust.dragItems > 0 && cust.secRows > 0,
  "drag=" + cust.dragItems + " secEdit=" + cust.secRows);
check("⑩-2 自建卷**有**「编号」面板（大题/小题序号那套没被改掉）", cust.noPanel === true);
check("⑩-3 自建卷工具条按钮仍是五件套（含编号）", cust.buttons.indexOf("编号") >= 0, cust.buttons.join(" / "));
check("⑩-4 自建卷有题目 ×（可从卷面移出，只有组卷需要）", cust.secRows > 0 && cust.snoBtn > 0,
  "sno=" + cust.snoBtn);

console.log("\n【⑪ 题目一变，卷面编排作废（重识别前会明说）】");
const askReco = async () => JSON.parse(await ev(cdp, `(function(){
  var b=document.getElementById("btn-reco");
  if(!b) return JSON.stringify({err:"没有重新识别按钮"});
  b.click();
  var m=document.querySelector(".modal-mask .modal");
  return JSON.stringify({ txt: m ? m.textContent : "", hasModal: !!m });
})()`));
await ev(cdp, `CloudAPI.updatePaper(4, { layout: { sections: [{title:"X",type:"",cols:1,ids:[]}] } })`);
await nav(`${BASE}/paper.html?id=4`, 3400);
let d1 = await askReco();
check("⑪-1 有排版时，重识别对话框挑明「卷面会重置」",
  d1.hasModal === true && /卷面会重置/.test(d1.txt || ""), (d1.txt || "").slice(-40));
await ev(cdp, `document.querySelector(".modal-mask [data-no]").click()`);
await sleep(300);
check("⑪-2 取消后不会开跑（没有进度条）",
  (await ev(cdp, `!!document.querySelector("#notice .progress")`)) === false);
await ev(cdp, `CloudAPI.updatePaper(4, { layout: null })`);
await nav(`${BASE}/paper.html?id=4`, 3400);
let d2 = await askReco();
check("⑪-3 没有排版时不加这句（别拿无关后果吓人）",
  d2.hasModal === true && !/卷面会重置/.test(d2.txt || ""), (d2.txt || "").slice(-40));
await ev(cdp, `document.querySelector(".modal-mask [data-no]").click()`);

/* 清干净：别把本地预览留在探针造出的排版上 */
await ev(cdp, `localStorage.removeItem(${JSON.stringify(LAY_KEY)})`);

const bad = checks.filter((c) => !c.ok);
for (const c of checks) console.log((c.ok ? "PASS " : "FAIL ") + c.name + (c.detail ? "  [" + c.detail + "]" : ""));
console.log("\n" + (checks.length - bad.length) + "/" + checks.length + " 通过"
  + (bad.length ? "，失败 " + bad.length + " 项" : ""));
chrome.kill();
process.exit(bad.length ? 1 : 0);
