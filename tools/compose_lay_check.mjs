/* 组卷台自检（2026-10-06：选题与排版合并到一页）：
 *   ① 进页面就有卷面编辑画布（不是先选题再跳去排版）
 *   ② 左栏「加入」-> 题目立刻落到卷面同题型板块，再点一下移出
 *   ③ 卷面题目右上角 × 能把题移出这份卷子（题库不受影响）
 *   ④ 卷面上拖动换板块 + 改板块标题 + 切列数
 *   ⑤ 卷名就是卷头，改一个字卷面跟着变
 *   ⑥ 保存 -> 留在本页（URL 带 id）、题目顺序与排版一起落库
 *   ⑦ 刷新后排版 / 题序 / 卷名都还原
 *   ⑧ 编号面板在组卷台也能用（大题换阿拉伯+括号，卷面立刻变）
 *   ⑨ 整页高度 ≈ 内容底（左栏题库池子那 1 万多 px 曾被算进整页滚动区 → 往下滚一大片空白）
 *   ⑩ 题库按页渲染（首屏 80 条、滚到底/点尾部条续渲、点「加入」只改那一行）+ 组卷台壳放宽\n *   ⑪ 题库级手动打题型（.tchip 浮层 → source.qtype_manual 落库/刷新保持/恢复自动）
 *   ⑫ 打印预览（工具条按钮 → 全屏遮罩里按打印态重画：无编辑控件、A4 分页、页数标注，关闭回排版态）
 *   ⑬ 组卷卡片右上角打印 icon（.cprint → print.html?custom=N，卷面出题）
 *   ⑭ 题目手动修正（按题型简单面板：算式/比大小=公式编辑器+预览 / 选择题才有选项 / 图列表编辑）
 *   ⑮ 题内插图替换（#figm 整页原图拖框替换 / **摆正＝转选区本身**（拖圆点或滑杆，烤出来是摆正且紧贴的）/
 *              恢复识别原状；「调整」弹层已移除，断言不回潮）
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻，演示模式免登录）
 * 用法：node tools/compose_lay_check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const CDP_PORT = 9349;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "compose-lay-"))}`, "about:blank",
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
  { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); }

/* 卷面快照：板块标题 + 每板块题数 / 列数 + 题目 id。
   卷面按 A4 分页后同一板块可能被拆到两页（多个 .grid-sec 共用一个 data-si），
   所以按 data-si 归并；标题直接读板块行上的输入框（编辑态标题就是那个 input）。 */
const READ = `(function(){
  var by = {}, order = [];
  [].forEach.call(document.querySelectorAll('#sheets .grid-sec'), function(g){
    var k = g.getAttribute('data-si');
    if(!by[k]){ by[k] = {title:'', n:0, ids:[], cols:1}; order.push(k); }
    var o = by[k];
    var cs = (getComputedStyle(g).gridTemplateColumns || '').split(' ').filter(Boolean).length;
    if(cs) o.cols = cs;
    o.n += g.querySelectorAll('.gitem[data-qid]').length;
    [].forEach.call(g.querySelectorAll('.gitem[data-qid]'), function(x){ o.ids.push(x.dataset.qid); });
  });
  [].forEach.call(document.querySelectorAll('#sheets .sec-edit'), function(e){
    var si = e.dataset.si;
    if(by[si]){ var t = e.querySelector('.sec-tinp'); by[si].title = t ? t.value : ''; }
  });
  return JSON.stringify(order.map(function(k){ return by[k]; }));
})()`;
const read = async () => JSON.parse(await ev(cdp, READ));
const store = (id) => ev(cdp, `(function(){var a=JSON.parse(localStorage.getItem('sj-demo-customs-v1')||'[]');`
  + `var c=a.filter(function(x){return String(x.id)===${JSON.stringify(id)};})[0];return c?JSON.stringify({ids:c.question_ids,layout:c.layout}):'null';})()`);

/* ---------------------------------------------------------------- 1) 打开：一进来就是编辑画布 */
await cdp.send("Page.navigate", { url: `${BASE}/compose.html` });
await sleep(2400);
check("演示模式已激活", await ev(cdp, "!!window.__LOCAL_DEMO__"));
check("① 没有选题时给的是引导语（不是一张空白 A4）",
  await ev(cdp, "!!document.querySelector('#sheets .canvas-empty')"));
check("① 排版工具条常显（不用先点「排版」）",
  await ev(cdp, "getComputedStyle(document.getElementById('lay')).display") !== "none");

/* ---------------------------------------------------------------- 2) 左栏加入 -> 落到卷面 */
const firstId = await ev(cdp, "document.querySelector('[data-add]').dataset.add");
await ev(cdp, "document.querySelector('[data-add]').click();");
await sleep(600);
let secs = await read();
check("② 加入一题后卷面出现该题",
  secs.reduce((a, s) => a + s.n, 0) === 1 && secs[0].ids[0] === firstId,
  JSON.stringify(secs));
check("② 卷面上就能看到板块行的编辑件（标题框 / 列数 / 板块操作）",
  await ev(cdp, "document.querySelectorAll('#sheets .sec-edit').length") === 1
  && await ev(cdp, "document.querySelectorAll('#sheets .sec-edit .ccol').length") === 4);
check("② 已加入的题在左栏变成「已加入」",
  (await ev(cdp, `document.querySelector('[data-add="${firstId}"]').textContent.trim()`)) === "已加入");

/* 每种题型各挑一题，凑出多个板块（「加入」是开关，得挑还没加入的按钮点） */
await ev(cdp, `(function(){
  var seen={},types=[];
  [].forEach.call(document.querySelectorAll('.pitem .chip.type'),function(c){
    var t=c.textContent.trim(); if(!seen[t]){seen[t]=1;types.push(t);}});
  for(var k=0;k<types.length && k<5;k++){
    var items=document.querySelectorAll('.pitem');
    for(var j=0;j<items.length;j++){
      var chip=items[j].querySelector('.chip.type');
      var btn=items[j].querySelector('[data-add]');
      if(chip&&btn&&chip.textContent.trim()===types[k]&&btn.textContent.trim()==='加入'){btn.click();break;}
    }
  }
})();`);
await sleep(800);
secs = await read();
check("② 挑中的题按题型自动分板块（板块数 > 1）",
  secs.length > 1 && secs.every((s) => s.n > 0),
  secs.map((s) => s.title + ":" + s.n).join(" | "));

/* ---------------------------------------------------------------- 3) 卷面上 × 移出 */
const victim = secs[0].ids[0];
await ev(cdp, `document.querySelector('#sheets .gitem[data-qid="${victim}"] .qbar [data-act="qdel"]').click();`);
await sleep(600);
const secs2 = await read();
check("③ 卷面题目右上角 × 能把题移出这份卷子",
  secs2.reduce((a, s) => a + s.n, 0) === secs.reduce((a, s) => a + s.n, 0) - 1
  && !secs2.some((s) => s.ids.indexOf(victim) >= 0));
check("③ 移出后左栏那题回到「加入」",
  (await ev(cdp, `document.querySelector('[data-add="${victim}"]').textContent.trim()`)) === "加入");

