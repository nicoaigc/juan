# -*- coding: utf-8 -*-
"""第 5 份试卷（9.28 家庭作业·多位数乘一位数，带红笔批改）全量识别。

源图：clipboard-2026-09-30T16-05-20-113Z-410b87c7.jpg (1131 x 1920)
卷面：第一部分残留「4. 写出综合算式（(1)(2)）」+「5. 列式计算」（只有标题、本页无小题，跳过）
      第二部分 概念：1、选择题 (1)-(6)  2、填空题 (1)-(6)
共 **16 题**入库：4 综合算式 + 6 选择 + 6 填空。

⛔ **【已被推翻，勿直接重跑】** 下面「四个算式各自成题」的切分是错的（2026-10-01 二次返工）：
   正确口径 = **按印刷题号成题**，而印刷题号只出现两次 → 本板块是 **2 题**
   （(1) 含 `63÷9=7` / `147-7=140` 两行，(2) 含 `367+26=393` / `494-393=101` 两行），
   题内多行用换行表示、渲染成 `<br>`。四条各成一题会把一个小题拆开（用户反馈「综合算式题被拆开了」）。
   库内现状是本脚本跑完后再由 `tools/fix_20261001_rev2.py` 合并过的形态
   （本卷 14 题：2 综合算式 + 6 选择 + 6 填空，`no` 已重排）。**重跑本脚本会退回旧形态。**
  「5. 列式计算。」本页只有标题、无小题内容，未入库（见汇报）。

⚠️ 题4「写出综合算式」的切分（2026-10-01 用户反馈后修订，**推翻了原来的合并规则**）：
  原卷版式是 **2 行 2 列**——(1)(2) 两个小题各占一列，每列两行已知算式、下方一条答题横线：
        (1) 63÷9=7            (2) 367+26=393
            147-7=140             494-393=101
            ─────────────          ─────────────
  用户要求「四个算式各自成题」（原来按「小题不自足→合并」把四行压成了一题一段文字，
  版式信息全丢了，卷面上也就没有答题空间）。因此**四条算式各成一道 `solve`**，
  共享的指令「写出综合算式。」作为板块名保留在 `section` 里、由组卷时的大题标题承载，
  不再重复写进每条 stem。组卷时用 2 列网格还原成 2 行 2 列（见 engine/paper.py 的 style="eq"）。
  题号顺延：原 002-013 → 005-016（四个算式占 001-004）。

坐标全部来自行/列投影分析（详见 prompts/recognition-spec.md「裁剪定位方法」）。
⚠️ 本卷的新情况（上一卷没遇到）：**选择题的选项行是顶格的**，比题号还靠左。
   实测选项行「A.」起点 x≈164-171，而题号「(1)」在 178-216、正文在 223-231（首行有缩进）。
   若照旧取「题号末像素+1」（≈211），选项行会被切掉「A. xxx」→ 内容缺失（首轮已复现）。
   因此**选择题的左边界随内容取到 163-169**，卷面题号完整保留在裁剪图内（唯一可行的取舍：
   题号留在图里只是观感问题，选项被切是内容错误）。填空题无顶格续行，仍按题号末+1 剔除。

关键测量（x 轴，1px 精度，来自逐列墨迹图案）：
  选1   「(1)」=178-210   正文 225  选项行起点 164      -> 取 163（保住选项 A）
  选2   「(2)」=180-210   正文 225  选项行起点 165      -> 取 163
  选3   「(3)」=178-210   正文 223  续行 167 / 选项 166 -> 取 164
  选4   「(4)」=180-212   正文 227  续行 216 / 选项 168 -> 取 164
  选5   「(5)」=184-216   正文 230  选项行起点 170      -> 取 168
  选6   「(6)」=184-216   正文 231  选项行起点 171      -> 取 169
  填1   「(1)」=187-219   正文 233                    -> 取 220
  填2   「(2)」=188-219   正文 234                    -> 取 220
  填3   「(3)」=187-222（红圈 185-223）正文 229        -> 取 224
  填4   「(4)」=189-221   正文 236                    -> 取 222
  填5   「(5)」=190-222   正文 236                    -> 取 223
  填6   「(6)」=192-224   正文 238                    -> 取 225

题4 四条算式的精确墨迹盒（y 轴，自适应二值 a < blur(14) - 28，gap=3）：
  左列 行1「63÷9=7」    y116-137 (h22)  x278-400    题号「(1)」x215-258 —— 窗口从 x272 起，剔掉题号
  右列 行1「367+26=393」 y119-142 (h24)  x776-952    题号「(2)」x715-758 —— 窗口从 x770 起
  左列 行2「147-7=140」  y168-190 (h23)  x279-446
  右列 行2「494-393=101」y171-193 (h23)  x774-966
  （作答横线 y242-251 不进裁剪；组卷时用 CSS 画。
    注意左右两列同一行纵向差 3px —— 扫描件倾斜，这正是「逐列做行带」的原因。）
"""
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(r"D:\workspace\ai\shijuan")
SRC = Path(r"C:\Users\1\.workbuddy\clipboard-images\clipboard-2026-09-30T16-05-20-113Z-410b87c7.jpg")
BENCH_NAME = "2026-10-01-乘法综合练习.jpg"
CN = timezone(timedelta(hours=8))
NOW = datetime.now(CN).isoformat(timespec="seconds")

