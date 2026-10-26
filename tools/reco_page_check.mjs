/* 单页重扫（Recognize.rescanPage / CloudAPI 按页操作）的离线验证。
 *
 * 不调真模型、不花额度：把 window.CloudAPI.cloud.llm 换成一个**可切换的假流**，
 * 让 recognizePage 走完整链路（真实图片、真实 refine 吸附、真实 toRow 归一化），
 * 只有"模型说什么"是假的。
 *
 * 用本地演示模式（127.0.0.1:64911）的 4 页卷「第2单元练习卷（静安名校）」：
 *   第1页 24 题 / 第2页 6 题 / 第3页 4 题 / 第4页 7 题，seq 1..41。
 * 重扫第 2 页（假模型返回 5 题）后应满足：
 *   · 只有第 2 页的题被换掉（新 id 与旧 id 无交集）
 *   · 第 1/3/4 页的题 **id 与题干一字不动**
 *   · 顺序仍是 1→2→3→4 页，seq 连续 1..40
 * 另外验：模型失败 / 返回空列表时，**数据一个字节都不动**。
 *
 * 用法：node tools/reco_page_check.mjs [-cdp-port 9346] [-base http://127.0.0.1:64911]
 */
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const CDP_PORT = Number(opt("cdp-port", "9346"));
const BASE = opt("base", "http://127.0.0.1:64911");
const OUT = opt("out", ".workbuddy/tmp/reco-page");

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
  close() { try { this.ws.close(); } catch {} }
}
async function evalJs(cdp, expr, awaitPromise = false) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}

/* 注入到页面：① 假模型流（三种模式）② 造一张真图片当"照片" */
const PATCH = `(function(){
  try { localStorage.removeItem("sj-demo-qedits-v1"); localStorage.removeItem("sj-demo-qtags-v1"); } catch (e) {}
  window.__llmMode = "ok";
  window.__llmCalls = 0;
  function fakeQs(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({ no: i + 1, printed_no: String(i + 1), section: "一、算一算", type: "calculate",
                 stem: [{ t: "text", v: "(假)" + (i + 1) + " 3\\\\times4=" }],
                 bbox: [80, 60 + i * 90, 620, 130 + i * 90],
                 confidence: { stem: 0.93 } });
    }
    return out;
  }
  var cap;
  Object.defineProperty(window, "CloudAPI", {
    configurable: true,
    get: function () { return cap; },
    set: function (v) {
      cap = v;
      if (v && v.demo) {
        v.cloud = { llm: { chat: { completions: { create: function () {
          return (async function* () {
            window.__llmCalls++;
            if (window.__llmMode === "fail") throw new Error("模拟模型失败");
            var body = window.__llmMode === "empty"
              ? { questions: [] }
              : { questions: fakeQs(window.__llmN || 5) };
            var s = JSON.stringify(body);
            for (var i = 0; i < s.length; i += 120) {
              yield { choices: [{ delta: { content: s.slice(i, i + 120) } }] };
            }
            yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { credit: 0.12 } };
          })();
        } } } } };
      }
    },
  });
  // 造一张真图片（canvas → File），免得依赖演示库里那张 jpg 能不能取到
  window.__mkFile = function () {
    return new Promise(function (res) {
      var cv = document.createElement("canvas");
      cv.width = 900; cv.height = 1200;
      var g = cv.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#000"; g.font = "28px sans-serif";
      for (var i = 0; i < 8; i++) g.fillText((i + 1) + ". 3\\\\times4=", 60, 90 + i * 90);
      cv.toBlob(function (b) { res(new File([b], "page-x.jpg", { type: "image/jpeg" })); }, "image/jpeg");
    });
  };
})();`;

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("连不上 Chrome 调试端口 " + CDP_PORT);
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
const inj = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PATCH });
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 1180, height: 2400, deviceScaleFactor: 1, mobile: false });

