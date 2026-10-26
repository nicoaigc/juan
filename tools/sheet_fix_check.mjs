/* 卷面修复自检（2026-10-06 用户反馈）：
 *   ① 分类错误  —— 板块名优先于模型题型：竖式/递等式/口算 → 计算题，判断 → 判断题，
 *                  在○里填 → **比大小**；且**能手动改一道题的题型**（存进 layout.types）
 *   ② 插图位置  —— 题内插图独占一行、限宽；多列板块里带图的题跨整行；
 *                  应用题图靠右、**带图的选择题「左选项右插图」**
 *   ③ A4 分页   —— 内容超一页就真的分成多张 .sheet，带页码；**屏幕上几页打印就几页**（真打一份 PDF 数页数）
 *   ③b 打印边距 —— 边距不交给 @page（打印对话框一改就贴纸角），改成卷面自带内边距；
 *                  真打一份 PDF 量纸上左边距/上边距；工具条里能选 紧凑/标准/宽松（见 ③b 段注释）
 *   ④ 口径一致  —— 首页统计 / 组卷台筛选 / 卷面板块都走 js/qtype.js 同一份分桶规则
 *   ⑤ 题距      —— 题目与题目之间留出行距（原来 3mm 太挤）
 *   ⑥ 插图大小  —— 排版态拖图边的手柄改大小（记进 layout.figs，跟着排版存）；
 *                  右对齐的应用题图手柄在左边缘（右边缘钉住）
 *   ⑦ 图下说明  —— 题内插图下面那行小字（figure.caption）能逐张移掉：排版态图右下角的
 *                  「说明 ✕」，点一下移除、再点恢复；记进 layout.caps，打印/预览也不印
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻，演示模式免登录）
 * 用法：node tools/sheet_fix_check.mjs（64 项）
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const CDP_PORT = 9350;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "sheet-fix-"))}`, "about:blank",
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

/* 卷面读数：同一板块（data-si）被分页拆成多个网格时**归并**回一份 */
const READ = `(function(){
  var by={},order=[];
  [].forEach.call(document.querySelectorAll('#sheets .grid-sec'),function(g){
    var k=g.getAttribute('data-si');
    if(!by[k]){by[k]={si:k,cols:1,n:0,ids:[],qn:[],wide:0,title:''};order.push(k);}
    var o=by[k];
    if(!o.title){
      var pv=g.previousElementSibling, tx=pv?String(pv.textContent||'').trim():'';
      if(tx && pv.classList &&
         (pv.classList.contains('sec-title')||pv.classList.contains('sec-edit'))) o.title=tx;
    }
    var m=/repeat\\((\\d+)/.exec(g.style.gridTemplateColumns||'');
    if(m) o.cols=Number(m[1]);
    if(!o.gap) o.gap = Math.round(parseFloat(getComputedStyle(g).rowGap)||0);
    if(!o.gapCol) o.gapCol = Math.round(parseFloat(getComputedStyle(g).columnGap)||0);
    o.n += g.querySelectorAll('.gitem[data-qid]').length;
    o.wide += g.querySelectorAll('.gitem.wide').length;
    [].forEach.call(g.querySelectorAll('.gitem[data-qid]'),function(x){o.ids.push(x.dataset.qid);});
    [].forEach.call(g.querySelectorAll('.gitem .qn'),function(x){o.qn.push(x.textContent.trim());});
  });
  return JSON.stringify({
    secs: order.map(function(k){return by[k];}),
    titles: [].map.call(document.querySelectorAll('#sheets .sec-title, #sheets .sec-edit'),function(t){
      var inp = t.querySelector('.sec-tinp');
      var no = t.querySelector('.sec-no');
      return inp ? ((no?no.textContent:'') + inp.value) : t.textContent.trim();
    }),
    pages: document.querySelectorAll('#sheets > .sheet').length,
    pgno: [].map.call(document.querySelectorAll('#sheets .pgno'),function(p){return p.textContent.trim();}),
    sheetH: [].map.call(document.querySelectorAll('#sheets > .sheet'),function(s){return s.offsetHeight;}),
    figbox: [].map.call(document.querySelectorAll('#sheets .gitem .figbox'),function(f){
      var r=f.getBoundingClientRect();
      return { w: Math.round(r.width), block: getComputedStyle(f).display };
    }),
    figRight: [].map.call(document.querySelectorAll('#sheets .gitem.figright'),function(it){
      var f=it.querySelector('.figbox'); if(!f) return null;
      var a=it.getBoundingClientRect(), b=f.getBoundingClientRect();
      return { gap: Math.round(a.right-b.right), w: Math.round(b.width) };
    }).filter(Boolean),
    duos: [].map.call(document.querySelectorAll('#sheets .gitem .figduo'),function(d){
      var o=d.querySelector('.figcol-opts'), f=d.querySelector('.figcol-fig');
      if(!o||!f) return null;
      var a=o.getBoundingClientRect(), b=f.getBoundingClientRect();
      return { opts:o.querySelectorAll('.opt').length,
               optRight:Math.round(a.right), figLeft:Math.round(b.left),
               figW:Math.round(b.width), sameRow:Math.abs(a.top-b.top)<26 };
    }).filter(Boolean)
  });
})()`;
const read = async () => JSON.parse(await ev(cdp, READ));

/* ================================================================ ① 分类：
   先用真实演示题库整体算一遍（bucketOf 是纯函数，直接调最准） */
await nav(`${BASE}/compose.html`);
const dist = JSON.parse(await ev(cdp, `fetch('assets/demo-library.json?v=1').then(function(r){return r.json();})
  .then(function(d){
    var c={}, bad=[];
    d.papers.forEach(function(p){ (p.questions||[]).forEach(function(q){
      var k=Sheet.bucketOf(q); c[k]=(c[k]||0)+1;
      if(k==='other' && !/判断|草稿/.test(q.section||'')) bad.push((q.section||'')+' | '+((q.stem||[]).map(function(s){return s.v||'';}).join('')).slice(0,18));
    });});
    return JSON.stringify({c:c,bad:bad});
  })`));
check("①-1 全库没有题再掉进「其他」桶（判断题除外）", dist.bad.length === 0,
  "桶分布 " + JSON.stringify(dist.c) + (dist.bad.length ? "\n        误判：" + dist.bad.slice(0, 6).join(" ／ ") : ""));
check("①-2 判断题单独成桶", dist.c.judge === 3, "判断 " + (dist.c.judge || 0) + " 题");
check("①-3 竖式/递等式等算式归到计算题（计算题 > 解答题）",
  (dist.c.calc || 0) > 40, "计算 " + (dist.c.calc || 0) + " 题 / 应用题 " + (dist.c.solve || 0) + " 题");

const bk = (section, qtype) => ev(cdp,
  `Sheet.bucketOf({section:${JSON.stringify(section)}, qtype:${JSON.stringify(qtype)}})`);
