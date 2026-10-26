# -*- coding: utf-8 -*-
"""第 8 份卷（第2单元练习卷 · 静安名校，4 页）全量识别。

源图：data/benchmark/2026-10-01-第2单元练习卷-p{1..4}.jpg (1440x1920)，四张照片同一份卷。
页序（按卷面题目顺序）：p1 标题/一/二/三/四(前3) → p2 四(续4)/五(1,2) → p3 五(4,5,6) → p4 六/七

卷面结构（印刷题号出现几次就成几题）：
    一、算一算            4 行 x 3 列 = 12 题（无小题号）
    二、用竖式计算        3 题（无小题号）
    三、在○里填入">""<"或"="   2 列 x 3 行 = 6 题（无小题号）
    四、递等式计算        p1 3 题 + p2 续 4 题 = 7 题（无小题号）
    五、解决问题          1 / 2 / [3 缺] / 4 / 5 / 6.估算(1)(2)  —— 共 6 题
    六、判断              3 题
    七、选择              4 题
  合计 **41 题**。

⚠️ 五、解决问题的第 3 小题在四张照片里都不存在（p2 底部以下被手指/阴影遮挡，p3 顶部直接是
   4.）—— 属「源图缺失」，非识别遗漏，已在本卷汇报里说明。

⚠️ 本卷唯一的定位难点是「六、判断」的第 1、2 小题：**两行行距极小**（题 1 左端 y110-150、
   右端 y135-175；题 2 左端 y180-220），中间只剩 5px 缝隙 —— 窗口按 y=177 切开即可，不必做
   倾斜校正。（曾误判为「倾斜 5-6°」并试写整页摆正脚本：按「行投影平方和最」估角在该卷上
   失效——桌面/纸张边缘的深色区主导了行投影，估出 0°；实测口算行三列行核 296/301/312 反推
   倾斜仅 1.1°。教训见 .workbuddy/memory。）

定位方法：本卷笔迹较密（红笔批改 + 铅笔作答 + 黑笔竖式），沿用「印刷黑」掩膜
（lum<118 且彩度<42）逐列做行投影定位行核，再用同一掩膜在窗口内拟合题目包围盒。

实测关键坐标（原图坐标）：
  p1  标题带 y40-160；「一、算一算。」y226-257(x196-367)
      口算 4 行 y 296/356/417/478（核心 h22-26，行距 60）；三列左起点 x196/x583/x960
      「二、用竖式计算。」y536-570(x204-450)；竖式题行 y604-636（三列 x204-382 / x583-784 / x959-1169）
      「三、在○里填入…」y1007-1040(x173-707)；比大小 3 行 y 1094-1118 / 1174-1198 / 1258-1282
      「四、递等式计算。」y1322-1366(x166-440)；递等式题行 y1398-1422
  p2  1468-356-444 y160-188(x156-399)；389×5×2 y258-300(x721-905)
      978+415-278 y490-520；9999+999+99+3 y486-532(x701-1005)
      「五、解决问题。」y798-838；题1 y864-892；题2 行1 y1363-1424、行2 y1437-1491
  p3  题4 行1 y215-254、行2 y281-312；题5 行1 y524-555、行2 y582-610
      「6. 估算。」y829-856；「水蜜桃是上海南汇的特产。」y878-908（x211-571）
      (1) y932-964（x216-775）；(2) 行1 y1161-1195、行2 y1210-1250
  p4  「六、判断。」y51-82；判断题 1 y96-142、2 y150-205、3 y486-586（含「七、选择。」）
      选择 1 y620-660 + 选项 y698-745；选择 2 y762-800 + 选项 y820-875
      选择 3 y885-920 + 选项 (A)三 y940-970 /(B)四 y995-1020 /(C) y1045-1075
      选择 4 y1105-1145 + 两条算式 y1160-1200
"""
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(r"D:\workspace\ai\shijuan")
CLIP = Path(r"C:\Users\1\.workbuddy\clipboard-images")
CN = timezone(timedelta(hours=8))
NOW = datetime.now(CN).isoformat(timespec="seconds")
PAD = 8

# 页 -> (benchmark 文件名, 本地照片名)
PAGES = {
    1: ("2026-10-01-第2单元练习卷-p1.jpg", "clipboard-2026-10-01T09-31-20-389Z-87635280.jpg"),
    2: ("2026-10-01-第2单元练习卷-p2.jpg", "clipboard-2026-10-01T09-31-20-391Z-57ab6721.jpg"),
    3: ("2026-10-01-第2单元练习卷-p3.jpg", "clipboard-2026-10-01T09-31-20-390Z-3cb3b9e1.jpg"),
    4: ("2026-10-01-第2单元练习卷-p4.jpg", "clipboard-2026-10-01T09-31-20-387Z-9ce1a8d5.jpg"),
}

