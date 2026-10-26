# -*- coding: utf-8 -*-
"""插图框吸附对账：在**人工逐像素核过**的插图框上比「现状（等量外扩）」与「吸附」。

用法：
    P=C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe
    $P tools/figsnap_eval.py                     # 默认参数，逐样本表
    $P tools/figsnap_eval.py '{"gap_y": 20}'     # 覆盖参数（JSON），调参用
    $P tools/figsnap_eval.py --json out.json     # 另存逐样本结果（给 JS 侧对账用）

样本（9 张插图，覆盖 paper6「1011」的 7 张 + 语料里 2 张有模型原始框的）：
  · 「模型原始框」怎么来的：插图的落库框 = 模型框 + 等量外扩（外扩量只由框的尺寸决定），
    所以从落库框可以**反推**出当年的模型框；语料那两张直接取自识别原始输出
    （.workbuddy/tmp/recog_pilot/e2e_fig.raw.json）。
  · 「人工真值框」= 在放大的原图上逐条核过的框（paper6 那 7 张这一轮重新核过一遍）。

指标：IoU（交并比）与「真值被覆盖的比例」。「比现状差」的样本单独标出来——
吸附带逐张独立兜底，**理论上不该出现"变差"**，出现就是 bug。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from figsnap_proto import (  # noqa: E402
    fig_content_area, fig_params, fig_scale, fig_snap_core, load_ink_work,
)

ROOT = Path(__file__).resolve().parents[1]
BM = ROOT / "data/benchmark"
P6 = {n: BM / ("2026-10-11-试卷1011-p%d.jpg" % n) for n in (1, 2, 3, 4)}
QY = BM / "2026-09-30-选择与应用题.jpg"

# (标签, 图片, 模型原始框, 人工真值框)
CASES = [
    ("q29 p2", P6[2], [957, 1187, 1034, 1357], [928, 1176, 1058, 1378]),
    ("q30 p2", P6[2], [145, 1525, 321, 1665], [145, 1512, 355, 1702]),
    ("q32 p3", P6[3], [935, 404, 1031, 605], [885, 366, 1054, 554]),
    ("q35 p3", P6[3], [952, 1375, 1037, 1589], [925, 1215, 1080, 1430]),
    ("q37 p4", P6[4], [591, 601, 944, 764], [528, 576, 978, 798]),
    ("q39甲 p4", P6[4], [220, 1320, 475, 1440], [82, 1284, 396, 1434]),
    ("q39乙 p4", P6[4], [575, 1320, 905, 1440], [450, 1284, 820, 1434]),
    ("泳道 0930", QY, [960, 700, 1330, 950], [978, 711, 1335, 963]),
    ("电梯 0930", QY, [1030, 1080, 1250, 1270], [1069, 1096, 1329, 1336]),
]


def widen(box):
    """现状策略（= recognize.js 的 toRow 对插图做的）：外扩 min(w,h)×25%，夹在 30~80。"""
    w, h = box[2] - box[0], box[3] - box[1]
    k = min(max(round(min(w, h) * 0.25), 30), 80)
    return [box[0] - k, box[1] - k, box[2] + k, box[3] + k]


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ar = (a[2] - a[0]) * (a[3] - a[1]); br = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (ar + br - inter)


def cover(truth, got):
    ix = max(0, min(truth[2], got[2]) - max(truth[0], got[0]))
    iy = max(0, min(truth[3], got[3]) - max(truth[1], got[1]))
    return (ix * iy) / max(1, (truth[2] - truth[0]) * (truth[3] - truth[1]))


def main():
    args = sys.argv[1:]
    over = {}
    if args and not args[0].startswith("--"):
        over = json.loads(args[0])
        args = args[1:]
    out_json = None
    if "--json" in args:
        out_json = args[args.index("--json") + 1]
    p = fig_params(over)
    cache = {}
    agg_o = agg_n = 0.0
    worse = []
    rec = []
    print("%-10s %-20s %-20s %s" % ("样本", "现状(外扩) IoU/覆盖", "吸附后 IoU/覆盖", "吸附结果"))
    for label, img, mb, truth in CASES:
        if img not in cache:
            cache[img] = load_ink_work(img, int(p["work_max"]))
        W0, H0, s, ink, thr = cache[img]
        base = widen(mb)
        oi, oc = iou(base, truth), cover(truth, base)
        q = fig_scale(p, s)
        area = fig_content_area(ink, q["bar_frac"])
        r = fig_snap_core(ink, ink.shape[1], ink.shape[0],
                          [mb[0] * s, mb[1] * s, mb[2] * s, mb[3] * s], q, area)
        if r is None:
            ni, nc, txt, got = oi, oc, "兜底 → 外扩 %s" % base, None
        else:
            got = [round(v / s) for v in r]
            ni, nc, txt = iou(got, truth), cover(truth, got), str(got)
        if ni < oi - 0.02:                      # 容差 0.02：等价框 ±几像素的抖动不算
            worse.append(label)
        agg_o += oi; agg_n += ni
        rec.append({"label": label, "image": str(img.relative_to(ROOT)).replace("\\", "/"),
                    "model": mb, "truth": truth, "widen": base, "snap": got})
        print("%-10s %.3f/%.2f%-12s %.3f/%.2f%-12s %s" % (label, oi, oc, "", ni, nc, "", txt))
    n = len(CASES)
    print("\n平均 IoU：现状 %.3f → 吸附 %.3f   （%d 张样本）" % (agg_o / n, agg_n / n, n))
    print("比现状差（容差 0.02）：%s" % (worse if worse else "无"))
    print("参数覆盖：", over if over else "（默认）")
    if out_json:
        Path(out_json).write_text(json.dumps({"params": over, "cases": rec}, ensure_ascii=False, indent=1),
                                  encoding="utf-8")
        print("->", out_json)


if __name__ == "__main__":
    main()
