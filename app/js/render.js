/* 题目渲染：把识别结果（schema v2）画成网页。
   这一份是 engine/render.py 前端版，两边规则必须一致（符号内联 SVG、运算符走 KaTeX、
   题干里的换行 -> <br>、[?] 高亮）。改任何一条请同步改 Python 那份。

   与 Python 版的唯一实质差别：**不预先裁图**。原图在云存储里，网页按 source.bbox
   从原图实时"抠"出那一块（cropBox），所以不需要往云端写任何裁剪文件。 */
(function () {
  "use strict";

  var TYPE_TEXT = {
    choice: "选择题", fill: "填空题", calculate: "计算题",
    solve: "解答题", geometry: "几何题", proof: "证明题", other: "其他",
  };

  // ---- 数学运算符：text 片段里的这些字符也要交给 KaTeX，才能跟 latex 片段视觉一致 ----
  var OPMAP = { "×": "\\times", "÷": "\\div", "+": "+", "-": "-", "=": "=", "<": "<", ">": ">" };
  var OPRE = /[×÷+=<>-]/g;

  // ---- 占位/几何符号：字体自带字形偏小且大小不一，统一用内联 SVG 等宽绘制 ----
  //      viewBox 紧贴墨迹 -> .sym 的宽高就是墨迹尺寸（见 css/app.css 的 .sym.*）
  var SYM_DEFS = {
    "□": ["box",    "0 0 100 100", '<rect x="5.5" y="5.5" width="89" height="89" rx="9" %A%/>', 11, false],
    "■": ["box",    "0 0 100 100", '<rect x="0" y="0" width="100" height="100" rx="9" %A%/>', 0, true],
    "○": ["circle", "0 0 100 100", '<circle cx="50" cy="50" r="44.5" %A%/>', 11, false],
    "●": ["circle", "0 0 100 100", '<circle cx="50" cy="50" r="50" %A%/>', 0, true],
    "△": ["tri",    "0 0 100 95",  '<path d="M50 5.5 L94.5 89.5 H5.5 Z" %A%/>', 11, false],
    "▲": ["tri",    "0 0 100 95",  '<path d="M50 0 L100 95 H0 Z" %A%/>', 0, true],
    "☆": ["star",   "0 0 94.6 90.4",
          '<path d="M47.3 4.5 L57.4 35.6 L90.1 35.6 L63.7 54.8 L73.8 85.9 L47.3 66.7 '
        + 'L20.9 85.9 L31 54.8 L4.5 35.6 L37.2 35.6 Z" %A%/>', 9, false],
    "★": ["star",   "0 0 95.1 90.4",
          '<path d="M47.6 0 L58.8 34.6 L95.1 34.6 L65.7 55.9 L76.9 90.4 L47.6 69.1 '
        + 'L18.2 90.4 L29.4 55.9 L0 34.6 L36.3 34.6 Z" %A%/>', 0, true],
  };

  function symSvg(viewBox, shape, stroke, solid) {
    var paint = solid ? 'fill="currentColor"'
      : 'fill="none" stroke="currentColor" stroke-width="' + stroke + '" stroke-linejoin="round"';
    return '<svg viewBox="' + viewBox + '" aria-hidden="true">' + shape.replace("%A%", paint) + "</svg>";
  }

  var SYMBOLS = {};
  Object.keys(SYM_DEFS).forEach(function (ch) {
    var d = SYM_DEFS[ch];
    SYMBOLS[ch] = [d[0], symSvg(d[1], d[2], d[3], d[4])];
  });

  var SYM_RE = /[□○△☆■●▲★]/g;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function symbols(s) {
    return String(s).replace(SYM_RE, function (m) {
      var e = SYMBOLS[m];
      return e ? '<span class="sym ' + e[0] + '" title="' + m + '">' + e[1] + "</span>" : m;
    });
  }

  /* text 片段里的运算符 -> KaTeX 行内式。两侧 {} 空组把它变成**二元算子**，
     KaTeX 才会留出与 `268\times4` 一样的左右间距（只包字符会被当独原子、贴得紧紧的）。
     数字 / 方框（另有内联 SVG）/ 留空括号都不动。 */
  function mathify(s) {
    return String(s).replace(OPRE, function (m) { return "\\(" + "{}" + OPMAP[m] + "{}" + "\\)"; });
  }

  /* 把原图的某一块"抠"出来显示：不落盘、纯 CSS。
     container 宽 = 容器宽，高由 bbox 宽高比决定；img 放大到 原图宽/bbox宽 倍，
     再用 translate（百分比相对图片自身尺寸）把目标区域推到左上角。分辨率无关。

     img: {url, w, h}  w/h = 原图像素尺寸；bbox: [x1,y1,x2,y2] 原图像素坐标 */
  function cropBox(img, bbox, alt) {
    if (!img || !img.url || !img.w || !img.h) return '<div class="cropbox failed"></div>';
    if (!bbox || bbox.length < 4) return '<div class="cropbox failed"></div>';
    var x1 = bbox[0], y1 = bbox[1], x2 = bbox[2], y2 = bbox[3];
    var bw = Math.max(1, x2 - x1), bh = Math.max(1, y2 - y1);
    var wPct = (img.w / bw) * 100;          // 图片宽度 = 容器宽的多少倍
    var tx = -(x1 / img.w) * 100;           // 相对图片自身宽度的平移
    var ty = -(y1 / img.h) * 100;
    return '<div class="cropbox loading" style="aspect-ratio:' + bw + '/' + bh + '">'
      + '<img src="' + esc(img.url) + '" alt="' + esc(alt || "原图裁切") + '"'
      + ' style="width:' + wPct.toFixed(3) + '%;height:auto;'
      + 'transform:translate(' + tx.toFixed(3) + '%,' + ty.toFixed(3) + '%)"'
      + ' onload="this.parentNode.classList.remove(\'loading\')"'
      + ' onerror="this.parentNode.classList.remove(\'loading\');this.parentNode.classList.add(\'failed\')">'
      + "</div>";
  }

  function typeText(d) { return TYPE_TEXT[d && d.type != null ? d.type : (d && d.qtype)] || (d && (d.type || d.qtype)) || "其他"; }

  function overallConf(d) {
    var c = (d && d.confidence) || {};
    var vals = Object.keys(c).map(function (k) { return c[k]; })
      .filter(function (v) { return typeof v === "number"; });
    if (!vals.length) return "-";
    var s = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    return s.toFixed(2);
  }

  /* 0~1 的裸置信度用户读不懂 —— 换成 高/中/偏低 + 百分比 */
  function confLevel(d) {
    var raw = overallConf(d);
    if (raw === "-") return "未评估";
    var pct = Math.round(parseFloat(raw) * 100);
    return (pct >= 90 ? "高" : pct >= 75 ? "中" : "偏低") + " · " + pct + "%";
  }

  /* 可疑理由：优先用页面注入的 _flags（recognize.js 的 auditOne/auditPaper 算出来的，
     判据比自己这套全：算式形式、题号断续、题干重复…）；没有才退回"只看 [?] 与低置信度"。 */
  function hasDoubt(d) {
    if (d && d._flags && d._flags.length) return d._flags.join("；");
    var c = (d && d.confidence) || {};
    var low = Object.keys(c).filter(function (k) { return typeof c[k] === "number" && c[k] < 0.7; });
    var unk = (d && d.stem || []).some(function (s) { return s && s.t === "text" && String(s.v || "").indexOf("[?]") >= 0; });
    var parts = [];
    if (unk) parts.push("题干含 [?]");
    if (low.length) parts.push("低置信度：" + low.join("、"));
    return parts.join("；");
  }

  function typeDist(items) {
    var c = {};
    (items || []).forEach(function (q) { var t = typeText(q); c[t] = (c[t] || 0) + 1; });
    return Object.keys(c).sort(function (a, b) { return c[b] - c[a] || (a < b ? -1 : 1); })
      .map(function (k) { return k + " " + c[k]; }).join(" · ");
  }

  /* 题内插图的**显示外观**（2026-10-11 用户要求：编辑时要能切图、调显示大小、调显示位置）。
     全站共用一套口径，字段落在 figure 片段上（引擎给的 bbox/rot 另有含义，这些是人工改的）：
       seg.dw   = 显示大小，30~100 的百分数（100 = 该容器的默认大小，不存字段）
       seg.pos  = 显示位置 'l' / 'c' / 'r'（不存 = 跟随各页默认落位：题目页按文字流排、
                  卷面里应用题靠右 / 带图选择题贴选项右侧，见 sheet.js）
       seg.wrap = true 时图浮起来、题干文字绕到另一侧（只有 pos 为 l / r 才成立）
       seg.img  = 这张图是从哪张原图上切的（文件名）。多张照片的卷子里，插图不一定和
                  题干在同一张照片上 —— 不记下来，渲染时就会拿题干那页去抠，抠出来是错的。

     ⚠️ 定位为什么要**外面再套一层**：.figbox 是 inline-block（收缩包装，宽度由里面的图决定），
     直接给它 display:block 会撑满整栏（图突然变成通栏大）；inline-block 又不认 margin auto。
     所以位置靠外层 .figwrap 的 text-align 摆，图自己的宽度一点不变（实测：包裹前 203px、
     包裹后还是 203px，只是右边缘贴到了题栏右边缘）。
     ⚠️ 大小用 zoom 而不是 max-width：同一个原因 —— 百分比 max-width 对收缩包装的 inline-block
     不起作用（块宽只有 203px，50% 的题栏宽 286px 根本碰不到），只有整体缩放才等比变小。

     返回三段：wrap = 外层包裹类 / cls = 图自己的类 / style = 内联 --fdw（挂最外层，里层继承）。
     卷面（.gitem）另有一套：那边 .figbox 是块级、宽度有定值（--figw），位置用 margin auto 摆，
     所以 sheet.js 会把外面这层包裹拆掉（见 sheet.js 的 figHtml）。 */
  var FPOS = { l: "fp-l", c: "fp-c", r: "fp-r" };
  function figView(seg) {
    var dw = Math.round(Number(seg && seg.dw) || 0);
    var out = { wrap: "", cls: "", style: "" };
    if (dw >= 30 && dw < 100) out.style = ' style="--fdw:' + dw + '"';
    var p = (seg && seg.pos) || "", wrap = !!(seg && seg.wrap);
    if (FPOS[p]) {
      if (wrap && p !== "c") out.cls = " fw-" + p;     // 环绕：图自己浮起来，文字绕另一侧
      else { out.cls = " " + FPOS[p]; out.wrap = "figwrap " + FPOS[p]; }
    }
    return out;
  }
  /* 这道题里有图被人工定过位置吗？定了就让位给用户 —— 卷面的题型默认落位
     （应用题靠右、带图选择题贴选项右侧）不能再盖掉它。 */
  function figPosFixed(q) {
    return !!((q && q.stem) || []).some(function (s) {
      return s && s.t === "figure" && (s.pos || s.wrap);
    });
  }

  /* 单个片段 -> HTML。ctx 提供原图（题内插图要用 bbox 从原图抠）。 */
  function frag(seg, ctx, data) {
    if (!seg) return "";
    if (seg.t === "latex") return "\\(" + String(seg.v == null ? "" : seg.v) + "\\)";
    if (seg.t === "figure") {
      var cap = seg.caption ? '<span class="figcap">' + esc(seg.caption) + "</span>" : "";
      var fv = figView(seg), box;
      /* --fdw 挂在 .figbox 自己身上：缩放规则（.stem/.fthumb 的 zoom）与打印链的
         .fig 宽高都从它取值；包裹层只负责摆位置 */
      var attrs = ' class="figbox' + (seg.fix ? " fixed" : "") + fv.cls + '"' + fv.style;
      /* 人工微调摆正后烤出来的成品图（seg.fix = data URI）—— 直接用，不再按 bbox 现裁。
         不能用 seg.src：引擎数据里 src 是预裁子图路径（data/crops/…），含义不同。 */
      if (seg.fix) {
        box = "<span" + attrs + '><img class="figimg" src="' + esc(seg.fix)
          + '" alt="' + esc(seg.caption || "题内插图") + '">' + cap + "</span>";
      } else {
        /* seg.img 记了"这张图是从哪张原图上切的"就用它 —— 多张照片的卷子里，插图可能
           在另一张照片上（见 figView 上面的说明）；老数据没这个字段，仍按题干那页。 */
        var img = ctx && ctx.imageFor
          ? ctx.imageFor(seg.img ? { source: { file: seg.img } } : data) : null;
        if (img && seg.bbox) {
          box = "<span" + attrs + ">"
            + cropBox(img, seg.bbox, seg.caption || "题内插图") + cap + "</span>";
        } else {
          return '<span class="figtag">［图 · ' + esc(seg.caption || "见左栏原图") + "］</span>" + cap;
        }
      }
      /* 需要摆位置才套外层（默认不套：保持"图跟在文字流里"的老样子） */
      return fv.wrap ? '<span class="' + fv.wrap + '">' + box + "</span>" : box;
    }
    // 题目里的换行 = 卷面上同一小题的第二行 -> <br>
    // ⚠️ 顺序不能反：先 mathify（此时还是纯文本，`<` 才能被识别并包进 KaTeX），
    //    再 esc（转义 `<`），最后 symbols（插 SVG）。反过来的话 mathify 会把 SVG 里的
    //    stroke-width / aria-hidden 连字符也包成 KaTeX，SVG 直接坏掉。
    return symbols(esc(mathify(String(seg.v == null ? "" : seg.v))))
      .replace(/\[\?\]/g, '<span class="qmark">[?]</span>')
      .replace(/\n/g, "<br>");
  }

  function stemHtml(data, ctx) {
    return (data.stem || []).map(function (s) { return frag(s, ctx, data); }).join(" ");
  }

  function optionsHtml(data, ctx) {
    if (!data.options || !data.options.length) return "";
    return '<div class="opts"><div class="lbl">选项</div><div class="box">'
      + data.options.map(function (o, i) {
          return "<b>" + String.fromCharCode(65 + i) + ".</b> " + frag(o, ctx, data);
        }).join("<br>")
      + "</div></div>";
  }

  function stemPreview(data, limit) {
    limit = limit || 120;
    var parts = (data.stem || []).map(function (s) {
      if (s.t === "latex") return "\\(" + String(s.v || "") + "\\)";
      if (s.t === "figure") return "［" + (s.caption ? s.caption : "图") + "］";
      return mathify(String(s.v == null ? "" : s.v));
    });
    var text = parts.join(" ").replace(/\n/g, " ");
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  }

  /* 让 KaTeX 渲染页面上所有 \\( ... \\)（调用前请先插入 HTML）。 */
  function typeset(el) {
    if (!window.renderMathInElement || !el) return;
    try {
      window.renderMathInElement(el, {
        delimiters: [{ left: "\\(", right: "\\)", display: false }],
        throwOnError: false,
      });
    } catch (e) { /* 渲染失败不影响文字显示 */ }
  }

  /* ---- 打印层用的标点规范化（只影响打印，不动数据）----
     与 engine/paper.py 的 fix_punct 同一口径：中文旁边的 ,;?! 转全角、留空括号统一成（　　），
     算式的 . , 不碰。 */
  var PUNCT_MAP = { ",": "，", ";": "；", "?": "？", "!": "！" };
  function fixPunct(s) {
    s = String(s == null ? "" : s);
    s = s.replace(/([，。；：、？！）】》”\u4e00-\u9fa5])\s*([,;?!])/g, function (m, a, b) { return a + PUNCT_MAP[b]; });
    s = s.replace(/([,;?!])(?=[\u4e00-\u9fa5]|$)/g, function (m, b) { return PUNCT_MAP[b]; });
    s = s.replace(/（\s*）/g, "（\u3000\u3000）").replace(/\(\s*\)/g, "（\u3000\u3000）");
    return s;
  }

  window.Render = {
    TYPE_TEXT: TYPE_TEXT,
    esc: esc,
    symbols: symbols,
    mathify: mathify,
    cropBox: cropBox,
    frag: frag,
    figView: figView,
    figPosFixed: figPosFixed,
    stemHtml: stemHtml,
    optionsHtml: optionsHtml,
    stemPreview: stemPreview,
    typeText: typeText,
    overallConf: overallConf,
    confLevel: confLevel,
    hasDoubt: hasDoubt,
    typeDist: typeDist,
    typeset: typeset,
    fixPunct: fixPunct,
  };
})();
