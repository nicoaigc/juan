/* 一次性诊断脚本：在真实 Chromium 里以手机 UA 打开线上应用，调用 signInWithOAuth，
   拿到 SDK 实际返回的跳转 URL / 错误，并截图微信那一步的页面。
   用法：node tools/probe_wechat_login.mjs [--cdp-port 9333] [--app <url>]
   依赖：本机 Chrome + node 22（内置 WebSocket / fetch）。*/
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = Number(opt("cdp-port", "9333"));
const APP = opt("app", "https://shijuan-question-bank.app.workbuddy.host/");
const UA_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_WECHAT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003129) NetType/WIFI Language/zh_CN";
const UA_DESK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const UA = { safari: UA_SAFARI, wechat: UA_WECHAT, desktop: UA_DESK }[opt("ua", "safari")] || UA_SAFARI;

async function httpJson(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

/* 极简 CDP 客户端 */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws error")); });
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
    expression: expr, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r.result?.value;
}

async function main() {
  const list = await httpJson("/json/list");
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用的 page target");
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: UA, platform: "iPhone", acceptLanguage: "zh-CN,zh;q=0.9",
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  console.log("== 1) 打开线上应用（手机 UA）");
  await cdp.send("Page.navigate", { url: APP });
  await sleep(6000);

  const inlineEval = opt("eval", "");
  if (inlineEval) {
    console.log(await evalJs(cdp, inlineEval));
    cdp.close();
    return;
  }

  const boot = await evalJs(cdp, `JSON.stringify({
    hasSDK: !!window.WorkBuddyCloud,
    hasCloudAPI: !!window.CloudAPI,
    hasOauthRelay: !!(window.PUBLIC_CONFIG && window.PUBLIC_CONFIG.oauthRelayBaseUrl),
    origin: location.origin,
    katexNodes: document.querySelectorAll('.katex').length,
    loginCard: !!document.getElementById('lg-wx'),
    bodyText: (document.body.innerText || '').slice(0, 200)
  })`);
  console.log(boot);

  console.log("\n== 2) 调用 signInWithOAuth({provider:'wechat'})");
  const res = await evalJs(cdp, `(async () => {
    if (!window.CloudAPI || !window.CloudAPI.cloud) return JSON.stringify({err:'no CloudAPI'});
    try {
      const r = await window.CloudAPI.cloud.auth.signInWithOAuth({
        provider: 'wechat', redirectTo: location.origin,
      });
      return JSON.stringify({
        error: r.error ? { message: r.error.message, kind: r.error.kind, code: r.error.code, status: r.error.status } : null,
        data: r.data || null,
      });
    } catch (e) {
      return JSON.stringify({ thrown: String(e && e.message || e) });
    }
  })()`);
  console.log(res);

  let target = "";
  try {
    const parsed = JSON.parse(res);
    target = (parsed.data && (parsed.data.url || parsed.data.redirectUrl)) || "";
  } catch {}

  if (target && !args.includes("--app-only")) {
    console.log("\n== 3) 微信授权页实际 URL");
    console.log(target);
    await cdp.send("Page.navigate", { url: target });
    await sleep(7000);
    const page2 = await evalJs(cdp, `JSON.stringify({
      url: location.href.slice(0, 300),
      title: document.title,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500)
    })`);
    console.log(page2);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const fs = await import("node:fs");
    const out = opt("shot", "data/samples/_wx_mobile.png");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("截图 ->", out);
  } else {
    console.log("\n（SDK 没有返回 URL，跳过第 3 步）");
  }

  if (args.includes("--app-only") && opt("shot", "")) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const fs = await import("node:fs");
    const out = opt("shot");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("截图 ->", out);
  }

  const bad = cdp.events.filter((e) =>
    (e.method === "Network.loadingFailed" && e.params.errorText !== "net::ERR_ABORTED") ||
    (e.method === "Runtime.consoleAPICalled" && (e.params.type === "error" || e.params.type === "warning"))
  );
  console.log("\n== 4) 网络失败 / 控制台错误 =", bad.length);
  for (const b of bad.slice(0, 12)) {
    console.log("  -", b.method, JSON.stringify(b.params).slice(0, 300));
  }
  cdp.close();
}

main().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