// 演示模式：4 页的那一卷
await cdp.send("Page.navigate", { url: `${BASE}/paper.html?id=4` });
await sleep(2600);

// 页面上认出那一卷的 id 与第 2 页的文件名，避免写死
const meta = await evalJs(cdp, `(async function(){
  var ps = await CloudAPI.listPapers();
  var p = null, id = null;
  for (var i = 0; i < ps.length; i++) if ((ps[i].title || "").indexOf("第2单元") >= 0) { p = ps[i]; id = ps[i].id; }
  var fs2 = await CloudAPI.listFiles(id);
  var maxPage = 0;
  fs2.forEach(function (f) { maxPage = Math.max(maxPage, Number(f.page_no) || 0); });
  return { paperId: id, title: p && p.title, files: fs2.map(function (f) {
             return { page_no: f.page_no, filename: f.filename, storage_path: f.storage_path }; }),
           maxPage: maxPage };
})()`, true);
console.log("   卷：" + JSON.stringify(meta && { paperId: meta.paperId, title: meta.title, maxPage: meta.maxPage }));
check("找到 4 页的演示卷", meta && meta.paperId && meta.files && meta.files.length === 4,
  JSON.stringify(meta && meta.files && meta.files.length));
const PID = meta.paperId;
const F2 = (meta.files || []).find((f) => Number(f.page_no) === 2) || {};

console.log("\n【① 重扫前的基线】");
const base = await evalJs(cdp, `(async function(){
  var qs = await CloudAPI.listQuestions(${PID});
  var by = {}; qs.forEach(function (q) { var p = Number((q.source||{}).page); (by[p] = by[p] || []).push(q); });
  var snap = {};
  Object.keys(by).forEach(function (p) { snap[p] = { ids: by[p].map(function(q){return q.id;}),
    seqs: by[p].map(function(q){return q.seq;}),
    stems: by[p].map(function(q){return (q.stem||[]).map(function(s){return s.t+":"+s.v;}).join("|");}) }; });
  return { total: qs.length, pages: Object.keys(snap).sort().map(function(p){return {page:Number(p), n:snap[p].ids.length, ids:snap[p].ids, seqs:snap[p].seqs, stems:snap[p].stems};}) };
})()`, true);
console.log("   " + JSON.stringify((base.pages || []).map((p) => "p" + p.page + ":" + p.n)).slice(0, 200));
check("基线：4 页共 41 题", base && base.total === 41 && base.pages.length === 4, JSON.stringify(base && base.total));
check("基线：seq 连续 1..41", base && base.pages.reduce((a, p) => a + p.n, 0) === 41
  && base.pages[3].seqs[base.pages[3].seqs.length - 1] === 41,
  JSON.stringify(base && base.pages.map((p) => p.seqs[0] + "-" + p.seqs[p.seqs.length - 1])));

console.log("\n【② 只重扫第 2 页（假模型给 5 题）】");
const r = await evalJs(cdp, `(async function(){
  window.__llmMode = "ok"; window.__llmN = 5; window.__llmCalls = 0;
  var f = await window.__mkFile();
  var res = await Recognize.rescanPage({ paperId: ${PID}, page: 2, file: f,
    filename: ${JSON.stringify(F2.filename || "p2.jpg")}, model: "fake",
    onProgress: function () {} });
  var qs = await CloudAPI.listQuestions(${PID});
  var ps = await CloudAPI.listPapers();
  var p = null; ps.forEach(function (x) { if (String(x.id) === String(${PID})) p = x; });
  return { res: res, calls: window.__llmCalls,
    order: qs.map(function (q) { return Number((q.source||{}).page); }),
    seqs: qs.map(function (q) { return q.seq; }),
    ids: qs.map(function (q) { return q.id; }),
    stems: qs.map(function (q) { return (q.stem||[]).map(function(s){return s.t+":"+s.v;}).join("|"); }),
    count: qs.length,
    paper: p ? { question_count: p.question_count, status: p.status, status_note: p.status_note } : null };
})()`, true);
if (r && r.__exception) throw new Error("重扫异常：" + String(r.__exception).slice(0, 400));
console.log("   " + JSON.stringify({ res: r.res, calls: r.calls, count: r.count, paper: r.paper }));
check("只调了一次模型（不是整卷）", r && r.calls === 1, "calls=" + (r && r.calls));
check("返回：这一页 5 题、换掉 6 题、全卷 40 题",
  r && r.res.count === 5 && r.res.replaced === 6 && r.res.total === 40, JSON.stringify(r && r.res));

