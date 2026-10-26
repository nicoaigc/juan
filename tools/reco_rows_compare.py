# -*- coding: utf-8 -*-
"""对账「应用真实落库的识别结果」与人工标注。

与 recog_compare.py 的分工：
  · recog_compare.py   → 验**模型能力**（原始输出，不做任何加工）
  · 本脚本             → 验**应用的归一化 + 外扩策略**：输入是 tools/reco_e2e_check.mjs 产出的
                         .rows.json，它与 recognizePaper 即将写进库的行等价 ——
                         但那个脚本本身**不写库**（不建卷/不上传/不 addQuestions），
                         所以这里验的是"会写成什么样"，不是"库里真的存了什么"。

坐标这一块本脚本看三个数，而不是只看 IoU：
  · 覆盖率  真值有多少落在落库框里 —— **最要紧**，掉了内容用户就看不到
  · 精度    落库框里有多少是真值   —— 框放太宽会带一堆隔壁题
  · IoU     综合贴合度             —— 因为框是**刻意放大**的，IoU 天然偏低，别只看它

用法：
  python tools/reco_rows_compare.py --rows .workbuddy/tmp/recog_pilot/e2e_p2p1.rows.json \
         --paper "2026-10-01-第2单元练习卷-p1.jpg"
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path
from unicodedata import normalize

from difflib import SequenceMatcher

FULL2HALF = {"（": "(", "）": ")", "，": ",", "。": ".", "：": ":", "；": ";"}


def norm_text(s) -> str:
    s = str(s or "")
    for a, b in FULL2HALF.items():
        s = s.replace(a, b)
    s = normalize("NFKC", s)
    import re
    s = re.sub(r"[\s\u3000]+", "", s)
    for a, b in (("\\times", "×"), ("\\div", "÷"), ("\\bigcirc", "○"), ("\\cdot", "·")):
        s = s.replace(a, b)
    return s.replace("\\text", "").replace("{", "").replace("}", "")


def frag_text(frags) -> str:
    return "".join(f.get("v", "") for f in (frags or []) if f.get("t") != "figure")


def sim(a, b) -> float:
    a, b = norm_text(a), norm_text(b)
    return 1.0 if not a and not b else SequenceMatcher(None, a, b).ratio()


def ratio(a, b) -> tuple[float, float, float]:
    """返回 (覆盖率, 精度, IoU)"""
    ax1, ay1, ax2, ay2 = a[:4]
    bx1, by1, bx2, by2 = b[:4]
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
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
        out[d["no"]] = {
            "type": d.get("type"), "section": d.get("section"),
            "printed_no": s.get("printed_no"), "bbox": s.get("bbox"),
            "stem": frag_text(d.get("stem")), "options": frag_text(d.get("options")),
            "figs": [f.get("bbox") for f in (d.get("stem") or []) if f.get("t") == "figure"],
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--paper", required=True)
    a = ap.parse_args()

    payload = json.loads(Path(a.rows).read_text(encoding="utf-8"))
    rows = payload["rows"]
    W, H = payload.get("W"), payload.get("H")
    truth = load_truth(a.paper)

    print("=" * 104)
    print("试卷 %s   落库 %d 题 / 人工 %d 题   图片 %s×%s" % (a.paper, len(rows), len(truth), W, H))
    print("=" * 104)
    print("%-4s %-7s %-7s %-7s %-7s %-7s %-6s %-6s %-6s" % (
        "no", "题干", "选项", "题型", "题号", "板块", "覆盖", "精度", "IoU"))
    print("-" * 104)

    cs, ps, js = [], [], []
    s_stem, s_opt = [], []
    ok_type = ok_no = ok_sec = 0
    oob = []
    for r in rows:
        no = r.get("qno")
        t = truth.get(no)
        if not t:
            print("%-4s 人工标注里没有这道题" % no)
            continue
        b = (r.get("source") or {}).get("bbox")
        ss = sim(t["stem"], frag_text(r.get("stem")))
        so = sim(t["options"], frag_text(r.get("options")))
        c = p = j = None
        if b and t["bbox"]:
            c, p, j = ratio(t["bbox"], b)
            cs.append(c); ps.append(p); js.append(j)
            if c < 0.999:
                oob.append((no, t["bbox"], b, c))
        s_stem.append(ss); s_opt.append(so)
        ok_type += 1 if t["type"] == r.get("qtype") else 0
        ok_no += 1 if norm_text(t["printed_no"]) == norm_text(r.get("printed_no")) else 0
        ok_sec += 1 if norm_text(t["section"]) == norm_text(r.get("section")) else 0
        print("%-4s %-7.2f %-7.2f %-7s %-7s %-7s %-6s %-6s %-6s" % (
            no, ss, so,
            "✓" if t["type"] == r.get("qtype") else "✗",
            "✓" if norm_text(t["printed_no"]) == norm_text(r.get("printed_no")) else "✗",
            "✓" if norm_text(t["section"]) == norm_text(r.get("section")) else "✗",
            ("%.2f" % c) if c is not None else "-",
            ("%.2f" % p) if p is not None else "-",
            ("%.2f" % j) if j is not None else "-"))

    n = len(rows)
    print("\n" + "-" * 104)
    print("题干文本平均相似度 ：%.3f   （最低 %.3f）" % (sum(s_stem) / n, min(s_stem)))
    print("选项文本平均相似度 ：%.3f" % (sum(s_opt) / n))
    print("题型一致           ：%d/%d" % (ok_type, n))
    print("印刷题号一致       ：%d/%d" % (ok_no, n))
    print("板块一致           ：%d/%d" % (ok_sec, n))
    if cs:
        print()
        print("坐标覆盖率 平均 %.3f   完全覆盖(≥0.99) %d/%d   ≥0.95 的 %d/%d" % (
            sum(cs) / len(cs), sum(1 for v in cs if v >= 0.99), len(cs),
            sum(1 for v in cs if v >= 0.95), len(cs)))
        print("坐标精度   平均 %.3f   （框里有多大比例是这道题本身）" % (sum(ps) / len(ps)))
        print("坐标 IoU   平均 %.3f   （框刻意放大，这个数天然偏低）" % (sum(js) / len(js)))

    # 插图：落库的 figure bbox 与人工标注的逐个比
    fig_pairs = []
    for r in rows:
        t = truth.get(r.get("qno"))
        if not t:
            continue
        pfigs = [f.get("bbox") for f in (r.get("stem") or [])
                 if f.get("t") == "figure" and f.get("bbox")]
        tfigs = t.get("figs") or []
        for i in range(min(len(pfigs), len(tfigs))):
            fig_pairs.append((r.get("qno"), tfigs[i], pfigs[i]))
    if fig_pairs:
        print("\n插图 %d 张：" % len(fig_pairs))
        for no, tb, fb in fig_pairs:
            c, p, j = ratio(tb, fb)
            print("  no=%-3s 人工 %-26s 落库 %-26s 覆盖 %.2f 精度 %.2f IoU %.2f" % (
                no, str(tb), str(fb), c, p, j))

    if oob:
        print("\n【有内容落在框外的题】（覆盖率 < 0.999）")
        for no, tb, b, c in oob:
            print("  no=%-3s 覆盖 %.2f  人工 %s  落库 %s" % (no, c, tb, b))


if __name__ == "__main__":
    main()
