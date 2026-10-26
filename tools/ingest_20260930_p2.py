# -*- coding: utf-8 -*-
"""整页全量识别入库（2026-09-30 第2份：印刷体乘法练习卷，5 板块 27 题）。

源图：C:\\Users\\1\\.workbuddy\\clipboard-images\\clipboard-2026-09-30T15-07-59-246Z-e73bef97.png
原则：整页所有题目全部识别入库（不筛错题）。本卷为纯印刷体、无学生作答。
坐标由行/列投影分析确定。
"""
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(r"D:\workspace\ai\shijuan")
SRC = Path(r"C:\Users\1\.workbuddy\clipboard-images\clipboard-2026-09-30T15-07-59-246Z-e73bef97.png")
SRC_NAME = "2026-09-30-乘法练习卷2.png"
TS = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")

# 投影分析所得 bbox（像素）
B1_COLS = [(520, 898), (898, 1275), (1275, 1646), (1646, 2150)]
B1_ROWS = [(618, 696), (696, 792), (792, 882)]
B2_COLS = [(540, 1001), (1001, 1595), (1595, 2200)]
B2_ROW = (945, 1335)          # 题目行 + 下方竖式书写区
B3_COLS = [(440, 1088), (1088, 1593), (1593, 2200)]
B3_ROW = (1390, 1510)
B4_COLS = [(420, 998), (998, 1622), (1622, 2180)]
B4_ROWS = [(1888, 2024), (2024, 2152)]
B5 = [(490, 2392, 2245, 2588), (490, 2596, 2245, 2678), (490, 2688, 2245, 2778)]

# (id, no, type, section, bbox, stem片段, answer, 知识点, 难度, note)
ITEMS = []


def add(qid, no, qtype, section, bbox, stem, answer, kps, diff, ans_conf=0.95, note=""):
    ITEMS.append((qid, no, qtype, section, bbox, stem, answer, kps, diff, ans_conf, note))


def calc(no, row, col, expr, val, kps, diff):
    x0, x1 = B1_COLS[col - 1]
    y0, y1 = B1_ROWS[row - 1]
    add(f"q-20260930-{25 + no:03d}", no, "calculate", "1. 直接写出得数", (x0, y0, x1, y1),
        [{"t": "latex", "v": expr}], {"t": "latex", "v": val}, kps, diff)


# ── 1. 直接写出得数（4 列 × 3 行 = 12 题）───────────────
calc(1, 1, 1, r"8\times8+7=", "71", ["乘加混合运算"], 1)
calc(2, 1, 2, r"70\times4=", "280", ["两位数乘一位数"], 1)
calc(3, 1, 3, r"3\times24=", "72", ["两位数乘一位数"], 1)
calc(4, 1, 4, r"31\times8=", "248", ["两位数乘一位数"], 1)
calc(5, 2, 1, r"4\times7+3=", "31", ["乘加混合运算"], 1)
calc(6, 2, 2, r"9\times200=", "1800", ["整百数乘一位数"], 1)
calc(7, 2, 3, r"15\times6=", "90", ["两位数乘一位数"], 1)
calc(8, 2, 4, r"70\times0\times3=", "0", ["含 0 的连乘"], 1)
calc(9, 3, 1, r"6\times9+6=", "60", ["乘加混合运算"], 1)
calc(10, 3, 2, r"360\times2=", "720", ["三位数乘一位数"], 1)
calc(11, 3, 3, r"600\times5=", "3000", ["整百数乘一位数"], 1)
calc(12, 3, 4, r"4\times300-30=", "1170", ["乘减混合运算"], 2)

# ── 2. 用竖式计算（3 题）──────────────────────────────
for i, (gid, expr, val, kps) in enumerate([
    (13, r"5\times580=", "2900", ["三位数乘一位数", "竖式"]),
    (14, r"609\times6=", "3654", ["三位数乘一位数", "竖式"]),
    (15, r"759\times8=", "6072", ["三位数乘一位数", "竖式"]),
]):
    x0, x1 = B2_COLS[i]
    add(f"q-20260930-{25 + gid:03d}", gid, "solve", "2. 用竖式计算", (x0, B2_ROW[0], x1, B2_ROW[1]),
        [{"t": "latex", "v": expr}], {"t": "latex", "v": val}, kps, 2, note="需用竖式计算（卷面下方留竖式书写区）。")

# ── 3. 计算（3 题）────────────────────────────────
add("q-20260930-041", 16, "solve", "3. 计算", (B3_COLS[0][0], B3_ROW[0], B3_COLS[0][1], B3_ROW[1]),
    [{"t": "latex", "v": r"1570-\text{[?]}\times314"}], {"t": "text", "v": "[?]", "confidence": 0.2},
    ["四则混合运算"], 3, ans_conf=0.2,
    note="原卷此处（减号与 ×314 之间）缺失约 3 字符宽的数字或方框，印刷不清/漏印，按规范标 [?]，不臆造。")
add("q-20260930-042", 17, "solve", "3. 计算", (B3_COLS[1][0], B3_ROW[0], B3_COLS[1][1], B3_ROW[1]),
    [{"t": "latex", "v": r"763\times8+99"}], {"t": "latex", "v": "6203"}, ["乘加混合运算"], 2)
