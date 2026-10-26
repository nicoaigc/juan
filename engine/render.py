# -*- coding: utf-8 -*-
"""题目识别校对页渲染器：题目 JSON -> 单文件自包含 HTML（左右对照）。

只呈现「识别结果」——题干、选项、图形、题型、来源、置信度。
不含答案 / 解析 / 学生作答 / 批改 / 对错判定（那些不属于识别）。

为什么必须「单文件自包含」（踩过的坑，不要改回去）：
  * CDN 会被拦：WorkBuddy 预览面板带 CSP `default-src 'self' 'unsafe-inline'
    'unsafe-eval' blob: data:`，从 cdn.jsdelivr.net 拉 KaTeX 会被 blocked。
    所以 KaTeX（CSS + 20 个 woff2 字体 + JS）从 engine/vendor/katex/ 读入后
    全部内联（字体转 data: URI），零外部请求、可离线。
  * 相对路径会 404：预览把页面挂在 /static-html/ 下，页面里的 ../crops/x.jpg
    越界后变成 /static-html/crops/x.jpg → 404。所以裁剪图与题内插图一律内联为
    data: URI，不再依赖任何相对路径。
  全内联后每个页面都能独立打开、单独转发（发 .html 给别人也能看）。

用法:
    python render.py <questions.json 或目录> [-o 输出目录] [--no-katex]

仅依赖标准库；KaTeX 由浏览器端内联脚本完成。
生成（三层，全部单文件自包含）:
    data/render/index.html          卷卡片页（顶部按日期筛选，卡片 = 原图/题目数/解析日期，倒序）
    data/render/doc-<日期>-<hash>.html  卷详情页（原图 + 该卷解析出的题目列表）
    data/render/<id>.html           题目详情页（左右对照，与改造前一致）
原图缩略图由 tools/make_thumbs.py 预生成到 data/thumbs/（本脚本纯标准库，不会自己缩图）。
"""
import argparse
import base64
import hashlib
import html
import json
import re
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = PROJECT_ROOT / "data" / "render"
CROPS_DIR = PROJECT_ROOT / "data" / "crops"
ORIGINALS_DIR = PROJECT_ROOT / "data" / "benchmark"   # 试卷原图
THUMBS_DIR = PROJECT_ROOT / "data" / "thumbs"          # 原图缩略图（tools/make_thumbs.py 生成）
VENDOR_DIR = PROJECT_ROOT / "engine" / "vendor" / "katex"
BUNDLE_CACHE = VENDOR_DIR / "katex-inline.html"

# 卷的文件名形如「2026-10-01-第一二单元素养卷.jpg」——前缀就是识别日期
_DATE_PREFIX = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")

MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

# KaTeX CSS 里丢掉的 woff/ttf 备选源（现代浏览器只吃 woff2，留一份省 200KB）
_DROP_FALLBACK = re.compile(
    r',\s*url\(fonts/[A-Za-z0-9_\-]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)'
)
_WOFF2_URL = re.compile(r'url\(fonts/([A-Za-z0-9_\-]+\.woff2)\)')


def _data_uri(path: Path) -> str:
    """文件 -> data: URI（图片内联用，避免任何相对路径依赖）。"""
    mime = MIME.get(path.suffix.lower(), "application/octet-stream")
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def original_uri(name: str) -> tuple[str, bool]:
    """原图 -> (data: URI, 是否为缩略图)。

    优先用 data/thumbs/ 里的缩略图（列表页才不会被几 MB 原图撑爆）；
    缩略图不存在时回退原图，页面大一些但不会裂图。
    """
    thumb = THUMBS_DIR / (Path(name).stem + ".jpg")
    if thumb.is_file():
        return _data_uri(thumb), True
    orig = ORIGINALS_DIR / name
    if orig.is_file():
        return _data_uri(orig), False
    return "", False


def doc_slug(filename: str) -> str:
    """卷的页面文件名：纯 ASCII + 稳定（同一文件名每次渲染结果一致）。

    卷名是中文（`2026-10-01-第一二单元素养卷.jpg`），直接拿来做文件名在
    URL / 预览面板下容易出编码问题，所以「日期 + 文件名哈希前 4 位」。
    """
    date = doc_date(filename)
    tag = date.replace("-", "") if date != "未知" else "unknown"
    digest = hashlib.sha1(filename.encode("utf-8")).hexdigest()[:4]
    return f"doc-{tag}-{digest}"


def doc_date(filename: str) -> str:
    """卷的日期：文件名前缀 `YYYY-MM-DD`（识别当天）。"""
    m = _DATE_PREFIX.match(Path(filename).stem)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else "未知"


def doc_title(filename: str) -> str:
    """卷的标题：去掉日期前缀与扩展名的文件名。"""
    stem = Path(filename).stem
    return _DATE_PREFIX.sub("", stem).lstrip("-_ ") or stem


def paper_key(src: dict) -> str:
    """一份卷的分组键：同一份卷的多张照片共享 `source.paper`；没标的卷按单张照片分组。

    `source.paper` 是形如 `2026-10-01-第2单元练习卷.jpg` 的虚拟文件名（不必真实存在），
    好让 doc_date / doc_title / doc_slug 这些「按文件名推导」的函数原样复用。
    """
    return str(src.get("paper") or src.get("file") or "（未标注来源）")


def paper_files(items: list[dict]) -> list[str]:
    """该卷用到的全部原图（照片）文件名，**按页序**排列。

    页序优先取 `source.paper_page`（一份卷拍成多张照片时标，从 1 起）。
    文件名顺序天然等于页序的卷（如 `-p1..-p4`）可以不标；
    文件名顺序与页序相反时**必须**标，例如 `…-应用.jpg` 的 `-`(0x2D)
    在字符串排序里会跑到 `…卷.jpg` 的 `.`(0x2E) 前面，把后一页排到前面。
    没标 `paper_page` 的照片退回按文件名排序（= 旧行为，不受影响）。
    """
    page: dict[str, int | None] = {}
    for q in items:
        src = q.get("source") or {}
        fn = str(src.get("file") or "")
        if not fn:
            continue
        pg = src.get("paper_page")
        pg = pg if isinstance(pg, int) else None
        if fn not in page or (pg is not None and (page[fn] is None or pg < page[fn])):
            page[fn] = pg
    # 标了页序的按页序在前，没标的按文件名排在后面（同旧行为）
    return sorted(page, key=lambda n: (1, 0, n) if page[n] is None else (0, page[n], n))


def _font_uri(name: str) -> str:
    font = VENDOR_DIR / "fonts" / name
    if not font.is_file():
        raise FileNotFoundError(f"缺少 KaTeX 字体：{font}")
    return "data:font/woff2;base64," + base64.b64encode(font.read_bytes()).decode("ascii")