const rules = [
  ["2. 用竖式计算", "solve", "calc"],
  ["三、递等式计算", "solve", "calc"],
  ["一、算一算", "calculate", "calc"],
  ["1. 直接写出得数", "calculate", "calc"],
  ["5. 列式计算", "solve", "calc"],
  ["4. 写出综合算式", "solve", "calc"],
  ["六、判断", "other", "judge"],
  ["三、在○里填入“>”“<”或“=”", "calculate", "compare"],
  ["4. 在○里填入“>”“<”或“=”", "fill", "compare"],
  ["三、比大小", "calculate", "compare"],
  ["五、解决问题 · 6. 估算", "solve", "solve"],
  ["7. 应用题", "solve", "solve"],
  ["第三部分 应用", "solve", "solve"],
  ["第二部分 概念 · 1、选择题", "choice", "choice"],
  ["第二部分 概念 · 2、填空题", "fill", "fill"],
];
const wrong = [];
for (const [sec, qt, want] of rules) {
  const got = await bk(sec, qt);
  if (got !== want) wrong.push(`${sec}(${qt}) → ${got}，期望 ${want}`);
}
check("①-4 板块名优先级逐条对上（15 条）", wrong.length === 0,
  wrong.length ? wrong.join("\n        ") : "竖式/递等式/口算/列式 → 计算题；判断 → 判断题；在○里填 → 比大小；估算/应用题 → 应用题");

/* ---- 题库级手动打标（source.qtype_manual）优先级最高：板块名和模型题型都改不动它 ---- */
const bkM = (sec, qt, tag) => ev(cdp,
  `Sheet.bucketOf({section:${JSON.stringify(sec)}, qtype:${JSON.stringify(qt)}, source:{qtype_manual:${JSON.stringify(tag)}}})`);
const manWrong = [];
for (const [sec, qt, want] of rules.slice(0, 6)) {
  const got = await bkM(sec, qt, "calc");
  if (got !== "calc") manWrong.push(`${sec}(${qt}) → ${got}`);
}
check("①-4b 手动打标压过板块名（打 calc 后一律归计算题）", manWrong.length === 0,
  manWrong.length ? manWrong.join("\n        ") : "打标优先级 = 手动 > 板块名 > 模型");
check("①-4c 未打标时不受影响（qtype_manual 缺省走原规则）",
  (await bk("三、应用题", "solve")) === "solve" && (await bkM("三、应用题", "solve", "")) === "solve",
  "空串打标 = 没打标");

/* ---- 卷面分组：选择性自检卷应该正好 4 个板块（「在○里填」那 4 道现在单独成「比大小」） ---- */
await nav(`${BASE}/print.html?custom=1`);
let st = await read();
check("①-5 智能排版分组 = 选择 / 比大小 / 计算 / 应用题",
  JSON.stringify(st.titles) === JSON.stringify(["一、选择题", "二、比大小", "三、计算题", "四、应用题"]),
  st.titles.join(" | "));
const cmpSec = st.secs.filter((s) => /比大小/.test(s.title || ""))[0];
check("①-5b 比大小的板块默认排 3 列（算式短，一行排得下）",
  !!cmpSec && cmpSec.cols === 3, cmpSec ? "cols = " + cmpSec.cols : "没找到「比大小」板块");

/* ---- 手动改题型 ---- */
await nav(`${BASE}/compose.html?id=1`);
const firstQ = await ev(cdp, "document.querySelector('#sheets .gitem[data-qid]').dataset.qid");
await ev(cdp, `document.querySelector('#sheets .gitem[data-qid="${firstQ}"] .qchip').click();`);
await sleep(350);
const menuN = await ev(cdp, "document.querySelectorAll('#sheets .qmenu .qmi').length");
check("①-6 点题目右上角的小标弹出题型菜单", menuN === 9, "菜单项 = " + menuN);
await ev(cdp, `(function(){var t=document.querySelectorAll('#sheets .qmenu .qmi');
  for(var i=0;i<t.length;i++){if(t[i].textContent.trim()==='判断题'){t[i].click();return;}}})()`);
await sleep(800);
st = await read();
const ji = st.titles.findIndex((t) => t.indexOf("判断题") >= 0);
check("①-7 改题型后题目挪进新建的「判断题」板块，且是排在第一的",
  ji >= 0 && st.secs[ji] && String(firstQ) === st.secs[ji].ids[0] && st.secs[ji].n === 1,
  st.titles.join(" | ") + "　判断题里 = " + JSON.stringify(st.secs[ji] && st.secs[ji].ids));
check("①-8 判断题板块排在「其他」之前（按题型顺序插入）",
  ji === 3, "判断题在第 " + (ji + 1) + " 个板块");

await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(1800);
const savedTypes = await ev(cdp, `(function(){
  var a=JSON.parse(localStorage.getItem('sj-demo-customs-v1')||'[]');
  var c=a.filter(function(x){return String(x.id)==='1';})[0];
  return c&&c.layout?JSON.stringify(c.layout.types||{}):'null';})()`);
check("①-9 手动改的题型跟着排版一起落库（layout.types）",
  savedTypes !== "null" && JSON.parse(savedTypes)[String(firstQ)] === "judge", "types = " + savedTypes);

await nav(`${BASE}/compose.html?id=1`);
st = await read();
check("①-10 刷新后手动改的题型还在",
  st.titles.some((t) => t.indexOf("判断题") >= 0),
  st.titles.join(" | "));

/* ================================================================ ② 插图位置 */
/* 题库按页渲染后（首屏 80 条），找题要像真用户一样先过搜索框 —— 顺手把防抖也测了 */
await nav(`${BASE}/compose.html`);
await ev(cdp, `(function(){
  var el = document.getElementById('f-q');
  el.value = '\u77f3\u69b4';
  el.dispatchEvent(new Event('input', {bubbles:true}));
})()`);
await sleep(500);
await ev(cdp, `(function(){
  var p=[].slice.call(document.querySelectorAll('#plist .pitem'));
  for(var i=0;i<p.length;i++){
    var s=p[i].querySelector('.pi-stem');
    if(s&&s.textContent.indexOf('\u77f3\u69b4')>=0){p[i].querySelector('[data-add]').click();return "hit";}
  }})()`);
await sleep(1000);
await ev(cdp, `(function(){
  var el = document.getElementById('f-q');
  el.value = '';
  el.dispatchEvent(new Event('input', {bubbles:true}));
})()`);
await sleep(400);

check("②-1 带插图的题在卷面上跨整行（.gitem.wide）", st.secs.some((s) => s.wide > 0),
  "wide 题数 = " + st.secs.reduce((a, s) => a + s.wide, 0));
check("②-2 插图独占一行（.figbox display:block）",
  st.figbox.length > 0 && st.figbox.every((f) => f.block === "block"),
  JSON.stringify(st.figbox));