PAD = 8
FIG_PAD = 6

SEC_CHOICE = "第二部分 概念 · 1、选择题"
SEC_FILL = "第二部分 概念 · 2、填空题"
SEC_CALC = "4. 写出综合算式"

# (id, no, section, type, stem, options, window[x0,y0,x1,y1], printed_no, conf,
#  figure(窗口或 None), [可选] pad_left)
#   pad_left 省略 = 0：窗口左侧已切掉卷面题号，不留白；
#   给 PAD：窗口左侧本来就是留白（无题号可剔），四边一致留白。
ITEMS = [
    # ---- 4. 写出综合算式：四个算式各自成题（原件的 2 行 2 列由组卷时还原）
    (
        "q-20261001-001", 1, SEC_CALC, "solve",
        [{"t": "text", "v": "63÷9=7"}],
        [], [272, 110, 412, 148], "(1)",
        {"stem": 0.97, "options": None, "figure": None}, None, PAD,
    ),
    (
        "q-20261001-002", 2, SEC_CALC, "solve",
        [{"t": "text", "v": "367+26=393"}],
        [], [770, 112, 962, 150], "(2)",
        {"stem": 0.97, "options": None, "figure": None}, None, PAD,
    ),
    (
        "q-20261001-003", 3, SEC_CALC, "solve",
        [{"t": "text", "v": "147-7=140"}],
        [], [272, 162, 456, 198], "",
        {"stem": 0.97, "options": None, "figure": None}, None, PAD,
    ),
    (
        "q-20261001-004", 4, SEC_CALC, "solve",
        [{"t": "text", "v": "494-393=101"}],
        [], [766, 165, 978, 200], "",
        {"stem": 0.97, "options": None, "figure": None}, None, PAD,
    ),
    # ---- 第二部分 概念
    (
        "q-20261001-005", 5, SEC_CHOICE, "choice",
        [{"t": "text", "v": "计算 268×3 时，百位上的“2”乘“3”的积是（　　）。"}],
        [{"t": "text", "v": "6"}, {"t": "text", "v": "60"},
         {"t": "text", "v": "600"}, {"t": "text", "v": "804"}],
        [163, 508, 1050, 600], "(1)",
        {"stem": 0.97, "options": 0.97, "figure": None}, None,
    ),
    (
        "q-20261001-006", 6, SEC_CHOICE, "choice",
        [{"t": "text", "v": "估算下面算式中积最大的是（　　）。"}],
        [{"t": "latex", "v": "268\\times4"}, {"t": "latex", "v": "102\\times8"},
         {"t": "latex", "v": "399\\times6"}, {"t": "latex", "v": "799\\times1"}],
        [163, 606, 1050, 692], "(2)",
        {"stem": 0.97, "options": 0.97, "figure": None}, None,
    ),
    (
        "q-20261001-007", 7, SEC_CHOICE, "choice",
        [{"t": "text", "v": "一本书有 286 页，乐乐第一天看了 97 页，第二天看了 104 页，"
                            "第三天应该从第（　　）页开始看。"}],
        [{"t": "text", "v": "85"}, {"t": "text", "v": "86"},
         {"t": "text", "v": "202"}, {"t": "text", "v": "201"}],
        [164, 700, 1050, 832], "(3)",
        {"stem": 0.97, "options": 0.97, "figure": None}, None,
    ),
    (
        "q-20261001-008", 8, SEC_CHOICE, "choice",
        [
            {"t": "text", "v": "妈妈买了 24 个石榴，每个石榴 4 元。下面用竖式计算出了 24 个石榴的总价，"
                                "框住的这一步的结果表示的是（　　）。"},
            {"t": "figure", "state": "crop", "src": "q-20261001-008-fig1.jpg",
             "bbox": None, "expr": None, "geometry": None, "confidence": 0.95},
        ],
        [{"t": "text", "v": "2 个石榴的价钱"}, {"t": "text", "v": "4 个石榴的价钱"},
         {"t": "text", "v": "20 个石榴的价钱"}, {"t": "text", "v": "24 个石榴的价钱"}],
        [164, 838, 1050, 1127], "(4)",
        {"stem": 0.97, "options": 0.97, "figure": 0.95}, [760, 915, 1030, 1140],
    ),
    (
        "q-20261001-009", 9, SEC_CHOICE, "choice",
        [{"t": "text", "v": "8×70□，积的末尾不可能（　　）。"}],
        [{"t": "text", "v": "没有 0"}, {"t": "text", "v": "有 1 个 0"},
         {"t": "text", "v": "有 2 个 0"}, {"t": "text", "v": "有 3 个 0"}],
        [168, 1128, 1050, 1218], "(5)",
        {"stem": 0.97, "options": 0.97, "figure": None}, None,
    ),
    (
        "q-20261001-010", 10, SEC_CHOICE, "choice",
        [{"t": "text", "v": "7×5□6，积可能是（　　）。"}],
        [{"t": "text", "v": "3042"}, {"t": "text", "v": "3648"},
         {"t": "text", "v": "3752"}, {"t": "text", "v": "3502"}],
        [169, 1222, 1050, 1302], "(6)",
        {"stem": 0.97, "options": 0.97, "figure": None}, None,
    ),
    (
        "q-20261001-011", 11, SEC_FILL, "fill",
        [{"t": "text", "v": "250×4 的积的末尾有____个 0。"}],
        [], [220, 1360, 1050, 1404], "(1)",
        {"stem": 0.97, "options": None, "figure": None}, None,
    ),
    (
        "q-20261001-012", 12, SEC_FILL, "fill",
        [{"t": "text", "v": "238×□<1000，□里最大可以填____。"}],
        [], [220, 1406, 1050, 1450], "(2)",
        {"stem": 0.97, "options": None, "figure": None}, None,
    ),
    (
        "q-20261001-013", 13, SEC_FILL, "fill",
        [{"t": "text", "v": "东东家距离学校 305 米，他每天往返于学校和家两次，一共要走____米。"}],
        [], [224, 1452, 1050, 1510], "(3)",
        {"stem": 0.97, "options": None, "figure": None}, None,
    ),
    (
        "q-20261001-014", 14, SEC_FILL, "fill",
        [{"t": "text", "v": "如果□=5，△=6，☆=7，那么□×10×☆+△=____。"}],
        [], [222, 1509, 1050, 1545], "(4)",
        {"stem": 0.97, "options": None, "figure": None}, None,
    ),
    (
        "q-20261001-015", 15, SEC_FILL, "fill",
        [
            {"t": "text", "v": "幼儿园准备买 5 台微波炉，请你估一估，大约要花____元。"},
            {"t": "figure", "state": "crop", "src": "q-20261001-015-fig1.jpg",
             "bbox": None, "expr": None, "geometry": None, "confidence": 0.95},
        ],
        [], [223, 1552, 1050, 1720], "(5)",
        {"stem": 0.97, "options": None, "figure": 0.95}, [400, 1595, 830, 1725],
    ),
    (
        "q-20261001-016", 16, SEC_FILL, "fill",
        [{"t": "text", "v": "计算 6×432，“6”和百位上“4”相乘的积是____百。"}],
        [], [225, 1735, 1050, 1815], "(6)",
        {"stem": 0.97, "options": None, "figure": None}, None,
    ),
]

