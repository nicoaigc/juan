/* 组卷功能视觉自检：不开真账号、不碰真数据库，用内置演示题库（135 题）当数据源，
 * 把 CloudAPI 整体换掉，截「组卷台（选题 + 排版同一页）/ 自建卷卷面 / 我的组卷列表 /
 * 卷面就地排版」等十几张图。
 *
 * 数据来自 app/assets/demo-library.json（5 份卷 135 题，图走 local: 静态路径）。
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻）
 *       chrome --headless=new --remote-debugging-port=9346 --user-data-dir=<tmp> about:blank
 * 用法：node tools/compose_shot.mjs [--port 64911] [--cdp-port 9346] [--out .workbuddy/tmp]
 *
 * 拖拽没法靠鼠标模拟（headless 的 Input 域拖放要开 intercept），这里直接派发
 * dragstart/dragover/drop 原生事件 —— 走的就是页面里那套委托，和真人拖一样。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
function opt(n, d) { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const PORT = Number(opt("port", "64911"));
const CDP_PORT = Number(opt("cdp-port", "9346"));
const OUT = opt("out", ".workbuddy/tmp");
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- 造数据
const lib = JSON.parse(readFileSync("app/assets/demo-library.json", "utf-8"));

const PAPERS = [];
const QUESTIONS = [];
const FILES = [];
let qid = 0;
(lib.papers || []).forEach((p, i) => {
  const pid = i + 1;
  PAPERS.push({
    id: pid, title: p.title, paper_date: p.paper_date, subject: p.subject, grade: p.grade,
    status: p.status || "done", status_note: p.status_note || "", question_count: (p.questions || []).length,
  });
  (p.files || []).forEach((f) => FILES.push({ ...f, id: FILES.length + 1, paper_id: pid }));
  (p.questions || []).forEach((q) => {
    qid += 1;
    QUESTIONS.push({ ...q, id: qid, paper_id: pid });
  });
});

/* 自建卷示例：id=1 没排过版（走智能排版），id=2 存了自定义排版（验证重新打开能还原） */
function pick(paperIdx, n, type) {
  const pid = paperIdx + 1;
  return QUESTIONS.filter((q) => q.paper_id === pid && q.qtype === type)
    .slice(0, n).map((q) => q.id);
}
const CUSTOM_IDS = [
  ...pick(4, 5, "choice"),
  ...QUESTIONS.filter((q) => q.qtype === "fill").slice(0, 4).map((q) => q.id),
  ...pick(0, 6, "calculate"),
  ...pick(0, 2, "solve"),
];
const LAY_CHOICE = pick(4, 2, "choice");
const LAY_CALC = pick(0, 3, "calculate");
const CUSTOMS = [
  {
    id: 1, title: "第三单元总复习（自选组卷）", question_ids: CUSTOM_IDS, layout: null,
    updated_at: "2026-10-06T21:20:00+08:00", created_at: "2026-10-06T21:05:00+08:00",
  },
  {
    id: 2, title: "口算与选择专项（自定义排版）", question_ids: [...LAY_CHOICE, ...LAY_CALC],
    layout: { sections: [
      { title: "一、选择题", cols: 1, ids: LAY_CHOICE },
      { title: "二、计算题", cols: 2, ids: LAY_CALC },
    ] },
    updated_at: "2026-10-06T20:40:00+08:00", created_at: "2026-10-06T20:30:00+08:00",
  },
];

// ---------------------------------------------------------------- 页面内动作
/* 进排版模式 + 把第一条操作条点亮（headless 没有鼠标悬停，不然截图看不到它） */
const LAY_OPEN = "document.getElementById('btn-lay').click();"
  + "var q=document.querySelector('#sheets .gitem .qbar'); if(q) q.style.opacity='1';";

/* 从「二、填空题」拖一道题到「一、选择题」的最前面（只发到 dragover，停在拖拽态） */
const DRAG_HOVER =
  "var dt=new DataTransfer();"
  + "var src=document.querySelector('#sheets .grid-sec[data-si=\"1\"] .gitem[data-qid]');"
  + "var tgt=document.querySelector('#sheets .grid-sec[data-si=\"0\"] .gitem[data-qid]');"
  + "var r=tgt.getBoundingClientRect();"
  + "src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));"
  + "tgt.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,"
  +   "clientX:r.left+4,clientY:r.top+4}));";