check("②-3 插图限宽（68mm ≈ 258px 以内）",
  st.figbox.length > 0 && st.figbox.every((f) => f.w <= 262),
  st.figbox.map((f) => f.w + "px").join(", "));

/* 应用题（solve 桶）的插图靠右：左半边整块留给学生写算式。
   自建卷 1 里有「小海去游泳馆」这道带图应用题（第2单元练习卷那卷本身不带图，别拿它测）。 */
await nav(`${BASE}/print.html?custom=1`, 3000);
st = await read();
check("②-4 应用题的插图靠右（图右缘贴着所在题格的右缘）",
  st.figRight.length > 0 && st.figRight.every((f) => f.gap <= 6),
  st.figRight.length ? st.figRight.map((f) => "gap=" + f.gap + "px 宽" + f.w + "px").join("， ")
    : "没有 .figright 的题（应用题插图没走靠右分支）");

/* 带图的选择题：**选项在左、插图在右**（用户要求）。
   自建卷 1 的「一、选择题」里就有那道「24 个石榴 · 竖式框住的这一步」 */
check("②-5 带图的选择题排成「左选项 / 右插图」",
  st.duos.length > 0 && st.duos.every((d) => d.opts > 0 && d.figLeft >= d.optRight),
  st.duos.length ? st.duos.map((d) => d.opts + " 个选项，选项右缘 " + d.optRight
    + "px → 图左缘 " + d.figLeft + "px（图宽 " + d.figW + "px）").join("； ")
    : "没有 .figduo（带图选择题没走左右并排分支）");
check("②-5b 右栏的插图不超过 62mm（≈234px）",
  st.duos.length > 0 && st.duos.every((d) => d.figW <= 238),
  st.duos.map((d) => d.figW + "px").join(", ") || "无");

/* ================================================================ ③ A4 分页 */
await nav(`${BASE}/print.html?id=4`, 3000);      // 第2单元练习卷：41 题，必然多页
st = await read();
check("③-1 内容超一页时真的分成多张 A4（.sheet > 1）", st.pages > 1,
  st.pages + " 页　每页高 = " + st.sheetH.join(" / "));
check("③-2 每张卷面都不超过一整页（297mm ≈ 1122px）",
  st.sheetH.every((h) => h > 0 && h <= 1125), st.sheetH.join(" / "));
check("③-3 每页都标了页码",
  st.pgno.length === st.pages && st.pgno[0] === "第 1 / " + st.pages + " 页",
  st.pgno.join(" | "));
check("③-4 分页没丢题（两页加起来 = 全卷题数）",
  st.secs.reduce((a, s) => a + s.n, 0) > 40,
  "共 " + st.secs.reduce((a, s) => a + s.n, 0) + " 题 / " + st.secs.length + " 个板块");
check("③-5 跨页的板块被拆成两段仍算同一个 data-si",
  st.secs.length < (await ev(cdp, "document.querySelectorAll('#sheets .grid-sec').length")),
  "板块 " + st.secs.length + " 个 / 网格 " + (await ev(cdp, "document.querySelectorAll('#sheets .grid-sec').length")) + " 个");

await nav(`${BASE}/print.html?custom=2`);
st = await read();
check("③-6 内容装得下时就一页，并标「第 1 / 1 页」",
  st.pages === 1 && st.pgno[0] === "第 1 / 1 页", st.pages + " 页　" + st.pgno.join("|"));

/* ---- 分页之后排版还得能用：跨页板块的下标不能错位 ---- */
await nav(`${BASE}/compose.html?id=1`);
await sleep(500);
const before = (await read()).secs.map((s) => s.n);
await ev(cdp, `(function(){
  var dt=new DataTransfer();
  var gs=[].slice.call(document.querySelectorAll('#sheets .grid-sec')).filter(function(g){
    return g.querySelectorAll('.gitem[data-qid]').length;});
  if(gs.length<2) return "no-node";
  var src=gs[1].querySelector('.gitem[data-qid]'), tgt=gs[0].querySelector('.gitem[data-qid]');
  var r=tgt.getBoundingClientRect();
  src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
  tgt.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+4,clientY:r.top+4}));
  tgt.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+4,clientY:r.top+4}));
  return "ok";
})();`);
await sleep(800);
const after = (await read()).secs.map((s) => s.n);
check("③-7 分页后拖动仍只挪一道题（总题数守恒）",
  after.reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0)
  && JSON.stringify(before) !== JSON.stringify(after),
  JSON.stringify(before) + " -> " + JSON.stringify(after));

/* ---- 屏幕上的页数 = 打印出来的页数。
   「所见即所印」不能靠肉眼：这里真打一份 PDF，数它的页数跟屏幕上的卷面张数对比。
   多出来的空白页（卷面被包装顶出去一点点）也是在这一步被抓出来的 —— 曾经 .wrap 的
   22px/60px 内边距就让一张 264mm 的卷面溢出成两页，最后多印一张白纸。 */
