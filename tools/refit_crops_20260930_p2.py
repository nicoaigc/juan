# -*- coding: utf-8 -*-
"""重裁第 2 份卷（2026-09-30 乘法练习卷2）的题区。

背景（用户反馈 q-20260930-050「前面的序号没有去掉」）：
初版用"全页统一行带 + 统一列边界"裁剪，实测暴露三类边界错误：
  1. 板块标题被裁进题区（板块1 第1行、板块2、板块3）；
  2. 同一行不同列的内容纵向错位（扫描件有轻微倾斜，列1 与列4 同排差 40+px），
     统一行带会把相邻行切进来 / 把自己的底部切掉；
  3. 板块5「填空」每题行首的印刷序号（1）（2）（3）被裁进了题区（且左边缘切半个字）。

修法：逐列检测真实的文字行带（自适应二值 + 行投影），把每道题的搜索窗口
严格限制在"只含本题内容"的范围（排除板块标题、排除印刷序号），再在窗口内
自动拟合内容包围盒作为裁剪框。序号本身不丢弃，记入 source.printed_no，
并从题干文本中剔除。

输出：重写 data/crops/*.jpg 与对应 JSON 的 source.bbox / source.printed_no / stem。
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageFilter
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "benchmark" / "2026-09-30-乘法练习卷2.png"
QUESTIONS = ROOT / "data" / "questions"
CROPS = ROOT / "data" / "crops"
SAMPLES = ROOT / "data" / "samples"
TS = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")

# ── 列窗口（相邻两列内容的间隙中点，保证不串列）──────────────
B1_COLS = [(520, 898), (898, 1275), (1275, 1646), (1646, 2150)]
B2_COLS = [(540, 1001), (1001, 1595), (1595, 2200)]
B3_COLS = [(440, 1088), (1088, 1593), (1593, 2200)]
B4_COLS = [(420, 998), (998, 1622), (1622, 2180)]
B5_WIN = [(2392, 2592), (2598, 2684), (2686, 2784)]
# 板块5 各题第一行行带（用于识别序号）
B5_LINE1 = [(2420, 2495), (2605, 2675), (2700, 2770)]
B5_X_TO = 2250

PAD = 8            # 拟合后的留白
GAP = 6            # 行/字间隙合并阈值
CUT = 8            # 判定"序号与正文分界"的间隙阈值
MIN_INK = 2


def build_mask():
    im = Image.open(SRC).convert("L")
    a = np.asarray(im).astype(np.float32)
    bg = np.asarray(im.filter(ImageFilter.GaussianBlur(14))).astype(np.float32)
    return (a < bg - 28).astype(np.int8)


def col_runs(ink, y0, y1, x0, x1, gap=GAP):
    s = ink[y0:y1, x0:x1].sum(axis=0)
    runs, inb, st = [], False, 0
    for x, v in enumerate(s):
        if v > 0 and not inb:
            inb, st = True, x
        elif v == 0 and inb:
            inb = False
            runs.append([st + x0, x + x0])
    if inb:
        runs.append([st + x0, x1])
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return merged


def row_bands(ink, x0, x1, y0, y1, minh=6):
    s = ink[:, x0:x1].sum(axis=1)
    bands, inb, st = [], False, 0
    for y in range(y0, y1):
        if s[y] > 0 and not inb:
            inb, st = True, y
        elif s[y] == 0 and inb:
            inb = False
            if y - st >= minh:
                bands.append((st, y))
    if inb:
        bands.append((st, y1))
    return bands


def heading_band(ink, x0, x1, y0, y1):
    b = row_bands(ink, x0, x1, y0, y1)
    return b[0] if b else None


def drop_heading(bands, head, ratio=0.3):
    if not head:
        return bands
    out = []
    for s, e in bands:
        ov = max(0, min(e, head[1]) - max(s, head[0]))
        if (e - s) > 0 and ov / (e - s) >= ratio:
            continue
        out.append((s, e))
    return out


def fit(ink, win, left_pad=PAD):
    """在窗口内自动拟合内容包围盒（含留白），返回像素 bbox。"""
    x0, y0, x1, y1 = win
    sub = ink[y0:y1, x0:x1]
    rows, cols = sub.sum(axis=1), sub.sum(axis=0)
    ys = np.nonzero(rows >= MIN_INK)[0]
    xs = np.nonzero(cols >= MIN_INK)[0]
    if len(ys) == 0 or len(xs) == 0:
        return tuple(win)
    nx0 = x0 + max(0, xs[0] - left_pad)
    ny0 = y0 + max(0, ys[0] - PAD)
    nx1 = x0 + min(x1 - x0, xs[-1] + 1 + PAD)
    ny1 = y0 + min(y1 - y0, ys[-1] + 1 + PAD)
    return (int(nx0), int(ny0), int(nx1), int(ny1))


def find_leading_marker(ink, y0, y1, x_from=420, x_to=1300):
    """检测行首印刷序号（如「（1）」）：返回序号最后一个墨迹像素的 x，或 None。

    判据：从扫描起点起的第一段连续墨迹（允许字内 ≤GAP 的间隙）宽度在
    20–110px 之间（正好是一个「（N）」的宽度），其后紧跟 ≥CUT 的空白再出现正文。
    """
    runs = col_runs(ink, y0, y1, x_from, x_to, gap=GAP)
    if len(runs) < 2:
        return None
    for i in range(len(runs) - 1):
        if runs[i + 1][0] - runs[i][1] >= CUT:
            st, en = runs[0][0], runs[i][1]
            if st - x_from < 200 and 20 <= en - st <= 110:
                return en
            return None
    return None


def main():
    ink = build_mask()
    print(f"原图 {SRC.name}，尺寸 {ink.shape[1]}x{ink.shape[0]}")

    # 板块标题行带（用于排除）
    heads = {
        "b1": heading_band(ink, 500, 900, 560, 660),
        "b2": heading_band(ink, 500, 900, 900, 985),
        "b3": heading_band(ink, 460, 900, 1340, 1412),
        "b4": heading_band(ink, 420, 900, 1790, 1895),
        "b5": heading_band(ink, 420, 900, 2320, 2390),
    }
    print("板块标题行带：", heads)

    tasks = []   # (qid, window, printed_no)

    # 板块1：4 列 × 3 行（逐列检测行带，排除标题）
    bands_per_col = []
    for c, (x0, x1) in enumerate(B1_COLS, 1):
        b = drop_heading(row_bands(ink, x0, x1, 560, 905), heads["b1"])
        bands_per_col.append(b)
        print(f"  板块1 列{c} 行带 {b}")
    for c, bands in enumerate(bands_per_col):
        assert len(bands) == 3, f"板块1 列{c+1} 行带数异常：{bands}"
        for r, (s, e) in enumerate(bands, 1):
            idx = 25 + (r - 1) * 4 + c + 1        # 026..037
            tasks.append((f"q-20260930-{idx:03d}", (B1_COLS[c][0], s - 6, B1_COLS[c][1], e + 6), None))

    # 板块2 / 板块3：各 3 题，每题一行
    for key, cols, (ys, ye), head, base in (
        ("b2", B2_COLS, (975, 1345), heads["b2"], 38),
        ("b3", B3_COLS, (1412, 1560), heads["b3"], 41),
    ):
        for c, (x0, x1) in enumerate(cols):
            bands = drop_heading(row_bands(ink, x0, x1, ys, ye), head)
            if not bands:
                print(f"  警告：{key} 列{c+1} 未检出内容行带")
                continue
            s, e = bands[0]
            print(f"  {key} 列{c+1} 行带 {(s, e)}  起点 {B3_COLS[0][0] if key=='b3' else B2_COLS[0][0]}")
            tasks.append((f"q-20260930-{base + c:03d}", (x0, s - 6, x1, e + 6), None))

    # 板块4：3 列 × 2 行
    for c, (x0, x1) in enumerate(B4_COLS):
        bands = drop_heading(row_bands(ink, x0, x1, 1895, 2170), heads["b4"])
        print(f"  板块4 列{c+1} 行带 {bands}")
        assert len(bands) == 2, f"板块4 列{c+1} 行带数异常：{bands}"
        for r, (s, e) in enumerate(bands):
            idx = 44 + r * 3 + c              # 044..049（列优先）
            tasks.append((f"q-20260930-{idx:03d}", (x0, s - 6, x1, e + 6), None))

    # 板块5：3 题，行首有印刷序号，需剔除
    for i, (ws, we) in enumerate(B5_WIN):
        m = find_leading_marker(ink, *B5_LINE1[i])
        printed = f"（{i+1}）"
        if m is None:
            print(f"  警告：板块5 第{i+1}题未检出序号，按原位裁剪")
            tasks.append((f"q-20260930-{50 + i:03d}", (440, ws, B5_X_TO, we), None))
        else:
            print(f"  板块5 第{i+1}题 序号结束于 x={m}，题区从 x={m+1} 起")
            tasks.append((f"q-20260930-{50 + i:03d}", (m + 1, ws, B5_X_TO, we), printed))

    # ── 执行裁剪 + 回写 JSON ──────────────────────────────
    im = Image.open(SRC)
    for qid, win, printed in tasks:
        jp = QUESTIONS / f"{qid}.json"
        if not jp.exists():
            print(f"  跳过 {qid}：JSON 不存在")
            continue
        d = json.loads(jp.read_text(encoding="utf-8"))
        new_bbox = fit(ink, win, left_pad=0 if printed else PAD)
        im.crop(new_bbox).save(CROPS / f"{qid}.jpg", quality=94)
        old = tuple(d["source"]["bbox"])
        d["source"]["bbox"] = list(new_bbox)
        if printed:
            d["source"]["printed_no"] = printed
            # 题干剔除行首序号
            for blk in d["stem"]:
                if blk.get("t") == "text" and blk["v"].startswith(printed):
                    blk["v"] = blk["v"][len(printed):]
                    break
        d["updated_at"] = TS
        jp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        moved = sum(abs(a - b) for a, b in zip(old, new_bbox))
        print(f"  {qid} bbox {old} -> {new_bbox}  (偏移合计 {moved}px)")

    # ── 校验图 ────────────────────────────────────────────
    ims = [(q, Image.open(CROPS / f"{q}.jpg")) for q, _, _ in tasks]
    cw = 300
    thumbs = [(q, i.resize((cw, max(24, int(i.height * cw / i.width))))) for q, i in ims]
    per_row, pad_gap = 5, 8
    rows = [thumbs[i:i + per_row] for i in range(0, len(thumbs), per_row)]
    rh = [max(t.height for _, t in r) for r in rows]
    sheet = Image.new("RGB", (cw * per_row, sum(rh) + pad_gap * len(rows)), "#e5e7eb")
    y = 0
    for r, h in zip(rows, rh):
        for i, (_, t) in enumerate(r):
            sheet.paste(t, (i * cw, y))
        y += h + pad_gap
    out = SAMPLES / "_crops_check_p2.jpg"
    sheet.save(out, quality=90)
    print(f"\n重裁 {len(tasks)} 题；校验图 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
