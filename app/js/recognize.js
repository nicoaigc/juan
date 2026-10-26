/* 自动识别：把上传的试卷照片送进云服务「免密钥」大模型，得到结构化题目。

   为什么只能在浏览器里调：云服务的免密钥通道按**精确 Origin** 校验，而且规范禁止
   手写 /.cloud/llm 请求 —— 必须走 SDK、在应用自己的页面上跑。所以识别这件事
   天然属于前端，后端没有可用的调用点。

   ── 坐标怎么精修（v5.2.1 本地吸附，js/refine.js） ──
   实测 deepseek-v4.1-flash 的文字转写是字符级 100% 准确，但坐标不行：
   即使给它看了带刻度的图，它输出的坐标也是"按版式铺开"的（同一列 y 整齐取 60 的倍数、
   三列 x 固定在 175/520/890），密集页偏 30~60px；同一张图两次调用 y 还能差 10~250px。
   三条朴素修法都试过、都不成立（本地全页行投影 / 中心吸附 / 外扩到必不漏，见 refine.js 头注）。
   现在的做法（tools/refine_proto.py 验证过 5 卷 10 次，覆盖率 8/10 优于外扩、IoU 9/10）：
     · js/refine.js 在本地做「结构判据 + 单调对齐」：印刷黑掩膜 → 行投影行带 →
       版面横向结构分类 → 模型行按顺序单调对齐（允许跳过板块标题）→ x 吸附列投影、
       y 向有墨处生长。算法细节与参数注释都在 refine.js，两边规则必须同步改。
     · 兜底：Refine 不在（老缓存页面没加载到 refine.js）、读像素失败、DP 判不可行，
       一律退回「外扩 35%」——就是下面的 widen()，绝不比老策略更差。
   典型应用题页（一页 4~8 题）误差本来就小；密集计算页的题目文字本身完整显示、
   缩略图偏一点不影响使用。

   ── 插图（stem 里的 t:"figure"）另走一路（v20261011a） ──
   插图的错法**不是**"顺序对应"而是"边界"：框会偏（paper6 的 q35 整段落在广告
   下方 150px 空白里）、会太小、会伸进旁边的题面文字或学生笔迹（q32 混进「406」）。
   等量外扩只会把错误放大。所以 refine.js 里另有一套 `snapFigures`（图形块吸附，
   判据与题区完全不同，见那边的注释），结果挂在 stem 片段上（`f._sb`）。
   哪张图吸附失败就不挂 → toRow 退回「外扩 25%（30~80）」，逐张独立兜底。
   实测 9 张人工标注插图：平均 IoU 0.564（外扩）→ 0.813（吸附）。
*/
(function () {
  "use strict";

  var MODEL_DEFAULT = "deepseek-v4.1-flash";

  /* 识别模型可手动切换（localStorage 记住）。清单是**实测过**的（2026-10-05，5 卷 10 次
     + 2 次线上 e2e）：
     · deepseek-v4.1-flash —— 效果最好、5~10 秒/页。缺点：配额独立，偶尔整模型限流。
     · space-bunny —— 准确度接近，倍率最便宜；但慢，题多的页 160s+（客户端时限已改为
       「空闲 2 分钟 + 绝对 10 分钟」双门槛，慢页只要还在出字就不会被掐）。
     · minimax-m3 —— 快（23s/页）；题特别多的页（24 题口算）输出会截断导致 JSON 解析失败。
     · glm-5.3-flash（深度思考，曾在 240s 时限下超时）/ glm-4.6v（不支持本链路参数）实测不可用，不列。 */
  var MODELS = [
    { id: "deepseek-v4.1-flash", label: "Deepseek-V4.1-Flash", tag: "推荐",
      desc: "效果最好，一页 5~10 秒；偶尔整体限流" },
    { id: "space-bunny", label: "Space-Bunny", tag: "省钱",
      desc: "准确度接近、倍率最低；题多的页较慢" },
    { id: "minimax-m3", label: "MiniMax-M3", tag: "快",
      desc: "一页约 23 秒；题特别多的页可能失败" },
  ];
  var MODEL_KEY = "reco_model";
  function currentModel() {
    try { return localStorage.getItem(MODEL_KEY) || MODEL_DEFAULT; }
    catch (e) { return MODEL_DEFAULT; }
  }
  function setModel(id) {
    try { localStorage.setItem(MODEL_KEY, id); } catch (e) { /* 隐私模式存不了就用默认 */ }
  }
  /* 把模型选择器接到 host 元素上（两处页面共用）。
     优先用 UI.select 自绘下拉（替代原生 <select>：弹出层是系统控件、样式改不了）；
     UI 没加载时退回原生 select，功能等价。 */
  function wireModelSelect(sel) {
    if (!sel) return;
    var items = MODELS.map(function (m) {
      return { value: m.id, label: m.label, tag: m.tag, desc: m.desc };
    });
    var v = currentModel();
    if (MODELS.every(function (m) { return m.id !== v; })) v = MODEL_DEFAULT;
    if (window.UI && UI.select) {
      UI.select(sel, items, {
        value: v, onChange: setModel,
        small: /\bsm\b/.test(sel.className || ""),
        title: "识别模型（重新识别时生效）",
      });
      return;
    }
    sel.innerHTML = items.map(function (m) {
      return '<option value="' + m.value + '">' + m.label + "</option>";
    }).join("");
    sel.value = v;
    sel.addEventListener("change", function () { setModel(sel.value); });
  }
  var MAX_EDGE = 1600;      // 送模型前把长边缩到这个值（手机原图可能 4000px 高）
  var PAD = 80;             // 画布白边（刻度画在这一圈里，绝不压到试卷内容）
  var GRID = 100;           // 网格间距，单位是**原图像素**
  var LABEL_EVERY = 500;    // 每多少像素标一个数字
  var TIMEOUT_MS = 1200000;     // 绝对上限 20 分钟：再慢也不该超过这个
  var IDLE_TIMEOUT_MS = 600000; // 空闲超时：流式输出连续 10 分钟没有任何新字才算卡死

  var TYPE_SET = { choice: 1, fill: 1, calculate: 1, solve: 1, geometry: 1, proof: 1, other: 1 };

  // 与 Python 版 make_ruler_image.py 同一套配色
  var C_GRID = "#d8dce8", C_MAJOR = "#96a4cd", C_AXIS = "#6c7eb0", C_LABEL = "#344e94";

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("这张图片打不开（若是 iPhone 的 HEIC 原图，请改用相机输出 JPG，或先截屏再上传）"));
      };
      im.src = url;
    });
  }

  /* ---------------------------------------------------------------- 带刻度的图
     给图加"参考网格 + 边缘刻度"，让模型能**读出**坐标而不是凭印象估。
     刻度数字标的是**原图坐标**（网格线也按原图坐标的 100 倍数画），
     所以模型照着读出来的数字**就是**原图坐标，落库前不需要任何换算。 */
  function buildRulerCanvas(img) {
    var W = img.naturalWidth, H = img.naturalHeight;
    var scale = Math.min(1, MAX_EDGE / Math.max(W, H));
    var cw = Math.max(1, Math.round(W * scale)), ch = Math.max(1, Math.round(H * scale));

    var cv = document.createElement("canvas");
    cv.width = cw + PAD * 2;
    cv.height = ch + PAD * 2;
    var g = cv.getContext("2d");

    g.fillStyle = "#fff";
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, PAD, PAD, cw, ch);

    var fs = 19;
    g.font = "bold " + fs + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
    g.textBaseline = "middle";

    var tickMinor = 8, tickMajor = 22;

    // ---- 横轴 ----
    g.textAlign = "center";
    for (var ox = GRID; ox < W; ox += GRID) {
      var x = PAD + ox * scale;
      var major = (ox % LABEL_EVERY === 0);
      g.strokeStyle = major ? C_MAJOR : C_GRID;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, PAD); g.lineTo(x, PAD + ch); g.stroke();

      g.strokeStyle = C_AXIS;
      g.beginPath(); g.moveTo(x, PAD); g.lineTo(x, PAD - (major ? tickMajor : tickMinor)); g.stroke();
      g.beginPath(); g.moveTo(x, PAD + ch); g.lineTo(x, PAD + ch + (major ? tickMajor : tickMinor)); g.stroke();

      if (major) {
        g.fillStyle = C_LABEL;
        g.fillText(String(ox), x, PAD - tickMajor - fs / 2 - 4);
        g.fillText(String(ox), x, PAD + ch + tickMajor + fs / 2 + 4);
      }
    }

    // ---- 纵轴 ----
    g.textAlign = "right";
    for (var oy = GRID; oy < H; oy += GRID) {
      var y = PAD + oy * scale;
      var mj = (oy % LABEL_EVERY === 0);
      g.strokeStyle = mj ? C_MAJOR : C_GRID;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(PAD, y); g.lineTo(PAD + cw, y); g.stroke();

      g.strokeStyle = C_AXIS;
      g.beginPath(); g.moveTo(PAD, y); g.lineTo(PAD - (mj ? tickMajor : tickMinor), y); g.stroke();
      g.beginPath(); g.moveTo(PAD + cw, y); g.lineTo(PAD + cw + (mj ? tickMajor : tickMinor), y); g.stroke();

      if (mj) {
        g.fillStyle = C_LABEL;
        g.fillText(String(oy), PAD - tickMajor - 6, y);
        g.textAlign = "left";
        g.fillText(String(oy), PAD + cw + tickMajor + 6, y);
        g.textAlign = "right";
      }
    }

    // 内容区外框：告诉模型"框内才是试卷，框外是标尺"
    g.strokeStyle = C_AXIS;
    g.lineWidth = 2;
    g.strokeRect(PAD - 1, PAD - 1, cw + 2, ch + 2);

    return { canvas: cv, W: W, H: H, scale: scale, sentW: cv.width, sentH: cv.height };
  }

  /* ---------------------------------------------------------------- 调模型 */
  function parseJson(text) {
    var t = String(text || "").trim();
    // 模型偶尔还是套一层 ```json ```，这里兜一下
    var f = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (f) t = f[1].trim();
    var a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }

  async function callModel(dataUrl, W, H, model, onDelta) {
    var P = window.RECOGNIZE_PROMPT;
    if (!P) throw new Error("缺少提示词产物 js/recognize-prompt.js（跑 python tools/build_prompt.py 生成）");
    var cloud = window.CloudAPI && window.CloudAPI.cloud;
    if (!cloud || !cloud.llm) throw new Error("云 SDK 还没就绪，请刷新页面重试");

    var sys = P.system;
    var usr = P.user.replace(/\{W\}/g, String(W)).replace(/\{H\}/g, String(H));

    var messages = [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "text", text: usr },
        { type: "image_url", image_url: { url: dataUrl } },
      ] },
    ];

    var content = "", usage = null, finish = null;
    var t0 = Date.now();
    var timer = null, rejectTimeout = null;
    /* 双门槛：慢页只要还在出字就一直放行（空闲计时每次收到新内容就重置），
       只有"长时间一个字都不出"（卡死/限流挂起）或超过绝对上限才报超时。
       旧的 240s 总上限会把 space-bunny 这类慢模型的题多页误杀（160s+ 很常见）。 */
    var timeout = new Promise(function (_, rej) {
      rejectTimeout = rej;
    });
    function armIdle() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        rejectTimeout(new Error("识别超时（连续 " + Math.round(IDLE_TIMEOUT_MS / 1000)
          + " 秒没有任何输出，可能被限流），可以稍后重试这一页"));
      }, IDLE_TIMEOUT_MS);
    }
    armIdle();

    var run = (async function () {
      for await (var chunk of cloud.llm.chat.completions.create({
        model: model,
        messages: messages,
        stream: true,
        stream_options: { include_usage: true },
        response_format: { type: "json_object" },
      })) {
        var c0 = chunk.choices && chunk.choices[0];
        var d = c0 && c0.delta;
        if (d && d.content) {
          content += d.content;
          armIdle();          // 还在出字，空闲计时重置
          if (onDelta) onDelta(content.length);
        }
        if (c0 && c0.finish_reason) finish = c0.finish_reason;
        if (chunk.usage) usage = chunk.usage;
        if (Date.now() - t0 > TIMEOUT_MS) {
          throw new Error("识别超时（超过 " + Math.round(TIMEOUT_MS / 60000)
            + " 分钟仍未完成），可以稍后重试这一页");
        }
      }
      return { content: content, usage: usage, finish: finish, ms: Date.now() - t0 };
    })();

    try {
      return await Promise.race([run, timeout]);
    } catch (e) {
      var msg = (e && (e.message || (e.error && (e.error.message || e.error.code)))) || String(e);
      throw new Error("模型调用失败：" + msg);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- 归一化 */
  // 模型爱给板块名补句号（卷面确实印着「一、算一算。」），但题库里既有标注一律不带，
  // 不归一化的话同一板块会被当成两个，成卷/统计都会错。
  function normSection(s) {
    return String(s == null ? "" : s).trim().replace(/[。．.]+$/, "").replace(/\s+$/, "");
  }
  // 卷面印着 "A. 42"，但字母是版式元数据、由渲染层统一生成，写进 options 会重成「A. A. 42」。
  // 提示词里已经要求不带，这里再兜一道（模型偶尔还是会带）。
  function stripOptPrefix(s) {
    var out = String(s == null ? "" : s).replace(/^\s*[A-Da-d]\s*[.、．:：)）]\s*/, "");
    return out.length ? out : String(s == null ? "" : s);
  }

  /* 模型对绝对位置的感知偏弱（见文件头）。这里是**兜底**：refine.js 没加载、读像素
     失败、或本地吸附判定不可行时，才退回"外扩一个自适应余量"——宁可多带上下文，
     也不切掉内容。

     量是实测出来的（tools/reco_rows_compare.py 对账 tools/reco_e2e_check.mjs 的产物）：
       · 应用题页（一页 4~8 题，缩略图真正有用的场景）：模型原始偏差中位 +37px，
         ±40 就有 0.993 的覆盖率、±80 完全覆盖 —— 可用。
       · 密集计算页（一页 24 个口算/竖式，最坏情况）：偏差能到 -240px，要 ±250 才够，
         那时框已宽到页面的 47%。这种页面认了：题区缩略图会偏，但那些题目文字本身很短
         （「4×40=」）、看列表文字就够，真要对照可以点进单题页看整页原图。
     所以取一个折中：按框高的 35% 外扩，下限 40（短题也得给足余量）、上限 110（再大就跨列了）。 */
  function widen(box, k) {
    return [Math.round(box[0] - k), Math.round(box[1] - k), Math.round(box[2] + k), Math.round(box[3] + k)];
  }
  function fitBox(box, W, H) {
    return [clamp(box[0], 0, W), clamp(box[1], 0, H), clamp(box[2], 0, W), clamp(box[3], 0, H)];
  }
  function saneBox(b) {
    return b && b.length >= 4 && b[2] > b[0] && b[3] > b[1];
  }

  /* 一道题（模型原始输出）-> 题库行。
     ctx: { paperId, seq, filename, pageNo, W, H } */
  function toRow(q, ctx) {
    var W = ctx.W, H = ctx.H;

    // ---- 题区框：优先用 refine.js 的本地吸附结果，没有才外扩兜底 ----
    var src = {};
    var mb = q.bbox;
    if (saneBox(mb)) {
      var rb = q._rb;                       // recognizePage 里由 Refine.snap 挂上
      if (saneBox(rb)) {
        src.bbox = fitBox(rb, W, H);
      } else {
        var h = mb[3] - mb[1];
        src.bbox = fitBox(widen(mb, clamp(Math.round(h * 0.35), 40, 110)), W, H);
      }
    }

    // ---- 题干片段：图也要外扩（插图裁切最怕切边）----
    // 优先用 js/refine.js 的插图吸附结果（_sb，recognizePage 里挂上）；
    // 没有才退回「外扩 25%（30~80px）」——老策略，绝不比现在差。
    // 为什么插图也值得吸附：实测模型对插图的框是"偏 + 小 + 伸进旁边内容"（paper6 的
    // q35 整段落在广告下方、q32 混进学生笔迹），等量外扩只会把这个错误放大。
    var stem = [];
    (q.stem || []).forEach(function (f) {
      if (!f || !f.t) return;
      if (f.t === "figure") {
        var fb = f.bbox, sb = f._sb;
        var ob = saneBox(sb)
          ? fitBox(sb, W, H)
          : (saneBox(fb)
            ? fitBox(widen(fb, clamp(Math.round(Math.min(fb[2] - fb[0], fb[3] - fb[1]) * 0.25), 30, 80)), W, H)
            : null);
        stem.push({
          t: "figure", state: "crop", src: null, bbox: ob, expr: null, geometry: null,
          confidence: (typeof f.confidence === "number" ? f.confidence : null),
          caption: f.caption ? String(f.caption) : "",
        });
        return;
      }
      var v = String(f.v == null ? "" : f.v);
      if (!v) return;
      stem.push(f.t === "latex" ? { t: "latex", v: v } : { t: "text", v: v });
    });

    var options = (q.options || []).map(function (o) {
      if (!o) return null;
      if (typeof o === "string") return { t: "text", v: stripOptPrefix(o) };
      if (o.t === "latex") return { t: "latex", v: String(o.v || "") };
      return { t: "text", v: stripOptPrefix(o.v) };
    }).filter(function (o) { return o && o.v; });

    var conf = q.confidence || {};
    return {
      paper_id: ctx.paperId,
      seq: ctx.seq,
      qno: (typeof q.no === "number" ? q.no : null),
      printed_no: String(q.printed_no == null ? "" : q.printed_no),
      section: normSection(q.section),
      qtype: TYPE_SET[q.type] ? q.type : "other",
      stem: stem,
      options: options,
      source: {
        file: ctx.filename,
        page: ctx.pageNo,
        bbox: src.bbox || null,
      },
      confidence: {
        stem: typeof conf.stem === "number" ? conf.stem : null,
        options: typeof conf.options === "number" ? conf.options : null,
        figure: typeof conf.figure === "number" ? conf.figure : null,
      },
    };
  }

  /* ---------------------------------------------------------------- 识别后自检
     识别结果里"机器能先替人挑出来"的硬伤。判据全部是**形式**上的（不需要看懂
     数学对错），命中就挂一条理由，页面只让人复核这几处。

     实测依据（2026-10-11 paper6 重扫后逐题对照片核过）：那次 12 处文字错里，
     `[?]`、算子形变（`×`→`÷`）、题号错位各占一部分；但"漏尾"（`4×8-11=` → `4×8=`）
     和"认错名字"这类**形式完全合法**的错，机器判不出来 —— 所以这套东西
     **只减不增**人工量，别指望它兜底。

     ⚠️ 判据宁可漏报、不可误报：误报多了人会习惯性忽略标记，真错反而被淹掉。
        所以每条都只在"确定是硬伤"时才命中（例如 `=` 结尾是正常的作答位，不算可疑）。 */
  var AUDIT_CONF_MIN = 0.7;                                  // 与 render.js 的 hasDoubt 同口径
  // ⚠️ 集合里**不含等号**：`4×8-11=` 这种以 `=` 结尾是正常的作答位，含进去就全页误报。
  var AUDIT_OP = "\\+\\-×÷*/＋－";
  var AUDIT_RUN = new RegExp("[" + AUDIT_OP + "]{2,}");        // 连用：`12-+`、`5×÷`
  var AUDIT_TAIL = new RegExp("[" + AUDIT_OP + "]\\s*$");      // 尾随运算符：`4×8-`
  var AUDIT_HEAD = /^\s*[×÷*/＋－]/;                            // 首字符是乘除：`×8=`
  var AUDIT_PAIRS = [["（", "）"], ["(", ")"], ["【", "】"], ["［", "］"], ["[", "]"]];

  function auditText(q) {
    var parts = [];
    (q.stem || []).forEach(function (f) {
      if (f && f.t !== "figure" && f.v != null) parts.push(String(f.v));
    });
    (q.options || []).forEach(function (o) { if (o && o.v != null) parts.push(String(o.v)); });
    return parts.join(" ").replace(/\s+/g, " ");
  }
  function auditParen(s) {
    for (var i = 0; i < AUDIT_PAIRS.length; i++) {
      if (s.split(AUDIT_PAIRS[i][0]).length !== s.split(AUDIT_PAIRS[i][1]).length) return true;
    }
    return false;
  }

  /* 单题自检（单题页直接用）。返回理由数组，空数组 = 没挑出硬伤。 */
  function auditOne(q) {
    var out = [];
    if (!q) return out;
    var text = auditText(q);
    var bare = text.replace(/\s/g, "");
    var hasFig = (q.stem || []).some(function (f) { return f && f.t === "figure"; });

    if (/\[\?\]/.test(text)) out.push("有无法辨认的字符 [?]");
    if (!bare && !hasFig) out.push("题干是空的");
    if (q.qtype === "choice" && (q.options || []).length < 2) out.push("选择题选项不足 2 个");
    if (bare && (AUDIT_RUN.test(text) || AUDIT_TAIL.test(text) || AUDIT_HEAD.test(text) || auditParen(text))) {
      out.push("算式形式可疑（可能认漏或认错）");
    }
    var c = q.confidence || {};
    var low = Object.keys(c).filter(function (k) {
      return typeof c[k] === "number" && c[k] < AUDIT_CONF_MIN;
    });
    if (low.length) out.push("识别置信度偏低（" + low.join("、") + "）");
    return out;
  }

  /* 整卷自检（卷详情页用）：单题判据 + 两条"跨题"判据（题号断续、题干重复）。
     返回 { flags: {seq: [理由…]}, suspect, total } —— flags 只放有理由的题。 */
  function auditPaper(rows) {
    rows = rows || [];
    var flags = {};
    function put(key, why) {
      key = String(key);
      if (!flags[key]) flags[key] = [];
      if (flags[key].indexOf(why) < 0) flags[key].push(why);
    }
    function keyOf(q) { return q.seq == null ? q.id : q.seq; }

    rows.forEach(function (q) {
      auditOne(q).forEach(function (w) { put(keyOf(q), w); });
    });

    // ① 题号连续：同一份卷里 qno 应严格 +1 递增。跳号/回退 = 漏题或串题
    //    （paper6 那次重扫第 1 页第三行的框与题序就是错位的）。
    var prevQno = null, prevKey = null;
    rows.forEach(function (q) {
      if (typeof q.qno !== "number") return;
      var k = keyOf(q);
      if (prevQno != null && q.qno !== prevQno + 1) {
        put(k, "题号不连续（上一题是 " + prevQno + "）");
        if (prevKey != null) put(prevKey, "题号不连续（下一题是 " + q.qno + "）");
      }
      prevQno = q.qno; prevKey = k;
    });

    // ② 题干完全重复：模型偶尔会把上一题复制下来（"计算"这种两字题干不算）
    var seen = {};
    rows.forEach(function (q) {
      var t = auditText(q).replace(/\s/g, "");
      if (t.length < 4) return;
      var k = keyOf(q);
      if (seen[t] != null) put(k, "与第 " + seen[t] + " 题题干完全一样");
      else seen[t] = (q.qno != null ? q.qno : q.seq);
    });

    return { flags: flags, suspect: Object.keys(flags).length, total: rows.length };
  }

  /* ---------------------------------------------------------------- 单页识别
     opts: { file, model, onDelta }
     返回 { questions: **模型给的原始数组**（未归一化）, rawCount, W, H, usage, credit, ms }
     —— 归一化（toRow）与写库都在 recognizePaper 里做。这一层刻意只做"看图说话"，
        好让离线对账（tools/recog_pilot.mjs / reco_e2e_check.mjs）拿到未经加工的模型输出。 */
  async function recognizePage(opts) {
    var model = opts.model || MODEL_DEFAULT;
    var img = await loadImage(opts.file);
    var W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error("读不到图片尺寸，这张照片可能已损坏");

    var built = buildRulerCanvas(img);
    var dataUrl = built.canvas.toDataURL("image/jpeg", 0.86);
    // 画布用完就放掉，手机上几千像素的 canvas 很占内存
    built.canvas.width = built.canvas.height = 0;

    var res = await callModel(dataUrl, W, H, model, opts.onDelta);
    var parsed;
    try {
      parsed = parseJson(res.content);
    } catch (e) {
      throw new Error("模型返回的不是合法 JSON（可能被截断），这一页可以重试。片段：" +
        res.content.slice(0, 160).replace(/\s+/g, " "));
    }
    var qs = parsed && parsed.questions;
    if (!qs || !qs.length) throw new Error("这一页没有识别到题目（模型返回了空列表）");

    // ---- 本地坐标吸附（js/refine.js）：模型框 → 卷面真实墨迹 ----
    // 任何失败都只是"没有精修"，不影响识别本身（toRow 会退回外扩 35% / 25%）。
    var refineInfo = { used: false, ms: null, figs: 0 };
    if (window.Refine) {
      // ① 题区框：结构判据 + 单调对齐（行带级）
      if (window.Refine.snap) {
        try {
          var list = [];
          qs.forEach(function (q, i) {
            if (saneBox(q.bbox)) list.push({ i: i, bbox: q.bbox });
          });
          var tR = Date.now();
          var snapped = window.Refine.snap({ image: img, boxes: list, params: { workMax: MAX_EDGE } });
          refineInfo.ms = Date.now() - tR;
          if (snapped && snapped.boxes) {
            qs.forEach(function (q, i) {
              var rb = snapped.boxes[i];
              if (rb && saneBox(rb)) q._rb = rb;
            });
            refineInfo.used = true;
          }
        } catch (e) { /* 吸附崩了就当没有，走兜底 */ }
      }
      // ② 插图框：图形块吸附（与题区是两套判据，见 refine.js 的 snapFigures）
      //    结果直接挂在 stem 片段对象上（toRow 读 f._sb），吸附失败的图不挂 → 走外扩。
      if (window.Refine.snapFigures) {
        try {
          var figs = [], fi = 0;
          qs.forEach(function (q) {
            (q.stem || []).forEach(function (f) {
              if (f && f.t === "figure" && saneBox(f.bbox)) figs.push({ i: fi++, f: f, bbox: f.bbox });
            });
          });
          if (figs.length) {
            var fsn = window.Refine.snapFigures({
              image: img,
              boxes: figs.map(function (t) { return { i: t.i, bbox: t.bbox }; }),
              params: { workMax: MAX_EDGE },
            });
            if (fsn && fsn.boxes) {
              figs.forEach(function (t) {
                var sb = fsn.boxes[t.i];
                if (sb && saneBox(sb)) { t.f._sb = sb; refineInfo.figs++; }
              });
            }
          }
        } catch (e) { /* 同上，走兜底 */ }
      }
    }

    return {
      rawCount: qs.length,
      questions: qs,
      W: W, H: H,
      refine: refineInfo,
      usage: res.usage || null,
      credit: (res.usage && typeof res.usage.credit === "number") ? res.usage.credit : null,
      ms: res.ms,
      finish: res.finish,
    };
  }

  /* ---------------------------------------------------------------- 只重扫一页
     上传了 N 张照片时，某一页认砸了不必把整卷重掷（整卷重扫会把其它页现在对的、
     甚至手工改过的题一起换掉）。这里只动这一页：
       ① 先识别这一张 —— **模型失败时数据一个字节都没动**（这是它比整卷重扫好的地方）；
       ② 才删这一页的旧题（只删这些 id，其它页的 id 保持不变）；
       ③ 插回新题；
       ④ 把这卷的 seq 按「原顺序里这一页那一段原地替换」重排一遍，顺序不乱。
     opts: { paperId, page, file, filename, model, onProgress }
     onProgress 沿用 recognizePaper 的 phase 口径（page-start / page-done / saved）。 */
  async function rescanPage(opts) {
    var paperId = opts.paperId, page = opts.page, filename = opts.filename;
    var model = opts.model || MODEL_DEFAULT;
    var progress = opts.onProgress || function () {};
    if (!opts.file) throw new Error("这一页的照片没取回来，没法重扫");

    /* 单页重扫也算一次识别（同样要花钱），先扣再动数据。 */
    if (window.CloudAPI && window.CloudAPI.consumeRecognition) {
      await window.CloudAPI.consumeRecognition();
    }

    // ① 先识别：失败就直接抛，下面一行都不会执行
    progress({ phase: "page-start", index: 0, total: 1, filename: filename });
    var res = await recognizePage({ file: opts.file, model: model });
    var rows = res.questions.map(function (q) {
      return toRow(q, {
        paperId: paperId, seq: 0, filename: filename, pageNo: page, W: res.W, H: res.H,
      });
    });
    if (!rows.length) throw new Error("这一页没识别出题目，已保留原来的结果不动");
    progress({ phase: "page-done", index: 0, total: 1, filename: filename,
               count: rows.length, credit: res.credit });

    var cur = await window.CloudAPI.listQuestions(paperId);
    var mine = window.CloudAPI.pageRowsOf(cur, page, filename);
    var mineIds = {};
    mine.forEach(function (q) { mineIds[String(q.id)] = 1; });

    /* 目标顺序 = 现有顺序里把"这一页那一段"原地换成新题。
       这样其它页的相对顺序、以及它们在各板块里的先后都保持原样。 */
    var order = [], placed = false;
    cur.forEach(function (q) {
      if (mineIds[String(q.id)]) {
        if (!placed) {
          placed = true;
          rows.forEach(function (r) { order.push(r); });
        }
        return;
      }
      order.push(q);
    });
    if (!placed) {
      // 这页原来没有题（上一次重扫失败的页）：插在"页号比它小的题"后面
      var at = 0;
      order.forEach(function (q, i) {
        var p = Number((q.source || {}).page);
        if (!isNaN(p) && p > 0 && p < Number(page)) at = i + 1;
      });
      order = order.slice(0, at).concat(rows, order.slice(at));
    }

    /* 先插后删：删失败最多留下重复的旧题（看得见、能再删），
       反过来先删后插万一插失败就是**这一页的题全没了**，不可接受。
       删的是**刚才抓到的旧 id**（不能按页重查：新题也是这一页，会被一起删掉）。
       新题的 seq 先给一串比谁都大的临时值，最后统一重排。 */
    var maxSeq = cur.reduce(function (m, q) { return Math.max(m, Number(q.seq) || 0); }, 0);
    rows.forEach(function (r, i) { r.seq = maxSeq + 1 + i; });
    var saved = await window.CloudAPI.insertQuestions(rows);
    var idByTmp = {};
    (saved || []).forEach(function (r) { idByTmp[r.seq] = r.id; });
    rows.forEach(function (r) { r.id = idByTmp[r.seq] != null ? idByTmp[r.seq] : r.id; });

    var removed = await window.CloudAPI.deleteQuestionsByIds(mine.map(function (q) { return q.id; }));

    var seqRows = order.map(function (q, i) {
      return { id: q.id, cur: Number(q.seq) || 0, seq: i + 1 };
    });
    await window.CloudAPI.setQuestionSeqs(seqRows);

    await window.CloudAPI.updatePaper(paperId, {
      status: "done", question_count: order.length,
      status_note: "已重扫第 " + page + " 页（" + rows.length + " 题），其余页保持原样",
    });

    progress({ phase: "saved", total: 1, questions: rows.length, failed: [], credit: res.credit || 0 });
    return {
      page: page, count: rows.length, replaced: removed, total: order.length,
      credit: res.credit, note: "第 " + page + " 页重扫完成，共 " + rows.length + " 题",
    };
  }

  /* ---------------------------------------------------------------- 整卷识别
     opts: { paperId, pages: [{file, filename, pageNo}], model, replace, onProgress }
       replace=true 时先清掉这卷已存的题目（重新识别用）
     onProgress({ phase, index, total, filename, count, error, credit })
       phase: page-start / page-done / page-fail / saved */
  async function recognizePaper(opts) {
    var pages = opts.pages || [];
    if (!pages.length) throw new Error("这份卷没有登记原图，无法识别");

    var progress = opts.onProgress || function () {};
    var seq = 0, totalQ = 0, credits = 0, failed = [];
    var model = opts.model || MODEL_DEFAULT;

    /* 先记一次「识别次数」，再动任何数据：次数不够就直接抛，旧题一个字节都没动。
       （本地演示默认不限，这个调用会直接返回。） */
    if (window.CloudAPI && window.CloudAPI.consumeRecognition) {
      await window.CloudAPI.consumeRecognition();
    }

    if (opts.replace) {
      await window.CloudAPI.deleteQuestions(opts.paperId);
      await window.CloudAPI.updatePaper(opts.paperId, { question_count: 0 });
    }

    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i];
      progress({ phase: "page-start", index: i, total: pages.length, filename: pg.filename });
      try {
        var res = await recognizePage({ file: pg.file, model: model });
        var rows = res.questions.map(function (q) {
          seq += 1;
          return toRow(q, {
            paperId: opts.paperId, seq: seq,
            filename: pg.filename, pageNo: pg.pageNo,
            W: res.W, H: res.H,
          });
        });
        await window.CloudAPI.addQuestions(rows);
        totalQ += rows.length;
        if (res.credit) credits += res.credit;
        progress({ phase: "page-done", index: i, total: pages.length, filename: pg.filename,
                   count: rows.length, credit: res.credit, questions: rows });
      } catch (e) {
        failed.push({ filename: pg.filename, pageNo: pg.pageNo, error: e.message || String(e) });
        progress({ phase: "page-fail", index: i, total: pages.length, filename: pg.filename,
                   error: e.message || String(e) });
      }
    }

    var status = failed.length ? (totalQ ? "done" : "failed") : "done";
    var note = failed.length
      ? ("已识别 " + totalQ + " 题；" + failed.length + " 页失败：" +
         failed.map(function (f) { return f.filename + "（" + f.error + "）"; }).join("；"))
      : "自动识别完成，共 " + totalQ + " 题";

    await window.CloudAPI.updatePaper(opts.paperId, {
      status: status, question_count: totalQ, status_note: note,
    });

    progress({ phase: "saved", total: pages.length, questions: totalQ, failed: failed, credit: credits });
    return { questions: totalQ, failed: failed, credit: credits, status: status, note: note };
  }

  window.Recognize = {
    MODEL_DEFAULT: MODEL_DEFAULT,
    MODELS: MODELS,
    currentModel: currentModel,
    setModel: setModel,
    wireModelSelect: wireModelSelect,
    buildRulerCanvas: buildRulerCanvas,
    normalizeRow: toRow,          // 给自检脚本用
    auditOne: auditOne,           // 识别后自检（单题 / 整卷），页面与自检脚本共用
    auditPaper: auditPaper,
    recognizePage: recognizePage,
    recognizePaper: recognizePaper,
    rescanPage: rescanPage,
  };
})();