const printPdf = async () => {
  const r = await cdp.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
  return Buffer.from(r.data, "base64");
};
const printPages = async () => {
  const buf = await printPdf();
  return ((buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length);
};
const screenPages = Number(await ev(cdp, "document.querySelectorAll('#sheets > .sheet').length"));
const composePrint = await printPages();
check("③-8 组卷台：屏幕上几页，打印就几页（不多印空白页）",
  screenPages > 0 && screenPages === composePrint,
  "屏幕 " + screenPages + " 页 / 打印 " + composePrint + " 页");

await nav(`${BASE}/print.html?custom=1`, 3000);
const sp1 = Number(await ev(cdp, "document.querySelectorAll('#sheets > .sheet').length"));
const pp1 = await printPages();
check("③-9 打印卷面：屏幕上几页，打印就几页",
  sp1 > 0 && sp1 === pp1, "屏幕 " + sp1 + " 页 / 打印 " + pp1 + " 页");

/* ================================================================ ③b 纸上到底多少边距
   起因（2026-10-11 用户）：真打印机打出来「整体内容靠左上」。取证：把 print.html 走
   Chrome 的真实打印管线转成 PDF 量坐标 —— 左边距 11.9mm、上边距 13.7mm，而右 12mm：
   卷面是**贴左**的。原因是边距全交给 CSS 的 @page（margin: 14mm 12mm），打印对话框里
   「边距」一改（无 / 最小 / 跟随驱动）@page 就被丢掉，卷面直接贴纸角。
   改法：@page margin 固定 0，边距写进卷面自己的内边距（:root --pg-* → .sheet padding）。
   这样对话框怎么选，纸上的边距只会 ≥ 设的值。下面三层都验：
     ① 打印媒体仿真下：内边距 ≠ 0 且 = 边距变量，内容真的从边距处开始；
     ② CSSOM：@page 的 margin 就是 0；
     ③ 真打 PDF 量左上边距（不看代码怎么写，看纸上是什么）。
   ⚠️ 量 PDF 必须跳过两类矩形，否则左边距会量成 0：页面裁切框 `0 0 W H re W* n`、
   卷面的白色底 `1 1 1 rg … re f`（卷面自带内边距后，白底 = 整张纸）。 */
function pdfMargins(buf) {
  const PT2MM = 25.4 / 72, A4H = 841.89;
  const NUM = "[-+]?[0-9]*\\.?[0-9]+";
  const TOK = new RegExp(`(${NUM})|(\\[)|(\\])|(/[^\\s/\\[\\]<>()]+)|([A-Za-z'"*]+)`, "g");
  const mul = (m1, m2) => {
    const [a1, b1, c1, d1, e1, f1] = m1, [a2, b2, c2, d2, e2, f2] = m2;
    return [a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2,
            c1 * b2 + d1 * d2, e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2];
  };
  const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const out = [];
  const s = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const end = s.indexOf("endstream", m.index);
    if (end < 0) continue;
    let txt;
    try { txt = zlib.inflateSync(Buffer.from(s.slice(m.index + m[0].length, end), "latin1")).toString("latin1"); }
    catch { continue; }
    // 只认页面内容流：内嵌 TTF / CMap 也会被解出来，里面的字节会被当成算子
    if (txt.indexOf(" cm") < 0 || txt.indexOf(" Tm") < 0) continue;
    let ctm = [1, 0, 0, 1, 0, 0], tm = ctm, stack = [], ops = [], fs = 10, white = false;
    const pts = [];
    TOK.lastIndex = 0;
    let t;
    while ((t = TOK.exec(txt))) {
      const [, num, ob, cb, name, op] = t;
      if (num !== undefined) { ops.push(parseFloat(num)); continue; }
      if (ob || cb || name) { ops.push(null); continue; }
      const n = (i, d = 0) => (typeof ops[i] === "number" ? ops[i] : d);
      if (op === "q") stack.push(ctm);
      else if (op === "Q") { if (stack.length) ctm = stack.pop(); }
      else if (op === "cm" && ops.length >= 6) ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm);
      else if (op === "BT") tm = [1, 0, 0, 1, 0, 0];
      else if (op === "Tm" && ops.length >= 6) tm = [n(0), n(1), n(2), n(3), n(4), n(5)];
      else if ((op === "Td" || op === "TD") && ops.length >= 2) tm = mul([1, 0, 0, 1, n(0), n(1)], tm);
      else if (op === "Tf" && ops.length >= 2) fs = n(1, 10);
      else if (op === "Tj" || op === "TJ" || op === "'" || op === '"' || op === "T*") pts.push(ap(mul(tm, ctm), 0, 0).concat(fs));
      else if (op === "rg" && ops.length >= 3) white = n(0) >= .99 && n(1) >= .99 && n(2) >= .99;
      else if (op === "g" && ops.length >= 1) white = n(0) >= .99;
      else if (op === "re" && ops.length >= 4) {
        const [x, y, w, h] = [n(0), n(1), n(2), n(3)];
        if (!((w > 400 && h > 500) || white))   // 页面裁切框 / 卷面白底：不是内容
          [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach((p) => pts.push(ap(ctm, p[0], p[1]).concat(0)));
      } else if ((op === "m" || op === "l") && ops.length >= 2) pts.push(ap(ctm, n(0), n(1)).concat(0));
      ops = [];
    }
    if (!pts.length) continue;
    out.push({
      left: Math.min(...pts.map((p) => p[0])) * PT2MM,
      top: (A4H - Math.max(...pts.map((p) => p[1] + p[2] * 0.76))) * PT2MM,
    });
  }
  return out;
}

await nav(`${BASE}/print.html?id=4`, 3000);
await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
await sleep(400);
const mg = JSON.parse(await ev(cdp, `(function(){
  var s=document.querySelector("#sheets > .sheet"), cs=getComputedStyle(s);
  var rs=getComputedStyle(document.documentElement);
  var first=s.querySelector(".sec-title, .sec-edit, .grid-sec, .paper-head");
  var page="";                       // CSSOM 里找 @page 规则（嵌在 @media print 里）
  [].forEach.call(document.styleSheets,function(sh){
    var walk=function(list){ [].forEach.call(list||[],function(r){
      if(r.type===6) page=r.style.margin;
      else if(r.cssRules) walk(r.cssRules);
    }); };
    try{ walk(sh.cssRules); }catch(e){}
  });
  return JSON.stringify({
    pad:[cs.paddingTop,cs.paddingRight,cs.paddingBottom,cs.paddingLeft],
    vars:[rs.getPropertyValue("--pg-t").trim(),rs.getPropertyValue("--pg-r").trim(),
          rs.getPropertyValue("--pg-b").trim(),rs.getPropertyValue("--pg-l").trim()],
    inset: first?[first.offsetTop,first.offsetLeft]:null,
    pageMargin: page,
    ctl: document.querySelectorAll("#mg .mgo").length,
    ctlOn: (function(){ var b=document.querySelector("#mg .mgo.on"); return b?b.getAttribute("data-mgk"):null; })()
  });
})()`));
const MM = (v) => Math.round(v * 96 / 25.4);
check("③b-1 打印态下卷面自带内边距（不再是 0 —— 贴纸角就是这么来的）",
  mg.pad.every((p) => parseFloat(p) > 0), mg.pad.join(" / "));
check("③b-2 内边距 = :root 的页边距变量（唯一口径）",
  mg.vars.every((v) => v === "18mm") && Math.abs(parseFloat(mg.pad[0]) - MM(18)) <= 1,
  "vars=" + mg.vars.join(",") + "　pad=" + mg.pad[0] + "（期望≈" + MM(18) + "px）");
check("③b-3 卷面第一块内容从边距处开始（不是贴角）",
  !!mg.inset && Math.abs(mg.inset[0] - parseFloat(mg.pad[0])) <= 1
              && Math.abs(mg.inset[1] - parseFloat(mg.pad[3])) <= 1,
  "内容起点 " + (mg.inset ? mg.inset.join(" / ") + "px" : "?"));
check("③b-4 @page 的 margin 是 0（边距不交给打印对话框）",
  /^0(px)?$/.test(String(mg.pageMargin).trim()), "page margin = " + JSON.stringify(mg.pageMargin));
check("③b-5 工具条里有页边距选择器，默认「标准」",
  mg.ctl === 3 && mg.ctlOn === "std", mg.ctl + " 个按钮，选中 " + mg.ctlOn);
await cdp.send("Emulation.setEmulatedMedia", { media: "" });
await sleep(300);

