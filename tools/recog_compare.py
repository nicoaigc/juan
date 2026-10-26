# -*- coding: utf-8 -*-
"""自动识别试点 · 对照脚本
把模型输出（tools/recog_pilot.mjs 产出的 *.parsed.json）与人工标注（data/questions/）逐字段对比。

用法：
  python tools/recog_compare.py --paper "2026-09-30-选择与应用题.jpg" \
         --pred .workbuddy/tmp/recog_pilot/pilot1.parsed.json
"""
import argparse, json, glob, os, re, sys, unicodedata
from difflib import SequenceMatcher

# ---------- 归一化：只比"内容"，不比排版差异 ----------
FULL2HALF = {"（": "(", "）": ")", "，": ",", "。": ".", "：": ":", "；": ";",
             "１": "1", "２": "2", "３": "3", "　": " "}
PUNCT = set(",.:;()、，。：；（）「」《》!?！？--·\u3000 \t\r\n")


def norm_text(s):
    if s is None:
        return ""
    s = str(s)
    for a, b in FULL2HALF.items():
        s = s.replace(a, b)
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[\s\u3000]+", "", s)
    s = s.replace("\\times", "×").replace("\\div", "÷").replace("\\cdot", "·")
    s = s.replace("\\bigcirc", "○").replace("\\text", "")
    s = s.replace("{", "").replace("}", "")
    return s


def frag_text(frags):
    """把片段数组压成一段纯文本（figure 片段跳过）"""
    out = []
    for f in frags or []:
        if f.get("t") == "figure":
            continue
        out.append(f.get("v", ""))
    return "".join(out)


def sim(a, b):
    a, b = norm_text(a), norm_text(b)
    if not a and not b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def iou(a, b):
    if not a or not b or len(a) < 4 or len(b) < 4:
        return None
    ax1, ay1, ax2, ay2 = a[:4]
    bx1, by1, bx2, by2 = b[:4]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else None


