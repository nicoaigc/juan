# -*- coding: utf-8 -*-
"""组卷渲染器：题库 JSON -> A4 试卷 HTML（可直接打印 / 导出 PDF）。

在识别校对页（render.py）之外的第二条输出链路：校对页是「一题一页、左右对照」给人核对用的，
本文件是「按题型重排、A4 分页」给学生做的正式卷子。

设计要点（都可调，参数集中在下面的 PAPER / SECTIONS）：
  * 题目**按版面需求分组**，不照搬原卷板块：口算分列（3–4 列，不宜更多）、竖式要留竖式空间
    （3 列固定高）、应用题要留答题区。同一类题可能来自不同来源卷，组卷时合并重排。
  * **计算类大题不标小题号**（`numbered=False`）：算式本身就是题目的标识，加「(1)(2)」反而挤。
  * **题图位置随题型变**（见 `item_html`）：应用题在题干**下方右侧**（右对齐，别居中——居中会把
    书写区顶下去）、带图选择题贴在**选项右侧**（选项排两列）、其余（填空）独占一行居中。
  * **「写出综合算式」按原件版式还原成 2 行 2 列**（`style="eq"` + `cols=2`，见 `item_html`）：
    每格是「(n) + 已知算式」+ 下方**一条答题横线**。题库里四条算式是**四道题**——不要合并成
    一题（合并=版式信息丢失，卷面上就没有答题空间了，用户反馈过）。
  * 分值自动汇总，总分写进副标题，不手写以免改题后对不上。给分有**三种口径**（见 `item_score`）：
    口算/竖式/选择这类按**每题固定分**（`per`）；填空题按**每空固定分**（`per_blank`）——
    填空卷面上是一题几个空、一个空多少分，按题给分会算错（用户口径：「一个空多少分，不是一题几分」）；
    应用题逐题给分（`scores`）。空数从题干里数（`blanks_of`）。
  * 与 render.py 共用一套资源处理：KaTeX 内联（零外部请求）、图片转 data: URI、
    占位符号 □ ○ △ ☆ 用内联 SVG（见 render.SYMBOL_TABLE）——**不要另起一套**。
  * **有 [?] 的题自动剔除**（识别没看清，正式卷面不能带问号占位），并打印警告。
  * 排版用 CSS 流式 + `break-inside: avoid`：屏幕上是一张 210mm 宽的纸（近似预览），
    打印时交回 @page 控制边距。真实分页要用 Chrome 打印成 PDF 才知道（见 README「导出 PDF」）。

用法:
    python paper.py                  # 按题型重排成一份合卷 -> data/render/paper-all.html
    python paper.py --by-doc         # 按原卷版面逐卷还原 -> data/render/paper-<卷slug>.html
生成（两种模式都写进 data/render/，与校对页同目录，UI 里的「试卷列表」页才点得通）:
    data/render/paper-all.html           按题型重排的合卷
    data/render/paper-<卷slug>.html      按原卷版面还原的可打印卷面
"""
import argparse
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render import (  # noqa: E402  与校对页共用，勿重复实现
    PROJECT_ROOT, SYMBOL_CSS, _data_uri, build_katex_bundle, doc_date, doc_slug, doc_title,
    load_question, mathify, sym_html,
)

# 输出目录：**统一写进 data/render/**（网页根目录），两种模式都一样。
# 理由：打印页要被 UI 里的「已生成试卷」列表点开、要在卷详情页里 `<a href="paper-x.html">`，
# 这些都必须是**同级相对链接**——预览面板把页面挂在 /static-html/ 下，跨目录的 ../ 会 404
# （见 README「单文件自包含」）。版面体检产物（每页 PNG / manifest.json）另放 data/paper/。
DEFAULT_OUT = PROJECT_ROOT / "data" / "render"
CROPS_DIR = PROJECT_ROOT / "data" / "crops"
# 「按题型重排」那份合卷的文件名（其余「按卷还原」的是 paper-<卷slug>.html）
ALL_SLUG = "all"

# ---------------------------------------------------------------- 卷面配置
PAPER = {
    "title": "多位数乘一位数 · 单元练习",
    "time": "60 分钟",
    "info": ["班级", "姓名", "学号", "得分"],
    "foot": "请仔细检查一遍，再做下一题。",
    # 版面：正文 12pt（小四），小学卷不适合更小；行距与题距留足手写空间
    "font_size": "12pt",
    "line_height": "1.7",
    # ---- 排版松紧（「四面 A4」的旋钮就在这几项 + SECTIONS 的 box_h / row_gap）----
    "gap_row": "8mm",            # 网格题（口算/竖式/递等式/比较）的行距；可被 SECTIONS.row_gap 覆盖
    "gap_col": "4mm",            # 网格题的列距
    "line_gap": "5mm",           # 整行题（填空/选择）的题距
    "sec_margin": "6mm 0 2mm",   # 大题标题上下边距
    "guide_lines": True,         # 书写区画浅虚线（便于预览版面；打印要干净就改 False）
}

# 「合卷收紧档」：**只作用于按题型重排的合卷**（paper-all），按卷还原的卷面（paper-<卷slug>）不受影响。
# 为什么需要它：合并全库重排（94 题 / 满分 130）后，上面那套给 70 题调的松紧度排成 5 页 ——
# 只差最后一道应用题溢出到第 5 页，那一页几乎全空。收紧一档正好压回四面。
# 字号仍是 12pt（小学卷不缩字号），省出来的都是「行距 / 题距 / 大题标题边距」。
# 为什么不直接改上面的 PAPER：按卷还原那一链要贴原卷版面，而且收紧后各卷末页空白反而更多
# （b354 第 4 页留白 176mm → 263mm）。两条链的诉求不同，用 overlay 分开。
TIGHT = {
    "line_height": "1.6",
    "gap_row": "6mm",
    "line_gap": "3.5mm",
    "sec_margin": "4mm 0 1.5mm",
}

# 「按卷还原 · 紧凑档」：**只给指定的卷**用（见 COMPACT_DOCS），不要默认套。
# 为什么需要：有的卷题目总量刚好溢出一页，末页只放一道题、其余全空（实测素养卷
# 合并三张照片后末页留白 218mm）。把行距/题距/书写区各收一点点，正好压掉那一页。
# 为什么不默认给所有「按卷还原」的卷开：那一链要贴原卷版面，整体收紧后**别的卷末页
# 空白反而更多**（b354 第 4 页留白 176mm → 263mm），所以按卷单独点名。
COMPACT = {
    "line_height": "1.55",
    "gap_row": "5mm",
    "line_gap": "3mm",
    "sec_margin": "3.5mm 0 1mm",
}
# 用紧凑档的卷（写分组键的 slug —— 就是 data/render/paper-<slug>.html 里那串）。
# 改题库后要重新量页数（tools/export_paper_pdf.py --docs 看每页留白），多退少补。
COMPACT_DOCS: set[str] = {
    # 第一二单元素养卷：三张照片合并（38 题，去重后 36 题）后排 4 页，第 4 页只有最后一道
    # 应用题、留白 218mm —— 收紧一档正好压成 3 页（见 .workbuddy/memory/2026-10-05.md）。
    "doc-20261001-e433",
}