# 裁剪边界复核说明（自检告警经人工核对后的结论，写进 source.review_note）
NOTE_INDENT = "左边界紧邻已剔除的卷面题号，题面完整"
NOTE_FLUSH = ("选项行顶格（起点 x≈164-171，比题号 178-216 更靠左），左边界随内容取，"
              "卷面题号完整保留在裁剪图内——取「题号末+1」会切掉选项 A")
NOTE_EQ = ("本题是「写出综合算式」四条算式之一（原为 (1)(2) 两列、每列两行），"
           "题号「(1)(2)」在窗口外已剔除；四边均留 8px 白，无切字")
NOTE = {
    "q-20261001-001": NOTE_EQ, "q-20261001-002": NOTE_EQ,
    "q-20261001-003": NOTE_EQ, "q-20261001-004": NOTE_EQ,
    "q-20261001-005": NOTE_FLUSH, "q-20261001-006": NOTE_FLUSH,
    "q-20261001-007": NOTE_FLUSH, "q-20261001-008": NOTE_FLUSH,
    "q-20261001-009": NOTE_FLUSH, "q-20261001-010": NOTE_FLUSH,
}

# 改名/重跑后会被遗弃的旧文件（新题号下已不存在同名产物）
STALE = ["q-20261001-005-fig1.jpg", "q-20261001-012-fig1.jpg"]


