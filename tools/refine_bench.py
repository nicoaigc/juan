# -*- coding: utf-8 -*-
"""扩样本对账：把 tools/refine_proto.py 的同一套参数在**多张卷 / 多次识别**上跑一遍。

为什么要单独一个脚本：`refine_proto.py` 的对账是**按 no 配对**的。这在"卷面有印刷题号"
时没问题，但实测 `2026-09-30-小学练习页.jpg`（一页**没有印刷题号**的口算）会让两边的编号
约定打架 —— 真值按"从左到右"（行优先）编号，模型那一次按"从上到下"（列优先）编号，
两边指的是**同样 24 个格子，只是标签不同**。按 no 配对会把这种"编号约定不同"算成坐标错，
把吸附算法的真实质量压掉一大截。

所以这里提供两种配对口径：

  --match no     按 no 配对（与 `refine_proto.py` / `reco_rows_compare.py` 口径一致）
  --match text   按**题干文本**配对（归一化后相等即认为是同一题）—— 与标签无关，
                 量的是"这个框有没有吸到**它自己那道题**的墨迹"。

两种口径都报，差在哪一目了然：差得多 = 编号约定不一致（坐标其实是对的）；
两种都低 = 真的是坐标没吸准。

用法：
    P=C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe
    $P tools/refine_bench.py \
       --cfg "密集页1=.workbuddy/tmp/recog_pilot/e2e_final.raw.json|data/benchmark/2026-10-01-第2单元练习卷-p1.jpg" \
       --cfg "小学练习页1=.workbuddy/tmp/recog_pilot/nd_page1.raw.json|data/benchmark/2026-09-30-小学练习页.jpg"
"""
from __future__ import annotations

import argparse
import glob
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from refine_proto import DEFAULTS, load_ink, ratio, refine  # noqa: E402


# ---------------------------------------------------------------- 真值（带题干）
def norm_text(s: str) -> str:
    """归一化题干，用于跨"模型输出 / 人工标注"两种来源的文本配对。

    · **NFKC**：真值与模型的全角/半角习惯不同（实测真值写 `,（　）。`、模型写 `，（）？`），
      NFKC 把全角标点、全角数字、表意空格统一成半角，省去逐条列举。
    · 去掉空白与花括号（`\\times 3` 与 `\\times3` 视为同一串）
    · 去掉 `$` 与 `\\left`/`\\right`（排版残留）
    · 统一乘除号写法（模型时而写 `×`、时而写 `\\times`）
    """
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("$", "").replace("\\left", "").replace("\\right", "")
    s = s.replace("\\!", "").replace("\\,", "")
    s = s.replace("\\times", "×").replace("\\div", "÷").replace("\\cdot", "×")
    s = re.sub(r"[\s{}]", "", s)
    return s


def load_truth_full(paper: str) -> dict:
    """返回 {no: {"bbox": (x1,y1,x2,y2), "stem": 归一化题干, "text": 原文}}"""
    out = {}
    for fp in glob.glob("data/questions/*.json"):
        d = json.loads(Path(fp).read_text(encoding="utf-8"))
        s = d.get("source") or {}
        if s.get("file") != paper:
            continue
        frags = d.get("stem") or []
        txt = "".join(f.get("v", "") for f in frags if f.get("t") != "figure")
        figs = sum(1 for f in frags if f.get("t") == "figure")
        out[d["no"]] = {"bbox": tuple(s["bbox"]), "stem": norm_text(txt),
                        "nfig": figs, "text": txt}
    return out


# ---------------------------------------------------------------- 配对
def pair_by_no(model: dict, truth: dict) -> dict:
    return {k: k for k in model if k in truth}


def pair_by_text(model: dict, qs: dict, truth: dict) -> tuple[dict, list]:
    """模型框 no -> 真值 no。按归一化题干配对；同题干的（含纯图题）按距离就近消歧。"""
    by_text = {}
    for no, t in truth.items():
        by_text.setdefault(t["stem"], []).append(no)
    used, mp, miss = set(), {}, []
    for no in sorted(model):
        key = norm_text(qs[no].get("_stem_text", ""))
        cand = [n for n in by_text.get(key, []) if n not in used]
        if not cand:
            miss.append((no, qs[no].get("_stem_text", "")[:40]))
            continue
        if len(cand) > 1:
            mb = model[no]
            mc = ((mb[0] + mb[2]) / 2.0, (mb[1] + mb[3]) / 2.0)

            def dist(n):
                tb = truth[n]["bbox"]
                return (abs((tb[0] + tb[2]) / 2.0 - mc[0])
                        + abs((tb[1] + tb[3]) / 2.0 - mc[1]))

            cand.sort(key=dist)
        t = cand[0]
        used.add(t)
        mp[no] = t
    return mp, miss


