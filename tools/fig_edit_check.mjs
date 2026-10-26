/* 题内插图「切图 + 显示大小 / 显示位置」自检（2026-10-11 用户要求）：
 *   「有些，你没有切图片，所以编辑的时候，是需要支持切图片的
 *     同时，需要支持调整图片显示大小，调整图片显示位置」
 *
 *   ① 入口   —— 图列表里**永远**有「＋ 从原图切一张图」（识别漏图时唯一的补图入口）；
 *               没有图的题也不再有"空板块"（以前干脆不出这一块，用户就没法补图）
 *   ② 切图   —— 弹层标题 / 按钮换成「从原图切一张图 / 加进题目」；在整页原图上拖一下
 *               就能画出框（真鼠标事件，不是调函数）；保存后 stem 多一个 figure 片段、
 *               文本框里多一个 ［图：说明］ 占位行
 *   ③ 位置   —— 新切的那块插在**光标处**（不是一律补末尾）：文本里的第 k 个占位符对应
 *               efigs 第 k 项，两边必须一起插在 k 位置，否则「保存修改」时占位符会把别的图
 *               换到自己位置上
 *   ④ 大小   —— 滑杆 30~100%，拖的时候只改缩略图不重画整行（不丢焦点）；「默认」回到满
 *   ⑤ 位置   —— 左 / 居中 / 右 + 文字环绕（居中不环绕）；再点一下 = 跟随题型默认
 *   ⑥ 渲染   —— 大小落成 --fdw（zoom 等比缩）、位置落成外层 .figwrap 的 text-align。
 *               真量像素：50% 的图宽约为 100% 的一半；右对齐图右边缘贴栏右、居中两边等距、
 *               左对齐贴栏左；环绕时图自己 float
 *   ⑦ 落库   —— 保存修改后重新打开，dw / pos / wrap 原样都在（演示覆盖层）
 *   ⑧ 卷面   —— 卷面默认宽 = 题型默认 × dw（排版态拖过的绝对毫米优先）；手工定过位置的图
 *               不再被"应用题靠右 / 带图选择题贴选项右侧"抢走
 *   ⑨ 多图   —— 一张卷多张原图时弹层顶上有选图条；seg.img 记住"这张图是从哪张原图上切的"
 *               （不记的话，从别的照片上切的图会拿题干那页去抠，抠出来是错的）
 *   ⑩ 不回潮 —— 「调整」弹层（大小/旋转/拉伸、四点透视）不回来（2026-10-07 按用户要求删的）
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻，演示模式免登录）
 * 用法：node tools/fig_edit_check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const CDP_PORT = 9361;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const QEDITS = "sj-demo-qedits-v1";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "fig-edit-"))}`, "about:blank",
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
const json = async (cdp, expr) => JSON.parse(await ev(cdp, expr));

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
  { width: 1340, height: 1500, deviceScaleFactor: 1, mobile: false });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) });
const nav = async (url, ms = 2600) => { await cdp.send("Page.navigate", { url }); await sleep(ms); };

/* 鼠标拖拽（真事件）：合成 pointerdown/move/up，页面里那些手势处理器才会跑 */
async function drag(x1, y1, x2, y2, steps = 6) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", button: "left", buttons: 1,
      x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps,
    });
    await sleep(30);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);
}

/* 题目页题干里第一张图的渲染几何（rect 口径：zoom 之后 clientWidth 还是没缩放的值，量不准） */
const GEO = `(function(){
  var st = document.getElementById('stem'), fb = document.querySelector('#stem .figbox');
  if (!st || !fb) return JSON.stringify(null);
  var r = fb.getBoundingClientRect(), sr = st.getBoundingClientRect();
  var cs = getComputedStyle(fb), wp = fb.closest('.figwrap');
  return JSON.stringify({
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
    left: Math.round(r.left - sr.left), right: Math.round(sr.right - r.right),
    cls: fb.className, zoom: cs.zoom, float: cs.float,
    wrap: wp ? wp.className : "", nWrap: document.querySelectorAll('#stem .figwrap').length });
})()`;

