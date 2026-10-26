/* 识别次数 + 登录方式自检（2026-10-26 加）
 *
 * 钉住四件事：
 *   ① 本地默认不限（顶栏「识别不限」、上传页无提示）；
 *   ② ?limit=2 会记住并跨页面生效，上传页显示「2 / 2」；
 *   ③ 用完之后第 3 次直接拒绝，**删卷也不返还**，上传按钮被按住；
 *   ④ 生产域名只渲染微信登录（.wxonly + 手机号表单隐藏），本地仍保留手机号表单。
 *
 * 前置：python tools/serve_with_csp.py --port 64911 --root app（后台常驻）
 * 用法：node tools/limit_check.mjs
 *
 * ④ 靠 --host-resolver-rules 把 prod.test 指到 127.0.0.1：hostname 不是 localhost，
 *   和真实发布域名的判定一致，但请求不出本机。
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:64911";
const PROD = "http://prod.test:64911";
const CDP_PORT = 9351;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REPO = "github.com/nicoaigc/juan";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "limit-check-"))}`,
  "--host-resolver-rules=MAP prod.test 127.0.0.1",
  "about:blank",
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

async function evalJs(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

async function waitFor(cdp, expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(cdp, expr)) return true; } catch { /* 页面还在跳 */ }
    await sleep(120);
  }
  return false;
}

