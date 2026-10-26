# -*- coding: utf-8 -*-
"""路线 A 原型：模型给粗框 + 顺序，本地把边界吸附到真实墨迹。

为什么要这样设计（别重走弯路）
--------------------------------------------------------------------
① 纯"从模型框中心向外吸附"失败过（见 tools/coord_refine_proto.py）：模型框中心
   本身已偏到相邻行（行高 40、行距 62，偏 46px 就跨行），必然吸错。

② "响应最大"也是错的（本脚本 v2 实测）：全页扫一遍，**最大的墨迹响应永远是
   右下角的桌面/阴影**（覆盖率 0.72），9 个模型行全被吸到 y≈1870。
   → 目标函数不能是"墨迹最多"，必须是"**结构像不像一行题**"。

③ 结构判据 v3（**已被 v5 取代，别再用**）：题目行会在**模型的每个列框**里都留下
   一段"横向较长的连续墨迹"；板块标题只横跨第一列。
   这条对**模型框位置极其敏感**：同一张图两次识别，模型把最右列给窄了 70px，
   窗跟着变，真值行的判定分从 0.60 掉到 0.12 被误剔除，整页回退。
   v5 起判据**完全不看模型框**（只看整页版面结构）；"行带高度 16~95px 挡掉卷头/阴影"
   这条保留。

④ **v5 的两个关键修正**（都来自"密集页第 2 次识别整页错位一格"的复盘）：
   4.1 判据必须**把 x 限制在行投影范围内**。用整页宽度时，右页边/黑桌面的墨迹会
       凭空造出第二段，"多段 = 题目行"于是把两条板块标题判成题目行。
   4.2 分段 DP 必须**允许跳过行带**。旧版要求"所有行带都被 K 段覆盖"，板块标题
       只好硬塞进某段；而当"标题带"与"题目带"之间隔着 326px 时，正确的分段
       （标题独立）根本不可行 → DP 退而求其次做整体错位一格。
       配套：**禁止把"非题目带"单独当成一道题**（q_pen），否则 DP 会为了省距离
       把「三、在○里填入…」这条标题带派给第 1 道题。
   4.3 DP 里**必须显式枚举"上一段的终点"**。只记 dp[r-1][0..i-1] 的最小值，
       那个最便宜的解可能被"不许跳过题目带"否决，次便宜的可行解就此丢失 →
       明明唯一的 1:1 解被判成"不可行"、整页退回模型框。

⑤ **v5.2 的三个修正**（都来自"扩样本到 5 张卷 10 次识别"时暴露的新失败）：
   5.1 **墨掩膜的亮度阈值必须自适应**（`resolve_ink_lum`）。固定 118 在偏暗的照片上
       会把纸面/阴影都算成墨：`2026-09-30-小学练习页.jpg` 墨占比 35.86%（密集页
       15.04%），行投影没有谷 → 扩展超 hmax 被整段丢弃 → 真值 4 行一条没检出，
       覆盖率 0.778 → 0.026。改用 `min(118, 0.68 × 纸面75分位)`：四张曝光正常的卷
       算出 125/173/173/173 → 仍取 118（**结果与改动前逐位一致**），只有偏暗那张
       落到 97。⚠️ 试过 Otsu×0.85（密集页=94）**不行**：peak_min/hmax 是按 118 那套
       掩膜的尺度调的，掩膜一变峰结构就变，密集页 0.948 → 0.884。
   5.2 **判"单段/多段"前先剔掉窄于 `seg_min_frac×页宽` 的碎片**。板块标题
       「二、用竖式计算。」那条带 = 标题(257px) + 一小坨学生笔迹(**71px**)，
       两段 → 被判成"multi"（硬）→ 硬带 11 条 > 模型行 8 条，DP 被迫让 3 行各吃
       两条硬带（覆盖率 0.302）。剔掉碎片后它是"单段 257px 紧贴左页边" → title（软）。
   5.3 **「有墨就长、没墨就停」的 y 扩张**（`grow_y` + `grow_h_ratio=2.5`）。
       真值框是否含"学生作答区"两页**约定相反**（密集页 p1 贴着印刷字 h=28~34；
       小学练习页把作答区圈进去，Q19 真值 h=216 而印刷行只有 22）。无差别地长，
       密集页精度 0.593→0.283；加上"模型框高 > 2.5× 行带高才长"后，密集页
       0.949/0.537/0.510、小学练习页 0.730/0.870/0.658（覆盖率 0.599→0.730）。
   5.4 **`grow_ext=90`：扩张的上界不能只有"模型框 ± pad(≤110)"**（v5.2.1 新增）。
       在窄页的选择/填空题上，模型框常常**只罩住多行题的第一行**，`pad` 上限 110px
       于是把扩张卡死：行带只覆盖第 1 行、后面 2 行够不到，`乘法综合练习` 第1次
       的 q25 覆盖率只有 0.34。给到 90px 后它 0.34→1.00、q33 0.34→0.81，
       该页整体 0.556→**0.659**，`小学练习页` 第2次 0.668→0.721。
       代价：真值"只贴印刷行"的卷（小学练习页 p1）框会略胖，IoU 0.658→0.638
       —— 这是**故意**的取舍（项目取向：宁可多带上下文，也不切掉内容）。

   附带修掉的一个 bug：`grow_y` 没把上/下界夹进画面，外扩之后会 IndexError 越界。
   另外试过、**没用**的（都写在 DEFAULTS 的注释里，别重试）：把 `lo/hi` 夹到相邻行段
   （应用题反而更差）、`soft_must`（软带也必须被覆盖）、`q_pen_all`（整段没有题目带时
   也罚）、`start_pen`（段起点窄于段内最宽行时罚）、`y_w`（降低"位置项"权重）、
   降低 `wide`（密集页 0.949→0.535，崩）。

⑥ **v5.3 的三个修正**（都来自线上真实故障：paper2 的 q4-15 整段下移一行、
   "解析结果没问题、图片定位不对"）：
   6.1 **空洞判定改用全部段**（不再只看宽段）。密集页真值第 2 行中间列「6×90=」
       的墨迹核只有 73px < seg_min_frac×W(86) 被当碎片滤掉 → 剩两段、空洞 617px
       (0.43W) → 整条带被判 "hole"（可跳过）→ **"硬题目带必须被覆盖"的安全网
       漏了个洞**，模型跳行畅通无阻（覆盖率 0.00）。小列也是内容、不是空洞；
       而「四、递等式计算。+右侧竖式」（两段都够宽、空洞 0.52W）照旧是 hole。
   6.2 **页边缘带**（y1≤2%H 或 y2≥98%H）一律非题目行。照片上/下边缘的页眉、
       裁切边、桌面杂墨被当硬带会抢走一个行、级联搞乱整页（实测小学练习页1
       页顶 y0~66 的页眉带）。真实题目行离照片边缘至少有 2% 留白。
   6.3 **反"拉伸吞行"**（`stretch_pen=500`）：一段横跨多条硬带而模型框高
       < 0.7×跨度时重罚。跳行发生后，DP 把第 1 行的段拉长盖住"行1+行2"两条
       硬带、让后面每行顺理成章错一格（拉伸的总代价比整体上移还低）。
       ⚠️ 只在**模型行数 ≥ 硬题目带数**时启用（全局门槛）：行数够分时拉伸几乎
       必是吞行；应用题页行数 < 硬带数（题干+选项天然多带）、拉伸是多行题的
       合法形态，不能罚（实测不设门槛小学练习页2 崩到 0.286）。
   效果：忠实复刻 paper2 失败态的模拟，吸附后 cov/IoU = 0.949/0.508，与正常
   模型输出完全一致（修复前 q4-15 覆盖率 0.00）。10 组基准：8 组持平、
   小学练习页2 反而提升（0.668→0.734）、仅小学页1 IoU -0.02 / 乘法综合1 cov
   -0.025 的小幅代价。JS 版（app/js/refine.js）已同步，JS/PY 对账最大差 3px。

   ⚠️ **`乘法综合练习` 第1次仍是弱项（0.659）**，天花板不是算法、是**模型输出本身**：
   该次识别把 14 个框的 y **整体压缩**了（q9~q13 比真值高 250px，框直接落在
   "1、选择题"这种板块说明行上）。用"正确行带"手工对齐测过上限 = **0.895**，
   所以差额全在**对齐**；但模型 y 在这页上是"均匀铺开式"的错，结构信号（宽度/高度/
   硬带覆盖）都不足以把它拉回来 —— 上面那一串开关全试过，没有一个能让它翻盘而不
   伤到另外 9 组。要再进一步得从**提示词/刻度图**那边让模型少压缩 y，或上
   "gap 一致性 DP"（本次未做）。

整体流程：
  1. 模型框按 y 聚类 → "模型行"。实测模型的**行/列分组与人工标注结构完全一致**
     （9 个行组、每组题号组成一样），只有整行的 y 漂移（上准下偏，最大 -210px）。
     ⚠️ **分组和顺序可信，坐标不可信** —— 底半页可以整体上偏 250px。
  2. 全页行投影 → 候选行带（峰值检测 + 高度过滤）
  3. 每条行带判"是不是题目行"（三类：够宽的单段 / 多段且无巨洞 / 其余），
     **不删带**，只标记；插图、选项续行仍可由 DP 并进该题的段里。
  4. **DP 单调对齐（允许跳过）**：模型行 r ↔ 行带区间，保持上下顺序
  5. 每题 y：多列行整行共用行带；单列长题与模型框**取并集**（只扩不缩）；
     若"模型框高 > 2.5× 行带高"（竖式/递等式那种多行题），再从行带**向有墨处扩张**
     （`grow_y`，跳过 ≤20 行空白），把学生作答区一起圈进来。
     x = 行带内该题局部的列投影边界（带"跑偏"保护）

坐标全程用**原图像素**，与模型给的坐标系一致（刻度图保证）。

用法：
    P=C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe
    $P tools/refine_proto.py --raw .workbuddy/tmp/recog_pilot/e2e_final.raw.json \
       --image data/benchmark/2026-10-01-第2单元练习卷-p1.jpg \
       --paper "2026-10-01-第2单元练习卷-p1.jpg" \
       --out .workbuddy/tmp/recog_pilot/refine_p2p1.json --preview .workbuddy/tmp/recog_pilot/refine_p2p1.jpg

批量对账（多卷 / 多次识别一把跑）用 `tools/refine_bench.py`：
    $P tools/refine_bench.py --match both \
       --cfg "密集页1=.workbuddy/tmp/recog_pilot/e2e_final.raw.json|data/benchmark/2026-10-01-第2单元练习卷-p1.jpg" \
       --cfg "..." --preview-dir .workbuddy/tmp/recog_pilot/v52

实测结果（5 张卷 / 10 次识别，真值 = data/questions 的精确坐标；覆盖率 / IoU）
--------------------------------------------------------------------
配对口径用**题干文本**（与题号约定无关，见 refine_bench.py 的说明）：

| 配置 | ① 模型原始框 | ② 现线上（外扩 35%） | ③ v5.2.1 吸附 |
|---|---|---|---|
| 密集页 第1次 | 0.382 / 0.115 | 0.713 / 0.094 | **0.949 / 0.508** |
| 密集页 第2次 | 0.199 / 0.097 | 0.546 / 0.110 | **0.938 / 0.565** |
| 应用题 第1次 | 0.398 / 0.396 | 0.604 / 0.357 | **0.926 / 0.477** |
| 应用题 第2次 | 0.762 / 0.622 | 1.000 / 0.503 | **0.997 / 0.486** |
| 小学练习页 第1次 | 0.335 / 0.319 | **0.778 / 0.505** | 0.730 / 0.638 |
| 小学练习页 第2次 | 0.226 / 0.204 | 0.596 / 0.383 | **0.721 / 0.618** |
| 乘法综合 第1次 | 0.161 / 0.075 | 0.342 / 0.103 | **0.659 / 0.250** |
| 乘法综合 第2次 | 0.472 / 0.358 | 0.806 / 0.307 | **0.876 / 0.365** |
| 乘法练习卷2 第1次 | 0.115 / 0.053 | 0.444 / 0.124 | **0.956 / 0.479** |
| 乘法练习卷2 第2次 | 0.360 / 0.248 | 0.698 / 0.209 | **0.931 / 0.462** |

结论：**覆盖率 9/10 优于现线上、IoU 9/10 优于现线上**；唯一覆盖率落后的是
「小学练习页 第1次」（0.730 vs 0.778），但那一格精度 0.870 vs 0.566、IoU 0.638 vs 0.505。
②那一列的覆盖率不是白来的：它是"把框放大到能罩住"，框里一半是空白和别人的题。

⚠️ **已知弱项**：①选择题 + 填空题 + 插图混排的窄页（`乘法综合练习.jpg` 第1次）
绝对覆盖率只有 0.556 —— 模型原始框本身很差（0.161），且 14 题里有 3 题题干对不上；
这类版面还没调好。②**无印刷题号的卷，模型的编号顺序会变**：`小学练习页` 真值按
"从左到右"、模型按"从上到下"，同一批格子只是标签不同 —— 对"按 no 排序"的下游有影响，
对坐标本身没有（所以对账必须两种配对口径都看）。

参数敏感性（同一套图，逐参数扫）：wide / hard_wide / hole_frac / q_pen / ban_pen /
seg_h_w / merge_ov / peak_min / line_col_gap / min_seg / seg_min_frac / grow_gap /
grow_h_ratio 都有一段很宽的安全区间（多数是 0.926 一动不动）。偏紧的两个：
wide 的上界（>0.42 时应用题短题干 605px 会掉出"软题目带"，覆盖率退到 0.857，
**渐进退化不会崩**）、grow_h_ratio（2.0 → 密集页精度 0.506；2.5 → 0.537，已取 2.5）。
"""
from __future__ import annotations