/* 图列表一行的读数（缩略图尺寸同样是 rect 口径） */
const ROW = `(function(){
  var row = document.querySelector('#e-figs .figrow');
  if (!row) return JSON.stringify(null);
  var th = row.querySelector('.fthumb .figbox'), r = th ? th.getBoundingClientRect() : null;
  var rng = row.querySelector('[data-fdw]'), rd = row.querySelector('[data-fdwv]');
  return JSON.stringify({
    thumbW: r ? Math.round(r.width) : 0, thumbH: r ? Math.round(r.height) : 0,
    img: !!row.querySelector('.fthumb .cropbox img'),
    dw: rng ? rng.value : null, rd: rd ? rd.textContent : null,
    posOn: (row.querySelector('[data-fpos].on') || {}).dataset ? row.querySelector('[data-fpos].on').dataset.fpos : "",
    nPos: row.querySelectorAll('[data-fpos]').length,
    wrap: !!row.querySelector('[data-fwrap]'), wrapOn: (row.querySelector('[data-fwrap]') || {}).checked,
    wrapDis: (row.querySelector('[data-fwrap]') || {}).disabled,
    rep: !!row.querySelector('[data-frep]'), del: !!row.querySelector('[data-fdel]'),
    adj: !!row.querySelector('[data-fadj]') });
})()`;

/* 找四类目标题：带图应用题 / 带图选择题 / 没图但原卷多张照片的题 */
await nav(`${BASE}/index.html`);
const T = await json(cdp, `(async function(){
  var qs = await CloudAPI.listAllQuestions(), out = {};
  for (var i = 0; i < qs.length; i++) {
    var q = qs[i], bucket = window.QType ? QType.bucketOf(q) : "";
    var figs = (q.stem || []).filter(function (s) { return s.t === "figure"; });
    var f = figs.filter(function (s) { return s.bbox; })[0];
    if (!out.figSolve && f && bucket === "solve")
      out.figSolve = { id: String(q.id), paper_id: q.paper_id, bbox: f.bbox, n: figs.length };
    if (!out.figChoice && f && bucket === "choice" && (q.options || []).length >= 4)
      out.figChoice = { id: String(q.id), paper_id: q.paper_id, n: figs.length };
    if (!out.noFig && !figs.length && q.source && q.source.bbox
        && bucket !== "calc" && bucket !== "compare") {   // 算式/比大小没有文本框（公式编辑器）
      var fs = await CloudAPI.listFiles(q.paper_id) || [];
      if (fs.length >= 2) out.noFig = { id: String(q.id), paper_id: q.paper_id,
        file: (q.source || {}).file, files: fs.map(function (x) { return x.filename; }) };
    }
    if (out.figSolve && out.figChoice && out.noFig) break;
  }
  return JSON.stringify(out);
})()`);
check("①-0 演示库里找得到三类目标题（带图应用题 / 带图选择题 / 多张原图的没图题）",
  !!(T.figSolve && T.figChoice && T.noFig), JSON.stringify(T));

/* ---------------------------------------------------------------- ① 编辑面板入口 */
await nav(`${BASE}/question.html?id=${T.figSolve.id}`);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(500);
const e1 = await json(cdp, ROW);
const e1b = await json(cdp, `(function(){
  var lb = document.getElementById('e-figl'), add = document.getElementById('e-figadd');
  return JSON.stringify({ rows: document.querySelectorAll('#e-figs .figrow').length,
    empty: !!document.querySelector('#e-figs .figempty'),
    add: !!add, addTxt: add ? add.textContent.trim() : "",
    lab: lb ? lb.textContent : "",
    posTxt: [].map.call(document.querySelectorAll('#e-figs .figrow:first-child [data-fpos]'),
      function (b) { return b.textContent; }).join("/") });
})()`);
check("①-1 带图题：图列表一行一图（缩略图真出图）+ 替换/删除钮，" +
  "显式「调整」钮不回来（2026-10-07 已删，别回潮）",
  e1 && e1b.rows === T.figSolve.n && e1.img && e1.rep && e1.del && !e1.adj && !e1b.empty,
  JSON.stringify({ rows: e1b.rows, n: T.figSolve.n, img: e1.img, adj: e1.adj }));