def load_truth(paper):
    rows = []
    for p in sorted(glob.glob("data/questions/*.json")):
        d = json.load(open(p, encoding="utf-8"))
        s = d.get("source") or {}
        if s.get("file") != paper:
            continue
        rows.append({
            "id": d["id"], "no": d.get("no"), "type": d.get("type"),
            "section": d.get("section"), "printed_no": s.get("printed_no"),
            "bbox": s.get("bbox"), "stem": frag_text(d.get("stem")),
            "options": frag_text(d.get("options")),
            "n_options": len(d.get("options") or []),
            "figs": [f.get("bbox") for f in (d.get("stem") or []) if f.get("t") == "figure"],
        })
    rows.sort(key=lambda r: (r["no"] if r["no"] is not None else 0))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paper", required=True)
    ap.add_argument("--pred", required=True)
    a = ap.parse_args()

    truth = load_truth(a.paper)
    pred = json.load(open(a.pred, encoding="utf-8"))
    pqs = pred.get("questions") or []

    print("=" * 96)
    print("试卷：%s   （人工 %d 题 / 模型 %d 题）" % (a.paper, len(truth), len(pqs)))
    print("=" * 96)

    if len(truth) != len(pqs):
        print("！！ 题数不一致 —— 逐题对齐没有意义，先看下面两份清单：\n")
        print("[人工]")
        for t in truth:
            print("  no=%-3s %-9s printed_no=%-6s %s" % (t["no"], t["type"], repr(t["printed_no"]), t["stem"][:60]))
        print("[模型]")
        for q in pqs:
            print("  no=%-3s %-9s printed_no=%-6s %s" % (q.get("no"), q.get("type"), repr(q.get("printed_no")), frag_text(q.get("stem"))[:60]))
        print("\n（题数一致才能逐题对账；下面仍按顺序对齐打印差异最大的部分）")

    n = max(len(truth), len(pqs))
    tot = {"stem": [], "opt": [], "bbox": [], "printed_no": 0, "type": 0, "section": 0, "fig": []}
    print("\n%-4s %-7s %-7s %-7s %-7s %-7s %s" % ("序", "题干相似", "选项相似", "题型", "题号", "板块", "bbox IoU"))
    print("-" * 96)
    for i in range(n):
        t = truth[i] if i < len(truth) else None
        q = pqs[i] if i < len(pqs) else None
        if not t or not q:
            print("%-4d  %s" % (i + 1, "缺" + ("人工" if not t else "模型")))
            continue
        s_stem = sim(t["stem"], frag_text(q.get("stem")))
        s_opt = sim(t["options"], frag_text(q.get("options")))
        ok_type = t["type"] == q.get("type")
        ok_no = norm_text(t["printed_no"]) == norm_text(q.get("printed_no"))
        ok_sec = norm_text(t["section"]) == norm_text(q.get("section"))
        j = iou(t["bbox"], q.get("bbox"))
        # 插图 bbox 对账
        fj = None
        if t["figs"] and q:
            pfigs = [f.get("bbox") for f in (q.get("stem") or []) if f.get("t") == "figure"]
            if pfigs:
                fj = iou(t["figs"][0], pfigs[0])
        tot["stem"].append(s_stem)
        tot["opt"].append(s_opt)
        if j is not None:
            tot["bbox"].append(j)
        if fj is not None:
            tot["fig"].append(fj)
        tot["printed_no"] += 1 if ok_no else 0
        tot["type"] += 1 if ok_type else 0
        tot["section"] += 1 if ok_sec else 0
        print("%-4d %-8.2f %-8.2f %-8s %-8s %-8s %s   %s" % (
            i + 1, s_stem, s_opt,
            "✓" if ok_type else "✗", "✓" if ok_no else "✗", "✓" if ok_sec else "✗",
            ("%.2f" % j) if j is not None else "-",
            ("插图IoU=%.2f" % fj) if fj is not None else ""))

    m = min(len(truth), len(pqs))
    print("\n" + "-" * 96)
    if m:
        print("题干文本平均相似度 ：%.3f   （最低 %.3f）" % (sum(tot["stem"]) / m, min(tot["stem"])))
        print("选项文本平均相似度 ：%.3f" % (sum(tot["opt"]) / m))
        print("题型一致           ：%d/%d" % (tot["type"], m))
        print("印刷题号一致       ：%d/%d" % (tot["printed_no"], m))
        print("板块一致           ：%d/%d" % (tot["section"], m))
    if tot["bbox"]:
        print("题区 bbox 平均 IoU ：%.3f   （最低 %.3f）" % (sum(tot["bbox"]) / len(tot["bbox"]), min(tot["bbox"])))
    if tot["fig"]:
        print("插图 bbox 平均 IoU ：%.3f   （最低 %.3f）" % (sum(tot["fig"]) / len(tot["fig"]), min(tot["fig"])))

    print("\n【逐题差异明细】")
    for i in range(m):
        t, q = truth[i], pqs[i]
        tp, qp = t["printed_no"], q.get("printed_no")
        if norm_text(tp) != norm_text(qp):
            print("  第%d题 印刷题号：人工 %r / 模型 %r" % (i + 1, tp, qp))
        if t["type"] != q.get("type"):
            print("  第%d题 题型：人工 %s / 模型 %s" % (i + 1, t["type"], q.get("type")))
        if norm_text(t["section"]) != norm_text(q.get("section")):
            print("  第%d题 板块：人工 %r / 模型 %r" % (i + 1, t["section"], q.get("section")))
        ns, ps = norm_text(t["stem"]), norm_text(frag_text(q.get("stem")))
        if ns != ps:
            print("  第%d题 题干：" % (i + 1))
            print("      人工：%s" % ns)
            print("      模型：%s" % ps)
        no_, po_ = norm_text(t["options"]), norm_text(frag_text(q.get("options")))
        if no_ != po_:
            print("  第%d题 选项：" % (i + 1))
            print("      人工：%s" % no_)
            print("      模型：%s" % po_)
        j = iou(t["bbox"], q.get("bbox"))
        if j is not None and j < 0.85:
            print("  第%d题 题区 bbox：人工 %s / 模型 %s  (IoU %.2f)" % (i + 1, t["bbox"], q.get("bbox"), j))


if __name__ == "__main__":
    main()