import argparse
import glob
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# ------------------------------------------------------------------ 掩膜
# 印刷黑：够暗 且 色差小。亮度**必须**用 int32 算，否则 299*255 溢出。
INK_LUM = 118          # 亮度的**上限**（见 resolve_ink_lum：实际阈值只在更暗时才下调）
INK_CHROMA = 42


def ink_mask(arr: np.ndarray, lum: int = INK_LUM, chroma: int = INK_CHROMA) -> np.ndarray:
    a = arr.astype(np.int32)
    lum_map = (a[:, :, 0] * 299 + a[:, :, 1] * 587 + a[:, :, 2] * 114) // 1000
    chroma_map = a.max(axis=2) - a.min(axis=2)
    return (lum_map < lum) & (chroma_map < chroma)


def otsu_lum(arr: np.ndarray, chroma: int = INK_CHROMA) -> int:
    """低色度像素的亮度直方图上跑 Otsu，返回"墨 / 纸"的分界亮度。"""
    a = arr.astype(np.int32)
    lum_map = (a[:, :, 0] * 299 + a[:, :, 1] * 587 + a[:, :, 2] * 114) // 1000
    chroma_map = a.max(axis=2) - a.min(axis=2)
    v = lum_map[chroma_map < chroma]
    if v.size < 1000:
        return INK_LUM
    hist = np.bincount(v.ravel(), minlength=256)[:256].astype(np.float64)
    tot = hist.sum()
    if tot <= 0:
        return INK_LUM
    idx = np.arange(256, dtype=np.float64)
    mu = float((idx * hist).sum() / tot)
    wB = np.cumsum(hist)
    mB = np.cumsum(idx * hist)
    wF = tot - wB
    ok = (wB > 0) & (wF > 0)
    var = np.zeros(256, dtype=np.float64)
    mBv = np.zeros(256); mBv[ok] = mB[ok] / wB[ok]
    mFv = np.zeros(256); mFv[ok] = (mu * tot - mB[ok]) / wF[ok]
    var[ok] = wB[ok] * wF[ok] * (mBv[ok] - mFv[ok]) ** 2
    return int(np.argmax(var))