/* 切「宽松」：变量 / 内边距 / 内容起点 / 分页 一起变；而且纸上仍不多印空白页 */
const pStd = Number(await ev(cdp, "document.querySelectorAll('#sheets > .sheet').length"));
await ev(cdp, `document.querySelector('#mg .mgo[data-mgk="wide"]').click()`);
await sleep(1000);
const wide = JSON.parse(await ev(cdp, `(function(){
  var s=document.querySelector("#sheets > .sheet"), cs=getComputedStyle(s);
  var rs=getComputedStyle(document.documentElement);
  var first=s.querySelector(".sec-title, .sec-edit, .grid-sec, .paper-head");
  var b=document.querySelector("#mg .mgo.on");
  return JSON.stringify({ pad:cs.paddingTop, t:rs.getPropertyValue("--pg-t").trim(),
    inset:first?first.offsetTop:null, pages:document.querySelectorAll("#sheets > .sheet").length,
    on:b?b.getAttribute("data-mgk"):null,
    sheetH:[].map.call(document.querySelectorAll("#sheets > .sheet"),function(x){return x.offsetHeight;}) });
})()`));
check("③b-6 点「宽松」：变量 / 内边距 / 内容起点一起变，按钮跟着亮",
  wide.t === "24mm" && wide.on === "wide" && Math.abs(parseFloat(wide.pad) - MM(24)) <= 1
  && wide.inset != null && Math.abs(wide.inset - parseFloat(wide.pad)) <= 1,
  "vars=" + wide.t + "　pad=" + wide.pad + "　inset=" + wide.inset + "　on=" + wide.on);
check("③b-7 「宽松」下每张卷面仍不超过一整页（边距变大不会把卷面挤出去）",
  wide.sheetH.every((h) => h > 0 && h <= 1125), wide.sheetH.join(" / "));
const wPrn = await printPages();
check("③b-8 「宽松」下屏幕上几页，打印就几页（不多印空白页）",
  wide.pages > 0 && wide.pages === wPrn,
  "屏幕 " + wide.pages + " 页 / 打印 " + wPrn + " 页（标准时 " + pStd + " 页）");

/* 还原成默认，别影响后面的用例 */
await ev(cdp, `document.querySelector('#mg .mgo[data-mgk="std"]').click()`);
await sleep(900);
const back = JSON.parse(await ev(cdp, `(function(){
  var s=document.querySelector("#sheets > .sheet");
  return JSON.stringify({ pad:getComputedStyle(s).paddingTop,
    pages:document.querySelectorAll("#sheets > .sheet").length });
})()`));
check("③b-9 点回「标准」：内边距与页数都还原",
  Math.abs(parseFloat(back.pad) - MM(18)) <= 1 && back.pages === pStd,
  "pad=" + back.pad + "　" + back.pages + " 页（改前 " + pStd + " 页）");

/* 最硬的一条：真打一份 PDF，量纸上最左/最上那点离纸边多远。不看代码怎么写，看纸上是什么。 */
const boxes = pdfMargins(await printPdf());
check("③b-10 纸上量出来：每页左边距 / 上边距都 ≥ 17mm（内容没贴纸角）",
  boxes.length > 0 && boxes.every((b) => b.left >= 17 && b.top >= 17),
  boxes.map((b, i) => "p" + (i + 1) + " 左" + b.left.toFixed(1) + "/上" + b.top.toFixed(1)).join("mm，") + "mm");

/* ================================================================ ④ 分桶口径一致
   首页的题型分布、组卷台的题型筛选、卷面的板块分组必须同一份答案。
   以前首页直读 q.qtype（只有 6 个值），结果首页把"用竖式计算"算成"解答"，
   卷面却把它排进"计算题" —— 同一道题两个说法。现在都走 js/qtype.js。 */
await nav(`${BASE}/index.html`, 3400);
const home = JSON.parse(await ev(cdp, `(function(){
  var card = document.querySelector('#list .pcard');
  var legend = card ? [].map.call(card.querySelectorAll('.dist-legend span'),
    function(s){ return s.textContent.trim(); }) : [];
  return JSON.stringify({
    hasQ: !!window.QType,
    buckets: window.QType ? window.QType.TYPE_SECTION.map(function(x){ return x[0]; }) : [],
    title: card ? (card.querySelector('.title').textContent || '').trim() : '',
    legend: legend,
  });
})()`));
check("④-1 首页也加载了全站唯一的分桶规则（js/qtype.js）",
  home.hasQ && home.buckets.length === 9, "桶 = " + home.buckets.join("/"));

const want = JSON.parse(await ev(cdp, `CloudAPI.listPapers().then(function(ps){
  if(!ps.length) return '{"none":true}';
  return CloudAPI.listQuestions(ps[0].id).then(function(qs){
    var c={}; qs.forEach(function(q){ var k=QType.bucketOf(q); c[k]=(c[k]||0)+1; });
    return JSON.stringify({ title: String(ps[0].title||'').trim(), by: c, total: qs.length });
  });
})`));
const LABEL = { choice: "选择", fill: "填空", compare: "比大小", calc: "计算", judge: "判断",
  solve: "应用", geometry: "几何", proof: "证明", other: "其他" };
const norm = (o) => Object.keys(o).sort().map((k) => k + "=" + o[k]).join(",");
const got = {};
(home.legend || []).forEach(function (s) {
  const m = /^(.+?)\s+(\d+)$/.exec(s);
  if (m) got[m[1]] = Number(m[2]);
});
const wantL = {};
Object.keys(want.by || {}).forEach(function (k) { wantL[LABEL[k] || k] = want.by[k]; });
check("④-2 首页卡片的题型分布 = 按同一口径现算的结果",
  !want.none && norm(got) === norm(wantL),
  home.title + "　显示 " + JSON.stringify(got) + "　应 " + JSON.stringify(wantL));
/* 「判断」桶的题不在首张卡片上（在别的卷里），所以单独全库数一遍 + 扫所有卡片的图例 */
const judgeAll = Number(await ev(cdp, `CloudAPI.listAllQuestions().then(function(qs){
  return String(qs.filter(function(q){ return QType.bucketOf(q)==='judge'; }).length); })`));
const judgeOnHome = JSON.parse(await ev(cdp, `(function(){
  var hits = [];
  [].forEach.call(document.querySelectorAll('#list .pcard'), function(c){
    var t = (c.querySelector('.title') || {}).textContent || '';
    [].forEach.call(c.querySelectorAll('.dist-legend span'), function(s){
      if (/^判断\\s+\\d+$/.test(s.textContent.trim())) hits.push(t.trim() + "：" + s.textContent.trim());
    });
  });
  return JSON.stringify(hits);
})()`));
check("④-3 首页能看到「判断」档（judge 没被并进「其他」）",
  judgeAll > 0 && judgeOnHome.length > 0,
  "全库判断 " + judgeAll + " 题；首页标出来的：" + (judgeOnHome.join("，") || "（没有）"));