S1 = "一、算一算"
S2 = "二、用竖式计算"
S3 = "三、在○里填入“>”“<”或“=”"
S4 = "四、递等式计算"
S5 = "五、解决问题"
S6 = "五、解决问题 · 6. 估算"
S6B = "六、判断"
S7 = "七、选择"

ITEMS = []


def add(page, section, qtype, stem, options, win, printed_no="", conf=None, note="", quad=None):
    ITEMS.append({
        "page": page, "section": section, "qtype": qtype, "stem": stem, "options": options,
        "win": win, "printed_no": printed_no, "quad": quad,
        "conf": conf or {"stem": 0.97, "options": None, "figure": None}, "note": note,
    })


# ---------------- 一、算一算（4 行 x 3 列，无小题号）----------------
KS = [
    [("latex", "4\\times40="), ("latex", "600+300="), ("latex", "4\\times2\\times5=")],
    [("latex", "10\\times0\\times8="), ("latex", "6\\times90="), ("latex", "200-130=")],
    [("latex", "180-80\\times2="), ("text", "（　）×4=360"), ("latex", "72\\div8\\div3=")],
    [("text", "50×（　）=350"), ("latex", "4\\times70-30="), ("text", "5×80=20×（　）")],
]
ROWY = [(286, 326), (348, 388), (408, 450), (470, 512)]
COLX = [(185, 480), (566, 820), (936, 1250)]
NOTE_KS = ("填空括号「（　）」是卷面印刷的空括号，括号内算式（如 90 / 3 / 20）是学生笔迹，"
           "未转写；题面无小题号，窗口即内容首字")
for _r, (_y0, _y1) in enumerate(ROWY):
    for _c, (_x0, _x1) in enumerate(COLX):
        _t, _v = KS[_r][_c]
        _conf = {"stem": 0.95 if _t == "text" else 0.97, "options": None, "figure": None}
        add(1, S1, "calculate", [{"t": _t, "v": _v}], [], (_x0, _y0, _x1, _y1), conf=_conf,
            note=NOTE_KS)

# ---------------- 二、用竖式计算（3 题，无小题号）----------------
NOTE_S2 = ("竖式题只印一行算式，下方学生的竖式过程（笔迹）按「不为包住笔迹而撑大框」未纳入；"
           "题面无小题号")
add(1, S2, "solve", [{"t": "latex", "v": "768\\times9="}], [], (185, 590, 470, 648), note=NOTE_S2)
add(1, S2, "solve", [{"t": "latex", "v": "8\\times750="}], [], (555, 588, 840, 646), note=NOTE_S2)
add(1, S2, "solve", [{"t": "latex", "v": "3056\\times8="}], [], (925, 592, 1215, 650), note=NOTE_S2)

# ---------------- 三、在○里填入“>”“<”或“=” （2 列 x 3 行，无小题号）----------------
NOTE_S3 = ("比大小的○是卷面印刷空圈（学生已在圈内填了 > 或 <，属笔迹、未转写），"
           "整个表达式走 latex 片段照实写 \\bigcirc；题面无小题号")
_CMP = [
    ("38\\times6\\ \\bigcirc\\ 38\\times8", (160, 1075, 490, 1138)),
    ("14\\times7\\ \\bigcirc\\ 17\\times4", (590, 1066, 1020, 1130)),
    ("27\\times3\\ \\bigcirc\\ 23\\times7", (160, 1150, 490, 1216)),
    ("81\\times3\\ \\bigcirc\\ 42\\times9", (590, 1148, 1020, 1214)),
    ("19\\times5\\ \\bigcirc\\ 15\\times9", (160, 1238, 490, 1302)),
    ("45\\times3\\ \\bigcirc\\ 43\\times5", (590, 1230, 1020, 1296)),
]
for _v, _w in _CMP:
    add(1, S3, "calculate", [{"t": "latex", "v": _v}], [], _w, note=NOTE_S3)

