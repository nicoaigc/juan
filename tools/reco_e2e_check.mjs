/* 端到端验证 app/js/recognize.js 的真实链路。
 *
 * 为什么必须这样跑：免密钥大模型通道按**精确 Origin** 校验，本机 127.0.0.1 必被拒；
 * 所以这里打开**线上应用自己的页面**（Origin 天然正确），把本地那两个 js
 * （recognize-prompt.js / recognize.js）注入进去，再在页面上下文里造一个 File 对象
 * 走完整的 recognizePage —— canvas 画参考刻度、调模型、归一化，一步不落。
 *
 * 和 tools/recog_pilot.mjs 的区别：pilot 验的是"模型的能力"（自己拼提示词、不做归一化），
 * 这里验的是"应用的归一化 + 坐标外扩策略"（在页面里调 Recognize.normalizeRow 造出准备落库的行）。
 *
 * ⚠️ 本脚本**不写库**：只调 recognizePage，不建卷、不上传、不 addQuestions、不改状态。
 *    所以它验不了 RLS / 字段类型 / 状态流转 —— 那几项靠"云端表结构核对"（见 README）
 *    与用户首次真实上传覆盖。真正写库的编排在 recognize.js :: recognizePaper 里。
 *
 * 用法：
 *   node tools/reco_e2e_check.mjs --image data/benchmark/xxx.jpg [--tag e2e1]
 *                                [--cdp-port 9346] [--app https://...]
 * 依赖：本机 Chrome（先用 bash 常驻起一个带 --remote-debugging-port 的）。
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const IMAGE = opt("image", "data/benchmark/2026-10-01-第2单元练习卷-p1.jpg");
const PORT = Number(opt("cdp-port", "9346"));
const APP = opt("app", "https://shijuan-question-bank.app.workbuddy.host/");
const TAG = opt("tag", path.basename(IMAGE).replace(/\.[^.]+$/, "") + ".e2e");
const PROMPT_JS = opt("prompt-js", "app/js/recognize-prompt.js");
const RECO_JS = opt("reco-js", "app/js/recognize.js");
const REFINE_JS = opt("refine-js", "app/js/refine.js");
const OUTDIR = opt("out", ".workbuddy/tmp/recog_pilot");

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
  if (r.exceptionDetails) {
    return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r.result?.value;
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const imgBuf = fs.readFileSync(IMAGE);
  const ext = path.extname(IMAGE).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const b64 = imgBuf.toString("base64");
  const name = path.basename(IMAGE);

  const promptJs = fs.readFileSync(PROMPT_JS, "utf8");
  const recoJs = fs.readFileSync(RECO_JS, "utf8");

  let list = null;
  try { list = await httpJson("/json/list"); } catch { /* 下面报错 */ }
  if (!list || !list.some((t) => t.type === "page")) {
    throw new Error(`连不上 Chrome 的调试端口 ${PORT}；先在 bash 里起一个：
  "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \\
    --remote-debugging-port=${PORT} --user-data-dir=<某个临时目录> about:blank &`);
  }
  const page = list.find((t) => t.type === "page");
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  console.log(`打开线上应用（真实 Origin）：${APP}`);
  await cdp.send("Page.navigate", { url: APP });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await evalJs(cdp, `!!(window.CloudAPI && window.CloudAPI.cloud && window.CloudAPI.cloud.llm)`) === true;
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error("线上页面的 CloudAPI.cloud.llm 没就绪，检查应用是否还在线上");
  console.log(`   origin=${await evalJs(cdp, "location.origin")}  CloudAPI 就绪`);

  const inj1 = await evalJs(cdp, promptJs, false);
  if (inj1 && inj1.__exception) throw new Error("注入提示词失败：" + inj1.__exception);
  const inj2 = await evalJs(cdp, recoJs, false);
  if (inj2 && inj2.__exception) throw new Error("注入 recognize.js 失败：" + inj2.__exception);
  let refineOk = false;
  if (fs.existsSync(REFINE_JS)) {
    const refineJs = "(() => {" + fs.readFileSync(REFINE_JS, "utf8") + "})()";
    const inj3 = await evalJs(cdp, refineJs, false);
    if (inj3 && inj3.__exception) throw new Error("注入 refine.js 失败：" + inj3.__exception);
    refineOk = await evalJs(cdp, `!!(window.Refine && window.Refine.snap)`) === true;
  }
  const has = await evalJs(cdp, `!!(window.Recognize && window.Recognize.recognizePage && window.RECOGNIZE_PROMPT && window.RECOGNIZE_PROMPT.user)`);
  if (has !== true) throw new Error("注入后 window.Recognize / RECOGNIZE_PROMPT 不完整");
  console.log("   已注入 recognize.js + 提示词产物" + (refineOk ? " + refine.js（吸附开启）" : "（无 refine.js，走外扩兜底）"));

  console.log(`\n== 走一遍真实的 recognizePage（${name}, ${(imgBuf.length / 1024).toFixed(0)} KB）…`);
  const expr = `(async () => {
    const B64 = ${JSON.stringify(b64)};
    const bin = atob(B64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    const t0 = Date.now();
    try {
      const r = await window.Recognize.recognizePage({ file: file, model: ${JSON.stringify(opt("model", ""))} || undefined });
      const rows = r.questions.map((q, i) => window.Recognize.normalizeRow(q, {
        paperId: "pilot", seq: i + 1, filename: file.name, pageNo: 1, W: r.W, H: r.H,
      }));
      return { ok: true, W: r.W, H: r.H, ms: r.ms, credit: r.credit, finish: r.finish,
               rawCount: r.rawCount, count: r.questions.length, rows: rows,
               rawQuestions: r.questions,
               usage: r.usage ? { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens } : null };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e), ms: Date.now() - t0 };
    }
  })()`;

  const res = await evalJs(cdp, expr, true);
  const rawPath = path.join(OUTDIR, `${TAG}.raw.json`);
  fs.writeFileSync(rawPath, JSON.stringify(res, null, 1), "utf8");

  if (!res || res.__exception) {
    console.log("页面里抛异常：", String(res && res.__exception).slice(0, 1200));
  } else if (!res.ok) {
    console.log(`失败：${res.err}（${(res.ms / 1000).toFixed(1)}s）`);
  } else {
    console.log(`成功：${res.count} 题  ${(res.ms / 1000).toFixed(1)}s  credit=${res.credit}`);
    console.log(`usage: prompt ${res.usage?.prompt} / completion ${res.usage?.completion}  finish=${res.finish}`);
    console.log(`图片 ${res.W}×${res.H}`);
    const rowsPath = path.join(OUTDIR, `${TAG}.rows.json`);
    fs.writeFileSync(rowsPath, JSON.stringify({ W: res.W, H: res.H, rows: res.rows }, null, 1), "utf8");
    console.log("归一化后的行（本脚本未写库）->", rowsPath);
    for (const r of res.rows.slice(0, 6)) {
      const txt = (r.stem || []).filter((f) => f.t !== "figure").map((f) => f.v).join("");
      console.log(`  seq=${r.seq} qno=${r.qno} type=${r.qtype} bbox=${JSON.stringify(r.source.bbox)} ` +
                  `printed_no=${JSON.stringify(r.printed_no)}`);
      console.log(`      section=${JSON.stringify(r.section)}  stem=${txt.slice(0, 70).replace(/\n/g, " / ")}`);
    }
  }

  const failed = cdp.events.filter((e) => e.method === "Network.loadingFailed");
  const cerr = cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error");
  console.log(`\n网络失败 ${failed.length} / 控制台错误 ${cerr.length}`);
  for (const e of cerr.slice(0, 3)) console.log("  cerr:", JSON.stringify(e.params.args).slice(0, 240));
  console.log("原始结果 ->", rawPath);
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error("脚本失败：", e.message || e); process.exit(1); });