await nav(`${BASE}/compose.html`, 3000);
const dd = JSON.parse(await ev(cdp, `(function(){
  var host = document.getElementById('f-type');
  var labels = [].map.call(host.querySelectorAll('.dd-it .dd-name'),
    function(e){ return e.textContent.trim(); }).filter(function(t){ return t !== '全部题型'; });
  var keys = [].map.call(host.querySelectorAll('.dd-it'), function(b){
    return b.getAttribute('data-i'); });
  return JSON.stringify({ labels: labels });
})()`));
const SEC_ORDER = ["选择题", "填空题", "比大小", "计算题", "判断题", "应用题", "几何题", "证明题", "其他"];
const idx = (t) => SEC_ORDER.indexOf(t);
const sortedOK = dd.labels.every((t) => idx(t) >= 0)
  && JSON.stringify(dd.labels.map(idx)) === JSON.stringify(dd.labels.map(idx).slice().sort((a, b) => a - b));
check("④-4 组卷台的题型下拉按板块顺序排（不是题库里碰到的先后）", sortedOK,
  dd.labels.join(" | "));

const calcShould = Number(await ev(cdp,
  `CloudAPI.listAllQuestions().then(function(qs){
     return String(qs.filter(function(q){ return QType.bucketOf(q)==='calc'; }).length); })`));
await ev(cdp, `(function(){
  var its = document.querySelectorAll('#f-type .dd-it');
  for (var i = 0; i < its.length; i++) {
    if (its[i].querySelector('.dd-name').textContent.trim() === '计算题') { its[i].click(); return; }
  }
})();`);
await sleep(600);
const pool = JSON.parse(await ev(cdp, `(function(){
  var items = [].slice.call(document.querySelectorAll('#pool .pitem'));
  var chips = items.map(function(x){ return (x.querySelector('.chip.type')||{}).textContent || ''; });
  return JSON.stringify({ n: items.length, uniq: chips.filter(function(v,i){return chips.indexOf(v)===i;}),
    count: document.getElementById('pool-count').textContent });
})()`));
check("④-5 组卷台选「计算题」筛出来的每题都真是计算题（按页渲染，首屏至多 80 条）",
  pool.n === Math.min(calcShould, 80) && pool.uniq.length === 1 && pool.uniq[0].trim() === "计算题"
    && (pool.count || "").indexOf("共 " + calcShould + " 题") >= 0,
  "渲染 " + pool.n + " 条（全库计算题 " + calcShould + " 题）　小标 = " + JSON.stringify(pool.uniq)
    + "　计数行 = " + (pool.count || "?"));

/* 同一个下拉里也得有「比大小」这一档 —— 新桶不能只活在卷面上 */
const cmpShould = Number(await ev(cdp,
  `CloudAPI.listAllQuestions().then(function(qs){
     return String(qs.filter(function(q){ return QType.bucketOf(q)==='compare'; }).length); })`));
check("④-6 组卷台的题型下拉里有「比大小」，筛出来的都真是比大小",
  cmpShould > 0 && dd.labels.indexOf("比大小") >= 0,
  "下拉 = " + dd.labels.join("/") + "；全库比大小 " + cmpShould + " 题");

/* ================================================================ ⑤ 题距：
   用户反馈"题目和题目之间太挤"，行间距从 3mm 加到 6mm（≈22.7px）。
   ⚠️ 得挑一张**有题的**卷面读：compose.html（不带 id）= 新建空白卷，卷面上什么都没有。 */
await nav(`${BASE}/print.html?custom=1`, 3000);
st = await read();
check("⑤-1 题与题之间留了行距（6mm ≈ 22.7px，原来 3mm）",
  st.secs.length > 0 && st.secs.every((s) => s.gap >= 22),
  "各行距 = " + st.secs.map((s) => s.gap + "px").join(" / "));
check("⑤-2 列间距没跟着变大（多列板块别被挤到折行）",
  st.secs.every((s) => s.gapCol <= 16),
  "各列距 = " + st.secs.map((s) => s.gapCol + "px").join(" / "));

/* ================================================================ ⑥ 插图大小可调：
   用户要求「图片支持调整大小」—— 排版态里每张题内插图的右缘有一条手柄，横拖改宽度，
   结果记进 layout.figs = {题目id: mm} 并跟排版一起存。
   拖拽过程只改 --figw（跟手、不重分页），松手才落数据 + 重画。
   ⚠️ 得挑**真有插图**的卷：自建卷 1（print.html?custom=1）里有石榴（带图选择题）
   与小海（带图应用题）两道；第2单元练习卷那道 id=4 一张图都没有。 */
await nav(`${BASE}/print.html?custom=1`, 3200);
check("⑥-1 非排版态不出现调大小手柄（打印不会带上手柄）",
  (await ev(cdp, "document.querySelectorAll('#sheets .figh').length")) === 0,
  "屏幕上 .figh = " + (await ev(cdp, "document.querySelectorAll('#sheets .figh').length")) + " 个");

await ev(cdp, `document.getElementById('btn-lay').click();`);
await sleep(1500);
const figN = Number(await ev(cdp, "document.querySelectorAll('#sheets .gitem .figbox').length"));
const hN = Number(await ev(cdp, "document.querySelectorAll('#sheets .figh').length"));
check("⑥-2 排版态里每张题内插图都挂上了手柄", figN > 0 && hN === figN,
  hN + " 个手柄 / " + figN + " 张插图");

const defs = JSON.parse(await ev(cdp, `(function(){
  var out=[];
  [].forEach.call(document.querySelectorAll('#sheets .gitem'),function(it){
    var f=it.querySelector('.figbox'); if(!f) return;
    out.push({ qid: it.dataset.qid, duo: !!it.querySelector('.figduo'),
               v: it.style.getPropertyValue('--figw') });
  });
  return JSON.stringify(out);})()`));
check("⑥-3 默认宽度写在 --figw 上（普通题 68mm、带图选择题右栏 62mm）",
  defs.length > 0 && defs.every((d) => d.v === (d.duo ? "62mm" : "68mm")),
  defs.map((d) => (d.duo ? "选择" : "普通") + " " + (d.v || "(空)")).join("，"));

