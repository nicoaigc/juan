# -*- coding: utf-8 -*-
"""把「数学三年级第一学期第一、二单元素养卷」（原分两张照片识别）合并成**一份卷**。

两份照片：
    2026-10-01-第一二单元素养卷.jpg       第一部分 计算（20 题，no 1..20）
    2026-10-01-第一二单元素养卷-应用.jpg   第三部分 应用（4 题，no 1..4）

写入三个字段（都挂在 `source` 下）：

    paper       卷标识 —— 同一份卷的多张照片共享同一个值。
                取虚拟文件名 `2026-10-01-第一二单元素养卷.jpg`（**不必真实存在**，
                只为复用「按文件名推日期 / 标题 / slug」那套逻辑）。
    paper_title 卷面印刷标题（原卷页眉那行字），用于卷卡片与卷面抬头。
    paper_page  该题所在照片在**卷内的页序**（1 起）。⚠️ 本卷必需：
                文件名排序里 `...-应用.jpg` 的 `-`(0x2D) 排在 `...卷.jpg` 的 `.`(0x2E) 之前，
                不标页序会把「第三部分 应用」排到「第一部分 计算」前面。

顺带把 `no` 按「卷内页序 + 原 no」重排成 1..24（原来两张照片各有自己的 1..20 / 1..4）。

用法：python tools/group_20261001_sy.py [--apply]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QDIR = ROOT / "data" / "questions"

PAPER = "2026-10-01-第一二单元素养卷.jpg"
PAPER_TITLE = "数学三年级第一学期第一、二单元素养卷"
# 页序：照片文件名 -> 页号
PAGE_OF = {
    "2026-10-01-第一二单元素养卷.jpg": 1,
    "2026-10-01-第一二单元素养卷-应用.jpg": 2,
}
APPLY = "--apply" in sys.argv


def main():
    items = []
    for f in sorted(QDIR.glob("q-*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        fn = str((d.get("source") or {}).get("file") or "")
        if fn in PAGE_OF:
            items.append((f, d))
    if len(items) != 24:
        print(f"[警告] 匹配到 {len(items)} 题，预期 24 题（20 + 4）—— 先核对再动手", file=sys.stderr)

    # 卷内顺序 = 页序 -> 原 no -> id
    items.sort(key=lambda t: (PAGE_OF[str(t[1]["source"]["file"])],
                              t[1].get("no") if isinstance(t[1].get("no"), int) else 9999,
                              t[1]["id"]))

    print(f"{'id':22s} {'页':>2s} {'原no':>5s} {'新no':>5s}  板块")
    changed = 0
    for new_no, (f, d) in enumerate(items, 1):
        src = d["source"]
        page = PAGE_OF[str(src["file"])]
        old_no = d.get("no")
        need = (src.get("paper") != PAPER or src.get("paper_title") != PAPER_TITLE
                or src.get("paper_page") != page or old_no != new_no)
        mark = "  <" if need else ""
        print(f"{d['id']:22s} {page:2d} {str(old_no):>5s} {new_no:5d}  "
              f"{str(d.get('section'))[:20]}{mark}")
        if not need:
            continue
        changed += 1
        src["paper"] = PAPER
        src["paper_title"] = PAPER_TITLE
        src["paper_page"] = page
        d["source"] = src
        d["no"] = new_no
        if APPLY:
            f.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{'已写入' if APPLY else '干跑：待改'} {changed} 题"
          f"（{len(items)} 题中）-> paper={PAPER} / paper_title={PAPER_TITLE}")
    if not APPLY:
        print("加 --apply 才真正写盘")


if __name__ == "__main__":
    main()