/* ---------------------------------------------------------------- 4) 拖拽 + 改标题 + 切列数 */
const before = (await read()).map((s) => s.n);
await ev(cdp, `(function(){
  var dt=new DataTransfer();
  var grids=[].slice.call(document.querySelectorAll('#sheets .grid-sec'));
  var srcG=null,tgtG=null;
  for(var i=0;i<grids.length;i++){
    if(grids[i].querySelectorAll('.gitem[data-qid]').length){
      if(!srcG) srcG=grids[i]; else { tgtG=grids[i]; break; }
    }
  }
  if(!srcG||!tgtG) return "no-node";
  var src=srcG.querySelector('.gitem[data-qid]'), tgt=tgtG.querySelector('.gitem[data-qid]');
  var r=tgt.getBoundingClientRect();
  src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
  tgt.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+4,clientY:r.top+4}));
  tgt.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+4,clientY:r.top+4}));
  return "ok";
})();`);
await sleep(600);
const after = (await read()).map((s) => s.n);
check("④ 卷面上拖动能把题换到别的板块",
  JSON.stringify(before) !== JSON.stringify(after),
  JSON.stringify(before) + " -> " + JSON.stringify(after));

await ev(cdp, `(function(){
  var c=document.querySelector('#sheets .sec-edit[data-si="0"] .ccol[data-set="2"]'); if(c) c.click();
  var t=document.querySelector('#sheets .sec-tinp'); if(t){t.value='口算';t.dispatchEvent(new Event('input',{bubbles:true}));}
})();`);
await sleep(600);
check("④ 板块标题就地改 + 列数就地切",
  (await read())[0].title === "口算"
  && (await ev(cdp, `document.querySelector('#sheets .grid-sec[data-si="0"]').style.gridTemplateColumns`))
     === "repeat(2, 1fr)");
check("④ 改动了就会出现「未保存」",
  await ev(cdp, "getComputedStyle(document.getElementById('c-dirty')).display") !== "none");