# 大题顺序 = 试卷顺序。per=每题分值；scores=逐题分值（两者取其一）
# numbered=False → 小题不标 (1)(2)；row_gap 覆盖 PAPER.gap_row；fig_opts_cols → 带图选择题的选项列数
SECTIONS = [
    dict(no="一", title="直接写出得数", cols=4, inline=True, style="oral", numbered=False,
         row_gap="3.5mm", pick=("一、算一算", "1. 直接写出得数"), per=1),
    dict(no="二", title="用竖式计算", cols=3, style="calc", numbered=False, box_h="28mm", row_gap="3mm",
         pick=("二、用竖式计算", "2. 用竖式计算"), per=2),
    dict(no="三", title="递等式计算", cols=3, style="calc", numbered=False, box_h="22mm",
         pick=("三、递等式计算", "3. 计算"), per=2),
    # 「写出综合算式」：原件是 2 行 2 列、每格下方一条答题横线 → cols=2 + style="eq"
    dict(no="四", title="写出综合算式", cols=2, style="eq", row_gap="4mm", box_h="11mm",
         pick=("4. 写出综合算式",), per=2),
    # 比较题也是计算类：算式本身就是标识，不标 (1)(2)(3)（与口算/竖式/递等式一致）
    dict(no="五", title="在○里填上“>”“<”或“=”", cols=3, inline=True, style="cmp", numbered=False,
         pick=("4. 在○里填入“>”“<”或“=”",), per=1),
    # 填空按**每空**给分（原卷口径），空数由 blanks_of() 从题干里数
    dict(no="六", title="填空", cols=1, style="line", per_blank=1,
         pick=("5. 填空", "第二部分 概念 · 2、填空题")),
    dict(no="七", title="选择（把正确答案的序号填在括号里）", cols=1, style="choice",
         fig_opts_cols=2,
         pick=("6. 选择", "第二部分 概念 · 1、选择题"), per=1),
    dict(no="八", title="应用题", cols=1, style="app", box_h="30mm",
         pick=("7. 应用题",), scores=[5, 6]),
]

# 不是题目的板块（识别时照实收了，组卷时不要）
SKIP_SECTIONS = ("卷面草稿",)

CN_NUM = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七",
          8: "八", 9: "九", 10: "十", 11: "十一", 12: "十二"}

# 题目里的「空」：全角/半角括号里全空白，或 ≥2 个连续下划线（见 blanks_of 的说明）
BLANK_RE = re.compile(r"[（(][\u3000\s\xa0]*[）)]|_{2,}")

# 题干里的换行：卷面上**同一小题的第二行**（如「写出综合算式」(1) 的两条算式）在识别结果里
# 用换行表示，渲染时换成 <br>。用 chr(10) 而不是字面转义，免得层层转义写错。
NEWLINE = chr(10)


# ---------------------------------------------------------------- 片段渲染
# 卷面上半角标点要不要规范化。识别结果是照原卷抄的（原卷本来就半角全角混着），
# **不改 JSON**，只在打印层统一；想看原文用校对页（render.py 不做这个转换）。
PUNCT_FIX = True

_CJK = r"\u4e00-\u9fff\u3000-\u303f"          # 汉字 + 中文标点
_CN = {",": "，", ";": "；", "?": "？", "!": "！"}


def fix_punct(v: str) -> str:
    """打印层的标点规范化：只在「中文旁边」动手，算式里的 `.` `,` 一律不碰。

    * 中文后的 `, ; ? !` → 全角（`6，结果`）；
    * 中文前的 `, ; ? !` → 全角（`79×6,第一个` → `79×6，第一个`）；
    * 中文后的 `.` → `。`（`A. 42`、`3.5` 不受影响，前面不是汉字）；
    * 留空括号统一成 `（　　）`（原来混着 `(　　)` / `（  ）` 两种写法）。
    """
    if not PUNCT_FIX:
        return v
    v = re.sub(r"(?<=[%s])[,;?!]" % _CJK, lambda m: _CN[m.group()], v)
    v = re.sub(r"[,;?!](?=[%s])" % _CJK, lambda m: _CN[m.group()], v)
    v = re.sub(r"(?<=[%s])\." % _CJK, "。", v)
    v = re.sub(r"[(][\u3000\s\xa0]*[)]|（[\u3000\s\xa0]*）", "（　　）", v)
    return v


def fig_view(seg: dict) -> tuple[str, str]:
    """题内插图的**显示外观**（与网页端 app/js/render.js 的 figView 同一口径，别各写一套）。

    dw   = 显示大小，30~100 的百分数（100 或不给 = 容器给的默认满宽）
    pos  = 显式位置 'l' / 'c' / 'r'（不给 = 按题型的默认落位：应用题靠右、带图选择题贴选项右侧）
    wrap = 文字环绕（浮起来，题干文字绕到另一侧；只有左右位置成立）

    返回 (类名, 内联 style 属性串)。大小交给 css 按图的最大宽高去乘（--fdw）。
    """
    try:                       # 与网页端 Math.round(Number(x) || 0) 同口径：认不得就当没设
        dw = int(float(seg.get("dw") or 0))
    except (TypeError, ValueError):
        dw = 0
    sty = f' style="--fdw:{dw}"' if 30 <= dw < 100 else ""
    p, wrap = str(seg.get("pos") or ""), bool(seg.get("wrap"))
    cls = ""
    if p in ("l", "c", "r"):
        cls = f" fw-{p}" if (wrap and p != "c") else f" fp-{p}"
    return cls, sty


def seg_html(seg: dict) -> str:
    """单个片段 -> HTML。字典键与 schema v2 一致，与校对页保持同一套规则。"""
    t = seg.get("t")
    if t == "latex":
        # 交浏览器端 KaTeX auto-render（与校对页同一套 \( \) 分隔符）
        return "\\(" + str(seg.get("v", "")) + "\\)"
    if t == "figure":
        cap = str(seg.get("caption") or "").strip()
        cap_html = f'<span class="figcap">{html.escape(cap)}</span>' if cap else ""
        name = Path(str(seg.get("src") or "")).name
        path = CROPS_DIR / name
        cls, sty = fig_view(seg)
        if name and path.is_file():
            return (f'<span class="figbox{cls}"{sty}><img class="fig" src="{_data_uri(path)}" '
                    f'alt="{html.escape(cap or "题图")}"></span>{cap_html}')
        return f'<span class="fig-miss">［图］</span>{cap_html}'
    # 题干里的换行 = 卷面上同一小题的第二行 -> <br>（与校对页同一套规则）
    # ⚠️ 顺序不能反：先 mathify（纯文本时才能认出 `<`），再 escape，最后 sym_html。
    #    反过来的话 mathify 会把 SVG 里的 `stroke-width` 连字符也包成 KaTeX。
    return sym_html(html.escape(mathify(fix_punct(str(seg.get("v", "")))))
                    ).replace(NEWLINE, "<br>")


def stem_html(segs: list[dict]) -> str:
    return " ".join(seg_html(s) for s in segs or [])


