# -*- coding: utf-8 -*-
"""把本地识别结果（data/questions/*.json）转成**导入云端题库**的 SQL。

为什么是「生成 SQL」而不是「直接上云」：本机脚本拿不到云数据面的管理凭据，
写库只能走 WorkBuddy 内的管理员通道（云数据库 MCP 工具）。所以这里只负责把
本地题库编译成一条条可直接执行的 SQL，执行由对话侧的通道完成。

一份卷 = 一条 SQL（CTE 串起 papers + paper_files + questions 三张表，原子写入），
所以「7 份卷 = 7 条语句」，不用在语句之间来回记 id。

用法：
    python tools/cloud_sync.py --owner <目标用户 uid> [--out-dir data/cloud_push]
                              [--copy-assets] [--only 素养卷]
  然后逐条把生成的 .sql 交给云数据库管理通道执行（mode=migrate 或 write）。

⚠️ owner_id 是**显式指定**的：这是管理员代为导入（seed）的场景，不是应用运行时代码。
   应用自己的代码永远不传 owner_id，由 `DEFAULT auth.uid()` + RLS 决定归属。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS = ROOT / "data" / "questions"
BENCH = ROOT / "data" / "benchmark"
SIZES = BENCH / "_sizes.json"
APP_ASSETS = ROOT / "app" / "assets" / "benchmark"

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")

# 云端不认的相对路径前缀：随应用一起打包的演示原图
LOCAL_PREFIX = "local:"


def dq(text: str, tag: str = "q") -> str:
    """PostgreSQL dollar-quoting。中文标点、引号、反斜杠都不用转义。"""
    body = str(text)
    while f"${tag}$" in body:
        tag += "q"
    return f"${tag}${body}${tag}$"


def sql_str(v) -> str:
    return "NULL::text" if v is None else dq(v)


def sql_int(v) -> str:
    return "NULL::int" if v is None else str(int(v))


def sql_jsonb(obj) -> str:
    return dq(json.dumps(obj, ensure_ascii=False, sort_keys=False)) + "::jsonb"


def paper_key(src: dict) -> str:
    return str(src.get("paper") or src.get("file") or "（未标注来源）")


def paper_title(key: str, items: list[dict]) -> str:
    for q in items:
        t = str((q.get("source") or {}).get("paper_title") or "").strip()
        if t:
            return t
    stem = Path(key).stem
    stem = _DATE_RE.sub("", stem).lstrip("-_ ") or stem
    return stem


def paper_date(key: str) -> str | None:
    m = _DATE_RE.match(Path(key).stem)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def load_sizes() -> dict:
    if not SIZES.is_file():
        return {}
    return json.loads(SIZES.read_text(encoding="utf-8"))


def normalize_source(src: dict) -> dict:
    """收进云端前清掉只对本地管线有意义的字段。

    `crop` 指向 data/crops 下的本地裁剪文件名，云端不存裁剪图（网页按 bbox 实时裁），
    留着只会让人以为云端有这个文件。`paper_title` / `paper_page` 已经落到表字段，不重复存。
    """
    drop = {"crop", "paper_title", "paper_page"}
    return {k: v for k, v in src.items() if k not in drop}


def build_statements(owner: str, only: list[str] | None, sizes: dict,
                     copy_assets: bool) -> list[dict]:
    by_paper: dict[str, list[dict]] = {}
    for f in sorted(QUESTIONS.glob("*.json")):
        q = json.loads(f.read_text(encoding="utf-8"))
        if q.get("schema_version") != 2:
            continue
        key = paper_key(q.get("source") or {})
        by_paper.setdefault(key, []).append(q)

    out = []
    demo_papers = []
    for idx, (key, items) in enumerate(sorted(by_paper.items()), 1):
        if only and not any(o in key for o in only):
            continue
        items.sort(key=lambda q: (q.get("no") if isinstance(q.get("no"), int) else 9999, q.get("id", "")))

        # ---- 原图（照片）清单：按页序 ----
        files: dict[str, dict] = {}
        for q in items:
            src = q.get("source") or {}
            fn = src.get("file")
            if not fn:
                continue
            rec = files.setdefault(fn, {"filename": fn, "page_no": src.get("paper_page") or 1})
            if src.get("paper_page"):
                rec["page_no"] = min(rec["page_no"], src["paper_page"])
        file_rows = sorted(files.values(), key=lambda r: (r["page_no"], r["filename"]))

        # 演示原图随应用打包，落地名一律 ASCII（静态服务器对中文路径容易出编码问题）
        if copy_assets:
            APP_ASSETS.mkdir(parents=True, exist_ok=True)
        for i, r in enumerate(file_rows, 1):
            r["page_no"] = i  # 归一成 1..N，避免多张照片的 paper_page 重复
            ext = Path(r["filename"]).suffix.lower() or ".jpg"
            r["asset"] = f"demo-{idx:02d}-{i}{ext}"
            if copy_assets:
                src_p, dst_p = BENCH / r["filename"], APP_ASSETS / r["asset"]
                if src_p.is_file():
                    dst_p.write_bytes(src_p.read_bytes())

        title = paper_title(key, items)
        date = paper_date(key)
        slug = re.sub(r"[^0-9A-Za-z]+", "-", f"{date or 'x'}-{title}").strip("-")[:40] or "paper"

        # ---- papers 行 ----
        paper_cols = ("owner_id, title, paper_date, subject, grade, status, status_note, "
                      "page_count, question_count")
        paper_vals = (f"{sql_str(owner)}, {sql_str(title)}, {sql_str(date)}, {sql_str('数学')}, "
                      f"NULL::text, {sql_str('done')}, {sql_str('由本地题库导入')}, "
                      f"{len(file_rows)}, {len(items)}")

        # ---- paper_files 行 ----
        # filename 保持原图原名（网页端靠 source.file 与它匹配定位原图）；
        # storage_path 指向随应用打包的 ASCII 演示图，两者不必同名。
        fvals = []
        for r in file_rows:
            sz = sizes.get(r["filename"], {})
            path = LOCAL_PREFIX + "assets/benchmark/" + r["asset"]
            fvals.append("(" + ", ".join([
                str(r["page_no"]), sql_str(r["filename"]), sql_str(path),
                sql_int(sz.get("w")), sql_int(sz.get("h")), sql_int(sz.get("bytes")),
            ]) + ")")

        # ---- questions 行 ----
        qvals = []
        for i, q in enumerate(items, 1):
            src = q.get("source") or {}
            qvals.append("(" + ", ".join([
                str(i),
                sql_int(q.get("no")),
                sql_str(src.get("printed_no")),
                sql_str(q.get("section")),
                sql_str(q.get("type") or "other"),
                sql_jsonb(q.get("stem") or []),
                sql_jsonb(q.get("options") or []),
                sql_jsonb(normalize_source(src)),
                sql_jsonb(q.get("confidence") or {}),
            ]) + ")")

        sql = (
            "WITH np AS (\n"
            f"  INSERT INTO papers ({paper_cols})\n"
            f"  VALUES ({paper_vals})\n"
            "  RETURNING id\n"
            "), nf AS (\n"
            "  INSERT INTO paper_files (owner_id, paper_id, page_no, filename, storage_path, width, height, size_bytes)\n"
            "  SELECT " + sql_str(owner) + ", np.id, v.page_no, v.filename, v.storage_path, v.width, v.height, v.size_bytes\n"
            "  FROM np, (VALUES\n    " + ",\n    ".join(fvals) + "\n  ) AS v(page_no, filename, storage_path, width, height, size_bytes)\n"
            ")\n"
            "INSERT INTO questions (owner_id, paper_id, seq, qno, printed_no, section, qtype, stem, options, source, confidence)\n"
            "SELECT " + sql_str(owner) + ", np.id, v.seq, v.qno, v.printed_no, v.section, v.qtype, "
            "v.stem::jsonb, v.options::jsonb, v.source::jsonb, v.confidence::jsonb\n"
            "FROM np, (VALUES\n  " + ",\n  ".join(qvals) + "\n) AS v(seq, qno, printed_no, section, qtype, stem, options, source, confidence)"
        )
        out.append({"key": key, "slug": slug, "title": title, "date": date,
                    "files": len(file_rows), "questions": len(items), "sql": sql})

        # 同内容再来一份 JSON：给网页应用里的「载入示例卷」按钮用（应用自己的会话写入，
        # owner_id 由 DEFAULT auth.uid() 决定，所以这里**不带** owner）
        demo_papers.append({
            "title": title, "paper_date": date, "subject": "数学", "grade": None,
            "status": "done", "status_note": "示例卷（内置）",
            "files": [{"page_no": r["page_no"], "filename": r["filename"],
                       "storage_path": LOCAL_PREFIX + "assets/benchmark/" + r["asset"],
                       "width": sizes.get(r["filename"], {}).get("w"),
                       "height": sizes.get(r["filename"], {}).get("h"),
                       "size_bytes": sizes.get(r["filename"], {}).get("bytes")} for r in file_rows],
            "questions": [{
                "seq": i, "qno": q.get("no"), "printed_no": (q.get("source") or {}).get("printed_no"),
                "section": q.get("section"), "qtype": q.get("type") or "other",
                "stem": q.get("stem") or [], "options": q.get("options") or [],
                "source": normalize_source(q.get("source") or {}),
                "confidence": q.get("confidence") or {},
            } for i, q in enumerate(items, 1)],
        })
    return out, demo_papers


def main() -> int:
    ap = argparse.ArgumentParser(description="本地识别结果 -> 云端题库导入 SQL")
    ap.add_argument("--owner", required=True, help="目标用户 uid（owner_id，管理员代为导入）")
    ap.add_argument("--out-dir", default=str(ROOT / "data" / "cloud_push"))
    ap.add_argument("--only", nargs="*", help="只导卷名包含这些子串的卷")
    ap.add_argument("--copy-assets", action="store_true",
                    help="把演示原图复制到 app/assets/benchmark（云端题图按 local: 前缀直出）")
    args = ap.parse_args()

    sizes = load_sizes()
    if not sizes:
        print("[警告] 没有 data/benchmark/_sizes.json，原图像素尺寸会缺 → 网页端裁图会退化。"
              "先跑 tools/bench_sizes.py。", file=sys.stderr)

    stmts, demo = build_statements(args.owner, args.only, sizes, args.copy_assets)
    if not stmts:
        print("没有匹配到任何卷。", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.sql"):
        old.unlink()

    total_q = total_f = 0
    for i, s in enumerate(stmts, 1):
        p = out_dir / f"{i:02d}-{s['slug']}.sql"
        p.write_text(s["sql"] + "\n", encoding="utf-8")
        total_q += s["questions"]
        total_f += s["files"]
        print(f"{i:02d}. {s['title']}  {s['date'] or '日期未知'}  "
              f"{s['files']} 张原图 / {s['questions']} 题  -> {p.name}")

    manifest = {"owner": args.owner, "papers": len(stmts), "questions": total_q, "files": total_f,
                "statements": [{"file": f"{i:02d}-{s['slug']}.sql", "title": s["title"],
                                "questions": s["questions"]} for i, s in enumerate(stmts, 1)]}
    (out_dir / "_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 示例题库 JSON：应用里「载入示例卷」用（不带 owner，写入时由登录态决定归属）
    demo_path = out_dir / "demo-library.json"
    demo_path.write_text(json.dumps({"papers": demo}, ensure_ascii=False, indent=1), encoding="utf-8")
    demo_kb = demo_path.stat().st_size / 1024
    if args.copy_assets:
        (APP_ASSETS.parent).mkdir(parents=True, exist_ok=True)
        (APP_ASSETS.parent / "demo-library.json").write_text(demo_path.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"示例题库 -> app/assets/demo-library.json（{demo_kb:.0f} KB）")

    print(f"\n合计 {len(stmts)} 份卷 / {total_f} 张原图 / {total_q} 题 → {out_dir}")
    print("下一步：把每个 .sql 交给云数据库管理通道执行（一条语句一次调用）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
