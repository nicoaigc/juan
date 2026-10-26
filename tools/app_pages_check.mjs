/* 应用页面自检：把 app/ 下每个页面在**同款 CSP** 的本地服务器上打开一遍，看有没有
 * JS 异常、静态资源 404、CSP 违规，以及识别链路需要的全局对象到底在不在。
 *
 * 为什么不能只看截图：静态截图看不出 JS 报错、看不出某个 script 404、
 * 也看不出 CSP 把什么挡了 —— 而这些恰好是"改动引入"的典型故障。
 *
 * 前置：
 *   python tools/serve_with_csp.py --port 64911 --root app      （后台常驻）
 *   "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
 *     --remote-debugging-port=9346 --user-data-dir=<临时目录> about:blank &
 *
 * 用法：node tools/app_pages_check.mjs [--port 64911] [--cdp-port 9346]
 */
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
function opt(n, d) { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const PORT = Number(opt("port", "64911"));
const CDP_PORT = Number(opt("cdp-port", "9346"));
const BASE = `http://127.0.0.1:${PORT}`;

// 未登录时 auth 接口失败是预期的，不算问题；只看**静态资源**有没有挂
const STATIC_RE = /\.(js|css|png|jpg|jpeg|webp|woff2?|svg)(\?|$)/i;

const PAGES = [
  ["index.html", "首页（卷列表）"],
  ["upload.html", "上传页"],
  ["paper.html?id=__nope__", "卷详情"],
  ["question.html?id=__nope__", "题目详情"],
  ["customs.html", "我的组卷"],
  ["compose.html", "组卷页"],
  ["print.html?id=__nope__", "打印卷面（照片卷）"],
  ["print.html?custom=__nope__", "打印卷面（自建卷）"],
];

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

async function evalJs(cdp, expr, awaitPromise = false) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

async function main() {
  let list = null;
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    list = await r.json();
  } catch { /* 下面报错 */ }
  if (!list || !list.some((t) => t.type === "page")) throw new Error(`连不上 Chrome 的调试端口 ${CDP_PORT}`);
  const cdp = await CDP.connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");

  let bad = 0;
  for (const [p, label] of PAGES) {
    cdp.events.length = 0;
    const url = `${BASE}/${p}`;
    await cdp.send("Page.navigate", { url });
    await sleep(2600);

    const exceptions = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown")
      .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text || "?");
    const consoleErr = cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
      .map((e) => (e.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200));
    const logErr = cdp.events.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
      .map((e) => e.params.entry.text.slice(0, 200));
    const netFail = cdp.events.filter((e) => e.method === "Network.loadingFailed")
      .map((e) => ({ url: e.params?.requestId, err: e.params?.errorText }));

    // 只看静态资源：接口失败（未登录）是预期的
    const staticFail = [];
    const reqs = new Map();
    for (const e of cdp.events) {
      if (e.method === "Network.requestWillBeSent") reqs.set(e.params.requestId, e.params.request.url);
      if (e.method === "Network.loadingFailed") {
        const u = reqs.get(e.params.requestId) || "";
        if (STATIC_RE.test(u)) staticFail.push(`${u} -> ${e.params.errorText}`);
      }
    }

    const csp = [...consoleErr, ...logErr].filter((t) => /refused|blocked|violat/i.test(t));
    const globals = await evalJs(cdp,
      `JSON.stringify({ Recall: !!window.Recognize, Prompt: !!(window.RECOGNIZE_PROMPT && window.RECOGNIZE_PROMPT.user),
        CloudAPI: !!window.CloudAPI, UI: !!window.UI, Render: !!window.Render,
        Refine: !!(window.Refine && window.Refine.snap && window.Refine.snapFigures),
        Audit: !!(window.Recognize && window.Recognize.auditOne && window.Recognize.auditPaper),
        topbar: (document.getElementById('topbar')||{}).innerHTML ? (document.getElementById('topbar').innerHTML.length) : 0,
        scripts: [].map.call(document.scripts, s => s.src).filter(Boolean).length })`);
    const g = globals && globals !== undefined ? JSON.parse(globals) : {};

    const issues = [];
    if (exceptions.length) issues.push("JS 异常 " + exceptions.length + "：" + exceptions[0]);
    if (staticFail.length) issues.push("静态资源失败：" + staticFail.slice(0, 3).join(" | "));
    if (csp.length) issues.push("CSP 违规：" + csp.slice(0, 2).join(" | "));
    if (!g.CloudAPI || !g.UI || !g.Render) issues.push("全局对象缺失：" + JSON.stringify(g));
    // 会真跑识别的页面（upload / paper，带提示词产物）必须同时有 refine.js 的
    // snap + snapFigures；question.html 只借 recognize.js 的自检（auditOne），不需要 refine。
    if (g.Prompt && !g.Refine) issues.push("识别链路页面缺 Refine.snap/snapFigures");
    // 加载了 recognize.js 的页面（卷详情 / 题目详情）要有识别后自检的能力
    if (g.Recall && !g.Audit) issues.push("recognize.js 缺 auditOne/auditPaper（识别后自检）");

    const ok = issues.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✗"} ${label.padEnd(12)} ${p}`);
    console.log(`    Recognize=${g.Recall} Refine=${g.Refine} Audit=${g.Audit} Prompt=${g.Prompt} CloudAPI=${g.CloudAPI} 顶栏长度=${g.topbar} 脚本数=${g.scripts} ` +
                `（接口类失败 ${netFail.length} 条，未登录时预期）`);
    for (const s of issues) console.log("    ! " + s);
  }

  console.log(bad ? `\n✗ ${bad} 个页面有问题` : "\n✓ 全部页面通过（无 JS 异常 / 无静态资源 404 / 无 CSP 违规）");
  cdp.close();
  return bad ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("脚本失败：", e.message || e); process.exit(1); });