def split_figs(q: dict) -> tuple[list[dict], list[dict]]:
    """把题干里的 figure 片段摘出来，返回 (插图片段, 其余片段)。

    插图不能留在文字流里：留在文字流里会独占一行居中、把答题区往下顶。
    应用题要挪到题干**下方右侧**，带图选择题要挪到**选项右侧**——都由调用方决定。
    """
    figs, rest = [], []
    for s in q.get("stem") or []:
        if isinstance(s, dict) and s.get("t") == "figure":
            figs.append(s)
        else:
            rest.append(s)
    return figs, rest


def figs_html(figs: list[dict]) -> str:
    return "".join(seg_html(s) for s in figs)


def has_unknown(q: dict) -> bool:
    """题干/选项里带 [?] 的题不能进正式卷面（识别没看清，不能猜）。"""
    txt = "".join(str(s.get("v", "")) for s in (q.get("stem") or []) if isinstance(s, dict))
    for o in q.get("options") or []:
        if isinstance(o, dict):
            txt += str(o.get("v", ""))
    return "[?]" in txt


# ---------------------------------------------------------------- 组卷
_WS_RE = re.compile(r"[\s\u3000\xa0]+")


def q_fingerprint(q: dict) -> str:
    """题目的内容指纹：只取「题干 + 选项」的文字，**去掉所有空白**后比较。

    用来在**合卷**时剔掉同一道题的多份副本 —— 题库是「整页全量识别、不筛选」入库的
    （见 recognition-spec），同一份卷若被拍成多张有重叠的照片，重叠区的题就会入库两次
    （如「乘法综合练习」与「第一二单元素养卷」在接缝处重复拍了「4. 写出综合算式」，
    `63÷9=7 / 147-7=140` 与 `367+26=393 / 494-393=101` 各出现两遍）。

    ⚠️ 只归一化空白、**不动标点与数字**（原卷本来就全角半角混排，动标点容易误判）：
    宁可漏判两道重复题，也不能把两道不同的题判成同一道。
    题内插图只按数量占位（不同照片上同一道题的 `figure.src` 不同，带上反而认不出重复）。
    """
    parts = []
    for seg in q.get("stem") or []:
        parts.append("⟨图⟩" if seg.get("t") == "figure" else str(seg.get("v") or ""))
    stem = "".join(parts)
    opts = "‖".join(str(o.get("v") or "") for o in (q.get("options") or []))
    return _WS_RE.sub("", stem) + "\u0001" + _WS_RE.sub("", opts)


def collect(files: list[Path], dedup: bool = True) -> tuple[list[dict], list[str]]:
    """按 SECTIONS 的 pick 归集题目；返回 (板块列表, 警告列表)。

    `dedup=True`（默认）时**在每个大题内部**按内容指纹去重：同一道题的多份副本
    （一份卷拍成多张有重叠的照片就会有）只印一份。跨大题不去重 —— 同一道题出现在
    两个不同大题里更可能是识别/归类的真问题，该留给人看，而不是悄悄合并。
    """
    pool, warns = [], []
    for f in files:
        try:
            q = load_question(f)
        except Exception as exc:  # noqa: BLE001
            warns.append(f"[跳过] {f.name}: {exc}")
            continue
        pool.append(q)

    picked = set()
    out = []
    for spec in SECTIONS:
        items = [q for q in pool
                 if (q.get("section") or "") in spec["pick"]
                 and not any(k in (q.get("section") or "") for k in SKIP_SECTIONS)]
        kept = []
        seen: dict[str, str] = {}          # 内容指纹 -> 已保留的题目 id
        for q in items:
            if has_unknown(q):
                warns.append(f"[剔除] {q['id']}：题干含 [?]（识别存疑，正式卷面不收录）")
                continue
            if dedup:
                fp = q_fingerprint(q)
                if fp in seen:
                    warns.append(f"[去重] {q['id']}：「{spec['no']}、{spec['title']}」里与 "
                                 f"{seen[fp]} 内容完全相同（同一份卷的照片重叠所致），卷面只印一份")
                    picked.add(q["id"])
                    continue
                seen[fp] = q["id"]
            kept.append(q)
            picked.add(q["id"])
        if not kept:
            warns.append(f"[空板块] {spec['no']}、{spec['title']}：没有题（检查 pick 与本库 section 名是否对得上）")
        out.append({**spec, "items": kept})

    for qid in sorted({q["id"] for q in pool} - picked):
        warns.append(f"[未收录] {qid}：section={pool_by_id(pool, qid)}（不在任何大题里；草稿类属正常）")
    return out, warns


def pool_by_id(pool: list[dict], qid: str) -> str:
    for q in pool:
        if q["id"] == qid:
            return q.get("section") or "(空)"
    return "?"


def blanks_of(q: dict) -> int:
    """数一道填空题有几个空。

    卷面上留空只有两种印法（见 recognition-spec「占位方框 / 下划线留空」）：
      * 全角括号留空 `（　　）`（括号里全是全角空格 / 空白）
      * 下划线留空 `____`（识别时统一转写成连续半角下划线，≥2 个）
    **方框 `□`、圆圈 `○` 不算空**——它们是题面给的已知量或待填比较符位（如「□24×4」的 □）。
    """
    n = 0
    for seg in q.get("stem") or []:
        if isinstance(seg, dict) and seg.get("t") == "text":
            n += len(BLANK_RE.findall(str(seg.get("v", ""))))
    return n


def item_score(spec: dict, q: dict, idx: int) -> int:
    """一道题的分数。三种口径，优先级从高到低：
      * `scores`     逐题显式给分（应用题：前面的题分多、后面的题分少）；
      * `per_blank`  每空固定分 × 本题空数（填空题）；
      * `per`        每题固定分（口算、竖式、选择……）。
    """
    if spec.get("scores") is not None:
        return spec["scores"][idx]
    if spec.get("per_blank") is not None:
        return spec["per_blank"] * max(1, blanks_of(q))
    return spec.get("per", 0)


def sec_caption(spec: dict) -> str:
    """大题标题后的分值说明。填空题说「每空几分」——说「每题几分」是错的。

    「按卷还原」模式不标分值时返回空串（原卷分值没有被识别记录，别编）。
    """
    items = spec["items"]
    if not items:
        return ""
    if spec.get("scores") is not None:
        return f"（共 {sum(spec['scores'])} 分）"
    if spec.get("per_blank") is not None:
        b = sum(max(1, blanks_of(q)) for q in items)
        return f"（每空 {spec['per_blank']} 分，共 {b * spec['per_blank']} 分）"
    if spec.get("per") is None:
        return ""
    return f"（每题 {spec['per']} 分，共 {len(items) * spec['per']} 分）"