def paper_level(arr: np.ndarray, chroma: int = INK_CHROMA, q: float = 75.0) -> float:
    """纸面亮度基准：低色度像素亮度的 75 分位（= "这张纸大概有多亮"）。

    实测：曝光正常的四张卷都是 255（纸面纯白）；而偏暗的
    `2026-09-30-小学练习页.jpg` 只有 ~143。
    """
    a = arr.astype(np.int32)
    lum_map = (a[:, :, 0] * 299 + a[:, :, 1] * 587 + a[:, :, 2] * 114) // 1000
    chroma_map = a.max(axis=2) - a.min(axis=2)
    v = lum_map[chroma_map < chroma]
    if v.size < 1000:
        return 255.0
    return float(np.percentile(v, q))


def resolve_ink_lum(arr: np.ndarray, base: int = INK_LUM, chroma: int = INK_CHROMA,
                    paper_frac: float = 0.68, floor: int = 60) -> int:
    """把固定的 `INK_LUM` 换成**按本图纸面亮度自适应**的阈值。

    为什么必须自适应（v5.2 新增，实测踩到）：`2026-09-30-小学练习页.jpg` 这张照片
    整体偏暗（低色度像素的亮度中位数只有 **127**、75 分位 143，而其它四张卷都是 255）。
    固定 118 于是把大片纸面/阴影都算成"墨" —— 全页"墨"占比 **35.86%**（密集页只有
    15.04%），行投影因此**没有谷**，`find_line_bands` 的侧向扩展停不下来、超出
    hmax=95 被整段丢弃：真值那 4 行（y 245~505）**一条都没检出**，覆盖率 0.778 → 0.026。

    规则 = `min(base, paper_frac × 纸面亮度)`，即"阈值取纸面亮度的 68%，但不超过 118"：

        | 卷 | 纸面 75 分位 | 0.68× | 取值 | 效果 |
        |---|---|---|---|---|
        | 密集页 p1 | 185 | 126 | **118** | 与原来完全一致（覆盖率 0.948 不动） |
        | 应用题 | 255 | 173 | **118** | 一致 |
        | 乘法综合 | 255 | 173 | **118** | 一致 |
        | 乘法练习卷2 | 255 | 173 | **118** | 一致 |
        | 小学练习页 | 143 | 97 | **97** | 行核立刻分开（峰 140~200、谷 8~32） |

    ⚠️ 试过、**不行**的替代方案（别再试）：Otsu×0.85 —— 密集页 Otsu=111 得 94，
    对密集页**太严**（0.948 → 0.884，因为 `peak_min=20 / hmax=95` 是按 118 那套掩膜
    的尺度调的，掩膜一变峰结构就变）。而按纸面亮度取值能把密集页**原样保住**。
    """
    pl = paper_level(arr, chroma)
    t = int(round(paper_frac * pl))
    return int(min(base, max(floor, t)))


def load_ink(path, forced_lum: int = 0):
    """打开图并按自适应阈值算墨掩膜。返回 (img, ink, 实际用的亮度阈值)。

    所有入口（原型 CLI / 批量对账）都走这里，避免两处各算一套阈值。
    `forced_lum > 0` 时用固定阈值（A/B 对照用，别在日常路径上用）。
    """
    img = Image.open(path).convert("RGB")
    arr = np.asarray(img)
    thr = int(forced_lum) if forced_lum else resolve_ink_lum(arr)
    return img, ink_mask(arr, thr, INK_CHROMA), thr


# ------------------------------------------------------------- 一维区间工具
def bands_1d(profile: np.ndarray, th: float) -> list[tuple[int, int]]:
    """profile 中连续 > th 的区间 [(a, b), ...]（半开区间）。"""
    on = profile > th
    out, s = [], None
    for i, v in enumerate(on):
        if v and s is None:
            s = i
        elif not v and s is not None:
            out.append((s, i))
            s = None
    if s is not None:
        out.append((s, len(on)))
    return out


def merge_gaps(segs, gap: int):
    """把间距 < gap 的区间合并（同一行的字与字之间有缝，得并起来）。"""
    if not segs:
        return []
    out = [list(segs[0])]
    for a, b in segs[1:]:
        if a - out[-1][1] <= gap:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def overlap(a, b) -> int:
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))


def cluster_rows(boxes, tol: int) -> list[list[int]]:
    """按 y1 把框聚类成"行"，保持从上到下的顺序。返回 [[idx...], ...]。"""
    order = sorted(range(len(boxes)), key=lambda i: boxes[i][1])
    rows, cur = [], []
    for i in order:
        if cur and boxes[i][1] - boxes[cur[-1]][1] > tol:
            rows.append(cur)
            cur = []
        cur.append(i)
    if cur:
        rows.append(cur)
    return rows


# --------------------------------------------------------- v3 核心：结构判据
def find_line_bands(prof, peak_min, peak_rel=0.35, peak_dist=34,
                    hmin=16, hmax=95, smooth_w=9):
    """候选行带 = 行投影的**局部峰**，向两侧扩展到峰值的 peak_rel 处。

    为什么不能用固定阈值：行距(77~82)只比字高(25)大一点，相邻行之间的"谷"
    只有 12~37，固定阈值会把两行粘成一块（实测吐出一条 150px 的巨块），
    再被高度上限砍掉 → **整个下半页 3 条行全丢**。改找峰之后 9 条全中。
    """
    n = len(prof)
    if n < 3:
        return []
    sw = smooth_w if smooth_w % 2 else smooth_w + 1
    s = np.convolve(prof, np.ones(sw) / sw, mode="same") if sw >= 3 else prof
    cand = [i for i in range(1, n - 1)
            if s[i] >= s[i - 1] and s[i] > s[i + 1] and s[i] >= peak_min]
    cand.sort(key=lambda i: -s[i])
    keep: list[int] = []
    for i in cand:
        if all(abs(i - j) >= peak_dist for j in keep):
            keep.append(i)
    keep.sort()
    out = []
    for i in keep:
        thr = max(peak_min * 0.5, s[i] * peak_rel)
        a = b = i
        while a > 0 and s[a - 1] > thr:
            a -= 1
        while b < n - 1 and s[b + 1] > thr:
            b += 1
        if hmin <= b - a <= hmax:
            out.append((a, b))
    return out


