# -*- coding: utf-8 -*-
"""坐标校正原型：把模型的"大致框"吸附到真实的印刷内容边界。

为什么需要：实测 deepseek-v4.1-flash 即使看着带刻度的图，输出的坐标也是"按版式铺开"的
（同一列 y 值整齐地取 60 的倍数、三列 x 固定在 175/520/890），误差 30~60px。
对"紧贴内容"的裁剪来说这仍是致命的（60px 高的框偏 58px 就只剩 2px 交叠）。

做法（全部在**模型框附近的小窗口**内做，避开桌面/手指/页边等背景）：
  1. 印刷黑掩膜：lum < LUM 且 max(RGB)-min(RGB) < CHROMA —— 滤掉彩色笔迹与浅灰阴影
  2. 从模型框的**中心**向上下扫，遇到连续 GAPY 行空白就停 → 真实的 y 边界
  3. 在定好的 y 范围里向左右扫，遇到连续 GAPX 列空白就停 → 真实的 x 边界
  4. 若校正后的框与模型框差得太远（或压根没找到内容），回退用模型框

这一步是**纯前端也要做**的（相机就在浏览器里），所以先在这里把参数调好、把效果验证出来，
再照搬进 JS。

用法：
    python tools/coord_refine_proto.py --image data/benchmark/xxx.jpg \
           --pred .workbuddy/tmp/recog_pilot/pilot2d.parsed.json [--paper <人工标注的 source.file>]
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

LUM = 118          # 印刷墨迹的亮度上限
CHROMA = 42        # 最大通道差上限：超过就是彩色（蓝/红笔迹、色块）


def ink_mask(arr: np.ndarray) -> np.ndarray:
    """印刷黑掩膜。arr 为 HxWx3 的 int32。"""
    lum = (arr[:, :, 0] * 299 + arr[:, :, 1] * 587 + arr[:, :, 2] * 114) // 1000
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    return (lum < LUM) & ((mx - mn) < CHROMA)


def scan(prof: np.ndarray, center: int, thr: float, gap: int, forward: bool) -> int:
    """从 center 沿一个方向扫，返回内容块的**外侧边界**。

    prof：投影剖面；thr：判定"这一行/列有内容"的阈值；gap：连续多少空行算一个分界。
    """
    n = len(prof)
    blank = 0
    idx = range(center, n) if forward else range(center, -1, -1)
    last_content = center
    for i in idx:
        if prof[i] <= thr:
            blank += 1
            if blank >= gap:
                return last_content
        else:
            blank = 0
            last_content = i
    return last_content


def refine_one(arr: np.ndarray, bbox, pad: int, gapy: int, gapx: int,
               ty_ratio: float, tx_ratio: float, max_shift: int):
    """把模型框吸附到真实内容边界。返回 (新 bbox, 是否成功)。"""
    H, W = arr.shape[:2]
    x1, y1, x2, y2 = [int(round(v)) for v in bbox[:4]]
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

    # 窗口：模型框外扩 pad，并裁到图片内
    wx1, wy1 = max(0, x1 - pad), max(0, y1 - pad)
    wx2, wy2 = min(W, x2 + pad), min(H, y2 + pad)
    if wx2 - wx1 < 20 or wy2 - wy1 < 20:
        return bbox, False

    win = arr[wy1:wy2, wx1:wx2]
    mask = ink_mask(win)
    h, w = mask.shape
    ty = max(6.0, ty_ratio * w)
    tx = max(2.0, tx_ratio * h)

    ccx = min(max(cx - wx1, 0), w - 1)
    ccy = min(max(cy - wy1, 0), h - 1)

    prof_y = mask.sum(axis=1)
    top = scan(prof_y, ccy, ty, gapy, forward=False)
    bot = scan(prof_y, ccy, ty, gapy, forward=True)

    sub = mask[top:bot + 1, :]
    prof_x = sub.sum(axis=0)
    left = scan(prof_x, ccx, tx, gapx, forward=False)
    right = scan(prof_x, ccx, tx, gapx, forward=True)

    # 只有上下/左右都真的找到了内容才算成功
    if prof_y[top] <= ty and prof_y[bot] <= ty:
        return bbox, False
    if prof_x[left] <= tx and prof_x[right] <= tx:
        return bbox, False

    nx1, ny1, nx2, ny2 = wx1 + left, wy1 + top, wx1 + right + 1, wy1 + bot + 1
    # 偏移过大说明吸到别的题上了 —— 宁可用模型框
    if max(abs(nx1 - x1), abs(ny1 - y1), abs(nx2 - x2), abs(ny2 - y2)) > max_shift:
        return bbox, False
    # 结果太小也不可信
    if nx2 - nx1 < 20 or ny2 - ny1 < 14:
        return bbox, False
    return [nx1, ny1, nx2, ny2], True


def iou(a, b):
    ax1, ay1, ax2, ay2 = a[:4]
    bx1, by1, bx2, by2 = b[:4]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--pred", required=True)
    ap.add_argument("--paper", default=None, help="人工标注的 source.file（不给就用图片名）")
    ap.add_argument("--pad", type=int, default=80)
    ap.add_argument("--gapy", type=int, default=8)
    ap.add_argument("--gapx", type=int, default=24)
    ap.add_argument("--ty", type=float, default=0.010)
    ap.add_argument("--tx", type=float, default=0.012)
    ap.add_argument("--max-shift", type=int, default=110)
    ap.add_argument("--out", default=".workbuddy/tmp/recog_pilot/refine_check")
    a = ap.parse_args()

    img_path = Path(a.image)
    im = Image.open(img_path).convert("RGB")
    arr = np.asarray(im).astype(np.int32)

    pred = json.loads(Path(a.pred).read_text(encoding="utf-8"))
    qs = pred.get("questions") or []

    paper = a.paper or img_path.name
    truth = {}
    for fp in glob.glob("data/questions/*.json"):
        d = json.loads(Path(fp).read_text(encoding="utf-8"))
        if (d.get("source") or {}).get("file") == paper:
            truth[d["no"]] = d["source"]["bbox"]

    print("%-4s %-24s %-24s %-24s %-7s %-7s" % ("no", "模型框", "校正后", "人工", "IoU前", "IoU后"))
    print("-" * 106)
    out_rows, before, after = [], [], []
    for q in qs:
        no = q.get("no")
        mb = q.get("bbox")
        if not mb:
            continue
        rb, ok = refine_one(arr, mb, a.pad, a.gapy, a.gapx, a.ty, a.tx, a.max_shift)
        q["refined_bbox"] = rb
        q["refined_ok"] = ok
        tb = truth.get(no)
        s_before = s_after = None
        if tb:
            s_before, s_after = iou(mb, tb), iou(rb, tb)
            before.append(s_before)
            after.append(s_after)
        out_rows.append((no, mb, rb, tb, ok, s_before, s_after))
        print("%-4s %-24s %-24s %-24s %-7s %-7s %s" % (
            no, str(mb), str(rb), str(tb) if tb else "-",
            ("%.2f" % s_before) if s_before is not None else "-",
            ("%.2f" % s_after) if s_after is not None else "-",
            "" if ok else "← 回退"))

    if before:
        print()
        print("平均 IoU：校正前 %.3f  ->  校正后 %.3f" % (sum(before) / len(before), sum(after) / len(after)))
        print("IoU ≥ 0.85 的题数：校正前 %d/%d  ->  校正后 %d/%d" % (
            sum(1 for v in before if v >= 0.85), len(before),
            sum(1 for v in after if v >= 0.85), len(after)))
        print("成功吸附：%d / %d" % (sum(1 for r in out_rows if r[4]), len(out_rows)))

    # ---------- 校验图：模型框 / 校正框 / 人工框 各裁一份并排 ----------
    tiles = []
    for no, mb, rb, tb, ok, sb, sa in out_rows:
        for who, bb in (("模型", mb), ("校正", rb), ("人工", tb)):
            if not bb:
                continue
            x1, y1, x2, y2 = [int(v) for v in bb]
            x1, y1 = max(0, x1 - 6), max(0, y1 - 6)
            x2, y2 = min(im.width, x2 + 6), min(im.height, y2 + 6)
            c = im.crop((x1, y1, x2, y2))
            tiles.append(("%s n=%s" % (who, no), c))

    if tiles:
        pad, lab, cols = 10, 20, 6
        tw = max(1, max(t[1].width for t in tiles))
        th = max(1, max(t[1].height for t in tiles)) + lab
        rows = (len(tiles) + cols - 1) // cols
        out = Image.new("RGB", (cols * (tw + pad) + pad, rows * (th + pad) + pad), (255, 255, 255))
        d = ImageDraw.Draw(out)
        for i, (lb, c) in enumerate(tiles):
            r, cc = divmod(i, cols)
            x, y = pad + cc * (tw + pad), pad + r * (th + pad)
            d.rectangle([x - 2, y - 2, x + tw + 1, y + th + 1], outline=(205, 70, 70))
            d.text((x + 2, y + 3), lb, fill=(0, 0, 0))
            out.paste(c, (x, y + lab))
        p = Path(a.out + ".jpg")
        p.parent.mkdir(parents=True, exist_ok=True)
        out.save(p, quality=86)
        print("\n校验图 ->", p, out.size)

    out_json = Path(a.out + ".json")
    out_json.write_text(json.dumps(pred, ensure_ascii=False, indent=1), encoding="utf-8")
    print("校正结果 ->", out_json)


if __name__ == "__main__":
    main()