def ink_mask(im: Image.Image) -> np.ndarray:
    g = np.asarray(im.convert("L")).astype(np.int16)
    blur = np.asarray(im.convert("L").filter(ImageFilter.GaussianBlur(14))).astype(np.int16)
    return g < (blur - 28)


def fit(ink: np.ndarray, win, pad=PAD, pad_left=0):
    """窗口内取墨迹最小外接矩形 + 留白。

    pad_left=0 用于「窗口左侧刚剔掉卷面题号」的题：那侧不留白，题面正好顶边；
    左侧本就是留白的题（如题4 的四个算式）传 pad_left=PAD，四边一致。
    """
    x0, y0, x1, y1 = win
    sub = ink[y0:y1, x0:x1]
    ys, xs = np.where(sub)
    if len(ys) == 0:
        return None
    return [int(x0 + xs.min()) - pad_left, int(y0 + ys.min()) - pad,
            int(x0 + xs.max()) + 1 + pad, int(y0 + ys.max()) + 1 + pad]


def main() -> None:
    (ROOT / "data" / "benchmark").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "crops").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "questions").mkdir(parents=True, exist_ok=True)

    # 清理上一轮遗留的产物（题号重排后原图子图已随题改号）
    for name in STALE:
        p = ROOT / "data" / "crops" / name
        if p.exists():
            p.unlink()
            print(f"清理旧产物 {name}")

    dst = ROOT / "data" / "benchmark" / BENCH_NAME
    shutil.copy2(SRC, dst)
    im = Image.open(SRC).convert("RGB")
    ink = ink_mask(im)
    print("原图", im.size, "->", dst.name)

    crops = []
    for item in ITEMS:
        qid, no, section, qtype, stem, options, win, printed_no, conf, fig_win = item[:10]
        pad_left = item[10] if len(item) > 10 else 0
        bbox = fit(ink, win, pad_left=pad_left)
        assert bbox, f"{qid} 窗口内无墨迹"
        crop_name = f"{qid}.jpg"
        im.crop(tuple(bbox)).save(ROOT / "data" / "crops" / crop_name, quality=95)

        if fig_win:
            fbox = fit(ink, fig_win, pad=FIG_PAD)
            fig_name = f"{qid}-fig1.jpg"
            im.crop(tuple(fbox)).save(ROOT / "data" / "crops" / fig_name, quality=95)
            for seg in stem:
                if seg.get("t") == "figure":
                    seg["src"] = fig_name
                    seg["bbox"] = fbox
            print(f"   {qid} 插图 {fig_name} bbox={fbox}")

        data = {
            "schema_version": 2,
            "id": qid,
            "no": no,
            "section": section,
            "type": qtype,
            "stem": stem,
            "options": options,
            "source": {
                "file": BENCH_NAME,
                "page": 1,
                "bbox": bbox,
                "crop": crop_name,
                "printed_no": printed_no,
                "crop_reviewed": True,
                "review_note": NOTE.get(qid, NOTE_INDENT),
            },
            "confidence": conf,
            "created_at": NOW,
            "updated_at": NOW,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        crops.append((qid, no, im.crop(tuple(bbox))))
        print(f"{qid} 第{no}题 {section[:12]}..{qtype}  bbox={bbox}  {bbox[2]-bbox[0]}x{bbox[3]-bbox[1]}")

    # 校验图（目视复核用）
    CW = 720
    rows = []
    for qid, no, c in crops:
        f = CW / c.width
        rows.append((qid, no, c.resize((CW, max(1, int(c.height * f))))))
    H = sum(r[2].height + 34 for r in rows) + 10
    sheet = Image.new("RGB", (CW + 16, H), "#ffffff")
    dr = ImageDraw.Draw(sheet)
    y = 6
    for qid, no, c in rows:
        dr.text((8, y + 8), f"{qid}  #{no}", fill=(200, 0, 0))
        y += 30
        sheet.paste(c, (8, y))
        dr.rectangle([7, y - 1, 8 + c.width, y + c.height], outline=(0, 150, 0))
        y += c.height + 4
    out = ROOT / "data" / "samples" / "_crops_check_p5.jpg"
    sheet.save(out, quality=90)
    print("校验图 ->", out.name, sheet.size)


if __name__ == "__main__":
    main()
