/* 把 app/js/refine.js 注入浏览器，对一批 (raw.json, 图片) 跑吸附，输出吸附后的框。
 *
 * 为什么要浏览器：refine.js 需要 canvas 读像素、要 HTMLImageElement 解码 JPEG/PNG，
 * Node 里没有这些。用 CDP 把脚本注入一个真实页面，在页面上下文里造 File → Image →
 * window.Refine.snap(...)，把结果取回来。
 *
 * 用途：① 和 Python 版 tools/refine_proto.py 逐题对账（--work-max 0 = 不缩放，
 *          理论上应与 Python 逐像素一致）；② 验证非 1.0 缩放下结果不掉。
 *
 * 用法：
 *   node tools/refine_js_check.mjs --cfg "标签=raw.json|图片" [--cfg ...] \
 *        [--work-max 0] [--out .workbuddy/tmp/recog_pilot/js_refine.json] [--cdp-port 9346]
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
function opts(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--" + name && args[i + 1]) out.push(args[i + 1]);
  return out;
}
const PORT = Number(opt("cdp-port", "9346"));
const WORK_MAX = Number(opt("work-max", "0"));
const REFINE_JS = opt("refine-js", "app/js/refine.js");
const OUT = opt("out", ".workbuddy/tmp/recog_pilot/js_refine.json");
const CFGS = opts("cfg");
if (!CFGS.length) { console.error("需要至少一个 --cfg \"标签=raw.json|图片\""); process.exit(2); }

async function httpJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []; }
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
      } else if (m.method) c.events.push(m);
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
  const refineJs = fs.readFileSync(REFINE_JS, "utf8");
  const cases = CFGS.map((spec) => {
    const [label, rest] = [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)];
    const parts = rest.split("|");
    return { label, raw: parts[0], image: parts[1] };
  });

  const list = await httpJson("/json/list");
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`连不上 Chrome 调试端口 ${PORT}`);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  const inj = await evalJs(cdp, refineJs, false);
  if (inj && inj.__exception) throw new Error("注入 refine.js 失败：" + inj.__exception);
  const has = await evalJs(cdp, `!!(window.Refine && window.Refine.snap)`);
  if (has !== true) throw new Error("注入后 window.Refine.snap 不在");
  console.log(`已注入 ${REFINE_JS}   workMax=${WORK_MAX}`);

  const results = [];
  for (const cs of cases) {
    const buf = fs.readFileSync(cs.image);
    const ext = path.extname(cs.image).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    const raw = JSON.parse(fs.readFileSync(cs.raw, "utf8"));
    const rawq = raw.rawQuestions || raw.questions || [];
    const boxes = [];
    for (let i = 0; i < rawq.length; i++) {
      const b = rawq[i].bbox;
      if (b && b.length >= 4) boxes.push({ i, no: rawq[i].no, bbox: b });
    }
    const expr = `(async () => {
      const B64 = ${JSON.stringify(buf.toString("base64"))};
      const bin = atob(B64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], ${JSON.stringify(path.basename(cs.image))}, { type: ${JSON.stringify(mime)} });
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("image load failed")); img.src = url; });
      const boxes = ${JSON.stringify(boxes)};
      const t0 = performance.now();
      let out = null, err = null;
      try { out = window.Refine.snap({ image: img, boxes: boxes, params: { workMax: ${WORK_MAX} } }); }
      catch (e) { err = String((e && e.message) || e); }
      URL.revokeObjectURL(url);
      return { ok: !!out, err: err, ms: Math.round(performance.now() - t0),
               W: img.naturalWidth, H: img.naturalHeight,
               boxes: out ? out.boxes : null, scale: out ? out.scale : null, lines: out ? out.lines : null };
    })()`;
    const res = await evalJs(cdp, expr, true);
    if (!res || res.__exception) {
      console.log(`  ${cs.label}: 页面异常 ${String(res && res.__exception).slice(0, 300)}`);
      results.push({ label: cs.label, image: cs.image, error: String(res && res.__exception) });
      continue;
    }
    console.log(`  ${cs.label}: ok=${res.ok} ${res.ms}ms scale=${res.scale} ${res.W}x${res.H} 行带=${res.lines}`);
    results.push({ label: cs.label, image: cs.image, raw: cs.raw, W: res.W, H: res.H,
                   scale: res.scale, ok: res.ok, err: res.err, boxes: res.boxes });
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1), "utf8");
  console.log("->", OUT);
  cdp.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error("脚本失败：", e.message || e); process.exit(1); });
