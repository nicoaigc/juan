# -*- coding: utf-8 -*-
"""整页识别入库（2026-09-30 小学练习页，全量 24 题 + 1 草稿）。

源图：C:\\Users\\1\\.workbuddy\\clipboard-images\\clipboard-2026-09-30T14-53-49-520Z-44550828.jpg
原则：**整页所有题目全部识别入库**（不筛错题）；卷面批改与对错另存 judgement 字段。
坐标由行/列投影分析确定（非目测）。
"""
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(r"D:\workspace\ai\shijuan")
SRC = Path(r"C:\Users\1\.workbuddy\clipboard-images\clipboard-2026-09-30T14-53-49-520Z-44550828.jpg")
SRC_NAME = "2026-09-30-小学练习页.jpg"
TS = "2026-09-30T23:10:00+08:00"

# 投影分析得到的列 / 行边界（像素）
COL = {1: (185, 520), 2: (560, 915), 3: (965, 1315)}
ROW1 = {1: (245, 310), 2: (306, 372), 3: (368, 432), 4: (428, 505)}      # 一、算一算（4 行）
ROW2 = {1: (560, 785), 2: (800, 1020)}                                   # 二、用竖式计算（含竖式，2 行）
ROW3 = {1: (1076, 1292), 2: (1284, 1480)}                                # 三、递等式计算（含步骤，2 行）

