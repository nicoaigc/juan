# -*- coding: utf-8 -*-
"""schema v1 -> v2 精简迁移。

v2 的定位：**只做题目识别**——把卷面上的题目结构化下来，外加题型分类。
凡是「分析」或「错题本」性质的内容一律移出 schema。

保留（识别必需）:
    schema_version, id, no, section, type, stem, options, source, confidence,
    created_at, updated_at

移除（分析 / 错题本）:
    answer            标准答案（助手计算的，非卷面内容）
    analysis          解析
    student_answer    学生手写作答
    annotations       红笔批改笔迹
    judgement         对错判定（依赖 answer，属分析）
    tags              知识点 / 错因 / 难度
    note              备注（含"待校对确认"等分析性说明）
    redo_history      重做记录
    confidence.answer 对应的置信度项

v1 原文件完整备份到 data/questions_v1_backup/（迁移可逆）。

用法:
    python tools/migrate_v1_to_v2.py            # 执行迁移
    python tools/migrate_v1_to_v2.py --dry-run  # 只看会做什么，不写文件
"""
import json
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = PROJECT_ROOT / "data" / "questions"
BAK_DIR = PROJECT_ROOT / "data" / "questions_v1_backup"

KEEP = ("id", "no", "section", "type", "stem", "options", "source", "confidence")
DROP = ("answer", "analysis", "student_answer", "annotations",
        "judgement", "tags", "note", "redo_history")
CONF_KEEP = ("stem", "options", "figure")


def migrate(data: dict) -> dict:
    """返回 v2 结构（字段顺序固定，便于人工阅读 diff）。"""
    out = {"schema_version": 2}
    for key in KEEP:
        if key in data and data[key] is not None:
            out[key] = data[key]
    conf = data.get("confidence") or {}
    kept = {k: conf[k] for k in CONF_KEEP if k in conf}
    if kept:
        out["confidence"] = kept
    for key in ("created_at", "updated_at"):
        if key in data:
            out[key] = data[key]
    return out


def main() -> int:
    dry = "--dry-run" in sys.argv
    files = sorted(SRC_DIR.glob("*.json"))
    if not files:
        print(f"没有找到题目 JSON：{SRC_DIR}", file=sys.stderr)
        return 1

    need = []
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        if d.get("schema_version") != 2:
            need.append(f)
    if not need:
        print(f"全部 {len(files)} 题已是 schema v2，无需迁移。")
        return 0

    print(f"待迁移 {len(need)}/{len(files)} 题 -> {BAK_DIR}")
    if dry:
        print("（--dry-run，不写文件）")
        return 0

    BAK_DIR.mkdir(parents=True, exist_ok=True)
    removed_counter: dict[str, int] = {}
    for f in need:
        d = json.loads(f.read_text(encoding="utf-8"))
        # 备份原件（只备份第一次，避免覆盖掉更早的 v1 快照）
        bak = BAK_DIR / f.name
        if not bak.exists():
            shutil.copy2(f, bak)
        v2 = migrate(d)
        for key in DROP:
            if d.get(key) not in (None, "", [], {}):
                removed_counter[key] = removed_counter.get(key, 0) + 1
        f.write_text(json.dumps(v2, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"已迁移 {len(need)} 题。备份目录：{BAK_DIR}")
    print("被移除且原本有内容的字段（题数）：")
    for key in DROP:
        n = removed_counter.get(key, 0)
        if n:
            print(f"  {key:16s} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
