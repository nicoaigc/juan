# -*- coding: utf-8 -*-
"""JS 版 refine 与 Python 版 refine 的逐题对账。

用法：
    P=C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe
    $P tools/refine_js_diff.py .workbuddy/tmp/recog_pilot/js_refine_s1.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from refine_proto import DEFAULTS, load_ink, refine  # noqa: E402


def main() -> int:
    js_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".workbuddy/tmp/recog_pilot/js_refine_s1.json"
    rows = json.loads(Path(js_path).read_text(encoding="utf-8"))
    worst = 0
    for r in rows:
        if not r.get("boxes"):
            print("%-16s JS 没产出（%s）" % (r["label"], r.get("err")))
            continue
        img, ink, thr = load_ink(str(ROOT / r["image"]), 0)
        W, H = img.size
        payload = json.loads((ROOT / r["raw"]).read_text(encoding="utf-8"))
        rawq = payload.get("rawQuestions") or payload.get("questions") or []
        boxes, nos, idxs = [], [], []
        for i, q in enumerate(rawq):
            b = q.get("bbox")
            if not b:
                continue
            boxes.append(tuple(int(v) for v in b)); nos.append(q.get("no")); idxs.append(i)
        ref_list, meta = refine(ink, boxes, W, H, DEFAULTS, nos=nos, verbose=False)
        py = {idxs[i]: tuple(int(v) for v in ref_list[i]) for i in range(len(idxs))}

        diffs = []
        for k, b in r["boxes"].items():
            k = int(k)
            if k not in py:
                continue
            p = py[k]
            d = max(abs(b[j] - p[j]) for j in range(4))
            diffs.append((d, k, b, p))
        diffs.sort(reverse=True)
        n = len(diffs)
        bad = [d for d in diffs if d[0] > 2]
        worst = max(worst, diffs[0][0] if diffs else 0)
        print("%-16s %3d 题  最大差 %3dpx  差>2px 的 %d 个  行带 JS=%s / PY=%d" % (
            r["label"], n, diffs[0][0] if diffs else 0, len(bad),
            r.get("lines"), len(meta["lines"])))
        for d, k, b, p in bad[:6]:
            print("      idx=%-3d JS=%s  PY=%s  Δ=%d" % (k, b, list(p), d))
    print("\n全部配置最大坐标差：%dpx" % worst)
    return 0 if worst <= 2 else 1


if __name__ == "__main__":
    sys.exit(main())