def item_html(spec: dict, q: dict, no: int, score: int) -> str:
    """一道题。样式随大题 style 变：oral/cmp 是密排小格，calc/app 要留书写空间。

    小题号有两种来源：
      * `printed=True`（按卷还原）——**用原卷印刷题号** `source.printed_no`（`（1）`/`1.`），
        原卷没印题号的（口算、竖式、递等式…)就不编号，跟原件一致；
      * 否则用 `(1)(2)...`，`numbered=False` 的大题不输出（计算类：算式本身就是标识）。
    """
    style = spec["style"]
    if spec.get("printed"):
        pn = (q.get("source") or {}).get("printed_no")
        tag = f'<span class="cn">{html.escape(str(pn))}</span>' if pn else ""
    elif spec.get("numbered", True):
        tag = f'<span class="cn">({no})</span>'
    else:
        tag = ""
    pts = f'<span class="pts">（{score} 分）</span>' if score else ""

    if style in ("oral", "cmp"):
        return f'<div class="cell">{tag}{stem_html(q.get("stem"))}</div>'

    if style == "calc":
        return (f'<div class="calc"><div class="calc-top">{tag}{stem_html(q.get("stem"))}</div>'
                f'<div class="calc-box"></div></div>')

    if style == "eq":
        # 「写出综合算式」：每格 = (n) + 已知算式，下方一条答题横线。
        # 题库里四条算式各是一道题，这里用 2 列网格把原件的 2 行 2 列还原出来
        # （原件每列两行算式 + 下方一条横线，所以答题横线是**每格一条**，不是整组一条）。
        return (f'<div class="eq"><div class="eq-stem">{tag}{stem_html(q.get("stem"))}</div>'
                f'<div class="eq-box"></div></div>')

    if style == "app":
        # 插图放题干**下方右侧**（右对齐）：左半边留给学生写算式，不占答题区中间。
        # 分值**跟在题干末尾**（不要 float:right）——浮到右上会在第一行占位、把题干提前折行，
        # q-20260930-056 就被挤出一个「物？」孤字。图已不在文字流里，所以末尾标分是安全的。
        figs, rest = split_figs(q)
        fig = f'<div class="figwrap-right">{figs_html(figs)}</div>' if figs else ""
        return (f'<div class="app"><div class="app-stem">{tag}{stem_html(rest)}{pts}</div>{fig}'
                f'<div class="app-box"></div></div>')

    opts = [o for o in (q.get("options") or []) if isinstance(o, dict)]
    cells = "".join(f'<span class="opt"><b>{"ABCD"[i]}.</b> {seg_html(o)}</span>'
                    for i, o in enumerate(opts))

    if style == "choice":
        figs, rest = split_figs(q)
        body = stem_html(rest)
        if figs and cells:
            # 带图选择题：选项排成 n 列（默认 2 列），插图贴在选项**右侧**——
            # 省一行高度，也不至于把选项挤到图下面去。
            cols = spec.get("fig_opts_cols", 2)
            return (f'<div class="line">{tag}{body}'
                    f'<div class="qrow"><div class="opts opts-{cols}">{cells}</div>'
                    f'<div class="qfig">{figs_html(figs)}</div></div></div>')
        opts_html = f'<div class="opts">{cells}</div>' if cells else ""
        return f'<div class="line">{tag}{body}{opts_html}</div>'

    # line（填空）：插图独占一行居中——图是题目内容的一部分，居中读起来自然。
    figs, rest = split_figs(q)
    fig = f'<div class="figwrap-center">{figs_html(figs)}</div>' if figs else ""
    opts_html = f'<div class="opts">{cells}</div>' if cells else ""
    return f'<div class="line">{tag}{stem_html(rest)}{fig}{opts_html}</div>'



def sections_html(sections: list[dict]) -> list[str]:
    """大题标题 + 题目网格。两条输出链路（四面重排卷 / 按卷还原）共用，别各写一套。"""
    body = []
    for spec in sections:
        if not spec["items"]:
            continue
        cls = "sec new-page" if spec.get("new_page") else "sec"
        sno = f'<span class="sno">{html.escape(spec["no"])}、</span>' if spec.get("no") else ""
        body.append(f'<h2 class="{cls}">{sno}{html.escape(spec["title"])}'
                    f'<span class="sscore">{sec_caption(spec)}</span></h2>')
        grid = f' grid-{spec["cols"]}' if spec["cols"] > 1 else ""
        style_attr = []
        if spec.get("box_h"):
            style_attr.append(f"--box:{spec['box_h']}")
        if spec.get("row_gap"):
            style_attr.append(f"--rowgap:{spec['row_gap']}")
        varbox = f' style="{";".join(style_attr)}"' if style_attr else ""
        cells = "".join(item_html(spec, q, i + 1, item_score(spec, q, i))
                        for i, q in enumerate(spec["items"]))
        body.append(f'<div class="block{grid}"{varbox}>{cells}</div>')
    return body


def build(topic_dir: Path, dedup: bool = True) -> tuple[str, list[str], int, int]:
    files = sorted(topic_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"没有题目 JSON：{topic_dir}")
    sections, warns = collect(files, dedup)

    # 按空给分的大题：数不出空的题要报出来——多半是题干留空写法没被 BLANK_RE 覆盖，
    # 不报的话它会静默按 1 空算，总分就悄悄错了。
    for spec in sections:
        if spec.get("per_blank") is not None:
            for q in spec["items"]:
                if not blanks_of(q):
                    warns.append(f"[无空] {q['id']}：{spec['title']}按空给分，但题干里数不出空")

    total = sum(item_score(s, q, i) for s in sections for i, q in enumerate(s["items"]))

    # ---- 卷头
    head = [f'<h1>{PAPER["title"]}</h1>',
            f'<div class="sub">时间：{PAPER["time"]}　　满分：{total} 分</div>',
            '<div class="info">' + "".join(
                f'<span>{k}：<i></i></span>' for k in PAPER["info"]) + '</div>']

    # ---- 得分表
    nos = [s["no"] for s in sections if s["items"]] + ["总分"]
    head.append('<table class="score"><tr><th>题号</th>'
                + "".join(f"<td>{n}</td>" for n in nos) + '</tr>'
                + '<tr><th>得分</th>' + "".join("<td></td>" for _ in nos) + '</tr></table>')

    # ---- 各答题
    body = sections_html(sections)
    body.append(f'<div class="end">—— 试卷结束 ── {PAPER["foot"]}</div>')

    count = sum(len(s["items"]) for s in sections)
    # 屏幕上给两个返回入口（打印时 .backbar 会被 @media print 隐藏）
    backbar = ('<div class="backbar"><a href="papers.html">&larr; 试卷列表</a> · '
               '<a href="index.html">卷列表</a></div>')
    page = (PAGE.replace("__CSS__", css(TIGHT))
                .replace("__KATEX__", build_katex_bundle())
                .replace("__META__", paper_meta("all", ALL_SLUG, PAPER["title"], count,
                                                note="按题型重排的合卷"))
                .replace("__TITLE__", html.escape(PAPER["title"]))
                .replace("__BACKBAR__", backbar)
                .replace("__HEAD__", "".join(head))
                .replace("__BODY__", "\n".join(body)))
    return page, warns, total, count


