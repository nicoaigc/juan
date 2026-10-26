/* 离线验证 recognize.js ↔ refine.js 的接线（不调模型、不花额度）。
 *
 * 注入 refine.js + recognize.js 到页面上下文，然后：
 *   A. 用已有 raw.json（模型原始输出）+ 原图走 Refine.snap → q._rb → Recognize.normalizeRow，
 *      对比落库 bbox 与直接 snap 的结果应一致、且 ≠ 外扩 35% 的兜底值；
 *      **插图另走一路**：Refine.snapFigures → stem 片段的 f._sb → normalizeRow 的
 *      stem[figure].bbox，应等于吸附框；没吸附到的应等于「外扩 25%（30~80）」。
 *   B. 删掉 window.Refine（并清掉 _rb / _sb）再走一遍，确认分别退回「外扩 35% / 25%」。
 *
 * 用法： node tools/reco_wiring_check.mjs --raw xxx.raw.json --image xxx.jpg [--out out.json]
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = Number(opt("cdp-port", "9346"));
const RAW = opt("raw");
const IMAGE = opt("image");
const OUT = opt("out", ".workbuddy/tmp/recog_pilot/wiring.json");
if (!RAW || !IMAGE) { console.error("需要 --raw 与 --image"); process.exit(2); }

async function httpJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
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
  close() { try { this.ws.close(); } catch {} }
}
async function evalJs(cdp, expr, awaitPromise = true) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

async function main() {
  const refineJs = fs.readFileSync("app/js/refine.js", "utf8");
  const recoJs = fs.readFileSync("app/js/recognize.js", "utf8");
  const promptStub = `window.RECOGNIZE_PROMPT = { system: "stub", user: "stub" };`;

  const list = await httpJson("/json/list");
  const page = list.find((t) => t.type === "page");
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  for (const [name, js] of [["refine.js", refineJs], ["recognize.js", recoJs], ["prompt stub", promptStub]]) {
    const r = await evalJs(cdp, js, false);
    if (r && r.__exception) throw new Error(`注入 ${name} 失败：` + r.__exception);
  }
  console.log("已注入 refine.js + recognize.js + prompt stub");

  const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
  const rawq = raw.rawQuestions || raw.questions || [];
  const qs = JSON.stringify(rawq);
  const buf = fs.readFileSync(IMAGE);
  const ext = path.extname(IMAGE).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";

  const expr = `(async () => {
    const B64 = ${JSON.stringify(buf.toString("base64"))};
    const bin = atob(B64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], ${JSON.stringify(path.basename(IMAGE))}, { type: ${JSON.stringify(mime)} });
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("image load failed")); img.src = url; });
    const qs = ${qs};
    const out = { W: img.naturalWidth, H: img.naturalHeight };

    // ---- A：Refine 在，走完整接线（先模拟 recognizePage 挂 _rb / _sb 的那两步）----
    const sane = (b) => b && b.length >= 4 && b[2] > b[0] && b[3] > b[1];
    const snap0 = window.Refine.snap({ image: img, boxes: qs.map((q, i) => ({ i, bbox: q.bbox })).filter(x => sane(x.bbox)) });
    if (snap0 && snap0.boxes) qs.forEach((q, i) => { const rb = snap0.boxes[i]; if (sane(rb)) q._rb = rb; });
    const figList = [];
    qs.forEach(function (q) {
      (q.stem || []).forEach(function (f) {
        if (f && f.t === "figure" && sane(f.bbox)) figList.push({ i: figList.length, f: f, bbox: f.bbox });
      });
    });
    let fsn = null;
    if (figList.length) {
      fsn = window.Refine.snapFigures({ image: img,
        boxes: figList.map(function (t) { return { i: t.i, bbox: t.bbox }; }) });
      if (fsn && fsn.boxes) figList.forEach(function (t) {
        const sb = fsn.boxes[t.i]; if (sane(sb)) t.f._sb = sb;
      });
    }
    const rowsA = qs.map((q, i) => window.Recognize.normalizeRow(q, { paperId: "pilot", seq: i + 1, filename: "f.jpg", pageNo: 1, W: out.W, H: out.H }));
    out.A_snap = snap0 ? snap0.boxes : null;
    out.A_rows_bbox = rowsA.map(r => r.source && r.source.bbox);
    out.A_fig_bbox = rowsA.map(r => (r.stem || []).filter(s => s.t === "figure").map(s => s.bbox));
    out.A_fig_snap = fsn ? fsn.boxes : null;

    // ---- B：删掉 Refine 且去掉 _rb / _sb，应退回外扩 35% / 25% ----
    const Keep = window.Refine; delete window.Refine;
    const qsB = qs.map((q) => {
      const c = JSON.parse(JSON.stringify(q));
      delete c._rb;
      (c.stem || []).forEach(function (f) { if (f) delete f._sb; });
      return c;
    });
    const rowsB = qsB.map((q, i) => window.Recognize.normalizeRow(q, { paperId: "pilot", seq: i + 1, filename: "f.jpg", pageNo: 1, W: out.W, H: out.H }));
    window.Refine = Keep;
    out.B_rows_bbox = rowsB.map(r => r.source && r.source.bbox);
    out.B_fig_bbox = rowsB.map(r => (r.stem || []).filter(s => s.t === "figure").map(s => s.bbox));
    return out;
  })()`;
  const res = await evalJs(cdp, expr, true);
  if (!res || res.__exception) throw new Error("页面异常 " + String(res && res.__exception).slice(0, 400));

  fs.writeFileSync(OUT, JSON.stringify(res, null, 1), "utf8");
  // 摘要
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let nA = 0, nB = 0, nSame = 0, nTot = 0;
  res.A_rows_bbox.forEach((b, i) => {
    if (!b) return;
    nTot++;
    const key = Object.keys(res.A_snap || {}).map(Number).find(k => same(res.A_snap[k], b));
    if (key !== undefined) nA++;
    const wb = res.B_rows_bbox[i];
    if (wb && !same(wb, b)) nB++;
    if (key !== undefined && wb && !same(wb, b)) nSame++;
  });
  console.log(`共 ${nTot} 行：A（接线后）= 吸附框的 ${nA} 个；A≠B（吸附与外扩不同）的 ${nB} 个`);
  // 插图
  const snapVals = Object.keys(res.A_fig_snap || {}).map(k => res.A_fig_snap[k]);
  let fTot = 0, fSnapped = 0, fDiffWiden = 0, fBad = 0;
  (res.A_fig_bbox || []).forEach((arr, i) => {
    arr.forEach((b, j) => {
      fTot++;
      const wb = ((res.B_fig_bbox || [])[i] || [])[j];
      const hit = snapVals.find(v => same(v, b));
      if (hit) fSnapped++;
      else if (!same(b, wb)) fBad++;      // 既不是吸附框、又与外扩不同 → 接线有问题
      if (wb && !same(wb, b)) fDiffWiden++;
    });
  });
  console.log(`共 ${fTot} 张插图：落库框 = 吸附框的 ${fSnapped} 张；`
    + `与外扩不同的 ${fDiffWiden} 张；既非吸附框又非外扩的（**应为 0**）${fBad} 张`);
  console.log(`-> ${OUT}`);
  cdp.close();
  if (fBad > 0) process.exitCode = 1;
}
main().then(() => process.exit(0)).catch((e) => { console.error("失败：", e.message || e); process.exit(1); });
