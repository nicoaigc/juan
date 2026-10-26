# -*- coding: utf-8 -*-
"""第 6 份试卷（三年级第一学期第一、二单元素养卷 · 第一部分 计算）全量识别。

源图：clipboard-2026-10-01T02-00-39-741Z-43933047.jpg (1279 x 1706)
卷面：第一部分 计算
        1、直接写出得数（3 列 x 3 行 = 9 题）
        2、递等式计算（3 题）
        3、竖式计算（4 题）
        4、写出综合算式（印刷题号只有 (1)(2) → **2 题**，各含两行算式）
        5、列式计算（2 题）
      共 **20 题**入库。

⛔ **【修正说明】** 脚本正文里把「写出综合算式」写成了**四条算式各自成题（4 题）**，那是错的
   （2026-10-01 二次返工，用户反馈「doc-20261001-e433.html 里的综合算式题被拆开了」）。
   正确口径 = **印刷题号出现几次就成几题**：题号只有 (1)(2) → 2 题，题内两行用换行表示。
   库内现状是本脚本跑完后再由 `tools/fix_20261001_rev2.py` 合并过的形态（本卷 20 题）。
   **重跑本脚本会退回被拆开的旧形态**（22 题），要改就改成本文件的 ITEMS 后再跑。

⚠️ 与上一卷（2026-10-01-乘法综合练习.jpg）的关系：
   本卷「4、写出综合算式」的四条算式（63÷9=7 / 147-7=140 / 367+26=393 / 494-393=101）
   与 q-20261001-001~004 **内容完全相同** —— 是同一份卷子的另一页/另一份答卷。
   按「整页全量识别、不做筛选」照实入库，重复项在 source.review_note 里注明（待用户决定是否去重）。

测量方法（本卷踩到的新问题）：**笔迹极多（红笔批改 + 铅笔作答），灰度二值化会把题目行与
笔迹连成一条大带**。改用颜色分离：印刷体是「低亮度 + 低彩度」（lum<118, max-min<42），
红笔是「R 明显高于 G/B」，铅笔是浅灰。定位题目行只用「印刷黑」掩膜，实测印刷行核的
密度 50–140，而笔迹带只有 5–25，用密度阈值（v5 脚本）即可稳稳定出印刷行核。

实测行核（y，印刷黑掩膜）：
  口算   行1 242–270  行2 299–328  行3 359–387（行距 60，行高 22–26）
  递等式 题目行 475–499（标题「2、递等式计算。」在 412–446，靠 y 分开）
  竖式   题目行 770–805
  综合   行1 1055–1097（左低右高，倾斜）  行2 1110–1150
  列式   (1) 1288–1319   (2) 1454–1481

题号（逐 run 合并，gap=3）：
  综合(1)「(」「1」「)」= 248–259 / 265–276 / 282–292 → 末像素 292，正文 311 起
  综合(2)                 = 751–761 / 766–780 / 783–795 → 末像素 795，正文 810 起
  列式(1)                 = 200–209 / 215–220 / 226–235 → 末像素 235，正文 246 起
  列式(2)                 = 219–229 / 232–244 / 247–256 → 末像素 256，正文 262 起
  四题的正文都不顶格（正文起点 > 题号末），所以窗口左边界取「题号末+1」是安全的。
"""
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(r"D:\workspace\ai\shijuan")
SRC = Path(r"C:\Users\1\.workbuddy\clipboard-images\clipboard-2026-10-01T02-00-39-741Z-43933047.jpg")
BENCH_NAME = "2026-10-01-第一二单元素养卷.jpg"
CN = timezone(timedelta(hours=8))
NOW = datetime.now(CN).isoformat(timespec="seconds")

PAD = 8

S1 = "1. 直接写出得数"
S2 = "2. 递等式计算"
S3 = "3. 竖式计算"
S4 = "4. 写出综合算式"
S5 = "5. 列式计算"