def band_structure(ink: np.ndarray, band, W: int, x1: int, x2: int, col_th: float,
                   col_gap: int, min_seg: int, seg_min_frac: float, wide: float,
                   hard_wide: float, hole_frac: float, left_edge: float, H: int = 0):
    """这条行带像不像"题目行"—— 只看**版面横向结构**，完全不依赖模型框。

    返回 (是否题目行, 判定分, 类型)。
    类型 ∈ {"multi","wide","loose","title","side","hole","empty","edge"}，其中
      multi / wide = **硬题目带**（必须被某一行用掉）
      loose        = **软题目带**（可跳过，见下）
      edge         = **贴着页顶/页底的带**（v5.3 新增）：照片上/下边缘的页眉、
                     裁切边、桌面杂墨。真实题目行不会贴到照片边上（多少有留白），
                     而这种带一旦被当"硬题目带"，会抢走一个行、把整页对齐级联搞乱
                     （实测小学练习页1：页顶 y0~66 的页眉带被判 multi 后，
                     覆盖率 0.730→0.653）。

    规则：
      · 单段且 ≥ hard_wide×页宽 → "wide"（硬）。
      · 单段且 ≥ wide×页宽 → "loose"（软）。**为什么要设软档**：应用题题干最短
        605px/1427=0.42，而密集页最长的板块标题「三、在○里填入…」530px/1440=0.37
        —— 两者只差 8%，单一阈值必然是个刀锋（实测 wide=0.36 就把标题判成题目带，
        10 条硬带对 9 行 → DP 改成比代价 → 密集页第 2 次直接崩到 0.224，比现线上
        的 0.572 还差）。拆成两档后，落在这 8% 灰区里的带只是"可跳过的软带"，
        "9 条硬带 ↔ 9 行"的强制对应不受影响，阈值判偏也只是少一条约束。
      · 单段但不够宽 → 不是题目行。要么是板块标题（「一、算一算。」171px、
        「二、用竖式计算。」245px，都**紧贴左页边**起笔），要么是右侧的插图/杂墨
        （应用题那两幅图 341/333px，起点在 x≈990，远在左页边之外）。
      · 多段但中间有**巨大空洞** → "hole"（不是题目行）。实测「四、递等式计算。」
        那条带 = 左边标题(167~439) + 右边学生竖式(1183~1324)，空洞 744px；
        而真正的两列题目行空洞只有 221~349px，三列 157~306px。
      · 其余多段 → "multi"（硬）。

    ⚠️ **判"单段/多段"之前，先把窄于 `seg_min_frac×页宽` 的碎片剔掉**（v5.2 新增，
    实测踩到）：`2026-09-30-小学练习页.jpg` 的板块标题「二、用竖式计算。」那条带
    = 标题(233~490, 257px) + 右边一小坨学生笔迹(760~831, **71px**)，两段 → 被判成
    "multi"（硬）。于是硬带 11 条 > 模型行 8 条，DP 被迫让 3 行各吃两条硬带 →
    覆盖率只有 0.302（现线上 0.552）。剔掉 71px 那坨后它是**单段 257px、紧贴左页边**
    → "title"（软，可跳过），"8 条硬带 ↔ 8 行"的对应立刻恢复。
    真正的题目列宽实测都 ≥ 0.08W（密集页三列 226~285px、竖式卷更宽），
    所以这条门槛只筛掉碎片，不会筛掉真的题目列。

    ⚠️ x 必须限制在 [x1, x2]（与行投影同一范围）。用整页宽度时，右页边/黑桌面的
    墨迹会凭空造出第二段，实测让两条板块标题被误判成题目行。
    """
    y1, y2 = band
    if y2 <= y1 or x2 <= x1:
        return False, 0.0, "empty"
    # 页顶/页底边缘带（见类型说明）。真实题目行离照片边缘至少有 2% 的留白。
    if H > 0 and (y1 <= 0.02 * H or y2 >= 0.98 * H):
        return False, 0.0, "edge"
    prof = ink[y1:y2, x1:x2].sum(axis=0).astype(np.float64)
    segs = merge_gaps(bands_1d(prof, col_th), gap=col_gap)
    segs = [(s + x1, e + x1) for s, e in segs if e - s >= min_seg]
    if not segs:
        return False, 0.0, "empty"
    wide_segs = [(s, e) for s, e in segs if e - s >= seg_min_frac * W]
    if not wide_segs:
        # 整条带里没有一个够宽的段 → 全是碎片（手写/噪点），不是文字行
        return False, max(e - s for s, e in segs) / max(1, W), "side"
    if len(wide_segs) == 1:
        s, e = wide_segs[0]
        w = e - s
        if w >= hard_wide * W:
            return True, w / max(1, W), "wide"
        if w >= wide * W:
            return True, w / max(1, W), "loose"
        return False, w / max(1, W), ("title" if s <= left_edge * W else "side")
    # ⚠️ 空洞判定用**全部段**（min_seg 过滤后），不是只看宽段（v5.3 修）：
    # 密集页真值第 2 行 = 「10×0×8= / 6×90= / 200-130=」，中间列「6×90=」的墨迹
    # 核只有 73px < seg_min_frac×W(86) 被当碎片滤掉 → 剩两段、空洞 617px(0.43W)
    # → 整条带被判 "hole"（非题目带）→ "硬题目带必须被覆盖"的安全网漏了个洞，
    # 模型一旦把 y 压下一行（线上真实发生：paper2 的 q4-15 整段下移一行），
    # DP 就地跟着跳行、覆盖率 0.00。改用全部段算空洞后：小列把大空洞切成
    # 238/306 两段（0.21W）→ "multi"（硬）✓；而原本要拦的
    # 「四、递等式计算。+右侧学生竖式」（167-439 / 1183-1324，两段都够宽、
    # 空洞 744px=0.52W）照旧是 hole ✓ —— 判"标题/侧墨"的单宽段路径也原样保留。
    gaps = [segs[i + 1][0] - segs[i][1] for i in range(len(segs) - 1)]
    mx = max(gaps)
    if mx > hole_frac * W:
        return False, mx / max(1, W), "hole"
    return True, min(e - s for s, e in wide_segs) / max(1, W), "multi"


def merge_overlaps(bands, ov: float = 0.5):
    """两条行带重叠超过"较矮那条的一半"就合并。

    峰值检测偶尔会在同一行吐两条（实测密集页的 #6 607-633 完全含于 #7 603-683）。
    不合并的话，分段 DP 会拿它"凑距离"——把 603 和 1088 两条不相干的行带并成
    一段（518px 的巨框），总代价反而更小。
    """
    out: list[list[int]] = []
    for a, b in sorted(bands):
        if out:
            pa, pb = out[-1]
            inter = min(pb, b) - max(pa, a)
            if inter > ov * min(pb - pa, b - a):
                out[-1] = [min(pa, a), max(pb, b)]
                continue
        out.append([a, b])
    return [(a, b) for a, b in out]