# 字段: id, no, type, 板块, col, row, 题干, 标准答案, 学生答案, 学生答案conf,
#       知识点, 难度, judgement(status/by), 备注
ITEMS = [
    # ── 一、算一算（口算，12 题）────────────────────────────
    ("q-20260930-001", 1, "calculate", "一、算一算", 1, ROW1[1], r"2\times3\times10=", "60", "60", 0.95,
     ["连乘运算"], 1, ("correct", "red_pen"), ""),
    ("q-20260930-002", 2, "calculate", "一、算一算", 2, ROW1[1], r"70\times9=", "630", "630", 0.95,
     ["两位数乘一位数"], 1, ("correct", "red_pen"), ""),
    ("q-20260930-003", 3, "calculate", "一、算一算", 3, ROW1[1], r"400\times9=", "3600", "4500", 0.8,
     ["整百数乘一位数"], 1, ("wrong", "computed"), "学生写 4500（有涂改重写痕迹），应为 3600。批改符号被长划线覆盖，无法确认 ✓/✗。"),
    ("q-20260930-004", 4, "calculate", "一、算一算", 1, ROW1[2], r"6\times0\times5=", "0", "0", 0.95,
     ["含 0 的连乘"], 1, ("correct", "red_pen"), ""),
    ("q-20260930-005", 5, "calculate", "一、算一算", 2, ROW1[2], r"9\times2\div3=", "6", "6", 0.95,
     ["乘除混合运算"], 1, ("correct", "red_pen"), ""),
    ("q-20260930-006", 6, "calculate", "一、算一算", 3, ROW1[2], r"4\times8+8=", "40", "40", 0.9,
     ["乘加混合运算"], 1, ("correct", "red_pen"), "学生写 40（4×8=32，32+8=40）。"),
    ("q-20260930-007", 7, "calculate", "一、算一算", 1, ROW1[3], r"7\times4+5=", "33", "33", 0.85,
     ["乘加混合运算"], 1, ("correct", "red_pen"), "学生写 33（7×4=28，28+5=33），卷面标 ✓。"),
    ("q-20260930-008", 8, "calculate", "一、算一算", 2, ROW1[3], r"48\div6\div2=", "4", "4", 0.95,
     ["连除运算"], 1, ("correct", "red_pen"), ""),
    ("q-20260930-009", 9, "calculate", "一、算一算", 3, ROW1[3], r"72\div9\div4=", "2", "2", 0.9,
     ["连除运算"], 1, ("correct", "red_pen"), ""),
    ("q-20260930-010", 10, "calculate", "一、算一算", 1, ROW1[4], r"8+2\times7=", "22", "29", 0.9,
     ["乘加混合运算", "运算顺序"], 1, ("wrong", "both"), "学生先算加法（8+2=10，10×7=70？卷面写 29），未按先乘后加，正确为 2×7+8=22。"),
    ("q-20260930-011", 11, "calculate", "一、算一算", 2, ROW1[4], r"400\div80=", "5", "5", 0.95,
     ["整百数除以整十数"], 1, ("correct", "red_pen"), "题干括号（400）÷80 为学生/题目原有形式。"),
    ("q-20260930-012", 12, "calculate", "一、算一算", 3, ROW1[4], r"50\times30=", "1500", "1500", 0.95,
     ["整十数相乘"], 1, ("correct", "red_pen"), "题干括号（50）×30。"),
    # ── 二、用竖式计算（6 题）──────────────────────────────
    ("q-20260930-013", 13, "solve", "二、用竖式计算", 1, ROW2[1], r"9070-2304=", "6766", "6766", 0.95,
     ["万以内减法", "竖式"], 2, ("correct", "red_pen"), "卷面为竖式作答。"),
    ("q-20260930-014", 14, "solve", "二、用竖式计算", 2, ROW2[1], r"6\times55=", "330", "210", 0.9,
     ["两位数乘一位数", "竖式"], 2, ("wrong", "both"), "竖式：55×6，进位错误，得 210，应为 330。"),
    ("q-20260930-015", 15, "solve", "二、用竖式计算", 3, ROW2[1], r"5\times809=", "4045", "4045", 0.9,
     ["三位数乘一位数", "竖式"], 2, ("correct", "red_pen"), "卷面为竖式作答。"),
    ("q-20260930-016", 16, "solve", "二、用竖式计算", 1, ROW2[2], r"754\times9=", "6786", "6386", 0.9,
     ["三位数乘一位数", "竖式"], 2, ("wrong", "both"), "竖式笔误：百位 6/7 写错，得 6386，应为 6786。"),
    ("q-20260930-017", 17, "solve", "二、用竖式计算", 2, ROW2[2], r"7\times240=", "1680", "1480", 0.8,
     ["三位数乘一位数", "竖式"], 2, ("wrong", "computed"),
     "存疑：学生竖式得 1480（应为 1680，百位 4/6 误），但卷面标对勾 ✓——红笔批改与答案比对不一致，需人工确认。"),
    ("q-20260930-018", 18, "solve", "二、用竖式计算", 3, ROW2[2], r"6200\times4=", "24800", "24800", 0.95,
     ["整百数乘一位数", "竖式"], 2, ("correct", "red_pen"), "卷面为竖式作答。"),
    # ── 三、递等式计算（6 题）──────────────────────────────
    ("q-20260930-019", 19, "solve", "三、递等式计算", 1, ROW3[1], r"254+27-54", "227", r"=2[?]8-54=2[?]7", 0.4,
     ["加减混合运算", "递等式"], 2, ("wrong", "red_pen"),
     "存疑：学生首步与终值均有手写遮挡，按规范标 [?]；卷面标 ✗，红笔判断依据需人工确认（若首步 254+27=281 则终值 227 正确）。"),
    ("q-20260930-020", 20, "solve", "三、递等式计算", 2, ROW3[1], r"976-81+19", "914", r"=895+19=914", 0.9,
     ["加减混合运算", "递等式"], 2, ("correct", "red_pen"), ""),
    ("q-20260930-021", 21, "solve", "三、递等式计算", 3, ROW3[1], r"543-219-281", "43", r"=324-281=243", 0.9,
     ["连减运算", "递等式"], 2, ("wrong", "both"), "首步 543-219=324 正确，末步 324-281 误算为 243，应为 43。"),
    ("q-20260930-022", 22, "solve", "三、递等式计算", 1, ROW3[2], r"43+57\times9", "556", r"=43+?63=?46", 0.5,
     ["乘加混合运算", "递等式"], 2, ("wrong", "both"),
     "中间乘积与终值部分字符被涂改，按规范标 [?]；卷面标 ✗。正确：57×9=513，43+513=556。"),
    ("q-20260930-023", 23, "solve", "三、递等式计算", 2, ROW3[2], r"108\times7-108\times5", "216", r"=?50-?34=116", 0.5,
     ["乘法分配律", "递等式"], 3, ("wrong", "both"),
     "两步乘积均误（应为 756-540=216），学生得 -?34 与 116；卷面另有红笔订正 108/216 字样。"),
    ("q-20260930-024", 24, "solve", "三、递等式计算", 3, ROW3[2], r"81\div9\times810", "7290", r"=9\times810=7290", 0.9,
     ["乘除混合运算", "递等式"], 2, ("correct", "red_pen"), ""),
]