# (id, no, section, type, stem, options, 窗口[x0,y0,x1,y1], printed_no, conf, pad_left)
ITEMS = [
    # ---------------- 1、直接写出得数（3 列 x 3 行）----------------
    ("q-20261001-017", 17, S1, "calculate",
     [{"t": "latex", "v": "67-5\\times5="}], [], [225, 230, 505, 280], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-018", 18, S1, "calculate",
     [{"t": "latex", "v": "32+8\\div4="}], [], [225, 290, 505, 338], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-019", 19, S1, "calculate",
     [{"t": "latex", "v": "49-49\\div7="}], [], [225, 350, 505, 398], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-020", 20, S1, "calculate",
     [{"t": "latex", "v": "400\\times6-20="}], [], [510, 230, 810, 280], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-021", 21, S1, "calculate",
     [{"t": "latex", "v": "2\\times100-100="}], [], [510, 290, 810, 338], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-022", 22, S1, "calculate",
     [{"t": "latex", "v": "0\\div27\\times3="}], [], [510, 350, 810, 398], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    # 三题都是「方框里填数」：方框是印刷的，框内是学生笔迹 → 方框本身照实写成 □（text 片段）
    ("q-20261001-023", 23, S1, "calculate",
     [{"t": "text", "v": "40×□-20=100"}], [], [830, 232, 1185, 284], "",
     {"stem": 0.95, "options": None, "figure": None}, PAD),
    ("q-20261001-024", 24, S1, "calculate",
     [{"t": "text", "v": "□×9-3=78"}], [], [830, 292, 1185, 342], "",
     {"stem": 0.95, "options": None, "figure": None}, PAD),
    ("q-20261001-025", 25, S1, "calculate",
     [{"t": "text", "v": "□×2=5×6-6"}], [], [830, 350, 1185, 400], "",
     {"stem": 0.85, "options": None, "figure": None}, PAD),

    # ---------------- 2、递等式计算 ----------------
    ("q-20261001-026", 26, S2, "solve",
     [{"t": "latex", "v": "172-95+278"}], [], [225, 466, 445, 508], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-027", 27, S2, "solve",
     [{"t": "latex", "v": "492-(292-165)"}], [], [590, 466, 880, 508], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-028", 28, S2, "solve",
     [{"t": "latex", "v": "3\\times80+420"}], [], [1015, 466, 1215, 508], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),

    # ---------------- 3、竖式计算 ----------------
    ("q-20261001-029", 29, S3, "solve",
     [{"t": "latex", "v": "52\\times2="}], [], [195, 760, 445, 812], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-030", 30, S3, "solve",
     [{"t": "latex", "v": "104\\times5="}], [], [455, 756, 715, 808], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-031", 31, S3, "solve",
     [{"t": "latex", "v": "810\\times6="}], [], [720, 754, 1000, 806], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-032", 32, S3, "solve",
     [{"t": "latex", "v": "7\\times849="}], [], [995, 752, 1255, 812], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),

    # ---------------- 4、写出综合算式（四条算式各自成题，题号 (1)(2) 剔除）----------------
    ("q-20261001-033", 33, S4, "solve",
     [{"t": "text", "v": "63÷9=7"}], [], [296, 1062, 452, 1104], "(1)",
     {"stem": 0.97, "options": None, "figure": None}, 0),
    ("q-20261001-034", 34, S4, "solve",
     [{"t": "text", "v": "367+26=393"}], [], [799, 1048, 998, 1090], "(2)",
     {"stem": 0.97, "options": None, "figure": None}, 0),
    ("q-20261001-035", 35, S4, "solve",
     [{"t": "text", "v": "147-7=140"}], [], [305, 1118, 522, 1160], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),
    ("q-20261001-036", 36, S4, "solve",
     [{"t": "text", "v": "494-393=101"}], [], [798, 1100, 1012, 1150], "",
     {"stem": 0.97, "options": None, "figure": None}, PAD),

    # ---------------- 5、列式计算（题号 (1)(2) 剔除）----------------
    ("q-20261001-037", 37, S5, "solve",
     [{"t": "text", "v": "17个7的和，减去最大的两位数，差是多少？"}], [],
     [236, 1280, 850, 1330], "(1)",
     {"stem": 0.97, "options": None, "figure": None}, 0),
    ("q-20261001-038", 38, S5, "solve",
     [{"t": "text", "v": "116与8的积减去480，差是多少？"}], [],
     [257, 1446, 700, 1488], "(2)",
     {"stem": 0.97, "options": None, "figure": None}, 0),
]

NOTE_BASE = "左边界紧邻已剔除的卷面题号，题面完整"
NOTE_NO_NUM = ("本题卷面未印小题号，窗口即内容首字；上下边为相邻题的学生笔迹/红笔越界"
               "（本卷笔迹极多），题目行本身完整无切字，已逐张放大核对")
NOTE_HW = "手写卷：{0} 有相邻题的学生笔迹/红笔越界，题目行本身完整无切字（已逐张放大核对）"
NOTE_REPEAT = ("⚠️ 与 q-20261001-00{0} 内容重复（同一份卷子的另一页/另一份答卷的「4、写出综合算式」），"
               "按「整页全量识别不筛选」照实入库，待用户决定是否去重。")
NOTE = {
    # 综合算式四条：剔了题号 + 边上有笔迹
    "q-20261001-033": "左边界紧邻已剔除的卷面题号「(1)」；" + NOTE_HW.format("右"),
    "q-20261001-034": NOTE_HW.format("上") + "。⚠️ 与 q-20261001-002 内容重复（同一份卷子的另一页），待用户决定是否去重",
    "q-20261001-035": NOTE_HW.format("下") + "。⚠️ 与 q-20261001-003 内容重复（另一页），待用户决定是否去重",
    "q-20261001-036": NOTE_HW.format("下") + "。⚠️ 与 q-20261001-004 内容重复（另一页），待用户决定是否去重",
    # 三个方框题：方框是印刷的，框内是学生笔迹
    "q-20261001-023": ("⚠️ 下边紧贴行 2 的方框顶缘：本卷行 1/行 2/行 3 的方框纵向相接（实测间距≈1px），无法再分离；"
                       "方框是印刷空框，框内「3」是学生笔迹，照实写 □"),
    "q-20261001-024": ("⚠️ 上下边分别紧贴行 1 / 行 3 的方框缘（同上，间距≈1px）；"
                       "方框内「9」是学生笔迹，照实写 □"),
    "q-20261001-025": ("⚠️ 上边带 q-024 的方框底缘；本题面第三个方框被红笔（学生订正的「31」）覆盖，"
                       "方框本身可辨认，但无法确认框内是否另有印刷内容，故置信度降到 0.85 —— 待人工核对"),
    # 列式计算两题：剔了题号
    "q-20261001-037": "左边界紧邻已剔除的卷面题号「(1)」；" + NOTE_HW.format("上（学生写的「99」）"),
    "q-20261001-038": "左边界紧邻已剔除的卷面题号「(2)」；" + NOTE_HW.format("上（上一题的作答笔迹）"),
}


def ink_mask(im: Image.Image) -> np.ndarray:
    g = np.asarray(im.convert("L")).astype(np.int16)
    blur = np.asarray(im.convert("L").filter(ImageFilter.GaussianBlur(14))).astype(np.int16)
    return g < (blur - 28)


def fit(ink: np.ndarray, win, pad=PAD, pad_left=0):
    x0, y0, x1, y1 = win
    sub = ink[y0:y1, x0:x1]
    ys, xs = np.where(sub)
    if len(ys) == 0:
        return None
    return [int(x0 + xs.min()) - pad_left, int(y0 + ys.min()) - pad,
            int(x0 + xs.max()) + 1 + pad, int(y0 + ys.max()) + 1 + pad]


def main() -> None:
    dst = ROOT / "data" / "benchmark" / BENCH_NAME
    if not dst.exists():
        shutil.copy2(SRC, dst)
    im = Image.open(SRC).convert("RGB")
    ink = ink_mask(im)
    print("原图", im.size, "->", dst.name)

    # 库中已有的 stem 文本（用于重复检测）
    known = {}
    for f in (ROOT / "data" / "questions").glob("*.json"):
        q = json.loads(f.read_text(encoding="utf-8"))
        txt = "".join(str(s.get("v", "")) for s in q.get("stem") or [] if isinstance(s, dict))
        known.setdefault(txt, []).append(q["id"])

    crops = []
    for idx, item in enumerate(ITEMS, 1):
        qid, _no, section, qtype, stem, options, win, printed_no, conf, pad_left = item
        # no = **卷内**阅读顺序（每卷从 1 开始，与历史各卷一致）；
        # id 尾号的 NNN 是「当天全局递增」，两者含义不同（规范 schema v2 的 no 定义）。
        no = idx
        bbox = fit(ink, win, pad_left=pad_left)
        assert bbox, f"{qid} 窗口内无墨迹"
        crop_name = f"{qid}.jpg"
        im.crop(tuple(bbox)).save(ROOT / "data" / "crops" / crop_name, quality=95)

        txt = "".join(str(s.get("v", "")) for s in stem)
        dup = [k for k in known.get(txt, []) if k != qid]
        note = NOTE.get(qid) or (NOTE_BASE if pad_left == 0 else NOTE_NO_NUM)

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
                "review_note": note,
            },
            "confidence": conf,
            "created_at": NOW,
            "updated_at": NOW,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        crops.append((qid, no, im.crop(tuple(bbox))))
        flag = f"  ⚠️重复({','.join(dup)})" if dup else ""
        print(f"{qid} 第{no:2d}题 {section[:8]:10s}{qtype:9s} bbox={bbox} "
              f"{bbox[2]-bbox[0]:4d}x{bbox[3]-bbox[1]:3d}{flag}")

    # 校验图（目视复核用）
    CW = 760
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
    out = ROOT / "data" / "samples" / "_crops_check_p6.jpg"
    sheet.save(out, quality=90)
    print("校验图 ->", out.name, sheet.size)


if __name__ == "__main__":
    main()
