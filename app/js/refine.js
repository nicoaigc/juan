/* 本地坐标吸附（「路线 A」）：大模型给「粗框 + 顺序」，本地把这些框吸附到卷面真实墨迹上。
 *
 * 这是 tools/refine_proto.py（v5.3）的前端版。**两边规则必须同步**：改了 Python 的
 * DEFAULTS / 判据，这里要跟着改，并用 tools/refine_js_check.mjs 与 Python 逐题对账。
 *
 * ── v5.3（线上真实故障修复：paper2 的 q4-15 整段下移一行 → "图片定位不对"）──
 *   ① 空洞判定改用全部段：小列（如「6×90=」墨迹核 73px）被 segMinFrac 滤掉后
 *      整条带被误判 "hole"（可跳过），"硬题目带必须被覆盖"的安全网漏了洞；
 *   ② 页顶/页底 2% 内的边缘带（页眉/裁切边/杂墨）一律非题目行；
 *   ③ 反"拉伸吞行"：段跨多条硬带而模型框高 < 0.7×跨度时罚 stretchPen
 *      （只在模型行数 ≥ 硬带数时启用，应用题页的多行题拉伸不受影响）。
 *   修复后忠实复刻该故障的模拟：cov 0.00 → 与正常输出一致（0.949/0.508）。
 *
 * ── 为什么需要它（把踩过的坑写下来，免得后人重走） ──
 *   · 模型的**文字转写逐字准**，但**绝对坐标不可信**：同一张图两次调用 y 差 10~250px。
 *     而且它的错法不是随机抖动，是「**按版式均匀铺开**」——下半页整体上偏、越往下偏越多
 *     （实测 `乘法综合练习` 第1次有 5 道题偏了 250px，框直接落在「1、选择题」这种说明行上）。
 *   · 三种朴素修法都试过、都不成立：① 本地行/列投影 + 全页统一行带（手写笔迹会把行带
 *     连成一整块 706px 高）；② 从模型框中心向外吸附（中心本身就偏到相邻行了）；③ 外扩到
 *     「必不漏」（密集页要 ±250px，那时框已宽到页面的 47%）。
 *   · 所以这里走「**结构判据 + 单调对齐**」：判据**只看版面横向结构、完全不看模型框**
 *     （否则模型框抖一下整页就崩），再把模型行按上下顺序**单调对齐**到候选行带上
 *     （允许跳过板块标题、题目带必须被覆盖），最后 x 吸附到该题局部的列投影边界、
 *     y 向有墨处「有墨就长、没墨就停」。
 *
 * ── 实测（5 张卷 / 10 次识别，真值 = data/questions 的精确坐标；覆盖率 / IoU，按题干文本配对）──
 *   密集页 0.949/0.508 · 0.938/0.565      应用题 0.926/0.477 · 0.997/0.486
 *   小学练习页 0.730/0.638 · 0.721/0.618  乘法综合 0.659/0.250 · 0.876/0.365
 *   乘法练习卷2 0.956/0.479 · 0.931/0.462
 *   现线上「外扩 35%」的覆盖率是 0.713/0.546/0.604/1.000/0.778/0.596/0.342/0.806/0.444/0.698，
 *   但**精度只有 0.09~0.5**（框里一半是空白和别人的题）。
 *
 * ── 兜底 ──
 *   任何一步抛错、或 DP 判定不可行（segs === null），`snap()` 返回 null，
 *   调用方（recognize.js）**退回「外扩 35%」**——也就是现线上的老策略，绝不比现在更差。
 *
 * ── 性能 ──
 *   大图先等比缩到 workMax（默认 1600 长边，与送模型前一致）再算，所有像素尺度参数
 *   同步按比例缩放 → 结果与全分辨率等价、内存只有 1/6。输出坐标再换算回原图。
 */