// 顺序：页序列 + seq 连续
const expOrder = [];
for (let i = 0; i < 24; i++) expOrder.push(1);
for (let i = 0; i < 5; i++) expOrder.push(2);
for (let i = 0; i < 4; i++) expOrder.push(3);
for (let i = 0; i < 7; i++) expOrder.push(4);
check("顺序仍按 1→2→3→4 页（第2页那段原地换成新结果）",
  JSON.stringify(r.order) === JSON.stringify(expOrder),
  JSON.stringify((r.order || []).join("").match(/1*2*3*4*/) || r.order));
check("seq 连续 1..40", JSON.stringify(r.seqs) === JSON.stringify(Array.from({ length: 40 }, (_, i) => i + 1)),
  JSON.stringify((r.seqs || []).slice(0, 8)) + "…" + JSON.stringify((r.seqs || []).slice(-3)));
check("第 2 页的 seq = 25..29", JSON.stringify(r.seqs.slice(24, 29)) === JSON.stringify([25, 26, 27, 28, 29]),
  JSON.stringify(r.seqs.slice(24, 29)));

// 其它页 id / 题干不变
const oldP = {}; base.pages.forEach((p) => { oldP[p.page] = p; });
const newP = {};
r.order.forEach((pg, i) => { (newP[pg] = newP[pg] || []).push(i); });
function segIds(pg) { return newP[pg].map((i) => r.ids[i]); }
function segStems(pg) { return newP[pg].map((i) => r.stems[i]); }
check("第 1 页 24 题 id 一个没变", JSON.stringify(segIds(1)) === JSON.stringify(oldP[1].ids),
  JSON.stringify(segIds(1).slice(0, 4)) + " vs " + JSON.stringify(oldP[1].ids.slice(0, 4)));
check("第 1 页题干一字不动", JSON.stringify(segStems(1)) === JSON.stringify(oldP[1].stems));
check("第 3 页 4 题 id 一个没变", JSON.stringify(segIds(3)) === JSON.stringify(oldP[3].ids));
check("第 3 页题干一字不动", JSON.stringify(segStems(3)) === JSON.stringify(oldP[3].stems));
check("第 4 页 7 题 id 一个没变", JSON.stringify(segIds(4)) === JSON.stringify(oldP[4].ids));
check("第 4 页题干一字不动", JSON.stringify(segStems(4)) === JSON.stringify(oldP[4].stems));
const old2 = oldP[2].ids, new2 = segIds(2);
check("第 2 页换成了新题（与旧 id 无交集）",
  new2.length === 5 && new2.every((id) => old2.indexOf(id) < 0),
  JSON.stringify(new2) + " 旧 " + JSON.stringify(old2));
check("第 2 页的新题干是这次识别的结果", segStems(2).every((s) => /\(假\)/.test(s)),
  JSON.stringify(segStems(2).slice(0, 2)));
check("卷面统计跟着更新（question_count=40）", r.paper && Number(r.paper.question_count) === 40,
  JSON.stringify(r.paper));
check("状态备注写明只重扫了第 2 页", r.paper && /第 2 页/.test(r.paper.status_note || ""),
  JSON.stringify(r.paper && r.paper.status_note));

