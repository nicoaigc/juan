/* 把 app/js/refine.js 注入浏览器，对「人工标注的插图框」跑 `Refine.snapFigures`，
 * 逐张比对 Python 孪生（tools/figsnap_proto.py）的输出，并算 IoU。
 *
 * 为什么要浏览器：snapFigures 要 canvas 读像素、要 HTMLImageElement 解 JPEG。
 *
 * 用法：
 *   1) 「/c/Program Files/Google/Chrome/Application/chrome.exe」--headless=new \
 *        --remote-debugging-port=9346 --user-data-dir=$(mktemp -d) about:blank &
 *   2) $P tools/figsnap_eval.py --json .workbuddy/tmp/figsnap_eval.json
 *      node tools/figsnap_js_check.mjs [--cdp-port 9346] \
 *        [--expect .workbuddy/tmp/figsnap_eval.json] [--out .workbuddy/tmp/figsnap_js.json]
 *
 * 判定：JS 与 Python 的框相差 > TOL px 就报不一致（两边参数/判据不同步的信号）；
 *       同时打印「现状(外扩) / 吸附」的 IoU，确认 JS 侧也拿到工具的收益。
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = Number(opt("cdp-port", "9346"));
const EXPECT = opt("expect", ".workbuddy/tmp/figsnap_eval.json");
const OUT = opt("out", ".workbuddy/tmp/figsnap_js.json");
const TOL = Number(opt("tol", "6"));
const WORK_MAX = Number(opt("work-max", "1600"));

const exp = JSON.parse(fs.readFileSync(EXPECT, "utf8"));
const refineJs = fs.readFileSync("app/js/refine.js", "utf8");

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

async function evalJs(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ar = (a[2] - a[0]) * (a[3] - a[1]), br = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (ar + br - inter);
}

async function main() {
  const list = await httpJson("/json/list");
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`连不上 Chrome 调试端口 ${PORT}`);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: "about:blank" });
  await new Promise((r) => setTimeout(r, 300));
  const inj = await evalJs(cdp, refineJs);
  if (inj && inj.__exception) throw new Error("注入 refine.js 失败：" + inj.__exception);
  if (await evalJs(cdp, "!!(window.Refine && window.Refine.snapFigures)") !== true)
    throw new Error("注入后 window.Refine.snapFigures 不在");

  const results = [];
  let aggW = 0, aggS = 0, mismatch = 0;
  console.log(pad("样本", 12) + pad("现状(外扩) IoU", 16) + pad("吸附后 IoU", 16) + "JS vs Python");
  for (const c of exp.cases) {
    const buf = fs.readFileSync(c.image);
    const ext = path.extname(c.image).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    const expr = `(async () => {
      const B64 = ${JSON.stringify(buf.toString("base64"))};
      const bin = atob(B64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], ${JSON.stringify(path.basename(c.image))}, { type: ${JSON.stringify(mime)} });
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("image load failed")); img.src = url; });
      let out = null, err = null;
      try { out = window.Refine.snapFigures({ image: img, boxes: [{ i: 0, bbox: ${JSON.stringify(c.model)} }],
                                             params: { workMax: ${WORK_MAX} } }); }
      catch (e) { err = String((e && e.message) || e); }
      URL.revokeObjectURL(url);
      return { ok: !!out, err: err, box: (out && out.boxes && out.boxes[0]) || null,
               W: img.naturalWidth, H: img.naturalHeight };
    })()`;
    const res = await evalJs(cdp, expr);
    if (!res || res.__exception) {
      console.log(`  ${c.label}: 页面异常 ${String(res && res.__exception).slice(0, 200)}`);
      results.push({ label: c.label, error: String(res && res.__exception) });
      continue;
    }
    const jsBox = res.box;
    const got = jsBox || c.widen;
    const wi = iou(c.widen, c.truth), si = iou(got, c.truth);
    aggW += wi; aggS += si;
    let tag = "（Python 也是兜底）";
    if (jsBox && c.snap) {
      const d = Math.max(...jsBox.map((v, i) => Math.abs(v - c.snap[i])));
      if (d > TOL) { tag = `⚠ 与 Python 差 ${d}px  js=${jsBox}  py=${c.snap}`; mismatch++; }
      else tag = `一致（最大差 ${d}px）`;
    } else if (!!jsBox !== !!c.snap) {
      tag = `⚠ 兜底判定不一致  js=${jsBox}  py=${c.snap}`;
      mismatch++;
    }
    console.log(pad(c.label, 12) + pad(wi.toFixed(3), 16) + pad(si.toFixed(3), 16) + tag);
    results.push({ label: c.label, image: c.image, model: c.model, truth: c.truth,
                   widen: c.widen, python: c.snap, js: jsBox, iouWiden: wi, iouSnap: si });
  }
  const n = exp.cases.length;
  console.log("\n平均 IoU：现状 " + (aggW / n).toFixed(3) + " → 吸附 " + (aggS / n).toFixed(3) + "   （JS 侧，" + n + " 张）");
  console.log(mismatch ? `❌ 有 ${mismatch} 张与 Python 不一致` : "✅ 与 Python 侧逐张一致");
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1), "utf8");
  console.log("->", OUT);
  cdp.close();
  if (mismatch) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error("脚本失败：", e.message || e); process.exit(1); });
