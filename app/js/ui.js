/* 页面外壳：顶栏、登录卡、登录守卫、原图地址预取、灯箱。
   另含三个自绘 UI 组件（select / confirm / datePicker），全站替代原生控件。
   每个页面都引它，别在页面里重复实现。 */
(function () {
  "use strict";

  /* 环境判定：本地（含演示模式）保留手机号验证码登录，生产只开微信扫码。
     口径按 hostname，和 local-demo.js 的激活条件一致 —— 换成本机访问就自动放开，
     不需要额外开关，也不怕把调试入口带上线。 */
  var LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  var WECHAT_ONLY = !LOCAL_HOST;
  var REPO_URL = "https://github.com/nicoaigc/juan";
  /* 源仓库入口只用 GitHub 的 mark 图标，不把 URL 印在页面上；地址放进 title / aria-label，
     鼠标悬停能看到、读屏也念得出来。 */
  var ICON_GH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.55v-1.94c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"/></svg>';

  // ------------------------------------------------------------- 自定义下拉
  /* 替代 <select>：原生下拉的弹出层是操作系统控件，样式改不了、各端长相还不一样。
     host 会被**就地替换**成自绘组件；键盘用户可 Tab 聚焦按钮、Esc 收起。
     items: [{value, label, tag?, desc?}]；返回 {el, get, set}。 */
  function select(host, items, opts) {
    opts = opts || {};
    var esc = Render.esc;
    var value = opts.value != null ? opts.value : (items[0] ? items[0].value : "");
    var onChange = opts.onChange || function () {};
    var CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>';
    var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';

    var root = document.createElement("div");
    root.className = "dd" + (opts.small ? " sm" : "");
    root.innerHTML =
      '<button type="button" class="dd-btn"' + (opts.title ? ' title="' + esc(opts.title) + '"' : "")
      + ' aria-haspopup="listbox"><span class="dd-lab"></span><span class="dd-ic">' + CARET + "</span></button>"
      + '<div class="dd-pop" role="listbox" hidden>'
      + items.map(function (it, i) {
          return '<button type="button" class="dd-it" role="option" data-i="' + i + '">'
            + '<span class="dd-txt"><span class="dd-name">' + esc(it.label)
            + (it.tag ? '<i class="dd-tag">' + esc(it.tag) + "</i>" : "")
            + "</span>"
            /* small（说明行）必须在 .dd-name 之外、.dd-txt 之内：进了 .dd-name 会被
               flex 挤到名称右边而不是独占一行 */
            + (it.desc ? "<small>" + esc(it.desc) + "</small>" : "")
            + "</span>"
            + '<span class="dd-ck">' + CHECK + "</span></button>";
        }).join("")
      + "</div>";
    if (host && host.parentNode) {
      /* 占位元素上的内联样式（如卷详情页工具栏的 max-width）要跟过来，
         否则 .dd 的 width:100% 会把下拉撑满整行 */
      var st = host.getAttribute("style");
      if (st) root.setAttribute("style", st);
      /* 显式要求时把 id 也带过去（调用方 / 自检脚本按占位 id 找组件节点）。
         默认不带：像 recognize.js 的 f-model 占位是原生 <select>，
         让 id 跑到 .dd 上会改变 getElementById("f-model") 的返回值。 */
      if (opts.keepId && host.id) root.id = host.id;
      host.parentNode.replaceChild(root, host);
    }

    var btn = root.querySelector(".dd-btn"), lab = root.querySelector(".dd-lab"), pop = root.querySelector(".dd-pop");

    function paint() {
      var cur = null;
      items.forEach(function (it) { if (it.value === value) cur = it; });
      lab.textContent = cur ? cur.label : (items[0] ? items[0].label : "");
      [].forEach.call(pop.querySelectorAll(".dd-it"), function (el) {
        el.classList.toggle("on", items[Number(el.dataset.i)].value === value);
      });
    }
    function close() {
      pop.hidden = true;
      root.classList.remove("open");
      if (root._onDoc) { document.removeEventListener("pointerdown", root._onDoc); root._onDoc = null; }
    }
    function open() {
      pop.hidden = false;
      root.classList.add("open");
      /* 弹层 280px 宽；贴近视口右缘时改成右对齐，免得被裁掉 */
      pop.classList.toggle("flip", root.getBoundingClientRect().left + 292 > window.innerWidth);
      var onDoc = function (e) { if (!root.contains(e.target)) close(); };
      setTimeout(function () { document.addEventListener("pointerdown", onDoc); }, 0);
      root._onDoc = onDoc;
    }
    btn.addEventListener("click", function () { pop.hidden ? open() : close(); });
    pop.addEventListener("click", function (e) {
      var el = e.target.closest(".dd-it");
      if (!el) return;
      value = items[Number(el.dataset.i)].value;
      paint(); close(); onChange(value);
    });
    paint();
    return { el: root, get: function () { return value; }, set: function (v) { value = v; paint(); } };
  }

  // ------------------------------------------------------------- 确认框 / 多分支选择框
  /* 替代 window.confirm：原生对话框样式改不了，也承载不了"后果说明"这类细节文案。
     choose = 通用版（2 个以上按钮），confirm 是它的"是/否"简写，两者共用同一个弹层实现。
     opts: {title, text, buttons:[{key,label,primary,danger}]}
     返回 Promise<key|null>：点了某按钮 -> 它的 key；取消 / 点遮罩 / Esc -> null。
     按钮样式：primary 用实心（不传则描边 sec）、danger 追加 danger-solid（红）。主按钮放最后。
     text 支持 \n 换行（转义后才替换，不会引入注入面）—— 后果说明经常要分条列。 */
  function choose(opt) {
    opt = opt || {};
    var btns = (opt.buttons || []).slice();
    return new Promise(function (resolve) {
      var foot = '<button type="button" class="btn sec" data-no>取消</button>';
      btns.forEach(function (b) {
        foot += '<button type="button" class="btn' + (b.primary ? "" : " sec")
          + (b.danger ? " danger-solid" : "") + '" data-k="' + Render.esc(b.key) + '">'
          + Render.esc(b.label || "确定") + "</button>";
      });
      var mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">'
        + '<div class="m-t">' + Render.esc(opt.title || "请确认") + "</div>"
        + '<div class="m-b">' + Render.esc(opt.text || "").replace(/\n/g, "<br>") + "</div>"
        + '<div class="m-f">' + foot + "</div></div>";
      document.body.appendChild(mask);
      function done(v) {
        document.removeEventListener("keydown", onKey);
        mask.remove();
        resolve(v);
      }
      function onKey(e) { if (e.key === "Escape") done(null); }
      mask.addEventListener("click", function (e) {
        if (e.target === mask) return done(null);
        if (e.target.closest("[data-no]")) return done(null);
        var k = e.target.closest("[data-k]");
        if (k) return done(k.dataset.k);
      });
      document.addEventListener("keydown", onKey);
      setTimeout(function () {
        var all = mask.querySelectorAll(".m-f .btn");
        var b = all[all.length - 1];      // 主按钮约定放最后
        if (b) b.focus();
      }, 0);
    });
  }

  function confirm(opt) {
    opt = opt || {};
    return choose({
      title: opt.title, text: opt.text,
      buttons: [{ key: "ok", label: opt.okText || "确定", primary: true, danger: !!opt.danger }],
    }).then(function (k) { return k === "ok"; });
  }

  // ------------------------------------------------------------- 日历
  /* 替代 <input type="date">：原生日期控件的弹层是系统控件（各端长相不一，电脑上还
     跟着浏览器走）。把一个文本框升级成日历选择器：框设为只读、点击弹自绘日历；
     input.value 始终是 YYYY-MM-DD，页面取值逻辑零改动。周一开头。 */
  function datePicker(input) {
    if (!input || input._cal) return;
    input._cal = true;
    input.readOnly = true;
    input.autocomplete = "off";
    input.classList.add("date-input");
    var pop = null, unbind = null;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function close() {
      if (pop) { pop.remove(); pop = null; }
      if (unbind) { unbind(); unbind = null; }
    }
    function picked() {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value || "");
      return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
    }
    function set(y, m, d) {
      input.value = y + "-" + pad(m + 1) + "-" + pad(d);
      close();
      try { input.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* 老浏览器无所谓 */ }
    }
    function paint(y, m) {
      var now = new Date();
      var sel = picked();
      var lead = (new Date(y, m, 1).getDay() + 6) % 7;   // 周一开头
      var days = new Date(y, m + 1, 0).getDate();
      var cells = "", d;
      for (var i = 0; i < lead; i++) cells += "<i></i>";
      for (d = 1; d <= days; d++) {
        cells += '<button type="button" data-d="' + d + '"'
          + (sel && sel.y === y && sel.m === m && sel.d === d ? ' class="sel"' : "")
          + (y === now.getFullYear() && m === now.getMonth() && d === now.getDate() ? ' data-today="1"' : "")
          + ">" + d + "</button>";
      }
      var CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6l-6 6 6 6"/></svg>';
      var CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></svg>';
      pop.innerHTML =
        '<div class="cal-h"><button type="button" data-nav="-1" aria-label="上个月">' + CHEV_L + "</button>"
        + "<b>" + y + " 年 " + (m + 1) + " 月</b>"
        + '<button type="button" data-nav="1" aria-label="下个月">' + CHEV_R + "</button></div>"
        + '<div class="cal-w"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>'
        + '<div class="cal-g">' + cells + "</div>";
    }
    function open() {
      close();
      var now = new Date(), v = picked();
      var y = v ? v.y : now.getFullYear(), m = v ? v.m : now.getMonth();
      pop = document.createElement("div");
      pop.className = "cal";
      document.body.appendChild(pop);
      paint(y, m);
      /* 先量后摆：默认弹在框下面，底下放不下且上面够放就往上弹；左右夹在视口内 */
      var r = input.getBoundingClientRect();
      var w = pop.offsetWidth, h = pop.offsetHeight;
      var top = r.bottom + 6;
      if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
      pop.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + "px";
      pop.style.top = top + "px";
      pop.addEventListener("click", function (e) {
        var nav = e.target.closest("[data-nav]");
        if (nav) {
          m += Number(nav.dataset.nav);
          if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
          paint(y, m);
          return;
        }
        var d = e.target.closest("[data-d]");
        if (d) set(y, m, Number(d.dataset.d));
      });
      function onDoc(e) { if (pop && !pop.contains(e.target) && e.target !== input) close(); }
      function onReflow() { close(); }   // 滚动/缩放后位置就错了，直接收起，下次点开重算
      function onDoc2(e) { document.removeEventListener("pointerdown", onDoc2); onReflow(); }
      setTimeout(function () { document.addEventListener("pointerdown", onDoc2); }, 0);
      window.addEventListener("scroll", onReflow, true);
      window.addEventListener("resize", onReflow);
      unbind = function () {
        document.removeEventListener("pointerdown", onDoc2);
        window.removeEventListener("scroll", onReflow, true);
        window.removeEventListener("resize", onReflow);
      };
    }
    input.addEventListener("click", function () { pop ? close() : open(); });
  }

  // ------------------------------------------------------------- toast
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  // ------------------------------------------------------------- 顶栏
  /* 只有两个主入口。2026-10-26 起没有「用户管理」了（开通审批已取消）。 */
  function header(active, user) {
    var el = document.getElementById("topbar");
    if (!el) return;
    el.style.display = "";
    /* 顶栏只留两个主入口 —— 「上传」不放这里：它已经在「我的试卷」页里（空态也有引导按钮），
       顶栏再挂一个属于重复入口，反而把导航挤乱。 */
    var items = [
      { href: "index.html", key: "papers", text: "我的试卷" },
      { href: "customs.html", key: "customs", text: "我的组卷" },
    ];
    var who = user ? CloudAPI.displayName(user) : "";
    el.className = "topbar";
    el.innerHTML =
      '<div class="brand">试卷<span>题库</span></div>'
      + '<nav>' + items.map(function (i) {
          return '<a href="' + i.href + '"' + (i.key === active ? ' class="on"' : "") + ">" + i.text + "</a>";
        }).join("") + "</nav>"
      + '<div class="right">'
      + '<span class="who quota" id="tb-quota" title="免费识别次数"></span>'
      + (who ? '<span class="who">' + Render.esc(who) + "</span>" : "")
      + (who ? '<button class="ghost" id="btn-out">退出</button>' : "")
      + "</div>";
    /* 剩余识别次数：每个页面顶栏都显示，用户在点「识别」之前就知道还能用几次。
       本地演示默认不限 → 显示「识别不限」。 */
    var qEl = document.getElementById("tb-quota");
    if (qEl && CloudAPI.recognitionQuota) {
      CloudAPI.recognitionQuota().then(function (s) {
        if (!s || s.quota == null) { qEl.textContent = "识别不限"; qEl.className = "who quota free"; return; }
        qEl.textContent = "还可识别 " + s.remain + " 次";
        qEl.className = "who quota" + (s.remain <= 0 ? " out" : "");
      }).catch(function () { qEl.textContent = ""; });
    }
    var out = document.getElementById("btn-out");
    if (out) out.addEventListener("click", function () {
      CloudAPI.signOut().then(function () { location.href = "index.html"; });
    });
  }

  /* 门禁模式：未登录、未开通、权限查不出来这三种状态。
     把顶栏整条收起（只有品牌和「未登录」的横条没有任何可点的东西，白占地方），
     并给 body 打类，让登录卡在手机端铺满整屏 —— 见 app.css 的 gate-mode 段。 */
  function gateMode(on) {
    var el = document.getElementById("topbar");
    if (el) {
      if (on) { el.className = "topbar"; el.innerHTML = ""; el.style.display = "none"; }
      else { el.style.display = ""; }
    }
    if (document.body) document.body.classList.toggle("gate-mode", !!on);
  }

  // ------------------------------------------------------------- 登录 / 注册
  /* 主路 = 手机号 + 短信验证码（未注册的手机号验证后自动建号），辅路 = 微信扫码。
     交互按主流做法：+86 前缀 / 清空按钮 / 输入框内「获取验证码」带 60s 倒计时 /
     协议勾选（不勾就去抖一下并报错）/ 回车即提交 / 字段行内报错 / 提交态 loading。 */
  var ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9" fill="#c9cfdb"/>'
    + '<path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_WX = '<svg viewBox="0 0 24 24" width="23" height="23" fill="currentColor" aria-hidden="true">'
    + '<path d="M9.1 3C5.2 3 2 5.6 2 8.8c0 1.8 1 3.4 2.6 4.5l-.7 2.1 2.4-1.2c.8.3 1.7.4 2.6.4h.4a5.4 5.4 0 0 1-.2-1.5c0-3 2.9-5.5 6.5-5.5h.5C15.7 4.8 12.7 3 9.1 3ZM6.7 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4.7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/>'
    + '<path d="M22 13.6c0-2.7-2.7-4.9-6-4.9s-6 2.2-6 4.9 2.7 4.9 6 4.9c.8 0 1.5-.1 2.1-.3l1.9 1-.5-1.7c1.5-.9 2.5-2.3 2.5-3.9Zm-8-.9a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm4 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z"/></svg>';

  /* 协议正文：本应用自建账号，条款要写实的（别抄模板），用一个「知道了」弹窗承载。 */
  var DOCS = {
    terms: {
      title: "用户服务协议",
      text: "本应用提供试卷照片识别与题库整理服务，账号由本应用独立维护，与 WorkBuddy 账号无关。"
        + "你应当对上传的照片拥有合法权利，请勿上传含有他人隐私或违法违规内容的图片。"
        + "题目内容由大模型自动识别，可能存在偏差，请以原卷为准。"
        + "请勿将本应用用于任何违法用途；我们有权对违规账号停止服务。",
    },
    privacy: {
      title: "隐私政策",
      text: "我们只收集并保存你主动提供的信息：手机号（用于登录）、上传的试卷照片与识别结果。"
        + "照片存放在云端存储中，仅你本人登录后可见；识别时照片会提交给云服务的大模型处理。"
        + "账号的登录方式、注册时间与开通状态会展示给本应用的管理员，用于审核开通使用权限。"
        + "你可随时删除试卷，对应的照片与识别结果会一并删除。我们不会把你的数据用于其他用途或对外提供。",
    },
  };

  function docModal(key) {
    var d = DOCS[key]; if (!d) return;
    var mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = '<div class="modal" role="dialog" aria-modal="true">'
      + '<div class="m-t">' + Render.esc(d.title) + "</div>"
      + '<div class="m-b">' + Render.esc(d.text) + "</div>"
      + '<div class="m-f"><button type="button" class="btn" data-close>知道了</button></div></div>';
    document.body.appendChild(mask);
    function done() { document.removeEventListener("keydown", onKey); mask.remove(); }
    function onKey(e) { if (e.key === "Escape") done(); }
    mask.addEventListener("click", function (e) {
      if (e.target === mask || e.target.closest("[data-close]")) done();
    });
    document.addEventListener("keydown", onKey);
    setTimeout(function () { var b = mask.querySelector("[data-close]"); if (b) b.focus(); }, 0);
  }

  function renderLogin(host, onDone) {
    /* 「极简下划线」版式：白卡无边框，输入只用一条底线，主按钮纯黑；
       微信登录只留一个圆形图标按钮（不放文字），可读性交给 title / aria-label。
       ⚠️ 2026-10-26 起生产环境只允许微信扫码：卡上加 .wxonly，手机号表单与圆形图标
       按钮由 CSS 收起，改成整行主按钮（文案在 .wx-txt 里，平时不显示）。 */
    host.innerHTML =
      '<div class="auth"><div class="auth-card" id="lg-card">'
      + '<div class="auth-brand">试卷<span>题库</span></div>'
      + "<h1>登录</h1>"
      + '<p class="sub" id="lg-sub">未注册的手机号验证后自动创建账号</p>'
      + '<div class="msg err" id="lg-msg"></div>'
      + '<form id="lg-form" novalidate>'
      + '<div class="auth-line" id="fld-phone">'
      + '<span class="auth-cc">+86</span>'
      + '<input id="lg-phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="11" placeholder="手机号">'
      + '<button type="button" class="auth-clear" id="lg-clear" aria-label="清空手机号">' + ICON_X + "</button>"
      + "</div>"
      + '<div class="auth-err" id="err-phone">请输入正确的 11 位手机号</div>'
      + '<div class="auth-line">'
      + '<input id="lg-code" class="auth-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="短信验证码">'
      + '<button type="button" class="auth-send" id="lg-send">获取验证码</button>'
      + "</div>"
      + '<div class="auth-err" id="err-code">请输入收到的 6 位验证码</div>'
      + '<button type="submit" class="auth-submit" id="lg-submit">登录</button>'
      + '<label class="auth-agree" id="lg-agree-row">'
      + '<input type="checkbox" id="lg-agree"><span class="auth-ck" aria-hidden="true"></span>'
      + '<span>我已阅读并同意 <a href="#" data-doc="terms">《用户服务协议》</a>与<a href="#" data-doc="privacy">《隐私政策》</a></span>'
      + "</label>"
      + "</form>"
      + '<div class="auth-alt">'
      + '<button type="button" class="auth-wx" id="lg-wx" aria-label="微信扫码登录" title="微信扫码登录">'
      + ICON_WX + '<span class="wx-txt">微信扫码登录</span></button>'
      + "</div>"
      + '<div class="auth-fine" id="lg-fine">登录即表示同意 <a href="#" data-doc="terms">《用户服务协议》</a>与<a href="#" data-doc="privacy">《隐私政策》</a></div>'
      + '<div class="repo-line">'
      + '<a class="repo-gh" href="' + REPO_URL + '" target="_blank" rel="noopener"'
      + ' title="开源地址：github.com/nicoaigc/juan —— 建议自行部署，不限次数"'
      + ' aria-label="在 GitHub 查看开源代码（建议自行部署，不限次数）">' + ICON_GH + "</a>"
      + '<div class="repo-tip">建议自行部署，不限次数</div>'
      + "</div>"
      + "</div></div>";

    var $ = function (id) { return document.getElementById(id); };
    var phoneEl = $("lg-phone"), codeEl = $("lg-code"), agreeRow = $("lg-agree-row");
    var sendBtn = $("lg-send"), submitBtn = $("lg-submit");
    var timer = null;

    /* 生产：只留微信。手机上微信内置浏览器无法扫码，文案里点明「请在电脑上扫」。 */
    if (WECHAT_ONLY) {
      $("lg-card").classList.add("wxonly");
      $("lg-sub").textContent = "使用微信扫码登录（手机端请改用电脑打开）";
    }
    /* 「登录即表示同意」那行（微信模式下是唯一的协议入口）与协议弹层连起来 */
    $("lg-fine").addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-doc]") : null;
      if (a) { e.preventDefault(); docModal(a.dataset.doc); }
    });

    function showMsg(t, kind) {
      var m = $("lg-msg");
      m.textContent = t || "";
      m.className = "msg " + (kind || "err") + (t ? " show" : "");
    }
    /* 字段行内报错：比顶部横幅更贴近输入位置 */
    function err(id, msg) {
      var el = $(id);
      el.textContent = msg || el.dataset.def || el.textContent;
      el.classList.toggle("show", !!msg);
      if (id === "err-phone") $("fld-phone").classList.toggle("bad", !!msg);
    }
    function agreeShake() {
      agreeRow.classList.add("shake", "bad");
      setTimeout(function () { agreeRow.classList.remove("shake"); }, 320);
    }

    phoneEl.addEventListener("input", function () {
      var v = phoneEl.value.replace(/\D/g, "").slice(0, 11);
      if (v !== phoneEl.value) phoneEl.value = v;
      $("lg-clear").classList.toggle("show", !!v);
      err("err-phone", "");
      if (v.length === 11) codeEl.focus();          // 填满自动跳到验证码
    });
    $("lg-clear").addEventListener("click", function () {
      phoneEl.value = ""; this.classList.remove("show"); phoneEl.focus();
    });
    codeEl.addEventListener("input", function () {
      var v = codeEl.value.replace(/\D/g, "").slice(0, 6);
      if (v !== codeEl.value) codeEl.value = v;
      err("err-code", "");
    });
    $("lg-agree").addEventListener("change", function () {
      if (this.checked) agreeRow.classList.remove("bad");
    });
    agreeRow.addEventListener("click", function (e) {
      var a = e.target.closest("a[data-doc]");
      if (a) { e.preventDefault(); docModal(a.dataset.doc); }
    });

    function countdown() {
      var left = 60; sendBtn.disabled = true; sendBtn.textContent = left + " 秒后重发";
      timer = setInterval(function () {
        left -= 1;
        if (left <= 0) { clearInterval(timer); sendBtn.disabled = false; sendBtn.textContent = "获取验证码"; }
        else sendBtn.textContent = left + " 秒后重发";
      }, 1000);
    }

    sendBtn.addEventListener("click", function () {
      var phone = phoneEl.value.trim();
      if (!/^1\d{10}$/.test(phone)) { err("err-phone", "请输入正确的 11 位手机号"); showMsg(""); return; }
      err("err-phone", ""); showMsg("");
      sendBtn.disabled = true; sendBtn.textContent = "发送中…";
      CloudAPI.sendPhoneCode(phone).then(function () {
        countdown();
        codeEl.focus();
        toast("验证码已发送");
        showMsg("验证码已发送至 " + phone.slice(0, 3) + "****" + phone.slice(7), "ok");
      }).catch(function (e) {
        sendBtn.disabled = false; sendBtn.textContent = "获取验证码";
        showMsg(e.message || "验证码发送失败");
      });
    });

    $("lg-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var phone = phoneEl.value.trim(), code = codeEl.value.trim();
      if (!/^1\d{10}$/.test(phone)) { err("err-phone", "请输入正确的 11 位手机号"); phoneEl.focus(); return; }
      if (code.length !== 6) { err("err-code", "请输入收到的 6 位验证码"); codeEl.focus(); return; }
      if (!$("lg-agree").checked) { agreeShake(); showMsg("请先阅读并勾选同意《用户服务协议》和《隐私政策》"); return; }
      showMsg("");
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="sp"></i>登录中…';
      CloudAPI.verifyPhone(code).then(function (s) {
        toast("登录成功");
        onDone && onDone(s);
      }).catch(function (e) {
        submitBtn.disabled = false;
        submitBtn.textContent = "登录";
        showMsg(e.message || "验证码不正确");
      });
    });

    $("lg-wx").addEventListener("click", function () {
      var b = this;
      b.disabled = true;
      CloudAPI.signInWechat().catch(function (e) {
        b.disabled = false;
        showMsg(e.message || "微信登录不可用");
      });
    });

    setTimeout(function () { try { phoneEl.focus(); } catch (e) { /* 忽略 */ } }, 60);
  }

  /* ------------------------------------------------ 登录守卫
     只判断「有没有登录」：登录之后所有功能直接可用（2026-10-26 起取消了「开通审批」）。
     账号之间仍然靠 owner_id 隔离，谁也看不到别人的题库；这里只负责把没登录的人请去登录。 */
  function requireLogin(host, onReady) {
    var nav = host.dataset.nav || "";
    var box = document.getElementById("login-host");
    function showLogin() {
      gateMode(true);                              // 登录界面不挂顶栏
      box.innerHTML = "";
      renderLogin(box, function () { location.reload(); });
      host.style.display = "none";
    }
    return CloudAPI.currentUser().then(function (user) {
      if (!user) { showLogin(); return null; }
      box.innerHTML = "";
      gateMode(false);
      header(nav, user);
      onReady && onReady(user);
      return user;
    }).catch(showLogin);
  }

  // ------------------------------------------------------------- 原图
  /* 一份卷的所有原图 -> { 文件名: {url, w, h} }。渲染前先全部签好地址，
     这样 frag()/cropBox() 拼 HTML 时是同步的（只做"抠图"，不发请求）。 */
  function buildImageMap(files) {
    var map = {};
    return (files || []).reduce(function (chain, f) {
      return chain.then(function () {
        return CloudAPI.signedUrl(f.storage_path).then(function (url) {
          map[f.filename] = { url: url, w: f.width, h: f.height, p: f.storage_path, id: f.id, page_no: f.page_no };
        }).catch(function () {
          map[f.filename] = { url: "", w: f.width, h: f.height, p: f.storage_path, id: f.id, page_no: f.page_no };
        });
      });
    }, Promise.resolve()).then(function () { return map; });
  }

  /* 这道题的原图是哪张：优先按 source.file 匹配，其次按 source.page，最后退到第一张。 */
  function imageFor(map, files, data) {
    var src = (data && data.source) || {};
    if (src.file && map[src.file]) return map[src.file];
    var names = Object.keys(map);
    if (files && files.length) {
      if (src.page) {
        for (var i = 0; i < files.length; i++) if (files[i].page_no === src.page && map[files[i].filename]) return map[files[i].filename];
      }
      if (map[files[0].filename]) return map[files[0].filename];
    }
    return names.length ? map[names[0]] : null;
  }

  function ctxFor(map, files) {
    return { imageFor: function (data) { return imageFor(map, files, data); } };
  }

  // ------------------------------------------------------------- 灯箱
  function initLightbox() {
    var box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = '<span class="close">&times;</span><img alt="原图">';
    document.body.appendChild(box);
    var img = box.querySelector("img");
    box.addEventListener("click", function () { box.classList.remove("show"); img.removeAttribute("src"); });
    window.UI_lightbox = function (url) { if (!url) { toast("原图地址不可用"); return; } img.src = url; box.classList.add("show"); };
  }

  function qs(name) {
    var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
  }

  // ------------------------------------------------------------- 题型打标浮层
  // 题库侧（组卷台左栏 / 题目详情页）共用：点题型小标弹出，选一个写进 source.qtype_manual。
  // 注意跟排版态卷面上的题型小标（sheet-edit.js 的 openTypeMenu）是两层 ——
  // 这里改的是**题库本身**（全站生效：首页统计 / 筛选 / 照片卷 / 之后的组卷默认），
  // 卷面上改的是**这一份卷子的排版覆盖**（layout.types）。
  var TYPEPICK = null;

  function closeTypePick() {
    if (TYPEPICK && TYPEPICK.parentNode) TYPEPICK.parentNode.removeChild(TYPEPICK);
    TYPEPICK = null;
    document.removeEventListener("click", typePickOutside, true);
    window.removeEventListener("resize", closeTypePick);
  }
  function typePickOutside(ev) {
    if (TYPEPICK && !TYPEPICK.contains(ev.target)) closeTypePick();
  }

  /* anchor：定位锚（题型小标元素）；cur：当前生效桶键；manual：已有手动打标（有才显示「恢复自动」）；
     onPick(bucket|null) —— null = 恢复自动识别。 */
  function typePicker(anchor, cur, manual, onPick) {
    closeTypePick();
    var Q = window.QType;
    var m = document.createElement("div");
    m.className = "qmenu typepick no-print";
    m.innerHTML = (Q ? Q.TYPE_SECTION : []).map(function (d) {
      return '<button type="button" class="qmi' + (d[0] === cur && !manual ? " on" : "") + '"'
        + ' data-t="' + d[0] + '">' + d[1] + "</button>";
    }).join("")
      + (manual
        ? '<button type="button" class="qmi qmi-clear" data-t="">恢复自动识别</button>'
        : "");
    document.body.appendChild(m);
    /* fixed 定位贴着锚点弹，屏幕右边/下边放不下就往回收 */
    var r = anchor.getBoundingClientRect();
    var x = Math.min(Math.max(8, r.left), window.innerWidth - m.offsetWidth - 8);
    var y = r.bottom + 4;
    if (y + m.offsetHeight > window.innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 4);
    m.style.left = x + "px";
    m.style.top = y + "px";
    m.addEventListener("click", function (ev) {
      var b = ev.target.closest(".qmi");
      if (!b) return;
      var t = b.dataset.t || null;
      closeTypePick();
      onPick(t);
    });
    TYPEPICK = m;
    setTimeout(function () {
      document.addEventListener("click", typePickOutside, true);
      window.addEventListener("resize", closeTypePick);
    }, 0);
  }

  function fmtDate(s) {
    if (!s) return "未填日期";
    return String(s).slice(0, 10);
  }

  function bytes(n) {
    n = Number(n || 0);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  window.UI = {
    toast: toast,
    select: select,
    confirm: confirm,
    choose: choose,
    datePicker: datePicker,
    header: header,
    gateMode: gateMode,
    renderLogin: renderLogin,
    requireLogin: requireLogin,
    buildImageMap: buildImageMap,
    imageFor: imageFor,
    ctxFor: ctxFor,
    initLightbox: initLightbox,
    qs: qs,
    typePicker: typePicker,
    closeTypePick: closeTypePick,
    fmtDate: fmtDate,
    bytes: bytes,
  };
})();