# ------------------------------------------------ 按卷还原（原图题目布局 → 重新打印）
# 与上面的「按题型重排」是两条链路：上面那套把全库题目合并重排成一张练习卷；
# 这一套是**照某一份卷的原版面重新排一版干净的**（老师要重新打印给学生做），
# 输出到 data/render/ 的 `paper-<slug>.html`，与卷详情页同级（相对链接才点得通）。
#
# 三条还原原则：
#   1. 板块顺序 = 原卷阅读顺序（按 `no` 首现排序），板块标题用原卷的（「2. 用竖式计算」）；
#   2. **列数由原卷题目的 `source.bbox` 实测**（`infer_cols`：同一横排里有几题就是几列）——
#      不硬编码，因为同一种题型在不同卷上列数不同（口算这份是 3 列、那份是 4 列，
#      竖式有 3 列也有一排 4 个的）。实测值与原卷一致，也顺手校对过「排数×列数=题数」；
#   3. 小题号用**原卷印刷题号** `source.printed_no`（`（1）`/`1.`）；原卷没印号的就不编号。
#
# 分值默认不标：schema v2 不收分值，原卷多少分我们并不知道，编一个出来不如不标。
# 要标就加 `--scores`，走 SCORE_PRESET 的估计口径（会在 stderr 明确警告这是估计值）。
DOC_PAPER = {
    "info": ["班级", "姓名", "得分"],
    "foot": "请检查一遍，再写下一题。",
}

# 板块 → 版式。**顺序即匹配优先级**（「列式计算」含“计算”二字，必须排在“计算”前面）。
LAYOUT_RULES = [
    (re.compile(r"竖式"),                       dict(style="calc", box_h="34mm")),
    (re.compile(r"递等式|脱式"),                 dict(style="calc", box_h="27mm")),
    (re.compile(r"综合算式"),                    dict(style="eq", box_h="11mm")),
    (re.compile(r"列式"),                        dict(style="app", box_h="30mm")),
    (re.compile(r"直接写出得数|算一算|口算"),       dict(style="oral")),
    (re.compile(r"计算"),                        dict(style="calc", box_h="27mm")),
    (re.compile(r"在○里填|填上\s*[“\"]?[><＞＜]|比较"), dict(style="cmp")),
    (re.compile(r"选择"),                        dict(style="choice", fig_opts_cols=2)),
    (re.compile(r"填空|填一填"),                  dict(style="line")),
    (re.compile(r"应用|解决问题|操作|图形|画一画"),   dict(style="app", box_h="37mm")),
]
DEFAULT_LAYOUT = dict(style="line")

# `--scores` 时的估计分值（按 style）。**这是估的**，原卷分值没被识别记录。
SCORE_PRESET = {"oral": 1, "cmp": 1, "choice": 1, "calc": 2, "eq": 2, "line": 5, "app": 5}


def _gap_clusters(xs: list[int], gap: int) -> list[list[int]]:
    """排序后的左边界按 gap 切成若干簇（每簇保留成员，供并簇用）。"""
    cs: list[list[int]] = [[xs[0]]]
    for x in xs[1:]:
        if x - cs[-1][-1] > gap:
            cs.append([x])
        else:
            cs[-1].append(x)
    return cs