check("①-2 图列表控件齐：大小滑杆（30~100）+ 位置三钮（左/中/右）+ 文字环绕",
  e1 && e1.nPos === 3 && e1.posOn === "" && e1.wrap && e1.dw === "100" && e1.rd === "100%",
  JSON.stringify({ dw: e1.dw, rd: e1.rd, nPos: e1.nPos, wrap: e1.wrap }));

/* 没图的题：这块以前根本不出现，用户就没有补图入口 */
await nav(`${BASE}/question.html?id=${T.noFig.id}`);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(500);
const e2 = await json(cdp, `(function(){
  var add = document.getElementById('e-figadd'), box = document.getElementById('e-figs');
  return JSON.stringify({ rows: document.querySelectorAll('#e-figs .figrow').length,
    empty: box ? box.textContent.indexOf("还没有图") >= 0 : false,
    add: !!add, lab: (document.getElementById('e-figl') || {}).textContent });
})()`);
check("①-3 没图的题也有图列表 + 「＋ 从原图切一张图」（识别漏图时唯一的补图入口）",
  e2.rows === 0 && e2.empty && e2.add && /图（0）/.test(e2.lab), JSON.stringify(e2));

/* ---------------------------------------------------------------- ③ 切图（在没图的题上做） */
await ev(cdp, "document.getElementById('e-figadd').click()");
await sleep(900);
const c1 = await json(cdp, `(function(){
  var rect = document.getElementById('figm-rect');
  var im = document.getElementById('figm-img');
  var on = document.querySelector('#figm-pages button.on');
  return JSON.stringify({
    open: document.getElementById('figm').style.display !== 'none',
    title: document.getElementById('figm-title').textContent,
    save: document.getElementById('figm-save').textContent,
    restore: document.getElementById('figm-restore').style.display,
    cap: !!document.getElementById('figm-cap'),
    pages: document.querySelectorAll('#figm-pages button').length,
    loaded: im.naturalWidth > 0,
    onFile: on ? on.dataset.file : "",
    box: [window.__figm.state.cx, window.__figm.state.cy, window.__figm.state.w, window.__figm.state.h],
    nw: im.naturalWidth, nh: im.naturalHeight,
    rectW: rect.offsetWidth });
})()`);
const midOk = c1.loaded && Math.abs(c1.box[0] - c1.nw / 2) < 3 && Math.abs(c1.box[1] - c1.nh / 2) < 3;
check("③-1 「＋ 切图」开的是**新建**模式：标题/按钮换成切图口吻、" +
  "恢复识别原状收起、给一个页面正中的默认框、说明输入框在位",
  c1.open && /切一张图/.test(c1.title) && /加进题目/.test(c1.save)
  && c1.restore === "none" && c1.cap && c1.loaded && midOk, JSON.stringify(c1));
check("③-2 多张原图的卷：弹层顶上有选图条（张数 = 原图数，当前那张带 on）",
  c1.pages === T.noFig.files.length && c1.pages >= 2 && c1.onFile === T.noFig.file,
  `pages=${c1.pages} files=${T.noFig.files.length} on=${c1.onFile}`);

/* 在整页原图上真拖一个框：从左上角往外拖（避开正中的默认框） */
const pr = await json(cdp, `(function(){
  var im = document.getElementById('figm-img'), r = im.getBoundingClientRect();
  return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
})()`);
await drag(pr.x + pr.w * 0.06, pr.y + pr.h * 0.08, pr.x + pr.w * 0.30, pr.y + pr.h * 0.30);
const c2 = await json(cdp, `(function(){
  var im = document.getElementById('figm-img'), r = document.getElementById('figm-rect');
  var s = im.clientWidth / im.naturalWidth;
  return JSON.stringify({ rect: [r.offsetLeft / s, r.offsetTop / s,
    (r.offsetLeft + r.offsetWidth) / s, (r.offsetTop + r.offsetHeight) / s],
    want: [im.naturalWidth * 0.06, im.naturalHeight * 0.08,
           im.naturalWidth * 0.30, im.naturalHeight * 0.30] });
})()`);
const dragOk = c2.rect.every((v, i) => Math.abs(v - c2.want[i]) < 6);
check("③-3 在整页原图上拖一下就能画出框（真鼠标事件，落在拖出来的矩形上）",
  dragOk, JSON.stringify(c2));