(function () {
  "use strict";

  /* 单位：**原图像素**（按 1440px 宽的卷标定）。`scale` 会把像素尺度的量等比缩放。 */
  var DEFAULTS = {
    workMax: 1600,     // 内部工作分辨率的长边上限（0 = 不缩放，用原图；跑对账时用）
    rowTol: 25,        // 模型框 y 聚类容差（行距 ~60，取 25 很安全）
    xExpand: 40,       // 行投影的 x 范围 = 模型框并集再外扩（另有 xEdge 兜底）
    xEdge: 0.08,       // 但至少覆盖页宽的 [8%, 92%]
    peakMin: 20.0,     // 行投影上"这算一条行"的最小峰高
    peakRel: 0.35,     // 行带边界：从峰向两侧扩展到峰值的这个比例
    peakDist: 34,      // 两个峰的最小间距（小于它的只留高的那个）
    smoothW: 9,        // 行投影平滑窗（奇数）
    mergeOv: 0.5,      // 两条行带重叠超过较矮那条的这个比例就合并
    inkLum: 118,       // 印刷黑的亮度**上限**（实际阈值只在更暗时才下调，见 resolveInkLum）
    inkChroma: 42,     // 色差上限（彩色笔迹/照片阴影不算印刷黑）
    hmin: 16, hmax: 95, // 行带高度范围（题目行 ~20-70；卷头/阴影块远超）
    colTh: 3.0,        // 列投影时"这一列有墨迹"的下限
    lineColGap: 100,   // 判"一整行题"时允许的横向空隙（相邻列空隙 220px+）
    minSeg: 60,        // 一段至少要这么宽才算"一列题"（滤掉噪点）
    segMinFrac: 0.06,  // 判"单段/多段"前，窄于此比例×页宽的段先当碎片剔掉
    wide: 0.40,        // 单段 → "软题目带"的下限（可跳过）
    hardWide: 0.55,    // 单段 → "硬题目带"的下限（必须被某一行用掉）
    holeFrac: 0.35,    // 多段时，段与段之间允许的最大空洞（占页宽）
    leftEdge: 0.20,    // 段起点 ≤ 该比例×页宽 → 判为板块标题
    xPad: 130,         // x 吸附的搜索半径
    snapColTh: 4.0,
    snapColGap: 100,   // x 吸附时字与字之间的缝
    xKeepOv: 0.5,      // x 吸附结果与模型框的重叠低于该比例 → 认定跑偏，退回模型框
    xMargin: 40,       // x 安全余量（人工标注的"题区框"是含作答留白的）
    widenRatio: 0.35,  // 单列长题的兜底外扩比例（与线上老策略一致）
    padMin: 40,        // 兜底外扩的下限（短题也得给足余量）
    padMax: 110,       // 兜底外扩的上限（再大就跨列了）
    yMargin: 12,       // y 安全余量
    growGap: 20,       // 「有墨就长」的扩张：允许跳过几行空白
    growHRatio: 2.5,   // 只有"模型框高 > 该比例 × 行带高"才长（=版面上真是多行的题）
    growInk: 2,        // 「这一行有墨」的下限（该题 x 范围内的墨像素数）
    growExt: 90,       // 扩张的上界比"模型框 ± pad(≤110)"再多探出去多少像素
    growExtRatio: 2.5, // 只有"模型框高 > 该比例 × 行带高"才给 growExt
    segHRatio: 1.6,    // 段高上限 = 比例 × 模型框高
    segHSlack: 60,
    segHW: 3.0,        // 代价里"段高与模型框高之差"的权重（比中心距离更重）
    segHCap: 80.0,     // 高度差的**上限**（封顶，防深色图盖过全局）
    qPen: 400.0,       // "段内只有一条带、且这条带不是题目带"的惩罚
    banPen: 250.0,     // 段内每含一条"板块标题带"的惩罚
    softMust: 0,       // 1 = 连"软题目带"也要求被覆盖（实验开关，默认关）
    qPenAll: 0,        // 1 = 整段没有任何"像题目"的带时也罚 qPen（实验开关，默认关）
    startPen: 0.0,     // "段起点窄于段内最宽行"的惩罚（实验开关，默认关）
    yW: 1.0,           // 代价里"段中心与模型框中心之差"的权重
    stretchPen: 500.0  // v5.3 反"拉伸吞行"：段横跨多条硬带但模型框高 < 0.7×跨度时
                       // 的惩罚。只在模型行数 ≥ 硬带数时生效（全局门槛见 alignSegments）
  };

  /* 需要按缩放比例同步放缩的**像素尺度**参数（比例/开关类不动）。 */
  var PX_KEYS = ["rowTol", "xExpand", "peakMin", "peakDist", "hmin", "hmax", "colTh",
                 "lineColGap", "minSeg", "xPad", "snapColTh", "snapColGap", "xMargin",
                 "yMargin", "padMin", "padMax", "growGap", "growInk", "growExt",
                 "segHSlack", "segHCap", "segHW", "qPen", "banPen", "startPen"];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function params(over) {
    var p = {}, k;
    for (k in DEFAULTS) p[k] = DEFAULTS[k];
    if (over) for (k in over) if (over[k] !== undefined && over[k] !== null) p[k] = over[k];
    return p;
  }
  function scaleParams(p, s) {
    var q = {}, k;
    for (k in p) q[k] = p[k];
    for (var i = 0; i < PX_KEYS.length; i++) {
      k = PX_KEYS[i];
      if (typeof q[k] === "number") q[k] = q[k] * s;
    }
    q.smoothW = Math.max(3, Math.round(p.smoothW * s) | 1); // 强制奇数、≥3
    q.hmin = Math.max(3, q.hmin);
    q.hmax = Math.max(q.hmin + 3, q.hmax);
    q.minSeg = Math.max(6, q.minSeg);
    return q;
  }

  /* ---------------------------------------------------------------- 墨掩膜
     印刷黑：够暗 **且** 色差小。亮度必须按 int32 思路算（299*255 会溢出 16 位思路）。 */
  function buildInk(d, w, h, lum, chroma) {
    var ink = new Uint8Array(w * h), n = w * h, i, p = 0;
    for (i = 0; i < n; i++, p += 4) {
      var r = d[p], g = d[p + 1], b = d[p + 2];
      if ((r * 299 + g * 587 + b * 114) / 1000 < lum) {
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx - mn < chroma) ink[i] = 1;
      }
    }
    return ink;
  }

  /* 纸面亮度基准：低色度像素亮度的 75 分位（"这张纸大概有多亮"）。
     ⚠️ 用**线性插值**（与 numpy.percentile 的默认口径一致）：用"直方图第一个够数的
     桶"会差 1 个亮度单位，进而让墨掩膜阈值差 1、个别框的吸附边差 3px —— 对账时很难看。 */
  function paperLevel(d, w, h, chroma, q) {
    var hist = new Int32Array(256), tot = 0, n = w * h, i, p = 0;
    for (i = 0; i < n; i++, p += 4) {
      var r = d[p], g = d[p + 1], b = d[p + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx - mn < chroma) { hist[Math.floor((r * 299 + g * 587 + b * 114) / 1000)]++; tot++; }
    }
    if (tot < 1000) return 255;
    function atRank(t) {
      if (t < 0) t = 0;
      var acc = 0;
      for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc > t) return v; }
      return 255;
    }
    var pos = (q / 100) * (tot - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    var a = atRank(lo), b2 = atRank(hi);
    return a + (b2 - a) * (pos - lo);
  }

  /* 墨掩膜的亮度阈值**必须自适应**：固定 118 在偏暗的照片上会把纸面/阴影都算成墨
     （实测 `2026-09-30-小学练习页.jpg` 墨占比 35.86% vs 密集页 15.04%），行投影没有谷、
     行带检测整页失效（覆盖率 0.778 → 0.026）。规则 = min(118, 0.68 × 纸面亮度)：
     曝光正常的卷纸面 255 → 算出 ≥125 → 仍取 118（行为不变），只有偏暗的才下调。 */
  function resolveInkLum(d, w, h, base, chroma, paperFrac, floor) {
    var pl = paperLevel(d, w, h, chroma, 75);
    return Math.min(base, Math.max(floor, Math.round(paperFrac * pl)));
  }

  /* ------------------------------------------------------------- 一维区间工具 */
  function bands1d(prof, th) {
    var out = [], s = -1, i;
    for (i = 0; i < prof.length; i++) {
      if (prof[i] > th) { if (s < 0) s = i; }
      else if (s >= 0) { out.push([s, i]); s = -1; }
    }
    if (s >= 0) out.push([s, prof.length]);
    return out;
  }
  function mergeGaps(segs, gap) {
    if (!segs.length) return [];
    var out = [[segs[0][0], segs[0][1]]], i;
    for (i = 1; i < segs.length; i++) {
      if (segs[i][0] - out[out.length - 1][1] <= gap) out[out.length - 1][1] = segs[i][1];
      else out.push([segs[i][0], segs[i][1]]);
    }
    return out;
  }
  function clusterRows(boxes, tol) {
    var order = [], i;
    for (i = 0; i < boxes.length; i++) order.push(i);
    order.sort(function (a, b) { return boxes[a][1] - boxes[b][1]; });
    var rows = [], cur = [];
    for (i = 0; i < order.length; i++) {
      var k = order[i];
      if (cur.length && boxes[k][1] - boxes[cur[cur.length - 1]][1] > tol) { rows.push(cur); cur = []; }
      cur.push(k);
    }
    if (cur.length) rows.push(cur);
    return rows;
  }

  /* --------------------------------------------------------- 结构判据：行带 */
  /* 候选行带 = 行投影的**局部峰**（不是固定阈值：行距只比字高大一点，固定阈值会把
     相邻两行粘成一块 150px 巨块，再被高度上限砍掉 → 整个下半页的行全丢）。 */
  function findLineBands(prof, peakMin, peakRel, peakDist, hmin, hmax, smoothW) {
    var n = prof.length;
    if (n < 3) return [];
    var sw = smoothW % 2 ? smoothW : smoothW + 1;
    var half = (sw - 1) / 2;
    var s = new Float64Array(n), i, j;
    if (sw >= 3) {
      for (i = 0; i < n; i++) {
        var acc = 0;
        for (j = -half; j <= half; j++) { var t = i + j; if (t >= 0 && t < n) acc += prof[t]; }
        s[i] = acc / sw;
      }
    } else { for (i = 0; i < n; i++) s[i] = prof[i]; }

    var cand = [];
    for (i = 1; i < n - 1; i++) if (s[i] >= s[i - 1] && s[i] > s[i + 1] && s[i] >= peakMin) cand.push(i);
    cand.sort(function (a, b) { return s[b] - s[a]; });
    var keep = [];
    for (i = 0; i < cand.length; i++) {
      var ok = true;
      for (j = 0; j < keep.length; j++) if (Math.abs(cand[i] - keep[j]) < peakDist) { ok = false; break; }
      if (ok) keep.push(cand[i]);
    }
    keep.sort(function (a, b) { return a - b; });
    var out = [];
    for (i = 0; i < keep.length; i++) {
      var c = keep[i], thr = Math.max(peakMin * 0.5, s[c] * peakRel);
      var a = c, b = c;
      while (a > 0 && s[a - 1] > thr) a--;
      while (b < n - 1 && s[b + 1] > thr) b++;
      if (b - a >= hmin && b - a <= hmax) out.push([a, b]);
    }
    return out;
  }

  /* 这条行带像不像"题目行"——只看**版面横向结构**，完全不依赖模型框。
     返回 [是否题目行, 判定分, 类型]，类型 ∈ multi/wide/loose/title/side/hole/empty。
       · 单段 ≥ hardWide×页宽 → "wide"（硬，必须被覆盖）
       · 单段 ≥ wide×页宽     → "loose"（软，可跳过）—— 为什么要两档：应用题最短题干
         605/1427=0.42，而密集页最长的板块标题「三、在○里填入…」530/1440=0.37，只差 8%，
         单一阈值必然是个刀锋；拆两档后落在这 8% 灰区里的带只是"可跳过的软带"。
       · 单段但不够宽 → 板块标题（紧贴左页边）或右侧插图（起点远在左页边之外）
       · 多段但中间有巨大空洞 → "hole"（标题 + 右侧学生竖式，空洞 744px；
         真正的两列题目行空洞只有 221~349px）
       · 其余多段 → "multi"（硬）
     ⚠️ 判"单段/多段"前先把窄于 segMinFrac×页宽的碎片剔掉：板块标题「二、用竖式计算。」
     那条带 = 标题(257px) + 一小坨学生笔迹(71px)，两段 → 会被误判成"multi"（硬）。
     ⚠️ x 必须限制在 [x1,x2]（与行投影同一范围）：用整页宽度时右页边/黑桌面会凭空
     造出第二段，实测让两条板块标题被误判成题目行。 */
  function bandStructure(ink, w, h, band, x1, x2, p) {
    var y1 = band[0], y2 = band[1];
    if (y2 <= y1 || x2 <= x1) return [false, 0.0, "empty"];
    /* v5.3 页顶/页底边缘带：照片上/下边缘的页眉、裁切边、桌面杂墨。真实题目行
       不会贴到照片边上（多少有留白）。这种带被当成硬题目带会抢走一个行、
       把整页对齐级联搞乱（实测小学练习页1 页顶 y0~66 的页眉带）。 */
    if (h > 0 && (y1 <= 0.02 * h || y2 >= 0.98 * h)) return [false, 0.0, "edge"];
    var ws = x2 - x1, prof = new Float64Array(ws), x, y;
    for (y = y1; y < y2; y++) {
      var base = y * w;
      for (x = x1; x < x2; x++) prof[x - x1] += ink[base + x];
    }
    var segs = mergeGaps(bands1d(prof, p.colTh), p.lineColGap), out = [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i][1] - segs[i][0] >= p.minSeg) out.push([segs[i][0] + x1, segs[i][1] + x1]);
    }
    segs = out;
    if (!segs.length) return [false, 0.0, "empty"];
    var wide = [];
    for (i = 0; i < segs.length; i++) if (segs[i][1] - segs[i][0] >= p.segMinFrac * w) wide.push(segs[i]);
    if (!wide.length) {
      var mxw = 0;
      for (i = 0; i < segs.length; i++) mxw = Math.max(mxw, segs[i][1] - segs[i][0]);
      return [false, mxw / Math.max(1, w), "side"];
    }
    if (wide.length === 1) {
      var s = wide[0][0], e = wide[0][1], ww = e - s;
      if (ww >= p.hardWide * w) return [true, ww / Math.max(1, w), "wide"];
      if (ww >= p.wide * w) return [true, ww / Math.max(1, w), "loose"];
      return [false, ww / Math.max(1, w), (s <= p.leftEdge * w ? "title" : "side")];
    }
    /* v5.3 空洞判定用**全部段**（minSeg 过滤后），不是只看宽段：
       密集页真值第 2 行中间列「6×90=」墨迹核只有 73px < segMinFrac×W(86) 被
       当碎片滤掉 → 剩两段、空洞 0.43W → 整条带被判 "hole"（可跳过）→ 硬带
       必须覆盖的安全网漏了个洞，模型一旦把 y 压下一行（线上真实发生），
       DP 就地跟着跳行、覆盖率 0.00。小列把大空洞切碎后是 "multi"（硬）；
       而「四、递等式计算。+右侧竖式」两段都够宽、空洞 0.52W 照旧是 hole。 */
    var mxg = 0;
    for (i = 1; i < segs.length; i++) mxg = Math.max(mxg, segs[i][0] - segs[i - 1][1]);
    if (mxg > p.holeFrac * w) return [false, mxg / Math.max(1, w), "hole"];
    var mn = Infinity;
    for (i = 0; i < wide.length; i++) mn = Math.min(mn, wide[i][1] - wide[i][0]);
    return [true, mn / Math.max(1, w), "multi"];
  }

  /* 两条行带重叠超过"较矮那条的一半"就合并。
     峰值检测偶尔会在同一行吐两条，不合并的话分段 DP 会拿它"凑距离"。 */
  function mergeOverlaps(bands, ov) {
    var sorted = bands.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var a = sorted[i][0], b = sorted[i][1];
      if (out.length) {
        var pa = out[out.length - 1][0], pb = out[out.length - 1][1];
        var inter = Math.min(pb, b) - Math.max(pa, a);
        if (inter > ov * Math.min(pb - pa, b - a)) {
          out[out.length - 1] = [Math.min(pa, a), Math.max(pb, b)];
          continue;
        }
      }
      out.push([a, b]);
    }
    return out;
  }

  /* --------------------------------------------------------- 单调对齐（分段 DP）
     把行带序列切成 K 段，第 r 段给第 r 个模型行。允许跳过行带，但：硬题目带必须被覆盖；
     板块标题带不许单独成题（qPen）、并进题里也罚（banPen）。
     三条规则各有实测来由，缺一条就有一页会崩（详见 refine_proto.py 的 docstring）。 */
  function alignSegments(modelC, modelH, bounds, K, kinds, p) {
    var M = bounds.length;
    if (K <= 0 || M < K) return null;
    if (K * M * M * M > 6e7) return null;      // 复杂度护栏：宁愿退回老策略也不卡死手机
    var INF = Infinity, i, j, r, t;

    var HARD = { wide: 1, multi: 1 }, SOFT = { loose: 1 }, BAN = { title: 1, hole: 1, empty: 1, edge: 1 };
    var isq = new Uint8Array(M), issoft = new Uint8Array(M), isany = new Uint8Array(M), isb = new Uint8Array(M);
    var preMust = new Int32Array(M), preB = new Int32Array(M);
    var nm = 0, nb2 = 0;
    for (j = 0; j < M; j++) {
      var kd = kinds[j];
      var hard = !!HARD[kd] || (p.softMust && !!SOFT[kd]);
      isq[j] = hard ? 1 : 0;
      issoft[j] = SOFT[kd] ? 1 : 0;
      isany[j] = (HARD[kd] || SOFT[kd]) ? 1 : 0;
      isb[j] = BAN[kd] ? 1 : 0;
      if (hard) nm++;
      if (isb[j]) nb2++;
      preMust[j] = nm; preB[j] = nb2;
    }

    function gapFree(a, b) {
      if (b < a) return true;
      return preMust[b] - (a > 0 ? preMust[a - 1] : 0) === 0;
    }
    function cost(i2, j2, rr) {                 // 段 = bounds[i2 .. j2-1]
      var mh = modelH[rr];
      var y1 = bounds[i2][0], y2 = bounds[j2 - 1][1], hh = y2 - y1;
      if (hh > Math.max(p.segHRatio * mh, mh + p.segHSlack)) return INF;
      var c = p.yW * Math.abs((y1 + y2) / 2 - modelC[rr])
            + p.segHW * Math.min(Math.abs(hh - mh), p.segHCap);
      /* v5.3 反"拉伸吞行"：一段横跨多条硬带而模型框高 < 0.7×跨度 时重罚。
         ⚠️ 只在模型行数 ≥ 硬带数时启用——行数够分时拉伸几乎必是吞行 bug
         （线上真实案例：模型 y 整段压下一行，DP 把第 1 行拉长盖住两行硬带、
         后面每行顺理成章错一格）；应用题页行数 < 硬带数、拉伸是多行题的
         合法形态（实测不设门槛小学练习页2 崩到 0.286）。 */
      var nh = preMust[j2 - 1] - (i2 > 0 ? preMust[i2 - 1] : 0);
      if (nh > 1 && mh < 0.7 * hh && K >= nm) c += p.stretchPen;
      var nb = preB[j2 - 1] - (i2 > 0 ? preB[i2 - 1] : 0);
      if (nb) c += p.banPen * nb;
      if (j2 - i2 === 1 && !(isq[i2] || issoft[i2])) c += p.qPen;
      else if (p.qPenAll) {
        var any = false;
        for (var tt = i2; tt < j2; tt++) if (isany[tt]) { any = true; break; }
        if (!any) c += p.qPen;
      }
      if (p.startPen) {
        var wS = p.segW[i2], wM = wS;
        for (var t2 = i2; t2 < j2; t2++) if (p.segW[t2] > wM) wM = p.segW[t2];
        c += p.startPen * Math.max(0, wM - wS);
      }
      return c;
    }

    var dp = [], bkI = [], bkJ = [];
    for (r = 0; r < K; r++) {
      var dv = new Float64Array(M); for (i = 0; i < M; i++) dv[i] = INF;
      dp.push(dv);
      bkI.push(new Int32Array(M).fill(-1));
      bkJ.push(new Int32Array(M).fill(-1));
    }
    /* ⚠️ 必须**显式枚举**上一段的终点 jp：只记"dp[r-1][0..i-1] 的最小值"会让
       被"不许跳过题目带"否决的最优解把次优可行解一起带走 —— 实测会把"9 条硬带 ↔ 9 行"
       这种明明可行的唯一解判成不可行、整页退回模型框。 */
    for (r = 0; r < K; r++) {
      for (j = 0; j < M; j++) {
        var best = INF, bi = -1, bj = -1;
        for (i = 0; i <= j; i++) {
          var c = cost(i, j + 1, r);
          if (c >= INF) continue;
          if (r === 0) {
            if (!gapFree(0, i - 1)) continue;
            if (c < best) { best = c; bi = i; bj = -1; }
          } else {
            for (var jp = -1; jp < i; jp++) {
              if (jp < 0) continue;
              if (dp[r - 1][jp] >= INF) continue;
              if (!gapFree(jp + 1, i - 1)) continue;
              var v = dp[r - 1][jp] + c;
              if (v < best) { best = v; bi = i; bj = jp; }
            }
          }
        }
        dp[r][j] = best; bkI[r][j] = bi; bkJ[r][j] = bj;
      }
    }
    var last = -1, bestv = INF;
    for (j = 0; j < M; j++) {
      if (dp[K - 1][j] < INF && gapFree(j + 1, M - 1) && dp[K - 1][j] < bestv) { bestv = dp[K - 1][j]; last = j; }
    }
    if (last < 0) return null;
    var segs = [], jj = last;
    for (r = K - 1; r >= 0; r--) {
      var ii = bkI[r][jj], jpr = bkJ[r][jj];
      if (ii < 0) return null;
      segs.push([ii, jj + 1]);
      jj = jpr;
    }
    segs.reverse();
    return segs;
  }

  /* --------------------------------------------- x 吸附 / 顺序对应 / y 生长 */
  /* 多列行：把行带里的横向段按**左右顺序**一一对应该行的题目框。
     为什么不能只靠"模型框中心落在哪个段里"：模型会把右侧列的框整体左移 170px，
     中心落在空白处 —— 顺序对应（段数 == 题目数时启用）比绝对坐标可靠得多。 */
  function orderX(ink, w, band, boxes, x1, x2, p) {
    var a = band[0], b = band[1];
    if (boxes.length < 2 || b <= a || x2 <= x1) return null;
    var ws = x2 - x1, prof = new Float64Array(ws), x, y;
    for (y = a; y < b; y++) {
      var base = y * w;
      for (x = x1; x < x2; x++) prof[x - x1] += ink[base + x];
    }
    var segs = mergeGaps(bands1d(prof, p.colTh), p.lineColGap), out = [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i][1] - segs[i][0] >= p.minSeg) out.push([segs[i][0] + x1, segs[i][1] + x1]);
    }
    if (out.length !== boxes.length) return null;
    return out.map(function (se) { return [Math.max(0, se[0] - p.xMargin), Math.min(w, se[1] + p.xMargin)]; });
  }

  /* 单框 x：在行带内把 x 吸附到该题局部的墨迹边界（取含模型中心的那个连续段）。 */
  function snapX(ink, w, band, box, p) {
    var a = band[0], b = band[1];
    var lx1 = Math.max(0, Math.round(box[0] - p.xPad));
    var lx2 = Math.min(w, Math.round(box[2] + p.xPad));
    if (b <= a || lx2 <= lx1) return [Math.round(box[0]), Math.round(box[2])];
    var ws = lx2 - lx1, prof = new Float64Array(ws), x, y;
    for (y = a; y < b; y++) {
      var base = y * w;
      for (x = lx1; x < lx2; x++) prof[x - lx1] += ink[base + x];
    }
    var segs = mergeGaps(bands1d(prof, p.snapColTh), p.snapColGap);
    if (!segs.length) return [Math.round(box[0]), Math.round(box[2])];
    var c = (box[0] + box[2]) / 2.0, pick = null, bd = Infinity;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i][0] + lx1, e = segs[i][1] + lx1;
      if (s <= c && c <= e) { pick = [s, e]; break; }
      var dd = Math.min(Math.abs(c - s), Math.abs(c - e));
      if (dd < bd) { bd = dd; pick = [s, e]; }
    }
    return [Math.max(0, pick[0] - p.xMargin), Math.min(w, pick[1] + p.xMargin)];
  }

  /* 把 y 向上下"长到没墨为止"，最多跳过 gap 行空白，不得超出 [lo, hi]。
     这条规则说的是"**有墨就长、没墨就停**"：作答墨迹与题干之间没有空行就会长上去，
     下一题之前通常有空行就停在那里 —— 不需要知道"这是不是竖式题"。 */
  function growY(ink, w, h, y1, y2, x1, x2, lo, hi, gap, th) {
    x1 = Math.max(0, Math.round(x1)); x2 = Math.min(w, Math.round(x2));
    if (x2 <= x1) return [Math.round(y1), Math.round(y2)];
    lo = Math.max(0, Math.round(lo));
    hi = Math.min(h - 1, Math.round(hi));
    y1 = clamp(Math.round(y1), lo, hi); y2 = clamp(Math.round(y2), y1, hi);
    function rowSum(y) {
      var base = y * w, s = 0;
      for (var x = x1; x < x2; x++) s += ink[base + x];
      return s;
    }
    var a = y1, blank = 0;
    while (a - 1 >= lo) {
      if (rowSum(a - 1) >= th) blank = 0;
      else { blank++; if (blank > gap) break; }
      a--;
    }
    var b = y2; blank = 0;
    while (b + 1 <= hi) {
      if (rowSum(b + 1) >= th) blank = 0;
      else { blank++; if (blank > gap) break; }
      b++;
    }
    return [a, b];
  }

  /* ---------------------------------------------------------------- 主流程 */
  /* boxes: [[x1,y1,x2,y2], ...]（**工作坐标系**）。返回同长度的吸附后框，或 null。 */
  function refineCore(ink, w, h, boxes, p) {
    var n = boxes.length;
    if (!n) return null;
    var rows = clusterRows(boxes, p.rowTol);
    if (rows.length < 1) return null;

    var xs1 = Infinity, xs2 = -Infinity, i, r;
    for (i = 0; i < n; i++) { xs1 = Math.min(xs1, boxes[i][0]); xs2 = Math.max(xs2, boxes[i][2]); }
    /* 行投影的 x 范围：模型框并集再外扩，但**至少覆盖页宽的 8%~92%**。
       为什么不能只跟着模型框走：模型有一次把最右列的框给窄了 70px，行投影范围随之右移，
       判定分集体失真（真值行从 0.60 掉到 0.12 被误剔除），整页直接回退。 */
    var lx1 = Math.max(0, Math.min(Math.round(xs1 - p.xExpand), Math.round(p.xEdge * w)));
    var lx2 = Math.min(w, Math.max(Math.round(xs2 + p.xExpand), Math.round((1 - p.xEdge) * w)));
    if (lx2 <= lx1) return null;

    var prof = new Float64Array(h);
    for (var y = 0; y < h; y++) {
      var base = y * w, acc = 0;
      for (var x = lx1; x < lx2; x++) acc += ink[base + x];
      prof[y] = acc;
    }
    var lines = mergeOverlaps(findLineBands(prof, p.peakMin, p.peakRel, p.peakDist,
                                            p.hmin, p.hmax, p.smoothW), p.mergeOv);
    if (!lines.length) return null;

    var scores = [], kinds = [];
    for (i = 0; i < lines.length; i++) {
      var st = bandStructure(ink, w, h, lines[i], lx1, lx2, p);
      scores.push(st[1]); kinds.push(st[2]);
    }
    var bounds = lines;
    if (bounds.length < rows.length) return null;

    var modelC = [], modelH = [];
    for (r = 0; r < rows.length; r++) {
      var idxs = rows[r], cy = 0, hs = [];
      for (i = 0; i < idxs.length; i++) { var b = boxes[idxs[i]]; cy += (b[1] + b[3]) / 2; hs.push(b[3] - b[1]); }
      modelC.push(cy / idxs.length);
      hs.sort(function (a, b2) { return a - b2; });
      var m = hs.length;
      modelH.push(m % 2 ? hs[(m - 1) / 2] : (hs[m / 2 - 1] + hs[m / 2]) / 2);
    }

    var kindsFull = kinds, segW = scores;
    p = (function () { var q = {}, k; for (k in p) q[k] = p[k]; q.segW = segW; return q; })();
    var segs = alignSegments(modelC, modelH, bounds, rows.length, kindsFull, p);
    if (!segs) return null;

    var out = new Array(n);
    for (r = 0; r < rows.length; r++) {
      var seg = segs[r];
      var sy1 = bounds[seg[0]][0], sy2 = bounds[seg[1] - 1][1];
      var idxRow = rows[r];
      var multi = idxRow.length >= 2;
      var sorted = idxRow.slice().sort(function (k1, k2) { return boxes[k1][0] - boxes[k2][0]; });
      var ox = null;
      if (multi) {
        var arr = [];
        for (i = 0; i < sorted.length; i++) arr.push(boxes[sorted[i]]);
        ox = orderX(ink, w, [sy1, sy2], arr, lx1, lx2, p);
      }
      for (var t = 0; t < sorted.length; t++) {
        var k = sorted[t], bx = boxes[k];
        var ay1 = sy1, ay2 = sy2;
        var y1, y2, x1, x2;
        var bandH = Math.max(1, ay2 - ay1);
        var pad = Math.min(Math.max(Math.round((bx[3] - bx[1]) * p.widenRatio), p.padMin), p.padMax);
        var ext = (bx[3] - bx[1]) > p.growExtRatio * bandH ? p.growExt : 0;
        if (p.growGap > 0 && (bx[3] - bx[1]) > p.growHRatio * bandH) {
          /* 「有墨就长、没墨就停」。⚠️ 只在**模型框明显比行带高**时才长：
             两页的真值标注约定是**相反**的 —— 密集页贴着印刷字（h=28~34），
             小学练习页把学生作答区圈进去（Q19 真值 h=216、印刷行只有 22）。
             无差别地长，密集页精度会掉一半。
             ⚠️ 扩张的上界不能只有"模型框 ± pad(≤110)"：模型框常常只罩住多行题的
             **第一行**，pad 会把扩张卡死（实测某题覆盖率只有 0.34）。growExt 补这一截。 */
          var loB = Math.min(ay1, bx[1] - pad) - ext;
          var hiB = Math.max(ay2, bx[3] + pad) + ext;
          var g = growY(ink, w, h, ay1, ay2, bx[0], bx[2], loB, hiB, p.growGap, p.growInk);
          if (multi) { y1 = g[0]; y2 = g[1]; }
          else {
            y1 = Math.min(g[0], bx[1] - pad, ay1 - ext);
            y2 = Math.max(g[1], bx[3] + pad, ay2 + ext);
          }
        } else {
          if (multi) { y1 = ay1; y2 = ay2; }
          else {
            y1 = Math.min(bx[1] - pad, ay1);
            y2 = Math.max(bx[3] + pad, ay2);
          }
        }
        y1 = Math.max(0, y1 - p.yMargin);
        y2 = Math.min(h, y2 + p.yMargin);
        if (ox) { x1 = ox[t][0]; x2 = ox[t][1]; }
        else {
          var sx = snapX(ink, w, [sy1, sy2], bx, p);
          x1 = sx[0]; x2 = sx[1];
          /* x 保护：吸附结果若与模型框几乎不重叠，说明列投影被"图 / 笔迹"带跑了，
             这种时候退回模型框，别把框挪到隔壁去。 */
          if (Math.min(x2, bx[2]) - Math.max(x1, bx[0]) <= p.xKeepOv * (bx[2] - bx[0])) { x1 = bx[0]; x2 = bx[2]; }
        }
        out[k] = [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
      }
    }
    for (i = 0; i < n; i++) if (!out[i]) out[i] = boxes[i].slice();
    return { boxes: out, lines: bounds, kinds: kindsFull, segs: segs };
  }

  /* ---------------------------------------------------------------- 对外接口 */
  /* snap({ image, boxes:[{i,bbox}], params }) -> { boxes:{i:[x1,y1,x2,y2]}, ... } | null
     · image：HTMLImageElement / ImageBitmap（naturalWidth/naturalHeight = 原图尺寸）
     · boxes：模型给的框（**原图像素**）
     · 失败一律返回 null，调用方退回"外扩 35%"。 */
  function snap(opts) {
    var img = opts.image, list = opts.boxes || [];
    if (!img || !list.length) return null;
    var W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
    if (!W0 || !H0) return null;
    var p0 = params(opts.params);
    var s = p0.workMax > 0 ? Math.min(1, p0.workMax / Math.max(W0, H0)) : 1;
    var w = Math.max(1, Math.round(W0 * s)), h = Math.max(1, Math.round(H0 * s));
    var p = scaleParams(p0, s);

    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    var data;
    try { data = g.getImageData(0, 0, w, h).data; }
    catch (e) { return null; }                       // 跨域图读像素会抛 → 退回老策略
    cv.width = cv.height = 0;                        // 立刻放掉画布

    var lum = p_inkLum(data, w, h, p);
    var ink = buildInk(data, w, h, lum, p.inkChroma);
    data = null;

    var idxs = [], bx = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i].bbox;
      if (!b || b.length < 4) continue;
      idxs.push(list[i].i);
      bx.push([b[0] * s, b[1] * s, b[2] * s, b[3] * s]);
    }
    if (!bx.length) return null;
    var res = refineCore(ink, w, h, bx, p);
    ink = null;
    if (!res) return null;

    var map = {}, inv = 1 / s;
    for (i = 0; i < idxs.length; i++) {
      var o = res.boxes[i];
      map[idxs[i]] = [clamp(Math.round(o[0] * inv), 0, W0), clamp(Math.round(o[1] * inv), 0, H0),
                      clamp(Math.round(o[2] * inv), 0, W0), clamp(Math.round(o[3] * inv), 0, H0)];
    }
    return { boxes: map, scale: s, W: W0, H: H0, inkLum: lum, lines: res.lines.length };
  }

  function p_inkLum(d, w, h, p) {
    return resolveInkLum(d, w, h, p.inkLum, p.inkChroma, 0.68, 60);
  }

  /* ══════════════════════════════════════════════════ 插图框吸附（figures）
     题区那套（行带 + 单调对齐 DP）解决的是「模型行 → 版面行」的**顺序对应**，
     插图的错法完全不同，是**边界**问题：
       · 框偏了 —— paper6 q35 的框整段落在广告下方 150px 的空白里；
       · 框太小 —— q29/q37 只罩住图形块的一部分；
       · 框伸进旁边内容 —— q30 混进题面印刷字、q32 混进学生「406」笔迹。
     而且插图块高 150~300px，题区那套的 hmin/hmax(16~95) 第一关就把它整个滤掉，
     所以**不能复用**，另走一路。

     判据（沿「有墨就长、没墨就停」的思路，但从「点」换成「段」）：
       ① 搜索窗 ROI = 模型框外扩 max(roi, roiRatio×框宽/高)；
       ② 在 ROI 里对**行**投影分段（允许块内部 ≤gapY 的白 —— 图形块内部本来就有白）；
       ③ 选**与模型框 y 区间重叠最大**的那一段。⚠️ 不能只看「模型框中心落在哪一段」：
          模型框可能整个落在图形块外面（q35 就是这样），中心落在空白里，一找就错；
       ④ 在该行段里同样处理**列**，选与模型框 x 区间重叠最大的一段；
       ⑤ 行列互换再跑一遍收敛；外缘补 pad（图形块的边框线不能被切）；
       ⑥ 每条边最多向外走 max(msMin, msFrac×框宽/高)。不设上限的话，密集页上会
          顺着相邻文字行连成一片（q30 会从图形块一路吃到题面文字，面积涨到 4.2 倍）。

     兜底：任何一步失败 / ROI 太小 / 结果面积 > maxGrow×模型框 / 比模型框还小到
     minScale 以下 → **这一张图不进结果 map**，调用方（recognize.js 的 toRow）
     退回老的「外扩 min(w,h)×25%（30~80px）」—— 绝不比现在更差。

     实测（9 张人工标注插图：paper6 的 7 张 + 语料里 2 张有模型原始框的，
           真值 = 人工逐像素核过的框，IoU）：
       平均 0.564（现状外扩）→ **0.817**（吸附）；最差一例 0.601（现状最差 0.198）；
       没有一例低于 0.5、没有一例比现状差（q30 / q37 两条走兜底，保持原样）。
     典型：q35 0.198→0.792、q32 0.587→0.852、q39甲 0.400→0.742、
           泳道图 0.487→0.947、电梯标牌 0.499→0.976。

     ⚠️ 参数与 tools/figsnap_proto.py **必须同步**（那边是调参/对账用的 Python 孪生，
     对账脚本 tools/figsnap_eval.py 跑 Python 侧、tools/figsnap_js_check.mjs 把本文件
     注入浏览器跑同一批样本，逐张比两边的框、比 IoU）。 */
  var FIG_DEFAULTS = {
    workMax: 1600,     // 内部工作分辨率的长边上限（0 = 用原图；跑对账时用）
    inkLum: 118,       // 与 refine 同口径的印刷黑阈值（自适应下调见 resolveInkLum）
    inkChroma: 42,
    roi: 90,           // 搜索窗至少外扩这么多 px
    roiRatio: 0.75,    // 或外扩「框宽/高 × 该比例」，取大者
    gapY: 14,          // 纵向：块内文字行之间允许的白（px）
    gapX: 10,          // 横向
    thFrac: 0.024,     // 「这一行/列有墨」= 墨像素 ≥ 该比例 × 采样长度
    thMin: 3,
    minLenY: 12,       // 一条行段至少这么高才算内容（滤噪点）
    minLenX: 12,
    pad: 8,            // 外缘再补的余量
    msFrac: 0.7,       // 每条边最多向外移动「框宽/高 × 该比例」
    msMin: 45,         // 或者至少这么多 px（取大者）
    maxGrow: 2.4,      // 面积 / 模型框面积 的上限（超过 → 兜底）
    minScale: 0.4,     // 宽或高小于「模型框 × 该比例」→ 兜底
    barFrac: 0.85      // 整行/列墨占比超过它 → 判为照片黑边（手机截图上下黑条）
  };
  var FIG_PX_KEYS = ["roi", "gapY", "gapX", "thMin", "minLenY", "minLenX", "pad", "msMin"];

  function figParams(over) {
    var p = {}, k;
    for (k in FIG_DEFAULTS) p[k] = FIG_DEFAULTS[k];
    if (over) for (k in over) if (over[k] !== undefined && over[k] !== null) p[k] = over[k];
    return p;
  }
  function figScale(p, s) {
    var q = {}, k, i;
    for (k in p) q[k] = p[k];
    for (i = 0; i < FIG_PX_KEYS.length; i++) {
      k = FIG_PX_KEYS[i];
      if (typeof q[k] === "number") q[k] = q[k] * s;
    }
    q.minLenY = Math.max(3, q.minLenY);
    q.minLenX = Math.max(3, q.minLenX);
    q.thMin = Math.max(2, q.thMin);
    return q;
  }

  /* 照片里被手机黑边/桌面压住的行列要排除（paper6 上下各有一条截图黑边）。
     判据：整行/整列的墨占比 > barFrac —— 真实卷面不可能有那么满。 */
  function figContentArea(ink, w, h, barFrac) {
    var i, c;
    function rowPct(y) { var base = y * w, n = 0; for (var x = 0; x < w; x++) n += ink[base + x]; return n / w; }
    function colPct(x) { var n = 0; for (var y = 0; y < h; y++) n += ink[y * w + x]; return n / h; }
    var y0 = 0, y1 = h, x0 = 0, x1 = w;
    while (y0 < h && rowPct(y0) > barFrac) y0++;
    while (y1 > y0 && rowPct(y1 - 1) > barFrac) y1--;
    while (x0 < w && colPct(x0) > barFrac) x0++;
    while (x1 > x0 && colPct(x1 - 1) > barFrac) x1--;
    return [x0, y0, x1, y1];
  }

  /* 一维投影 → 段：墨 ≥th 的连续段，间隔 ≤gap 的合并，短于 minlen 的丢掉。 */
  function figSegments(prof, th, gap, minlen) {
    var raw = [], s = -1, i;
    for (i = 0; i < prof.length; i++) {
      if (prof[i] >= th) { if (s < 0) s = i; }
      else if (s >= 0) { raw.push([s, i]); s = -1; }
    }
    if (s >= 0) raw.push([s, prof.length]);
    var merged = [];
    for (i = 0; i < raw.length; i++) {
      if (merged.length && raw[i][0] - merged[merged.length - 1][1] <= gap)
        merged[merged.length - 1][1] = raw[i][1];
      else merged.push([raw[i][0], raw[i][1]]);
    }
    var out = [];
    for (i = 0; i < merged.length; i++)
      if (merged[i][1] - merged[i][0] >= minlen) out.push(merged[i]);
    return out;
  }

  /* 挑与 [a,b] 重叠最大的段；全都压不上就挑中心最近的那段。 */
  function figPick(segs, a, b) {
    if (!segs.length) return null;
    var best = null, bv = -1, i, d, bd = Infinity, c = (a + b) / 2;
    for (i = 0; i < segs.length; i++) {
      var ov = Math.min(b, segs[i][1]) - Math.max(a, segs[i][0]);
      if (ov > bv) { bv = ov; best = segs[i]; }
    }
    if (bv > 0) return best;
    for (i = 0; i < segs.length; i++) {
      d = Math.abs((segs[i][0] + segs[i][1]) / 2 - c);
      if (d < bd) { bd = d; best = segs[i]; }
    }
    return best;
  }

  function figProfRows(ink, w, x1, x2, y1, y2) {   // 每行在 x∈[x1,x2] 上的墨数
    var prof = new Float64Array(y2 - y1 + 1), x, y, base;
    for (y = y1; y <= y2; y++) {
      base = y * w;
      var n = 0;
      for (x = x1; x <= x2; x++) n += ink[base + x];
      prof[y - y1] = n;
    }
    return prof;
  }
  function figProfCols(ink, w, y1, y2, x1, x2) {   // 每列在 y∈[y1,y2] 上的墨数
    var prof = new Float64Array(x2 - x1 + 1), x, y;
    for (x = x1; x <= x2; x++) {
      var n = 0;
      for (y = y1; y <= y2; y++) n += ink[y * w + x];
      prof[x - x1] = n;
    }
    return prof;
  }

  /* 单张插图吸附（工作坐标系）。返回 [x1,y1,x2,y2] 或 null（null = 兜底）。 */
  function figSnapCore(ink, w, h, box, p, area) {
    var ax0 = area[0], ay0 = area[1], ax1 = area[2], ay1 = area[3];
    var x1 = box[0], y1 = box[1], x2 = box[2], y2 = box[3];
    var bw = Math.max(1, x2 - x1), bh = Math.max(1, y2 - y1);
    var rw = Math.max(p.roi, p.roiRatio * bw), rh = Math.max(p.roi, p.roiRatio * bh);
    var rx1 = Math.max(ax0, Math.floor(x1 - rw)), rx2 = Math.min(ax1 - 1, Math.ceil(x2 + rw));
    var ry1 = Math.max(ay0, Math.floor(y1 - rh)), ry2 = Math.min(ay1 - 1, Math.ceil(y2 + rh));
    if (rx2 - rx1 < 12 || ry2 - ry1 < 12) return null;

    var cur = [rx1, ry1, rx2, ry2], it;
    for (it = 0; it < 2; it++) {
      var prof = figProfRows(ink, w, cur[0], cur[2], ry1, ry2);
      var th = Math.max(p.thMin, p.thFrac * (cur[2] - cur[0]));
      var pk = figPick(figSegments(prof, th, p.gapY, p.minLenY), y1 - ry1, y2 - ry1);
      if (!pk) return null;
      var ny1 = ry1 + pk[0], ny2 = ry1 + pk[1];
      prof = figProfCols(ink, w, ny1, ny2, cur[0], cur[2]);
      th = Math.max(p.thMin, p.thFrac * (ny2 - ny1));
      pk = figPick(figSegments(prof, th, p.gapX, p.minLenX), x1 - cur[0], x2 - cur[0]);
      if (!pk) return null;
      var nx1 = cur[0] + pk[0], nx2 = cur[0] + pk[1];
      cur = [nx1, ny1, nx2, ny2];
      rx1 = nx1; rx2 = nx2; ry1 = ny1; ry2 = ny2;
    }

    var ox1 = Math.max(ax0, cur[0] - p.pad), oy1 = Math.max(ay0, cur[1] - p.pad);
    var ox2 = Math.min(ax1, cur[2] + p.pad), oy2 = Math.min(ay1, cur[3] + p.pad);
    var sx = Math.max(p.msMin, p.msFrac * bw), sy = Math.max(p.msMin, p.msFrac * bh);
    ox1 = Math.max(ox1, x1 - sx); ox2 = Math.min(ox2, x2 + sx);
    oy1 = Math.max(oy1, y1 - sy); oy2 = Math.min(oy2, y2 + sy);
    if (ox2 - ox1 < 8 || oy2 - oy1 < 8) return null;
    if (ox2 - ox1 < p.minScale * bw || oy2 - oy1 < p.minScale * bh) return null;
    if ((ox2 - ox1) * (oy2 - oy1) > p.maxGrow * bw * bh) return null;
    return [ox1, oy1, ox2, oy2];
  }

  /* snapFigures({ image, boxes:[{i,bbox}], params }) -> { boxes:{i:[x1,y1,x2,y2]} } | null
     · 只包含**吸附成功**的项；没进 map 的（key 不存在）由调用方走外扩兜底。
     · image：HTMLImageElement / ImageBitmap；boxes 的 bbox 是**原图像素**。 */
  function snapFigures(opts) {
    var img = opts.image, list = opts.boxes || [];
    if (!img || !list.length) return null;
    var W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
    if (!W0 || !H0) return null;
    var p0 = figParams(opts.params);
    var s = p0.workMax > 0 ? Math.min(1, p0.workMax / Math.max(W0, H0)) : 1;
    var w = Math.max(1, Math.round(W0 * s)), h = Math.max(1, Math.round(H0 * s));
    var p = figScale(p0, s);

    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    var data;
    try { data = g.getImageData(0, 0, w, h).data; }
    catch (e) { return null; }                       // 跨域图读像素会抛 → 退回老策略
    cv.width = cv.height = 0;

    var lum = p_inkLum(data, w, h, p);
    var ink = buildInk(data, w, h, lum, p.inkChroma);
    data = null;
    var area = figContentArea(ink, w, h, p.barFrac);

    var map = {}, inv = 1 / s, n = 0, i;
    for (i = 0; i < list.length; i++) {
      var b = list[i].bbox;
      if (!b || b.length < 4) continue;
      var r = null;
      try { r = figSnapCore(ink, w, h, [b[0] * s, b[1] * s, b[2] * s, b[3] * s], p, area); }
      catch (e2) { r = null; }
      if (!r) continue;
      map[list[i].i] = [clamp(Math.round(r[0] * inv), 0, W0), clamp(Math.round(r[1] * inv), 0, H0),
                        clamp(Math.round(r[2] * inv), 0, W0), clamp(Math.round(r[3] * inv), 0, H0)];
      n++;
    }
    ink = null;
    return { boxes: map, count: n, scale: s, W: W0, H: H0, inkLum: lum };
  }

  window.Refine = {
    DEFAULTS: DEFAULTS,
    FIG_DEFAULTS: FIG_DEFAULTS,
    snap: snap,
    snapFigures: snapFigures,
    // 给对账脚本用的内部件（不改行为）
    _internals: {
      buildInk: buildInk, paperLevel: paperLevel, resolveInkLum: resolveInkLum,
      findLineBands: findLineBands, bandStructure: bandStructure, alignSegments: alignSegments,
      refineCore: refineCore, params: params, scaleParams: scaleParams,
      figParams: figParams, figScale: figScale, figContentArea: figContentArea,
      figSegments: figSegments, figPick: figPick, figSnapCore: figSnapCore,
    },
  };
})();
