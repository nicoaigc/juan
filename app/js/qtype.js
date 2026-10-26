/* 题型分桶 —— 全站唯一口径（首页统计 / 组卷台 / 卷面排版 / 打印都用它）。
   识别存下来的 type 只有 6 个值（choice / fill / calculate / solve / geometry / proof / other），
   但排卷面需要更细：竖式 · 递等式要从 solve 里分出来当"计算题"，判断题单独成桶，
   「在○里填入＞＜=」这类**比大小**也从 fill 里分出来单独成一个板块。
   旧的 calculate 归一成 calc，老数据读进来照样认。

   为什么单独一个文件：首页的题型分布、组卷台的筛选、卷面的板块分组必须同口径，
   以前各写一套（首页按 qtype 直读），结果首页显示"解答 N"、卷面却把这几道题排进"计算题"。
   谁要分桶都从这里拿。 */
window.QType = (function () {
  /* [桶键, 板块默认名, 默认列数]；数组顺序 = 排板块时的先后 */
  var TYPE_SECTION = [
    ["choice",   "选择题",   1],
    ["fill",     "填空题",   1],
    ["compare",  "比大小",   3],
    ["calc",     "计算题",   3],
    ["judge",    "判断题",   1],
    ["solve",    "应用题",   1],
    ["geometry", "几何题",   1],
    ["proof",    "证明题",   1],
    ["other",    "其他",     1],
  ];
  var TYPE_TITLE = {};
  TYPE_SECTION.forEach(function (d) { TYPE_TITLE[d[0]] = d[1]; });

  /* 题型小标上的短名（排版模式下显示在题目右上角，点它就能改题型） */
  var TYPE_SHORT = {
    choice: "选择", fill: "填空", compare: "比大小", calc: "计算", judge: "判断",
    solve: "应用", geometry: "几何", proof: "证明", other: "其他",
  };

  var TYPE_ALIAS = {
    choice: "choice", fill: "fill", compare: "compare",
    calc: "calc", calculate: "calc",
    judge: "judge", solve: "solve", geometry: "geometry", proof: "proof", other: "other",
  };

  /* 卷面印的板块名比模型的题型判得准 —— 模型只有 6 个类型，「2. 用竖式计算」「三、递等式计算」
     会被打成 solve（解答），整段跑到应用题里去（用户反馈的"分类错误"就是这个）。
     所以**先看板块名**，认不出来再看题型。顺序即优先级。 */
  var SEC_RULES = [
    [/判断/,                                                          "judge"],
    [/解决|应用|实际问题/,                                              "solve"],
    [/选择/,                                                          "choice"],
    /* 比大小单独成桶（用户要求）：卷面印的「在○里填＞＜=」「比大小」是**一类独立大题**，
       不是填空 —— 判据是题干里那个 ○ 是**运算符**（`102×3 ○ 500`），跟填空题的空位不是一回事。
       这条必须排在下面那条「填」之前，否则「在○里填入…」会先被 `填` 抢走归进填空题。 */
    [/比大小|在○里填|○里填/,                                           "compare"],
    [/填/,                                                            "fill"],
    [/竖式|递等式|脱式|口算|算一算|直接写出得数|计算|列式|综合算式|估算/,  "calc"],
    [/几何|图形|作[图画]/,                                              "geometry"],
    [/证明/,                                                          "proof"],
  ];

  function normBucket(t) { return TYPE_ALIAS[String(t == null ? "" : t)] || "other"; }

  function typeIndex(k) {
    k = normBucket(k);
    for (var i = 0; i < TYPE_SECTION.length; i++) if (TYPE_SECTION[i][0] === k) return i;
    return TYPE_SECTION.length - 1;
  }

  /* 剥掉板块名开头的卷面序号（"一、"、"（2）"、"1."），拿纯名比关键词 */
  function stripSecNo(t) {
    return String(t == null ? "" : t)
      .replace(/^\s*(?:[（(]\s*[一二三四五六七八九十\d]{1,3}\s*[)）]\s*|[一二三四五六七八九十]{1,3}\s*[、.．]\s*|\d{1,2}\s*[、.．]\s*)/, "")
      .trim();
  }

  /* 一道题（识别结果结构）属于哪个桶：手动打标 > 板块名 > 模型题型。
     手动打标（source.qtype_manual，题目详情页 / 组卷台题库里点的）必须是最高优先 ——
     用户改它就是为了纠正「卷面板块名误导」或「模型判错」，再被板块名抢回去打标就白打了。 */
  function bucketOf(q) {
    if (!q) return "other";
    var man = q.source && q.source.qtype_manual;
    if (man) return normBucket(man);
    var sec = String(q.section || "");
    for (var i = 0; i < SEC_RULES.length; i++) if (SEC_RULES[i][0].test(sec)) return SEC_RULES[i][1];
    return normBucket(q.qtype || q.type);
  }

  /* 一个板块（layout.section）属于哪个桶：显式 type 优先，其次认板块名里的关键词。
     板块名是用户自己改的（"计算题"→"口算"）也要认得出，所以不能只比类型键。 */
  function secBucket(s) {
    if (s && s.type) return normBucket(s.type);
    var name = stripSecNo(s && s.title);
    if (!name) return "";
    for (var i = 0; i < SEC_RULES.length; i++) if (SEC_RULES[i][0].test(name)) return SEC_RULES[i][1];
    for (var j = 0; j < TYPE_SECTION.length; j++) {
      if (name.indexOf(TYPE_SECTION[j][1]) >= 0) return TYPE_SECTION[j][0];
    }
    return "";
  }

  return {
    TYPE_SECTION: TYPE_SECTION, TYPE_TITLE: TYPE_TITLE, TYPE_SHORT: TYPE_SHORT,
    TYPE_ALIAS: TYPE_ALIAS, SEC_RULES: SEC_RULES,
    normBucket: normBucket, typeIndex: typeIndex, stripSecNo: stripSecNo,
    bucketOf: bucketOf, secBucket: secBucket,
  };
})();