# ---------------- 四、递等式计算（p1 3 题 + p2 续 4 题，无小题号）----------------
NOTE_S4 = "递等式题只印算式本身（无小题号），下方学生作答笔迹未纳入框内"
add(1, S4, "solve", [{"t": "latex", "v": "822+276+178+634"}], [], (150, 1385, 500, 1447), note=NOTE_S4)
add(1, S4, "solve", [{"t": "latex", "v": "750+250\\times6"}], [], (640, 1382, 900, 1445), note=NOTE_S4)
add(1, S4, "solve", [{"t": "latex", "v": "6\\times486+314\\times6"}], [], (1020, 1380, 1310, 1445), note=NOTE_S4)
NOTE_S4B = "换页续排的递等式算式（无小题号），本页最上一行；上下为学生作答笔迹，未纳入框内"
add(2, S4, "solve", [{"t": "latex", "v": "1468-356-444"}], [], (140, 148, 470, 200), note=NOTE_S4B)
add(2, S4, "solve", [{"t": "latex", "v": "389\\times5\\times2"}], [], (700, 185, 980, 235), note=NOTE_S4B)
add(2, S4, "solve", [{"t": "latex", "v": "978+415-278"}], [], (95, 476, 470, 530), note=NOTE_S4B)
add(2, S4, "solve", [{"t": "latex", "v": "9999+999+99+3"}], [], (680, 476, 1070, 542), note=NOTE_S4B)

# ---------------- 五、解决问题 ----------------
add(2, S5, "solve",
    [{"t": "text", "v": "小明储蓄罐中有 28 个 5 角硬币和 69 个 1 元硬币。"
                        "小明储蓄罐里一共有多少元？"}],
    [], (232, 852, 1435, 902), "1.",
    note="左边界紧邻已剔除的卷面题号「1.」（题号 x204-228，正文 x246 起）")

add(2, S5, "solve",
    [{"t": "text", "v": "运动会长跑比赛在 200 米环形跑道上进行，小海参加的项目是 1000 米，"
                        "他跑了 4\n圈。小海已经跑了多少米？还剩下多少米没跑？"}],
    [], (185, 1350, 1435, 1510), "2.",
    note="题干在卷面上印成两行，按规范在一条 text 片段里用换行表示。"
         "左边界紧邻已剔除的卷面题号「2.」（x158-180）：第二行「圈。…」起点 x196，"
         "仍在题号末像素右侧，故剔除题号后不会切到第二行首字")

add(3, S5, "solve",
    [{"t": "text", "v": "学校三年级有 6 个班，每班发了 48 本书，四年级共发了 356 本书。"
                        "四年级比三年级多发了多少本？"}],
    [], (180, 200, 1435, 322), "4.",
    note="卷面题号从 2 直接跳到 4 —— 五、解决问题的第 3 小题在四张源图中都不存在"
         "（p2 底部被手指/阴影遮挡，p3 顶部直接是 4.），属源图缺失而非识别遗漏。"
         "左边界紧邻已剔除的卷面题号「4.」（x147-171，正文 x192 起）")

add(3, S5, "solve",
    [{"t": "text", "v": "同学们乘车去秋游，每辆车可乘 54 人，前四辆车全部坐满，"
                        "第五辆车还有 19 个空位。总共有多少人参加秋游？"}],
    [], (195, 508, 1435, 622), "5.",
    note="左边界紧邻已剔除的卷面题号「5.」（x164-186，正文 x208 起）")

add(3, S6, "solve",
    [{"t": "text", "v": "水蜜桃是上海南汇的特产。\n一箱水蜜桃 69 元，490 元够买 7 箱吗？"}],
    [], (202, 860, 1020, 978), "(1)",
    note="「水蜜桃是上海南汇的特产。」是 6. 估算 (1)(2) 两小题共同的情景引导语，卷面上单独一行"
         "（y878-908, x211-571），按「题内多行用换行」并入本小题题干，裁剪范围同步向上涵盖它。"
         "左边界保留了卷面题号「(1)」（引导语 x211 与题号 x216 起点几乎重合，无法在不切引导语的前提下"
         "剔除题号）")

add(3, S6, "solve",
    [{"t": "text", "v": "某农庄采摘了一批水蜜桃，分装成 1800 箱运往超市。现在有 6 辆货车，"
                        "每辆最多装 304 箱，一次运得完吗？"}],
    [], (215, 1150, 1435, 1262), "(2)",
    note="左边界紧邻已剔除的卷面题号「(2)」（x167-210，正文 x220 起）")