def _merge_outlier_cols(cs: list[list[int]]) -> list[list[int]]:
    """孤立小簇并入最近大簇。

    中列某题起始 x 偏右（算式长一点），会造出只含 1 题的伪列，把 3 列数成 4 列
    （实测：第2单元照片卷「一、算一算」x=1372 的孤簇、「三、比大小」x=1326 的孤簇）。
    判据：小簇代表点与某大簇（≥2 题）代表点的距离 < 半个列距
    （列距 = 大簇代表点间距的中位数）。没有两个大簇可参照时不动（全单簇 = 每题一列，别并）。
    """
    for _ in range(6):
        big = [c for c in cs if len(c) >= 2]
        if len(big) < 2:
            break
        reps = [min(c) for c in big]
        gaps = sorted(b - a for a, b in zip(reps, reps[1:]))
        pitch = gaps[len(gaps) // 2]
        best: tuple[int, list[int], int] | None = None
        for c in cs:
            if len(c) >= 2:
                continue
            for j, r in enumerate(reps):
                d = abs(c[0] - r)
                if best is None or d < best[0]:
                    best = (d, c, j)
        if best is None or best[0] >= 0.5 * pitch:
            break
        big[best[2]].extend(best[1])
        cs.remove(best[1])
    return cs


def _cluster_cols(items: list[dict], gap: int, max_cols: int) -> int:
    """把一批题的 bbox 左边界按 gap 聚类，簇数 = 列数（孤立伪列先并入大簇）。"""
    xs = sorted(q["source"]["bbox"][0] for q in items)
    if not xs:
        return 1
    return max(1, min(len(_merge_outlier_cols(_gap_clusters(xs, gap))), max_cols))


def infer_cols(items: list[dict], gap: int = 40, max_cols: int = 6) -> int:
    """从原卷坐标实测这一板块是几列。

    做法：把所有题的 `bbox` 左边界排序后按 `gap` 聚类 —— 左边界聚成几簇，原卷就是几列。
    （比「按 y 分行再数」稳：手写卷的裁剪框会把学生的竖式/答题笔迹也包进去，y 方向会被撑开
      导致相邻两排合并，x 方向不受影响。）

    ⚠️ 合并多张照片后必须**按照片分别聚类再取最小**：同一大题在不同照片上列数可能不同
    （实测：第2单元练习卷的「四、递等式计算」p1 是 3 列、p2 是 2 列）。
    全部题一起聚类会把两张照片的列位置并成 3+2=4 这种伪列数 -> 算式被挤到折行；
    取最小则保证每张照片上的题都不会折行。只有 1 道题的照片不参与取最小
    （否则一道残题会把整个大题压成一列）。
    """
    by_page: dict[str, list[dict]] = {}
    for q in items:
        key = str((q.get("source") or {}).get("file") or "")
        by_page.setdefault(key, []).append(q)
    counts = [_cluster_cols(page, gap, max_cols) for page in by_page.values()]
    solid = [c for c, page in zip(counts, by_page.values()) if len(page) >= 2]
    n = min(solid) if solid else max(counts or [1])
    return max(1, min(n, max_cols, len(items)))


def layout_for(section: str) -> tuple[dict, bool]:
    """板块名 -> 版式参数；返回 (参数, 是否命中规则)。"""
    for pat, lay in LAYOUT_RULES:
        if pat.search(section):
            return dict(lay), True
    return dict(DEFAULT_LAYOUT), False


def item_score_doc(spec: dict, q: dict, idx: int) -> int:
    """按卷还原 + `--scores` 时的每题分值（估计值，填空按空）。"""
    if spec.get("per_blank") is not None:
        return spec["per_blank"] * max(1, blanks_of(q))
    return spec.get("per", 0)


def paper_key(src: dict) -> str:
    """一份卷的分组键：同一份卷的多张照片共享 `source.paper`；没标的卷仍按单张照片分组。

    `source.paper` 取值形如 `2026-10-01-第2单元练习卷.jpg`（虚拟文件名，不必真实存在），
    好让 doc_date / doc_title / doc_slug 这些「按文件名推导」的函数原样复用。
    """
    return str(src.get("paper") or src.get("file") or "（未标注来源）")


def paper_files(items: list[dict]) -> list[str]:
    """该卷用到的全部原图（照片）文件名，**按页序**排列。

    页序优先取 `source.paper_page`（一份卷拍成多张照片时标，从 1 起）；
    文件名顺序天然等于页序的卷（如 `-p1..-p4`）可以不标，文件名顺序与页序相反时**必须**标
    （`…-应用.jpg` 的 `-`(0x2D) 在字符串排序里会跑到 `…卷.jpg` 的 `.`(0x2E) 前面）。
    没标 `paper_page` 的照片退回按文件名排序（= 旧行为）。
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
    return sorted(page, key=lambda n: (1, 0, n) if page[n] is None else (0, page[n], n))


def order_in_paper(items: list[dict]) -> tuple[list[dict], list[str]]:
    """卷内排序 = 先按照片**页序**（`source.paper_page`；未标时按文件名），再按卷内 `no`。

    为什么不能只按 `no`：不同照片各自从 1 开始编号的卷（有的卷就是这么识别的），
    只按 no 排会把第 2 页的第 1 题插到第 1 页的第 1 题前面。
    返回 (排好序的题, 该卷的照片顺序)。
    """
    pages = paper_files(items)
    idx = {fn: i for i, fn in enumerate(pages)}
    items.sort(key=lambda q: (idx.get(str((q.get("source") or {}).get("file") or ""), 999),
                              q.get("no") if isinstance(q.get("no"), int) else 9999))
    return items, pages


def collect_doc(pool: list[dict], with_scores: bool = False,
                dedup: bool = True) -> tuple[list[dict], list[str]]:
    """把一份卷的题按**原版面**归集：板块顺序 = 原卷顺序，列数实测，题号用原卷印刷题号。

    板块顺序与题序都跟着**传进来的 pool 顺序**（调用方已按「照片顺序 + 卷内 no」排好），
    不再自己按 `no` 重排——合并多张照片后 `no` 可能在不同照片上重叠。

    `dedup=True`（默认）时**在每个板块内部**按内容指纹去重：一份卷拍成多张有重叠的照片时，
    接缝处的题会被拍两遍、入库两次（如素养卷第 1 张底部与乘法卷顶部的「4. 写出综合算式」）。
    题库保持全量（识别层不去重、不跳题），只是**卷面不印两遍**；跨板块不去重（归类问题留给人看）。
    """
    pos = {q["id"]: i for i, q in enumerate(pool)}
    by: dict[str, list[dict]] = {}
    warns: list[str] = []
    for q in pool:
        sec = str(q.get("section") or "未分板块")
        if any(k in sec for k in SKIP_SECTIONS):
            warns.append(f"[跳过] {q['id']}：板块「{sec}」不是题目（草稿类）")
            continue
        by.setdefault(sec, []).append(q)

    sections = []
    for sec, items in sorted(by.items(), key=lambda kv: min(pos[q["id"]] for q in kv[1])):
        items.sort(key=lambda q: pos[q["id"]])
        kept = []
        seen: dict[str, str] = {}
        for q in items:
            if has_unknown(q):
                warns.append(f"[剔除] {q['id']}：题干含 [?]（识别存疑，正式卷面不收录）")
                continue
            if dedup:
                fp = q_fingerprint(q)
                if fp in seen:
                    warns.append(f"[去重] {q['id']}：板块「{sec}」里与 {seen[fp]} 内容完全相同"
                                 f"（同一份卷的照片重叠所致），卷面只印一次")
                    continue
                seen[fp] = q["id"]
            kept.append(q)
        if not kept:
            continue
        lay, hit = layout_for(sec)
        if not hit:
            warns.append(f"[版式兜底] 板块「{sec}」没匹配到版式规则，按整行（line）排")
        cols = infer_cols(kept)
        if cols > len(kept):
            cols = len(kept)
        spec = dict(lay, no="", title=sec, cols=cols, printed=True, numbered=False, items=kept)
        if with_scores:
            if spec["style"] == "line":
                spec["per_blank"] = 1
            else:
                spec["per"] = SCORE_PRESET.get(spec["style"], 1)
        sections.append(spec)
    return sections, warns


def build_doc(pool: list[dict], filename: str, with_scores: bool = False,
              title: str = "", dedup: bool = True,
              compact: bool = False) -> tuple[str, list[str], int, int]:
    """一份卷 -> 可打印的 A4 卷面 HTML（原版面）。返回 (html, 警告, 满分, 题数)。

    `filename` 是分组键（`source.paper` 或原图文件名），用于 slug / 日期；
    `title` 可覆盖抬头（卷面印刷标题，来自 `source.paper_title`）；
    `compact` 为真时叠 `COMPACT` 收紧档 —— 只给「末页几乎全空」的卷单独开，别默认套。
    """
    sections, warns = collect_doc(pool, with_scores, dedup)
    if not sections:
        raise SystemExit(f"{filename}: 没有可用的题目")
    count = sum(len(s["items"]) for s in sections)
    total = sum(item_score_doc(s, q, i) for s in sections for i, q in enumerate(s["items"]))

    title = title or doc_title(filename)
    head = [f'<h1>{html.escape(title)}</h1>']
    sub = f'识别日期 {html.escape(doc_date(filename))}　共 {count} 题'
    if with_scores:
        sub += f'　满分 {total} 分'
    head.append(f'<div class="sub">{sub}</div>')
    head.append('<div class="info">' + "".join(
        f'<span>{k}：<i></i></span>' for k in DOC_PAPER["info"]) + '</div>')
    if with_scores:
        nos = [s["title"].split(".")[0].split("、")[0] for s in sections] + ["总分"]
        head.append('<table class="score"><tr><th>题号</th>'
                    + "".join(f"<td>{html.escape(n)}</td>" for n in nos) + '</tr>'
                    + '<tr><th>得分</th>' + "".join("<td></td>" for _ in nos) + '</tr></table>')

    body = sections_html(sections)
    body.append(f'<div class="end">—— 本卷结束 —— {html.escape(DOC_PAPER["foot"])}</div>')
    slug = doc_slug(filename)
    backbar = ('<div class="backbar"><a href="papers.html">&larr; 试卷列表</a> · '
               f'<a href="{slug}.html">&larr; 本卷解析</a>'
               '　（这里只是预览，打印请用浏览器「打印」或右键下载 PDF）</div>')
    page = (PAGE.replace("__CSS__", css(COMPACT if compact else None))
                .replace("__KATEX__", build_katex_bundle())
                .replace("__META__", paper_meta("doc", slug, title, count,
                                                date=doc_date(filename),
                                                scores=with_scores,
                                                note="按原卷版面还原"
                                                     + ("（紧凑档）" if compact else "")))
                .replace("__TITLE__", html.escape(title))
                .replace("__BACKBAR__", backbar)
                .replace("__HEAD__", "".join(head))
                .replace("__BODY__", "\n".join(body)))
    return page, warns, total, count


def paper_meta(kind: str, slug: str, title: str, questions: int,
               date: str = "", scores: bool = False, note: str = "") -> str:
    """把这份卷面的元信息嵌进页面 <head>，供「试卷列表」页读取。

    为什么嵌在页面里而不是另维护一份清单：清单会跟页面不同步（改了卷面忘了改清单）。
    嵌进去之后，**扫描 data/render/paper-*.html 就能列出全部已生成试卷**，
    页数/PDF/缩略图这几项由 tools/export_paper_pdf.py 写进 data/paper/manifest.json 补充
    （页数只有打印成 PDF 才知道，见 README「导出 PDF」）。
    """
    obj = {"kind": kind, "slug": slug, "title": title, "questions": questions,
           "date": date, "scores": scores, "note": note}
    return '<meta name="x-paper" content="' + html.escape(
        json.dumps(obj, ensure_ascii=False), quote=True) + '">'


def css(overlay: dict | None = None) -> str:
    """卷面样式。`overlay` 用于覆盖 PAPER 里的松紧参数（合卷走 TIGHT，按卷还原不传）。

    两条链路共用这一份 CSS（别各写一套），差异只在几个可覆盖的间距变量上。
    """
    P = {**PAPER, **(overlay or {})}
    guide = "1px dotted #c8c8c8" if P["guide_lines"] else "none"
    # 页边距（2026-10-11 从 14/13/10 放大）：原来太贴纸边，打印出来整体靠左上。
    # 这条链路是**一张长卷面**靠浏览器自然分页，边距只能交给 @page（内边距方案会让
    # 中间页没有上边距）；app 那边是自己分页、边距走卷面内边距，两边数值对齐到 18mm。
    return f"""
@page {{ size: A4; margin: 18mm 18mm 16mm; }}
* {{ box-sizing: border-box; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{ margin: 0; background: #e9ebef; color: #000;
        font-family: "Times New Roman", "宋体", SimSun, serif;
        font-size: {P['font_size']}; line-height: {P['line_height']}; }}
/* 屏幕：模拟一张 210mm 宽的纸；打印时交回 @page（否则边距会叠加） */
.sheet {{ width: 210mm; margin: 0 auto 10mm; background: #fff; padding: 18mm 18mm 16mm;
          box-shadow: 0 2px 12px rgba(0,0,0,.16); }}
.backbar {{ max-width: 210mm; margin: 12px auto 6px; font: 14px "Microsoft YaHei", sans-serif; }}
.backbar a {{ color: #1d4ed8; text-decoration: none; }}
@media print {{
  body {{ background: #fff; }}
  .sheet {{ width: auto; margin: 0; padding: 0; box-shadow: none; }}
  .backbar {{ display: none; }}   /* 打印时不要把这个导航条印上去 */
}}

/* 卷头 */
h1 {{ font-family: "黑体", SimHei, sans-serif; font-size: 17pt; text-align: center;
      letter-spacing: .12em; margin: 0 0 2mm; font-weight: 700; }}
.sub {{ text-align: center; font-size: 10.5pt; margin-bottom: 4mm; }}
.info {{ display: flex; justify-content: space-between; gap: 6mm; font-size: 11pt;
         border-bottom: 1.2px solid #000; padding-bottom: 2mm; }}
.info span {{ white-space: nowrap; }}
.info i {{ display: inline-block; min-width: 24mm; border-bottom: 1px solid #000; }}
table.score {{ width: 100%; border-collapse: collapse; margin: 4mm 0 3mm; font-size: 11pt;
               table-layout: fixed; }}
table.score th, table.score td {{ border: 1px solid #000; text-align: center;
                                  padding: 1.5mm 0; font-weight: 400; }}
table.score th {{ background: #f2f2f2; width: 18mm; }}

/* 大题 */
h2.sec {{ font-family: "黑体", SimHei, sans-serif; font-size: 12.5pt; font-weight: 700;
          margin: {P['sec_margin']}; break-after: avoid; }}
h2.sec.new-page {{ break-before: page; }}
h2.sec .sscore {{ font-family: "宋体", SimSun, serif; font-size: 10pt; font-weight: 400;
                  margin-left: 2mm; }}
.block.grid-2, .block.grid-3, .block.grid-4, .block.grid-6 {{ display: grid;
    gap: var(--rowgap, {P['gap_row']}) {P['gap_col']}; }}
.block.grid-2 {{ grid-template-columns: repeat(2, 1fr); }}
.block.grid-3 {{ grid-template-columns: repeat(3, 1fr); }}
.block.grid-4 {{ grid-template-columns: repeat(4, 1fr); }}
.block.grid-6 {{ grid-template-columns: repeat(6, 1fr); }}

.cn {{ margin-right: 1.2mm; }}
.pts {{ font-size: 10pt; color: #444; margin-left: 1.5mm; white-space: nowrap; }}
.cell {{ break-inside: avoid; white-space: nowrap; }}
.grid-6 .cell {{ font-size: 11.5pt; }}

/* 竖式 / 递等式 / 应用题：留出书写区（--box 由 SECTIONS.box_h 给） */
.calc, .app {{ break-inside: avoid; }}
.calc-top, .app-stem {{ }}
.calc-box, .app-box {{ height: var(--box, 30mm); border-bottom: {guide}; }}
.app {{ margin-bottom: {P['line_gap']}; }}

/* 写出综合算式（2 列网格）：每格「(n) + 已知算式」+ 下方答题横线。
   横线是**实线**（原件就是一条实线，不是占位虚线），高度由 box_h 给 = 学生写字的空间。 */
.eq {{ break-inside: avoid; }}
.eq-stem {{ white-space: nowrap; }}
.eq-box {{ height: var(--box, 11mm); border-bottom: 1px solid #333; }}

/* 整行题（填空 / 选择） */
.line {{ break-inside: avoid; margin-bottom: {P['line_gap']}; }}
.opts {{ display: flex; flex-wrap: wrap; gap: 2mm 8mm; margin: 2mm 0 0 6mm;
         font-size: 11.5pt; }}
.opt {{ white-space: nowrap; }}
/* 带图选择题：选项两列 + 插图贴右侧 */
.qrow {{ display: flex; align-items: flex-start; gap: 6mm; margin: 1.5mm 0 0 6mm; }}
.opts-2 {{ flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1fr;
           gap: 1.5mm 6mm; margin: 0; }}
.qfig {{ flex: 0 0 auto; padding-top: .5mm; }}
/* 贴选项右侧的图（多为竖式，窄高）：比通栏图放宽一点高度，不然缩得太小看不清 */
.qfig .fig {{ max-height: calc(29mm * var(--fdw, 100) / 100);
              max-width: calc(28mm * var(--fdw, 100) / 100); }}

/* 每大题最后一个的不需要下外边距（否则白留一格题距，7 个大题白吃 ~35mm，
   正好把最后一行挤到下一页） */
.block > :last-child {{ margin-bottom: 0; }}

/* 题内插图（三种落位，按题型选，别写死成一种）：
   * .figwrap-center  填空类：独占一行居中（图是题目内容的一部分，居中读起来自然）
   * .figwrap-right   应用题：题干**下方右侧**——左半边留给学生写算式；
                     居中会把书写区顶到页面中间，学生没地方写（用户反馈过）
   * .qfig            带图选择题：贴在选项右侧
   尺寸按「宽或高先到限制」缩放，实测等效 dpi 都在 130+（石榴竖式 160、微波炉 152、
   泳道 181、电梯 132）。**不要改回把图混在文字流里**：图高会把所在行的行距整个撑开，
   q-20261001-005 就出现过「（　　）。」被顶到下一行、中间裂开一大片。 */
.fig {{ display: block; max-height: calc(28mm * var(--fdw, 100) / 100);
        max-width: calc(52mm * var(--fdw, 100) / 100); }}
.figwrap-center {{ display: flex; justify-content: center; margin: 2mm 0; }}
.figwrap-right {{ display: flex; justify-content: flex-end; margin: 1mm 0 0; }}
.fig-miss {{ color: #999; }}
/* 插图说明（识别时补的 figure.caption）：图下小字。打印后万一图印不清，也能靠这句话读懂题意 */
.figbox {{ display: block; }}
/* 显示位置 / 文字环绕（编辑里调的 pos / wrap，见 fig_view）：块级 + margin auto 对齐，
   在图是 flex 子项时同样生效（margin-left:auto 把图推到右边），所以能压过 .figwrap-* 的默认。 */
.figbox.fp-l {{ margin-left: 0; margin-right: auto; }}
.figbox.fp-c {{ margin-left: auto; margin-right: auto; }}
.figbox.fp-r {{ margin-left: auto; margin-right: 0; }}
.figbox.fw-l {{ float: left; margin: 1mm 4mm 1.5mm 0; }}
.figbox.fw-r {{ float: right; margin: 1mm 0 1.5mm 4mm; }}
.figcap {{ display: block; font-size: 8.5pt; color: #444; text-align: center;
           line-height: 1.35; margin-top: .5mm; }}
.end {{ text-align: center; color: #888; font-size: 9.5pt; margin-top: 2mm; }}
{SYMBOL_CSS}
"""


PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>__TITLE__</title>
__META__
__KATEX__
<style>__CSS__</style></head>
<body>
__BACKBAR__
<div class="sheet">
__HEAD__
__BODY__
</div>
<script>
window.addEventListener("DOMContentLoaded", () => {
  if (window.renderMathInElement) {
    renderMathInElement(document.body, {
      delimiters: [ { left: "\\\\(", right: "\\\\)", display: false } ],
      throwOnError: false,
    });
  }
});
</script>
</body></html>
"""


def run_by_doc(in_dir: Path, out_dir: Path, with_scores: bool, dedup: bool = True) -> int:
    """按原版面逐卷生成可打印卷面（原图题目布局还原）。

    分组键 = `source.paper or source.file`：一份卷拍成多张照片时，
    只要这些题都标了同一个 `source.paper`，就合成**一份**卷面（页序按 `paper_page`）。
    """
    files = sorted(in_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"没有题目 JSON：{in_dir}")
    pool: dict[str, list[dict]] = {}
    titles: dict[str, str] = {}
    for f in files:
        try:
            q = load_question(f)
        except Exception as exc:  # noqa: BLE001
            print(f"[跳过] {f.name}: {exc}", file=sys.stderr)
            continue
        src = q.get("source") or {}
        key = paper_key(src)
        pool.setdefault(key, []).append(q)
        pt = str(src.get("paper_title") or "").strip()
        if pt and key not in titles:
            titles[key] = pt

    out_dir.mkdir(parents=True, exist_ok=True)
    if with_scores:
        print("[注意] --scores 用的是**估计**分值（原卷分值没有被识别记录）："
              f"填空每空 1 分，其余按 {SCORE_PRESET}；若与原卷不符，改 SCORE_PRESET 或别加此参数。",
              file=sys.stderr)
    for key, items in sorted(pool.items()):
        items, pages = order_in_paper(items)
        slug = doc_slug(key)
        compact = slug in COMPACT_DOCS
        page, warns, total, count = build_doc(items, key, with_scores, title=titles.get(key, ""),
                                             dedup=dedup, compact=compact)
        out = out_dir / f"paper-{slug}.html"
        out.write_text(page, encoding="utf-8")
        for w in warns:
            print(f"  {w}", file=sys.stderr)
        lay = " / ".join(f"{s['title']}×{s['cols']}列" for s in collect_doc(items, dedup=dedup)[0])
        head = titles.get(key) or key
        print(f"完成：{head}  {count} 题" + (f" / 满分 {total} 分" if with_scores else "")
              + (f"  [紧凑档]" if compact else "") + f" -> {out}")
        if len(pages) > 1:
            print(f"        本卷由 {len(pages)} 张照片合并：{'、'.join(pages)}")
        print(f"        板块列数（原卷实测）：{lay}")
    print(f"\n共 {len(pool)} 份卷 -> {out_dir}（文件名与卷详情页 doc-<...>.html 同 slug）")
    print("提示：卷详情页的「打印本卷」按钮与「试卷列表」页(papers.html)都是渲染时按文件存在"
          "与否决定的，刚生成/更新过打印页要**重跑一次** engine/render.py 才会刷新。")
    print("导出 PDF（顺带写页数/缩略图到试卷列表）：tools/export_paper_pdf.py --docs")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="组卷渲染器（题库 JSON -> A4 试卷 HTML）")
    ap.add_argument("input", nargs="?", default=str(PROJECT_ROOT / "data" / "questions"),
                    help="题目 JSON 目录")
    ap.add_argument("-o", "--out", default=None,
                    help=f"输出目录（两种模式默认都是 {DEFAULT_OUT}）")
    ap.add_argument("--by-doc", action="store_true",
                    help="按**原卷版面**逐卷生成可打印卷面（原图题目布局还原，重新打印给学生做）")
    ap.add_argument("--scores", action="store_true",
                    help="--by-doc 时标分值（估计口径，原卷分值未被识别记录）")
    ap.add_argument("--keep-dup", action="store_true",
                    help="**不去重**：默认会把同一道题的多份副本（一份卷拍成多张有重叠的照片就会"
                         "有）只印一份——合卷与按卷还原都是；加此开关则全部保留")
    args = ap.parse_args()

    if args.by_doc:
        return run_by_doc(Path(args.input), Path(args.out or DEFAULT_OUT), args.scores,
                          dedup=not args.keep_dup)

    out_dir = Path(args.out or DEFAULT_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)

    page, warns, total, count = build(Path(args.input), dedup=not args.keep_dup)
    out = out_dir / f"paper-{ALL_SLUG}.html"
    out.write_text(page, encoding="utf-8")

    for w in warns:
        print(w, file=sys.stderr)
    print(f"完成：{count} 题 / 满分 {total} 分 -> {out}")
    print("按原卷版面逐卷打印：python engine/paper.py --by-doc")
    print("导出 PDF 并在「试卷列表」页里显示页数/缩略图："
          "python tools/export_paper_pdf.py --docs（隔离 venv 里跑）")
    print("改过打印页后要重跑一次 engine/render.py，试卷列表与按钮才会刷新。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