async function go(cdp, url, readyExpr) {
  await cdp.send("Page.navigate", { url });
  await sleep(300);
  const ok = await waitFor(cdp, readyExpr);
  if (!ok) throw new Error("页面没就绪：" + url);
}

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
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log("PASS  " + name); }
  else { fail += 1; console.log("FAIL  " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

const TQ = "document.getElementById('tb-quota') && document.getElementById('tb-quota').textContent.trim()";

try {
  // ---------- ① 默认不限 ----------
  await go(cdp, BASE + "/index.html", "!!document.getElementById('page') && document.getElementById('page').style.display !== 'none'");
  await waitFor(cdp, `${TQ}.indexOf('识别') >= 0`);
  check("①-1 本地默认不限：顶栏写「识别不限」", (await evalJs(cdp, TQ)) === "识别不限", await evalJs(cdp, TQ));

  await go(cdp, BASE + "/upload.html", "!!document.getElementById('go')");
  await sleep(500);
  check("①-2 上传页不出现次数提示", await evalJs(cdp,
    "getComputedStyle(document.getElementById('quota-note')).display === 'none'"));
  check("①-3 consumeRecognition 在不限模式下直接成功", await evalJs(cdp,
    "CloudAPI.consumeRecognition().then(function(s){return s.quota === null})"));

  // ---------- ② ?limit=2 ----------
  await go(cdp, BASE + "/index.html?limit=2", "!!document.getElementById('tb-quota')");
  await waitFor(cdp, `${TQ}.indexOf('2 次') >= 0`);
  check("②-1 带 ?limit=2 顶栏显示「还可识别 2 次」", (await evalJs(cdp, TQ)) === "还可识别 2 次", await evalJs(cdp, TQ));

  // 参数不跟着跳转走，靠 localStorage 记住
  await go(cdp, BASE + "/upload.html", "!!document.getElementById('go')");
  await sleep(600);
  check("②-2 换到上传页（不带参数）仍受限", (await evalJs(cdp, TQ)) === "还可识别 2 次", await evalJs(cdp, TQ));
  check("②-3 上传页提示含 2 / 2", /2\s*\/\s*2/.test(await evalJs(cdp,
    "document.getElementById('quota-note').textContent")), await evalJs(cdp,
    "document.getElementById('quota-note').textContent"));

  // ---------- ③ 用完 + 删卷不返还 ----------
  check("③-1 第 1 次扣成功", await evalJs(cdp, "CloudAPI.consumeRecognition().then(function(s){return s.remain})") === 1);
  check("③-2 第 2 次扣成功", await evalJs(cdp, "CloudAPI.consumeRecognition().then(function(s){return s.remain})") === 0);
  const third = await evalJs(cdp,
    "CloudAPI.consumeRecognition().then(function(){return 'ok'}).catch(function(e){return e.message})");
  check("③-3 第 3 次被拒且提示已用完", /已用完/.test(String(third)), third);
  check("③-4 拒绝信息带 GitHub 地址", String(third).indexOf(REPO) >= 0, third);
  check("③-5 本地计数落盘 used=2", await evalJs(cdp,
    "JSON.parse(localStorage.getItem('sj-demo-quota') || '{}').used") === 2);

  // 删掉全部试卷再查：次数不返还
  const before = await evalJs(cdp, "CloudAPI.listPapers().then(function(l){return l.length})");
  check("③-6 演示库里有试卷可删（前置）", before > 0, before);
  await evalJs(cdp, `CloudAPI.listPapers().then(function(l){
      return Promise.all(l.map(function(p){ return CloudAPI.deletePaper(p.id); }));
    }).then(function(){ return true; })`);
  const after = await evalJs(cdp, "CloudAPI.listPapers().then(function(l){return l.length})");
  check("③-7 试卷已全部删除", after === 0, after);
  check("③-8 删卷后计数仍是 used=2", await evalJs(cdp,
    "JSON.parse(localStorage.getItem('sj-demo-quota') || '{}').used") === 2);
  check("③-9 删卷后仍拒绝第 3 次", await evalJs(cdp,
    "CloudAPI.consumeRecognition().then(function(){return 'ok'}).catch(function(){return 'denied'})") === "denied");

  // 用完的上传页：按钮按住 + 引导去部署
  await go(cdp, BASE + "/upload.html", "!!document.getElementById('go')");
  await sleep(700);
  check("③-10 上传页显示「已用完」并给 GitHub 出口", await evalJs(cdp,
    "document.getElementById('quota-note').className.indexOf('out') >= 0 && document.getElementById('quota-note').innerHTML.indexOf('github.com/nicoaigc/juan') >= 0"));
  check("③-11 用完时「创建并上传」是禁用态", await evalJs(cdp,
    "document.getElementById('go').disabled === true"));

  // ---------- ④ ?limit=0 关闭 ----------
  await go(cdp, BASE + "/index.html?limit=0", "!!document.getElementById('tb-quota')");
  await waitFor(cdp, `${TQ}.indexOf('识别') >= 0`);
  check("④-1 ?limit=0 恢复不限", (await evalJs(cdp, TQ)) === "识别不限", await evalJs(cdp, TQ));
  check("④-2 关闭限制后旧计数不再生效", await evalJs(cdp,
    "CloudAPI.consumeRecognition().then(function(s){return s.quota === null})"));

  // ---------- ⑤ 生产只允许微信 ----------
  await go(cdp, PROD + "/index.html", "!!document.querySelector('.auth-card')");
  check("⑤-1 生产域名登录卡带 .wxonly", await evalJs(cdp,
    "!!document.querySelector('.auth-card.wxonly')"));
  check("⑤-2 手机号表单被隐藏", await evalJs(cdp,
    "getComputedStyle(document.getElementById('lg-form')).display === 'none'"));
  check("⑤-3 微信按钮是整行主按钮并带文字", await evalJs(cdp,
    "(function(){var b=document.getElementById('lg-wx');var t=b.querySelector('.wx-txt');return Math.round(b.getBoundingClientRect().width) >= 260 && getComputedStyle(t).display !== 'none';})()"));
  check("⑤-4 副标题提示用微信", /微信/.test(await evalJs(cdp,
    "document.getElementById('lg-sub').textContent")), await evalJs(cdp, "document.getElementById('lg-sub').textContent"));
  check("⑤-5 登录卡里有 GitHub 图标入口", await evalJs(cdp,
    "!!document.querySelector('.repo-line a.repo-gh[href*=\"github.com/nicoaigc/juan\"] svg')"));
  check("⑤-5b 登录卡不直接显示地址文本", await evalJs(cdp,
    "(function(){var t=document.querySelector('.repo-line').textContent;return t.indexOf('github.com') < 0;})()"),
    await evalJs(cdp, "document.querySelector('.repo-line').textContent"));

  // 本地 ?demo=0：退回真实登录链路，仍然是「手机号 + 圆形微信图标」
  await go(cdp, BASE + "/index.html?demo=0", "!!document.querySelector('.auth-card')");
  check("⑤-6 本地不加 .wxonly", await evalJs(cdp, "!document.querySelector('.auth-card.wxonly')"));
  check("⑤-7 本地手机号表单可见", await evalJs(cdp,
    "getComputedStyle(document.getElementById('lg-form')).display !== 'none'"));
  check("⑤-8 本地微信仍是圆形图标（无文字）", await evalJs(cdp,
    "getComputedStyle(document.querySelector('#lg-wx .wx-txt')).display === 'none'"));

  // ---------- ⑥ 首页页脚 ----------
  await go(cdp, BASE + "/index.html", "!!document.querySelector('.repo-line a')");
  check("⑥-1 首页页脚有 GitHub 图标入口", await evalJs(cdp,
    "!!document.querySelector('.repo-line a.repo-gh[href*=\"github.com/nicoaigc/juan\"] svg')"));
  check("⑥-2 首页页脚不直接显示地址文本", await evalJs(cdp,
    "(function(){var t=document.querySelector('.repo-line').textContent;return t.indexOf('github.com') < 0;})()"),
    await evalJs(cdp, "document.querySelector('.repo-line').textContent"));
} catch (e) {
  fail += 1;
  console.log("FAIL  自检中断：" + (e && e.message ? e.message : e));
} finally {
  console.log("\n" + pass + "/" + (pass + fail) + " 通过");
  try { await cdp.send("Page.close"); } catch { /* 忽略 */ }
  chrome.kill();
  process.exit(fail ? 1 : 0);
}