/* 占位行插在**光标处**：先把光标放题干中间，再切图 */
const caret = await json(cdp, `(function(){
  var ta = document.getElementById('e-stem');
  var at = Math.min(4, ta.value.length);
  ta.focus(); ta.setSelectionRange(at, at);
  ta.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return JSON.stringify({ at: at, txt: ta.value });
})()`);
const phBefore = (caret.txt.slice(0, caret.at).match(/［图：/g) || []).length;
await ev(cdp, `(function(){ document.getElementById('figm-cap').value = '自检切的图'; })()`);
await ev(cdp, "document.getElementById('figm-save').click()");
await sleep(1400);
const c3 = await json(cdp, `(function(){
  return CloudAPI.getQuestion(${JSON.stringify(T.noFig.id)}).then(function (row) {
    var figs = (row.stem || []).map(function (s, i) { return { s: s, i: i }; })
      .filter(function (x) { return x.s.t === "figure"; });
    var ta = document.getElementById('e-stem');
    return JSON.stringify({
      nFigs: figs.length, idx: figs.length ? figs[0].i : -1,
      bbox: figs.length ? figs[0].s.bbox : null,
      cap: figs.length ? figs[0].s.caption : "",
      img: figs.length ? figs[0].s.img : "",
      ta: ta ? ta.value : "",
      phAt: ta ? ta.value.indexOf("［图：自检切的图］") : -1,
      rows: document.querySelectorAll('#e-figs .figrow').length,
      closed: document.getElementById('figm').style.display === 'none' });
  });
})()`);
check("③-4 保存后：stem 多一个 figure 片段（bbox = 画的框、说明落上、记下来源原图）、" +
  "编辑框多一个占位行、图列表 +1、弹层收起",
  c3.nFigs === 1 && c3.bbox && c3.bbox.every((v, i) => Math.abs(v - c2.want[i]) < 6)
  && c3.cap === "自检切的图" && c3.img === c1.onFile
  && c3.phAt >= 0 && c3.rows === 1 && c3.closed,
  JSON.stringify({ n: c3.nFigs, bbox: c3.bbox, cap: c3.cap, img: c3.img, phAt: c3.phAt, rows: c3.rows }));
check("③-5 占位行插在**光标处**（不是一律补末尾）——文本里第 k 个占位符对应第 k 项，" +
  "两边必须一起插在 k 位置",
  c3.phAt === caret.at + phBefore, `phAt=${c3.phAt} want=${caret.at + phBefore}（光标在 ${caret.at}）`);

/* 再从别的原图上切一张（多图卷）：验 seg.img 记得住"从哪张上切的" */
const pageImgs = await json(cdp, `(function(){
  var b = document.querySelectorAll('#figm-pages button');
  return JSON.stringify([].map.call(b, function (x) { return { file: x.dataset.file, on: x.classList.contains('on') }; }));
})()`);
check("③-6 选图条标出当前是哪一张（且只有一张是当前）",
  pageImgs.length === T.noFig.files.length
  && pageImgs.filter((x) => x.on).length === 1 && pageImgs.filter((x) => x.on)[0].file === c1.onFile,
  JSON.stringify(pageImgs));

