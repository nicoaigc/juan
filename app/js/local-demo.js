/* 本地演示模式（local-demo）—— 只在本机静态服务下生效，线上按 hostname 判定永不激活。
 *
 * 为什么要它：后端是云服务（服务端按 Origin 精确校验），本地 127.0.0.1 连不上，
 * 想在本地把界面点一遍就得自己喂数据。这里用 app/assets/demo-library.json
 * （5 份卷 135 题，图走 assets/benchmark/ 静态文件）搭一套**内存版 CloudAPI**，
 * 自建卷与照片卷的卷面排版写进 localStorage，刷新不丢。
 *
 * 生效条件：hostname 是本机（127.0.0.1 / localhost）+ 地址不带 ?demo=0。
 * 一键启动（项目根）：
 *   python tools/serve_with_csp.py --port 64911 --root app
 * 然后打开 http://127.0.0.1:64911/index.html
 *
 * 演示模式下不可用：上传扫描件、AI 识别（都要真云服务），页面会自己提示。
 * 生产页面里的 cloud.js 开头会看 window.__LOCAL_DEMO__ 决定是否早退，线上零影响。
 */
(function () {
  "use strict";

  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) return;   // 线上永不激活
  if (/(?:^|[?&])demo=0(?:&|$)/.test(location.search)) return;                 // 显式关闭
  window.__LOCAL_DEMO__ = true;

  // ---------------------------------------------------------------- 演示数据
  function loadLibrary() {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "assets/demo-library.json", false);   // 同步：页面启动就是同步 IIFE，来不及 await
    xhr.send(null);
    if (xhr.status !== 200 && xhr.status !== 0) throw new Error("演示数据载入失败（HTTP " + xhr.status + "）");
    return JSON.parse(xhr.responseText);
  }

  var lib;
  try {
    lib = loadLibrary();
  } catch (e) {
    console.error("[local-demo]", e);
    document.addEventListener("DOMContentLoaded", function () {
      var d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;"
        + "background:#fff;font:15px/1.7 system-ui;color:#333;padding:32px;text-align:center";
      d.innerHTML = "<div><b>本地演示模式启动失败</b><br>" + (e.message || e)
        + "<br><br>请用 http 服务打开（<code>tools/serve_with_csp.py --port 64911 --root app</code>），"
        + "直接双击 html 文件读不到演示数据。</div>";
      document.body.appendChild(d);
    });
    return;
  }

  var PAPERS = [], QUESTIONS = [], FILES = [];
  var BACKUPS = [], BACKUP_ID = 0;   // 重新识别前的自动备份（内存版，刷新即清，够验证交互）
  var qid = 0;
  (lib.papers || []).forEach(function (p, i) {
    var pid = i + 1;
    PAPERS.push({
      id: pid, title: p.title, paper_date: p.paper_date, subject: p.subject, grade: p.grade,
      status: p.status || "done", status_note: p.status_note || "",
      question_count: (p.questions || []).length,
    });
    (p.files || []).forEach(function (f) {
      FILES.push(Object.assign({}, f, { id: FILES.length + 1, paper_id: pid }));
    });
    (p.questions || []).forEach(function (q) {
      qid += 1;
      QUESTIONS.push(Object.assign({}, q, { id: qid, paper_id: pid }));
    });
  });

  function pick(paperIdx, n, type) {
    return QUESTIONS.filter(function (q) {
      return q.paper_id === paperIdx + 1 && q.qtype === type;
    }).slice(0, n).map(function (q) { return q.id; });
  }

  /* 应用题要按**板块名**挑：识别存的 type 里"用竖式计算/递等式计算"也是 solve，
     随手取前两道 solve 会取到纯算式（卷面按板块名分桶后会跑到计算题里去）。 */
  function pickApply(n) {
    return QUESTIONS.filter(function (q) { return /应用|解决/.test(q.section || ""); })
      .slice(0, n).map(function (q) { return q.id; });
  }

  /* 两份示例自建卷：id=1 没排过版（打开时走智能排版），id=2 存了自定义排版（验证能还原） */
  function seedCustoms() {
    var choice = pick(4, 5, "choice");
    var fill = QUESTIONS.filter(function (q) { return q.qtype === "fill"; }).slice(0, 4)
      .map(function (q) { return q.id; });
    var calc = pick(0, 6, "calculate");
    var solve = pickApply(2);
    var layChoice = pick(4, 2, "choice"), layCalc = pick(0, 3, "calculate");
    return [
      {
        id: 1, title: "第三单元总复习（自选组卷）",
        question_ids: choice.concat(fill, calc, solve), layout: null,
        updated_at: "2026-10-06T21:20:00+08:00", created_at: "2026-10-06T21:05:00+08:00",
      },
      {
        id: 2, title: "口算与选择专项（自定义排版）",
        question_ids: layChoice.concat(layCalc),
        layout: { sections: [
          { title: "一、选择题", cols: 1, ids: layChoice },
          { title: "二、计算题", cols: 2, ids: layCalc },
        ] },
        updated_at: "2026-10-06T20:40:00+08:00", created_at: "2026-10-06T20:30:00+08:00",
      },
    ];
  }

  var KEY = "sj-demo-customs-v1";
  var CUSTOMS = (function () {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var v = JSON.parse(raw); if (Array.isArray(v)) return v; }
    } catch (e) { /* 忽略：坏数据就回种子 */ }
    return seedCustoms();
  })();
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(CUSTOMS)); } catch (e) { /* 忽略配额 */ }
  }

  // 题库级手动打标的持久层：演示题库本身是只读 JSON，把 source.qtype_manual 的改动
  // 存成 {题目id: 桶键|""} 的覆盖层，读题目时叠回去（"" = 恢复自动，即删键）。
  var TAGKEY = "sj-demo-qtags-v1";
  var QTAGS = (function () {
    try {
      var raw = localStorage.getItem(TAGKEY);
      if (raw) { var v = JSON.parse(raw); if (v && typeof v === "object") return v; }
    } catch (e) { /* 忽略：坏数据当没有 */ }
    return {};
  })();
  function persistTags() {
    try { localStorage.setItem(TAGKEY, JSON.stringify(QTAGS)); } catch (e) { /* 忽略配额 */ }
  }
  function applyTags(q) {
    var t = QTAGS[String(q.id)];
    if (t === undefined) return q;
    var src = Object.assign({}, q.source || {});
    if (t) src.qtype_manual = t; else delete src.qtype_manual;
    return Object.assign({}, q, { source: src });
  }

  // 题目内容的手动修正（题干/选项）：也是覆盖层（{题目id: {stem, options, edited}}）——
  // 演示题库是只读 JSON，真正的云库 updateQuestion 直接落库，这里刷新后要能还原。
  var EDITKEY = "sj-demo-qedits-v1";
  var QEDITS = (function () {
    try {
      var raw = localStorage.getItem(EDITKEY);
      if (raw) { var v = JSON.parse(raw); if (v && typeof v === "object") return v; }
    } catch (e) { /* 忽略：坏数据当没有 */ }
    return {};
  })();
  function persistEdits() {
    try { localStorage.setItem(EDITKEY, JSON.stringify(QEDITS)); } catch (e) { /* 忽略配额 */ }
  }
  function applyEdits(q) {
    var e = QEDITS[String(q.id)];
    if (!e) return q;
    var src = Object.assign({}, q.source || {});
    if (e.edited) src.edited = true;
    var row = Object.assign({}, q, { source: src, stem: e.stem ? clone(e.stem) : q.stem });
    if (e.options) row.options = clone(e.options);   // 只改图片时没有 options，保留原值
    return row;
  }
  function applyOverlays(q) { return applyTags(applyEdits(q)); }

  // 照片卷的卷面排版（print.html?id=N 上就地排的那份）：和自建卷一样覆盖层处理 ——
  // 演示题库 JSON 是只读的，真正的云库写进 papers.layout（列由 2026-10-11 加上），
  // 这里存成 {卷id: layout}，读卷时叠回去，刷新不丢、清 localStorage 即还原。
  var PLAYKEY = "sj-demo-paper-layouts-v1";
  var PLAYOUTS = (function () {
    try {
      var raw = localStorage.getItem(PLAYKEY);
      if (raw) { var v = JSON.parse(raw); if (v && typeof v === "object") return v; }
    } catch (e) { /* 忽略：坏数据当没有 */ }
    return {};
  })();
  function persistPlays() {
    try { localStorage.setItem(PLAYKEY, JSON.stringify(PLAYOUTS)); } catch (e) { /* 忽略配额 */ }
  }
  function applyPlay(p) {
    if (!p || !p.id) return p;
    var L = PLAYOUTS[String(p.id)];
    return L ? Object.assign({}, p, { layout: clone(L) }) : p;
  }

  // ---------------------------------------------------------------- 登录态
  var USER = { id: "demo-teacher", name: "本地演示（张老师）", phoneNumber: "13800138000" };

  /* 识别次数：本地**默认不限**；带 ?limit=N 才打开限制（记在 localStorage，
     所以「删了卷再传」也照样扣，可以拿来验生产那套规则）。
     N 会跨页面记住（识别是在卷详情页跑的，参数不会跟着跳转走）；
     ?limit=0 关闭限制，换别的 N 会自动把已用次数重置。 */
  var LKEY = "sj-demo-limit";
  var LIMIT = (function () {
    var m = /[?&]limit=(\d+)/.exec(location.search);
    if (m) {
      var n = Number(m[1]);
      if (n > 0) { try { localStorage.setItem(LKEY, String(n)); } catch (e) { /* 忽略 */ } return n; }
      try { localStorage.removeItem(LKEY); } catch (e) { /* 忽略 */ }
      return null;
    }
    var s = NaN;
    try { s = Number(localStorage.getItem(LKEY)); } catch (e) { s = NaN; }
    return s > 0 ? s : null;
  })();
  var QKEY = "sj-demo-quota";

  function quotaState() {
    if (LIMIT == null) return { used: 0, quota: null, remain: null };
    var s = null;
    try { s = JSON.parse(localStorage.getItem(QKEY) || "null"); } catch (e) { s = null; }
    if (!s || Number(s.quota) !== LIMIT) s = { quota: LIMIT, used: 0 };
    return { used: s.used, quota: s.quota, remain: Math.max(s.quota - s.used, 0) };
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function ok(v) { return Promise.resolve(v); }
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function bySeq(a, b) { return (Number(a.seq) || 0) - (Number(b.seq) || 0); }

  /* ---- 单页重扫用的三个小工具（与云版 cloud.js 同口径 -------------------------
     先按 source.file（哪张图）精确匹配，匹配不到才退回 source.page（第几页）——
     老数据里 page_no 可能重复，只按 page 会把别的照片的题一起圈进来。 */
  function pageRowsOf(rows, page, filename) {
    var all = rows || [];
    if (filename) {
      var byFile = all.filter(function (q) {
        return String((q.source || {}).file || "") === String(filename);
      });
      if (byFile.length) return byFile;
    }
    return all.filter(function (q) {
      var s = q.source || {};
      if (s.page == null || s.page === "") return false;
      return Number(s.page) === Number(page);
    });
  }
  function addQuestions(rows) {
    return ok((rows || []).map(function (row) {
      qid += 1; var q = Object.assign({ id: qid }, row); QUESTIONS.push(q); return clone(q);
    }));
  }

  // ---------------------------------------------------------------- CloudAPI
  window.CloudAPI = {
    // 识别（recognize.js）会探这个键；演示模式下不提供，页面自己提示"云 SDK 还没就绪"
    cloud: null,
    demo: true,
    unwrap: function (res) { return res && res.data ? res.data : res; },

    session: function () { return ok({ user: clone(USER) }); },
    currentUser: function () { return ok(clone(USER)); },
    displayName: function (u) { return (u && u.name) || USER.name; },
    uid: function () { return USER.id; },

    handleWechatCallback: function () { return ok(null); },
    sendPhoneCode: function () { return Promise.reject(new Error("本地演示模式不需要登录")); },
    verifyPhone: function () { return Promise.reject(new Error("本地演示模式不需要登录")); },
    signInWechat: function () { return Promise.reject(new Error("本地演示模式不需要登录")); },
    signOut: function () { return ok(true); },
    onAuthChange: function () { return function () {}; },

    recognitionQuota: function () { return ok(quotaState()); },
    consumeRecognition: function () {
      var s = quotaState();
      if (s.quota == null) return ok(s);          // 不限：永远成功
      if (s.remain <= 0) {
        // 文案与云端一致（cloud.js 的 OUT_OF_QUOTA），本地自检才对得上
        return Promise.reject(new Error("免费识别次数已用完（" + s.quota + "/" + s.quota
          + "）。建议自行部署后继续使用：https://github.com/nicoaigc/juan"));
      }
      var next = { quota: s.quota, used: s.used + 1 };
      try { localStorage.setItem(QKEY, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
      return ok({ used: next.used, quota: next.quota, remain: next.quota - next.used });
    },

    // 卷 / 原图 / 题目（只读够用；写操作在内存里生效，刷新即还原）
    listPapers: function () { return ok(clone(PAPERS).map(applyPlay)); },
    getPaper: function (id) { return ok(clone(applyPlay(byId(PAPERS, id)))); },
    createPaper: function (row) {
      var p = Object.assign({ id: PAPERS.length + 1, question_count: 0 }, row);
      PAPERS.push(p); return ok(clone(p));
    },
    updatePaper: function (id, row) {
      var p = byId(PAPERS, id); if (!p) return ok(null);
      Object.assign(p, row);
      /* 卷面排版是唯一需要跨刷新的部分（云端落 papers.layout），演示走覆盖层 */
      if (row && row.layout !== undefined) {
        if (row.layout) PLAYOUTS[String(id)] = clone(row.layout);
        else delete PLAYOUTS[String(id)];
        persistPlays();
      }
      return ok(clone(applyPlay(p)));
    },
    deletePaper: function (id) {
      PAPERS = PAPERS.filter(function (p) { return String(p.id) !== String(id); });
      QUESTIONS = QUESTIONS.filter(function (q) { return String(q.paper_id) !== String(id); });
      FILES = FILES.filter(function (f) { return String(f.paper_id) !== String(id); });
      if (PLAYOUTS[String(id)]) { delete PLAYOUTS[String(id)]; persistPlays(); }
      return ok(true);
    },
    listFiles: function (pid) {
      return ok(clone(FILES.filter(function (f) { return String(f.paper_id) === String(pid); })));
    },
    addFile: function (row) {
      var f = Object.assign({ id: FILES.length + 1 }, row); FILES.push(f); return ok(clone(f));
    },
    addFiles: function (rows) {
      return ok((rows || []).map(function (row) {
        var f = Object.assign({ id: FILES.length + 1 }, row); FILES.push(f); return clone(f);
      }));
    },
    removeFileRow: function (id) {
      FILES = FILES.filter(function (f) { return String(f.id) !== String(id); }); return ok(true);
    },
    /* 顺序与云版对齐：云端 listQuestions 是 order("seq")，演示题库是内存数组，
       不排的话单页重扫重排过 seq 也看不出效果。 */
    listQuestions: function (pid) {
      return ok(clone(QUESTIONS.filter(function (q) { return String(q.paper_id) === String(pid); })
        .map(applyOverlays).sort(bySeq)));
    },
    listAllQuestions: function () {
      return ok(clone(QUESTIONS.map(applyOverlays).sort(function (a, b) {
        return (Number(a.paper_id) || 0) - (Number(b.paper_id) || 0) || bySeq(a, b);
      })));
    },
    listAllFiles: function () { return ok(clone(FILES)); },
    getQuestion: function (id) {
      var q = byId(QUESTIONS, id);
      return ok(q ? clone(applyOverlays(q)) : null);
    },
    /* 题库级字段修正：顶层浅合并。source 里带不带 qtype_manual 决定打标覆盖层的值；
       带 stem/options 说明是内容级手动修正，另记进 qedits 覆盖层（刷新还原）。 */
    updateQuestion: function (id, patch) {
      var q = byId(QUESTIONS, id);
      if (!q) return Promise.reject(new Error("找不到这道题"));
      Object.keys(patch || {}).forEach(function (k) { q[k] = patch[k]; });
      if (patch && patch.source) {
        QTAGS[String(id)] = patch.source.qtype_manual || "";
        persistTags();
      }
      if (patch && (patch.stem || patch.options)) {
        /* 图片微调只带 stem 不带 options —— 两边都要按「有才覆盖」处理，别 clone(undefined) */
        var ed = { edited: true };
        if (patch.stem) ed.stem = clone(patch.stem);
        if (patch.options) ed.options = clone(patch.options);
        QEDITS[String(id)] = ed;
        persistEdits();
      }
      return ok(clone(applyOverlays(q)));
    },
    addQuestions: addQuestions,
    insertQuestions: addQuestions,        // 云版会返回落库行；演示版本来就是返回插入后的行
    deleteQuestions: function (pid) {
      QUESTIONS = QUESTIONS.filter(function (q) { return String(q.paper_id) !== String(pid); });
      return ok(true);
    },

    /* 单页重扫用：按「页」定位 / 只删这些 id / 重排 seq（与云版同口径，仅实现更直接） */
    pageRowsOf: pageRowsOf,
    deleteQuestionsByIds: function (ids) {
      var want = {};
      (ids || []).forEach(function (id) { want[String(id)] = 1; });
      QUESTIONS = QUESTIONS.filter(function (q) { return !want[String(q.id)]; });
      Object.keys(want).forEach(function (k) { delete QEDITS[k]; delete QTAGS[k]; });
      return ok((ids || []).length);
    },
    setQuestionSeqs: function (pairs) {
      var n = 0;
      (pairs || []).forEach(function (p) {
        if (Number(p.cur) === Number(p.seq)) return;
        var q = byId(QUESTIONS, p.id);
        if (!q) return;
        q.seq = p.seq; n += 1;
      });
      return ok(n);
    },

    /* 重新识别前的自动备份 / 恢复。云版按 seq 原地 UPDATE 保住题目 id；
       演示版题库是内存数组，直接重建更省事（自建卷引用在这个模式里本来就易变）。 */
    fmtStamp: function (iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || "");
      function p(n) { return (n < 10 ? "0" : "") + n; }
      return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
    },
    backupQuestions: function (pid, rows, reason) {
      BACKUP_ID += 1;
      var b = {
        id: BACKUP_ID, paper_id: pid, created_at: new Date().toISOString(),
        reason: reason || "", q_count: (rows || []).length, payload: clone(rows || []),
      };
      BACKUPS.unshift(b);
      // 与云版同口径：每卷最多留 5 份，超出自动清最旧的
      BACKUPS.filter(function (x) { return String(x.paper_id) === String(pid); }).slice(5)
        .forEach(function (x) {
          BACKUPS = BACKUPS.filter(function (y) { return String(y.id) !== String(x.id); });
        });
      return ok({ id: b.id, paper_id: pid, created_at: b.created_at, reason: b.reason, q_count: b.q_count });
    },
    listBackups: function (pid) {
      return ok(clone(BACKUPS.filter(function (b) { return String(b.paper_id) === String(pid); })
        .map(function (b) {
          return { id: b.id, paper_id: b.paper_id, created_at: b.created_at,
                   reason: b.reason, q_count: b.q_count };
        })));
    },
    restoreQuestions: function (id) {
      var b = byId(BACKUPS, id);
      if (!b) return Promise.reject(new Error("这份备份已经不在了"));
      var pid = b.paper_id, n = 0;
      QUESTIONS = QUESTIONS.filter(function (q) { return String(q.paper_id) !== String(pid); });
      (b.payload || []).forEach(function (row) {
        qid += 1; n += 1;
        QUESTIONS.push(Object.assign({}, clone(row), { id: qid, paper_id: pid }));
      });
      var p = byId(PAPERS, pid);
      if (p) { p.question_count = n; p.status = "done"; p.status_note = "已从备份恢复（本地演示）"; }
      return ok({ updated: 0, inserted: n, removed: 0 });
    },
    deleteBackup: function (id) {
      BACKUPS = BACKUPS.filter(function (b) { return String(b.id) !== String(id); });
      return ok(1);
    },

    // 自建卷：唯一有持久化的部分（localStorage），这样排版保存后刷新还在
    listCustomPapers: function () { return ok(clone(CUSTOMS)); },
    getCustomPaper: function (id) { return ok(clone(byId(CUSTOMS, id))); },
    createCustomPaper: function (row) {
      var maxId = CUSTOMS.reduce(function (m, c) { return Math.max(m, Number(c.id) || 0); }, 0);
      var c = Object.assign({}, row, {
        id: maxId + 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      CUSTOMS.push(c); persist(); return ok(clone(c));
    },
    updateCustomPaper: function (id, row) {
      var c = byId(CUSTOMS, id);
      if (!c) return Promise.reject(new Error("这份自建卷已不存在"));
      Object.assign(c, row, { updated_at: new Date().toISOString() });
      persist(); return ok(clone(c));
    },
    deleteCustomPaper: function (id) {
      CUSTOMS = CUSTOMS.filter(function (c) { return String(c.id) !== String(id); });
      persist(); return ok(true);
    },

    // 图片：演示数据里是 local: 前缀的静态路径，直接换成本地相对地址
    signedUrl: function (p) { return ok(p && p.indexOf("local:") === 0 ? p.slice(6) : ""); },
    uploadPhoto: function () { return Promise.reject(new Error("本地演示模式不连云存储，上传请用发布版")); },
    downloadPhoto: function () { return ok(null); },
    removePhoto: function () { return ok(true); },
  };

  // ---------------------------------------------------------------- 角标
  function badge() {
    var d = document.createElement("div");
    d.id = "demo-badge";
    /* 带 no-print：本地打印卷面时别把角标印到纸上（@media print 会隐藏 .no-print） */
    d.className = "no-print";
    d.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;background:rgba(23,32,44,.9);"
      + "color:#fff;font:12px/1.6 system-ui;padding:8px 12px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.2);"
      + "max-width:260px";
    d.innerHTML = "本地演示模式 · 数据为示例题库<br>"
      + "<a href='#' id='demo-reset' style='color:#8fd3ff;text-decoration:underline'>重置演示数据</a>";
    document.body.appendChild(d);
    d.querySelector("#demo-reset").addEventListener("click", function (ev) {
      ev.preventDefault();
      try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
      location.reload();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", badge);
  else badge();
})();