def build_katex_bundle(force: bool = False) -> str:
    """把 KaTeX 的 CSS(字体内联) + JS 拼成一段可直接塞进 <head> 的 HTML。

    结果缓存到 engine/vendor/katex/katex-inline.html，源文件更新后自动重建。
    """
    css_path = VENDOR_DIR / "katex.min.css"
    js_path = VENDOR_DIR / "katex.min.js"
    ar_path = VENDOR_DIR / "auto-render.min.js"
    sources = [css_path, js_path, ar_path, *sorted((VENDOR_DIR / "fonts").glob("*.woff2"))]
    for p in sources:
        if not p.is_file():
            raise FileNotFoundError(f"缺少 KaTeX 资源：{p}（重新解包 katex npm tarball 的 dist/）")

    if not force and BUNDLE_CACHE.is_file():
        newest = max(p.stat().st_mtime for p in sources)
        if BUNDLE_CACHE.stat().st_mtime >= newest:
            return BUNDLE_CACHE.read_text(encoding="utf-8")

    css = css_path.read_text(encoding="utf-8")
    css = _DROP_FALLBACK.sub("", css)
    css = _WOFF2_URL.sub(lambda m: "url(" + _font_uri(m.group(1)) + ")", css)
    js = js_path.read_text(encoding="utf-8")
    ar = ar_path.read_text(encoding="utf-8")
    if "</script" in js.lower() or "</script" in ar.lower():
        raise ValueError("KaTeX 脚本含 </script，不能直接内联（改用 CDN? 或转义）")

    bundle = (
        "<style>\n" + css + "\n</style>\n"
        "<script>\n" + js + "\n</script>\n"
        "<script>\n" + ar + "\n</script>\n"
    )
    BUNDLE_CACHE.write_text(bundle, encoding="utf-8")
    return bundle


# 数学运算符：**text 片段**里的这些字符也要交给 KaTeX 画，才能跟 latex 片段里的
# `\times` `\div` 视觉一致。起因：识别结果里算式有两种存法——纯算式存成 latex 片段
# （`67-5\times5=`），夹在句子里的算式（`计算 268×3 时`、`40×□-20=100`）只能存成 text，
# 于是同一张卷上这两种 × 一个大一个小（实测宋体字形只有汉字高的 ~0.51，KaTeX ~0.71），
# 排在一起明显不齐。这里把 text 里的运算符逐个包成 KaTeX 行内式（`\(\times\)`），
# **数字、方框 ○△☆、留空括号都不动**——方框是渲染层用内联 SVG 画的（见 SYMBOL_TABLE），
# 括号留空要留给 paper.blanks_of() 数空给分，都不能进 KaTeX。
OP_LATEX = {"×": r"\times", "÷": r"\div", "+": "+", "-": "-",
            "=": "=", "<": "<", ">": ">"}
OP_CLASS = "[" + "".join(c for c in OP_LATEX if c != "-") + r"\-" + "]"   # 供 JS 的 new RegExp 用
_OP_RE = re.compile(OP_CLASS)


def mathify(text: str, katex_on: bool = True) -> str:
    """把 text 片段里的数学运算符包成 KaTeX 行内式（`katex_on=False` 时原样返回）。

    包成 `\\({}\\times{})` 而不是 `(\\times)`：两侧的空组把运算符变成**二元算子**，
    KaTeX 才会给它左右留出与 `268\\times4` 一样的间距 —— 只包字符的话它被当成独原子，
    贴得紧紧的，跟 latex 片段的排版还是两种观感。
    """
    if not katex_on or not _OP_RE.search(text):
        return text
    return _OP_RE.sub(lambda m: "\\({}" + OP_LATEX[m.group()] + "{}\\)", text)


def needs_katex(data: dict) -> bool:
    """题目要不要带 KaTeX 包。

    两种情形都要带：① 有 latex 片段；② text 片段里有数学运算符（`mathify` 会把它包成
    KaTeX 行内式，没带包就会原样显示成 `\\(\\times\\)`）。
    """
    segs = list(data.get("stem") or []) + list(data.get("options") or [])
    for s in segs:
        if not isinstance(s, dict):
            continue
        if s.get("t") == "latex":
            return True
        if s.get("t") == "text" and _OP_RE.search(str(s.get("v") or "")):
            return True
    return False