/* 换到**另一张**再切（现在这张是题干那页，换一张才有意义） */
const otherIdx = pageImgs.findIndex((x) => !x.on);
if (otherIdx >= 0) {
  await ev(cdp, "document.getElementById('e-figadd').click()");
  await sleep(700);
  const p2 = await json(cdp, `(function(){
    var b = document.querySelectorAll('#figm-pages button')[${otherIdx}];
    var before = document.getElementById('figm-img').getAttribute('src');
    b.click();
    return JSON.stringify({ before: before });
  })()`);
  await sleep(1400);
  const c4 = await json(cdp, `(function(){
    var im = document.getElementById('figm-img'), b = document.querySelectorAll('#figm-pages button');
    return JSON.stringify({ src: im.getAttribute('src'), loaded: im.naturalWidth > 0,
      on: [].map.call(b, function (x) { return x.classList.contains('on'); }) });
  })()`);
  await ev(cdp, `(function(){ document.getElementById('figm-cap').value = '第二张上的图'; })()`);
  await ev(cdp, "document.getElementById('figm-save').click()");
  await sleep(1400);
  const c5 = await json(cdp, `(function(){
    return CloudAPI.getQuestion(${JSON.stringify(T.noFig.id)}).then(function (row) {
      var figs = (row.stem || []).filter(function (s) { return s.t === "figure"; });
      var last = figs.filter(function (s) { return s.caption === "第二张上的图"; })[0];
      return JSON.stringify({ n: figs.length, img: last ? last.img : "", cap: last ? last.caption : "",
        rows: document.querySelectorAll('#e-figs .figrow').length });
    });
  })()`);
  check("③-7 换一张原图再切：seg.img 记的是**那张**原图（不记的话渲染会拿题干那页去抠，" +
    "抠出来是错的）",
    c4.src !== p2.before && c4.loaded && c5.n === 2 && c5.img === T.noFig.files[otherIdx]
    && c5.rows === 2, JSON.stringify({ srcChanged: c4.src !== p2.before, img: c5.img, n: c5.n }));
}

/* ---------------------------------------------------------------- ④ 大小 / 位置（带图的题） */
await nav(`${BASE}/question.html?id=${T.figSolve.id}`);
const g0 = await json(cdp, GEO);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(500);
const sz = await json(cdp, `(function(){
  var th = document.querySelector('#e-figs .fthumb .figbox');
  var t0 = th.getBoundingClientRect().width;
  var rng = document.querySelector('#e-figs [data-fdw]');
  rng.value = '50'; rng.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ t0: Math.round(t0), rd: document.querySelector('#e-figs [data-fdwv]').textContent,
    t1: Math.round(th.getBoundingClientRect().width) });
})()`);
check("④-1 大小滑杆拖到 50%：读数跟着走、缩略图当场缩一半（不点保存也看得见）",
  sz.rd === "50%" && Math.abs(sz.t1 - sz.t0 / 2) < 6 && sz.t1 < sz.t0 - 40, JSON.stringify(sz));
await ev(cdp, "document.querySelector('#e-figs [data-fdwdef]').click()");
await sleep(300);
const sz2 = await json(cdp, `(function(){
  var th = document.querySelector('#e-figs .fthumb .figbox');
  return JSON.stringify({ rd: document.querySelector('#e-figs [data-fdwv]').textContent,
    w: Math.round(th.getBoundingClientRect().width) });
})()`);
check("④-2 「默认」钮：读数回 100%、缩略图回原大",
  sz2.rd === "100%" && Math.abs(sz2.w - sz.t0) < 3, JSON.stringify(sz2) + " vs " + sz.t0);

