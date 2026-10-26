# -*- coding: utf-8 -*-
"""诊断：本地"行带 + 列块"检测在真实试卷上到底靠不靠得住。

⚠️ 本脚本刻意用的是**全页统一行投影**，也就是项目规范明确禁止的那个做法。
   所以它跑出来的失败**只能说明"朴素做法不行"**，不能说明"本地版面分析不行"。
   2026-10-05 复查确认真因是：卷面印的田字格竖线属印刷黑（色差阈值收不掉），
   再叠加拍照的手指/桌面/阴影。逐列行投影 + 干扰剔除的做法**还没有被这个脚本测过**。

思路的由来：模型即使看着带刻度的图，坐标也是"按版式铺开"的（同一列 y 整齐取 60 的倍数），
误差 30~60px；但**它的顺序和行分组是准的**（把 24 题分成 9 行，与人工标注的 9 行完全一致）。
所以几何交给本地检测、模型只提供"顺序 + 文字"，才是有希望的组合。

本脚本只做检测并打印 + 出图，供目视判断，不做任何对齐。

用法：
    python tools/layout_blocks_probe.py --image data/benchmark/xxx.jpg [--truth]
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

LUM = 118
CHROMA = 42


def ink_mask(arr: np.ndarray, lum_thr: float = LUM, chroma_thr: float = CHROMA) -> np.ndarray:
    """印刷黑掩膜：够暗 + 色彩够淡（学生笔迹若是蓝/红笔会被这条排除掉）。
    亮度必须先转 int32 —— uint8 上做 *299 会溢出回绕（踩过）。"""
    lum = (arr[:, :, 0] * 299 + arr[:, :, 1] * 587 + arr[:, :, 2] * 114) // 1000
    return (lum < lum_thr) & ((arr.max(axis=2) - arr.min(axis=2)) < chroma_thr)


def bands(prof: np.ndarray, thr: float, gap: int):
    """把剖面切成若干"有内容"的带：[start, end]，中间允许间隔 < gap 的空洞。"""
    on = prof > thr
    out = []
    i = 0
    n = len(on)
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        last = i
        while j < n:
            if on[j]:
                last = j
                j += 1
            else:
                # 向后看 gap 行，若 gap 内还有内容就并进来
                k = j
                while k < n and k - j < gap and not on[k]:
                    k += 1
                if k < n and on[k]:
                    j = k
                else:
                    break
        out.append((i, last))
        i = max(j, last + 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--paper", default=None)
    ap.add_argument("--ty", type=float, default=0.010, help="行阈值 = 该系数 × 图宽")
    ap.add_argument("--gapy", type=int, default=4, help="行带内允许的空白高度")
    ap.add_argument("--tx", type=float, default=0.014, help="列阈值 = 该系数 × 带高")
    ap.add_argument("--gapx", type=int, default=26, help="列块内允许的空白宽度")
    ap.add_argument("--lum", type=float, default=LUM, help="印刷黑掩膜：亮度上限")
    ap.add_argument("--chroma", type=float, default=CHROMA,
                    help="印刷黑掩膜：色差上限（越小越只认灰黑印刷体；学生用黑笔时这里分不开）")
    ap.add_argument("--out", default=".workbuddy/tmp/recog_pilot/layout_probe.jpg")
    a = ap.parse_args()

    im = Image.open(a.image).convert("RGB")
    arr = np.asarray(im).astype(np.int32)
    H, W = arr.shape[:2]
    mask = ink_mask(arr, a.lum, a.chroma)

    ty = max(4.0, a.ty * W)
    prof_y = mask.sum(axis=1)
    rows = bands(prof_y, ty, a.gapy)
    print(f"图 {W}×{H}   行阈值 {ty:.0f}   检测到 {len(rows)} 个行带\n")

    paper = a.paper or Path(a.image).name
    truth = []
    for fp in glob.glob("data/questions/*.json"):
        d = json.loads(Path(fp).read_text(encoding="utf-8"))
        if (d.get("source") or {}).get("file") == paper:
            truth.append((d["no"], d["source"]["bbox"]))
    truth.sort()

    print("%-4s %-16s %-7s %s" % ("行", "y 区间", "高", "列块（x 区间 / 宽的百分比）"))
    print("-" * 100)
    vis = im.copy()
    d = ImageDraw.Draw(vis)

    for i, (y1, y2) in enumerate(rows):
        h = y2 - y1 + 1
        tx = max(2.0, a.tx * h)
        sub = mask[y1:y2 + 1, :]
        prof_x = sub.sum(axis=0)
        cols = bands(prof_x, tx, a.gapx)
        desc = "  ".join("[%d..%d w=%d]" % (c1, c2, c2 - c1 + 1) for c1, c2 in cols)
        print("%-4d %-16s %-7d %s" % (i + 1, f"{y1}..{y2}", h, desc[:120]))
        d.rectangle([0, y1, W - 1, y2], outline=(0, 150, 80), width=2)
        d.text((4, y1 + 2), "R%d" % (i + 1), fill=(0, 120, 60))
        for c1, c2 in cols:
            d.rectangle([c1, y1, c2, y2], outline=(220, 120, 0), width=1)

    # 人工标注叠一层（蓝框），方便直接比对
    for no, b in truth:
        d.rectangle([b[0], b[1], b[2], b[3]], outline=(40, 90, 220), width=2)
        d.text((b[0] + 2, b[1] + 1), str(no), fill=(40, 90, 220))

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    vis.save(out, quality=84)
    print(f"\n叠加图 -> {out}（绿=检测到的行带，橙=检测到的列块，蓝=人工标注）")

    # 统计：人工的每个题是否被某个"列块"覆盖住
    print("\n【人工标注 vs 检测块 的覆盖检查】")
    allcols = []
    for y1, y2 in rows:
        h = y2 - y1 + 1
        tx = max(2.0, a.tx * h)
        for c1, c2 in bands(mask[y1:y2 + 1, :].sum(axis=0), tx, a.gapx):
            allcols.append((y1, y2, c1, c2))
    hit = miss = 0
    for no, b in truth:
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        best = None
        for (y1, y2, c1, c2) in allcols:
            if y1 - 12 <= cy <= y2 + 12 and c1 - 12 <= cx <= c2 + 12:
                area = (y2 - y1) * (c2 - c1)
                if best is None or area < best[0]:
                    best = (area, (y1, y2, c1, c2))
        if best:
            y1, y2, c1, c2 = best[1]
            # 覆盖度：真值框有多少比例落在检测块里
            ix = max(0, min(b[2], c2) - max(b[0], c1))
            iy = max(0, min(b[3], y2) - max(b[1], y1))
            cov = (ix * iy) / max(1, (b[2] - b[0]) * (b[3] - b[1]))
            print("  no=%-3s 检测块 y%d..%d x%d..%d  覆盖 %.2f" % (no, y1, y2, c1, c2, cov))
            hit += 1 if cov >= 0.9 else 0
            miss += 1 if cov < 0.9 else 0
        else:
            print("  no=%-3s 未找到对应检测块（中心 %d,%d）" % (no, cx, cy))
            miss += 1
    print("  完整覆盖(≥0.90)：%d / %d   有缺口：%d" % (hit, len(truth), miss))


if __name__ == "__main__":
    main()
