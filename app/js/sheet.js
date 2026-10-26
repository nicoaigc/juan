/* ============================================================================ 卷面渲染引擎
   Sheet —— 把「一组板块」画成 A4 卷面 HTML。

   print.html（打印 / 校对）与 compose.html（组卷台）共用这一份，别再各写一套。
   职责边界：
     · 本文件只管**画**：题号方案、按题型分板块、照片卷按原卷版面还原、选项分栏、书写区留白；
     · 交互（拖拽、就地改标题、切列数、编号面板）在 js/sheet-edit.js；
     · 数据（板块顺序 / 列数 / 题号方案存哪、怎么存）由页面自己定。

   题号方案是模块级状态：Sheet.getNo() / Sheet.setNo(o)，渲染前由页面或 SheetEd 设好。
   序号一律**按位置现算、不落数据** —— 所以交换第一、二大题之后序号自动跟着换。
   ============================================================================ */
var Sheet = (function () {
  "use strict";

  /* 草稿类板块不进卷面；识别存疑（题干带 [?]）的题也不进卷面。 */
  var SKIP_SECTION = ["草稿", "笔迹", "卷面草稿"];

  // 书写区高度（mm）：先按板块名推断（与 engine/paper.py 的口径一致），未命中再按题型兜底
  var BOX_H = [
    ["竖式", 30], ["递等式", 26], ["综合算式", 12], ["解决问题", 30], ["应用", 30], ["计算", 0],
  ];

  function boxHeight(section) {
    for (var i = 0; i < BOX_H.length; i++) if (String(section).indexOf(BOX_H[i][0]) >= 0) return BOX_H[i][1];
    return -1;   // 板块名未命中（"未分板块"/"估算"这类），交给 boxFor 按题型兜底
  }

  /* 每题的书写区高度：板块名命中（含"计算"=0 的显式命中）就用板块值；
     未命中时按题型兜底 —— 解答/几何/证明题留 30mm，填空/选择/计算类不留，
     题型缺失再看题干是不是问句（应用题特征）。否则"未分板块"里的应用题整段没有答题空间。 */
  function boxFor(q, section) {
    var h = boxHeight(section);
    if (h >= 0) return h;
    var t = (q && (q.qtype || q.type)) || "";
    if (t === "solve" || t === "geometry" || t === "proof") return 30;
    if (t === "fill" || t === "choice" || t === "calculate") return 0;
    var text = (q.stem || []).map(function (s) { return s && s.t === "text" ? String(s.v || "") : ""; }).join("");
    if (/[？?]/.test(text) && !/____|（\s*）|□|○/.test(text)) return 30;
    return 0;
  }

  /* ---------------------------------------------------------------- 照片卷：按原卷版面还原 */
  function leftEdges(items) {
    return items.map(function (q) { return q.source && q.source.bbox ? q.source.bbox[0] : null; })
      .filter(function (v) { return typeof v === "number"; });
  }

  function gapClusters(xs, gap) {
    var cs = [[xs[0]]];
    for (var i = 1; i < xs.length; i++) {
      if (xs[i] - cs[cs.length - 1][cs[cs.length - 1].length - 1] > gap) cs.push([xs[i]]);
      else cs[cs.length - 1].push(xs[i]);
    }
    return cs;
  }

  /* 孤立小簇并入最近大簇：中列某题起始 x 偏右会造出只含 1 题的伪列，
     把 3 列数成 4 列。判据：与大簇（≥2 题）代表点距离 < 半个列距（大簇间距中位数）。 */
  function mergeOutliers(cs) {
    for (var k = 0; k < 6; k++) {
      var big = cs.filter(function (c) { return c.length >= 2; });
      if (big.length < 2) break;
      var reps = big.map(function (c) { return Math.min.apply(null, c); });
      var gaps = [];
      for (var i = 1; i < reps.length; i++) gaps.push(reps[i] - reps[i - 1]);
      var pitch = gaps.slice().sort(function (a, b) { return a - b; })[gaps.length >> 1];
      var best = null;
      cs.forEach(function (c) {
        if (c.length >= 2) return;
        reps.forEach(function (r, j) {
          var d = Math.abs(c[0] - r);
          if (!best || d < best.d) best = { d: d, c: c, j: j };
        });
      });
      if (!best || best.d >= 0.5 * pitch) break;
      big[best.j].push.apply(big[best.j], best.c);
      cs.splice(cs.indexOf(best.c), 1);
    }
    return cs;
  }

  function clusterCount(xs, gap) {
    if (!xs.length) return 1;
    return mergeOutliers(gapClusters(xs.slice().sort(function (a, b) { return a - b; }), gap)).length;
  }

  /* 列数按"照片分别聚类再取最小"（engine/paper.py 的 infer_cols 同一口径）：
     一份卷拍成多张照片时，同一大题在不同照片上列数可能不同，全部题一起聚类会得到伪列数。
     列距阈值随版面宽度伸缩：真列距 ≥ 版面宽的 1/3（3 列）或 1/2（2 列），
     而题号缩进/长短造成的左边界差通常 < 0.1×宽 —— 固定 40px 会把「两道全宽应用题
     左边界差 103px」误判成两列（paper4 踩过）。 */
  function inferCols(items) {
    var byFile = {}, counts = [];
    items.forEach(function (q) {
      var f = (q.source && (q.source.file || q.source.paper)) || "_";
      (byFile[f] = byFile[f] || []).push(q);
    });
    Object.keys(byFile).forEach(function (k) {
      var g = byFile[k];
      if (g.length <= 1) return;   // 只 1 道题的照片不参与（否则一道残题把大题压成一列）
      var x1 = null, x2 = null;
      g.forEach(function (q) {
        var b = q.source && q.source.bbox;
        if (!b) return;
        if (x1 === null || b[0] < x1) x1 = b[0];
        if (x2 === null || b[2] > x2) x2 = b[2];
      });
      var gap = Math.max(40, Math.round(((x2 - x1) || 0) * 0.15));
      counts.push(clusterCount(leftEdges(g), gap));
    });
    var n = counts.length ? Math.min.apply(null, counts) : 1;
    return Math.max(1, Math.min(n, 4, items.length));   // 上限 4 列
  }

  function hasUnknown(q) {
    return (q.stem || []).some(function (s) { return s && s.t === "text" && String(s.v || "").indexOf("[?]") >= 0; });
  }

  /* 空 / "未分板块" 一律视为没有板块名：卷面上不印板块标题 */
  function sectionOf(q) {
    var s = String(q.section || "").trim();
    return (!s || s === "未分板块") ? "" : s;
  }

  /* 这道题能不能进卷面：草稿类板块（笔迹 / 卷面草稿）不要，识别存疑（题干带 [?]）也不要。
     collect() 与页面都在用同一条判据 —— 分开放的话，只筛一处的版本会让 [?] 题漏到卷面上
     （照片卷打印页曾经就是：SheetEd 拿到的题目池没筛，重画一次存疑题就冒出来了）。 */
  function usable(q) {
    var sec = sectionOf(q);
    if (SKIP_SECTION.some(function (k) { return sec.indexOf(k) >= 0; })) return false;
    if (hasUnknown(q)) return false;
    return true;
  }

  function usableList(questions) { return (questions || []).filter(usable); }

  function collect(questions) {
    var order = [], by = {};
    questions.forEach(function (q) {
      if (!usable(q)) return;
      var sec = sectionOf(q);
      if (!by[sec]) { by[sec] = []; order.push(sec); }
      by[sec].push(q);
    });
    return order.map(function (sec) {
      var items = by[sec], cols = inferCols(items);
      /* 板块名没命中、靠题型兜底留白的应用题板块：独占整行（多列会把 30mm 答题框挤扁）。
         但只限**长文字题干**的真应用题 —— 递等式这类纯算式 qtype 也是 solve，
         若也压成 1 列就会把原卷的多列布局整个改掉（paper4 踩过）。 */
      function isWordy(q) {
        return (q.stem || []).some(function (s) {
          return s.t === "text" && String(s.v || "").replace(/\s+/g, "").length >= 15;
        });
      }
      if (boxHeight(sec) < 0 && items.some(function (q) { return boxFor(q, sec) >= 20; })
          && items.every(isWordy)) cols = 1;
      return { title: sec, items: items, cols: cols };
    });
  }

  /* ---------------------------------------------------------------- 自建卷：按题型分板块 */
  /* 板块顺序固定（选择→填空→计算→判断→解答→几何→证明→其他）；标题只存"纯名"，
     **序号按板块在卷面上的位置现算**（见 fullTitle / noText）。
     [桶键, 板块名, 默认列数] */
  /* 分桶口径在 js/qtype.js（首页统计 / 组卷台 / 卷面 / 打印共用一份，见该文件注释）。 */
  var Q = window.QType;
  var TYPE_SECTION = Q.TYPE_SECTION;
  var TYPE_TITLE = Q.TYPE_TITLE;
  var TYPE_SHORT = Q.TYPE_SHORT;
  var TYPE_ALIAS = Q.TYPE_ALIAS;
  var SEC_RULES = Q.SEC_RULES;
  var normBucket = Q.normBucket;
  var typeIndex = Q.typeIndex;
  var stripSecNo = Q.stripSecNo;
  var secBucket = Q.secBucket;
  var LAY_MAX_COLS = 4;

  /* 用户手动改过的题型（layout.types = {题目id: 桶}）：优先级最高，且跟排版一起存，
     换台机器打开也一致。这是"这份卷子"的本地覆盖，不属于通用口径，所以留在这一层。 */
  var OVERRIDES = {};
  function setBuckets(o) {
    OVERRIDES = {};
    if (o) Object.keys(o).forEach(function (k) { OVERRIDES[k] = normBucket(o[k]); });
    return OVERRIDES;
  }
  function buckets() { return OVERRIDES; }

  /* 一道题属于哪个板块桶：本卷手改的覆盖 > 通用口径（板块名 > 题型） */
  function bucketOf(q) {
    if (!q) return "other";
    if (q.id != null && OVERRIDES[q.id]) return OVERRIDES[q.id];
    return Q.bucketOf(q);
  }

  /* ---------------------------------------------------------------- 题号方案（大题 / 小题各一套）
     一套 = 是否显示 + 数字形式（中文/阿拉伯/大写字母/小写字母）+ 包裹样式（顿号、点、圆括号…）。
     真正落数据的只有 layout.numbering，所以换台机器打开也一致。 */
  var NO_STYLES = [
    ["cn",  "中文数字 一"],
    ["num", "阿拉伯数字 1"],
    ["ABC", "大写字母 A"],
    ["abc", "小写字母 a"],
  ];
  /* [键, 前缀, 后缀]：键就是「包裹」下拉的值，"无"的键是空串 */
  var NO_WRAPS = [
    ["",   "",  ""],
    ["、", "",  "、"],
    [".",  "",  "."],
    ["．", "",  "．"],
    ["（）", "（", "）"],
    ["()", "(", ")"],
    ["【】", "【", "】"],
    ["[]", "[", "]"],
  ];
  var NO_DEF = {
    big:   { show: true, style: "cn",  pre: "", suf: "、" },
    small: { show: true, style: "num", pre: "", suf: "." },
  };

  /* 中文数字到 99（十、十一、二十三…），再多就直接用阿拉伯数字 */
  function cnNum(n) {
    var d = "零一二三四五六七八九";
    if (n <= 10) return n === 10 ? "十" : (d[n] || String(n));
    if (n < 20) return "十" + d[n - 10];
    if (n < 100) return d[Math.floor(n / 10)] + "十" + (n % 10 ? d[n % 10] : "");
    return String(n);
  }

  /* i 是 0 基的序号；spec 见 NO_DEF。不显示时返回空串。 */
  function noText(i, spec) {
    if (!spec || !spec.show) return "";
    var s;
    if (spec.style === "cn") s = cnNum(i + 1);
    else if (spec.style === "ABC") s = String.fromCharCode(65 + (i % 26));
    else if (spec.style === "abc") s = String.fromCharCode(97 + (i % 26));
    else s = String(i + 1);
    return (spec.pre || "") + s + (spec.suf || "");
  }

  /* 大题标题里「一、」和「选择题」之间的缝：裸数字或半角点才补空格（"1. 选择题"），
     顿号 / 括号 / 全角点是中文习惯，贴着写（"一、选择题"、"（一）选择题"）。 */
  function noGap(spec) {
    return (spec.pre === "" && (spec.suf === "" || spec.suf === ".")) ? " " : "";
  }

  /* 把存进 layout 的东西（可能是旧版、可能是空的、可能被改坏）规范成一套合法的 spec。
     注意：只有真的带了 pre/suf 才去认包裹 —— 否则空对象会被「无包裹」那一项匹配上，
     把默认的顿号 / 句点清成空。 */
  function normSpec(o, def) {
    o = o || {};
    var out = { show: def.show, style: def.style, pre: def.pre, suf: def.suf }, i;
    if (o.show != null) out.show = !!o.show;
    for (i = 0; i < NO_STYLES.length; i++) if (NO_STYLES[i][0] === o.style) out.style = o.style;
    if (o.pre != null || o.suf != null) {
      for (i = 0; i < NO_WRAPS.length; i++) {
        if (String(o.pre == null ? "" : o.pre) === NO_WRAPS[i][1]
          && String(o.suf == null ? "" : o.suf) === NO_WRAPS[i][2]) {
          out.pre = NO_WRAPS[i][1]; out.suf = NO_WRAPS[i][2]; break;
        }
      }
    }
    return out;
  }

  function normNo(o) {
    return { big: normSpec(o && o.big, NO_DEF.big), small: normSpec(o && o.small, NO_DEF.small) };
  }

  /* spec 对应「包裹」下拉里的哪一项 */
  function wrapKey(spec) {
    for (var i = 0; i < NO_WRAPS.length; i++) {
      if (NO_WRAPS[i][1] === (spec.pre || "") && NO_WRAPS[i][2] === (spec.suf || "")) return NO_WRAPS[i][0];
    }
    return "";
  }

  /* 卷面上真正要印的大题标题：自建卷 = 位置序号 + 纯名；照片卷 = 原卷标题原样（还原原卷）。
     数据里 title 只存纯名（"选择题"），旧 layout 里带序号的老写法（"一、选择题"）读进来时剥掉。 */
  function fullTitle(s, si) {
    var raw = s.title || "";
    if (!s.autoNo) return raw;
    var name = stripSecNo(raw);
    if (!name) return "";
    var no = noText(si, spec.big);
    return no ? no + noGap(spec.big) + name : name;
  }

  /* 板块是不是「计算题」——决定要不要印小题号。先看板块自己认出来的桶
     （显式 type 或板块名关键词），最后看板块里是不是清一色计算题。 */
  function isCalcSec(s, items) {
    var b = secBucket(s);
    if (b) return b === "calc";
    var its = items || (s && s.items) || [];
    return its.length > 0 && its.every(function (q) { return bucketOf(q) === "calc"; });
  }

  /* 这个板块要不要印小题号：板块自己设过就以它为准（板块行上的 # 按钮），
     没设过就按题型默认 —— 计算题不编号（一整块直接写答案）。
     全局「小题序号 - 显示」关掉的话，一律不印。 */
  function smallNoFor(s, items) {
    if (!spec.small.show) return false;
    if (s && s.smallNo === true) return true;
    if (s && s.smallNo === false) return false;
    return !isCalcSec(s, items);
  }

  /* 括号里的小题号一律**按最终顺序重编**（跨卷混排后原卷题号必然重复，不能直接印）；
     每个板块都从 1 起，不是全卷连号。 */
  function numberItems(sec) {
    var show = smallNoFor(sec, sec.items);
    sec.items.forEach(function (q, j) {
      q._no = show ? noText(j, spec.small) : "";
    });
  }

  /* 列数：计算题默认 3 列（纯算式排得下），其余题型一律 1 列；
     题数比列数还少时就按题数收窄。 */
  function colsForSection(def, items) {
    return Math.max(1, Math.min(def[2], items.length));
  }

  function copyQ(q) {
    var c = {};
    for (var k in q) if (Object.prototype.hasOwnProperty.call(q, k)) c[k] = q[k];
    return c;
  }

  function clampCols(c) {
    c = parseInt(c, 10);
    if (!c || c < 1) c = 1;
    return c > LAY_MAX_COLS ? LAY_MAX_COLS : c;
  }

  /* 板块简称：卷面统计那行显示用（"二、应用题" -> "应用题"） */
  function secLabel(t) {
    if (!t) return "";
    var p = String(t).split(/[、·]/);
    return p[p.length - 1].trim();
  }

  /* 智能排版：把题目按题型分板块（板块顺序 = TYPE_SECTION 的先后）。
     用的是 bucketOf —— 先认卷面板块名，再退回模型题型，见上面 SEC_RULES。 */
  function collectByType(questions) {
    var by = {}, order = [];
    questions.forEach(function (q) {
      var k = bucketOf(q);
      if (!by[k]) { by[k] = []; order.push(k); }
      by[k].push(q);
    });
    order.sort(function (a, b) { return typeIndex(a) - typeIndex(b); });
    return order.map(function (k) {
      var def = TYPE_SECTION[typeIndex(k)];
      var items = by[k].map(copyQ).map(function (q) { q._no = ""; return q; });
      var sec = { title: def[1], type: k, autoNo: true, items: items,
                  cols: colsForSection(def, items) };
      numberItems(sec);
      return sec;
    });
  }

/* 按 manual（layout.sections）拼出卷面。动手之前先理顺两件事，
   否则「卷面上第几道题」会和 manual.ids 对不上：
     ① 清掉已不在题库里的 id（原卷被删 / 被移出这份卷）；
     ② 不在任何板块里的题（组卷台后来加的）按题型并入同名板块，没有就新开一个。
   keepEmpty：编辑态要保留空板块（先建好、还没往里拖题的那种），打印态不要。
   opt.autoNo（默认 true）：大题序号由**板块位置**现算 —— 自建卷的规矩，标题只存纯名。
     照片卷传 false：板块标题就是**原卷印的那行字**（"概念部分·一、填空" 自带序号），
     不能再剥再生成 —— 否则会变成"一、概念部分·一、填空"，或者丢序号。
     同一开关也决定小题号：false 时不重编，沿用识别存的原卷题号（printed_no）。 */
function buildFromManual(m, byId, allQs, keepEmpty, opt) {
  opt = opt || {};
  var auto = opt.autoNo !== false;
  m.forEach(function (s) {
    s.title = auto ? stripSecNo(s.title) : String(s.title == null ? "" : s.title);
    s.ids = (s.ids || []).map(Number).filter(function (i) { return !!byId[i]; });
    s.cols = clampCols(s.cols);
  });
    var used = {};
    m.forEach(function (s) { s.ids.forEach(function (i) { used[i] = 1; }); });
    (allQs || []).forEach(function (q) {
      var i = Number(q.id);
      if (used[i]) return;
      used[i] = 1;
      var k = bucketOf(q);
      var name = TYPE_TITLE[k] || "其他";
      var hit = null;
      for (var j = 0; j < m.length; j++) {
        if (secBucket(m[j]) === k || stripSecNo(m[j].title).indexOf(name) >= 0) { hit = m[j]; break; }
      }
      if (!hit) {
        hit = { title: name, type: k, cols: TYPE_SECTION[typeIndex(k)][2], ids: [] };
        m.push(hit);
      }
      hit.ids.push(i);
    });
    var out = m.map(function (s) {
      var items = s.ids.map(function (i) { return copyQ(byId[i]); });
      var sec = { title: auto ? stripSecNo(s.title) : String(s.title == null ? "" : s.title),
                  type: s.type || "", autoNo: auto,
                  smallNo: s.smallNo, cols: clampCols(s.cols), items: items };
      if (auto) numberItems(sec);
      /* 不重编题号时把 _no 清成 null —— itemHtml 见 null 才回落到原卷题号 printed_no */
      else items.forEach(function (q) { q._no = null; });
      return sec;
    });
    if (!keepEmpty) out = out.filter(function (s) { return s.items.length; });
    return out;
  }

  /* ---------------------------------------------------------------- 题目渲染 */
  /* 结构行：①②… / （1）(2) / 1. 1、2．/ 一、二、 —— 只认真正的列表标记，
     不认普通数字开头的句子（"490 元够买 7 箱吗？"不是新小项） */
  var MARK_RE = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]|^（\s*[一二三四五六七八九十\d]+\s*）|^\(\s*[一二三四五六七八九十\d]+\s*\)|^\d+\s*[.、．]|^[一二三四五六七八九十]{1,3}\s*、/;

  function flowText(t) {
    var lines = String(t || "").split("\n"), out = lines[0] || "";
    for (var i = 1; i < lines.length; i++) {
      var cur = lines[i];
      if (!cur.trim()) { out += "\n"; continue; }          // 空行保留（段落分隔）
      var prevTail = out.trim().slice(-1);
      if (prevTail === "：" || prevTail === ":" || MARK_RE.test(cur.trim())) out += "\n" + cur;
      else out += cur.replace(/^\s+/, "");                 // 拼回句子流，去掉行首缩进
    }
    return out;
  }

  /* 判断题末尾补作答括号（　　）：题干本身已带空括号就不重复补 */
  function judgeBracket(q) {
    if (!/判断/.test(String(q.section || ""))) return "";
    var plain = (q.stem || []).map(function (s) { return s.t === "text" ? String(s.v || "") : ""; }).join("");
    if (/（[^）]*）|\([^)]*\)/.test(plain)) return "";
    return '<span class="judge-mark">（　　）</span>';
  }

  /* 选项按「列」排：列宽随内容伸缩，一排放不下就把整个选项换到下一排（不折选项内部文字）。
     宽度按 em 估算：汉字/全角记 1em，其它字符 0.55em，"A. " 前缀记 1.4em。
     maxEm 给了就用它当可用宽度（带图的选择题里选项只占左半边，见 figChoice）。 */
  function emWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      w += (c > 0x2e80) ? 1 : 0.55;
    }
    return w;
  }

  function optsHtml(q, ctx, cols, maxEm) {
    var GAP_EM = 2.2;                     // 选项之间至少留这么多
    var SHEET_EM = 43;                    // A4 卷面内容区宽度（12pt 字号下约 43em）
    maxEm = maxEm || Math.max(8, SHEET_EM / Math.max(1, cols || 1));
    var items = q.options.map(function (o, i) {
      var t = (o && o.v != null) ? String(o.v) : "";
      return {
        html: '<span class="opt"><b>' + String.fromCharCode(65 + i) + ".</b> " + Render.frag(o, ctx, q) + "</span>",
        em: 1.4 + emWidth(t),
      };
    });
    var rows = [], cur = [], curW = 0;
    items.forEach(function (it) {
      var add = (cur.length ? GAP_EM : 0) + it.em;
      if (cur.length && curW + add > maxEm) { rows.push(cur); cur = []; curW = 0; add = it.em; }
      cur.push(it); curW += add;
    });
    if (cur.length) rows.push(cur);
    /* 行数定了之后把选项按行数**均衡分配**：4 个中等长度的选项排 2+2，而不是 3+1 */
    if (rows.length > 1) {
      var per = Math.ceil(items.length / rows.length);
      rows = [];
      for (var i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per));
    }
    return '<div class="opts-inline">' + rows.map(function (r) {
      /* 列宽按内容比例分配（下限 4em），短选项也能排成分栏的效果 */
      var weights = r.map(function (it) { return Math.max(it.em, 4); });
      var sum = weights.reduce(function (a, b) { return a + b; }, 0);
      return '<div class="optrow" style="grid-template-columns:' + weights.map(function (w) {
        return (w / sum * 100).toFixed(3) + "%";
      }).join(" ") + '">' + r.map(function (it) { return it.html; }).join("") + "</div>";
    }).join("") + "</div>";
  }

  /* 编辑态里每道题右上角浮出的就地操作条：题型小标（可改）、↑↓ 板块内换位、← → 换板块，
     canRemove 时多一个 ×（从这份卷子里移出，只有组卷台需要）。
     哪个方向能用、能不能用，渲染时就算好传进来，省得用户点了个没反应的箭头。 */
  function qbarHtml(m) {
    if (!m) return "";
    function b(act, txt, ok, title) {
      return '<button type="button" class="ico" data-act="' + act + '" title="' + title + '"'
        + (ok ? "" : " disabled") + ">" + txt + "</button>";
    }
    return '<span class="qbar no-print">'
      + (m.bucket
          ? '<button type="button" class="ico qchip" data-act="qtype"'
            + ' title="这道题归在哪个大题 —— 点一下可以改">'
            + Render.esc(TYPE_SHORT[m.bucket] || "其他") + "</button>"
          : "")
      + b("qup", "&uarr;", m.up, "上移一位")
      + b("qdown", "&darr;", m.down, "下移一位")
      + b("qprev", "&larr;", m.left, "移到上一个板块")
      + b("qnext", "&rarr;", m.right, "移到下一个板块")
      + (m.del ? b("qdel", "&times;", true, "把这题从这份卷子里移出") : "")
      + "</span>";
  }

  /* ---------------------------------------------------------------- 插图尺寸
     题内插图默认宽度：普通题 68mm，带图的选择题右栏 62mm（见 css 的 --figw）。
     排版态可以拖图片右边缘那条手柄改大小（交互在 sheet-edit.js），改过的记进
     layout.figs = {题目id: mm} —— 跟题型覆盖一样，是"这一份卷子本地的设置"，
     跟着排版一起存，换台机器打开还是那么大。 */
  var FIG_W_DEF = 68, FIG_W_DUO = 62, FIG_W_MIN = 20, FIG_W_MAX = 170;
  var MM_PER_EM = 25.4 / 72 * 12;         /* 12pt 字号下 1em ≈ 4.233mm */
  var FIGW = {};
  /* 手柄：只有排版态才渲染（itemHtml 里看 meta）。带 .no-print，打印不会印到纸上。 */
  var FIG_HANDLE = '<span class="figh no-print" draggable="false"'
    + ' title="拖动调整图片大小（双击恢复默认）"><span class="fighw"></span></span>';

  function clampFigW(mm) {
    mm = Math.round(Number(mm) || 0);
    if (!mm) return 0;
    return Math.max(FIG_W_MIN, Math.min(FIG_W_MAX, mm));
  }
  function setFigW(o) {
    FIGW = {};
    if (o) Object.keys(o).forEach(function (k) { var w = clampFigW(o[k]); if (w) FIGW[k] = w; });
    return FIGW;
  }
  function figws() { return FIGW; }
  /* 这道题的插图宽度（mm）：改过用改过的，没改过用题型默认。
     题型默认还要乘「显示大小」—— 编辑里把图调到 70%，卷面上的默认宽也跟着变 70%
     （用户要求：编辑时要能调图片显示大小；改过大小就把 figure 片段上的 dw 带上）。
     排版态拖手柄拖出来的宽度是**绝对毫米**，不再乘 dw（用户拖到多大就是多大）。 */
  function dwOf(q) {
    var d = 0;
    ((q && q.stem) || []).forEach(function (s) {
      if (!d && s && s.t === "figure") {
        var v = Math.round(Number(s.dw) || 0);
        if (v >= 30 && v < 100) d = v;
      }
    });
    return d || 100;
  }
  function figWidthOf(q, dflt) {
    var w = q && q.id != null ? clampFigW(FIGW[q.id]) : 0;
    return w || Math.max(FIG_W_MIN, Math.round((dflt || FIG_W_DEF) * dwOf(q) / 100));
  }
  function figWidthMm(q) { return figWidthOf(q, figChoice(q) ? FIG_W_DUO : FIG_W_DEF); }

  /* ---------------------------------------------------------------- 图下说明文字
     识别时给每张题内插图补的那行小字（figure.caption，如「图：24×4 的竖式，框住的是
     20×4 这一步」）是**识别过程的备注**，印在卷面上往往多余（有时还跟原卷印的图注打架）。
     排版态里每张图右下角有个小按钮，点一下就能把这行字逐张移掉，再点一下恢复。
     移掉了哪几张记进 layout.caps = {题目id: [图序号…]} —— 图序号 = 这道题 stem 里第几个
     figure 片段（从 0 起），跟 layout.figs 一样是"这一份卷子本地的设置"，跟着排版存。 */
  var CAPS = {};
  function capKey(q) { return q && q.id != null ? String(q.id) : ""; }
  function setCaps(o) {
    CAPS = {};
    if (o) Object.keys(o).forEach(function (k) {
      var a = o[k];
      if (!a || !a.length) return;
      CAPS[k] = [].slice.call(a).map(Number)
        .filter(function (n) { return n >= 0; })
        .sort(function (x, y) { return x - y; });
    });
    return CAPS;
  }
  function caps() { return CAPS; }
  /* 这张图的说明是不是被移掉了（打印、预览也一样不印） */
  function capOff(q, fi) {
    var k = capKey(q);
    return !!(k && CAPS[k] && CAPS[k].indexOf(fi) >= 0);
  }
  /* 把图下那行说明从片段 HTML 里摘掉（figure 渲染出来就是 .figcap 这一个 span） */
  function stripCap(html) {
    return String(html).replace(/\s*<span class="figcap">[\s\S]*?<\/span>/, "");
  }
  /* 说明文字开关：挂在插图右下角（.figbox 内绝对定位，只有排版态出现、带 .no-print）。
     现在有这行说明 -> 显示「说明 ✕」；已经被移掉 -> 显示「说明 ↺」提示能恢复。 */
  function figCapBtn(fi, off) {
    return '<button type="button" class="figcapbtn no-print" draggable="false"'
      + ' data-act="figcap" data-fi="' + fi + '"'
      + ' title="' + (off ? "点一下恢复这行说明文字" : "移除图片下面这行说明文字") + '">'
      + "说明 " + (off ? "&#8635;" : "&#10005;") + "</button>";
  }

  /* 题内插图：有图就不能跟文字抢同一行 —— 图是**块级**独占一行（见 css 的 .gitem .figbox），
     多列板块里还要跨整行，否则一张竖式图被挤在 1/3 列里根本看不清。 */
  function hasFigure(q) {
    return !!q && (q.stem || []).some(function (s) { return s && s.t === "figure"; });
  }

  /* 应用题的插图**靠右**（用户要求）：左边整块留给学生写算式 —— 与本地成卷链路
     engine/paper.py 的 .figwrap-right 是同一条规矩，两边看着才一致。
     但这只是**题型默认落位**：编辑里给图手工定过位置（pos / 环绕）的题就让位给用户，
     别再把人家挪到右边去（见 render.js 的 figView / figPosFixed）。 */
  function figRight(q) {
    return hasFigure(q) && bucketOf(q) === "solve" && !Render.figPosFixed(q);
  }

  /* 带图的选择题：**选项在左、插图在右**（用户要求）。这类题（如「下面用竖式算出了…，
     框住的这一步表示的是（ ）」）图是主体，选项是四个短句，左右并排一行读完，
     比"图独占一行、选项甩到图下面"省一半高度，也更像卷面上的排法。
     左半边可用宽度由 itemHtml 按插图实际宽度现算（图调大，选项那栏就让位）。
     同样只是**题型默认**：编辑里手工定过位置的图不走这条（图要独占一行按用户选的位置排）。 */
  function figChoice(q) {
    return hasFigure(q) && !!(q.options && q.options.length) && bucketOf(q) === "choice"
      && !Render.figPosFixed(q);
  }

  /* meta：编辑态传 {si, qi, up, down, left, right[, del]}，其余（照片卷、预览）传 null。
     带上 data-si/data-qi，拖拽落点和按钮就能直接定位到题，不用从 DOM 反推位置。 */
  function itemHtml(q, ctx, boxH, cols, meta) {
    // 自建卷用重编的序号（_no），照片卷用卷面原题号（printed_no）
    var noTxt = q._no != null ? q._no : q.printed_no;
    var no = noTxt ? '<span class="qn">' + Render.esc(noTxt) + "</span> " : "";
    /* 带图的选择题：插图从文字流里摘出来，单独放右栏（选项在左栏），见 figChoice。
       其余题型插图仍留在文字流里（块级独占一行）。 */
    var duo = figChoice(q);
    /* 插图宽度（mm）：排版态拖手柄改的就是它，落在 .gitem 的 --figw 上，
       css 里 .figbox 的 max-width 与 .figduo 的右栏宽度都读这个变量。 */
    var fw = hasFigure(q) ? figWidthMm(q) : 0;
    /* 插图片段。fi = 这是这道题的第几张图（0 起）—— 图下说明的开关按「题 + 第几张图」记。
       排版态在 .figbox 内部（绝对定位）挂两样东西：右缘的"拖大拖小"手柄 + 右下角的说明开关。 */
    function figHtml(s, fi) {
      var html = Render.frag(s, ctx, q);
      /* 用户把这行说明移掉了 —— 打印、预览、排版都不印（所以放在 meta 判断之前） */
      if (capOff(q, fi)) html = stripCap(html);
      /* 位置（pos）在题目页靠外层 .figwrap 的 text-align 摆；卷面这里 .figbox 是块级、
         宽度有定值（--figw），位置用 margin auto 摆（见 css 的 .gitem .figbox.fp-*），
         所以把外面那层包裹拆掉 —— 留着它反而挡住下面挂手柄的位置判断。 */
      var m = /^<span class="figwrap fp-[lcr]">([\s\S]*)<\/span>$/.exec(html);
      if (m) html = m[1];
      if (!meta || html.indexOf('<span class="figbox') !== 0) return html;
      /* 手柄/说明开关要落在 .figbox **里面**（它们是相对图定位的绝对定位件）：
         没有包裹层时最后一个 </span> 就是图的收尾，有包裹层时是倒数第二个 —— 上面已经
         把包裹拆掉了，所以这里取最后一个就够。 */
      var i = html.lastIndexOf("</span>");
      if (i < 0) return html;
      return html.slice(0, i) + FIG_HANDLE + figCapBtn(fi, capOff(q, fi)) + html.slice(i);
    }
    /* 一道题内部的子项（（1）（2）①②…）各自要有答题空间：遇到下一个子项行时插一段留白
       收掉上一个子项，最后一个子项由题末的 box 收尾 —— (1)(2) 两小题就有两块答题区。
       共享题面（首个子项之前）不留白；没有留白的题（boxH=0）整题不插。 */
    var chunks = [], figs = [], lastWasLine = false, seenSub = false, fn = -1;
    (q.stem || []).forEach(function (s) {
      if (s.t === "figure") fn++;                    // 这道题的第几张图（说明开关按它记）
      if (s.t === "figure" && duo) { figs.push(figHtml(s, fn)); return; }
      if (s.t === "text") {
        flowText(String(s.v || "")).split("\n").forEach(function (ln) {
          var isSub = !!boxH && MARK_RE.test(ln.trim());
          if (lastWasLine) {
            if (isSub && seenSub) chunks.push('<div class="box-after" style="height:' + boxH + 'mm"></div>');
            else chunks.push("<br>");
          }
          if (isSub) seenSub = true;
          lastWasLine = true;
          chunks.push(Render.symbols(Render.esc(Render.fixPunct(ln))));
        });
        return;
      }
      lastWasLine = false;
      chunks.push(figHtml(s, fn));
    });
    var body = chunks.join(" ") + judgeBracket(q);
    /* 带图选择题的左栏可用宽度 = 卷面 43em − 图那栏（含列距）—— 图调大后左栏要跟着让位，
       否则选项会被挤到图下面去。 */
    var optsEm = duo ? Math.max(8, 43 - Math.round(fw / MM_PER_EM + 1)) : null;
    var opts = (q.options && q.options.length) ? optsHtml(q, ctx, cols, optsEm) : "";
    var box = boxH ? '<div class="box-after" style="height:' + boxH + 'mm"></div>' : "";
    /* 左右并排：左 = 选项，右 = 插图。插图多张也排在同一栏里。 */
    if (figs.length) {
      body += '<div class="figduo"><div class="figcol-opts">' + opts + "</div>"
        + '<div class="figcol-fig">' + figs.join("") + "</div></div>";
      opts = "";
    }
    return '<div class="gitem' + (hasFigure(q) ? " wide" : "") + (figRight(q) ? " figright" : "") + '"'
      + (fw ? ' style="--figw:' + fw + 'mm"' : "")
      + (meta ? ' data-si="' + meta.si + '" data-qi="' + meta.qi + '" draggable="true"' : "")
      + (q.id != null ? ' data-qid="' + Render.esc(String(q.id)) + '"' : "")
      + ">" + qbarHtml(meta) + no + body + opts + box + "</div>";
  }