/* 位置：右 -> 居中 -> 左（每次经「保存修改」落到真渲染，量真像素） */
async function setPos(which, wrap) {
  await ev(cdp, "document.getElementById('q-edit').click()");
  await sleep(400);
  await ev(cdp, `document.querySelector('#e-figs [data-fpos="${which}"]').click()`);
  await sleep(300);
  if (wrap) {
    await ev(cdp, `(function(){
      var c = document.querySelector('#e-figs [data-fwrap]');
      c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);
  }
  await ev(cdp, "document.getElementById('e-save').click()");
  await sleep(1300);
  return json(cdp, GEO);
}
const gR = await setPos("r");
check("④-3 位置=右：图**整块**挪到题栏右边（右边缘贴齐），尺寸一点不变（不是撑满整栏）",
  Math.abs(gR.right) <= 2 && Math.abs(gR.left) > 100 && Math.abs(gR.w - g0.w) < 3
  && /figwrap fp-r/.test(gR.wrap) && /fp-r/.test(gR.cls), JSON.stringify(gR) + " vs 默认 " + JSON.stringify(g0));
const gC = await setPos("c");
check("④-4 位置=居中：左右留白相等",
  Math.abs(gC.left - gC.right) <= 2 && Math.abs(gC.w - g0.w) < 3 && /figwrap fp-c/.test(gC.wrap),
  JSON.stringify(gC));
const gL = await setPos("l");
check("④-5 位置=左：贴左缘（留白都在右边）",
  Math.abs(gL.left) <= 2 && gL.right > 100 && Math.abs(gL.w - g0.w) < 3,
  JSON.stringify(gL));
const gW = await json(cdp, ROW);
check("④-6 选了「左」之后「文字环绕」才可用（居中不环绕）",
  gW.wrap && gW.wrapDis === false, JSON.stringify({ dis: gW.wrapDis }));
await nav(`${BASE}/question.html?id=${T.figSolve.id}`);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(400);
await ev(cdp, `document.querySelector('#e-figs [data-fpos="c"]').click()`);
await sleep(300);
const gCD = await json(cdp, ROW);
check("④-7 点「居中」：环绕勾立刻变灰（居中不环绕）",
  gCD.posOn === "c" && gCD.wrapDis === true && gCD.wrapOn === false, JSON.stringify(gCD));
await ev(cdp, `document.querySelector('#e-figs [data-fpos="l"]').click()`);
await sleep(200);
await ev(cdp, `(function(){
  var c = document.querySelector('#e-figs [data-fwrap]');
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(300);
await ev(cdp, "document.getElementById('e-save').click()");
await sleep(1300);
const gWrap = await json(cdp, GEO);
check("④-8 勾「文字环绕」：图自己浮起来（float），题干文字能绕到另一侧",
  gWrap.float === "left" && /fw-l/.test(gWrap.cls) && gWrap.nWrap === 0,
  JSON.stringify(gWrap));
/* 跟随默认 = 取消位置（回到题型的默认落位） */
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(400);
await ev(cdp, `document.querySelector('#e-figs [data-fpos=""]').click()`);
await sleep(200);
await ev(cdp, "document.getElementById('e-save').click()");
await sleep(1300);
const gD = await json(cdp, GEO);
check("④-9 「跟随默认」：位置/环绕都清掉，图回到文字流里（无类名、无包裹层）",
  gD.cls === "figbox" && gD.nWrap === 0 && gD.float === "none" && Math.abs(gD.w - g0.w) < 3,
  JSON.stringify(gD));

/* ---------------------------------------------------------------- ⑤ 落库往返 */
await nav(`${BASE}/question.html?id=${T.figSolve.id}`);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(400);
await ev(cdp, `(function(){
  var rng = document.querySelector('#e-figs [data-fdw]');
  rng.value = '60'; rng.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#e-figs [data-fpos="r"]').click();
})()`);
await sleep(250);
await ev(cdp, `(function(){
  var c = document.querySelector('#e-figs [data-fwrap]');
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(250);
await ev(cdp, "document.getElementById('e-save').click()");
await sleep(1400);
const p60 = await json(cdp, GEO);
check("⑤-3 保存后题目页真渲染：60% 的图 ≈ 默认宽的 0.6 倍（zoom 真生效，不是只存了字段）",
  Math.abs(p60.w - g0.w * 0.6) < 10 && p60.float === "right" && /fw-r/.test(p60.cls),
  JSON.stringify(p60) + " 默认宽 " + g0.w);
await nav(`${BASE}/question.html?id=${T.figSolve.id}`);
await ev(cdp, "document.getElementById('q-edit').click()");
await sleep(500);
const rt = await json(cdp, ROW);
check("⑤-1 保存修改后重开：大小 60% / 右 / 环绕 原样都在（不是只改了内存）",
  rt.dw === "60" && rt.rd === "60%" && rt.posOn === "r" && rt.wrapOn === true && rt.wrapDis === false,
  JSON.stringify(rt));
const rtGeo = await json(cdp, `(function(){
  return CloudAPI.getQuestion(${JSON.stringify(T.figSolve.id)}).then(function (row) {
    var f = (row.stem || []).filter(function (s) { return s.t === "figure"; })[0];
    return JSON.stringify({ dw: f.dw, pos: f.pos, wrap: !!f.wrap });
  });
})()`);
check("⑤-2 落库字段就是 dw / pos / wrap（没有额外脏字段）",
  rtGeo.dw === 60 && rtGeo.pos === "r" && rtGeo.wrap === true, JSON.stringify(rtGeo));

/* ---------------------------------------------------------------- ⑥ 卷面口径 */
await nav(`${BASE}/print.html?id=${T.figSolve.paper_id}`, 3200);
const sh1 = await json(cdp, `(function(){
  var it = document.querySelector('.gitem[data-qid="${T.figSolve.id}"]');
  if (!it) return JSON.stringify(null);
  var fb = it.querySelector('.figbox'), r = fb ? fb.getBoundingClientRect() : null;
  var ir = it.getBoundingClientRect();
  return JSON.stringify({ cls: it.className, style: it.getAttribute('style') || "",
    figCls: fb ? fb.className : "", figW: r ? Math.round(r.width) : 0,
    right: r ? Math.round(ir.right - r.right) : -1, wrap: !!it.querySelector('.figwrap') });
})()`);
check("⑥-1 卷面：手工定过位置的应用题图不再被「应用题靠右」抢走，图带 fw-，包裹层拆掉了",
  sh1 && !/figright/.test(sh1.cls) && /fw-r/.test(sh1.figCls) && sh1.wrap === false,
  JSON.stringify(sh1));
check("⑥-2 卷面默认宽 = 题型默认 × 显示大小（应用题 68mm × 60% ≈ 41mm）",
  sh1 && /--figw:\s*4[01]mm/.test(sh1.style), sh1 && sh1.style);

/* 清掉显式位置，看卷面回到"应用题靠右 + 68mm" */
await ev(cdp, `(function(){
  return CloudAPI.getQuestion(${JSON.stringify(T.figSolve.id)}).then(function (row) {
    var stem = row.stem.map(function (s) {
      if (s.t === "figure") { delete s.pos; delete s.wrap; delete s.dw; }
      return s;
    });
    return CloudAPI.updateQuestion(${JSON.stringify(T.figSolve.id)}, { stem: stem, source: row.source });
  });
})()`);
await nav(`${BASE}/print.html?id=${T.figSolve.paper_id}`, 3200);
const sh2 = await json(cdp, `(function(){
  var it = document.querySelector('.gitem[data-qid="${T.figSolve.id}"]');
  return JSON.stringify({ cls: it ? it.className : "", style: it ? it.getAttribute('style') : "" });
})()`);
check("⑥-3 没定过位置时卷面走题型默认：应用题靠右（figright）+ 68mm",
  /figright/.test(sh2.cls) && /--figw:\s*68mm/.test(sh2.style), JSON.stringify(sh2));

/* 带图选择题：选项左、图右（.figduo）；手工定位置后不再并排 */
await nav(`${BASE}/print.html?id=${T.figChoice.paper_id}`, 3200);
const sh3 = await json(cdp, `(function(){
  var it = document.querySelector('.gitem[data-qid="${T.figChoice.id}"]');
  return JSON.stringify({ duo: !!(it && it.querySelector('.figduo')), style: it ? it.getAttribute('style') : "" });
})()`);
check("⑥-4 带图选择题默认左选项右插图（.figduo）+ 62mm 默认宽",
  sh3.duo && /--figw:\s*62mm/.test(sh3.style), JSON.stringify(sh3));

/* ---------------------------------------------------------------- ⑩ 不回潮 + 收尾 */
const noAdj = await json(cdp, `(function(){
  return JSON.stringify({ adj: document.querySelectorAll('[data-fadj],#figm [data-adj]').length,
    persp: !!document.querySelector('[data-persp]') });
})()`);
check("⑩-1 「调整」（大小/旋转/拉伸）与四点透视矫正没有回潮", noAdj.adj === 0 && !noAdj.persp,
  JSON.stringify(noAdj));
await ev(cdp, `localStorage.removeItem(${JSON.stringify(QEDITS)})`);
await sleep(200);
const cleared = await ev(cdp, `localStorage.getItem(${JSON.stringify(QEDITS)}) === null`);
check("⑩-2 自检收尾：清掉演示覆盖层，不留脏数据", cleared);

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   <<< " + c.detail}`);
}
console.log(`\n${checks.length - bad}/${checks.length} 通过` + (bad ? `，失败 ${bad} 项` : ""));
chrome.kill();
process.exit(bad ? 1 : 0);
