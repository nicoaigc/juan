# -*- coding: utf-8 -*-
"""修正 2026-10-01 两处解析错误（第二批）。

## 修正一：「写出综合算式」把**同一小题的两条算式**拆成了两道题

原卷版式（两份卷子完全一样）：

    (1) 63÷9=7            (2) 367+26=393
        147-7=140             494-393=101
        ［学生在这里写综合算式］

印刷小题号只出现**两次**（`(1)` `(2)`），每条小题是「两条已知算式 + 一条答题位置」。
上一轮按「一条算式一道题」入库（`printed_no` 为空的两条也各成了一道题），
结果一份小题被拆成两题，卷详情页里 (1) 的第一条算式和第二条算式被 (2) 隔开
（用户反馈：「综合算式题被拆开了」）。

规范原文是「**印刷小题号出现几次就成几题**」——所以正确答案是 **2 题**，不是 4 题。
被并入的那两条 `printed_no == ""`，正是「不是新小题」的信号。

    q-20261001-001 + q-20261001-003 -> q-20261001-001（63÷9=7 / 147-7=140）
    q-20261001-002 + q-20261001-004 -> q-20261001-002（367+26=393 / 494-393=101）
    q-20261001-033 + q-20261001-035 -> q-20261001-033
    q-20261001-034 + q-20261001-036 -> q-20261001-034   ← 同一份卷的另一张照片

小题内的多行用一个 `\\n` 表示，渲染时换成 `<br>`（渲染层已同步改）。

## 修正二：q-20261001-042 丢了两个印刷标签

卷面在题干下方另印有「①估算法：」「②计算法：」两行**作答位置标签**。
上一轮判为「只有标签、无小题内容」把它并入了 review_note，但用户指出这是**卷面上真实存在的印刷内容**，
不该丢（反馈：「这一题下面有指定了两个解法的名词被丢了」）。
本次把两行写回 stem（同样用 `\\n`），并把裁剪范围扩到覆盖这两行——
题区 = 该题在卷面上的**全部印刷范围**，左右对照才对得起来。

用法: python tools/fix_20261001_rev2.py            # 干跑，只打印将要做的改动
      python tools/fix_20261001_rev2.py --apply    # 真正写入（先自动备份）
"""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
QS = ROOT / "data" / "questions"
CROPS = ROOT / "data" / "crops"
BENCH = ROOT / "data" / "benchmark"
BACKUP = ROOT / "data" / "_backup_20261001_rev2"

# ---- 修正一：合并（保留 id, 被并入 id, 合并说明）
MERGES = [
    ("2026-10-01-乘法综合练习.jpg", [
        ("q-20261001-001", "q-20261001-003", "(1)"),
        ("q-20261001-002", "q-20261001-004", "(2)"),
    ]),
    ("2026-10-01-第一二单元素养卷.jpg", [
        ("q-20261001-033", "q-20261001-035", "(1)"),
        ("q-20261001-034", "q-20261001-036", "(2)"),
    ]),
]

MERGE_NOTE = (
    "本题原卷印的是「印刷小题号 {no} + 两条已知算式」，两条算式同属**一个**小题"
    "（学生要在下方空白处写出把两条算式并起来的综合算式），不是两道题——"
    "按规范「印刷小题号出现几次就成几题」，此处合并为 1 题，行间用换行表示。"
    "（原先按「一条算式一题」拆成了两题，卷详情页里同一小题的两条算式被邻题隔开，用户反馈过。）"
)

# ---- 修正二：给 q-20261001-042 补回卷面上的两个作答位置标签
LABEL_QID = "q-20261001-042"
LABEL_TEXT = "另起一行印有「①估算法：」、下方隔开一段再印「②计算法：」两行**作答位置标签**"
LABEL_NOTE = (
    "卷面在题干下方另印有「①估算法：」（y1299–1325, x171–296）与「②计算法：」（y1516–1541, x181–305）"
    "两行作答位置标签（印刷体，两行之间是学生手写作答）。上一轮把它们判成「只有标签、无小题内容」"
    "而未入题干，用户指出这是卷面上真实存在的印刷内容、不该丢；本次已写回 stem（行间用换行表示），"
    "并把裁剪范围下延到覆盖这两行——题区 = 该题在卷面上的全部印刷范围，左右对照才对得起来。"
    "左边界仍取题干首行首字 x158（题号「4.」留在图内，原因见原 review_note）。"
)
# 裁剪下边界：取到 ② 标签底边 + 8px 留白
LABEL_CROP_BOTTOM = 1549


def load(qid: str) -> dict:
    return json.loads((QS / f"{qid}.json").read_text(encoding="utf-8"))


def save(q: dict, apply: bool) -> None:
    if apply:
        (QS / f"{q['id']}.json").write_text(
            json.dumps(q, ensure_ascii=False, indent=2), encoding="utf-8")