# 左下角卷面草稿（非正式题，单独标记）
DRAFT = ("q-20260930-025", 25, "other", "卷面草稿", (125, 1450, 340, 1725),
         r"57\times9=", "513", "513", 0.8, ["两位数乘一位数", "竖式草稿"], 2, ("correct", "computed"),
         "页脚空白处的手写竖式草稿（57×9），非题目区，独立收录。")


def main():
    (ROOT / "data" / "benchmark").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "crops").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "questions").mkdir(parents=True, exist_ok=True)

    bench = ROOT / "data" / "benchmark" / SRC_NAME
    if not bench.exists():
        shutil.copy2(SRC, bench)

    im = Image.open(SRC)
    crops = []

    def emit(qid, no, qtype, section, bbox, stem, ans, stu, stu_conf, kps, diff, jg, note):
        b = tuple(int(v) for v in bbox)
        crop_rel = f"{qid}.jpg"
        im.crop(b).save(ROOT / "data" / "crops" / crop_rel, quality=92)
        crops.append(qid)
        status, by = jg
        data = {
            "schema_version": 1,
            "id": qid,
            "no": no,
            "type": qtype,
            "section": section,
            "stem": [{"t": "latex", "v": stem}],
            "options": [],
            "answer": {"t": "latex", "v": ans, "confidence": 0.95},
            "analysis": "",
            "student_answer": {"t": "latex", "v": stu, "confidence": stu_conf},
            "annotations": ([] if by == "computed" else [{"correct": "红笔批改：✓", "wrong": "红笔批改：✗"}.get(status, "红笔批改：?")]),
            "judgement": {"status": status, "by": by},
            "tags": {"知识点": kps, "错因": "", "难度": diff},
            "note": (f"来源：{section}。标准答案为助手计算（卷面无答案栏），待校对确认。" + (note or "")),
            "redo_history": [],
            "source": {"file": SRC_NAME, "page": 1, "bbox": list(b), "crop": crop_rel},
            "confidence": {"stem": 0.97, "figure": None, "options": None, "answer": 0.95},
            "created_at": TS,
            "updated_at": TS,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"写出 {qid} 第{no}题 [{section}] bbox={b}")

    for (qid, no, qtype, section, c, row, stem, ans, stu, sc, kps, diff, jg, note) in ITEMS:
        x0, x1 = COL[c]
        y0, y1 = row
        emit(qid, no, qtype, section, (x0, y0, x1, y1), stem, ans, stu, sc, kps, diff, jg, note)

    # 草稿
    (qid, no, qtype, section, bbox, stem, ans, stu, sc, kps, diff, jg, note) = DRAFT
    emit(qid, no, qtype, section, bbox, stem, ans, stu, sc, kps, diff, jg, note)

    # 校验图：所有裁剪拼成一张
    ims = [Image.open(ROOT / "data" / "crops" / f"{q}.jpg") for q in crops]
    cw = 300
    thumbs = [i.resize((cw, max(30, int(i.height * cw / i.width)))) for i in ims]
    per_row = 5
    rows = [thumbs[i:i + per_row] for i in range(0, len(thumbs), per_row)]
    rh = [max(t.height for t in r) for r in rows]
    sheet = Image.new("RGB", (cw * per_row, sum(rh) + 8 * len(rows)), "#e5e7eb")
    y = 0
    for r, h in zip(rows, rh):
        for i, t in enumerate(r):
            sheet.paste(t, (i * cw, y))
        y += h + 8
    out = ROOT / "data" / "samples" / "_crops_check.jpg"
    sheet.save(out, quality=88)
    print("共", len(crops), "裁剪；校验图 ->", out)


if __name__ == "__main__":
    main()