console.log("\n【③ 模型失败 / 空结果：数据一个字节都不动】");
const guard = await evalJs(cdp, `(async function(){
  var before = JSON.stringify(await CloudAPI.listQuestions(${PID}));
  function brief(qs) { return qs.map(function(q){return q.id+":"+q.seq+":"+(q.stem||[]).map(function(s){return s.v;}).join("");}).join("|"); }
  var f = await window.__mkFile();
  var errs = [];
  window.__llmMode = "fail";
  try { await Recognize.rescanPage({ paperId: ${PID}, page: 3, file: f, filename: "p3.jpg", model: "fake" }); }
  catch (e) { errs.push(String(e.message || e)); }
  var afterFail = JSON.stringify(await CloudAPI.listQuestions(${PID}));
  window.__llmMode = "empty";
  try { await Recognize.rescanPage({ paperId: ${PID}, page: 3, file: f, filename: "p3.jpg", model: "fake" }); }
  catch (e) { errs.push(String(e.message || e)); }
  var afterEmpty = JSON.stringify(await CloudAPI.listQuestions(${PID}));
  window.__llmMode = "ok";
  return { errs: errs, sameFail: before === afterFail, sameEmpty: before === afterEmpty };
})()`, true);
console.log("   " + JSON.stringify(guard));
check("模型失败时报错并中止", guard && guard.errs.length === 2, JSON.stringify(guard && guard.errs));
check("模型失败：题目完全没变", guard && guard.sameFail === true);
check("这一页没识别出题：报错并**保留原结果**", guard && /没(有)?识别到题目|没识别出题/.test(guard.errs[1] || ""), (guard && guard.errs[1]) || "");
check("空结果：题目完全没变", guard && guard.sameEmpty === true);

console.log("\n【④ 老数据页号重复：只按 file 圈定这一张】");
const dup = await evalJs(cdp, `(async function(){
  // 找出"同一页号下有多张不同原图"的卷（演示库里那卷素养卷就是这样：3 张图都写了第 1 页）
  var ps = await CloudAPI.listPapers();
  var hit = null;
  for (var i = 0; i < ps.length; i++) {
    var qs = await CloudAPI.listQuestions(ps[i].id);
    var byPage = {};
    qs.forEach(function (q) {
      var s = q.source || {};
      var p = Number(s.page);
      if (!p || !s.file) return;
      (byPage[p] = byPage[p] || {})[s.file] = 1;
    });
    for (var p in byPage) {
      if (Object.keys(byPage[p]).length > 1) { hit = { paperId: ps[i].id, page: Number(p), files: Object.keys(byPage[p]) }; break; }
    }
    if (hit) break;
  }
  if (!hit) return { skip: "没有同页号多图的数据" };

  function brief(qs) { return qs.map(function (q) { return q.id + ":" + q.seq; }).join(","); }
  var before = await CloudAPI.listQuestions(hit.paperId);
  var target = hit.files[hit.files.length - 1];        // 最后一张，位置在末尾，最容易看出错位
  var mine = CloudAPI.pageRowsOf(before, hit.page, target);
  var others = before.filter(function (q) { return mine.indexOf(q) < 0; });
  window.__llmMode = "ok"; window.__llmN = 3;
  var f = await window.__mkFile();
  var res = await Recognize.rescanPage({ paperId: hit.paperId, page: hit.page,
    file: f, filename: target, model: "fake" });
  var after = await CloudAPI.listQuestions(hit.paperId);
  var afterIds = {}; after.forEach(function (q) { afterIds[String(q.id)] = 1; });
  var allSamePage = before.filter(function (q) { return Number((q.source||{}).page) === hit.page; }).length;
  return { paperId: hit.paperId, page: hit.page, filesSamePage: hit.files.length, allSamePage: allSamePage,
    mineN: mine.length, othersN: others.length, res: res, afterN: after.length,
    othersSurvive: others.every(function (q) { return afterIds[String(q.id)]; }),
    goneAll: mine.every(function (q) { return !afterIds[String(q.id)]; }),
    seqOk: JSON.stringify(after.map(function (q) { return q.seq; })) ===
           JSON.stringify(after.map(function (_, i) { return i + 1; })) };
})()`, true);
console.log("   " + JSON.stringify(dup));
if (!dup || dup.skip) {
  check("找到页号重复的老数据卷（没有就跳过这一节）", true, dup && dup.skip);
} else {
  check("同一页号下确实有多张图（正是危险场景）", dup.filesSamePage > 1,
    "同页号 " + dup.filesSamePage + " 张，该页共 " + dup.allSamePage + " 题");
  check("只圈定这一张图的题（没把整页号一起圈进来）",
    dup.mineN > 0 && dup.othersN > 0 && dup.mineN < dup.allSamePage,
    "这一张 " + dup.mineN + " 题 / 该页共 " + dup.allSamePage + " 题 / 其余 " + dup.othersN + " 题");
  check("只有这一张的题被换掉", dup.goneAll === true && dup.res.replaced === dup.mineN,
    "replaced=" + (dup.res && dup.res.replaced) + " 应为 " + dup.mineN);
  check("其它照片的题 id 一个没动", dup.othersSurvive === true);
  check("全卷题数 = 其余 + 新识别", dup.afterN === dup.othersN + dup.res.count,
    dup.afterN + " vs " + dup.othersN + "+" + dup.res.count);
  check("重排后 seq 仍然连续", dup.seqOk === true);
}

