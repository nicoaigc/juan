# -*- coding: utf-8 -*-
"""第 8 份卷（第2单元练习卷 · 静安名校，4 页）版面探针。

源图：data/benchmark/2026-10-01-第2单元练习卷-p{1..4}.jpg (1440x1920)
页序：p1 标题/一/二/三/四(3)  p2 四(续4)/五(1,2)  p3 五(4,5,6)  p4 六/七
"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\workspace\ai\shijuan\data\benchmark"
TAG = sys.argv[1] if len(sys.argv) > 1 else "p1"
MODE = sys.argv[2] if len(sys.argv) > 2 else "overview"

a = np.asarray(Image.open(f"{ROOT}/2026-10-01-第2单元练习卷-{TAG}.jpg").convert("RGB")).astype(np.int32)
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
lum = (R * 299 + G * 587 + B * 114) // 1000
mx = np.maximum(np.maximum(R, G), B)
mn = np.minimum(np.minimum(R, G), B)
PRINT = (lum < 118) & (mx - mn < 42)


def cores(x0, x1, y0, y1, thr=22, gap=4, min_h=8):
    prof = PRINT[y0:y1, x0:x1].sum(axis=1)
    rows = np.where(prof >= thr)[0]
    out = []
    if not len(rows):
        return out
    s = prev = rows[0]
    for r in rows[1:]:
        if r - prev > gap:
            if prev - s + 1 >= min_h:
                out.append((y0 + s, y0 + prev + 1, int(prof[s:prev + 1].max())))
            s = r
        prev = r
    if prev - s + 1 >= min_h:
        out.append((y0 + s, y0 + prev + 1, int(prof[s:prev + 1].max())))
    return out


def segs(y0, y1, x0, x1, gap=22, min_w=6, thr=1):
    prof = PRINT[y0:y1, x0:x1].sum(axis=0)
    cs = np.where(prof >= thr)[0]
    out = []
    if not len(cs):
        return out
    s = prev = cs[0]
    for c in cs[1:]:
        if c - prev > gap:
            if prev - s + 1 >= min_w:
                out.append((x0 + s, x0 + prev + 1))
            s = c
        prev = c
    if prev - s + 1 >= min_w:
        out.append((x0 + s, x0 + prev + 1))
    return out


def dump(tag, x0, x1, y0, y1, thr=22, gap=22):
    print(f"\n===== {tag}  (x {x0}-{x1}, y {y0}-{y1}, thr>{thr})")
    for cy0, cy1, pk in cores(x0, x1, y0, y1, thr=thr):
        sg = segs(cy0, cy1, x0, x1, gap=gap)
        ss = "  ".join(f"x{a}-{b}" for a, b in sg)
        print(f"   行核 y {cy0}-{cy1} (h{cy1-cy0}, 峰{pk})   列段: {ss}")


if MODE == "overview":
    dump(f"{TAG} 全页行核", 60, 1180, 0, 1920, thr=25, gap=8)
elif MODE == "col":
    # 逐列扫描：三列口算 + 通用
    for i, (x0, x1) in enumerate([(110, 460), (460, 800), (800, 1180)]):
        dump(f"{TAG} 列{i+1} x{x0}-{x1}", x0, x1, 0, 1920, thr=14, gap=6)
elif MODE == "win":
    x0, x1, y0, y1, thr = (int(v) for v in sys.argv[3:8])
    dump(f"{TAG} win", x0, x1, y0, y1, thr=thr, gap=6)
elif MODE == "curve":
    # 密度曲线：每行打印柱状，st=步长
    x0, x1, y0, y1 = (int(v) for v in sys.argv[3:7])
    st = int(sys.argv[7]) if len(sys.argv) > 7 else 4
    prof = PRINT[y0:y1, x0:x1].sum(axis=1)
    for y in range(0, y1 - y0, st):
        v = int(prof[y:y + st].max())
        print(f"y{y0+y:5d} {v:4d} " + "#" * min(80, v // 4))
