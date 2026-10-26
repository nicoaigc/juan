/* 把 app/js/recognize.js 里那个 canvas 版"参考刻度图"导出来看一眼。
 *
 * 为什么单独验它：刻度图是模型读坐标的唯一依据 —— 网格画歪了、数字标错系了，
 * 模型给出来的坐标就整片偏。Python 版（tools/make_ruler_image.py）已经目视核对过，
 * 但前端这份是 canvas 重写的，字号/描边/对齐都可能不同，必须亲眼看过。
 *
 * 用法：node tools/dump_ruler_canvas.mjs --image data/benchmark/xxx.jpg
 * 前置：本地服务器（同源才能读 blob 图片不需要 CORS）+ 带调试端口的 Chrome。
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(n, d) { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const IMAGE = opt("image", "data/benchmark/2026-10-01-第2单元练习卷-p1.jpg");
const PAGE = opt("page", "http://127.0.0.1:64911/upload.html");
const CDP_PORT = Number(opt("cdp-port", "9346"));
const OUT = opt("out", ".workbuddy/tmp/recog_pilot/ruler_canvas.jpg");

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

async function main() {
  const b64 = fs.readFileSync(IMAGE).toString("base64");
  const ext = path.extname(IMAGE).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const recoJs = fs.readFileSync("app/js/recognize.js", "utf8");

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const cdp = await CDP.connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await cdp.send("Page.navigate", { url: PAGE });
  await new Promise((r) => setTimeout(r, 2200));
  const inj = await cdp.send("Runtime.evaluate", { expression: recoJs, returnByValue: true });
  if (inj.exceptionDetails) throw new Error("注入失败：" + (inj.exceptionDetails.exception?.description || ""));

  const expr = `(async () => {
    const B64 = ${JSON.stringify(b64)};
    const bin = atob(B64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new File([u8], "x.jpg", { type: ${JSON.stringify(mime)} }));
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => rej(new Error("图片加载失败"));
      im.src = url;
    });
    const b = window.Recognize.buildRulerCanvas(img);
    const dataUrl = b.canvas.toDataURL("image/jpeg", 0.88);
    return { dataUrl, W: b.W, H: b.H, scale: b.scale, sentW: b.sentW, sentH: b.sentH };
  })()`;
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("画布失败：" + (r.exceptionDetails.exception?.description || ""));
  const v = r.result.value;

  const out = path.resolve(OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(v.dataUrl.split(",")[1], "base64"));
  console.log(`原图 ${v.W}×${v.H}  scale=${v.scale.toFixed(4)}  送给画布 ${v.sentW}×${v.sentH}`);
  console.log("刻度图 ->", out, `(${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error("失败：", e.message || e); process.exit(1); });
