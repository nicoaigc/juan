/* 自动识别试点：把一页试卷照片送进云服务免密钥大模型，看它识别的质量。
 *
 * 为什么要在浏览器里跑：云服务的免密钥通道按 **精确 Origin** 校验，
 * 本机 127.0.0.1 一定被拒；而技能规范**禁止**手写 /.cloud/llm 请求或自己拼 fetch。
 * 所以这里的做法是：用 CDP 打开**线上应用自己的页面**（Origin 天然正确、
 * window.CloudAPI.cloud 已经初始化好），再在那个页面的上下文里调 SDK。
 *
 * 用法：
 *   node tools/recog_pilot.mjs --image data/benchmark/xxx.jpg [--model deepseek-v4.1-flash]
 *                              [--cdp-port 9345] [--app <url>] [--tag pilot1]
 * 依赖：本机 Chrome + node 22（内置 WebSocket / fetch）。 */
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const IMAGE = opt("image", "data/benchmark/2026-09-30-选择与应用题.jpg");
const SEND = opt("send", "");          // 实际送给模型的图（默认 = IMAGE）；给带刻度图时用这个
const MODEL = opt("model", "deepseek-v4.1-flash");
const PORT = Number(opt("cdp-port", "9345"));
const APP = opt("app", "https://shijuan-question-bank.app.workbuddy.host/");
const TAG = opt("tag", path.basename(IMAGE).replace(/\.[^.]+$/, ""));
const OUTDIR = opt("out", ".workbuddy/tmp/recog_pilot");
const PROMPT_MD = opt("prompt", "prompts/auto-recognize-prompt.md");

/* ---------- 从提示词正本里抽出 SYSTEM / USER 两个代码块（避免两处维护） ---------- */
function extractPrompt(mdPath) {
  const md = fs.readFileSync(mdPath, "utf8");
  function blockAfter(heading) {
    const i = md.indexOf(heading);
    if (i < 0) throw new Error("提示词文件里找不到：" + heading);
    const fence = md.indexOf("```", i);
    if (fence < 0) throw new Error(heading + " 后面没有代码块");
    const body = md.indexOf("\n", fence);
    const end = md.indexOf("```", body);
    if (end < 0) throw new Error(heading + " 的代码块没有闭合");
    return md.slice(body + 1, end).replace(/\s+$/, "");
  }
  return {
    system: blockAfter("### SYSTEM"),
    user: blockAfter("### USER"),
  };
}

async function httpJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

/* ---------- 极简 CDP 客户端（与 tools/probe_wechat_login.mjs 同款） ---------- */
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
      } else if (m.method) {
        c.events.push(m);
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
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr, awaitPromise, returnByValue: true,
  });
  if (r.exceptionDetails) {
    return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r.result?.value;
}