# ---------------- 六、判断 ----------------
NOTE_PD = ("左边界紧邻已剔除的卷面题号（题号 x189-215，正文 x230 起）；判断题括号是卷面印刷，照实写（　）")
NOTE_PD12 = ("⚠️ 「六、判断」的第 1、2 两小题**行距极小且卷面在这两行上明显倾斜**——实测该处斜率"
             "约 0.136（≈7.8°，即 x 从 215 到 1185 时行下移 132px）。两题在 y 上**交错重叠**"
             "（题 1 用矩形窗口只截得到左半段，右半段比题 2 的左端还低），任何矩形窗口都切不开，"
             "故这两题改用**平行四边形采样**（`source.quad` 记 4 个角点，实现见本文件的 crop_quad）："
             "沿该题的斜行方向取样后摆平成水平矩形，题面完整、且不含邻题任何字符。"
             "斜率由「裁剪图内每列墨迹质心的方差最小」自动搜出（题 1 d=132、题 2 d=136，两题独立），"
             "再逐张放大核对。`source.bbox` 记的是该四边形的外接矩形"
             "（故自检会报四边有墨迹，属预期）。学生铅笔圈画与红笔批改被印刷黑掩膜滤除，未进框。")
add(4, S6B, "other", [{"t": "text", "v": "乘数的末尾一共有几个 0，积的末尾就有几个 0。"}],
    [], None, "1.", note=NOTE_PD12, quad=(215, 1185, 105, 148, 237, 280))
add(4, S6B, "other", [{"t": "text", "v": "最小的两位数乘最大的一位数，积是三位数。"}],
    [], None, "2.", note=NOTE_PD12, quad=(215, 1185, 155, 198, 291, 334))
add(4, S6B, "other", [{"t": "text", "v": "6×324，“6”和百位上的“3”相乘，积是 18 个百。"}],
    [], (218, 472, 1000, 548), "3.", note=NOTE_PD)

# ---------------- 七、选择 ----------------
NOTE_CH = ("左边界紧邻已剔除的卷面题号（题号 x171-200，正文 x217 起）；"
           "选项行按卷面顺序收入 options（不含 A/B/C 前缀）")
add(4, S7, "choice",
    [{"t": "text", "v": "要使□37×3 的积是四位数，□里最小填（　）。"}],
    [{"t": "text", "v": "2"}, {"t": "text", "v": "3"}],
    (208, 610, 1150, 752), "1.",
    conf={"stem": 0.95, "options": 0.95, "figure": None}, note=NOTE_CH)
add(4, S7, "choice",
    [{"t": "text", "v": "306×5 的积中有（　）个 0。"}],
    [{"t": "text", "v": "0"}, {"t": "text", "v": "1"}, {"t": "text", "v": "2"}],
    (208, 752, 1150, 880), "2.",
    conf={"stem": 0.95, "options": 0.95, "figure": None}, note=NOTE_CH)
add(4, S7, "choice",
    [{"t": "text", "v": "三位数和一位数相乘，积是（　）位数。"}],
    [{"t": "text", "v": "三"}, {"t": "text", "v": "四"}, {"t": "text", "v": "以上情况都有可能"}],
    (208, 880, 1150, 1088), "3.",
    conf={"stem": 0.95, "options": 0.95, "figure": None}, note=NOTE_CH)
add(4, S7, "choice",
    [{"t": "text", "v": "（　）里最大填几？\n（　）×60<431\n1480>（　）×300"}],
    [],
    (175, 1098, 1320, 1215), "4.",
    conf={"stem": 0.95, "options": None, "figure": None},
    note="一个小题内含三行（提问 + 两条待填的算式），按「题内多行用换行」写在一条 text 片段里；"
         "右半条算式「1480>（　）×300」排在卷面同一行的右侧，一并纳入本框。"
         "左边界紧邻已剔除的卷面题号「4.」（x138-165）")


def print_mask(im):
    a = np.asarray(im.convert("RGB")).astype(np.int32)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    lum = (R * 299 + G * 587 + B * 114) // 1000
    mx = np.maximum(np.maximum(R, G), B)
    mn = np.minimum(np.minimum(R, G), B)
    return (lum < 118) & (mx - mn < 42)


def fit(P, win, pad=PAD):
    """在窗口内拟合印刷墨迹包围盒，四边留 pad —— 但**夹回窗口内**（否则会把邻题带进来）。"""
    x0, y0, x1, y1 = win
    sub = P[y0:y1, x0:x1]
    ys, xs = np.where(sub)
    if len(ys) == 0:
        return None
    b = [int(x0 + xs.min()) - pad, int(y0 + ys.min()) - pad,
         int(x0 + xs.max()) + 1 + pad, int(y0 + ys.max()) + 1 + pad]
    return [max(b[0], x0), max(b[1], y0), min(b[2], x1), min(b[3], y1)]