def align_segments(model_c, model_h, bounds, K, h_ratio=1.6, h_slack=60,
                   h_w=3.0, h_cap=80.0, kinds=None, q_pen=400.0, ban_pen=250.0,
                   soft_must=0, q_pen_all=0, y_w=1.0, wfrac=None, start_pen=0.0,
                   stretch_pen=500.0):
    """把行带序列切成 K 段，第 r 段给第 r 个模型行。允许跳过行带，但有条条框框。

    代价 = |段中心 - 模型行中心| + h_w × min(|段高 - 模型框高|, h_cap)
           + q_pen （段里只有一条带、且这条带不是题目带）
           + ban_pen × （段里含几条"板块标题带"）

    硬约束
      · 段高 ≤ max(h_ratio × 模型框高, 模型框高 + h_slack)；
      · **题目带（wide/multi）必须被某一行的段覆盖** —— 跳过的行带里不许有题目带。
        （插图片段与"空带"可以跳过。）

    三条规则各有实测来由，缺一条就有一页会崩：

    1. 允许跳过 —— 板块标题必须能独立于相邻题目带存在。密集页 #6 结束于 683、
       #7 起于 1009 隔 326px，并进同一段就是 440px 高，超段高上限 → 不给跳过
       就等于"正确的分段不可行"，DP 只能整体错位一格（覆盖率 0.239）。

    2. **题目带必须被覆盖** —— 应用题的模型框整体下移了整整一题（题1 的模型框
       正好落在题2 的真值框上）。只比中心距离，DP 必然选"整页下移一题"那个解
       （代价 2.5 vs 114），必须靠"每一条题目带都要有主"把它拽回来：
       6 条题目带分给 4 行 → 「{题干,选项}→题1、{题干,选项}→题2、题干→题3、
       题干→题4」被强制成立，下移解不再可行。

    3. 板块标题带不许用（q_pen 管"单独成题"，ban_pen 管"并进题里"）——
       允许跳过之后，DP 会为了省距离把「三、在○里填入…」这条**标题带**派给
       第 1 道题（标题带够宽、离模型框又近，代价反而更低）；也会把标题并进
       相邻题的段里（密集页题13-15 的模型框高 155，与"标题+题目"两带并起来
       的高度 146 更配，代价 65 < 单独用题目带的 235）。
    注意**只罚"板块标题带"**：插图/选项续行（side）仍可自由并入（应用题页
    题3 的游泳图、题4 的电梯图就是这么进段的）。

    返回 [(i, j), ...]（半开区间，i/j 是 bounds 的下标）或 None。
    """
    M = len(bounds)
    if K <= 0 or M < K:
        return None
    INF = float("inf")
    if kinds is None:
        kinds = ["multi"] * M
    QK = ("wide", "multi")                      # 硬题目带（必须被覆盖）
    if soft_must:
        QK = ("wide", "multi", "loose")         # 连"软题目带"也要求被覆盖（实验开关）
    SK = ("loose",)                             # 软题目带（可跳过）
    BK = ("title", "hole", "empty", "edge")     # 板块标题带（不许用）
    isq = [k in QK for k in kinds]
    issoft = [k in SK for k in kinds]
    isany = [k in ("wide", "multi", "loose") for k in kinds]   # 任何"像题目"的带
    isb = [k in BK for k in kinds]
    n_hard = sum(1 for v in isq if v)
    # pre_must[j] = bands[0..j] 里有几条题目带 → 用来禁止"跳过题目带"
    pre_must = []
    n = 0
    for j in range(M):
        if isq[j]:
            n += 1
        pre_must.append(n)

    def cost(i, j, r):
        """段 bounds[i..j] 派给第 r 个模型行。返回 INF 表示不可行。"""
        mh = model_h[r]
        y1, y2 = bounds[i][0], bounds[j - 1][1]
        if y2 - y1 > max(h_ratio * mh, mh + h_slack):
            return INF
        c = y_w * abs((y1 + y2) / 2.0 - model_c[r]) + h_w * min(abs((y2 - y1) - mh), h_cap)
        # v5.3 反"拉伸吞行"：一段横跨**多条硬题目带**、而模型框高根本装不下
        # （< 0.7×跨度）时重罚。线上真实案例（paper2）：模型把 q4-15 的 y 整段
        # 压下一行，DP 不去纠正、反而把第 1 行的段拉长盖住"行1+行2"两条硬带，
        # 让后面每一行都顺理成章地错一格 —— 拉伸的总代价比整体上移还低。
        # ⚠️ 只在 **模型行数 ≥ 硬题目带数** 时启用（全局门槛）：行数够分时拉伸
        # 几乎必是吞行；而应用题页行数 < 硬带数（题干+选项天然多带）、拉伸是
        # 多行题的合法形态，不能罚（实测小学练习页2 不设门槛会崩到 0.286）。
        nh = sum(1 for t in range(i, j) if isq[t])
        if nh > 1 and mh < 0.7 * (y2 - y1) and K >= n_hard:
            c += stretch_pen
        nb = sum(1 for t in range(i, j) if isb[t])
        if nb:
            c += ban_pen * nb
        if j - i == 1 and not (isq[i] or issoft[i]):
            c += q_pen
        elif q_pen_all and not any(isany[t] for t in range(i, j)):
            # 整段里**一条"像题目"的带都没有** → 这一行是"停在空白/标题上"，重罚。
            # （v5.2 实验：密集题少、模型 y 被压缩的窄页上，DP 会把某一行免费停在
            #  「标题+说明」两条带上，从而把后面所有行整体上偏一道题。）
            c += q_pen
        if start_pen and wfrac is not None:
            # "这一题从哪一行开始"的结构信号：一道题**从它最宽的那行（题干）起笔**，
            # 后面的选项/续行都比它窄。段起点明显窄于段内最宽行 → 说明起错了行。
            w_start = wfrac[i]
            w_max = max(wfrac[t] for t in range(i, j))
            c += start_pen * max(0.0, w_max - w_start)
        return c

    def gap_free(a, b):
        """bands[a..b] 里没有题目带（允许这段被跳过）。"""
        if b < a:
            return True
        return pre_must[b] - (pre_must[a - 1] if a > 0 else 0) == 0

    dp = [[INF] * M for _ in range(K)]        # dp[r][j]：第 r 行的段以带 j 结尾
    bk = [[(0, -1)] * M for _ in range(K)]    # 回溯：(本段起点 i, 上一行段的终点 j')
    # ⚠️ 必须**显式枚举**上一段的终点 jp，不能只记"dp[r-1][0..i-1] 里的最小值"：
    # 最便宜的那个解可能被执行"不许跳过题目带"的 gap_free 否决掉，而次便宜的可行解
    # 就此丢失 —— 实测会让"9 条硬带 ↔ 9 行"这种明明可行的唯一解被判成不可行，
    # 整页退回模型框。M、K 都只有十几，三重循环的开销可以忽略。
    for r in range(K):
        for j in range(M):
            best, bi, bj = INF, -1, -1
            for i in range(0, j + 1):
                for jp in ([-1] if r == 0 else range(-1, i)):
                    if r == 0:
                        prev = 0.0
                    else:
                        if jp < 0 or dp[r - 1][jp] >= INF:
                            continue
                        prev = dp[r - 1][jp]
                    if not gap_free(jp + 1, i - 1):   # 两段之间（含卷首）不许跳过题目带
                        continue
                    c = cost(i, j + 1, r)
                    if c >= INF:
                        continue
                    if prev + c < best:
                        best, bi, bj = prev + c, i, jp
            dp[r][j] = best
            bk[r][j] = (bi, bj)
    # 收尾：最后一行止于哪个带最省（尾部允许跳过非题目带）
    cand = [j for j in range(M) if dp[K - 1][j] < INF and gap_free(j + 1, M - 1)]
    if not cand:
        return None
    last = min(cand, key=lambda j: dp[K - 1][j])
    segs, j = [], last
    for r in range(K - 1, -1, -1):
        i, jp = bk[r][j]
        if i < 0:
            return None
        segs.append((i, j + 1))
        j = jp
    segs.reverse()
    return segs


def order_x(ink, band, boxes, W, x1, x2, col_th, col_gap, min_seg, margin):
    """多列行：把行带里的横向段按**左右顺序**一一对应该行的题目框。

    为什么不能只靠"模型框中心落在哪个段里"：密集页第 2 次识别把右侧列的框整体
    左移了约 170px（570~760，真值 737~972），模型框中心落在**空白处** —— 既没
    命中任何墨迹段，"与模型框重叠 < 50% 就退回模型框"的保护又把它打回原形，
    结果框画在空白纸上（no=17 覆盖率 0.09）。同一行带的段数正好等于这一行题目数
    时，"第 1 段↔左边第 1 题"这种顺序对应比绝对坐标可靠得多（两页实测全对）。

    ⚠️ x 必须和 band_structure 用同一个范围 [x1,x2]、同一套参数：用整页宽度时
    右页边/黑桌面会多造出 2 条段，段数与题目数就永远对不上，这个函数等于废掉。

    段数 ≠ 题目数就返回 None，交回给 snap_x 的逐框吸附。
    """
    a, b = band
    if len(boxes) < 2 or b <= a or x2 <= x1:
        return None
    prof = ink[a:b, x1:x2].sum(axis=0).astype(np.float64)
    segs = [(s + x1, e + x1) for s, e in merge_gaps(bands_1d(prof, col_th), gap=col_gap)
            if e - s >= min_seg]
    if len(segs) != len(boxes):
        return None
    return [(max(0, s - margin), min(W, e + margin)) for s, e in segs]


def snap_x(ink, band, box, W, col_th, col_gap, pad, margin):
    """在行带内，把 x 吸附到该题局部的墨迹边界（取含模型中心的那个连续段）。"""
    a, b = band
    lx1 = max(0, int(box[0] - pad))
    lx2 = min(W, int(box[2] + pad))
    if b <= a or lx2 <= lx1:
        return int(box[0]), int(box[2])
    prof = ink[a:b, lx1:lx2].sum(axis=0).astype(np.float64)
    segs = merge_gaps(bands_1d(prof, col_th), gap=col_gap)
    if not segs:
        return int(box[0]), int(box[2])
    segs = [(s + lx1, e + lx1) for s, e in segs]
    c = (box[0] + box[2]) / 2.0
    pick = next(((s, e) for s, e in segs if s <= c <= e), None)
    if pick is None:
        pick = min(segs, key=lambda se: min(abs(c - se[0]), abs(c - se[1])))
    return max(0, pick[0] - margin), min(W, pick[1] + margin)


