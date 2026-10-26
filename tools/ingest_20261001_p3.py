# -*- coding: utf-8 -*-
"""第 7 份图片（三年级第一学期第一、二单元素养卷 · 第三部分 应用）全量识别。

源图：clipboard-2026-10-01T02-13-32-670Z-bda9060e.jpg (1279 x 1706)
卷面：第三部分 应用
        1、王老师家电费（一个季度几个月）
        2、4 本书摞起来 24 毫米，40 本多高
        3、3 天看完故事书，前两天平均 125 页、第三天 85 页
        4、自行车 289 元买 3 辆，900 元够吗（用两种方法解答）
      共 **4 题**入库（全部是解答题）。

版面：本页笔迹极多（红笔批改 + 铅笔作答 + 铅笔圈画），与第 6 份卷同源（同一份卷的第三部分）。
定位沿用「印刷黑」掩膜（lum<118 且彩度<42），实测印刷行核密度 120–360，笔迹带只有 3–40。

实测（原图坐标）：
   板块标题「第三部分 应用」  y 30–60    x 572–796
   题1 行1 y 130–165  x 163–1192（题号「1.」163–181，正文 194 起）
       行2 y 170–196  x 162–568   ← 顶格，比题号起点还靠左 1px
   题2 行1 y 484–516  x 160–1192（题号「2.」160–179，正文 190 起）
       行2 y 525–549  x 160–322   ← 顶格，与题号起点同为 160
   题3 行1 y 837–864  x 165–1161（题号「3.」165–185，正文 197 起）
       行2 y 875–901  x 164–478   ← 顶格，比题号起点靠左 1px
   题4 行1 y 1184–1212 x 166–984（题号「4.」166–187，正文 198 起）
       行2 y 1224–1251 x 183–419  ← 只比题号末靠左 4px
       ①估算法： y 1299–1325 x 171–296
       ②计算法： y 1516–1541 x 181–305
   题1 的红笔斜线自右下穿出题干，题3 的题干上有学生铅笔圈画（圈内文字可辨认）。

**左边界一律取「全部内容行的最小墨迹 x」**：题 1/2/3 的续行是顶格的（比首行题号起点还靠左 1px），
按「题号末像素+1」裁会切掉续行首字 —— 按规范「题号留图只是观感，切掉内容是内容错误」，
卷面题号完整留在裁剪图内并写进 review_note。

**裁剪用「印刷黑」掩膜拟合包围盒**（本页笔迹过密，用灰度掩膜会让包围盒被邻题作答带跑偏；
本卷笔迹在题干下方 60–100px 处才出现，按印刷墨迹定界后题目文字四周留白干净）。
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
SRC = Path(r"C:\Users\1\.workbuddy\clipboard-images\clipboard-2026-10-01T02-13-32-670Z-bda9060e.jpg")
BENCH_NAME = "2026-10-01-第一二单元素养卷-应用.jpg"
CN = timezone(timedelta(hours=8))
NOW = datetime.now(CN).isoformat(timespec="seconds")

PAD = 8
SECTION = "第三部分 应用"
ID_BASE = 20261001
ID_START = 39          # 当天全局递增的尾号（本卷之前到 038）

# (id_suffix, section, type, stem, options, 窗口[x0,y0,x1,y1], printed_no, conf)
ITEMS = [
    (39, SECTION, "solve",
     [{"t": "text", "v": "王老师家第一个月电费共 160 元，按这个标准计算，王老师家一个季度的电费"
                         "是多少元？（一个季度 3 个月）"}],
     [], [150, 118, 1205, 206], "1.",
     {"stem": 0.97, "options": None, "figure": None}),
    (40, SECTION, "solve",
     [{"t": "text", "v": "把 4 本相同的书摞起来，高度是 24 毫米。如果把 40 本这样的书摞起来，"
                         "高度是多少毫米？"}],
     [], [150, 478, 1205, 554], "2.",
     {"stem": 0.97, "options": None, "figure": None}),
    (41, SECTION, "solve",
     [{"t": "text", "v": "小明 3 天看完了一本故事书，前两天平均每天看 125 页，第三天看了 85 页，"
                         "这本故事书一共多少页？"}],
     [], [150, 830, 1172, 906], "3.",
     {"stem": 0.97, "options": None, "figure": None}),
    (42, SECTION, "solve",
     [{"t": "text", "v": "每辆自行车 289 元，买 3 辆这样的自行车，准备 900 元够吗？"
                         "（用两种方法解答）"}],
     [], [150, 1178, 1000, 1262], "4.",
     {"stem": 0.97, "options": None, "figure": None}),
]

NOTE = {
    39: ("左边界取全部内容行的最小墨迹 x：续行「是多少元？（一个季度 3 个月）」顶格，比首行题号起点"
         "还靠左 1px，故卷面题号「1.」完整留在裁剪图内（规范取舍：题号留图只是观感问题，切掉续行是"
         "内容错误）。右端有红笔批改斜线自下方穿出题干：题干文字在「一个季度的电费」处被斜线擦过，"
         "文字本身完整可辨认，未遮挡任何字符。自检在下边界（y214）内侧报「有墨迹」即这条红笔斜线；"
         "题干文字最下沿在 y196，与下边界有 18px 余量，无切字。"),
    40: ("左边界取全部内容行的最小墨迹 x：续行「是多少毫米？」顶格，与首行题号起点同为 x160，"
         "故卷面题号「2.」完整留在裁剪图内。下边界外紧邻学生作答「24×4=96(mm)」的上缘"
         "（实测笔迹上缘 y562，题干下沿 y549），题干本身完整无切字。"),
    41: ("左边界取全部内容行的最小墨迹 x：续行「这本故事书一共多少页？」顶格，比首行题号起点靠左 1px，"
         "故卷面题号「3.」完整留在裁剪图内。题干上「前两天平均每天看」有学生铅笔圈画，圈内文字"
         "清晰可辨认，未遮挡任何字符。自检在上边界（y822）内侧报「有墨迹」是上一题作答区的横线与"
         "学生铅笔圈的上缘；题干首行文字上缘在 y833，与上边界有 11px 余量，无切字。"),
    42: ("左边界取首行题号起点 x166：本题续行「（用两种方法解答）」起点 x183 只比题号末像素 x187 靠左 4px，"
         "若按「题号末+1」裁会切到括号左弧，故仍保留题号「4.」在裁剪图内。"
         "⚠️ 卷面在题干下方另印有「①估算法：」（y1299–1325, x171–296）与「②计算法：」（y1516–1541, "
         "x181–305）两个**作答位置标签**（标签下均为学生手写作答，无印刷内容）。按「只识别题目本身"
         "＋只有标签无小题内容的不入库」判为作答位置指示、非题目内容，**未入题干、未入裁剪**；"
         "题干已用「（用两种方法解答）」完整表达要求，此处留档以备组卷时还原版式。"),
}


def print_mask(im: Image.Image) -> np.ndarray:
    a = np.asarray(im.convert("RGB")).astype(np.int32)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    lum = (R * 299 + G * 587 + B * 114) // 1000
    mx = np.maximum(np.maximum(R, G), B)
    mn = np.minimum(np.minimum(R, G), B)
    return (lum < 118) & (mx - mn < 42)


def fit(P: np.ndarray, win, pad=PAD):
    x0, y0, x1, y1 = win
    sub = P[y0:y1, x0:x1]
    ys, xs = np.where(sub)
    if len(ys) == 0:
        return None
    return [int(x0 + xs.min()) - pad, int(y0 + ys.min()) - pad,
            int(x0 + xs.max()) + 1 + pad, int(y0 + ys.max()) + 1 + pad]


def main() -> None:
    dst = ROOT / "data" / "benchmark" / BENCH_NAME
    if not dst.exists():
        shutil.copy2(SRC, dst)
    im = Image.open(SRC).convert("RGB")
    P = print_mask(im)
    print("原图", im.size, "->", dst.name)

    known = {}
    for f in (ROOT / "data" / "questions").glob("*.json"):
        q = json.loads(f.read_text(encoding="utf-8"))
        txt = "".join(str(s.get("v", "")) for s in q.get("stem") or [] if isinstance(s, dict))
        known.setdefault(txt, []).append(q["id"])

    crops = []
    for idx, item in enumerate(ITEMS, 1):
        suf, section, qtype, stem, options, win, printed_no, conf = item
        qid = f"q-{ID_BASE}-{suf:03d}"
        no = idx                                     # no = 卷内阅读顺序，每卷从 1 开始
        bbox = fit(P, win)
        assert bbox, f"{qid} 窗口内无印刷墨迹"
        crop_name = f"{qid}.jpg"
        im.crop(tuple(bbox)).save(ROOT / "data" / "crops" / crop_name, quality=95)

        txt = "".join(str(s.get("v", "")) for s in stem)
        dup = [k for k in known.get(txt, []) if k != qid]

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
                "review_note": NOTE[suf],
            },
            "confidence": conf,
            "created_at": NOW,
            "updated_at": NOW,
        }
        (ROOT / "data" / "questions" / f"{qid}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        crops.append((qid, no, im.crop(tuple(bbox))))
        flag = f"  ⚠️重复({','.join(dup)})" if dup else ""
        print(f"{qid} 第{no}题 {qtype:9s} bbox={bbox} {bbox[2]-bbox[0]:4d}x{bbox[3]-bbox[1]:3d}{flag}")

    CW = 900
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
    out = ROOT / "data" / "samples" / "_crops_check_p7.jpg"
    sheet.save(out, quality=90)
    print("校验图 ->", out.name, sheet.size)


if __name__ == "__main__":
    main()
