# -*- coding: utf-8 -*-
"""版面探针：定位「印刷题目的行核」与「列段」——每识别一份新卷都先跑它。

为什么需要它（2026-10-01 第 6 份卷实测的教训）：
  第 6 份卷笔迹极多（红笔批改 + 铅笔作答），**灰度二值化会把题目行与笔迹连成一条大带**，
  行投影完全失效。解决办法是**按颜色分离**：
    印刷黑 = 低亮度 + 低彩度（lum<118 且 max(RGB)-min(RGB)<42）
    红笔   = R 明显高于 G/B
    铅笔   = 浅灰（lum 140–215）
  实测印刷行核的墨迹密度 50–140，而笔迹带只有 5–25 —— 用密度阈值找行核非常稳。

用法：改下面 SRC 与末尾的 dump(...) 窗口（窗口就是「一列里只含某一道题」的矩形），
      跑出来每段会给出「行核 y 区间 + 该行内的列段 x 区间」，据此写 ingest 脚本的窗口。
      窗口给得比内容略大即可（拟合会自动贴合墨迹），关键是**不要把邻列/邻题/板块标题包进来**。
运行时用隔离环境：C:\\Users\\1\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe
"""
import numpy as np
from PIL import Image

SRC = r"D:\workspace\ai\shijuan\data\benchmark\2026-10-01-第一二单元素养卷.jpg"
a = np.asarray(Image.open(SRC).convert("RGB")).astype(np.int32)
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
lum = (R * 299 + G * 587 + B * 114) // 1000
mx = np.maximum(np.maximum(R, G), B)
mn = np.minimum(np.minimum(R, G), B)
PRINT = (lum < 118) & (mx - mn < 42)


def cores(x0, x1, y0, y1, thr=22, gap=4, min_h=8):
    """密度峰值段 = 印刷行核。"""
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


def dump(tag, x0, x1, y0, y1, thr=22):
    print(f"\n===== {tag}  (x {x0}-{x1}, y {y0}-{y1}, thr>{thr})")
    for cy0, cy1, pk in cores(x0, x1, y0, y1, thr=thr):
        sg = segs(cy0, cy1, x0, x1)
        ss = "  ".join(f"x{a}-{b}" for a, b in sg)
        print(f"   行核 y {cy0}-{cy1} (h{cy1-cy0}, 峰{pk})   列段: {ss}")


# ---- 口算区：三个列窗口
dump("口算 左列", 215, 500, 225, 415)
dump("口算 中列", 505, 815, 225, 425)
dump("口算 右列", 830, 1180, 210, 470)

# ---- 递等式：三列
dump("递等式 左", 210, 560, 505, 660, thr=18)
dump("递等式 中", 570, 910, 505, 660, thr=18)
dump("递等式 右", 935, 1260, 505, 670, thr=15)

# ---- 竖式：四列
dump("竖式 1", 180, 440, 755, 970, thr=18)
dump("竖式 2", 450, 715, 755, 970, thr=18)
dump("竖式 3", 720, 1000, 755, 975, thr=18)
dump("竖式 4", 995, 1260, 755, 975, thr=18)

# ---- 综合算式：两列
dump("综合 左", 150, 570, 1050, 1150, thr=18)
dump("综合 右", 610, 1100, 1045, 1150, thr=18)

# ---- 列式计算：两题
dump("列式计算 (1)", 130, 1240, 1335, 1420, thr=18)
dump("列式计算 (2)", 130, 1240, 1495, 1580, thr=18)