console.log("\n【⑤ 界面入口：每张原图下的「只重扫这页」】");
await cdp.send("Page.navigate", { url: `${BASE}/paper.html?id=${PID}` });
await sleep(2600);
const ui = await evalJs(cdp, `(function(){
  var btns = document.querySelectorAll(".origins .repage");
  return { n: btns.length,
    labels: [].map.call(btns, function (b) { return b.dataset.page + "|" + b.textContent; }),
    single: null };
})()`);
console.log("   " + JSON.stringify(ui.labels));
check("多页卷每张原图都有「只重扫这页」", ui && ui.n === 4, "n=" + (ui && ui.n));
check("按钮带页码且文案一致", ui && ui.labels.every((s) => /^\\d\\|只重扫这页$/.test(s)), JSON.stringify(ui && ui.labels));
await evalJs(cdp, `document.querySelectorAll(".origins .repage")[2].click()`);
await sleep(350);
const dlg = await evalJs(cdp, `(function(){
  var m = document.querySelector(".modal-mask"); if (!m) return null;
  return { title: m.querySelector(".m-t").textContent,
           labels: [].map.call(m.querySelectorAll(".m-f .btn"), function (b) { return b.textContent; }) };
})()`);
console.log("   " + JSON.stringify(dlg));
check("点按钮弹出「只重扫第 3 页」选择框", !!dlg && /只重扫第 3 页/.test(dlg.title || ""), JSON.stringify(dlg));
check("同样给「不备份 / 备份」两个选项", !!dlg && dlg.labels.some((t) => /不备份/.test(t))
  && dlg.labels.some((t) => /备份并重扫/.test(t)), JSON.stringify(dlg && dlg.labels));
check("选之前不会开跑", (await evalJs(cdp, `!document.querySelector("#notice .progress")`)) === true);
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(OUT + "-dlg.png", Buffer.from(shot.data, "base64"));
await evalJs(cdp, `document.querySelector(".modal-mask [data-no]").click()`);
await sleep(200);

await cdp.send("Page.navigate", { url: `${BASE}/paper.html?id=1` });
await sleep(2200);
const single = await evalJs(cdp, `document.querySelectorAll(".origins .repage").length`);
check("单页卷不显示这个按钮（等同整卷重扫，没意义）", single === 0, "n=" + single);

await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: inj.identifier });
cdp.close();
console.log("\n   截图 -> " + OUT + "-dlg.png");
console.log(`\n单页重扫验证：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