def grow_y(ink, y1, y2, x1, x2, lo, hi, gap: int, th: int):
    """把 y 范围向上下"长到没墨为止"，最多允许跳过 `gap` 行空白，不得超出 [lo, hi]。

    为什么需要（v5.2 新增）：`2026-09-30-小学练习页.jpg` 的真值框把**学生作答区**
    也算进去了（「三、递等式计算」的 Q19 真值 216px 高，而印刷行只有 22px；
    下面的作答墨迹是连着的）。只贴行带就系统性欠覆盖（Q19 覆盖仅 0.15）。
    这条规则说的是"**有墨就长、没墨就停**"：作答墨迹与题干之间没有空行，就会长上去；
    下一题之前通常有空行，就停在那里 —— 不需要知道"这是不是竖式题"。
    """
    x1 = max(0, int(x1)); x2 = min(ink.shape[1], int(x2))
    if x2 <= x1:
        return int(y1), int(y2)
    lo = max(0, int(lo))                  # ⚠️ 必须夹在图内：外扩/扩展上界可能超出画布
    hi = min(ink.shape[0] - 1, int(hi))
    y1 = min(max(int(y1), lo), hi)
    y2 = min(max(int(y2), y1), hi)
    prof = ink[:, x1:x2].sum(axis=1)
    a = int(y1); blank = 0
    while a - 1 >= lo:
        if prof[a - 1] >= th:
            blank = 0
        else:
            blank += 1
            if blank > gap:
                break
        a -= 1
    b = int(y2); blank = 0
    while b + 1 <= hi:
        if prof[b + 1] >= th:
            blank = 0
        else:
            blank += 1
            if blank > gap:
                break
        b += 1
    return a, b


DEFAULTS = dict(
    row_tol=25,      # 模型框 y 聚类容差（行距 ~60，取 25 很安全）
    x_expand=40,     # 行投影的 x 范围 = 模型框并集再外扩（另有 x_edge 兜底）
    x_edge=0.08,     # 但至少覆盖页宽的 [8%, 92%]（见 refine 里的说明）
    peak_min=20.0,   # 行投影上"这算一条行"的最小峰高
    peak_rel=0.35,   # 行带边界：从峰向两侧扩展到峰值的这个比例
    peak_dist=34,    # 两个峰的最小间距（小于它的只留高的那个）
    smooth_w=9,      # 行投影平滑窗（奇数）
    merge_ov=0.5,    # 两条行带重叠超过较矮那条的这个比例就合并
    ink_lum=0,       # 0 = 按本图自适应（Otsu×0.85，上限 118，见 resolve_ink_lum）；
                     # >0 = 强制用这个亮度阈值（**只给 A/B 对照用**，别当日常旋钮）。
    hmin=16, hmax=95,  # 行带高度范围（题目行 ~20-70；卷头/阴影块远超）
    col_th=3.0,      # 列投影时"这一列有墨迹"的下限
    line_col_gap=100,  # 判"一整行题"时允许的横向空隙。相邻列的空隙是 220px+，
                       # 所以 100 能把一道题自己的字连起来、又不会跨到隔壁列。
    min_seg=60,      # 一段至少要这么宽才算"一列题"（滤掉噪点）
    seg_min_frac=0.06,  # 判"单段/多段"时，窄于此比例×页宽的段先当碎片剔掉。
                        # 为什么不能复用 min_seg：min_seg=60 是"抗噪点"的绝对下限，
                        # 而实测需要剔掉的是**学生笔迹**（71px）—— 见 band_structure 里
                        # 「二、用竖式计算。」那条带的例子（剔掉后硬带 11→10 条，
                        # 与模型 8 行重新对得上）。真的题目列宽都 ≥0.08W，不受影响。
    wide=0.40,       # 单段 → "软题目带" 的下限。0.40 落在实测的 8% 灰区正中间：
                     # 应用题最短题干 605px/1427=0.42，密集页最长板块标题
                     # 「三、在○里填入…」530px/1440=0.37。
    hard_wide=0.55,  # 单段 → "硬题目带" 的下限。软带可跳过、硬带必须被覆盖，
                     # 所以阈值判偏时最多多/少一条软带，不会破坏"硬带↔行"的强制
                     # 对应（见 band_structure 的说明：wide 曾经是个刀锋）。
    hole_frac=0.35,  # 多段时，段与段之间允许的最大空洞（占页宽）。
                     # 真题目行：两列 221~349px、三列 157~306px（≤0.24 页宽）；
                     # 「四、递等式计算。」那条 = 标题 + 右侧学生竖式，空洞 744px=0.52。
    left_edge=0.20,  # "够宽的单段"之外，段起点 ≤ 该比例 × 页宽 → 判为板块标题。
                     # 板块标题一律紧贴左页边；右侧的插图片段起点在 0.69 页宽处。
    x_pad=130,       # x 吸附的搜索半径
    snap_col_th=4.0,
    snap_col_gap=100,  # x 吸附时字与字之间的缝。同一个题的文字段之间不该有
                       # >100px 的空隙（相邻列的空隙是 220px+），所以用大值把
                       # 一道题的字连成一段，又不会跨到隔壁列。
    x_keep_ov=0.5,   # x 吸附结果与模型框的重叠低于该比例 → 认定跑偏，退回模型框
    x_margin=40,     # x 安全余量。人工标注的"题区框"是含作答留白的，只给 12px
                     # 时覆盖率 0.869，给 40px 到 0.942（精度仍有 0.62，不会跨列）。
    widen_ratio=0.35,  # 单列长题的兜底外扩比例（与线上策略一致）
    y_margin=12,     # y 安全余量
    grow_gap=20,     # 「有墨就长」的扩张：允许跳过几行空白。0 = 关闭。
                     # 见 grow_y 的说明（真值框含作答区时才需要）。
                     # 实测（10 组）：开着 覆盖率 9/10 优于现线上，IoU 10/10 优于现线上。
    grow_h_ratio=2.5,  # 只有"模型框高 > 该比例 × 行带高"才长（=版面上真是多行的题）。
                       # 两页真值约定相反，无差别地长会让密集页精度掉一半。
                       # 2.0 → 密集页 0.951/**0.506**/0.479（有的行也被长）
                       # 2.5 → 密集页 0.949/**0.537**/0.510（该长的才长），竖式页不受影响
    grow_ink=2,      # 「这一行有墨」的下限（该题 x 范围内的墨像素数）。
    seg_h_ratio=1.6,  # 段高上限 = ratio × 模型框高（见 align_segments 的说明）
    seg_h_slack=60,
    seg_h_w=3.0,     # 代价里"段高与模型框高之差"的权重。**要比中心距离更重**：
                     # 应用题页模型框整体下移 ~115px，恰好落在下一题的位置上，
                     # 中心距离会把"错的段"算成更近；但段高一比就露馅（145 vs 90）。
                     # 提到 3.0 后应用题页 4 段全部切对，密集页不受影响（唯一解）。
    seg_h_cap=80.0,  # 高度差的**上限**（封顶）。题4 真值含 362px 高的图，而行带
                     # 只到 1016（深色图被高度上限挡掉），不封顶这一项会盖过全局。
    q_pen=400.0,     # "段内只有一条带、且这条带不是题目带"的惩罚。要比典型代价
                     # （30~300）大一档，又不至于盖过全局。
    ban_pen=250.0,   # 段内每含一条"板块标题带"的惩罚。密集页题13-15 的模型框高
                     # 155，与"标题带+题目带"并起来的高度 146 更配（代价 65），
                     # 比单用题目带（代价 235）还便宜 → 不罚就会把标题吃进框里。
    soft_must=0,     # 1 = 连"软题目带"(loose)也要求被覆盖（实验开关，默认关）
    q_pen_all=0,     # 1 = 整段里没有任何"像题目"的带时也罚 q_pen（实验开关，默认关）
    y_w=1.0,         # 代价里"段中心与模型框中心之差"的权重（实验开关，默认 1.0）
    start_pen=0.0,   # "段起点窄于段内最宽行"的惩罚（实验开关，默认关；量纲=像素）
    stretch_pen=500.0,  # 段横跨多条硬带但模型框高 < 0.7×跨度 时的惩罚（v5.3 反"拉伸吞行"）
    grow_ext=90,     # 「有墨就长」时，允许比"行带/模型框+pad"再多探出去多少像素。
                     # 为什么要它（v5.2.1，实测踩到）：模型框常常只罩住**多行题的第一行**
                     # （窄页的选择/填空题尤其明显），而 `pad` 上限只有 110px —— 于是
                     # 「有墨就长」根本没机会够到本题后面的行带，覆盖率被卡在 0.34。
                     # 给到 90 后 `乘法综合练习` 第1次 0.556 → 0.659（q25 0.34→1.00、
                     # q33 0.34→0.81），`小学练习页` 第2次 0.668 → 0.721。
                     # 代价：真值"只贴印刷行"的卷（小学练习页 p1）框会略胖，IoU 0.658→0.638；
                     # 换来的覆盖率是净赚的（项目取向：宁可多带上下文也不切内容）。
                     # 设 0 = 回到旧行为（扩张上界只到"模型框 ± pad"）。
    grow_ext_ratio=2.5,  # 只有"模型框高 > 该比例 × 行带高"才给 grow_ext
) 


