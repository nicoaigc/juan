# -*- coding: utf-8 -*-
"""给「2026-10-01 第2单元练习卷（静安名校）」的 4 张照片题打上**同一份卷**的标识。

背景：一份卷被拍成多张照片时，`source.file` 是「照片文件名」，
于是渲染/成卷会把它当成 4 份独立的卷（卡片标题变成「第2单元练习卷-p1/p2/p3/p4」）。
新增两个**可选**字段解决：

    source.paper       卷标识 —— 同一份卷的多张照片共享同一个值。
                       取值形如 `2026-10-01-第2单元练习卷.jpg`（**虚拟文件名**，
                       不必真实存在），这样 doc_date / doc_title / doc_slug 无需改动。
    source.paper_title 卷面印刷标题（原卷页眉上的那行字），用于卡片与卷面抬头。

渲染层（render.py）与成卷（paper.py --by-doc）的分组键统一用
`source.paper or source.file` —— 不标 paper 的卷仍旧按单张照片分组，行为不变。

用法：python tools/group_20261001_p8.py [--apply]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QDIR = ROOT / "data" / "questions"
PREFIX = "2026-10-01-第2单元练习卷"
PAPER = "2026-10-01-第2单元练习卷.jpg"
PAPER_TITLE = "第2单元练习卷（静安名校）"
APPLY = "--apply" in sys.argv


def main():
    touched = []
    pages = set()
    for f in sorted(QDIR.glob("q-*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        src = d.get("source") or {}
        if not str(src.get("file", "")).startswith(PREFIX):
            continue
        if src.get("paper") == PAPER and src.get("paper_title") == PAPER_TITLE:
            continue
        src["paper"] = PAPER
        src["paper_title"] = PAPER_TITLE
        d["source"] = src
        touched.append(d["id"])
        pages.add(src["file"])
        if APPLY:
            f.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    print(("已写入" if APPLY else "干跑：待改") + f" {len(touched)} 题（{len(pages)} 张照片）")
    for p in sorted(pages):
        print("   ", p)
    if not APPLY:
        print("加 --apply 才真正写盘")


if __name__ == "__main__":
    main()
