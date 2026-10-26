# -*- coding: utf-8 -*-
"""题目库 SQLite 存取：初始化、导入题目 JSON、列表。

用法:
    python db.py init
    python db.py import <questions.json 或目录>
    python db.py list [N]
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "cuotiji.db"

CN_TZ = timezone(timedelta(hours=8))


def now_iso() -> str:
    return datetime.now(CN_TZ).isoformat(timespec="seconds")


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS questions (
                id          TEXT PRIMARY KEY,
                no          INTEGER,
                type        TEXT,
                stem_text   TEXT,
                payload     TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
            """
        )
    print(f"已初始化: {DB_PATH}")


def load_question(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("schema_version") != 2:
        raise ValueError("schema_version 必须为 2")
    for key in ("id", "stem"):
        if key not in data:
            raise ValueError(f"缺少字段 {key}")
    return data


def stem_text(data: dict) -> str:
    return " ".join(str(seg.get("v", "")) for seg in data.get("stem", []) if seg.get("t") == "text")[:200]


def prune_questions(target: str) -> int:
    """删掉「JSON 已经不在了」的库内条目。

    `import` 是 upsert：只增改不删。所以修数据（合并/删除题目）后，库里会残留孤儿行，
    必须显式 prune 一次（本次就是「写出综合算式」4 题并成 2 题时踩到的）。
    """
    path = Path(target)
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    keep = set()
    for f in files:
        try:
            keep.add(json.loads(f.read_text(encoding="utf-8"))["id"])
        except Exception:  # noqa: BLE001
            continue
    with get_conn() as conn:
        rows = [r[0] for r in conn.execute("SELECT id FROM questions").fetchall()]
        gone = [qid for qid in rows if qid not in keep]
        for qid in gone:
            conn.execute("DELETE FROM questions WHERE id = ?", (qid,))
    for qid in gone:
        print(f"[清理] {qid}：JSON 已不存在，从库中删除")
    print(f"清理 {len(gone)} 条孤儿记录（库内保留 {len(keep)} 条）")
    return len(gone)


def import_questions(target: str) -> None:
    path = Path(target)
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    if not files:
        print("没有可导入的 JSON", file=sys.stderr)
        return
    imported, updated, errors = 0, 0, 0
    with get_conn() as conn:
        for f in files:
            try:
                data = load_question(f)
            except Exception as exc:  # noqa: BLE001
                print(f"[跳过] {f.name}: {exc}", file=sys.stderr)
                errors += 1
                continue
            ts = now_iso()
            data.setdefault("created_at", ts)
            data["updated_at"] = ts
            cur = conn.execute(
                "SELECT 1 FROM questions WHERE id = ?", (data["id"],)
            )
            exists = cur.fetchone() is not None
            conn.execute(
                """
                INSERT INTO questions (id, no, type, stem_text, payload, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    no = excluded.no,
                    type = excluded.type,
                    stem_text = excluded.stem_text,
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (
                    data["id"],
                    data.get("no"),
                    data.get("type", "other"),
                    stem_text(data),
                    json.dumps(data, ensure_ascii=False),
                    data["created_at"],
                    data["updated_at"],
                ),
            )
            # 同步 updated_at 回 JSON 文件
            f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            imported += 1
            updated += 1 if exists else 0
    print(f"导入 {imported} 题（其中更新已有 {updated}，跳过 {errors}）-> {DB_PATH}")


def list_questions(limit: int = 20) -> None:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, no, type, stem_text, updated_at FROM questions ORDER BY id LIMIT ?",
            (limit,),
        ).fetchall()
    if not rows:
        print("（空）")
        return
    for r in rows:
        print(f"{r[0]}  第{r[1]}题  {r[2]}  {r[3][:40]}  更新于 {r[4]}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    if cmd == "init":
        init_db()
    elif cmd == "import":
        if len(sys.argv) < 3:
            print("用法: python db.py import <json 或目录>", file=sys.stderr)
            return 1
        init_db()
        import_questions(sys.argv[2])
        if "--prune" in sys.argv:
            prune_questions(sys.argv[2])
    elif cmd == "list":
        list_questions(int(sys.argv[2]) if len(sys.argv) > 2 else 20)
    else:
        print(f"未知命令: {cmd}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