add("q-20260930-043", 18, "solve", "3. 计算", (B3_COLS[2][0], B3_ROW[0], B3_COLS[2][1], B3_ROW[1]),
    [{"t": "latex", "v": r"1000-109\times7"}], {"t": "latex", "v": "237"}, ["乘减混合运算"], 2)

# ── 4. 在○里填入 > < 或 =（3 列 × 2 行 = 6 题）──────────
cmp_items = [
    (19, 1, 1, r"102\times3", "500", "<", "306 < 500"),
    (20, 1, 2, r"170\times4", "680", "=", "680 = 680"),
    (21, 1, 3, r"180\times6", "1000", ">", "1080 > 1000"),
    (22, 2, 1, r"250\times4", r"5\times240", "<", "1000 < 1200"),
    (23, 2, 2, r"430\times3", r"403\times7", "<", "1290 < 2821"),
    (24, 2, 3, r"360\times5", r"350\times6", "<", "1800 < 2100"),
]
for (gid, r, c, left, right, ans, why) in cmp_items:
    x0, x1 = B4_COLS[c - 1]
    y0, y1 = B4_ROWS[r - 1]
    add(f"q-20260930-{25 + gid:03d}", gid, "fill", "4. 在○里填入“>”“<”或“=”", (x0, y0, x1, y1),
        [{"t": "latex", "v": left + r"\ \bigcirc\ " + right}], {"t": "text", "v": ans},
        ["乘法计算", "大小比较"], 2, ans_conf=0.9, note=f"填入：{ans}（{why}）。")

# ── 5. 填空（3 题）─────────────────────────────────
add("q-20260930-050", 25, "fill", "5. 填空", B5[0],
    [{"t": "text", "v": "（1）三位数□24×4 的积是三位数，□里最大能填（　　）；积是四位数，□里最小能填（　　）。"}],
    {"t": "text", "v": "最大填 2；最小填 3", "confidence": 0.9}, ["乘法估算", "数位", "最大值最小值"], 3,
    ans_conf=0.9, note="124×4=496、224×4=896 为三位数，324×4=1296 为四位数。")
add("q-20260930-051", 26, "fill", "5. 填空", B5[1],
    [{"t": "text", "v": "（2）一位数乘四位数，积可能是（　　）位数，也可能是（　　）位数。"}],
    {"t": "text", "v": "四位数；五位数", "confidence": 0.9}, ["乘法估算", "数位"], 3,
    ans_conf=0.9, note="最小 1×1000=1000（四位），最大 9×9999=89991（五位）。")
add("q-20260930-052", 27, "fill", "5. 填空", B5[2],
    [{"t": "text", "v": "（3）最大的一位数与最大的三位数的和是（　　），积是（　　）。"}],
    {"t": "text", "v": "1008；8991", "confidence": 0.95}, ["加法", "乘法", "极值"], 2,
    ans_conf=0.95, note="最大一位数 9，最大三位数 999：9+999=1008，9×999=8991。")


def main():
    (ROOT / "data" / "benchmark").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "crops").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "questions").mkdir(parents=True, exist_ok=True)
    bench = ROOT / "data" / "benchmark" / SRC_NAME
    if not bench.exists():
        shutil.copy2(SRC, bench)

    im = Image.open(SRC)
    W, H = im.size
    crops = []
    for (qid, no, qtype, section, bbox, stem, answer, kps, diff, ans_conf, note) in ITEMS:
        b = (max(0, bbox[0]), max(0, bbox[1]), min(W, bbox[2]), min(H, bbox[3]))
        crop_rel = f"{qid}.jpg"
        im.crop(b).save(ROOT / "data" / "crops" / crop_rel, quality=92)
        crops.append(qid)
        data = {
            "schema_version": 1,
            "id": qid,
            "no": no,
            "type": qtype,
            "section": section,
            "stem": stem,
            "options": [],
            "answer": answer,
            "analysis": "",
            "student_answer": None,
            "annotations": [],
            "judgement": {"status": "unknown", "by": "none"},
            "tags": {"知识点": kps, "错因": "", "难度": diff},
            "note": (note + " 标准答案为助手计算（卷面无答案栏），待校对确认。") if note else
                    "标准答案为助手计算（卷面无答案栏），待校对确认。",
            "redo_history": [],
            "source": {"file": SRC_NAME, "page": 1, "bbox": list(b), "crop": crop_rel},
            "confidence": {"stem": 0.97, "figure": None, "options": None, "answer": ans_conf},
            "created_at": TS,
            "updated_at": TS,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"写出 {qid} 第{no}题 [{section}] bbox={b}")

    ims = [Image.open(ROOT / "data" / "crops" / f"{q}.jpg") for q in crops]
    cw = 300
    thumbs = [i.resize((cw, max(24, int(i.height * cw / i.width)))) for i in ims]
    per_row = 5
    rows = [thumbs[i:i + per_row] for i in range(0, len(thumbs), per_row)]
    rh = [max(t.height for t in r) for r in rows]
    sheet = Image.new("RGB", (cw * per_row, sum(rh) + 8 * len(rows)), "#e5e7eb")
    y = 0
    for r, h in zip(rows, rh):
        for i, t in enumerate(r):
            sheet.paste(t, (i * cw, y))
        y += h + 8
    out = ROOT / "data" / "samples" / "_crops_check_p2.jpg"
    sheet.save(out, quality=88)
    print(f"共 {len(crops)} 裁剪；校验图 -> {out}")


if __name__ == "__main__":
    main()