def stem_text(q: dict) -> str:
    return "".join(str(s.get("v", "")) for s in q.get("stem") or [])


def union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def main() -> int:
    apply = "--apply" in sys.argv
    action = "写入" if apply else "【干跑】将要"
    imgs: dict[str, Image.Image] = {}
    removed: list[str] = []
    dirty_docs: set[str] = set()

    if apply:
        BACKUP.mkdir(parents=True, exist_ok=True)

    print(f"=== 修正一：按印刷小题号合并「写出综合算式」({action}执行) ===")
    for fname, pairs in MERGES:
        im = imgs.setdefault(fname, Image.open(BENCH / fname).convert("RGB"))
        for keep_id, drop_id, no in pairs:
            keep, drop = load(keep_id), load(drop_id)
            if apply:
                for qid in (keep_id, drop_id):
                    shutil.copy2(QS / f"{qid}.json", BACKUP / f"{qid}.json")
                    shutil.copy2(CROPS / f"{qid}.jpg", BACKUP / f"{qid}.jpg")
            lines = [stem_text(keep), stem_text(drop)]
            bbox = union(keep["source"]["bbox"], drop["source"]["bbox"])
            bbox[3] += 2                      # 两条各自带 8px 留白，合并后再补一点
            keep["stem"] = [{"t": "text", "v": "\n".join(lines)}]
            keep["source"]["bbox"] = bbox
            keep["source"]["crop_reviewed"] = True
            keep["source"]["review_note"] = (
                MERGE_NOTE.format(no=no) + " 裁剪范围 = 两条算式的并集。"
            )
            keep["updated_at"] = drop["updated_at"]
            save(keep, apply)
            if apply:
                im.crop(tuple(bbox)).save(CROPS / f"{keep_id}.jpg", quality=95)
                (QS / f"{drop_id}.json").unlink()
                (CROPS / f"{drop_id}.jpg").unlink()
            removed.append(drop_id)
            dirty_docs.add(fname)
            print(f"  {keep_id} ← {drop_id}   {lines[0]} / {lines[1]}   bbox={bbox}")
            print(f"      删除 {drop_id}.json + {drop_id}.jpg")

    print(f"\n=== 修正二：补回 q-20261001-042 的两个作答位置标签 ({action}执行) ===")
    q = load(LABEL_QID)
    base = stem_text(q)
    assert "①估算法" not in base, "已经有了，不用重复补"
    bbox = list(q["source"]["bbox"])
    new_bbox = [bbox[0], bbox[1], max(bbox[2], 305 + 8), LABEL_CROP_BOTTOM]
    if apply:
        shutil.copy2(QS / f"{LABEL_QID}.json", BACKUP / f"{LABEL_QID}.json")
        shutil.copy2(CROPS / f"{LABEL_QID}.jpg", BACKUP / f"{LABEL_QID}.jpg")
    q["stem"] = [{"t": "text", "v": base + "\n①估算法：\n②计算法："}]
    q["source"]["bbox"] = new_bbox
    q["source"]["crop_reviewed"] = True
    q["source"]["review_note"] = LABEL_NOTE
    save(q, apply)
    if apply:
        imgs.setdefault(q["source"]["file"],
                        Image.open(BENCH / q["source"]["file"]).convert("RGB"))
        imgs[q["source"]["file"]].crop(tuple(new_bbox)).save(
            CROPS / f"{LABEL_QID}.jpg", quality=95)
    dirty_docs.add(q["source"]["file"])
    print(f"  题干 -> {q['stem'][0]['v']!r}")
    print(f"  bbox {bbox} -> {new_bbox}（下边界下延到 ② 标签之下，覆盖全部印刷内容）")

    # ---- 卷内序号重排：no = 卷内阅读顺序，必须 1..N 连续
    print(f"\n=== 卷内序号重排 ({action}执行) ===")
    for fname in sorted(dirty_docs):
        items = []
        for f in QS.glob("*.json"):
            d = json.loads(f.read_text(encoding="utf-8"))
            if d["source"]["file"] == fname and d["id"] not in removed:
                items.append(d)
        items.sort(key=lambda d: d["no"])
        changed = [(d["id"], d["no"], i) for i, d in enumerate(items, 1) if d["no"] != i]
        for i, d in enumerate(items, 1):
            if d["no"] != i:
                d["no"] = i
                save(d, apply)
        print(f"  {fname}：{len(items)} 题 -> no 1..{len(items)}；改动 {len(changed)} 条")
        for qid, old, new in changed[:6]:
            print(f"      {qid}: {old} -> {new}")
        if len(changed) > 6:
            print(f"      …另 {len(changed) - 6} 条")

    print(f"\n被删除的题：{', '.join(removed)}")
    if apply:
        print(f"原件已备份到 {BACKUP}")
        print("下一步：python engine/db.py import data/questions --prune"
              "  →  engine/paper.py --by-doc  →  engine/render.py data/questions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