TYPE_TEXT = {
    "choice": "选择题",
    "fill": "填空题",
    "calculate": "计算题",
    "solve": "解答题",
    "geometry": "几何题",
    "proof": "证明题",
    "other": "其他",
}

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>题目：__ID__</title>
__KATEX__
<style>
  body { font-family: "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #222; }
  header { background: #1f2937; color: #fff; padding: 10px 20px; display: flex; gap: 16px; align-items: center; }
  header a { color: #93c5fd; text-decoration: none; }
  header .crumb { color: #9ca3af; font-size: 13px; }
  .flag { padding: 2px 10px; border-radius: 12px; font-size: 13px; }
  .flag.low { background: #fee2e2; color: #b91c1c; }
  .flag.ok { background: #dcfce7; color: #166534; }
  .wrap { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
  .panel { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08); flex: 1; }
  .panel h2 { margin: 0 0 10px; font-size: 15px; color: #555; }
  .panel img { max-width: 100%; border: 1px solid #ddd; }
  .qno { font-size: 18px; font-weight: bold; margin-bottom: 8px; }
  .qno .kind { font-size: 13px; font-weight: normal; color: #3730a3; background: #e0e7ff;
               padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .seg { line-height: 1.9; font-size: 16px; }
  .field { margin-top: 14px; }
  .field .label { font-size: 13px; color: #888; margin-bottom: 4px; }
  .field .content { border-left: 3px solid #dbeafe; padding: 6px 10px; background: #f8fafc;
                    border-radius: 0 6px 6px 0; line-height: 1.8; }
  .meta { margin-top: 18px; font-size: 12px; color: #9ca3af; line-height: 1.7; }
  .marks { margin-top: 12px; font-size: 13px; color: #6b7280; }
  .mark { display: inline-block; margin: 2px 6px 2px 0; background: #fef3c7; color: #92400e;
          padding: 2px 8px; border-radius: 10px; }
  .mark.low { background: #fee2e2; color: #b91c1c; }
  .qmark { background: #fde68a; padding: 0 4px; border-radius: 3px; }
  .figtag { background: #e0f2fe; color: #075985; padding: 1px 8px; border-radius: 4px; font-size: 14px; }
  /* 题内插图：src 已内联为 data: URI，不再走相对路径 */
  .figimg { display: block; max-width: min(100%, calc(440px * var(--fdw, 100) / 100)); margin: 10px 0 6px;
            padding: 6px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; }
  .figbox { display: block; }
  /* 显示位置 / 文字环绕（编辑里调的 pos / wrap，见 app/js/render.js 的 figView，同一口径） */
  .figbox.fp-l { margin-left: 0; margin-right: auto; }
  .figbox.fp-c { margin-left: auto; margin-right: auto; }
  .figbox.fp-r { margin-left: auto; margin-right: 0; }
  .figbox.fw-l { float: left; margin: 0 12px 6px 0; }
  .figbox.fw-r { float: right; margin: 0 0 6px 12px; }
  /* 插图说明（识别时补的 `figure.caption`）：图下小字，便于打印后图不清时仍能读懂题意 */
  .figcap { display: block; font-size: 12px; color: #6b7280; padding-left: 6px; margin: -2px 0 6px; }
__SYMBOL_CSS__
  .empty { color: #aaa; }
</style>
</head>
<body>
<header>
  <a href="__DOC_HREF__">&larr; 本卷题目</a>
  <a href="index.html">卷列表</a>
  <a href="papers.html">已生成试卷</a>
  <span class="crumb">__DOC_TITLE__</span>
  <span>__ID__（第 __NO__ 题 · __SECTION__）</span>
  <span class="flag __OVERALL__">整体置信度 __CONF__</span>
</header>
<div class="wrap">
  <div class="panel">
    <h2>原图（裁剪，已内联）</h2>
    <div id="crop">__CROP__</div>
  </div>
  <div class="panel">
    <h2>结构化还原（识别结果，可对照左栏核对）</h2>
    <div class="qno">第 __NO__ 题 <span class="kind">__TYPE__</span></div>
    <div class="seg" id="stem"></div>
    <div id="options"></div>
    <div class="marks" id="marks"></div>
    <div class="meta" id="meta"></div>
  </div>
</div>
<script>
const ASSETS = __ASSETS__;
const DATA = __DATA__;
const KATEX_ON = __KATEX_ON__;
const OPMAP = __OP_MAP__;
const OPRE = new RegExp(__OP_CLASS__, "g");
</script>
<script>
// 渲染内容片段：text 直接显示（[?] 高亮），latex 交给 KaTeX auto-render
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
// 占位/几何符号画成与汉字协调的等宽形状（字体自带字形偏小且大小不一）
// 表由渲染器注入：{ "□": ["box", "<svg …/>"], … }
const SYMBOLS = __SYMBOL_SVG__;
function symbols(s) {
  return s.replace(/[□○△☆■●▲★]/g, m => {
    const e = SYMBOLS[m];
    return e ? '<span class="sym ' + e[0] + '" title="' + m + '">' + e[1] + "</span>" : m;
  });
}
function mathify(s) {
  // text 片段里的数学运算符 -> KaTeX 行内式，与 latex 片段（\\times \\div）视觉一致。
  // 两侧的 `{}`（空组）把运算符变成二元算子，KaTeX 才会留出与 `268\\times4` 相同的间距。
  // 数字/方框/留空括号不动（方框另有内联 SVG，括号留空要留给数空给分）。
  if (!KATEX_ON) return s;
  return String(s).replace(OPRE, m => "\\\\(" + "{}" + OPMAP[m] + "{}" + "\\\\)");
}
function figcap(seg) {
  const cap = seg && seg.caption ? String(seg.caption) : "";
  return cap ? '<span class="figcap">' + esc(cap) + "</span>" : "";
}
// 题内插图的显示大小 / 位置（与 app/js/render.js 的 figView 同一口径）：
// dw = 30~100 的百分数（100 或不给 = 默认满宽）；pos = l/c/r；wrap = 文字环绕（左右才成立）。
function figView(seg) {
  const dw = Math.round(Number(seg && seg.dw) || 0);
  const sty = (dw >= 30 && dw < 100) ? ' style="--fdw:' + dw + '"' : "";
  const p = String((seg && seg.pos) || ""), wrap = !!(seg && seg.wrap);
  const cls = (p === "l" || p === "c" || p === "r")
    ? ((wrap && p !== "c") ? " fw-" + p : " fp-" + p) : "";
  return { cls: cls, sty: sty };
}
function frag(seg) {
  if (!seg) return "";
  if (seg.t === "latex") return KATEX_ON ? "\\\\(" + seg.v + "\\\\)" : esc(String(seg.v));
  if (seg.t === "figure") {
    // src = data/crops/ 下该插图自己的裁剪子图文件名；ASSETS 已把它换成 data: URI
    const name = String(seg.src || "").split("/").pop();
    const uri = name ? ASSETS[name] : "";
    const fv = figView(seg);
    if (uri) return '<span class="figbox' + fv.cls + '"' + fv.sty + '><img class="figimg" src="' + uri +
                    '" alt="' + esc(String((seg && seg.caption) || "题内插图")) + '">' +
                    figcap(seg) + "</span>";
    if (name) return '<span class="figtag">［图 · 裁剪文件缺失：' + esc(name) + '］</span>' + figcap(seg);
    return '<span class="figtag">［图 · 见左栏原图］</span>' + figcap(seg);
  }
  // 题干内的换行（同一小题印成多行时，识别结果用换行表示）-> <br>
  // ⚠️ 顺序不能反：先 mathify（此时还是纯文本，`<` 才能被认出并包进 KaTeX），
  //    再 esc（转义 `<`），最后 symbols（插 SVG）。反过来的话 mathify 会把
  //    SVG 里的 `stroke-width`/`aria-hidden` 连字符也当成运算符包掉。
  return symbols(esc(mathify(String(seg.v))))
    .replace(/\\[\\?\\]/g, '<span class="qmark">[?]</span>')
    .replace(/\\n/g, '<br>');
}
document.getElementById("stem").innerHTML = (DATA.stem || []).map(frag).join(" ");
if (DATA.options && DATA.options.length) {
  document.getElementById("options").innerHTML =
    '<div class="field"><div class="label">选项</div><div class="content">' +
    DATA.options.map((o, i) => "<b>" + String.fromCharCode(65 + i) + ".</b> " + frag(o)).join("<br>") + "</div></div>";
}
// 来源信息
(function () {
  const s = DATA.source || {};
  const bits = [];
  if (s.file) bits.push("来源文件：" + s.file + (s.page ? "（第 " + s.page + " 页）" : ""));
  if (s.bbox) bits.push("原图坐标：" + s.bbox.join(", "));
  if (s.crop) bits.push("裁剪文件：" + s.crop);
  // 题号一律不进题干；但裁剪里是否保留取决于「续行是否顶格」（顶格时必须保留，见识别规范），
  // 所以这里只断言「已从题干剔除」，裁剪处置留给下方核对说明讲。
  if (s.printed_no) bits.push("卷面题号：" + s.printed_no + "（已从题干剔除，未写入题干文本）");
  if (s.crop_reviewed) bits.push("裁剪边界已人工核对" + (s.review_note ? "：" + s.review_note : ""));
  document.getElementById("meta").innerHTML = bits.map(esc).join("<br>");
})();
// 低置信度 / [?] 汇总
const marks = [];
const conf = DATA.confidence || {};
for (const [k, v] of Object.entries(conf)) if (typeof v === "number" && v < 0.7) marks.push(["low", k + " 置信度 " + v]);
(function walk(segs) { (segs || []).forEach(s => { if (s && s.v && String(s.v).includes("[?]")) marks.push(["", "题干含 [?] 标记"]); }); })(DATA.stem);
document.getElementById("marks").innerHTML = marks.length
  ? "需人工确认：" + marks.map(([c, t]) => '<span class="mark ' + c + '">' + esc(t) + "</span>").join("")
  : '<span class="empty">无明显疑点</span>';
// 图片自检：data: URI 理论上不会失败，真失败就把原因写在页面上（别只留一个裂图）
document.querySelectorAll("img").forEach(img => {
  img.addEventListener("error", () => {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "［图片加载失败］" + (img.getAttribute("alt") || "");
    img.replaceWith(p);
  });
});
// KaTeX 渲染
window.addEventListener("DOMContentLoaded", () => {
  if (window.renderMathInElement) {
    renderMathInElement(document.body, {
      delimiters: [
        { left: "\\\\(", right: "\\\\)", display: false },
        { left: "\\\\[", right: "\\\\]", display: true },
      ],
      throwOnError: false,
    });
  }
});
</script>
</body>
</html>
"""

INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>试卷识别 · 卷列表</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background:#f5f6f8; margin:0; color:#222; }
  header { background:#1f2937; color:#fff; padding:14px 22px; display:flex; align-items:baseline; gap:14px; }
  header h1 { font-size:17px; margin:0; font-weight:600; }
  header .sub { color:#9ca3af; font-size:13px; }
  .filters { position:sticky; top:0; z-index:5; background:#fff; border-bottom:1px solid #e5e7eb;
             padding:10px 22px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .filters .flabel { font-size:13px; color:#6b7280; }
  .chip { border:1px solid #d1d5db; background:#fff; color:#374151; border-radius:16px;
          padding:5px 12px; font-size:13px; cursor:pointer; font-family:inherit; }
  .chip:hover { border-color:#93c5fd; }
  .chip.active { background:#1f2937; border-color:#1f2937; color:#fff; }
  .chip .n { margin-left:6px; opacity:.62; font-size:12px; }
  main { padding:16px 22px 40px; max-width:1000px; margin:0 auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(310px, 1fr)); gap:14px; }
  a.card { display:flex; gap:14px; background:#fff; padding:12px; border-radius:10px; text-decoration:none;
           color:#222; box-shadow:0 1px 4px rgba(0,0,0,.08); border:1px solid transparent; }
  a.card:hover { border-color:#93c5fd; box-shadow:0 3px 10px rgba(0,0,0,.12); }
  .thumb { flex:0 0 84px; width:84px; height:112px; border:1px solid #e5e7eb; border-radius:6px;
           overflow:hidden; background:#fafafa; display:flex; align-items:center; justify-content:center; }
  .thumb img { width:100%; height:100%; object-fit:contain; display:block; }
  .thumb .na { font-size:11px; color:#9ca3af; text-align:center; padding:6px; }
  .body { flex:1; min-width:0; display:flex; flex-direction:column; }
  .row1 { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
  .date { font-size:12px; color:#fff; background:#374151; border-radius:10px; padding:1px 8px; }
  .cnt { font-size:12px; color:#3730a3; background:#e0e7ff; border-radius:10px; padding:1px 8px; }
  .title { font-weight:600; font-size:15px; margin:7px 0 4px; line-height:1.4; }
  .dist { font-size:12px; color:#6b7280; line-height:1.6; }
  .file { font-size:11px; color:#b0b6bf; margin-top:auto; padding-top:6px;
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .none { color:#9ca3af; text-align:center; padding:40px; }
  header nav { margin-left:auto; }
  header nav a { color:#93c5fd; text-decoration:none; font-size:13px; margin-left:14px; }
  header nav a.on { color:#fff; font-weight:600; }
</style></head><body>
<header><h1>试卷识别结果</h1><span class="sub" id="hdr">共 __NDOC__ 份卷 · __NQ__ 题</span>
  <nav><a class="on" href="index.html">卷列表</a><a href="papers.html">已生成试卷</a></nav></header>
<div class="filters"><span class="flabel">按日期筛选</span>__CHIPS__</div>
<main>
  <div class="grid" id="grid">__CARDS__</div>
  <p class="none" id="empty" hidden>该日期下没有卷</p>
</main>
<script>
// 筛选是纯前端切显隐：卡片本来就全在 DOM 里，禁用 JS 也能看到全部卷
(function () {
  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  var cards = Array.prototype.slice.call(document.querySelectorAll("a.card"));
  var hdr = document.getElementById("hdr");
  var empty = document.getElementById("empty");
  var NDOC = __NDOC__, NQ = __NQ__;
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      chips.forEach(function (c) { c.classList.toggle("active", c === chip); });
      var d = chip.dataset.date || "";
      var docs = 0, qs = 0;
      cards.forEach(function (card) {
        var ok = !d || card.dataset.date === d;
        card.style.display = ok ? "" : "none";
        if (ok) { docs++; qs += Number(card.dataset.q || 0); }
      });
      hdr.textContent = d ? (d + "：共 " + docs + " 份卷 · " + qs + " 题")
                          : ("共 " + NDOC + " 份卷 · " + NQ + " 题");
      empty.hidden = docs !== 0;
    });
  });
})();
</script>
</body></html>
"""

DOC_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>__TITLE__ · 题目列表</title>
__KATEX__
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background:#f5f6f8; margin:0; color:#222; }
  header { background:#1f2937; color:#fff; padding:10px 20px; display:flex; gap:16px; align-items:center; }
  header a { color:#93c5fd; text-decoration:none; }
  header .crumb { color:#9ca3af; font-size:13px; }
  main { padding:16px 20px 40px; max-width:1000px; margin:0 auto; }
  .dochead { display:flex; gap:16px; background:#fff; padding:14px; border-radius:10px; align-items:flex-start;
             flex-wrap:wrap; box-shadow:0 1px 4px rgba(0,0,0,.08); margin-bottom:14px; }
  .dochead .orig { flex:0 0 auto; width:132px; border:1px solid #e5e7eb; border-radius:6px; background:#fafafa; }
  .dochead .opage { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:4px; }
  .dochead .origcap { font-size:11px; color:#9ca3af; max-width:150px; text-align:center;
                      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dochead img.orig { cursor:zoom-in; }
  .dochead img.orig.big { flex:1 1 100%; width:min(100%, 860px); cursor:zoom-out; }
  .dochead div.orig { height:176px; display:flex; align-items:center; justify-content:center;
                      color:#9ca3af; font-size:12px; text-align:center; padding:4px; }
  .dbody { flex:1; min-width:0; }
  .dtitle { font-size:18px; font-weight:600; margin:0 0 8px; }
  .dline { font-size:13px; color:#4b5563; line-height:1.9; }
  .date { font-size:12px; color:#fff; background:#374151; border-radius:10px; padding:1px 8px; margin-right:6px; }
  .dline .small { color:#9ca3af; font-size:12px; }
  .actions { margin-top:10px; }
  a.pbtn { display:inline-block; background:#1d4ed8; color:#fff; text-decoration:none; font-size:13px;
           padding:7px 14px; border-radius:6px; }
  a.pbtn:hover { background:#1e40af; }
  span.pbtn { display:inline-block; font-size:12px; color:#9ca3af; border:1px dashed #d1d5db;
              padding:6px 12px; border-radius:6px; }
  h2.listhead { font-size:14px; color:#6b7280; font-weight:600; margin:18px 0 8px; }
  a.q { display:flex; gap:14px; background:#fff; margin-bottom:10px; padding:12px; border-radius:10px;
        text-decoration:none; color:#222; box-shadow:0 1px 4px rgba(0,0,0,.08); border:1px solid transparent; }
  a.q:hover { border-color:#93c5fd; box-shadow:0 3px 10px rgba(0,0,0,.12); }
  .crop { flex:0 0 auto; max-width:200px; display:flex; align-items:center; }
  .crop img { max-width:200px; max-height:104px; display:block; border:1px solid #e5e7eb;
              border-radius:6px; background:#fafafa; }
  .crop .na { font-size:11px; color:#9ca3af; }
  .qbody { flex:1; min-width:0; display:flex; flex-direction:column; }
  .qhead { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .qno { font-weight:bold; font-size:15px; }
  .kind { padding:1px 8px; border-radius:10px; font-size:12px; background:#e0e7ff; color:#3730a3; }
  .sec { font-size:12px; color:#9ca3af; }
  .stem { color:#555; font-size:13px; line-height:1.65; margin-top:5px; display:-webkit-box;
          -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .qfoot { margin-top:auto; padding-top:6px; font-size:11px; color:#b0b6bf; }
  .warnmark { font-size:12px; color:#b91c1c; background:#fee2e2; border-radius:10px; padding:1px 8px; }
  .none { color:#9ca3af; text-align:center; padding:30px; }
__SYMBOL_CSS__
</style></head><body>
<header>
  <a href="index.html">&larr; 卷列表</a>
  <a href="papers.html">已生成试卷</a>
  <span class="crumb">__TITLE__ · 解析日期 __DATE__</span>
</header>
<main>
  <div class="dochead">
    __ORIG__
    <div class="dbody">
      <h1 class="dtitle">__TITLE__</h1>
      <div class="dline">
        <span class="date">__DATE__</span>解析日期 __DATE__ · 共 <b>__N__</b> 题<br>
        __DIST__
      </div>
      <div class="dline small">原图：__FILE__（点图片可放大）</div>
      <div class="actions">__PRINT__</div>
    </div>
  </div>
  <h2 class="listhead">解析出的题目（点任意一题看结构化详情）</h2>
  __CARDS__
</main>
<script>
// 原图点开放大 / 收起（一份卷可能有多张照片，每张都能单独放大）
(function () {
  document.querySelectorAll(".dochead img.orig").forEach(function (img) {
    img.addEventListener("click", function () { img.classList.toggle("big"); });
  });
})();
// 题干预览里的公式：与单题页同一套 KaTeX 行内分隔符
window.addEventListener("DOMContentLoaded", function () {
  if (window.renderMathInElement) {
    renderMathInElement(document.body, {
      delimiters: [{ left: "\\\\(", right: "\\\\)", display: false }],
      throwOnError: false,
    });
  }
});
</script>
</body></html>
"""


PAPERS_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>已生成的试卷</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background:#f5f6f8; margin:0; color:#222; }
  header { background:#1f2937; color:#fff; padding:14px 22px; display:flex; align-items:baseline; gap:14px; }
  header h1 { font-size:17px; margin:0; font-weight:600; }
  header .sub { color:#9ca3af; font-size:13px; }
  header nav { margin-left:auto; }
  header nav a { color:#93c5fd; text-decoration:none; font-size:13px; margin-left:14px; }
  header nav a.on { color:#fff; font-weight:600; }
  main { padding:16px 22px 40px; max-width:1100px; margin:0 auto; }
  .hint { font-size:12.5px; color:#6b7280; background:#fff; border:1px solid #e5e7eb;
          border-radius:8px; padding:10px 14px; line-height:1.8; margin:0 0 14px; }
  .hint code { background:#f3f4f6; padding:1px 6px; border-radius:4px; font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(430px, 1fr)); gap:14px; }
  .paper { display:flex; gap:14px; background:#fff; padding:12px; border-radius:10px;
           box-shadow:0 1px 4px rgba(0,0,0,.08); border:1px solid transparent; }
  .paper:hover { border-color:#93c5fd; box-shadow:0 3px 10px rgba(0,0,0,.12); }
  .pt { flex:0 0 92px; width:92px; height:130px; border:1px solid #e5e7eb; border-radius:6px;
        overflow:hidden; background:#fafafa; display:flex; align-items:center; justify-content:center; }
  .pt img { width:100%; height:100%; object-fit:contain; display:block; }
  .pt .na { font-size:11px; color:#9ca3af; text-align:center; padding:6px; }
  .pbody { flex:1; min-width:0; display:flex; flex-direction:column; }
  .prow { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
  .kind { font-size:12px; border-radius:10px; padding:1px 8px; background:#dbeafe; color:#1e40af; }
  .kind.all { background:#ede9fe; color:#5b21b6; }
  .pages { font-size:12px; border-radius:10px; padding:1px 8px; background:#dcfce7; color:#166534; }
  .date { font-size:12px; color:#fff; background:#374151; border-radius:10px; padding:1px 8px; }
  .ptitle { font-weight:600; font-size:15px; margin:7px 0 4px; line-height:1.4; }
  .pmeta { font-size:12px; color:#6b7280; line-height:1.7; }
  .acts { margin-top:auto; padding-top:9px; display:flex; flex-wrap:wrap; gap:8px; }
  a.btn { font-size:12.5px; padding:5px 12px; border-radius:6px; text-decoration:none;
          background:#1d4ed8; color:#fff; }
  a.btn:hover { background:#1e40af; }
  a.btn.ghost { background:#fff; color:#1d4ed8; border:1px solid #bfdbfe; }
  a.btn.ghost:hover { background:#eff6ff; }
  span.btn { font-size:12px; color:#9ca3af; border:1px dashed #d1d5db; padding:5px 11px; border-radius:6px; }
  .none { color:#9ca3af; text-align:center; padding:40px; }
</style></head><body>
<header>
  <h1>已生成的试卷</h1>
  <span class="sub">共 __NP__ 份 · __NPAGES__ 页</span>
  <nav><a href="index.html">卷列表（识别结果）</a><a class="on" href="papers.html">已生成试卷</a></nav>
</header>
<main>
  <p class="hint">
    这里是按题库排好的卷面，可直接打印给学生做（不含答案、不含学生笔迹）。<br>
    「按原卷版面」= 照某一份卷的原版面重新排一版干净的；「按题型重排」= 全库题目合并重排成的合卷。<br>
    重新生成：<code>python engine/paper.py --by-doc</code>（按卷）/ <code>python engine/paper.py</code>（合卷）
    → <code>python tools/export_paper_pdf.py --docs</code>（出 PDF、页数、缩略图）
    → <code>python engine/render.py data/questions</code>（刷新本页）。
  </p>
  <div class="grid">__CARDS__</div>
</main>
</body></html>
"""


def load_question(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("schema_version") != 2:
        raise ValueError(f"{path.name}: schema_version 必须为 2")
    for key in ("id", "stem"):
        if key not in data:
            raise ValueError(f"{path.name}: 缺少字段 {key}")
    return data


def stem_preview(data: dict, limit: int = 80, katex_on: bool = True) -> str:
    """卡片一行预览。LaTeX 片段与 text 里的运算符都用同一套 \\( ... \\) 分隔符，由 KaTeX 渲染。"""
    parts = []
    for seg in data.get("stem", []):
        t = seg.get("t")
        if t == "latex":
            v = f"\\({seg.get('v', '')}\\)" if katex_on else str(seg.get("v", ""))
        elif t == "figure":
            cap = str(seg.get("caption") or "").strip()
            v = f"［{cap}］" if cap else "［图］"
        else:
            v = mathify(str(seg.get("v", "")), katex_on)
        parts.append(str(v))
    text = " ".join(parts)
    return text[:limit] + ("…" if len(text) > limit else "")


# 占位/几何符号：字体自带的 □ ○ △ ☆ 字形偏小且大小不一（用户先后反馈过方框、三角形、
# 五角星），统一用内联 SVG 等宽绘制。viewBox 紧贴墨迹 —— 于是 .sym 的宽高即墨迹尺寸，
# 各形状共用同一个 vertical-align；描边放在 SVG 内，随字号缩放。
# 尺寸依据原卷实测（q-20261001-011：汉字墨迹高 22–23px 时，□ 17×19、△ 20×19、☆ 20×21）。
_SYM_DEFS = {
    #  字符: (class,   viewBox,        图形元素（%A% → 描边/填充属性）, 描边宽, 实心)
    "□": ("box",    "0 0 100 100", '<rect x="5.5" y="5.5" width="89" height="89" rx="9" %A%/>', 11, False),
    "■": ("box",    "0 0 100 100", '<rect x="0" y="0" width="100" height="100" rx="9" %A%/>', 0, True),
    "○": ("circle", "0 0 100 100", '<circle cx="50" cy="50" r="44.5" %A%/>', 11, False),
    "●": ("circle", "0 0 100 100", '<circle cx="50" cy="50" r="50" %A%/>', 0, True),
    "△": ("tri",    "0 0 100 95",  '<path d="M50 5.5 L94.5 89.5 H5.5 Z" %A%/>', 11, False),
    "▲": ("tri",    "0 0 100 95",  '<path d="M50 0 L100 95 H0 Z" %A%/>', 0, True),
    "☆": ("star",   "0 0 94.6 90.4",
           '<path d="M47.3 4.5 L57.4 35.6 L90.1 35.6 L63.7 54.8 L73.8 85.9 L47.3 66.7 '
           'L20.9 85.9 L31 54.8 L4.5 35.6 L37.2 35.6 Z" %A%/>', 9, False),
    "★": ("star",   "0 0 95.1 90.4",
           '<path d="M47.6 0 L58.8 34.6 L95.1 34.6 L65.7 55.9 L76.9 90.4 L47.6 69.1 '
           'L18.2 90.4 L29.4 55.9 L0 34.6 L36.3 34.6 Z" %A%/>', 0, True),
}


def _sym_svg(viewbox: str, shape: str, stroke: int, solid: bool) -> str:
    paint = ('fill="currentColor"' if solid else
             f'fill="none" stroke="currentColor" stroke-width="{stroke}" stroke-linejoin="round"')
    return f'<svg viewBox="{viewbox}" aria-hidden="true">{shape.replace("%A%", paint)}</svg>'


SYMBOL_TABLE = {ch: (cls, _sym_svg(vb, shape, sw, solid))
                for ch, (cls, vb, shape, sw, solid) in _SYM_DEFS.items()}

# 符号的 CSS 单独成一份常量：校对页（单题/列表）与试卷页（paper.py）都嵌它。
# ⚠️ 踩过的坑：漏嵌这份 CSS，`<svg>` 就没有尺寸约束、按默认 300×150px 撑开 —— 试卷里
#    每道含 □ △ ☆ 的题都会占满一整页。新增任何输出链路都要记得带上它。
SYMBOL_CSS = """/* 占位/几何符号（□ ○ △ ☆ 及实心变体）：字体自带字形偏小且大小不一，统一用内联 SVG
   等宽绘制。viewBox 紧贴墨迹，所以 .sym 的宽高就是墨迹尺寸，各形状垂直对齐一致；
   描边写在 SVG 里因而随字号缩放。
   ⚠️ 尺寸最初按原卷墨迹实测（□ 高 ≈ 汉字 0.84em），但网页字号比原卷小一档，
   实测观感偏矮（用户反馈「□ 太小」）→ 统一上调到接近 1em，方框基本与汉字同高。 */
.sym { display: inline-block; vertical-align: -.11em; margin: 0 .06em; line-height: 0; }
.sym > svg { display: block; width: 100%; height: 100%; }
.sym.box, .sym.circle { width: .98em; height: .98em; }
.sym.tri  { width: .98em; height: .94em; }
.sym.star { width: 1em; height: .96em; }"""


def sym_html(escaped: str) -> str:
    """把占位/几何符号换成内联 SVG 等宽绘制（在已 HTML 转义的文本上调用）。"""
    if not any(ch in escaped for ch in SYMBOL_TABLE):
        return escaped
    for ch, (cls, svg) in SYMBOL_TABLE.items():
        escaped = escaped.replace(ch, f'<span class="sym {cls}" title="{ch}">{svg}</span>')
    return escaped


def overall_conf(data: dict) -> str:
    confs = [v for v in (data.get("confidence") or {}).values() if isinstance(v, (int, float))]
    if not confs:
        return "-"
    return f"{sum(confs) / len(confs):.2f}"


def type_text(data: dict) -> str:
    t = str(data.get("type", "other"))
    return TYPE_TEXT.get(t, t)


def figure_names(data: dict) -> list[str]:
    """题目里所有题内插图文件名（只取 basename）。"""
    names = []
    for seg in data.get("stem") or []:
        if isinstance(seg, dict) and seg.get("t") == "figure" and seg.get("src"):
            names.append(Path(str(seg["src"])).name)
    return names


def crop_img(name: str, alt: str) -> str:
    """裁剪图 -> 内联 data: URI 的 <img>；文件缺失时页面直接说清楚缺哪个。"""
    path = CROPS_DIR / name
    if not path.is_file():
        return f'<p class="empty">裁剪图缺失：data/crops/{html.escape(name)}</p>'
    return f'<img src="{_data_uri(path)}" alt="{html.escape(alt)}">'


def type_dist(items: list[dict]) -> str:
    """题型分布摘要，如「计算题 9 · 解答题 13」（多的排前面）。"""
    c: dict[str, int] = {}
    for q in items:
        t = type_text(q)
        c[t] = c.get(t, 0) + 1
    return " · ".join(f"{k} {v}" for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0])))


def has_doubt(data: dict) -> str:
    """疑点摘要（空串 = 无）。低置信度 / 题干含 [?] 都要在列表上一眼看见。"""
    low = [k for k, v in (data.get("confidence") or {}).items()
           if isinstance(v, (int, float)) and v < 0.7]
    unk = any("[?]" in str(s.get("v", "")) for s in data.get("stem") or [] if isinstance(s, dict))
    what = []
    if unk:
        what.append("题干含 [?]")
    if low:
        what.append("低置信度：" + "、".join(low))
    return "；".join(what)


def q_card(data: dict, katex_on: bool = True) -> str:
    """卷详情页里的一行题目卡片：裁剪缩略图 + 题号 / 题型 / 板块 / 题干预览 / 疑点。"""
    src = data.get("source") or {}
    name = src.get("crop")
    crop_path = CROPS_DIR / name if name else None
    if crop_path is not None and crop_path.is_file():
        inner = f'<img src="{_data_uri(crop_path)}" alt="第 {html.escape(str(data.get("no", "-")))} 题裁剪图">'
    else:
        inner = '<span class="na">无裁剪图</span>'
    doubt = has_doubt(data)
    warn = f'<span class="warnmark">{html.escape(doubt)}</span>' if doubt else ""
    section = sym_html(html.escape(str(data.get("section") or "未分板块")))
    return (
        f'<a class="q" href="{html.escape(data["id"])}.html">'
        f'<div class="crop">{inner}</div>'
        f'<div class="qbody">'
        f'<div class="qhead"><span class="qno">第 {html.escape(str(data.get("no", "-")))} 题</span>'
        f'<span class="kind">{html.escape(type_text(data))}</span>'
        f'<span class="sec">{section}</span>{warn}</div>'
        f'<div class="stem">{sym_html(html.escape(stem_preview(data, 120, katex_on)))}</div>'
        f'<div class="qfoot">{html.escape(data["id"])} · 整体置信度 {html.escape(overall_conf(data))}</div>'
        f'</div></a>'
    )


def doc_card(doc: dict) -> str:
    """卷列表页的一张卡片：原图 + 解析出的题目数 + 解析日期（`data-*` 供前端筛选）。"""
    uri, is_thumb = original_uri(doc["file"])
    if uri:
        inner = f'<img src="{uri}" alt="{html.escape(doc["title"])} 原图">'
    else:
        inner = '<span class="na">原图缺失</span>'
    tip = "" if is_thumb or not uri else "（未缩略，点开较慢）"
    files = doc.get("files") or [doc["file"]]
    src_line = html.escape(files[0]) + html.escape(tip)
    if len(files) > 1:
        src_line += f'（本卷共 {len(files)} 张照片：{html.escape("、".join(files))}）'
    return (
        f'<a class="card" href="{doc["slug"]}.html"'
        f' data-date="{html.escape(doc["date"])}" data-q="{len(doc["items"])}">'
        f'<div class="thumb">{inner}</div>'
        f'<div class="body">'
        f'<div class="row1"><span class="date">{html.escape(doc["date"])}</span>'
        f'<span class="cnt">{len(doc["items"])} 题</span></div>'
        f'<div class="title">{html.escape(doc["title"])}</div>'
        f'<div class="dist">{html.escape(type_dist(doc["items"]))}</div>'
        f'<div class="file">{src_line}</div>'
        f'</div></a>'
    )


# ---------------------------------------------------------------- 试卷列表
# 数据来源有两处，**都不是手工维护的清单**：
#   1. 卷面页面自己 <head> 里的 x-paper 元信息（kind/slug/title/题数/日期）——由 paper.paper_meta 写；
#      所以「扫 data/render/paper-*.html 就能列出全部已生成试卷」，不会出现清单与文件不同步。
#   2. data/paper/manifest.json（页数 / PDF / 缩略图）——页数只有打印成 PDF 才知道，
#      由 tools/export_paper_pdf.py 写。清单缺失时这几项显示成「—」，不影响打开卷面。
_PAPER_META = re.compile(r'<meta name="x-paper" content="([^"]*)"')
_PAPER_HEAD_BYTES = 8192   # 只读文件头（卷面页正文很大，全读没必要）
PAPER_MANIFEST = PROJECT_ROOT / "data" / "paper" / "manifest.json"


def paper_manifest() -> dict:
    if not PAPER_MANIFEST.is_file():
        return {}
    try:
        return (json.loads(PAPER_MANIFEST.read_text(encoding="utf-8"))
                .get("papers") or {})
    except Exception:  # noqa: BLE001
        return {}


def collect_papers(out_dir: Path) -> list[dict]:
    """扫描 data/render/paper-*.html，拼出「已生成试卷」列表（按生成时间倒序）。"""
    man = paper_manifest()
    papers = []
    for html_path in sorted(out_dir.glob("paper-*.html")):
        head = html_path.read_bytes()[:_PAPER_HEAD_BYTES].decode("utf-8", "ignore")
        m = _PAPER_META.search(head)
        meta = {}
        if m:
            try:
                meta = json.loads(html.unescape(m.group(1)))
            except Exception:  # noqa: BLE001
                meta = {}
        stem = html_path.stem
        extra = man.get(stem, {})
        pdf = out_dir / extra.get("pdf", f"{stem}.pdf")
        thumb = out_dir / extra.get("thumb", f"thumb-{stem}.png")
        papers.append({
            "stem": stem,
            "html": html_path.name,
            "pdf": pdf.name if pdf.is_file() else "",
            "thumb": thumb.name if thumb.is_file() else "",
            "kind": meta.get("kind") or "doc",
            "slug": meta.get("slug") or "",
            "title": meta.get("title") or stem,
            "questions": meta.get("questions") or 0,
            "date": meta.get("date") or "",
            "note": meta.get("note") or "",
            "scores": bool(meta.get("scores")),
            "pages": int(extra.get("pages") or 0),
            "kb": int(extra.get("kb") or 0),
            "mtime": html_path.stat().st_mtime,
        })
    papers.sort(key=lambda p: p["mtime"], reverse=True)
    return papers


def paper_card(p: dict) -> str:
    """一张试卷卡片：首页缩略图 + 类型/页数/日期 + 题数 · 体积 · 生成时间 + 三个入口。"""
    if p["thumb"]:
        thumb = f'<img src="{html.escape(p["thumb"])}" alt="卷面首页缩略图">'
    else:
        thumb = '<span class="na">未出 PDF<br>（跑 export_paper_pdf.py）</span>'
    kind_cls = "kind all" if p["kind"] == "all" else "kind"
    kind_txt = "按题型重排" if p["kind"] == "all" else "按原卷版面"
    badges = [f'<span class="{kind_cls}">{kind_txt}</span>']
    if p["date"]:
        badges.append(f'<span class="date">{html.escape(p["date"])}</span>')
    badges.append(f'<span class="pages">共 {p["pages"]} 页</span>' if p["pages"]
                  else '<span class="pages" style="background:#f3f4f6;color:#9ca3af">页数待导 PDF</span>')

    bits = [f'{p["questions"]} 题' if p["questions"] else "题数未知"]
    if p["kb"]:
        bits.append(f'PDF {p["kb"]} KB')
    bits.append("生成于 " + time.strftime("%m-%d %H:%M", time.localtime(p["mtime"])))
    if p["scores"]:
        bits.append("标了分值（估计口径）")

    acts = [f'<a class="btn" href="{html.escape(p["html"])}">打开卷面</a>']
    acts.append(f'<a class="btn ghost" href="{html.escape(p["pdf"])}" target="_blank">PDF</a>'
                if p["pdf"] else '<span class="btn">PDF 未生成</span>')
    # 合卷（kind=all）没有「本卷解析」——它是全库重排的，不对应某一份卷
    if p["kind"] == "doc" and p["slug"]:
        acts.append(f'<a class="btn ghost" href="{html.escape(p["slug"])}.html">本卷解析</a>')
    return (
        f'<div class="paper">'
        f'<div class="pt">{thumb}</div>'
        f'<div class="pbody">'
        f'<div class="prow">{"".join(badges)}</div>'
        f'<div class="ptitle">{html.escape(p["title"])}</div>'
        f'<div class="pmeta">{" · ".join(bits)}</div>'
        f'<div class="acts">{"".join(acts)}</div>'
        f'</div></div>'
    )


def render_papers(out_dir: Path) -> tuple[Path, int, int]:
    """第 4 层页面：已生成的试卷列表（扫 data/render/paper-*.html，无需手工维护清单）。"""
    papers = collect_papers(out_dir)
    cards = "\n".join(paper_card(p) for p in papers)
    if not papers:
        cards = ('<p class="none">还没有生成过卷面。<br>'
                 '先生成：python engine/paper.py --by-doc（按原卷版面）或 '
                 'python engine/paper.py（合卷）。</p>')
    page = (PAPERS_TEMPLATE
            .replace("__CARDS__", cards)
            .replace("__NP__", str(len(papers)))
            .replace("__NPAGES__", str(sum(p["pages"] for p in papers) or "—")))
    out = out_dir / "papers.html"
    out.write_text(page, encoding="utf-8")
    return out, len(papers), sum(p["pages"] for p in papers)


def render_doc(doc: dict, out_dir: Path, katex_on: bool) -> Path:
    """卷详情页：原图（可点开放大）+ 该卷解析出的题目列表 + 「打印本卷」入口。

    一份卷可能由多张照片组成（`source.paper` 相同）——这里把每张照片都列出来，
    多张时标上「第 N 页 / 共 M 张」。
    """
    files = doc.get("files") or [doc["file"]]
    parts = []
    for i, name in enumerate(files, 1):
        uri, _ = original_uri(name)
        cap = (f'<div class="origcap">第 {i} / {len(files)} 页 · '
               f'{html.escape(name)}</div>') if len(files) > 1 else ""
        if uri:
            body = (f'<img class="orig" src="{uri}" '
                    f'alt="{html.escape(doc["title"])} 原图 {i}">')
        else:
            body = ('<div class="orig"><span>原图缺失<br>'
                    + html.escape(name) + "</span></div>")
        parts.append(f'<div class="opage">{cap}{body}</div>')
    orig = "\n".join(parts)
    # 可打印卷面（按原卷版面还原）由 `python engine/paper.py --by-doc` 生成，
    # 与卷详情页**同目录**，所以这里是同级相对链接（跨目录的 ../ 在预览面板下会 404）。
    paper_name = f"paper-{doc['slug']}.html"
    if (out_dir / paper_name).is_file():
        printhtml = f'<a class="pbtn" href="{paper_name}">打印本卷（按原卷版面 · 重新打印给学生做）</a>'
    else:
        printhtml = ('<span class="pbtn">打印卷面未生成：跑 '
                     'python engine/paper.py --by-doc</span>')
    use_katex = katex_on and any(needs_katex(q) for q in doc["items"])
    cards = "\n".join(q_card(q, use_katex) for q in doc["items"])
    page = (
        DOC_TEMPLATE
        .replace("__KATEX__", build_katex_bundle() if use_katex else "")
        .replace("__SYMBOL_CSS__", SYMBOL_CSS)
        .replace("__TITLE__", html.escape(doc["title"]))
        .replace("__DATE__", html.escape(doc["date"]))
        .replace("__N__", str(len(doc["items"])))
        .replace("__DIST__", html.escape(type_dist(doc["items"])))
        .replace("__FILE__", html.escape("、".join(files)))
        .replace("__ORIG__", orig)
        .replace("__PRINT__", printhtml)
        .replace("__CARDS__", cards or '<p class="none">本卷没有题目</p>')
    )
    out = out_dir / f"{doc['slug']}.html"
    out.write_text(page, encoding="utf-8")
    return out


def render_one(data: dict, out_dir: Path, katex_on: bool = True,
               doc_href: str = "index.html", doc_title: str = "") -> Path:
    qid = data["id"]
    src = data.get("source") or {}
    crop_name = src.get("crop")
    crop_html = crop_img(crop_name, "原图裁剪") if crop_name else '<p class="empty">无裁剪图</p>'

    # 题内插图：文件名 -> data: URI，供前端 frag() 查表
    assets, missing = {}, []
    for name in figure_names(data):
        path = CROPS_DIR / name
        if path.is_file():
            assets[name] = _data_uri(path)
        else:
            missing.append(name)

    low = [k for k, v in (data.get("confidence") or {}).items()
           if isinstance(v, (int, float)) and v < 0.7]
    use_katex = katex_on and needs_katex(data)

    page = (
        PAGE_TEMPLATE
        .replace("__KATEX__", build_katex_bundle() if use_katex else "")
        .replace("__SYMBOL_CSS__", SYMBOL_CSS)
        .replace("__ID__", html.escape(qid))
        .replace("__NO__", html.escape(str(data.get("no", "-"))))
        .replace("__TYPE__", html.escape(type_text(data)))
        .replace("__SECTION__", sym_html(html.escape(str(data.get("section") or "未分板块"))))
        .replace("__DOC_HREF__", html.escape(doc_href))
        .replace("__DOC_TITLE__", html.escape(doc_title or "本卷"))
        .replace("__OVERALL__", "low" if low else "ok")
        .replace("__CONF__", overall_conf(data))
        .replace("__CROP__", crop_html)
        .replace("__ASSETS__", json.dumps(assets, ensure_ascii=False).replace("</", "<\\/"))
        .replace("__SYMBOL_SVG__", json.dumps(
            {ch: [cls, svg] for ch, (cls, svg) in SYMBOL_TABLE.items()},
            ensure_ascii=False).replace("</", "<\\/"))
        .replace("__KATEX_ON__", "true" if use_katex else "false")
        .replace("__OP_MAP__", json.dumps(OP_LATEX, ensure_ascii=False))
        .replace("__OP_CLASS__", json.dumps(OP_CLASS, ensure_ascii=False))
        .replace("__DATA__", json.dumps(data, ensure_ascii=False, default=str).replace("</", "<\\/"))
    )
    out = out_dir / f"{qid}.html"
    out.write_text(page, encoding="utf-8")
    if missing:
        print(f"[警告] {qid}: 缺少题内插图 {', '.join(missing)}", file=sys.stderr)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="题目识别校对页渲染器（单文件自包含）")
    parser.add_argument("input", help="单个题目 JSON 或包含题目 JSON 的目录")
    parser.add_argument("-o", "--out", default=str(DEFAULT_OUT), help="输出目录")
    parser.add_argument("--no-katex", action="store_true",
                        help="不内联 KaTeX（页面更小，公式按 LaTeX 原文显示）")
    args = parser.parse_args()

    in_path = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    katex_on = not args.no_katex

    if in_path.is_dir():
        files = sorted(in_path.glob("*.json"))
    elif in_path.is_file():
        files = [in_path]
    else:
        print(f"输入不存在: {in_path}", file=sys.stderr)
        return 1
    if not files:
        print("没有可渲染的 JSON 文件", file=sys.stderr)
        return 1

    cards, count, errors = [], 0, 0
    for f in files:
        try:
            data = load_question(f)
        except Exception as exc:  # noqa: BLE001
            print(f"[跳过] {f.name}: {exc}", file=sys.stderr)
            errors += 1
            continue
        cards.append(data)
        count += 1

    # 按「卷」分组 —— 分组键 = source.paper or source.file。
    # 一份卷拍成多张照片时，这些题都标了同一个 source.paper，就合成**一份卷**
    # （多张原图列在同一个卷详情页里）；没标 paper 的卷仍旧按单张照片分组。
    groups: dict[str, list[dict]] = {}
    for data in cards:
        groups.setdefault(paper_key(data.get("source") or {}), []).append(data)

    docs = []
    for key, items in groups.items():
        files = paper_files(items)
        idx = {fn: i for i, fn in enumerate(files)}
        items.sort(key=lambda q: (
            idx.get(str((q.get("source") or {}).get("file") or ""), 999),
            q.get("no") if isinstance(q.get("no"), int) else 9999, q["id"]))
        src0 = items[0].get("source") or {}
        docs.append({
            "key": key,
            "file": files[0] if files else key,
            "files": files or [key],
            "slug": doc_slug(key),
            "date": doc_date(key),
            "title": str(src0.get("paper_title") or doc_title(key)),
            "items": items,
            "stamp": max((str(q.get("created_at") or "") for q in items), default=""),
        })
    # 倒序：日期新的在前；同一天按入库时间、再按文件名
    docs.sort(key=lambda d: (d["date"] if d["date"] != "未知" else "", d["stamp"], d["file"]),
              reverse=True)

    # 第 3 层：单题详情页（与本改造前一致，只是顶部返回链到本卷列表）
    for doc in docs:
        for q in doc["items"]:
            render_one(q, out_dir, katex_on=katex_on,
                       doc_href=f'{doc["slug"]}.html', doc_title=doc["title"])

    # 第 2 层：卷详情页 = 该卷解析出的题目列表
    for doc in docs:
        render_doc(doc, out_dir, katex_on)

    # 第 1 层：卷卡片页（日期筛选 + 原图 / 题目数 / 解析日期，倒序）
    by_date: dict[str, list[dict]] = {}
    for doc in docs:
        by_date.setdefault(doc["date"], []).append(doc)
    chips = [f'<button class="chip active" data-date="">全部<span class="n">{count} 题</span></button>']
    for date in sorted(by_date, key=lambda d: (d != "未知", d), reverse=True):
        ds = by_date[date]
        nq = sum(len(d["items"]) for d in ds)
        chips.append(f'<button class="chip" data-date="{html.escape(date)}">{html.escape(date)}'
                     f'<span class="n">{len(ds)} 份 · {nq} 题</span></button>')

    (out_dir / "index.html").write_text(
        INDEX_TEMPLATE
        .replace("__CHIPS__", "".join(chips))
        .replace("__CARDS__", "\n".join(doc_card(d) for d in docs))
        .replace("__NDOC__", str(len(docs)))
        .replace("__NQ__", str(count)),
        encoding="utf-8",
    )
    # 第 4 层：已生成的试卷列表（扫 paper-*.html，页数等来自 data/paper/manifest.json）
    papers_path, npapers, npages = render_papers(out_dir)
    print(f"完成：{len(docs)} 份卷 / {count} 题 -> {out_dir / 'index.html'}"
          f"（卷详情页 {len(docs)} 个，跳过 {errors} 个无效文件）")
    print(f"已生成试卷 {npapers} 份 / {npages} 页 -> {papers_path}")

    missing_print = [d["slug"] for d in docs
                     if not (out_dir / f"paper-{d['slug']}.html").is_file()]
    if missing_print:
        print(f"[提示] {len(missing_print)} 份卷还没有「按原卷版面」的可打印卷面，"
              f"卷详情页里会显示灰字提示。生成命令：python engine/paper.py --by-doc",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