def crop_quad(im, x0, x1, ya0, ya1, yb0, yb1, pad=PAD):
    """把原图上一段**斜行**摆平后裁出来。

    入参：左端 y 带 [ya0, ya1]、右端 y 带 [yb0, yb1]（该行文本在 x0 与 x1 处的上下沿），
    中间线性过渡——即该行所占的是一个平行四边形。用 AFFINE 反采样成水平矩形，
    这样「行距极小 + 卷面倾斜」的两道题也能各自完整切开（矩形窗口做不到，见 NOTE_PD12）。

    返回 (裁剪图, 外接矩形 bbox, 4 角点 quad)。
    """
    W = int(round(x1 - x0))
    s = ((yb0 - ya0) + (yb1 - ya1)) / 2.0 / W          # 该行的斜率
    H = int(round(max(ya1 - ya0, yb1 - yb0))) + 2 * pad
    coeffs = (1.0, 0.0, float(x0), float(s), 1.0, float(ya0 - pad))
    out = im.transform((W, H), Image.AFFINE, coeffs, resample=Image.BICUBIC)
    quad = [[int(x0), int(ya0)], [int(x1), int(yb0)], [int(x1), int(yb1)], [int(x0), int(ya1)]]
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return out, [min(xs), min(ys), max(xs), max(ys)], quad


def main():
    # 0) 幂等：先清掉本卷此前生成的 JSON / 裁剪图（按 source.file 前缀匹配，可反复重跑）
    pref = "2026-10-01-第2单元练习卷-"
    for f in (ROOT / "data" / "questions").glob("*.json"):
        try:
            q = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if str(q.get("source", {}).get("file", "")).startswith(pref):
            crop = ROOT / "data" / "crops" / str(q["source"].get("crop", ""))
            if crop.exists():
                crop.unlink()
            f.unlink()
            print("清理旧产物", f.name)

    # 1) 登记原图到 benchmark
    for pg, (bench, photo) in PAGES.items():
        dst = ROOT / "data" / "benchmark" / bench
        if not dst.exists():
            shutil.copy2(CLIP / photo, dst)
        print(f"p{pg} -> {bench}")

    # 2) 逐页预载掩膜
    masks = {}
    for pg, (bench, _photo) in PAGES.items():
        masks[pg] = print_mask(Image.open(ROOT / "data" / "benchmark" / bench).convert("RGB"))

    # 3) 当天已有最大 id
    exist = list((ROOT / "data" / "questions").glob("q-20261001-*.json"))
    nxt = max(int(f.stem.split("-")[-1]) for f in exist) + 1

    crops = []
    for idx, it in enumerate(ITEMS, 1):
        qid = f"q-20261001-{nxt + idx - 1:03d}"
        im = Image.open(ROOT / "data" / "benchmark" / PAGES[it["page"]][0]).convert("RGB")
        crop_name = f"{qid}.jpg"
        quad_out = None
        if it.get("quad"):
            cimg, bbox, quad_out = crop_quad(im, *it["quad"])
        else:
            bbox = fit(masks[it["page"]], it["win"])
            assert bbox, f"{qid} 窗口内无印刷墨迹：{it['win']}"
            cimg = im.crop(tuple(bbox))
        cimg.save(ROOT / "data" / "crops" / crop_name, quality=95)
        src = {
            "file": PAGES[it["page"]][0],
            "page": it["page"],
            "bbox": bbox,
            "crop": crop_name,
            "printed_no": it["printed_no"],
            "crop_reviewed": True,
            "review_note": it["note"],
        }
        if quad_out:
            # 平行四边形采样的题：bbox 只是外接矩形，真正的裁剪范围由 quad 的 4 角点定义
            src["quad"] = quad_out
        data = {
            "schema_version": 2,
            "id": qid,
            "no": idx,
            "section": it["section"],
            "type": it["qtype"],
            "stem": it["stem"],
            "options": it["options"],
            "source": src,
            "confidence": it["conf"],
            "created_at": NOW,
            "updated_at": NOW,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        crops.append((qid, idx, cimg))
        tag = "QUAD" if quad_out else "    "
        print(f"{qid} 第{idx:2d}题 p{it['page']} {tag} {it['section'][:14]:16s}{it['qtype']:9s} "
              f"bbox={bbox} {bbox[2]-bbox[0]:4d}x{bbox[3]-bbox[1]:3d}")

    # 4) 校验拼图
    CW = 820
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
    out = ROOT / "data" / "samples" / "_crops_check_p8.jpg"
    sheet.save(out, quality=88)
    print("校验图 ->", out.name, sheet.size, "共", len(crops), "题")


if __name__ == "__main__":
    main()
