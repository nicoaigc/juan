# -*- coding: utf-8 -*-
"""把「数学三年级第一学期第一、二单元素养卷」的**第三张照片**（乘法综合练习）也并进同一份卷。

背景（详见 .workbuddy/memory/2026-10-05.md）：这份卷被拍成了三张有重叠的照片，
但最初只把前两张（计算 / 应用）合成了一份卷，`2026-10-01-乘法综合练习.jpg` 还自成一份：

    2026-10-01-第一二单元素养卷.jpg       第一部分 计算（20 题）      ← 卷头在这张上
    2026-10-01-乘法综合练习.jpg           4./5. 接缝重拍 + 第二部分 概念（14 题）
    2026-10-01-第一二单元素养卷-应用.jpg   第三部分 应用（4 题）

判据：① 三张的板块接得上（第一部分 计算 → 第二部分 概念 → 第三部分 应用）；
② 乘法卷顶部把前一张底部的「4. 写出综合算式」又拍了一遍，两条算式一字不差（照片重叠）；
③ 乘法卷**没有**卷头 —— 是同一张卷子的下半段的续拍，而不是另一份材料。

所以这里补上第三张照片：写入 `source.paper` / `paper_title` / `paper_page=2`，
并把「第三部分 应用」的 `paper_page` 从 2 改成 3，最后按「页序 + 原 no」把 `no` 重排成 1..38。

⚠️ 接缝处重复的题（`4. 写出综合算式`）**不在识别层删**（题库保持全量，见 recognition-spec）；
   打印时由 `paper.py` 的内容指纹去重（合卷 `collect(dedup=)` 与按卷还原 `collect_doc(dedup=)`）。

用法：python tools/group_20261001_sy2.py [--apply]
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
    "2026-10-01-乘法综合练习.jpg": 2,
    "2026-10-01-第一二单元素养卷-应用.jpg": 3,
}
# 原本已并进本卷的照片（第二次合并时按 paper 匹配；乘法卷还没标 paper，按 file 匹配）
LEGACY_PAPER = "2026-10-01-第一二单元素养卷.jpg"
EXTRA_FILE = "2026-10-01-乘法综合练习.jpg"
EXPECT = 20 + 14 + 4      # 20 计算 + 14 乘法卷 + 4 应用
APPLY = "--apply" in sys.argv


def main():
    items = []
    for f in sorted(QDIR.glob("q-*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        src = d.get("source") or {}
        fn = str(src.get("file") or "")
        if src.get("paper") == LEGACY_PAPER or fn in (LEGACY_PAPER, EXTRA_FILE):
            items.append((f, d))
    if len(items) != EXPECT:
        print(f"[警告] 匹配到 {len(items)} 题，预期 {EXPECT} 题（20 + 14 + 4）—— 先核对再动手",
              file=sys.stderr)

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
              f"{str(d.get('section'))[:22]}{mark}")
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

    print(f"\n{'已写入' if APPLY else '干跑：待改'} {changed} 题（{len(items)} 题中）"
          f"-> paper={PAPER} / {len(PAGE_OF)} 张照片 / no 1..{len(items)}")
    if not APPLY:
        print("加 --apply 才真正写盘")


if __name__ == "__main__":
    main()