def refine(ink, boxes, W, H, p, nos=None, verbose=True):
    nos = nos if nos is not None else list(range(len(boxes)))
    rows = cluster_rows(boxes, p["row_tol"])
    row_boxes = [[boxes[i] for i in idxs] for idxs in rows]

    xs1 = min(b[0] for b in boxes)
    xs2 = max(b[2] for b in boxes)
    # 行投影的 x 范围：模型框并集再外扩，但**至少覆盖页面中央的大部分**。
    # 为什么不能只跟着模型框走：模型有一次把最右一列的框给窄了 70px，
    # 行投影范围随之右移，判定分集体失真（真值行从 0.60 掉到 0.12 被误剔除），
    # 整页直接回退。钉住"至少到页宽的 8%~92%"，两次识别就稳定多了。
    lx1 = max(0, min(int(xs1 - p["x_expand"]), int(p["x_edge"] * W)))
    lx2 = min(W, max(int(xs2 + p["x_expand"]), int((1.0 - p["x_edge"]) * W)))
    prof = ink[:, lx1:lx2].sum(axis=1).astype(np.float64)
    lines = find_line_bands(prof, p["peak_min"], p["peak_rel"], p["peak_dist"],
                            p["hmin"], p["hmax"], p["smooth_w"])
    lines = merge_overlaps(lines, p["merge_ov"])

    # ---- 判据：这条行带像不像"题目行"（v5：只看版面横向结构，不删带、只标记）----
    # 为什么不删带：插图、选项续行本身"不是题目行"，但它属于某道题，得让 DP 把它
    # 并进那道题的段里（应用题页题3 的游泳图就是这么进段的）。
    # 所以这里只算"是不是题目带"，非题目带由 align_segments 的 q_pen 管住
    # —— 它们**不能单独充当一道题**，但可以并入别的段。
    scores, ok, kinds = [], [], []
    for (a, b) in lines:
        good, sc, kind = band_structure(ink, (a, b), W, lx1, lx2, p["col_th"],
                                        p["line_col_gap"], p["min_seg"], p["seg_min_frac"],
                                        p["wide"], p["hard_wide"], p["hole_frac"],
                                        p["left_edge"], H=H)
        ok.append(good); scores.append(sc); kinds.append(kind)
    bounds = list(lines)

    model_c = [float(np.mean([(b[1] + b[3]) / 2 for b in rb])) for rb in row_boxes]
    model_h = [float(np.median([b[3] - b[1] for b in rb])) for rb in row_boxes]
    segs = align_segments(model_c, model_h, bounds, len(rows),
                          p["seg_h_ratio"], p["seg_h_slack"], p["seg_h_w"], p["seg_h_cap"],
                          kinds=kinds, q_pen=p["q_pen"], ban_pen=p["ban_pen"],
                          soft_must=p["soft_must"], q_pen_all=p["q_pen_all"],
                          y_w=p["y_w"], wfrac=scores, start_pen=p["start_pen"],
                          stretch_pen=p["stretch_pen"])

    if verbose:
        print("候选行带 %d 条（x∈[%d,%d]），其中判定为题目带 %d 条：" % (
            len(lines), lx1, lx2, sum(1 for v in ok if v)))
        for j, (a, b) in enumerate(lines):
            print("   #%-2d y %4d~%-4d (h=%-3d) 判定分 %.2f  %-6s %s" % (
                j, a, b, b - a, scores[j], kinds[j], "✔ 题目带" if ok[j] else "✗ 非题目带"))
        print()
        print("%-4s %-14s %-22s %s" % ("行", "题号", "占用的行带", "该段 y 范围"))
        print("-" * 84)
        for r in range(len(rows)):
            if not segs:
                print("%-4d %-14s %-22s %s" % (r, str([nos[i] for i in rows[r]]), "（未对齐）", ""))
                continue
            i, j = segs[r]
            print("%-4d %-14s %-22s y %d~%d" % (
                r, str([nos[i] for i in rows[r]]), "#%d..#%d" % (i, j - 1),
                bounds[i][0], bounds[j - 1][1]))

    out = [None] * len(boxes)
    if segs:
        for r, idxs in enumerate(rows):
            i, j = segs[r]
            sy1, sy2 = bounds[i][0], bounds[j - 1][1]
            multi = len(idxs) >= 2          # 这一行是"多列并排"还是"一题独占一行"
            # 多列行：先试"按左右顺序一一对应"（段数 == 题目数时最可靠）
            id_sorted = sorted(idxs, key=lambda k: boxes[k][0])
            ox = None
            if multi:
                ox = order_x(ink, (sy1, sy2), [boxes[k] for k in id_sorted], W,
                             lx1, lx2, p["col_th"], p["line_col_gap"], p["min_seg"],
                             p["x_margin"])
            for t, k in enumerate(id_sorted):
                bx = boxes[k]
                if multi:
                    # 多列行：整行的题共用这条真实行带
                    ay1, ay2 = sy1, sy2
                else:
                    # 单列长题：模型框整体下移过 115px，也补过很准的（覆盖 0.762），
                    # 所以行带只当**锚**，不作为唯一边界。
                    ay1, ay2 = sy1, sy2
                if p["grow_gap"] > 0 and (bx[3] - bx[1]) > p["grow_h_ratio"] * max(1, ay2 - ay1):
                    # 「有墨就长、没墨就停」：竖式/递等式的作答墨迹能被圈进来，
                    # 而模型框外扩给上界，防止一路长到隔壁题去。
                    #
                    # ⚠️ 只在**模型框明显比行带高**时才长（`grow_h_ratio`）：两页的
                    # 真值标注约定是**相反**的 —— 密集页 p1 的框贴着印刷字（h=28~34），
                    # 而小学练习页把学生作答区也圈进去（Q19 真值 h=216、印刷行只有 22）。
                    # 无差别地长，密集页的精度会从 0.593 掉到 0.283（框高了一倍、多圈了
                    # 手写）；加上这条判据后密集页（模型框/行带 ≈1.9 倍）不动，
                    # 而竖式题（157/22 ≈ 7 倍）才长。
                    pad = min(max(round((bx[3] - bx[1]) * p["widen_ratio"]), 40), 110)
                    # ext 只在"模型框明显比行带高"（真是多行题）时才给。
                    # 为什么要这个门槛：ext 让框有机会够到本题后面的行（收益在覆盖率），
                    # 但也会让"真值只贴印刷行"的卷（小学练习页 p1）白白变胖（精度掉）。
                    band_h = max(1, ay2 - ay1)
                    ext = p["grow_ext"] if (bx[3] - bx[1]) > p["grow_ext_ratio"] * band_h else 0
                    # 扩张范围的上/下界：默认是"模型框 ± pad"，再加 ext；
                    # 但**不得越过相邻行段**——上一段的下沿、下一段的上沿就是天然围墙。
                    # 为什么需要（v5.2.1）：模型框常只罩住多行题的第一行，而 pad 上限 110
                    # 会让扩张根本没机会够到本题后面的行（实测 `乘法综合练习` 的选择/填空
                    # 题：行带只覆盖第一行，后面 2 行被 110px 的界卡住，覆盖率只有 0.34）。
                    # 用邻段当界既够长、又不会吃到隔壁题（q25 从 747 长到 834、下一段起于 851）。
                    lo_b = min(ay1, bx[1] - pad) - ext
                    hi_b = max(ay2, bx[3] + pad) + ext
                    gy1, gy2 = grow_y(ink, ay1, ay2, boxes[k][0], boxes[k][2],
                                      lo_b, hi_b, p["grow_gap"], p["grow_ink"])
                    if multi:
                        y1, y2 = gy1, gy2
                    else:
                        y1 = min(gy1, bx[1] - pad, ay1 - ext)
                        y2 = max(gy2, bx[3] + pad, ay2 + ext)
                else:
                    if multi:
                        y1, y2 = ay1, ay2
                    else:
                        pad = min(max(round((bx[3] - bx[1]) * p["widen_ratio"]), 40), 110)
                        y1 = min(bx[1] - pad, ay1)
                        y2 = max(bx[3] + pad, ay2)
                y1 = max(0, y1 - p["y_margin"])
                y2 = min(H, y2 + p["y_margin"])
                if ox is not None:
                    x1, x2 = ox[t]
                else:
                    x1, x2 = snap_x(ink, (sy1, sy2), bx, W, p["snap_col_th"],
                                    p["snap_col_gap"], p["x_pad"], p["x_margin"])
                    # x 保护：吸附结果若与模型框几乎不重叠，说明列投影被"图 / 笔迹"
                    # 带跑了（实测应用题页一次跑到 x 945~1369，真值在 277~1345），
                    # 这种时候退回模型框，别把框挪到隔壁去。
                    if min(x2, bx[2]) - max(x1, bx[0]) <= p["x_keep_ov"] * (bx[2] - bx[0]):
                        x1, x2 = bx[0], bx[2]
                out[k] = (int(x1), int(y1), int(x2), int(y2))
    for i, b in enumerate(out):
        if b is None:
            out[i] = boxes[i]
    return [tuple(int(v) for v in b) for b in out], {"lines": lines, "segs": segs, "kinds": kinds}