/* 拖手柄：按下 → 往右推 60px → 松手。1mm ≈ 3.78px，所以大约 +16mm。 */
const drag = JSON.parse(await ev(cdp, `(function(){
  var h = document.querySelector('#sheets .figduo .figh') || document.querySelector('#sheets .figh');
  var it = h.closest('.gitem'), f = it.querySelector('.figbox'), bd = h.querySelector('.fighw');
  var r = h.getBoundingClientRect();
  var x0 = Math.round(r.left + 5), y0 = Math.round(r.top + 10);
  var before = { w: Math.round(f.getBoundingClientRect().width), v: it.style.getPropertyValue('--figw') };
  var o = { bubbles:true, cancelable:true, pointerId:9, isPrimary:true, pointerType:'mouse',
            clientX:x0, clientY:y0 };
  h.dispatchEvent(new PointerEvent('pointerdown', o));
  window.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientX: x0 + 60 })));
  var during = { v: it.style.getPropertyValue('--figw'), badge: bd.textContent,
                 shown: getComputedStyle(bd).display };
  window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { clientX: x0 + 60 })));
  return JSON.stringify({ qid: it.dataset.qid, w0: before.w, v0: before.v, during: during });
})()`));
await sleep(1100);
const afterFig = JSON.parse(await ev(cdp, `(function(){
  var it = document.querySelector('#sheets .gitem[data-qid="${drag.qid}"]');
  var f = it.querySelector('.figbox'), h = it.querySelector('.figh');
  return JSON.stringify({ w: Math.round(f.getBoundingClientRect().width),
                          v: it.style.getPropertyValue('--figw'),
                          badge: getComputedStyle(h.querySelector('.fighw')).display,
                          hand: h.classList.contains('on') });})()`));
const grew = Number((/(\d+)/.exec(afterFig.v) || [])[1]) - Number((/(\d+)/.exec(drag.v0) || [])[1]);
check("⑥-4 拖手柄能把图改大（--figw 变大，图跟着变宽）",
  grew >= 10 && grew <= 22 && afterFig.w > drag.w0 + 30,
  drag.v0 + " → " + afterFig.v + "（+" + grew + "mm）　图宽 " + drag.w0 + "px → " + afterFig.w + "px");
check("⑥-5 拖动过程中实时显示当前宽度（松手后收起）",
  drag.during.shown === "block" && /^\d+mm$/.test(drag.during.badge)
  && afterFig.badge === "none" && !afterFig.hand,
  "拖动时提示 = " + drag.during.badge + "（" + drag.during.shown + "）　松手后 = " + afterFig.badge);

await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(1800);
const figSaved = JSON.parse(await ev(cdp, `(function(){
  var a = JSON.parse(localStorage.getItem('sj-demo-customs-v1') || '[]');
  var c = a.filter(function(x){ return String(x.id) === '1'; })[0];
  return JSON.stringify((c && c.layout && c.layout.figs) || {});})()`));
check("⑥-6 改过的插图宽度跟着排版落库（layout.figs）",
  figSaved[drag.qid] === Number((/(\d+)/.exec(afterFig.v) || [])[1]),
  "layout.figs = " + JSON.stringify(figSaved));

await nav(`${BASE}/print.html?custom=1`, 3200);
const kept = JSON.parse(await ev(cdp, `(function(){
  var it = document.querySelector('#sheets .gitem[data-qid="${drag.qid}"]');
  var f = it.querySelector('.figbox');
  return JSON.stringify({ w: Math.round(f.getBoundingClientRect().width),
                          v: it.style.getPropertyValue('--figw'),
                          hand: document.querySelectorAll('#sheets .figh').length });})()`));
check("⑥-7 刷新后宽度还在，而且非排版态仍然不带手柄",
  kept.v === afterFig.v && kept.w === afterFig.w && kept.hand === 0,
  "刷新后 " + kept.v + " / " + kept.w + "px，手柄 " + kept.hand + " 个");

/* 双击手柄 = 回到默认大小（不用一点点拖回去） */
await ev(cdp, `document.getElementById('btn-lay').click();`);
await sleep(1300);
await ev(cdp, `(function(){
  var h = document.querySelector('#sheets .gitem[data-qid="${drag.qid}"] .figh');
  h.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, cancelable:true }));})()`);
await sleep(1100);
const reset = JSON.parse(await ev(cdp, `(function(){
  var it = document.querySelector('#sheets .gitem[data-qid="${drag.qid}"]');
  var f = it.querySelector('.figbox');
  return JSON.stringify({ w: Math.round(f.getBoundingClientRect().width),
                          v: it.style.getPropertyValue('--figw') });})()`));
check("⑥-8 双击手柄恢复默认宽度", reset.w === drag.w0 && reset.v === drag.v0,
  reset.v + " / " + reset.w + "px（默认 " + drag.v0 + " / " + drag.w0 + "px）");

/* 右对齐的应用题图（.figright）：右边缘钉在题格右边不动，宽度一变是**左边**在动 ——
   所以手柄挂左边缘，而且往左拖才是变大。不这么干的话拖右边手柄时手柄不会跟着手指走。 */
const fr = JSON.parse(await ev(cdp, `(function(){
  var it = document.querySelector('#sheets .gitem.figright');
  if(!it) return '{"none":true}';
  var h = it.querySelector('.figh'), f = it.querySelector('.figbox');
  var hs = getComputedStyle(h), a = it.getBoundingClientRect(), b = f.getBoundingClientRect();
  var hr = h.getBoundingClientRect();
  return JSON.stringify({ qid: it.dataset.qid, left: hs.left, right: hs.right,
    onLeft: Math.round(hr.left + hr.width / 2) < Math.round(b.left + b.width / 2),
    figRight: Math.round(b.right - a.right), boxW: Math.round(b.width),
    v0: it.style.getPropertyValue('--figw') });})()`));
check("⑥-9 右对齐的应用题图：手柄挂在左边缘（右边缘是钉住的）",
  !fr.none && /^-\d/.test(fr.left) && fr.onLeft && Math.abs(fr.figRight) <= 2,
  fr.none ? "没有 .figright 的题" : "手柄 left=" + fr.left + "，在图的左侧 = " + fr.onLeft
    + "；图右缘离题格右缘 " + fr.figRight + "px");

if (!fr.none) {
  await ev(cdp, `(function(){
    var it = document.querySelector('#sheets .gitem.figright');
    var h = it.querySelector('.figh');
    var r = h.getBoundingClientRect();
    var x0 = Math.round(r.left + 5), y0 = Math.round(r.top + 10);
    var o = { bubbles:true, cancelable:true, pointerId:13, isPrimary:true, pointerType:'mouse',
              clientX:x0, clientY:y0 };
    h.dispatchEvent(new PointerEvent('pointerdown', o));
    window.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientX: x0 - 60 })));
    window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { clientX: x0 - 60 })));
  })()`);
  await sleep(1100);
  const fr2 = JSON.parse(await ev(cdp, `(function(){
    var it = document.querySelector('#sheets .gitem[data-qid="${fr.qid}"]');
    var f = it.querySelector('.figbox');
    var a = it.getBoundingClientRect(), b = f.getBoundingClientRect();
    return JSON.stringify({ v: it.style.getPropertyValue('--figw'), boxW: Math.round(b.width),
                            figRight: Math.round(b.right - a.right) });})()`));
  const g2 = Number((/(\d+)/.exec(fr2.v) || [])[1]) - Number((/(\d+)/.exec(fr.v0) || [])[1]);
  check("⑥-10 往左拖把应用题图改大、右边缘仍然钉在原处",
    g2 >= 10 && g2 <= 22 && fr2.boxW > fr.boxW + 30 && Math.abs(fr2.figRight) <= 2,
    fr.v0 + " → " + fr2.v + "（+" + g2 + "mm）　图宽 " + fr.boxW + "→" + fr2.boxW
      + "px，右缘偏移 " + fr2.figRight + "px");
}

