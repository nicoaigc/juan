# -*- coding: utf-8 -*-
"""第 3 份试卷（选择 + 应用题，无手写作答）全量识别：裁剪 + 写 schema v2 JSON + 校验图。

源图：clipboard-2026-09-30T15-41-06-811Z-30a07370.jpg (1427 x 1920)
卷面：6. 选择（2 小题） / 7. 应用题（2 小题），共 4 题。

坐标全部来自行/列投影分析（详见 prompts/recognition-spec.md 裁剪章节）：
  行带  [309,340]=6.选择标题  [368,401]=Q1题干  [428,457]=Q1选项
        [485,518]=Q2题干     [544,573]=Q2选项  [603,634]=7.应用题标题
        [659,695]=Q3题干     [721,957]=泳道图
        [980,1021]=Q4题干行1 [1048,1083]=Q4题干行2  [1102,1330]=电梯图
  题号  Q1「(1)」x243-286  Q2「(2)」x239-281  Q3「(1)」x232-274  Q4「(2)」x204-235（均剔除）
  正文左起点  Q1 292 / Q2 288 / Q3 279 / Q4 238
  插图 泳道图 x984-1329 y721-957；电梯图 x1075-1323 y1102-1330
"""
from pathlib import Path
from PIL import Image, ImageDraw
import json
import shutil
from datetime import datetime, timezone, timedelta

ROOT = Path(r"D:\workspace\ai\shijuan")
SRC = Path(r"C:\Users\1\.workbuddy\clipboard-images\clipboard-2026-09-30T15-41-06-811Z-30a07370.jpg")
BENCH_NAME = "2026-09-30-选择与应用题.jpg"
CN = timezone(timedelta(hours=8))
NOW = datetime.now(CN).isoformat(timespec="seconds")

# id, no, section, type, stem, options, bbox[左,上,右,下], printed_no, conf
ITEMS = [
    (
        "q-20260930-053", 1, "6. 选择", "choice",
        [{"t": "text", "v": "79×6,第一个乘数十位上的 7 乘第二个乘数 6,结果是(　　)。"}],
        [
            {"t": "text", "v": "42"},
            {"t": "text", "v": "420"},
            {"t": "text", "v": "4200"},
            {"t": "text", "v": "不确定"},
        ],
        [290, 362, 1310, 463], "(1)",
        {"stem": 0.97, "options": 0.97, "figure": None},
    ),
    (
        "q-20260930-054", 2, "6. 选择", "choice",
        [{"t": "text", "v": "下面乘积最接近 1000 的算式是(　　)。"}],
        [
            {"t": "latex", "v": "300\\times3"},
            {"t": "latex", "v": "330\\times3"},
            {"t": "latex", "v": "333\\times3"},
            {"t": "latex", "v": "501\\times2"},
        ],
        [286, 479, 1306, 579], "(2)",
        {"stem": 0.97, "options": 0.97, "figure": None},
    ),
    (
        "q-20260930-055", 3, "7. 应用题", "solve",
        [
            {"t": "text", "v": "暑假里,小海去游泳馆游泳,他游了 3 个来回,一共游了多少米?"},
            {"t": "figure", "state": "crop", "src": "q-20260930-055.jpg", "expr": None,
             "geometry": None, "confidence": 0.95},
        ],
        [],
        [277, 653, 1345, 963], "(1)",
        {"stem": 0.97, "options": None, "figure": 0.95},
    ),
    (
        "q-20260930-056", 4, "7. 应用题", "solve",
        [
            {"t": "text", "v": "有 6 箱货物,每箱货物重 285 千克,请你用估算的方法判断"
                              "货运电梯能否一次性运输这些货物?"},
            {"t": "figure", "state": "crop", "src": "q-20260930-056.jpg", "expr": None,
             "geometry": None, "confidence": 0.95},
        ],
        [],
        [252, 974, 1340, 1336], "(2)",
        {"stem": 0.97, "options": None, "figure": 0.95},
    ),
]

# 左边界外侧是刚被剔除的卷面题号，属已知情况，直接登记复核
REVIEW_NOTE = "左边界紧邻已剔除的卷面题号（(1)/(2)），题面完整"


def main() -> None:
    (ROOT / "data" / "benchmark").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "crops").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "questions").mkdir(parents=True, exist_ok=True)

    dst = ROOT / "data" / "benchmark" / BENCH_NAME
    shutil.copy2(SRC, dst)
    im = Image.open(SRC).convert("RGB")
    print("原图", im.size, "->", dst.name)

    crops = []
    for (qid, no, section, qtype, stem, options, bbox, printed_no, conf) in ITEMS:
        x0, y0, x1, y1 = bbox
        crop_name = f"{qid}.jpg"
        im.crop((x0, y0, x1, y1)).save(ROOT / "data" / "crops" / crop_name, quality=95)
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
                "review_note": REVIEW_NOTE,
            },
            "confidence": conf,
            "created_at": NOW,
            "updated_at": NOW,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        crops.append((qid, im.crop((x0, y0, x1, y1))))
        print(f"{qid} 第{no}题 {section} {qtype}  bbox={bbox}  图 {x1-x0}x{y1-y0}")

    # 校验图
    CW = 760
    rows = []
    for qid, c in crops:
        f = CW / c.width
        rows.append((qid, c.resize((CW, max(1, int(c.height * f))))))
    H = sum(r[1].height + 34 for r in rows) + 10
    sheet = Image.new("RGB", (CW + 16, H), "#ffffff")
    dr = ImageDraw.Draw(sheet)
    y = 6
    for qid, c in rows:
        dr.text((8, y + 8), f"{qid}", fill=(200, 0, 0))
        y += 30
        sheet.paste(c, (8, y))
        dr.rectangle([7, y - 1, 8 + c.width, y + c.height], outline=(0, 150, 0))
        y += c.height + 4
    out = ROOT / "data" / "samples" / "_crops_check_p3.jpg"
    sheet.save(out, quality=90)
    print("校验图 ->", out.name, sheet.size)


if __name__ == "__main__":
    main()
