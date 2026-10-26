/* 识别后自检（app/js/recognize.js 的 auditOne / auditPaper）的对账脚本。
 *
 * 为什么不用浏览器：recognize.js 只在真正识别时才碰 document，纯定义阶段只写 window。
 * 这里造一个 window 就能把它加载进来，比起 CDP 快得多、也没有端口依赖。
 *
 * 两件事：
 *   A. 判据样板：每条判据"该抓的抓到、不该抓的别动"（后者更重要 —— 误报会让人
 *      对红色疲劳，真错反而被淹掉）。
 *   B. 真实题库误报率：app/assets/demo-library.json（5 卷 135 题，人工核过的正常结果）
 *      整体命中率必须低于阈值。
 *
 * 用法：node tools/reco_audit_check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
global.window = {};
new Function("window", fs.readFileSync(path.join(ROOT, "app/js/recognize.js"), "utf8"))(global.window);
const R = global.window.Recognize;
if (!R || !R.auditOne || !R.auditPaper) { console.error("✗ recognize.js 没有导出 auditOne/auditPaper"); process.exit(1); }

const T = (v) => ({ t: "text", v: v });
const L = (v) => ({ t: "latex", v: v });
const F = (bbox) => ({ t: "figure", bbox: bbox || [10, 10, 90, 90], caption: "图" });
function Q(stem, extra) {
  return Object.assign({
    seq: 1, qno: 1, qtype: "calculate", section: "一、计算", stem: stem,
    options: [], confidence: { stem: 0.95, options: null, figure: null },
  }, extra || {});
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}
function hit(list, ...subs) { return subs.every((s) => list.some((x) => x.indexOf(s) >= 0)); }

// ---------------------------------------------------------------- A① 该抓到的
console.log("\n【该抓到的】");
const SHOULD = [
  ["[?] 未辨认", Q([T("12[?]-[?]=")]), "[?]"],
  ["算式尾随运算符", Q([T("4×8-")]), "算式形式"],
  ["运算符连用", Q([T("12-+=8")]), "算式形式"],
  ["算式以乘除开头", Q([T("×8=40")]), "算式形式"],
  ["括号不配对", Q([L("(35-15\\div5")]), "算式形式"],
  ["题干为空", Q([]), "题干是空的"],
  ["选择题没有选项", Q([T("下面哪个对？")], { qtype: "choice", options: [] }), "选项不足"],
  ["低置信度", Q([T("计算 24÷3")], { confidence: { stem: 0.5 } }), "置信度偏低"],
];
for (const [name, q, sub] of SHOULD) {
  const f = R.auditOne(q);
  check(name, hit(f, sub), "得到 " + JSON.stringify(f));
}

// ---------------------------------------------------------------- A② 不该动的
console.log("\n【不该动的（防误报）】");
const SHOULD_NOT = [
  ["口算以 = 结尾", Q([T("4×8-11=")])],
  ["除法以 = 结尾", Q([T("200÷6=")])],
  ["分步算式两片段", Q([T("81÷9-3"), T("9-3=")])],
  ["比大小含括号", Q([L("(35-15)\\div5\\ \\bigcirc\\ 35-15\\div5")])],
  ["方框占位", Q([T("5+□×9=23")])],
  ["中文应用题", Q([T("欢欢在计算 5+□×9 时，先算加法，结果是多少？")])],
  ["四选项选择题", Q([T("下面哪个对？")], { qtype: "choice", options: [T("42"), T("43"), T("44"), T("45")] })],
  ["图片题无文字", Q([F()])],
  ["留空括号", Q([T("（　　）×60<431")])],
  ["高置信度", Q([T("计算 24÷3=")], { confidence: { stem: 0.93 } })],
  ["负号在中间", Q([T("150-95+5=")])],
];
for (const [name, q] of SHOULD_NOT) {
  const f = R.auditOne(q);
  check(name, f.length === 0, "得到 " + JSON.stringify(f));
}

// ---------------------------------------------------------------- A③ 跨题判据
console.log("\n【跨题判据】");
{
  const rows = [Q([T("4×8=")])
    , Object.assign(Q([T("6×3=")]), { seq: 2, qno: 2 })
    , Object.assign(Q([T("25+5=")]), { seq: 3, qno: 4 })];
  const r = R.auditPaper(rows);
  check("题号跳号（1,2,4）", hit(r.flags["3"] || [], "题号不连续"),
    JSON.stringify(r.flags));
}
{
  const rows = [Q([T("用竖式计算 24×3")]), Object.assign(Q([T("用竖式计算 24×3")]), { seq: 2, qno: 2 })];
  const r = R.auditPaper(rows);
  check("题干重复", hit(r.flags["2"] || [], "完全一样"), JSON.stringify(r.flags));
}
{
  const rows = [Q([T("计算")]), Object.assign(Q([T("计算")]), { seq: 2, qno: 2 })];
  const r = R.auditPaper(rows);
  check("两字题干重复不算（太短）", r.suspect === 0, JSON.stringify(r.flags));
}
{
  const rows = [Q([T("4×8=")]), Object.assign(Q([T("6×3=")]), { seq: 2, qno: 2 })];
  const r = R.auditPaper(rows);
  check("正常小题不报", r.suspect === 0, JSON.stringify(r.flags));
}

// ---------------------------------------------------------------- B 真实题库误报率
console.log("\n【真实题库误报率】（demo-library.json，人工核过的正常识别结果）");
const lib = JSON.parse(fs.readFileSync(path.join(ROOT, "app/assets/demo-library.json"), "utf8"));
let tot = 0, sus = 0;
for (const p of lib.papers) {
  const rows = (p.questions || []).map((q, i) => Object.assign({}, q, { seq: i + 1, id: i + 1 }));
  const r = R.auditPaper(rows);
  tot += rows.length; sus += r.suspect;
  if (r.suspect) console.log(`  · ${p.title}：${rows.length} 题中挑出 ${r.suspect} 题`);
}
const rate = tot ? sus / tot : 0;
check(`命中率 ${(rate * 100).toFixed(1)}% ≤ 8%（${sus}/${tot}）`, rate <= 0.08);

console.log(`\n识别后自检对账：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