/* ---------------------------------------------------------------- 5) 卷名即卷头 */
await ev(cdp, `(function(){var i=document.getElementById('c-title');i.value='自检组卷台';`
  + `i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(400);
check("⑤ 卷名实时变成卷头标题",
  (await ev(cdp, "document.querySelector('#sheets .paper-head .t').textContent")) === "自检组卷台");

/* ---------------------------------------------------------------- 6) 保存：留在本页 + 落库 */
await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(1800);
check("⑥ 保存后留在组卷台，URL 带上 id（可继续编辑）",
  (await ev(cdp, "location.href")).indexOf("compose.html?id=") >= 0,
  await ev(cdp, "location.href"));
const savedId = await ev(cdp, "new URLSearchParams(location.search).get('id')");
const row = JSON.parse(await store(savedId));
const flatIds = [].concat(...row.layout.sections.map((s) => s.ids.map(String)));
check("⑥ 题目顺序与排版一起落库（question_ids = 卷面顺序）",
  JSON.stringify(row.ids.map(String)) === JSON.stringify(flatIds),
  "question_ids=" + JSON.stringify(row.ids) + "  卷面=" + JSON.stringify(flatIds));
const sheetNow = await read();
check("⑥ 落库的板块 / 题序与卷面一致",
  JSON.stringify(row.layout.sections.map((s) => [s.title, s.ids.length, s.cols]))
  === JSON.stringify(sheetNow.map((s) => [s.title, s.n, s.cols])),
  JSON.stringify(row.layout.sections.map((s) => `${s.title} ${s.cols}列 ${s.ids.length}题`)));

/* ---------------------------------------------------------------- 7) 刷新还原 */
await cdp.send("Page.navigate", { url: `${BASE}/compose.html?id=${savedId}` });
await sleep(2400);
const secs3 = await read();
check("⑦ 刷新后题序 / 板块名 / 列数都还原",
  JSON.stringify(secs3.map((s) => [s.title, s.n, s.cols]))
  === JSON.stringify(sheetNow.map((s) => [s.title, s.n, s.cols])),
  secs3.map((s) => s.title + ":" + s.n).join(" | "));
check("⑦ 刷新后卷名也还在",
  (await ev(cdp, "document.getElementById('c-title').value")) === "自检组卷台");

/* ---------------------------------------------------------------- 8) 编号面板 */
await ev(cdp, "document.getElementById('lay-no').click();");
await sleep(400);
check("⑧ 编号面板在组卷台也能展开",
  await ev(cdp, "document.getElementById('no-panel').style.display") !== "none");
const setSel = async (id, label) => {
  await ev(cdp, `document.getElementById(${JSON.stringify(id)}).querySelector('.dd-btn').click(); true`);
  await sleep(140);
  const hit = await ev(cdp, `(function(){var r=document.getElementById(${JSON.stringify(id)});`
    + `var its=r.querySelectorAll('.dd-it');`
    + `for(var i=0;i<its.length;i++){var n=its[i].querySelector('.dd-name');`
    + `if(n&&n.textContent.trim()===${JSON.stringify(label)}){its[i].click();return true;}}return false;})()`);
  await sleep(200);
  if (!hit) throw new Error(`下拉 ${id} 找不到「${label}」`);
};
await setSel("no-big-style", "阿拉伯数字 1");
await setSel("no-big-wrap", "（）");
await sleep(500);
check("⑧ 大题序号换成「（1）」后卷面上立刻生效",
  (await ev(cdp, "document.querySelector('#sheets .sec-no').textContent")) === "（1）");

/* ---------------------------------------------------------------- 9) 整页不该滚进空白
   ⚠️ 回归项：`.bank` 是 position:sticky，左栏题库池子那 1 万多 px 的内容会被 Chrome 算进
   祖先的滚动区（实测 body.scrollHeight=11414，而卷面只占 3407）→ 往下能滚 8000px 的纯空白
   （用户报「编辑试卷下面的留白太多」）。修法 = `.pool { contain: paint }`。 */
await ev(cdp, "window.scrollTo(0, 0); true");
await sleep(300);
const gapD = JSON.parse(await ev(cdp, `(function(){
  var st = document.getElementById('studio'), bk = document.getElementById('bank');
  var p = document.getElementById('pool');
  var a = p.scrollTop; p.scrollTop = 300; var moved = p.scrollTop; p.scrollTop = a;
  return JSON.stringify({
    body: document.body.scrollHeight,
    studioBottom: Math.round(st.getBoundingClientRect().bottom + window.scrollY),
    bankScroll: bk.scrollHeight,
    bankH: Math.round(bk.getBoundingClientRect().height),
    poolScrolls: moved > 0,
    maxScroll: Math.round(document.scrollingElement.scrollHeight
      - document.scrollingElement.clientHeight),
  });
})()`));
check("⑨ 整页高度 ≈ 内容底（不会往下滚出一大片空白）",
  gapD.body - gapD.studioBottom < 120,
  `body=${gapD.body} 内容底=${gapD.studioBottom} 最大滚动=${gapD.maxScroll}`);
check("⑨ 左栏题库仍能自己滚（没被裁死）",
  gapD.bankScroll - gapD.bankH < 4 && gapD.poolScrolls,
  `bank scrollH=${gapD.bankScroll} h=${gapD.bankH} 池子可滚=${gapD.poolScrolls}`);

/* ================================================================ ⑩ 题库按页渲染 + 宽版式
 * 演示题库 135 题：一次全量渲染 = 4.5k DOM 节点 + 每点一次「加入」重画整张列表。
 * 改成先画 80 条、滚到底/点尾部条续渲；「加入」只改那一行。卷面壳放宽到 1500。 */
const nav2 = async (url) => { await cdp.send("Page.navigate", { url }); await sleep(2200); };
await nav2(`${BASE}/compose.html`);
const pool0 = JSON.parse(await ev(cdp, `(function(){
  var pool = document.getElementById('pool');
  var its = document.querySelectorAll('#plist .pitem');
  window.__keep = its[its.length - 1];
  return JSON.stringify({
    shown: its.length,
    count: document.getElementById('pool-count').textContent,
    more: (document.getElementById('pool-more')||{textContent:''}).textContent,
    wrapMax: getComputedStyle(document.querySelector('.wrap')).maxWidth,
    sheetScale: document.getElementById('sheets').style.transform || '(1:1)',
  });
})()`));
check("⑩-1 首屏只渲染一页（80 条），计数行仍报全量",
  pool0.shown === 80 && pool0.count.indexOf("135") >= 0,
  `渲染 ${pool0.shown} 条 / ${pool0.count}`);
check("⑩-2 列表尾部有「继续加载」条",
  pool0.more.indexOf("80 / 135") >= 0, pool0.more);
check("⑩-3 组卷台壳放宽（.wrap.wide = 1500px），1280 屏卷面不再缩放",
  pool0.wrapMax === "1500px" && (pool0.sheetScale === "(1:1)" || pool0.sheetScale === ""),
  `max-width=${pool0.wrapMax} 卷面 transform=${pool0.sheetScale}`);

/* 滚到底 -> 自动续渲（不用手点），135 题一次滚就全出来了 */
const scr = JSON.parse(await ev(cdp, `(function(){
  var pool = document.getElementById('pool');
  pool.scrollTop = pool.scrollHeight;
  pool.dispatchEvent(new Event('scroll'));
  return new Promise(function(res){
    setTimeout(function(){
      res(JSON.stringify({ after: document.querySelectorAll('#plist .pitem').length,
        moreGone: !document.getElementById('pool-more') }));
    }, 250);
  });
})()`));
check("⑩-4 池子滚到底自动加载下一批（直到没有更多）",
  scr.after === 135 && scr.moreGone, `滚动后 ${scr.after} 条，尾部条消失=${scr.moreGone}`);

/* 重进一次，点尾部条续渲 + 点「加入」只换那一行 */
await nav2(`${BASE}/compose.html`);
const more1 = JSON.parse(await ev(cdp, `(function(){
  var before = document.querySelectorAll('#plist .pitem').length;
  document.getElementById('pool-more').click();
  return JSON.stringify({ before: before,
    after: document.querySelectorAll('#plist .pitem').length,
    moreGone: !document.getElementById('pool-more') });
})()`));
check("⑩-5 点「继续加载」把下一批接上",
  more1.before === 80 && more1.after === 135 && more1.moreGone,
  `${more1.before} → ${more1.after} 条`);

const add1 = JSON.parse(await ev(cdp, `(function(){
  var bs = document.querySelectorAll('#plist [data-add]');
  var btn = null;
  for (var i = 0; i < bs.length; i++) { if (bs[i].textContent.trim() === '加入') { btn = bs[i]; break; } }
  if (!btn) return JSON.stringify({ hit: false });
  var id = btn.dataset.add;
  var its = document.querySelectorAll('#plist .pitem');
  window.__keep = its[its.length - 1];
  btn.click();
  var row = document.querySelector('#plist .pitem[data-id="' + id + '"]');
  return JSON.stringify({ hit: true, kept: document.contains(window.__keep),
    label: row ? row.querySelector('[data-add]').textContent.trim() : '?',
    count: document.getElementById('pool-count').textContent });
})()`));
check("⑩-6 点「加入」只改那一行（列表不整棵重建）",
  add1.hit && add1.kept && add1.label === "已加入" && add1.count.indexOf("已选 1") >= 0,
  `尾节点还在=${add1.kept} 按钮=${add1.label} / ${add1.count}`);
await ev(cdp, `(function(){
  var bs = document.querySelectorAll('#plist [data-add]');
  for (var i = 0; i < bs.length; i++) { if (bs[i].textContent.trim() === '已加入') { bs[i].click(); return; } }
})();`);

/* ================================================================ ⑪ 题库级手动打题型
 * 题库列表的题型小标（.tchip）点开浮层选类型 → 写进题目的 source.qtype_manual（demo 存
 * localStorage 的 sj-demo-qtags-v1 覆盖层）→ 全站生效（小标带「·手」、bucketOf 优先）。
 * 「恢复自动识别」把覆盖层清掉。 */
await nav2(`${BASE}/compose.html`);
const tag0 = JSON.parse(await ev(cdp, `(function(){
  var el = document.querySelector('#plist .tchip');
  return JSON.stringify({ label: el.textContent.trim(), n: document.querySelectorAll('#plist .tchip').length });
})()`));
check("⑪-1 题库列表的题型小标全部可点（无手动标记）",
  tag0.n === 80 && tag0.label.indexOf("·手") < 0, `可点小标 ${tag0.n} 个，首个 = ${tag0.label}`);
await ev(cdp, "document.querySelector('#plist .tchip').click()");
await sleep(250);
const pick0 = JSON.parse(await ev(cdp, `(function(){
  var m = document.querySelector('.typepick');
  return JSON.stringify({ open: !!m, items: m ? m.querySelectorAll('.qmi').length : 0,
    hasClear: m ? !!m.querySelector('.qmi-clear') : null });
})()`));
check("⑪-2 点小标弹出打标浮层（9 类，没打过标不给「恢复自动」）",
  pick0.open && pick0.items === 9 && pick0.hasClear === false,
  `浮层开=${pick0.open} 选项=${pick0.items} 恢复项=${pick0.hasClear}`);
/* 选「计算题」→ 落库 + 小标刷新 + 覆盖层写进 localStorage */
const tag1 = JSON.parse(await ev(cdp, `(function(){
  var id = Number(document.querySelector('#plist .tchip').dataset.taid);
  document.querySelector('.typepick .qmi[data-t="calc"]').click();
  return new Promise(function(res){
    setTimeout(function(){
      var chip = document.querySelector('#plist .tchip[data-taid="' + id + '"]');
      var tags = JSON.parse(localStorage.getItem('sj-demo-qtags-v1') || '{}');
      res(JSON.stringify({ id: id, label: chip ? chip.textContent.trim() : '?',
        tagged: tags[String(id)] || null }));
    }, 400);
  });
})()`));
check("⑪-3 选「计算题」后小标变成「计算题 ·手」，覆盖层落库",
  tag1.label === "计算题 ·手" && tag1.tagged === "calc",
  `小标 = ${tag1.label}，localStorage = ${JSON.stringify(tag1.tagged)}`);
/* 刷新后依然在（demo 的持久层生效） */
await nav2(`${BASE}/compose.html`);
const tag2 = JSON.parse(await ev(cdp, `(function(){
  var chip = document.querySelector('#plist .tchip[data-taid="' + ${tag1.id} + '"]');
  return JSON.stringify({ label: chip ? chip.textContent.trim() : '?' });
})()`));
check("⑪-4 刷新页面后打标还在", tag2.label === "计算题 ·手", tag2.label);
/* 恢复自动：浮层出现「恢复自动识别」，点了之后小标和覆盖层都清掉 */
await ev(cdp, `document.querySelector('#plist .tchip[data-taid="' + ${tag1.id} + '"]').click()`);
await sleep(250);
const tag3 = JSON.parse(await ev(cdp, `(function(){
  var m = document.querySelector('.typepick');
  if (!m) return JSON.stringify({ open: false });
  var clear = m.querySelector('.qmi-clear');
  if (!clear) return JSON.stringify({ open: true, hasClear: false });
  clear.click();
  return new Promise(function(res){
    setTimeout(function(){
      var chip = document.querySelector('#plist .tchip[data-taid="' + ${tag1.id} + '"]');
      var tags = JSON.parse(localStorage.getItem('sj-demo-qtags-v1') || '{}');
      res(JSON.stringify({ open: true, hasClear: true, label: chip.textContent.trim(),
        tagged: tags[${tag1.id}] }));
    }, 400);
  });
})()`));
check("⑪-5 「恢复自动识别」清掉打标（小标回自动、覆盖层清空）",
  tag3.hasClear && tag3.label.indexOf("·手") < 0 && !tag3.tagged,
  `恢复项=${tag3.hasClear} 小标=${tag3.label} 覆盖层=${JSON.stringify(tag3.tagged)}`);

/* ---------------------------------------------------------------- ⑫ 打印预览
 * 排版工具条的「打印预览」：同一份排版数据（含未保存改动）按打印态重画进全屏遮罩 ——
 * 没有任何编辑控件、按 A4 分页并标页数；关闭后回排版态原样。 */
await nav2(`${BASE}/compose.html`);
/* 加两道**不同的**题（同一行的按钮再点一下是移出） */
await ev(cdp, "[].slice.call(document.querySelectorAll('[data-add]'))[0].click();");
await sleep(500);
await ev(cdp, "[].slice.call(document.querySelectorAll('[data-add]'))[10].click();");
await sleep(500);
check("⑫-1 排版工具条有「打印预览」按钮",
  await ev(cdp, "!!document.getElementById('lay-preview') && document.getElementById('lay-preview').textContent === '打印预览'"));
await ev(cdp, "document.getElementById('lay-preview').click()");
await sleep(2200);   // 预览要等插图加载（上限 1.2s）再分页
const pv = JSON.parse(await ev(cdp, `(function(){
  var pv = document.getElementById('lay-pv');
  if (!pv) return JSON.stringify({ open: false });
  return JSON.stringify({
    open: true,
    pages: document.getElementById('pv-pages').textContent || '',
    disp: getComputedStyle(pv).display,
    editCtrl: pv.querySelectorAll('.sec-edit, .qbar, .figh, .figcapbtn, .sec-tinp').length,
    secTitles: pv.querySelectorAll('#pv-sheets .sec-title').length,
    items: pv.querySelectorAll('#pv-sheets .gitem[data-qid]').length,
    editItems: document.querySelectorAll('#sheets .gitem[data-qid]').length,
    bodyLocked: document.body.classList.contains('pv-open'),
  });
})()`));
check("⑫-2 点「打印预览」出全屏遮罩并标出页数（真实盖住页面）",
  pv.open && pv.bodyLocked && pv.disp === "flex" && /共 \d+ 页/.test(pv.pages),
  JSON.stringify(pv));
check("⑫-3 预览里没有任何编辑控件（板块标题是纯文字）", pv.editCtrl === 0 && pv.secTitles > 0,
  `编辑控件=${pv.editCtrl} 纯标题=${pv.secTitles}`);
check("⑫-4 预览的题目与编辑态一致（含未保存改动）", pv.items === pv.editItems,
  `预览 ${pv.items} 题 / 编辑态 ${pv.editItems} 题`);
await ev(cdp, "document.getElementById('pv-close').click()");
await sleep(300);
check("⑫-5 关闭预览回到排版态（遮罩移除、编辑控件还在）",
  await ev(cdp, "!document.getElementById('lay-pv') && !document.body.classList.contains('pv-open') && document.querySelectorAll('#sheets .sec-edit').length > 0"));

/* 收尾：把自检造的卷删掉，别污染用户要试的环境；编号方案改回默认 */
await ev(cdp, "document.getElementById('lay-no').click();");
await setSel("no-big-style", "中文数字 一");
await setSel("no-big-wrap", "、");
await ev(cdp, `localStorage.setItem('sj-demo-customs-v1', JSON.stringify(
  JSON.parse(localStorage.getItem('sj-demo-customs-v1')).filter(function(c){return c.title!=='自检组卷台';})));`);

/* ---------------------------------------------------------------- ⑬ 组卷卡片打印 icon
 * 「我的组卷」卡片右上角的打印机小图标：点它进 print.html?custom=N 看卷面 / 打印。 */
await nav2(`${BASE}/customs.html`);
await sleep(1200);
const cpr = JSON.parse(await ev(cdp, `(function(){
  var a = document.querySelector('#list .ccard .cprint');
  return JSON.stringify({ n: document.querySelectorAll('#list .ccard').length,
    href: a ? a.getAttribute('href') : null,
    svg: a ? !!a.querySelector('svg') : false });
})()`));
check("⑬-1 组卷卡片右上角有打印 icon（指向 print.html?custom=N）",
  cpr.n > 0 && /^print\.html\?custom=\d+$/.test(cpr.href || "") && cpr.svg,
  `卡片 ${cpr.n} 张，icon href = ${cpr.href}`);
await ev(cdp, "document.querySelector('#list .ccard .cprint').click()");
await sleep(2200);
const pvUrl = await ev(cdp, "location.pathname + location.search");
const pvQs = JSON.parse(await ev(cdp, `JSON.stringify({
  gitems: document.querySelectorAll('#sheets .gitem[data-qid]').length,
  layBtn: !!document.getElementById('btn-lay') })`));
check("⑬-2 点打印 icon 进入打印界面（?custom=N）", /print\.html\?custom=\d+$/.test(pvUrl), pvUrl);
check("⑬-3 打印界面出卷面（有题、排版按钮在）", pvQs.gitems > 0 && pvQs.layBtn, pvQs);

/* ---------------------------------------------------------------- ⑭ 题目手动修正（按题型简单面板，2026-10-07 二次简化 + 内嵌公式编辑器）
 * 用户原话：算式/比大小给一个公式编辑器就够；只有选择题才有选项；图片能编辑/替换。
 *   算式/比大小 = 内嵌 math-field 公式编辑器本体（所见即所得，无文本框无预览）；
 *   其余 = 一个文本框（$…$ = 复杂公式、［图：…］ = 插图占位）；图列表（缩略图+说明+调整/替换+删除）。
 * 可读算式存 text 片段（渲染层 mathify 排版无损）。演示覆盖层 sj-demo-qedits-v1，收尾清掉。 */
await nav2(`${BASE}/question.html?id=1`);
await sleep(2000);
await ev(cdp, "document.getElementById('q-edit').click()");
/* 公式编辑器模块懒加载（首帧只有空 math-field），轮询等 upgrade */
let ed0 = null;
for (let i = 0; i < 25 && !ed0; i++) {
  await sleep(300);
  const r = JSON.parse(await ev(cdp, `(function(){
    var mf = document.getElementById('e-mf');
    return JSON.stringify({ open: document.getElementById('editor').style.display !== 'none',
      mf: !!(mf && mf.setOptions),
      val: mf ? String(mf.value == null ? '' : mf.value) : null,
      noTa: !document.getElementById('e-stem'),
      noFx: !document.getElementById('e-fx'),
      noPv: !document.getElementById('e-pv'),
      noLoad: !document.getElementById('e-mf-load'),
      rows: document.querySelectorAll('#e-opts .orow').length,
      addBtn: !!document.getElementById('e-add'),
      stemHidden: document.getElementById('stem').style.display === 'none' });
  })()`));
  if (r && r.mf && r.noLoad) ed0 = r;
}
check("⑭-1 计算题 = 内嵌公式编辑器：8×8+7= 成 LaTeX（\\times）、无文本框无弹层钮无预览无选项",
  !!ed0 && ed0.open && ed0.stemHidden && ed0.mf && ed0.noTa && ed0.noFx && ed0.noPv
  && /times/.test(ed0.val || "") && ed0.rows === 0 && !ed0.addBtn,
  JSON.stringify(ed0));
/* 改算式（两行，覆盖 \displaylines 外壳的完整换行链路）-> 保存 */
await ev(cdp, `(function(){
  var mf = document.getElementById('e-mf');
  mf.value = "\\\\displaylines{12 \\\\times 3 = \\\\\\\\ 4 \\\\times 5 =}";
})()`);
await sleep(400);
await ev(cdp, "document.getElementById('e-save').click()");
await sleep(900);
const saved = JSON.parse(await ev(cdp, `(function(){
  var c = document.getElementById('stem').cloneNode(true);
  [].forEach.call(c.querySelectorAll('.katex-mathml'), function (e) { e.remove(); }); // 隐藏 MathML 三份文本
  return JSON.stringify({
    stem: c.textContent,
    opts: document.querySelectorAll('#options .opts .box b').length,
    okMark: !!document.querySelector('#marks .mark.ok'),
    meta: document.getElementById('meta').textContent });
})()`));
check("⑭-2 保存后渲染新内容（两行算式 + 已人工校对角标，计算题仍无选项）",
  saved.stem.indexOf("12×3") >= 0 && saved.stem.indexOf("4×5") >= 0
    && saved.opts === 0 && saved.okMark && saved.meta.indexOf("已人工修改") >= 0,
  JSON.stringify(saved));
/* 刷新后修改还在（演示覆盖层生效）；可读算式存 text 片段（两行一个片段），mathify 照常排 KaTeX */
await nav2(`${BASE}/question.html?id=1`);
await sleep(2000);
const qedAfter = JSON.parse(await ev(cdp, `(function(){
  return CloudAPI.getQuestion('1').then(function (row) {
    var t = (row.stem || [])[0] || {};
    var c = document.getElementById('stem').cloneNode(true);
    [].forEach.call(c.querySelectorAll('.katex-mathml'), function (e) { e.remove(); });
    return JSON.stringify({
      seg: { t: t.t, v: t.v },
      stem: c.textContent,
      opts: document.querySelectorAll('#options .opts .box b').length,
      tex: !!document.querySelector('#stem .katex'),
      editBtn: !!document.getElementById('q-edit') });
  });
})()`));
check("⑭-3 刷新后修改还原（覆盖层）；算式存 text 片段（× 原样、两行\\n分隔）且公式照常渲染",
  qedAfter.opts === 0 && qedAfter.tex && qedAfter.editBtn
    && qedAfter.seg.t === "text" && qedAfter.seg.v === "12×3=\n4×5="
    && qedAfter.stem.indexOf("12×3") >= 0,
  JSON.stringify(qedAfter));
/* 收尾：清掉这道题的修正，别污染演示环境 */
await ev(cdp, `localStorage.removeItem('sj-demo-qedits-v1')`);

/* ⑭-2b 文本为主的题在文本框里直接补一行算式，存 text 片段、mathify 照常渲染 */
const edMix = JSON.parse(await ev(cdp, `(function(){
  return CloudAPI.listAllQuestions().then(function (qs) {
    for (var i = 0; i < qs.length; i++) {
      var b = window.QType ? QType.bucketOf(qs[i]) : null;   // 算式/比大小面板是 math-field，没文本框
      var ts = (qs[i].stem || []).filter(function (s) { return s.t === "text" && String(s.v||"").length > 4; });
      if (ts.length && qs[i].id !== '1' && b !== 'calc' && b !== 'compare') {
        return JSON.stringify({ id: String(qs[i].id) });
      }
    }
    return JSON.stringify(null);
  });
})()`));
let edMixOk = false, edMixDetail = "题库里没有文本题干可测";
if (edMix) {
  await nav2(`${BASE}/question.html?id=${edMix.id}`);
  await sleep(2000);
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(400);
  await ev(cdp, `(function(){
    var ta = document.getElementById('e-stem');
    ta.value = ta.value + "\\n3×4=12";
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  await ev(cdp, "document.getElementById('e-save').click()");
  await sleep(900);
  edMixDetail = JSON.parse(await ev(cdp, `(function(){
    return CloudAPI.getQuestion(${JSON.stringify(edMix.id)}).then(function (row) {
      var all = (row.stem || []).map(function (s) { return s.t + ":" + String(s.v||""); }).join(" | ");
      return JSON.stringify({ all: all,
        has: all.indexOf("3×4=12") >= 0,
        rendered: !!document.querySelector('#stem .katex') });
    });
  })()`));
  edMixOk = edMixDetail.has && edMixDetail.rendered;
}
check("⑭-2b 文本题补一行算式，保存后 text 片段照常按公式渲染", edMixOk, JSON.stringify(edMixDetail));
await ev(cdp, `localStorage.removeItem('sj-demo-qedits-v1')`);

/* 对照：填空题编辑面板 = 纯文本框，无选项区无加选项钮，有空格计数 */
const edFill = JSON.parse(await ev(cdp, `(function(){
  return CloudAPI.listAllQuestions().then(function (qs) {
    for (var i = 0; i < qs.length; i++) {
      if (window.QType && QType.bucketOf(qs[i]) === "fill") {
        return CloudAPI.getQuestion(String(qs[i].id)).then(function (row) {
          return JSON.stringify({ id: String(row.id) });
        });
      }
    }
    return JSON.stringify(null);
  });
})()`));
let edFillOk = false, edFillDetail = "题库里没有填空题";
if (edFill) {
  await nav2(`${BASE}/question.html?id=${edFill.id}`);
  await sleep(2000);
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(400);
  const ef = JSON.parse(await ev(cdp, `(function(){
    return JSON.stringify({ addBtn: !!document.getElementById('e-add'),
      rows: document.querySelectorAll('#e-opts .orow').length,
      ta: !!document.getElementById('e-stem'),
      blankCnt: (document.getElementById('e-blank') || {}).textContent || '' });
  })()`));
  edFillOk = !ef.addBtn && ef.rows === 0 && ef.ta && ef.blankCnt.indexOf("空") >= 0;
  edFillDetail = JSON.stringify(ef);
}
check("⑭-1c 填空题面板：纯文本框，无加选项钮、无选项区，空格计数在", edFillOk, edFillDetail);

/* 对照：带图的题编辑面板出「图列表」（缩略图 + 调整/替换 + 删除） */
const edFig = JSON.parse(await ev(cdp, `(function(){
  return CloudAPI.listAllQuestions().then(function (qs) {
    for (var i = 0; i < qs.length; i++) {
      var f = (qs[i].stem || []).filter(function (s) { return s.t === "figure"; })[0];
      if (f) return JSON.stringify({ id: String(qs[i].id) });
    }
    return JSON.stringify(null);
  });
})()`));
let edFigOk = false, edFigDetail = "题库里没有带图的题";
if (edFig) {
  await nav2(`${BASE}/question.html?id=${edFig.id}`);
  await sleep(2000);
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(400);
  const eg = JSON.parse(await ev(cdp, `(function(){
    var th = document.querySelector('#e-figs .fthumb');
    return JSON.stringify({ rows: document.querySelectorAll('#e-figs .figrow').length,
      rep: !!document.querySelector('[data-frep]'),
      del: !!document.querySelector('[data-fdel]'),
      adj: !!document.querySelector('[data-fadj]'),
      thumbW: th ? th.clientWidth : 0,
      phInTa: (document.getElementById('e-stem') || {}).value
        ? document.getElementById('e-stem').value.indexOf('［图：') >= 0 : false });
  })()`));
  edFigOk = eg.rows >= 1 && eg.rep && eg.del && !eg.adj && eg.phInTa && eg.thumbW >= 60;
  edFigDetail = JSON.stringify(eg);
}
check("⑭-1d 带图题面板：图列表（缩略图 + 替换/删除，无调整钮）+ 占位行在文本框里", edFigOk, edFigDetail);

/* 对照：选择题模板仍默认给 4 行空选项 + 加选项钮 */
const edChoice = JSON.parse(await ev(cdp, `(function(){
  return CloudAPI.listAllQuestions().then(function (qs) {
    for (var i = 0; i < qs.length; i++) {
      if (window.QType && QType.bucketOf(qs[i]) === "choice") {
        return CloudAPI.getQuestion(String(qs[i].id)).then(function (row) {
          return JSON.stringify({ id: String(row.id) });
        });
      }
    }
    return JSON.stringify(null);
  });
})()`));
let edChoiceOk = false, edChoiceDetail = "题库里没有选择题";
if (edChoice) {
  await nav2(`${BASE}/question.html?id=${edChoice.id}`);
  await sleep(2000);
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(400);
  const ec = JSON.parse(await ev(cdp, `(function(){
    return JSON.stringify({ rows: document.querySelectorAll('#e-opts .orow').length,
      addBtn: !!document.getElementById('e-add'),
      ta: !!document.getElementById('e-stem') });
  })()`));
  edChoiceOk = ec.rows === 4 && ec.addBtn && ec.ta; edChoiceDetail = JSON.stringify(ec);
}
check("⑭-1b 选择题面板：4 行空选项 + 加选项钮 + 文本框", edChoiceOk, edChoiceDetail);

/* ⑭-1e 公式编辑器（MathLive 懒加载）：在填空题（文本框 + 弹层钮）上测弹层 ——
 * 计算题面板已内嵌编辑器本体、没有这个钮了。拼分式 -> 插入后题干出现 $…$（不保存，纯 UI） */
await nav2(`${BASE}/question.html?id=${edFill ? edFill.id : 1}`);
await sleep(2000);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(500);
await ev(cdp, "document.getElementById('e-fx').click()");
await sleep(4500);                       // 首次动态 import 模块（1MB+），headless 里给足时间
const fxr = JSON.parse(await ev(cdp, `(function(){
  var f = document.getElementById('fx-field');
  if (!f) return JSON.stringify(null);
  f.value = '\\\\frac{3}{4}';
  document.getElementById('fxm-ok').click();
  var ta = document.getElementById('e-stem');
  return JSON.stringify({ mf: f.tagName === 'MATH-FIELD',
    hasFx: ta.value.indexOf('$\\\\frac{3}{4}$') >= 0,
    closed: document.getElementById('fxm').style.display === 'none' });
})()`));
check("⑭-1e 公式编辑器（MathLive）：插入分式 3/4 -> 题干出现 $…$、弹层关闭",
  !!fxr && fxr.mf && fxr.hasFx && fxr.closed, JSON.stringify(fxr));

/* ⑭-1f 弹层插入可读算式：编辑器里的 LaTeX 先转回可读符号（×÷·）落进框里，
 * 不包 $…$（mathify 全站认可读符号，存 text 片段渲染无损；$…$ 会把句子搞成混合体） */
await ev(cdp, `(function(){
  var ta = document.getElementById('e-stem');
  ta.value = ta.value.replace(/\\$\\\\frac\\{3\\}\\{4\\}\\$/g, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await ev(cdp, "document.getElementById('e-fx').click()");
await sleep(800);
const fxp = JSON.parse(await ev(cdp, `(function(){
  var f = document.getElementById('fx-field');
  f.value = '3 \\\\times 4 \\\\cdot 5 =';
  document.getElementById('fxm-ok').click();
  var ta = document.getElementById('e-stem');
  return JSON.stringify({ plain: ta.value.indexOf('3 × 4 · 5 =') >= 0,
    noDollar: ta.value.indexOf('$') < 0,
    closed: document.getElementById('fxm').style.display === 'none' });
})()`));
check("⑭-1f 弹层插入：LaTeX 转回可读符号（3 × 4 · 5 =）不包 $…$、弹层关闭",
  !!fxp && fxp.plain && fxp.noDollar && fxp.closed, JSON.stringify(fxp));

/* ⑭-1g 分式输入：「分式 a/b」钮已按用户要求删除（2026-10-07），入口只剩
 * 长按 ÷ 变体 + 直接打 LaTeX —— 断言按钮不存在且 .fxm-hint 提示行还在（防回退） */
const fxf = JSON.parse(await ev(cdp, `(function(){
  return JSON.stringify({ noBtn: !document.getElementById('fxm-frac'),
    hint: !!document.querySelector('.fxm-hint') });
})()`));
check("⑭-1g 分式入口：「分式 a/b」钮已删、提示行在位（长按 ÷ / LaTeX）",
  !!fxf && fxf.noBtn && fxf.hint, JSON.stringify(fxf));

/* ---------------------------------------------------------------- ⑮ 题内插图替换
 * 「替换」（#figm）= 整页原图上拖框改 bbox（+ 顺手摆正角度烤 seg.fix）。
 * 「调整」（大小/旋转/拉伸弹层）已于 2026-10-07 整体移除 —— 断言它不再出现，防止回潮。
 * 演示图片 assets/benchmark/… 与页面同源，canvas 不 tainted；改动走 ⑭ 的 stem 覆盖层。
 * 收尾同样清掉。 */
const figQ = JSON.parse(await ev(cdp, `(function(){
  return CloudAPI.listAllQuestions().then(function(qs){
    for (var i = 0; i < qs.length; i++) {
      var f = (qs[i].stem || []).filter(function (s) { return s.t === "figure" && s.bbox; })[0];
      if (f) return JSON.stringify({ id: String(qs[i].id), bbox: f.bbox });
    }
    return JSON.stringify(null);
  });
})()`));
check("⑮-0 题库里找得到带 bbox 插图的题", !!figQ && figQ.bbox.length === 4, JSON.stringify(figQ));

if (figQ) {
  await nav2(`${BASE}/question.html?id=${figQ.id}`);
  await sleep(2400);
  const fa0 = JSON.parse(await ev(cdp, `(function(){
    return JSON.stringify({
      boxes: document.querySelectorAll('#stem .figbox').length,
      adj: document.querySelectorAll('#stem .figadj').length,
      img: !!document.querySelector('#stem .figbox .cropbox img') });
  })()`));
  check("⑮-1 题干图不再挂「调整」钮（功能已移除）",
    fa0.boxes >= 1 && fa0.adj === 0 && fa0.img, JSON.stringify(fa0));

  /* 编辑面板图列表：替换/删除钮在、「调整」钮没有 */
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(500);
  const fa1 = JSON.parse(await ev(cdp, `(function(){
    return JSON.stringify({
      rep: document.querySelectorAll('[data-frep]').length,
      del: document.querySelectorAll('[data-fdel]').length,
      adj: document.querySelectorAll('[data-fadj]').length });
  })()`));
  check("⑮-2 编辑图列表：替换/删除钮在、「调整」钮没有",
    fa1.rep >= 1 && fa1.del === fa1.rep && fa1.adj === 0, JSON.stringify(fa1));

  /* 「替换」弹层：框落在识别 bbox 上（整页原图拖框） */
  await ev(cdp, "document.querySelector('[data-frep]').click()");
  await sleep(900);
  const fa2 = JSON.parse(await ev(cdp, `(function(){
    var im = document.getElementById('figm-img'), r = document.getElementById('figm-rect');
    var s = im.clientWidth / im.naturalWidth;
    return JSON.stringify({
      open: document.getElementById('figm').style.display !== 'none',
      loaded: im.naturalWidth > 0,
      rect: [r.offsetLeft / s, r.offsetTop / s, (r.offsetLeft + r.offsetWidth) / s, (r.offsetTop + r.offsetHeight) / s] });
  })()`));
  const b = figQ.bbox;
  const near = fa2.rect.map(function (v, i) { return Math.abs(v - b[i]) < 3; }).every(Boolean);
  check("⑮-3 「替换」弹层：框落在识别 bbox 上（整页原图拖框）",
    fa2.open && fa2.loaded && near, JSON.stringify(fa2));

  /* 「摆正」转的是**选区本身**（不是"选完再转框里的内容"）：
     拉滑杆 -> #figm-rect 自己在屏幕上转了（外接框变大），而未旋转的框尺寸没变。 */
  const faRot = JSON.parse(await ev(cdp, `(function(){
    var r = document.getElementById('figm-rect');
    var g = getComputedStyle(r);
    var before = { ow: r.offsetWidth, oh: r.offsetHeight,
      bw: Math.round(r.getBoundingClientRect().width) };
    var bm = new DOMMatrix(g.transform);
    before.deg = Math.atan2(bm.b, bm.a) * 180 / Math.PI;
    var el = document.getElementById('figm-rot');
    el.value = '3'; el.dispatchEvent(new Event('input'));
    g = getComputedStyle(r);
    var m = new DOMMatrix(g.transform);
    return JSON.stringify({ before: before,
      deg: Math.atan2(m.b, m.a) * 180 / Math.PI,
      ow: r.offsetWidth, oh: r.offsetHeight,
      bw: Math.round(r.getBoundingClientRect().width),
      label: document.getElementById('figm-rotv').textContent,
      read: document.getElementById('figm-read').textContent,
      rh: document.querySelectorAll('#figm-rect .rh').length,
      prev: document.querySelectorAll('#figm-prev canvas').length });
  })()`));
  check("⑮-3b 摆正转的是**选区本身**：滑杆 3° 框自己转了（外接框变大、框尺寸没变）",
    Math.abs(faRot.before.deg) < 0.01 && Math.abs(faRot.deg - 3) < 0.05
    && faRot.ow === faRot.before.ow && faRot.oh === faRot.before.oh
    && faRot.bw > faRot.before.bw && faRot.rh === 1 && faRot.prev === 1,
    JSON.stringify(faRot));
  check("⑮-3b2 角度回显到位（滑杆旁读数 + 尺寸行里也带角度）",
    faRot.label === "3.0°" && faRot.read.indexOf("转 3.0°") >= 0, faRot.read);

  /* 转把手：拖顶上那个圆点也能转（不是只有滑杆），转完滑杆跟着变 */
  const rhPos = JSON.parse(await ev(cdp, `(function(){
    var el = document.getElementById('figm-rot'); el.value = '0'; el.dispatchEvent(new Event('input'));
    document.getElementById('figm-rect').scrollIntoView({ block: 'center' });
    var r = document.getElementById('figm-rect').getBoundingClientRect();
    var h = document.querySelector('#figm-rect .rh').getBoundingClientRect();
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      hx: h.left + h.width / 2, hy: h.top + h.height / 2 });
  })()`));
  const rad = Math.hypot(rhPos.hx - rhPos.cx, rhPos.hy - rhPos.cy);
  const a0 = Math.atan2(rhPos.hy - rhPos.cy, rhPos.hx - rhPos.cx);
  const a1 = a0 + 5 * Math.PI / 180;
  const mv = { x: rhPos.cx + rad * Math.cos(a1), y: rhPos.cy + rad * Math.sin(a1) };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rhPos.hx, y: rhPos.hy, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mv.x, y: mv.y, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mv.x, y: mv.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
  const faH = JSON.parse(await ev(cdp, `(function(){
    var m = new DOMMatrix(getComputedStyle(document.getElementById('figm-rect')).transform);
    return JSON.stringify({ deg: Math.atan2(m.b, m.a) * 180 / Math.PI,
      slider: Number(document.getElementById('figm-rot').value) });
  })()`));
  check("⑮-3c 拖圆点转选区：指针转 5° → 框转 5°、滑杆同步",
    Math.abs(faH.deg - 5) < 0.6 && Math.abs(faH.slider - faH.deg) < 0.01, JSON.stringify(faH));

  /* 摆正的几何：造一张"歪 5° 的黑长条"测试图，选区跟着转 5° ——
     出来必须是**摆正**（条带左右两端行齐平）且**紧贴**（画布就是选区尺寸，不是转完外扩的那块）。
     旧的"先选正框、再转框里内容"实现会同时挂在这两条上（画布 306×106、条带斜 10°）。 */
  const geo = JSON.parse(await ev(cdp, `(function(){
    var src = document.createElement('canvas'); src.width = 400; src.height = 400;
    var g = src.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 400);
    g.save(); g.translate(200, 200); g.rotate(5 * Math.PI / 180);
    g.fillStyle = '#000'; g.fillRect(-120, -8, 240, 16);      // 长 240、厚 16、歪 5°
    g.restore();
    var c = window.__figm.bake([50, 160, 350, 240], 5, 100, 100, src, 900);   // 选区 300×80，跟着歪 5°
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    function band(x) {                                        // 某一列上墨迹的行范围
      var rows = [];
      for (var y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4] < 128) rows.push(y);
      return rows.length ? [rows[0], rows[rows.length - 1]] : null;
    }
    var lo = -1, hi = -1;
    for (var y = 0; y < c.height; y++)
      for (var x = 0; x < c.width; x++)
        if (d[(y * c.width + x) * 4] < 128) { if (lo < 0) lo = y; hi = y; break; }
    return JSON.stringify({ w: c.width, h: c.height, lo: lo, hi: hi,
      L: band(45), R: band(c.width - 45) });                  // 两端都落在条带里（局部 ±105）
  })()`));
  const bandMid = (a) => (a[0] + a[1]) / 2;
  check("⑮-3d 摆正几何：歪 5° 的内容 + 选区转 5° → 出来是摆正的（两端齐平）且紧贴（画布=选区尺寸）",
    Math.abs(geo.w - 300) <= 3 && Math.abs(geo.h - 80) <= 3 && !!geo.L && !!geo.R
    && Math.abs(bandMid(geo.L) - bandMid(geo.R)) <= 2 && (geo.hi - geo.lo) <= 20,
    JSON.stringify(geo) + " 两端行中: " + (geo.L && geo.R ? bandMid(geo.L) + "/" + bandMid(geo.R) : "-"));

  /* 替换弹层里摆正 2° -> 保存：烤 data URI、seg.rot=2、bbox 不变、留 bbox0 */
  await ev(cdp, `(function(){
    var el = document.getElementById('figm-rot');
    el.value = '2';
    el.dispatchEvent(new Event('input'));
  })()`);
  await sleep(300);
  await ev(cdp, "document.getElementById('figm-save').click()");
  await sleep(1000);
  /* 保存是从编辑态里发起的：figmPersist 留在编辑器里刷图列表 —— 退出编辑再验证卷面渲染 */
  await ev(cdp, "document.getElementById('e-cancel').click()");
  await sleep(900);
  const fa3 = JSON.parse(await ev(cdp, `(function(){
    var fx = document.querySelector('#stem .figbox.fixed');
    return CloudAPI.getQuestion(${JSON.stringify(figQ.id)}).then(function (row) {
      var f = (row.stem || []).filter(function (s) { return s.t === "figure"; })[0];
      return JSON.stringify({ rot: f.rot, bbox0: !!f.bbox0, sameBbox: !!f.bbox, bbox: f.bbox,
        isData: !!(f.fix && f.fix.indexOf('data:image/jpeg') === 0),
        ok: !!(row.source && row.source.edited),
        rendered: !!fx });
    });
  })()`));
  check("⑮-4 替换+摆正保存：烤 data URI、seg.rot=2、bbox 在、留 bbox0",
    fa3.isData && fa3.rot === 2 && fa3.bbox0 && fa3.sameBbox && fa3.ok && fa3.rendered,
    JSON.stringify(fa3));

  /* 重开弹层：框与角度按上次存的还原（不是回识别原框）——
     存的是「未旋转的局部框 + 角度」，所以重开能一字不差地接着调。 */
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(500);
  await ev(cdp, "document.querySelector('[data-frep]').click()");
  await sleep(900);
  const fa4 = JSON.parse(await ev(cdp, `(function(){
    var im = document.getElementById('figm-img'), r = document.getElementById('figm-rect');
    var s = im.clientWidth / im.naturalWidth;
    var m = new DOMMatrix(getComputedStyle(r).transform);
    return JSON.stringify({
      rect: [r.offsetLeft / s, r.offsetTop / s, (r.offsetLeft + r.offsetWidth) / s, (r.offsetTop + r.offsetHeight) / s],
      deg: Math.atan2(m.b, m.a) * 180 / Math.PI,
      slider: Number(document.getElementById('figm-rot').value),
      restore: document.getElementById('figm-restore').style.display });
  })()`));
  const back4 = fa4.rect.every(function (v, i) { return Math.abs(v - fa3.bbox[i]) < 3; });
  check("⑮-4b 重开弹层：框与角度按上次存的还原（续调不丢）",
    back4 && Math.abs(fa4.deg - fa3.rot) < 0.05 && fa4.slider === fa3.rot && fa4.restore !== "none",
    JSON.stringify(fa4) + " vs bbox " + JSON.stringify(fa3.bbox) + " rot " + fa3.rot);

  /* 「恢复识别原状」（替换弹层里）：fix/rot/bbox0 全清，回 bbox 现裁 */
  await ev(cdp, "document.getElementById('figm-restore').click()");
  await sleep(1000);
  const fa5 = JSON.parse(await ev(cdp, `(function(){
    return CloudAPI.getQuestion(${JSON.stringify(figQ.id)}).then(function (row) {
      var f = (row.stem || []).filter(function (s) { return s.t === "figure"; })[0];
      return JSON.stringify({ bbox: f.bbox, noFix: !f.fix, noRot: !f.rot, noBbox0: !f.bbox0 });
    });
  })()`));
  const back = fa5.bbox && fa5.bbox.every(function (v, i) { return Math.abs(v - b[i]) < 2; });
  check("⑮-5 「恢复识别原状」清掉烤图/旋转/留底，回 bbox 现裁",
    back && fa5.noFix && fa5.noRot && fa5.noBbox0, JSON.stringify(fa5));
  /* 收尾：清掉这道题的图片调整 */
  await ev(cdp, `localStorage.removeItem('sj-demo-qedits-v1')`);
}

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "   (" + c.detail + ")" : ""}`);
}
console.log(bad === 0 ? "\n全部通过" : `\n${bad} 项未通过`);
chrome.kill();
process.exit(bad === 0 ? 0 : 1);