/* 同一拖拽补上 drop 收尾 */
const DRAG_DROP =
  "var dt2=new DataTransfer();"
  + "var src2=document.querySelector('#sheets .grid-sec[data-si=\"1\"] .gitem[data-qid]');"
  + "var tgt2=document.querySelector('#sheets .grid-sec[data-si=\"0\"] .gitem[data-qid]');"
  + "var r2=tgt2.getBoundingClientRect();"
  + "src2.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt2}));"
  + "tgt2.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt2,"
  +   "clientX:r2.left+4,clientY:r2.top+4}));"
  + "tgt2.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt2,"
  +   "clientX:r2.left+4,clientY:r2.top+4}));";

/* 卷面上就地改：标题点开就改、列数点 3 列 */
const EDIT_TITLE = "var t=document.querySelector('.sec-tinp');"
  + "if(t){t.value='一、选择题（标题改过）';t.dispatchEvent(new Event('input',{bubbles:true}));}";

const SET_COLS = "var c=document.querySelector('#sheets .sec-edit[data-si=\"0\"] .ccol[data-set=\"3\"]');"
  + "if(c)c.click();";

/* 断言用：各板块的列数 / 题数 / 标题，以及「未保存」标记是否出现 */
const PROBE_STATE = "JSON.stringify({"
  + "secs:[].map.call(document.querySelectorAll('#sheets .grid-sec'),function(g){return {"
  +   "si:g.dataset.si,cols:g.style.gridTemplateColumns,n:g.querySelectorAll('.gitem[data-qid]').length};}),"
  + "titles:[].map.call(document.querySelectorAll('#sheets .sec-tinp'),function(i){return i.value;}),"
  + "dirty:document.getElementById('lay-dirty').style.display,"
  + "noControls:document.querySelectorAll('#sheets .sec-edit').length})";

const PROBE_SAVED = "JSON.stringify({"
  + "dirty:document.getElementById('lay-dirty').style.display,"
  + "saved:(window.__saved||[]).map(function(s){return {id:s.id,sections:"
  +   "((s.row.layout&&s.row.layout.sections)||[]).map(function(x){return x.title+' '+x.cols+'列 '+x.ids.length+'题';})};})})";

const ACC = { userId: "u-1", status: "approved", role: "admin", approved: true, blocked: false,
              isAdmin: true, phone: "13800138000", name: "张老师", pendingCount: 0 };

const SCENARIOS = [
  { name: "c1-compose", page: "compose.html" },
  /* 「加入」是开关：要挑还写着「加入」的那些按钮点，否则点第二次就把它移出去了 */
  { name: "c2-compose-picked", page: "compose.html",
    after: "for(var i=0;i<7;i++){var bs=document.querySelectorAll('[data-add]');"
      + "for(var j=0;j<bs.length;j++){if(bs[j].textContent.trim()==='加入'){bs[j].click();break;}}}" },
  { name: "c3-custom-paper", page: "print.html?custom=1" },
  { name: "c4-customs-list", page: "customs.html" },
  /* 进排版模式：板块标题就地变成输入框 + 列数按钮，题目卡片浮出 ↑↓←→ */
  { name: "c5-layout-open", page: "print.html?custom=1", vh: 1560, after: LAY_OPEN },
  /* 拖动中：源卡片半透明、目标位置出现插入指示线 */
  { name: "c6-drag-hover", page: "print.html?custom=1", vh: 1560, after: LAY_OPEN + DRAG_HOVER },
  /* 松手落位 + 就地改标题 + 切列数，卷面应立刻跟着变 */
  { name: "c7-layout-edited", page: "print.html?custom=1", vh: 1560,
    after: LAY_OPEN + DRAG_DROP + EDIT_TITLE + SET_COLS, probe: PROBE_STATE },
  /* 打开一份存过自定义排版的卷：应还原成 1 列 / 2 列两块 */
  { name: "c8-layout-saved", page: "print.html?custom=2", vh: 1560, after: LAY_OPEN, probe: PROBE_STATE },
  /* 保存：写库内容 + 「未保存」标记消失 */
  { name: "c9-layout-persist", page: "print.html?custom=1", vh: 1560,
    after: LAY_OPEN + DRAG_DROP + SET_COLS + "document.getElementById('lay-save').click();",
    probe: PROBE_SAVED },
  /* 退出排版：控件整块消失，卷面回到干净状态（打印前就是这个样子） */
  { name: "c10-exit-clean", page: "print.html?custom=1", vh: 1560,
    after: LAY_OPEN + "document.getElementById('btn-lay').click();", probe: PROBE_STATE },
  { name: "c11-index", page: "index.html" },
  /* 组卷端到端：填卷名 -> 点「加入」3 次 -> 保存 -> **留在本页**（URL 带上 id，可继续编辑） */
  { name: "c12-save-flow", page: "compose.html", navAway: true,
    after: "document.getElementById('c-title').value='第四单元自测（自选组卷）';"
      + "for(var i=0;i<3;i++){var bs=document.querySelectorAll('[data-add]');"
      + "for(var j=0;j<bs.length;j++){if(bs[j].textContent.trim()==='加入'){bs[j].click();break;}}}"
      + "document.getElementById('lay-save').click();" },
];