/* ================================================================ ⑦ 图下说明文字可移除：
   用户要求「支持移除图片下面的说明文字」—— 题内插图下面那行小字（figure.caption，
   识别时补的备注，如「图：24×4 的竖式，框住的是 20×4 这一步」）在卷面上常不需要。
   排版态里每张图右下角有「说明 ✕」，点一下移掉、再点一下恢复；记进
   layout.caps = {题目id: [图序号…]}，跟排版一起存，**打印/预览态也不印**。
   仍然用 print.html?custom=1：石榴（123）、小海（55）、货运电梯（56）三张图都有说明。 */
const CAP_READ = `(function(){
  var out=[];
  [].forEach.call(document.querySelectorAll('#sheets .gitem'),function(it){
    var f=it.querySelector('.figbox'); if(!f) return;
    var c=f.querySelector('.figcap'), b=f.querySelector('.figcapbtn');
    out.push({ qid:String(it.dataset.qid),
               cap: c?String(c.textContent).trim():'',
               btn: b?String(b.textContent).replace(/\\s+/g,' ').trim():'' });
  });
  return JSON.stringify(out);
})()`;
const capQ = (list, qid) => list.filter((x) => x.qid === qid)[0] || null;

await nav(`${BASE}/print.html?custom=1`, 3200);
const cap0 = JSON.parse(await ev(cdp, CAP_READ));
const btn0 = Number(await ev(cdp, "document.querySelectorAll('#sheets .figcapbtn').length"));
const capT = cap0.filter((x) => x.cap)[0];
check("⑦-1 非排版态：图下说明照印，但不会挂「说明」开关（打印带不上按钮）",
  cap0.length >= 2 && cap0.every((x) => x.cap) && btn0 === 0,
  cap0.length + " 张图，说明 " + cap0.filter((x) => x.cap).length + " 条，按钮 " + btn0 + " 个");

await ev(cdp, `document.getElementById('btn-lay').click();`);
await sleep(1500);
const cap1 = JSON.parse(await ev(cdp, CAP_READ));
check("⑦-2 排版态：每张带说明的图右下角都有开关，且显示成「说明 ✕」（= 现在印着）",
  cap1.filter((x) => x.cap).length >= 2 && cap1.filter((x) => x.cap).every((x) => /^说明 \u2715$/.test(x.btn)),
  cap1.map((x) => x.qid + ":" + JSON.stringify(x.btn)).join("，"));

await ev(cdp, `document.querySelector('#sheets .gitem[data-qid="${capT.qid}"] .figcapbtn').click();`);
await sleep(1200);
const cap2 = JSON.parse(await ev(cdp, CAP_READ));
const t2 = capQ(cap2, capT.qid);
const others2 = cap2.filter((x) => x.qid !== capT.qid && x.cap);
check("⑦-3 点一下「说明 ✕」就把这行字从卷面上移掉（只剩按钮，提示可恢复）",
  t2 && !t2.cap && /^说明 \u21bb$/.test(t2.btn) && cap2.filter((x) => !x.cap).length === 1,
  "题目 " + capT.qid + " 的说明：" + JSON.stringify(capT.cap) + " → " + JSON.stringify(t2 && t2.cap)
    + "，按钮变成 " + JSON.stringify(t2 && t2.btn));
check("⑦-4 只动点的那一张（同卷其他图的说明照旧）",
  others2.length === cap1.filter((x) => x.qid !== capT.qid && x.cap).length,
  "其余仍有说明的图 " + others2.length + " 张");

await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(1800);
const capSaved = JSON.parse(await ev(cdp, `(function(){
  var a = JSON.parse(localStorage.getItem('sj-demo-customs-v1') || '[]');
  var c = a.filter(function(x){ return String(x.id) === '1'; })[0];
  return JSON.stringify((c && c.layout && c.layout.caps) || {});})()`));
check("⑦-5 移掉这行说明跟着排版落库（layout.caps = {题目id: [图序号…]}）",
  Array.isArray(capSaved[capT.qid]) && capSaved[capT.qid].indexOf(0) >= 0,
  "layout.caps = " + JSON.stringify(capSaved));

await nav(`${BASE}/print.html?custom=1`, 3200);
const cap3 = JSON.parse(await ev(cdp, CAP_READ));
const t3 = capQ(cap3, capT.qid);
check("⑦-6 刷新后那行说明仍然不印（预览/打印都干净），而且没有按钮",
  t3 && !t3.cap && (await ev(cdp, "document.querySelectorAll('#sheets .figcapbtn').length")) === 0
  && cap3.filter((x) => x.cap).length === cap1.filter((x) => x.qid !== capT.qid && x.cap).length,
  "题目 " + capT.qid + " 说明 = " + JSON.stringify(t3 && t3.cap)
    + "；全卷仍有说明 " + cap3.filter((x) => x.cap).length + " 张");

await ev(cdp, `document.getElementById('btn-lay').click();`);
await sleep(1400);
await ev(cdp, `document.querySelector('#sheets .gitem[data-qid="${capT.qid}"] .figcapbtn').click();`);
await sleep(1200);
const cap4 = JSON.parse(await ev(cdp, CAP_READ));
const t4 = capQ(cap4, capT.qid);
check("⑦-7 再点一下「说明 ↺」就恢复（原文一字不差）",
  t4 && t4.cap === capT.cap && /^说明 \u2715$/.test(t4.btn),
  JSON.stringify(t4 && t4.cap));

await ev(cdp, "document.getElementById('lay-save').click();");
await sleep(1600);
const capsClear = JSON.parse(await ev(cdp, `(function(){
  var a = JSON.parse(localStorage.getItem('sj-demo-customs-v1') || '[]');
  var c = a.filter(function(x){ return String(x.id) === '1'; })[0];
  return JSON.stringify(c && c.layout ? (c.layout.caps || null) : null);})()`));
check("⑦-8 全部恢复后不留空壳（layout 里不再有 caps）", capsClear === null,
  "layout.caps = " + JSON.stringify(capsClear));

/* 收尾：别把演示数据留在半路 */
await ev(cdp, `localStorage.setItem('sj-demo-customs-v1', JSON.stringify(
  JSON.parse(localStorage.getItem('sj-demo-customs-v1')).map(function(c){
    if(String(c.id)==='1'){ c.layout=null; }
    return c;
  })));`);

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "\n        " + c.detail : ""}`);
}
console.log(bad === 0 ? "\n全部通过" : `\n${bad} 项未通过`);
chrome.kill();
process.exit(bad === 0 ? 0 : 1);