# ------------------------------------------------------------------ 对账
def ratio(a, b):
    ax1, ay1, ax2, ay2 = a[:4]
    bx1, by1, bx2, by2 = b[:4]
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ta = max(1, (ax2 - ax1) * (ay2 - ay1))
    tb = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / ta, inter / tb, inter / (ta + tb - inter)


def load_truth(paper: str) -> dict:
    out = {}
    for fp in glob.glob("data/questions/*.json"):
        d = json.loads(Path(fp).read_text(encoding="utf-8"))
        s = d.get("source") or {}
        if s.get("file") != paper:
            continue
        out[d["no"]] = tuple(s["bbox"])
    return out


def report(name: str, boxes: dict, truth: dict):
    cs, ps, js, bad = [], [], [], []
    for no, b in boxes.items():
        t = truth.get(no)
        if not t:
            continue
        c, p, j = ratio(t, b)
        cs.append(c); ps.append(p); js.append(j)
        if c < 0.999:
            bad.append((no, c, t, b))
    if not cs:
        print("  %s：无可比数据" % name)
        return None
    print("  %-24s 覆盖 %.3f  完全(≥0.99) %2d/%d  精度 %.3f  IoU %.3f" % (
        name, sum(cs) / len(cs), sum(1 for v in cs if v >= 0.99), len(cs),
        sum(ps) / len(ps), sum(js) / len(js)))
    return bad


def draw_preview(img, model, refined, truth, out_path: Path):
    im = img.convert("RGB").copy()
    d = ImageDraw.Draw(im)
    for b in model.values():
        d.rectangle(b, outline=(150, 150, 160), width=2)
    for b in truth.values():
        d.rectangle(b, outline=(210, 40, 40), width=3)
    for b in refined.values():
        d.rectangle(b, outline=(20, 120, 230), width=3)
    im.save(out_path, quality=88)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="识别产物 *.raw.json（含 rawQuestions[].bbox）")
    ap.add_argument("--image", required=True)
    ap.add_argument("--paper", required=True, help="真值 data/questions/*.json 里的 source.file")
    ap.add_argument("--out")
    ap.add_argument("--preview")
    for k, v in DEFAULTS.items():
        ap.add_argument("--" + k.replace("_", "-"), type=type(v), default=v)
    a = ap.parse_args()
    p = {k: getattr(a, k) for k in DEFAULTS}

    payload = json.loads(Path(a.raw).read_text(encoding="utf-8"))
    qs = payload.get("rawQuestions") or []
    img, ink, ink_thr = load_ink(a.image, p["ink_lum"])
    W, H = img.size

    model, boxes, nos = {}, [], []
    for q in qs:
        b = q.get("bbox")
        if not b:
            continue
        model[q["no"]] = tuple(int(v) for v in b)
        boxes.append(model[q["no"]])
        nos.append(q["no"])

    print("图 %s  %d×%d   模型框 %d 个   墨水占比 %.2f%%（亮度阈值 %d）" % (
        Path(a.image).name, W, H, len(boxes), 100.0 * ink.mean(), ink_thr))
    refined_list, _ = refine(ink, boxes, W, H, p, nos=nos)
    refined = {nos[i]: refined_list[i] for i in range(len(nos))}

    truth = load_truth(a.paper)
    print()
    print("对账（%s，真值 %d 题）" % (a.paper, len(truth)))
    report("① 模型原始框", model, truth)
    widened = {}
    for no, b in model.items():
        pad = min(max(round((b[3] - b[1]) * 0.35), 40), 110)
        widened[no] = (max(0, b[0] - pad), max(0, b[1] - pad), min(W, b[2] + pad), min(H, b[3] + pad))
    report("② 现线上（外扩 35%）", widened, truth)
    b3 = report("③ 吸附后（原型 v5）", refined, truth)

    if b3:
        print("\n  吸附后仍有内容在框外的题：")
        for no, c, t, b in sorted(b3, key=lambda x: x[1])[:12]:
            print("    no=%-3s 覆盖 %.2f  真值 %s  吸附 %s" % (no, c, t, b))

    if a.out:
        Path(a.out).write_text(json.dumps(
            {"paper": a.paper, "W": W, "H": H,
             "model": {str(k): list(v) for k, v in model.items()},
             "refined": {str(k): list(v) for k, v in refined.items()},
             "truth": {str(k): list(v) for k, v in truth.items()}},
            ensure_ascii=False, indent=1), encoding="utf-8")
        print("\n写出 ->", a.out)
    if a.preview:
        draw_preview(img, model, refined, truth, Path(a.preview))
        print("校验图 ->", a.preview, "（灰=模型框  蓝=吸附后  红=人工真值）")


if __name__ == "__main__":
    main()