# ---------------------------------------------------------------- 评估
def score(boxes: dict, mp: dict, truth: dict) -> tuple:
    cs, ps, js = [], [], []
    for no, tno in mp.items():
        b = boxes.get(no)
        if b is None:
            continue
        t = truth[tno]["bbox"]
        c, p, j = ratio(t, b)
        cs.append(c); ps.append(p); js.append(j)
    if not cs:
        return 0.0, 0.0, 0.0, 0
    n = len(cs)
    return sum(cs) / n, sum(ps) / n, sum(js) / n, n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cfg", action="append", required=True,
                    help='"标签=raw.json|图片路径"；真值文件名默认取图片文件名，可写 "…|图|真值文件名"')
    ap.add_argument("--match", choices=["no", "text", "both"], default="both")
    ap.add_argument("--set", action="append", default=[],
                    help="临时覆盖 DEFAULTS 里的参数，如 --set ink_lum=118 --set seg_min_frac=0")
    ap.add_argument("--preview-dir", default=None, help="给出则每张都出校验图")
    a = ap.parse_args()

    params = dict(DEFAULTS)
    for kv in a.set:
        k, _, v = kv.partition("=")
        params[k] = type(DEFAULTS[k])(float(v)) if isinstance(DEFAULTS[k], float) else int(v)
        print("# 覆盖参数 %s=%s" % (k, params[k]))

    cfgs = []
    for spec in a.cfg:
        label, rest = spec.split("=", 1)
        parts = rest.split("|")
        raw, image = parts[0], parts[1]
        paper = parts[2] if len(parts) > 2 else Path(image).name
        cfgs.append((label, raw, image, paper))

    cache = {}
    rows = []
    for label, rawp, imgp, paper in cfgs:
        if imgp not in cache:
            img, ink, thr = load_ink(imgp, params["ink_lum"])
            cache[imgp] = (img, ink, thr)
        img, ink, ink_thr = cache[imgp]
        W, H = img.size
        payload = json.loads(Path(rawp).read_text(encoding="utf-8"))
        rawq = payload.get("rawQuestions") or []
        truth = load_truth_full(paper)

        model, qs, nos = {}, {}, []
        for q in rawq:
            b = q.get("bbox")
            if not b:
                continue
            frags = q.get("stem") or []
            txt = "".join(f.get("v", "") for f in frags if f.get("t") != "figure")
            model[q["no"]] = tuple(int(v) for v in b)
            qs[q["no"]] = {"_stem_text": txt}
            nos.append(q["no"])
        order = nos
        boxes = [model[n] for n in order]

        ref_list, _ = refine(ink, boxes, W, H, params, nos=order, verbose=False)
        refined = {order[i]: tuple(int(v) for v in ref_list[i]) for i in range(len(order))}
        widened = {}
        for no, b in model.items():
            pad = min(max(round((b[3] - b[1]) * 0.35), 40), 110)
            widened[no] = (max(0, b[0] - pad), max(0, b[1] - pad),
                           min(W, b[2] + pad), min(H, b[3] + pad))

        res = {"label": label, "paper": paper, "img": imgp,
               "n_model": len(model), "n_truth": len(truth), "W": W, "H": H,
               "ink": 100.0 * ink.mean(), "ink_thr": ink_thr, "model": model, "refined": refined,
               "truth": {k: v["bbox"] for k, v in truth.items()},
               "only_truth": sorted(set(truth) - set(model))}
        for mode in (["no"] if a.match == "no" else ["text"] if a.match == "text" else ["no", "text"]):
            mp = pair_by_no(model, truth) if mode == "no" else pair_by_text(model, qs, truth)[0]
            miss = [] if mode == "no" else pair_by_text(model, qs, truth)[1]
            res[mode] = {
                "raw": score(model, mp, truth),
                "wide": score(widened, mp, truth),
                "ref": score(refined, mp, truth),
                "matched": len(mp), "miss": miss,
            }
        rows.append(res)

    for r in rows:
        print("=" * 100)
        print("%s   %s   %d×%d  墨 %.2f%%(阈值%d)   模型 %d 框 / 真值 %d 题%s" % (
            r["label"], Path(r["img"]).name, r["W"], r["H"], r["ink"], r["ink_thr"],
            r["n_model"], r["n_truth"],
            "   模型漏掉：%s" % r["only_truth"] if r["only_truth"] else ""))
        for mode in ("no", "text"):
            if mode not in r:
                continue
            d = r[mode]
            print("  配对=%-5s 命中 %d 对%s" % (
                mode, d["matched"],
                "   未配上的模型框：%s" % [m[0] for m in d["miss"]] if d["miss"] else ""))
            print("      ① 模型原始框  覆盖 %.3f  精度 %.3f  IoU %.3f" % d["raw"][:3])
            print("      ② 外扩 35%%     覆盖 %.3f  精度 %.3f  IoU %.3f" % d["wide"][:3])
            print("      ③ 吸附后      覆盖 %.3f  精度 %.3f  IoU %.3f" % d["ref"][:3])

    print("=" * 100)
    print("\n汇总（覆盖率 / IoU）—— 配对=text 时与编号约定无关\n")
    print("%-26s %-22s %-22s %-22s" % ("配置", "① 模型原始框", "② 外扩 35%", "③ 吸附后"))
    print("-" * 100)
    for r in rows:
        if "text" not in r:
            continue
        d = r["text"]
        print("%-26s %.3f / %.3f        %.3f / %.3f        %.3f / %.3f" % (
            r["label"], d["raw"][0], d["raw"][2], d["wide"][0], d["wide"][2],
            d["ref"][0], d["ref"][2]))
    if a.match == "both":
        print("\n按 no 配对的同一张表（与 refine_proto.py 口径一致）\n")
        for r in rows:
            d = r["no"]
            print("%-26s %.3f / %.3f        %.3f / %.3f        %.3f / %.3f" % (
                r["label"], d["raw"][0], d["raw"][2], d["wide"][0], d["wide"][2],
                d["ref"][0], d["ref"][2]))

    if a.preview_dir:
        from refine_proto import draw_preview
        out = Path(a.preview_dir); out.mkdir(parents=True, exist_ok=True)
        for r in rows:
            p = out / ("bench_%s.jpg" % re.sub(r"[^\w.-]", "_", r["label"]))
            img = Image.open(r["img"]).convert("RGB")
            draw_preview(img, r["model"], r["refined"], r["truth"], p)
            print("校验图 ->", p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
