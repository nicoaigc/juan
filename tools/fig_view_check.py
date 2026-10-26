# -*- coding: utf-8 -*-
"""题内插图「显示大小 / 位置」在打印链路上的口径自检（2026-10-11）。

用户原话：「有些，你没有切图片，所以编辑的时候，是需要支持切图片的；
          同时，需要支持调整图片显示大小，调整图片显示位置」

网页端（app/js/render.js 的 figView）与打印端（engine/paper.py 的 fig_view、
engine/render.py 的内联 figView）必须是**同一套口径**：同一道题在题库页看着靠右、
印出来却居中，用户没法理解。这里把打印端钉住，网页端由 tools/fig_edit_check.mjs 用真 DOM 验。

跑法：python tools/fig_view_check.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))
import paper  # noqa: E402

checks = []


def ck(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


def fv(**seg):
    return paper.fig_view(seg)


# ① 默认（识别给的原样：没有 dw/pos/wrap）-> 一个类名、一个 style 都不加
cls, sty = fv(t="figure", src="a.jpg")
ck("①-1 默认图：不加类名、不加 style", cls == "" and sty == "", f"cls={cls!r} sty={sty!r}")

# ② 显示大小：30~100 的百分数落成 --fdw；100 / 越界不落（不留脏数据）
cls, sty = fv(dw=70)
ck("①-2 dw=70 -> --fdw:70", sty == ' style="--fdw:70"' and cls == "", f"{sty!r}")
for bad in (0, 29, 100, 120, None, "x"):
    _c, _s = fv(dw=bad)
    if _s:
        break
else:
    bad = None
ck("①-3 dw 为 100 / 越界 / 缺省 -> 不写 style（100 = 默认满宽，不存字段）", bad is None,
   f"第一个漏网的：{bad!r}")

# ③ 显示位置：左 / 居中 / 右
for k, want in (("l", " fp-l"), ("c", " fp-c"), ("r", " fp-r")):
    cls, sty = fv(pos=k)
    ck("②-1 pos=%s -> %s" % (k, want.strip()), cls == want and sty == "", f"cls={cls!r}")
cls, _s = fv(pos="x")
ck("②-2 认不得的 pos 当没设（不产生野类名）", cls == "", f"cls={cls!r}")

# ④ 文字环绕：只有左右成立，居中 / 没位置都不环绕
cls, _s = fv(pos="l", wrap=True)
ck("③-1 pos=l + wrap -> fw-l（浮起来，文字绕另一侧）", cls == " fw-l", f"cls={cls!r}")
cls, _s = fv(pos="r", wrap=True)
ck("③-2 pos=r + wrap -> fw-r", cls == " fw-r", f"cls={cls!r}")
cls, _s = fv(pos="c", wrap=True)
ck("③-3 pos=c + wrap -> 仍是 fp-c（居中不环绕）", cls == " fp-c", f"cls={cls!r}")
cls, _s = fv(wrap=True)
ck("③-4 没定位置就谈环绕 -> 当没设", cls == "", f"cls={cls!r}")

# ⑤ 片段 HTML：类名 / style 真的贴到 .figbox 上（渲染层照它排版）
crops = sorted(p.name for p in paper.CROPS_DIR.glob("*.jpg")) if paper.CROPS_DIR.is_dir() else []
if crops:
    html_ = paper.seg_html({"t": "figure", "src": crops[0], "caption": "图", "dw": 60, "pos": "r"})
    ck("④-1 seg_html 把 dw/pos 贴到片段上",
       'class="figbox fp-r"' in html_ and 'style="--fdw:60"' in html_, html_[:120])
    html2 = paper.stem_html([{"t": "text", "v": "看图："},
                             {"t": "figure", "src": crops[0], "dw": 50, "pos": "l", "wrap": True}])
    ck("④-2 stem_html 里同样生效（wrap -> fw-l）",
       'class="figbox fw-l"' in html2 and "--fdw:50" in html2, html2[:120])
else:
    ck("④-1 seg_html 把 dw/pos 贴到片段上", False, "data/crops 下没有裁剪图可用")
    ck("④-2 stem_html 里同样生效（wrap -> fw-l）", False, "data/crops 下没有裁剪图可用")
src = (ROOT / "engine" / "paper.py").read_text(encoding="utf-8")
ck("④-3 打印端 CSS：图的宽高都按 --fdw 缩", "max-width: calc(52mm * var(--fdw" in src,
   "CSS 模板里找不到 --fdw 缩放")
ck("④-4 打印端 CSS：左/中/右 + 环绕五条都在",
   all(s in src for s in (".figbox.fp-l", ".figbox.fp-c", ".figbox.fp-r",
                          ".figbox.fw-l", ".figbox.fw-r")), "")

# ⑥ 跨端一致性：两个 JS（网页端 render.js / 单文件导出 render.py 内联段）判据必须同源
js = (ROOT / "app" / "js" / "render.js").read_text(encoding="utf-8")
ck("⑤-1 网页端 render.js 有 figView（dw 30~100 / pos l·c·r / wrap 仅左右）",
   "function figView(seg)" in js and "dw >= 30 && dw < 100" in js and 'p !== "c"' in js, "")
rp = (ROOT / "engine" / "render.py").read_text(encoding="utf-8")
ck("⑤-2 单文件导出 render.py 的内联 figView 同口径",
   "function figView(seg)" in rp and 'dw >= 30 && dw < 100' in rp and 'p !== "c"' in rp, "")
ck("⑤-3 网页端 CSS 有 --fdw 与 fp-/fw-",
   all(s in (ROOT / "app" / "css" / "app.css").read_text(encoding="utf-8")
       for s in ("var(--fdw", ".figbox.fp-r", ".figbox.fw-l")), "")

# ⑦ 卷面（sheet.js）默认宽 = 题型默认 × dw，且显式位置不再被"应用题靠右"抢走
sh = (ROOT / "app" / "js" / "sheet.js").read_text(encoding="utf-8")
ck("⑥-1 卷面默认宽按 dw 折算", "* dwOf(q) / 100" in sh, "")
ck("⑥-2 手工定过位置的图不被题型默认落位抢走",
   sh.count("!Render.figPosFixed(q)") >= 2, "")

# ⑧ 不能回潮：2026-10-07 删掉的「调整」弹层别偷偷加回来
ck("⑦-1 「调整」弹层（figa/figv/透视矫正）没有回潮",
   "figaQuadWarp" not in js and "triAffine" not in js and "data-fadj" not in js, "")

if __name__ == "__main__":
    bad = 0
    for name, ok, detail in checks:
        print(("  OK  " if ok else "  NG  ") + name + ("" if ok else "   <<< " + str(detail)))
        bad += 0 if ok else 1
    print("\n%d 项，%d 项未过" % (len(checks), bad))
    sys.exit(1 if bad else 0)