/* 板块标题那一行（编辑态替代 .sec-title）：整行都是控件，打印时隐藏。
     ≡ 拖动换板块顺序；序号是**自动**的（只读，交换板块后自己变）；标题就地改纯名；
     1/2/3/4 切列数；# 切这个板块要不要小题号；右侧板块上移/下移/删除。
   opt.autoNo === false（照片卷）：标题框里放的是**原卷标题原文**（含"一、"），
     所以不显示自动序号，也没有 # 那个小题号开关（题号沿用原卷，不重编）。 */
function secEditHtml(s, si, n, items, opt) {
  opt = opt || {};
  var auto = opt.autoNo !== false;
  var showSmallNo = auto && opt.smallNo !== false;
  var cols = clampCols(s.cols);
  var no = auto ? noText(si, spec.big) : "";
  var sno = showSmallNo ? smallNoFor(s, items) : false;
  return '<div class="sec-edit no-print" data-si="' + si + '">'
    + '<span class="sec-grip" draggable="true" title="拖动调整板块顺序">&equiv;</span>'
    + (no ? '<span class="sec-no" title="序号按板块位置自动生成，不用自己写">' + no + "</span>" : "")
    + '<input type="text" class="sec-tinp" data-title="' + si + '" maxlength="24"'
    + ' value="' + Render.esc(auto ? stripSecNo(s.title) : String(s.title == null ? "" : s.title))
    + '" placeholder="板块标题（可留空）">'
    + '<span class="sec-colsw" title="这个板块排几列">'
    + [1, 2, 3, 4].map(function (c) {
        return '<button type="button" class="ccol' + (cols === c ? " on" : "") + '"'
          + ' data-sec="' + si + '" data-act="scols" data-set="' + c + '">' + c + "</button>";
      }).join("")
    + "</span>"
    + (showSmallNo
        ? '<button class="ico' + (sno ? " on" : "") + '" data-sec="' + si + '" data-act="sno"'
          + ' title="' + (sno ? "这个板块印小题号，点一下不印" : "这个板块不印小题号，点一下印上") + '">#</button>'
        : "")
    + '<button class="ico" data-sec="' + si + '" data-act="sup" title="板块上移"'
    + (si === 0 ? " disabled" : "") + ">&uarr;</button>"
    + '<button class="ico" data-sec="' + si + '" data-act="sdown" title="板块下移"'
    + (si === n - 1 ? " disabled" : "") + ">&darr;</button>"
    + '<button class="ico del" data-sec="' + si + '" data-act="sdel" title="删掉这个板块（题并入相邻板块）"'
    + (n === 1 ? " disabled" : "") + ">&times;</button>"
    + "</div>";
}

  /* sections -> 一整张长卷面（一个 .sheet）。真正的 A4 分页交给 paginate()：
     先把内容按浏览器的排法排出来，再按页拆 —— 这样高度是实测的，不是估的。 */
  function sheetHtml(sections, paper, ctx, ed, eopts) {
    eopts = eopts || {};
    // 卷头只印标题；没有标题就整个卷头都不渲染
    var hasTitle = paper && paper.title && paper.title !== "未命名试卷";
    var head = hasTitle
      ? '<div class="paper-head"><div class="t">' + Render.esc(paper.title) + "</div></div>"
      : "";
    var body = sections.map(function (s, si) {
      var full = fullTitle(s, si);
      var title = ed
        ? secEditHtml(s, si, sections.length, s.items,
            { autoNo: eopts.autoNo, smallNo: eopts.smallNo })
        : (full ? '<div class="sec-title">' + Render.esc(full) + "</div>" : "");
      var inner = s.items.map(function (q, qi) {
        return itemHtml(q, ctx, boxFor(q, s.title), s.cols, ed ? {
          si: si, qi: qi, bucket: bucketOf(q),
          up: qi > 0, down: qi < s.items.length - 1,
          left: si > 0, right: si < sections.length - 1,
          del: !!eopts.canRemove,
        } : null);
      }).join("");
      if (ed && !s.items.length) {
        inner = '<div class="gempty no-print">' + Render.esc(eopts.emptyText || "把题目拖到这里") + "</div>";
      }
      /* data-si 一律写（不分编辑态）：分页会把一个板块拆到两页上，自检与拖拽都靠它归并 */
      return title
        + '<div class="grid-sec" data-si="' + si + '" data-qbase="0"'
        + ' style="grid-template-columns:repeat(' + s.cols + ',1fr)">' + inner + "</div>";
    }).join("");
    return '<div class="sheet">' + head + body + "</div>";
  }

  /* ---------------------------------------------------------------- A4 分页
     为什么非做不可：① 排版界面得让人看见"打印出来会断在第几页"；② 不自己分页的话，
     浏览器打印时会从一道题**中间**劈开（题目被切成上下两半，学生没法做）。
     做法：先让浏览器把一个 .sheet 排出来（高度是实测的，不是估的），再把每块元素按
     「A4 内容高度」贪心装箱，最后把这些**真实 DOM 节点**搬进一页一个的 .sheet。
     搬节点而不是重画：KaTeX 不用再排一次、图片不会重新加载、输入焦点也不受影响。

     注意：多列板块里**一行是一整块**，不能把一行拆到两页去，否则版面就散了。 */
  var PAGE_H_MM = 297, PAGE_SAFE_MM = 5;

  /* ---- 页边距：唯一口径在 CSS（app.css 的 :root --pg-*），这里只读不复制常量。
     三处必须一致：屏幕 .sheet 内边距 / 打印 .sheet 内边距 / 这里的 A4 分页高度。
     为什么不让 @page 管：打印对话框一改「边距」，@page 就被忽略，卷面贴到纸角
     （2026-10-11 实测左边距 0mm）。现在 @page margin 固定 0，边距由卷面自己内缩。 */
  var MARGINS = {
    tight: { label: "紧凑", t: 14, r: 14, b: 14, l: 14 },
    std: { label: "标准", t: 18, r: 18, b: 18, l: 18 },
    wide: { label: "宽松", t: 24, r: 22, b: 22, l: 22 },
  };
  var MARGIN_ORDER = ["tight", "std", "wide"];
  var MARGIN_KEY = "sj-print-margin";
  var MARGIN_DEF = "std";

  function marginSpec(k) { return MARGINS[k] || MARGINS[MARGIN_DEF]; }

  function marginKey() {
    try { var k = localStorage.getItem(MARGIN_KEY); if (MARGINS[k]) return k; } catch (e) {}
    return MARGIN_DEF;
  }

  /* 把预设写进 :root 的 CSS 变量 —— CSS 里的 .sheet 内边距跟着走，分页也从这读 */
  function applyMargin(k) {
    var m = marginSpec(k), r = document.documentElement.style;
    r.setProperty("--pg-t", m.t + "mm");
    r.setProperty("--pg-r", m.r + "mm");
    r.setProperty("--pg-b", m.b + "mm");
    r.setProperty("--pg-l", m.l + "mm");
    return m;
  }

  function setMargin(k) {
    if (!MARGINS[k]) return false;
    try { localStorage.setItem(MARGIN_KEY, k); } catch (e) {}
    applyMargin(k);
    return true;
  }

  /* 当前生效的边距（mm）：优先从算好的 CSS 变量读回，读不到才退回预设 */
  function pageMargins() {
    var cs = getComputedStyle(document.documentElement);
    var d = marginSpec(marginKey());
    function v(name, def) {
      var n = parseFloat((cs.getPropertyValue(name) || "").trim());
      return isFinite(n) && n > 0 ? n : def;
    }
    return { t: v("--pg-t", d.t), r: v("--pg-r", d.r), b: v("--pg-b", d.b), l: v("--pg-l", d.l) };
  }

  /* 页边距选择器：返回一个节点，由页面插进工具条。onChange 里调用方负责重排分页。 */
  function marginCtl(onChange) {
    var wrap = document.createElement("span");
    wrap.className = "mgctl no-print";
    wrap.innerHTML = '<span class="lbl">页边距</span>' + MARGIN_ORDER.map(function (k) {
      return '<button type="button" class="btn sec sm mgo" data-mgk="' + k + '">'
        + MARGINS[k].label + "</button>";
    }).join("");
    function sync() {
      [].forEach.call(wrap.querySelectorAll(".mgo"), function (b) {
        b.classList.toggle("on", b.getAttribute("data-mgk") === marginKey());
      });
    }
    wrap.addEventListener("click", function (ev) {
      var b = ev.target.closest(".mgo");
      if (!b) return;
      setMargin(b.getAttribute("data-mgk"));
      sync();
      if (onChange) onChange();
    });
    sync();
    return wrap;
  }

  /* 1mm = 多少 px：不猜 96dpi，量一个 10mm 高的探针 */
  function pageMetrics() {
    var d = document.createElement("div");
    d.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:10mm";
    document.body.appendChild(d);
    var perMm = d.offsetHeight / 10;
    document.body.removeChild(d);
    var pg = pageMargins();
    /* 分页只累计「块高」，不含内边距 —— 所以可用高度 = 纸高 - 上边距 - 下边距 - 保险 */
    var H = (PAGE_H_MM - pg.t - pg.b - PAGE_SAFE_MM) * perMm;
    return { px: perMm, content: Math.round(H), pg: pg };
  }

  /* 1mm = 多少**布局** px（不受 transform: scale 影响）—— 排版态拖插图手柄时用它把
     手指移动的视觉像素换算成 mm。 */
  function pxPerMm() { return pageMetrics().px; }

  /* 把分过页的卷面重新并回一张长卷面 —— paginate 要能反复调用
     （切列数、拖动、改卷名之后都会重排）。 */
  function flatten(host) {
    var sheets = [].slice.call(host.querySelectorAll(":scope > .sheet"));
    if (!sheets.length) return null;
    var one = sheets[0];
    sheets.slice(1).forEach(function (s) {
      [].slice.call(s.children).forEach(function (c) {
        if (c.classList && c.classList.contains("pgno")) return;   // 页码标签丢掉
        one.appendChild(c);
      });
      s.parentNode.removeChild(s);
    });
    [].forEach.call(one.querySelectorAll(".pgno"), function (p) { p.parentNode.removeChild(p); });
    /* 同一板块被拆成的多个网格并回一个：否则"行"会被拆成两组，高度量不准 */
    var seen = {};
    [].slice.call(one.querySelectorAll(":scope > .grid-sec")).forEach(function (g) {
      var k = g.getAttribute("data-si");
      if (k == null) return;
      if (seen[k]) {
        [].slice.call(g.children).forEach(function (c) { seen[k].appendChild(c); });
        g.parentNode.removeChild(g);
      } else seen[k] = g;
      seen[k].setAttribute("data-qbase", "0");
    });
    return one;
  }

  /* 返回页数。只有一页时原样返回（不动 DOM，省一次重排）。 */
  function paginate(host) {
    if (!host) return 0;
    var sheet = flatten(host);
    if (!sheet) return 0;

    /* ---- 1. 拆块：卷头 / (板块标题 + 该板块第一行) / 每一行题 ----
       高度一律用 offsetTop / offsetHeight 量，**不要用 getBoundingClientRect**：
       组卷台为了把卷面塞进半屏给它加了 transform: scale，rect 量到的是缩放后的视觉尺寸，
       拿它算页高会整页错位；offset* 是布局尺寸，不受 transform 影响。 */
    var blocks = [], head = null;
    function boxOf(el) { return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight }; }
    [].slice.call(sheet.children).forEach(function (el) {
      if (el.classList.contains("sec-title") || el.classList.contains("sec-edit")) { head = el; return; }
      if (!el.classList.contains("grid-sec")) {
        /* 卷头这类独立块也要量高度 —— 漏掉的话 top/bottom 是 undefined，
           后面累加会变成 NaN，贪心装箱就永远不换页（踩过）。 */
        if (!el.classList.contains("pgno")) {
          var pb = boxOf(el);
          blocks.push({ els: [el], top: pb.top, bottom: pb.bottom });
        }
        return;
      }
      var items = [].slice.call(el.querySelectorAll(":scope > .gitem, :scope > .gempty"));
      var rows = [];
      items.forEach(function (it) {                       // 同一行（同一 grid row）的题一起搬
        var t = it.offsetTop;
        var last = rows[rows.length - 1];
        if (last && Math.abs(t - last.t) < 2) { last.els.push(it); return; }
        rows.push({ t: t, els: [it] });
      });
      if (!rows.length) rows.push({ t: null, els: [] });  // 空板块也是一块（编辑态有占位）
      var base = 0;
      rows.forEach(function (r, ri) {
        var els = r.els;
        var b0 = els.length ? boxOf(els[0]) : boxOf(el);
        var top = b0.top, bottom = b0.bottom;
        els.forEach(function (x) {
          var b = boxOf(x);
          if (b.top < top) top = b.top;
          if (b.bottom > bottom) bottom = b.bottom;
        });
        var hh = ri === 0 ? head : null;                  // 板块标题跟着它的第一行走
        if (hh) { var hb = boxOf(hh); if (hb.top < top) top = hb.top; }
        blocks.push({ head: hh, grid: el, els: els, base: base, top: top, bottom: bottom });
        base += els.length;
      });
      head = null;
    });
    if (!blocks.length) return 0;

    /* ---- 2. 贪心装箱 ---- */
    var pm = pageMetrics();
    var pages = [[]], used = 0, prevBottom = null;
    blocks.forEach(function (b) {
      var h = b.bottom - b.top;
      var gap = (used > 0 && prevBottom != null) ? Math.max(0, b.top - prevBottom) : 0;
      if (used > 0 && used + gap + h > pm.content) { pages.push([]); used = 0; gap = 0; }
      used += gap + h;
      prevBottom = b.bottom;
      pages[pages.length - 1].push(b);
    });

    /* ---- 3. 按页重建：先把容器建好，再把节点搬进去 ---- */
    var frag = document.createDocumentFragment();
    pages.forEach(function (list, pi) {
      var s = document.createElement("div");
      s.className = "sheet";
      var curGrid = null, curSrc = null;
      list.forEach(function (b) {
        if (b.head) s.appendChild(b.head);
        if (!b.grid) { b.els.forEach(function (el) { s.appendChild(el); }); return; }   // 卷头这类独立块
        if (b.grid !== curSrc) {
          curGrid = document.createElement("div");
          curGrid.className = b.grid.className;
          curGrid.setAttribute("style", b.grid.getAttribute("style") || "");
          var si = b.grid.getAttribute("data-si");
          if (si != null) curGrid.setAttribute("data-si", si);
          /* 这一格里的题在**整段板块**里排第几起 —— 拖拽落点要靠它换算成全局下标 */
          curGrid.setAttribute("data-qbase", String(b.base));
          s.appendChild(curGrid);
          curSrc = b.grid;
        }
        b.els.forEach(function (el) { curGrid.appendChild(el); });
      });
      var pg = document.createElement("div");
      pg.className = "pgno no-print";
      pg.textContent = "第 " + (pi + 1) + " / " + pages.length + " 页";
      s.appendChild(pg);
      frag.appendChild(s);
    });
    host.innerHTML = "";          // 旧容器里的节点早已搬走，这里只是丢掉空壳
    host.appendChild(frag);
    return pages.length;
  }

  /* ---------------------------------------------------------------- 模块状态与出口
     题号方案（spec）放在这里，渲染前由页面 / SheetEd 设好。必须在所有 var 声明之后再初始化。 */
  var spec = normNo(null);

  /* 页边距预设（存在本机）在渲染前先落到 CSS 变量上，页面第一次画就是对的 */
  applyMargin(marginKey());

  return {
    // 常量
    SKIP_SECTION: SKIP_SECTION, BOX_H: BOX_H, TYPE_SECTION: TYPE_SECTION, TYPE_TITLE: TYPE_TITLE,
    NO_STYLES: NO_STYLES, NO_WRAPS: NO_WRAPS, NO_DEF: NO_DEF, LAY_MAX_COLS: LAY_MAX_COLS,
    MARK_RE: MARK_RE, TYPE_SHORT: TYPE_SHORT,
    // 题号方案
    getNo: function () { return spec; },
    setNo: function (o) { spec = normNo(o); return spec; },
    normNo: normNo, normSpec: normSpec, noText: noText, noGap: noGap, wrapKey: wrapKey,
    stripSecNo: stripSecNo, cnNum: cnNum,
    isCalcSec: isCalcSec, smallNoFor: smallNoFor, numberItems: numberItems,
    fullTitle: fullTitle, secEditHtml: secEditHtml,
    // 题型分桶（板块名优先，模型题型兜底；用户手动改过的优先）
    normBucket: normBucket, bucketOf: bucketOf, secBucket: secBucket,
    setBuckets: setBuckets, buckets: buckets,
    // 分组 / 列数
    typeIndex: typeIndex, colsForSection: colsForSection, collectByType: collectByType,
    buildFromManual: buildFromManual, clampCols: clampCols, secLabel: secLabel, copyQ: copyQ,
    // 照片卷
    sectionOf: sectionOf, hasUnknown: hasUnknown, usable: usable, usableList: usableList,
    collect: collect, inferCols: inferCols,
    boxFor: boxFor, boxHeight: boxHeight,
    // 渲染
    sheetHtml: sheetHtml, itemHtml: itemHtml, optsHtml: optsHtml, qbarHtml: qbarHtml,
    flowText: flowText, judgeBracket: judgeBracket, emWidth: emWidth,
    hasFigure: hasFigure, figRight: figRight, figChoice: figChoice,
    // 插图尺寸（排版态可拖手柄改；改过的记在 layout.figs）
    FIG_W_DEF: FIG_W_DEF, FIG_W_DUO: FIG_W_DUO, FIG_W_MIN: FIG_W_MIN, FIG_W_MAX: FIG_W_MAX,
    clampFigW: clampFigW, setFigW: setFigW, figws: figws, figWidthOf: figWidthOf,
    figWidthMm: figWidthMm,
    setCaps: setCaps, caps: caps, capOff: capOff, stripCap: stripCap,
    // 分页
    paginate: paginate, flatten: flatten, pxPerMm: pxPerMm,
    // 页边距（唯一口径在 CSS :root --pg-*；这里读/写 + 选择器）
    MARGINS: MARGINS, marginKey: marginKey, setMargin: setMargin,
    applyMargin: applyMargin, pageMargins: pageMargins, marginCtl: marginCtl,
  };
})();