// ---------------------------------------------------------------- 桩
function stubSrc() {
  return `(function () {
  var ACC = ${JSON.stringify(ACC)};
  var PAPERS = ${JSON.stringify(PAPERS)};
  var QUESTIONS = ${JSON.stringify(QUESTIONS)};
  var FILES = ${JSON.stringify(FILES)};
  var CUSTOMS = ${JSON.stringify(CUSTOMS)};
  function patch(v) {
    v.currentUser = function () { return Promise.resolve({ id: "u-1", phoneNumber: "13800138000", name: "张老师" }); };
    v.handleWechatCallback = function () { return Promise.resolve(null); };
    v.signOut = function () { return Promise.resolve(true); };
    v.ensureAccess = function () { return Promise.resolve(ACC); };
    v.listAccess = function () { return Promise.resolve([]); };
    v.setAccess = function () { return Promise.resolve({}); };
    v.listPapers = function () { return Promise.resolve(PAPERS); };
    v.listQuestions = function (pid) {
      return Promise.resolve(QUESTIONS.filter(function (q) { return Number(q.paper_id) === Number(pid); }));
    };
    v.listFiles = function (pid) {
      return Promise.resolve(FILES.filter(function (f) { return Number(f.paper_id) === Number(pid); }));
    };
    v.listAllQuestions = function () { return Promise.resolve(QUESTIONS); };
    v.listAllFiles = function () { return Promise.resolve(FILES); };
    v.listCustomPapers = function () { return Promise.resolve(CUSTOMS); };
    v.getCustomPaper = function (id) {
      return Promise.resolve(CUSTOMS.filter(function (c) { return String(c.id) === String(id); })[0] || null);
    };
    v.createCustomPaper = function (row) { return Promise.resolve(Object.assign({ id: 1 }, row)); };
    v.updateCustomPaper = function (id, row) {
      (window.__saved = window.__saved || []).push({ id: id, row: row });   // 记下来，probe 里断言
      return Promise.resolve(Object.assign({ id: Number(id) }, row));
    };
    v.deleteCustomPaper = function () { return Promise.resolve({ id: 1 }); };
    v.signedUrl = function (p) {
      return Promise.resolve(p && p.indexOf("local:") === 0 ? p.slice(6) : "");
    };
    v.buildImageMap = undefined;
    Object.defineProperty(window, "CloudAPI", { value: v, configurable: true, writable: true });
  }
  Object.defineProperty(window, "CloudAPI", {
    configurable: true,
    get: function () { return undefined; },
    set: function (v) { patch(v); },
  });
})();`;
}

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
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const cdp = await CDP.connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  let prev = null;
  let bad = 0;
  for (const s of SCENARIOS) {
    if (prev) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: prev });
    const inj = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: stubSrc() });
    prev = inj.identifier;

    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: s.vh || 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${BASE}/${s.page}` });
    await sleep(1500);
    if (s.after) { await cdp.send("Runtime.evaluate", { expression: s.after }); await sleep(s.navAway ? 2000 : 600); }

    if (s.probe) {
      const r = await cdp.send("Runtime.evaluate", { expression: s.probe, returnByValue: true });
      const val = r.result && r.result.value;
      console.log("  probe " + s.name + ": " + val);
      if (!val || /NaN|undefined/.test(val)) bad++;
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = `${OUT}/compose-${s.name}.png`;
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log("✓ " + file);
  }
  cdp.close();
  if (bad) { console.error(`${bad} 个场景的 probe 结果异常`); process.exit(1); }
}

main().catch((e) => { console.error("失败：", e.message || e); process.exit(1); });
