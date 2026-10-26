# -*- coding: utf-8 -*-
"""插图框吸附：**app/js/refine.js 的 `snapFigures` 的 Python 孪生**。

两边的参数（FIG_DEFAULTS / FIG_PX_KEYS）、判据、兜底规则**必须逐条同步**；
对账用 `tools/figsnap_eval.py`（在这边跑）与 `tools/figsnap_js_check.mjs`
（把 refine.js 注入浏览器跑同一批样本，逐张比两边的框）。

为什么插图要单独一套，不能复用题区的「行带 + 单调对齐 DP」：
  · 那套的 `hmin/hmax`(16~95) 是**文字行**的高度上限，插图块高 150~300，
    第一关就被整个滤掉；
  · 行带 DP 解决的是「模型行 → 版面行」的**顺序对应**，而插图的错法是**边界**：
    框会偏（paper6 的 q35 整段落在广告下方 150px 的空白里）、会太小
    （q29/q37 只罩住图形块的一部分）、会伸进旁边的题面文字或学生笔迹
    （q30 混进题面印刷字、q32 混进学生「406」）。等量外扩只会把错误放大。

判据（沿 refine 的「有墨就长、没墨就停」思路，但从「点」换成「段」）：
  ① 搜索窗 ROI = 模型框外扩 max(roi, roiRatio×框宽/高)；
  ② 在 ROI 里对**行**投影分段（允许块内部 ≤gapY 的白——图形块内部本来就有白）；
  ③ 选**与模型框 y 区间重叠最大**的那一段。⚠️ 不能只看「模型框中心落在哪一段」：
     模型框可能整个落在图形块外面（q35 就是这样），中心落在空白里，一找就错；
  ④ 在该行段里同样处理**列**，选与模型框 x 区间重叠最大的一段；
  ⑤ 行列互换再跑一遍收敛；外缘补 pad（图形块的边框线不能被切）；
  ⑥ 每条边最多向外走 max(msMin, msFrac×框宽/高)。不设上限的话，密集页上会顺着
     相邻文字行连成一片（q30 会从图形块一路吃到题面文字，面积涨到 4.2 倍）。

兜底：任何一步失败 / ROI 太小 / 面积 > maxGrow×模型框 / 比模型框小到 minScale 以下
→ **这一张图不进结果字典**，调用方（recognize.js 的 toRow）退回老的
「外扩 min(w,h)×25%（30~80px）」。逐张独立兜底，所以**绝不比改动前差**。

实测（9 张人工逐像素核过的插图框：paper6「1011」的 7 张 + 语料里 2 张有模型原始框的）：
    平均 IoU 0.564（外扩）→ **0.817**（吸附）；最差一例 0.601（外扩最差 0.198）；
    没有一例低于 0.5、没有一例比外扩差（q30 / q37 两条走兜底，保持原样）。
    q35 0.198→0.792 · q32 0.587→0.852 · q39甲 0.400→0.742
    泳道图 0.487→0.947 · 电梯标牌 0.499→0.976
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from refine_proto import INK_CHROMA, ink_mask, resolve_ink_lum

# ⚠️ 与 app/js/refine.js 的 FIG_DEFAULTS 一字不差地对应。
# 单位 = **工作分辨率的像素**（长边 = work_max 的那个坐标系），与 refine.js 同口径。
FIG_DEFAULTS = {
    "work_max": 1600,
    "roi": 90,          # 搜索窗至少外扩这么多 px
    "roi_ratio": 0.75,  # 或外扩「框宽/高 × 该比例」，取大者
    "gap_y": 14,        # 纵向：块内文字行之间允许的白（px）
    "gap_x": 10,        # 横向
    "th_frac": 0.024,   # 「这一行/列有墨」= 墨像素 ≥ 该比例 × 采样长度
    "th_min": 3,
    "min_len_y": 12,    # 一条行段至少这么高才算内容（滤噪点）
    "min_len_x": 12,
    "pad": 8,           # 外缘再补的余量
    "ms_frac": 0.7,     # 每条边最多向外移动「框宽/高 × 该比例」
    "ms_min": 45,       # 或者至少这么多 px（取大者）
    "max_grow": 2.4,    # 面积 / 模型框面积 的上限（超过 → 兜底）
    "min_scale": 0.4,   # 宽或高小于「模型框 × 该比例」→ 兜底
    "bar_frac": 0.85,   # 整行/列墨占比超过它 → 判为照片黑边（手机截图上下黑条）
}
FIG_PX_KEYS = ("roi", "gap_y", "gap_x", "th_min", "min_len_y", "min_len_x", "pad", "ms_min")


def fig_params(over: dict | None = None) -> dict:
    p = dict(FIG_DEFAULTS)
    if over:
        p.update({k: v for k, v in over.items() if v is not None})
    return p


def fig_scale(p: dict, s: float) -> dict:
    q = dict(p)
    for k in FIG_PX_KEYS:
        q[k] = q[k] * s
    q["min_len_y"] = max(3, q["min_len_y"])
    q["min_len_x"] = max(3, q["min_len_x"])
    q["th_min"] = max(2, q["th_min"])
    return q


def load_ink_work(path, work_max: int = 1600):
    """按工作分辨率算墨掩膜。返回 (原图宽, 原图高, scale, ink, 实际亮度阈值)。"""
    img = Image.open(path).convert("RGB")
    W0, H0 = img.size
    s = min(1.0, work_max / max(W0, H0)) if work_max > 0 else 1.0
    w, h = max(1, round(W0 * s)), max(1, round(H0 * s))
    if (w, h) != (W0, H0):
        img = img.resize((w, h), Image.LANCZOS)
    arr = np.asarray(img)
    thr = resolve_ink_lum(arr)
    return W0, H0, s, ink_mask(arr, thr, INK_CHROMA), thr


def fig_content_area(ink: np.ndarray, bar_frac: float):
    """照片里被手机黑边/桌面压住的行列要排除（paper6 上下各有一条截图黑边）。
    判据：整行/整列的墨占比 > bar_frac —— 真实卷面不可能有那么满。"""
    H, W = ink.shape
    rf = ink.mean(axis=1)
    cf = ink.mean(axis=0)
    y0 = 0
    while y0 < H and rf[y0] > bar_frac:
        y0 += 1
    y1 = H
    while y1 > y0 and rf[y1 - 1] > bar_frac:
        y1 -= 1
    x0 = 0
    while x0 < W and cf[x0] > bar_frac:
        x0 += 1
    x1 = W
    while x1 > x0 and cf[x1 - 1] > bar_frac:
        x1 -= 1
    return x0, y0, x1, y1


def fig_segments(prof: np.ndarray, th: float, gap: int, min_len: int):
    """一维投影 → 段：墨 ≥th 的连续段，间隔 ≤gap 的合并，短于 min_len 的丢掉。"""
    raw: list[list[int]] = []
    s = -1
    for i, v in enumerate(prof):
        if v >= th:
            if s < 0:
                s = i
        elif s >= 0:
            raw.append([s, i])
            s = -1
    if s >= 0:
        raw.append([s, len(prof)])
    merged: list[list[int]] = []
    for a, b in raw:
        if merged and a - merged[-1][1] <= gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [x for x in merged if x[1] - x[0] >= min_len]


def fig_pick(segs, a, b):
    """挑与 [a,b] 重叠最大的段；全都压不上就挑中心最近的那段。"""
    if not segs:
        return None
    best, bv = None, -1
    for s in segs:
        ov = min(b, s[1]) - max(a, s[0])
        if ov > bv:
            bv, best = ov, s
    if bv > 0:
        return best
    c = (a + b) / 2.0
    return min(segs, key=lambda s: abs((s[0] + s[1]) / 2.0 - c))


def _prof_rows(ink, x1, x2, y1, y2):
    return ink[y1:y2 + 1, x1:x2 + 1].sum(axis=1).astype(np.float64)


def _prof_cols(ink, y1, y2, x1, x2):
    return ink[y1:y2 + 1, x1:x2 + 1].sum(axis=0).astype(np.float64)


def fig_snap_core(ink, w, h, box, p, area, dbg=None):
    """单张插图吸附（工作坐标系）。返回 [x1,y1,x2,y2] 或 None（None = 走兜底）。"""
    if dbg is None:
        dbg = {}
    ax0, ay0, ax1, ay1 = area
    x1, y1, x2, y2 = [float(v) for v in box]
    bw, bh = max(1.0, x2 - x1), max(1.0, y2 - y1)
    rw = max(p["roi"], p["roi_ratio"] * bw)
    rh = max(p["roi"], p["roi_ratio"] * bh)
    rx1 = int(max(ax0, np.floor(x1 - rw))); rx2 = int(min(ax1 - 1, np.ceil(x2 + rw)))
    ry1 = int(max(ay0, np.floor(y1 - rh))); ry2 = int(min(ay1 - 1, np.ceil(y2 + rh)))
    if rx2 - rx1 < 12 or ry2 - ry1 < 12:
        dbg["why"] = "roi"
        return None

    cur = [rx1, ry1, rx2, ry2]
    for _ in range(2):
        prof = _prof_rows(ink, cur[0], cur[2], ry1, ry2)
        th = max(p["th_min"], p["th_frac"] * (cur[2] - cur[0]))
        pk = fig_pick(fig_segments(prof, th, int(p["gap_y"]), int(p["min_len_y"])), y1 - ry1, y2 - ry1)
        if pk is None:
            dbg["why"] = "no-row-band"
            return None
        ny1, ny2 = ry1 + pk[0], ry1 + pk[1]
        prof = _prof_cols(ink, ny1, ny2, cur[0], cur[2])
        th = max(p["th_min"], p["th_frac"] * (ny2 - ny1))
        pk = fig_pick(fig_segments(prof, th, int(p["gap_x"]), int(p["min_len_x"])), x1 - cur[0], x2 - cur[0])
        if pk is None:
            dbg["why"] = "no-col-band"
            return None
        nx1, nx2 = cur[0] + pk[0], cur[0] + pk[1]
        cur = [nx1, ny1, nx2, ny2]
        rx1, rx2, ry1, ry2 = nx1, nx2, ny1, ny2

    ox1 = max(ax0, cur[0] - p["pad"]); oy1 = max(ay0, cur[1] - p["pad"])
    ox2 = min(ax1, cur[2] + p["pad"]); oy2 = min(ay1, cur[3] + p["pad"])
    sx = max(p["ms_min"], p["ms_frac"] * bw); sy = max(p["ms_min"], p["ms_frac"] * bh)
    ox1 = max(ox1, x1 - sx); ox2 = min(ox2, x2 + sx)
    oy1 = max(oy1, y1 - sy); oy2 = min(oy2, y2 + sy)
    dbg["band"] = [int(ox1), int(oy1), int(ox2), int(oy2)]
    if ox2 - ox1 < 8 or oy2 - oy1 < 8:
        dbg["why"] = "too-small"
        return None
    if ox2 - ox1 < p["min_scale"] * bw or oy2 - oy1 < p["min_scale"] * bh:
        dbg["why"] = "min_scale"
        return None
    if (ox2 - ox1) * (oy2 - oy1) > p["max_grow"] * bw * bh:
        dbg["why"] = "max_grow %.2f" % ((ox2 - ox1) * (oy2 - oy1) / (bw * bh))
        return None
    return [int(ox1), int(oy1), int(ox2), int(oy2)]


def snap_figures(path, boxes, params: dict | None = None, return_lum: bool = False):
    """boxes: [(key, [x1,y1,x2,y2]), ...]（**原图像素**）→ {key: [x1,y1,x2,y2]}。

    只包含吸附成功的项；没进字典的由调用方走「外扩 25%」兜底。
    与 app/js/refine.js 的 `Refine.snapFigures` 同签名同语义。
    """
    p0 = fig_params(params)
    W0, H0, s, ink, thr = load_ink_work(path, int(p0["work_max"]))
    p = fig_scale(p0, s)
    area = fig_content_area(ink, p["bar_frac"])
    out = {}
    for key, b in boxes:
        if not b or len(b) < 4:
            continue
        r = fig_snap_core(ink, ink.shape[1], ink.shape[0],
                          [b[0] * s, b[1] * s, b[2] * s, b[3] * s], p, area)
        if r is None:
            continue
        inv = 1.0 / s
        out[key] = [int(min(max(round(r[0] * inv), 0), W0)), int(min(max(round(r[1] * inv), 0), H0)),
                    int(min(max(round(r[2] * inv), 0), W0)), int(min(max(round(r[3] * inv), 0), H0))]
    return (out, thr) if return_lum else out
