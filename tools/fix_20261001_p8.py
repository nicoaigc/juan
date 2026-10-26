# -*- coding: utf-8 -*-
"""2026-10-01 第2单元练习卷（静安名校）入库后的文字层规范化。

只动本卷（source.file 以 2026-10-01-第2单元练习卷 开头）的 JSON，三件事：
 1) 留空圆括号宽度统一：库里既有约定是「（\u3000\u3000）」（两个全角空格，见 q-20260930-050），
    本卷首次入库写成了一个全角空格 -> 补齐。只改 text 片段里的 `（\u3000）`。
 2) q-20261001-083（七、选择 第4题）：卷面是「（ ）里最大填几？」换行后
    「（ ）×60<431」在左、「1480>（ ）×300」在右**同一行** -> 把两条算式放回一行
    （用全角空格分隔），不再各占一行。
 3) q-20261001-077/078/079 的 review_note 里写着「判断题括号是卷面印刷，照实写（　）」，
    实测**原卷判断题没有任何印刷括号**（学生直接在行尾写 √/×）—— 去掉这句错误描述。

用法：python tools/fix_20261001_p8.py [--apply]   （默认干跑）
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QDIR = ROOT / "data" / "questions"
PREFIX = "2026-10-01-第2单元练习卷"
APPLY = "--apply" in sys.argv

EMPTY1 = "（\u3000）"          # 一个全角空格（本卷错误写法）
EMPTY2 = "（\u3000\u3000）"    # 两个全角空格（库内既有约定）


def ws(v: str) -> str:
    return v.replace(EMPTY1, EMPTY2)


def main():
    changed = []
    for f in sorted(QDIR.glob("q-*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if not str(d.get("source", {}).get("file", "")).startswith(PREFIX):
            continue
        qid = d["id"]
        before = json.dumps(d, ensure_ascii=False, sort_keys=True)

        # 1) 留空括号宽度
        for s in d["stem"]:
            if s.get("t") == "text" and isinstance(s.get("v"), str):
                s["v"] = ws(s["v"])
        for o in (d.get("options") or []):
            if isinstance(o.get("v"), str):
                o["v"] = ws(o["v"])

        # 2) 083 两条算式回到同一行
        if qid == "q-20261001-083":
            for s in d["stem"]:
                if s.get("t") == "text" and "1480>" in (s.get("v") or ""):
                    s["v"] = ("（\u3000\u3000）里最大填几？\n"
                              "（\u3000\u3000）×60<431\u30001480>（\u3000\u3000）×300")

        # 3) 判断题 note 更正
        src = d["source"]
        note = src.get("review_note") or ""
        if "判断题括号是卷面印刷" in note:
            src["review_note"] = (
                "左边界紧邻已剔除的卷面题号（题号 x189-215，正文 x230 起）。"
                "⚠️ 更正：原卷判断题**没有任何印刷括号**，学生直接在行尾写 √/×，"
                "故 stem 里不写「（　）」。")

        after = json.dumps(d, ensure_ascii=False, sort_keys=True)
        if after != before:
            changed.append(qid)
            if APPLY:
                f.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")

    print(("已写入" if APPLY else "干跑：待改") + f" {len(changed)} 题：{changed}")
    if not APPLY:
        print("加 --apply 才真正写盘")


if __name__ == "__main__":
    main()