function findChrome() {
  const cands = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  throw new Error("找不到 Chrome");
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const imgBuf = fs.readFileSync(SEND || IMAGE);
  const ext = path.extname(SEND || IMAGE).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const b64 = imgBuf.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;

  // 坐标基准永远是**原图**尺寸（带刻度图上标的也是原图坐标）
  const dim = JSON.parse(fs.readFileSync("data/benchmark/_sizes.json", "utf8"));
  const meta = dim[path.basename(IMAGE)];
  if (!meta) throw new Error("_sizes.json 里没有这张图的尺寸：" + path.basename(IMAGE));
  const W = meta.w, H = meta.h;

  const prompt = extractPrompt(PROMPT_MD);
  const userMsg = prompt.user.replace(/\{W\}/g, String(W)).replace(/\{H\}/g, String(H));

  console.log(`原图      ${IMAGE}  (${W}×${H})`);
  console.log(`实发      ${SEND || IMAGE}  (${(imgBuf.length / 1024).toFixed(0)} KB, base64 ${(b64.length / 1024).toFixed(0)} KB)`);
  console.log(`模型      ${MODEL}`);
  console.log(`提示词    system ${prompt.system.length} 字 / user ${userMsg.length} 字`);

  // ---------- 接上 Chrome ----------
  // 优先复用已经在跑的（本机从 Node 里 spawn 有时起不来，直接用现成的更稳）：
  //   "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  //     --remote-debugging-port=9346 --user-data-dir=... about:blank &
  let chrome = null;
  let list = null;
  try {
    list = await httpJson("/json/list");
    if (list.some((t) => t.type === "page")) console.log("   （复用已在运行的 Chrome）");
    else list = null;
  } catch { list = null; }

  if (!list) {
    const profile = path.join(OUTDIR, "chrome-profile");
    chrome = spawn(findChrome(), [
      "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--disable-features=Translate", "about:blank",
    ], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
      try { list = await httpJson("/json/list"); if (list.some((t) => t.type === "page")) break; } catch {}
      await sleep(400);
    }
  }
  if (!list) throw new Error(`连不上 Chrome 的调试端口 ${PORT}（先在 bash 里手动起一个，再带 --cdp-port 跑本脚本）`);
  const page = list.find((t) => t.type === "page");
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  console.log(`\n== 打开线上应用（真实 Origin）：${APP}`);
  await cdp.send("Page.navigate", { url: APP });

  // 等 SDK 初始化完
  let ready = null;
  for (let i = 0; i < 40; i++) {
    ready = await evalJs(cdp, `!!(window.CloudAPI && window.CloudAPI.cloud && window.CloudAPI.cloud.llm)`);
    if (ready === true) break;
    await sleep(500);
  }
  console.log(`   CloudAPI.cloud.llm 就绪：${ready}`);

  console.log(`   page origin        ：${await evalJs(cdp, "location.origin")}`);

  // ---------- 在页面上下文里调模型 ----------
  const expr = `(async () => {
    const cloud = window.CloudAPI.cloud;
    const DATA_URL = ${JSON.stringify(dataUrl)};
    const SYS = ${JSON.stringify(prompt.system)};
    const USR = ${JSON.stringify(userMsg)};
    const messages = [
      { role: "system", content: SYS },
      { role: "user", content: [
        { type: "text", text: USR },
        { type: "image_url", image_url: { url: DATA_URL } },
      ] },
    ];
    let content = "", usage = null, finish = null;
    const t0 = Date.now();
    try {
      for await (const chunk of cloud.llm.chat.completions.create({
        model: ${JSON.stringify(MODEL)},
        messages: messages,
        stream: true,
        stream_options: { include_usage: true },
        response_format: { type: "json_object" },
      })) {
        const c0 = chunk.choices && chunk.choices[0];
        const d = c0 && c0.delta;
        if (d && d.content) content += d.content;
        if (c0 && c0.finish_reason) finish = c0.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
      return { ok: true, content: content, usage: usage, finish: finish, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, err: String((e && e.error) ? JSON.stringify(e.error) : (e && e.message) || e),
               code: e && e.error && e.error.code, requestId: e && e.requestId, ms: Date.now() - t0 };
    }
  })()`;

  console.log("\n== 调用模型（流式，等它跑完）…");
  const res = await evalJs(cdp, expr, true);

  console.log("\n---- 结果 ----");
  if (res && res.__exception) {
    console.log("页面里抛异常：", String(res.__exception).slice(0, 1200));
  } else if (res && res.ok) {
    console.log(`耗时 ${(res.ms / 1000).toFixed(1)}s  finish=${res.finish}`);
    console.log("usage:", JSON.stringify(res.usage));
    console.log(`返回正文 ${res.content.length} 字`);
  } else if (res) {
    console.log(`失败 code=${res.code} requestId=${res.requestId} 耗时 ${(res.ms / 1000).toFixed(0)}ms`);
    console.log("错误：", String(res.err).slice(0, 1200));
  } else {
    console.log("没有拿到结果：", JSON.stringify(res));
  }

  const rawPath = path.join(OUTDIR, `${TAG}.raw.json`);
  fs.writeFileSync(rawPath, JSON.stringify(res, null, 2), "utf8");
  console.log("原始结果已存：", rawPath);

  // 试着解析出 JSON
  if (res && res.ok && res.content) {
    let parsed = null, perr = null;
    try {
      let t = res.content.trim();
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      if (a >= 0 && b > a) t = t.slice(a, b + 1);
      parsed = JSON.parse(t);
    } catch (e) { perr = String(e.message); }
    if (parsed) {
      const p = path.join(OUTDIR, `${TAG}.parsed.json`);
      fs.writeFileSync(p, JSON.stringify(parsed, null, 2), "utf8");
      const qs = parsed.questions || [];
      console.log(`\n解析成功：${qs.length} 道题 -> ${p}`);
      for (const q of qs) {
        const txt = (q.stem || []).filter((f) => f.t !== "figure").map((f) => f.v).join("");
        const figs = (q.stem || []).filter((f) => f.t === "figure").length;
        console.log(`  no=${q.no} ${q.type} printed_no=${JSON.stringify(q.printed_no)} bbox=${JSON.stringify(q.bbox)} fig=${figs} opt=${(q.options || []).length}`);
        console.log(`      section=${JSON.stringify(q.section)}`);
        console.log(`      stem=${txt.slice(0, 110).replace(/\n/g, " / ")}`);
        for (const f of (q.stem || []).filter((x) => x.t === "figure")) {
          console.log(`      FIG bbox=${JSON.stringify(f.bbox)} caption=${String(f.caption || "").slice(0, 60)}`);
        }
      }
    } else {
      console.log("\n正文不是合法 JSON：", perr);
      console.log(res.content.slice(0, 800));
    }
  }

  // 网络与控制台异常
  const failed = cdp.events.filter((e) => e.method === "Network.loadingFailed");
  const consoleErr = cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error");
  console.log(`\n网络失败 ${failed.length} 条 / 控制台错误 ${consoleErr.length} 条`);
  for (const e of failed.slice(0, 5)) console.log("  fail:", JSON.stringify(e.params).slice(0, 300));
  for (const e of consoleErr.slice(0, 5)) console.log("  cerr:", JSON.stringify(e.params.args).slice(0, 300));

  cdp.close();
  try { if (chrome) chrome.kill(); } catch {}
}

main().then(() => process.exit(0)).catch((e) => { console.error("脚本失败：", e); process.exit(1); });
