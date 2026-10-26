# -*- coding: utf-8 -*-
"""把组好的试卷导成 PDF，并给出版面体检报告（页数 / 每页填充度 / 每页首行）。

为什么需要它：A4 的真实分页只有浏览器排版时才知道 —— 屏幕上看到的是连续的一长条，
`.sheet` 只是近似预览。所以「是不是正好四面」「有没有半页空白」必须靠打印成 PDF 来量。

它还有第二个职责：**给「试卷列表」页补充只有打印才知道的信息**——
每份卷的页数、PDF 文件名与体积、首页缩略图。这些写进 `data/paper/manifest.json`，
`engine/render.py` 渲染 `papers.html` 时读它（页面里的元信息由 paper.py 嵌在 <head>，
见 `paper.paper_meta`）。

产物落位（**都要能被浏览器点开，所以必须放 data/render/ 同级**）：
    data/render/paper-all.pdf              合卷 PDF
    data/render/paper-<卷slug>.pdf         按卷还原的 PDF（与同名 .html 挨着）
    data/render/thumb-<stem>.png           首页缩略图（试卷列表用）
    data/paper/manifest.json               页数 / 体积 / 缩略图清单
    data/paper/preview*/pageN.png          每页 PNG（版面体检用，不进 UI）

用法:
    python tools/export_paper_pdf.py                 # 只导合卷（data/render/paper-all.html）
    python tools/export_paper_pdf.py --docs          # 导 data/render/paper-*.html 全部
    python tools/export_paper_pdf.py --html <路径> --pdf <路径> --png <目录>

依赖：Chrome（打印）、PyMuPDF（量页数、出缩略图，装在隔离 venv 里）
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RENDER_DIR = PROJECT_ROOT / "data" / "render"
MANIFEST = PROJECT_ROOT / "data" / "paper" / "manifest.json"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
PT_MM = 25.4 / 72  # 1pt = 0.3528mm
THUMB_DPI = 34     # 首页缩略图（A4 -> 约 280×400px，够卡片用又不占体积）


def print_pdf(html: Path, pdf: Path, timeout_ms: int = 15000) -> None:
    subprocess.run(
        [str(CHROME), "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
         f"--virtual-time-budget={timeout_ms}",
         f"--print-to-pdf={pdf}", html.as_uri()],
        check=True, capture_output=True,
    )


def visible_bottom(page, dpi: int = 72) -> float:
    """页面「肉眼可见内容的底边」(pt)。按渲染像素找最后一个非白行。

    不能用 get_text("blocks")：竖式与答题区是空白块 + 一条虚线，会被误报成「空白过多」。
    也不能用 get_drawings()：Chrome 会把 body 背景（白底）也画成一个整页矩形，同样偏。
    """
    import numpy as np
    import pymupdf

    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    rows = np.where((arr < 245).any(axis=1))[0]
    return (rows.max() + 1) * 72 / dpi if len(rows) else 0.0


def report(pdf: Path, png_dir: Path | None, expect: int = 0) -> dict:
    """体检 + 出缩略图。返回给 manifest 用的条目。"""
    import pymupdf

    doc = pymupdf.open(pdf)
    H = doc[0].rect.height
    print(f"\n共 {doc.page_count} 页（{doc[0].rect.width:.0f}×{H:.0f}pt = A4）")
    worst = None
    for page in doc:
        bottom = visible_bottom(page)
        gap = H - bottom
        lines = [l for l in page.get_text().strip().split("\n") if l.strip()]
        first = lines[0][:34] if lines else "(空)"
        flag = "  ← 空白过多" if gap > 130 else ""
        print(f"  p{page.number + 1}: 底部留白 {gap:5.0f}pt ({gap * PT_MM:4.0f}mm){flag} | 首行: {first}")
        if worst is None or gap > worst[1]:
            worst = (page.number + 1, gap)
        if png_dir:
            png_dir.mkdir(parents=True, exist_ok=True)
            page.get_pixmap(dpi=100).save(png_dir / f"page{page.number + 1}.png")
    if png_dir:
        print(f"每页 PNG 已存到 {png_dir}")

    thumb = RENDER_DIR / f"thumb-{pdf.stem}.png"
    doc[0].get_pixmap(dpi=THUMB_DPI).save(thumb)

    if expect and doc.page_count != expect:
        print(f"\n⚠ 当前 {doc.page_count} 页，不是预期的 {expect} 页 —— 调 engine/paper.py 里的")
        print("  PAPER（gap_row / gap_col / line_gap / sec_margin）或 SECTIONS 的 box_h / row_gap / new_page。")
    elif worst and worst[1] > 130:
        print(f"\n提示：第 {worst[0]} 页留白 {worst[1] * PT_MM:.0f}mm 偏多，可加大题距或书写区。")

    return {"pages": doc.page_count, "pdf": pdf.name, "thumb": thumb.name,
            "kb": round(pdf.stat().st_size / 1024)}


def write_manifest(entries: dict) -> None:
    """把每份卷的页数/PDF/缩略图写进清单，合并进已有内容（不覆盖别的卷）。

    同时**剔除已经没有对应卷面页面（paper-<stem>.html）的旧条目**——卷合并/改名后，
    旧 slug 的清单条目会变成幽灵项（papers.html 是按文件扫的，看不到它，但会误导计数）。
    """
    old = {}
    if MANIFEST.is_file():
        try:
            old = json.loads(MANIFEST.read_text(encoding="utf-8")).get("papers", {})
        except Exception:  # noqa: BLE001
            old = {}
    old.update(entries)
    stale = [k for k in old if not (RENDER_DIR / f"{k}.html").is_file()]
    for k in stale:
        del old[k]
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(
        {"generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
         "note": "engine/render.py 渲染 papers.html 时读它补页数/PDF/缩略图；"
                 "卷面的 kind/slug/title/题数 由页面 <head> 里的 x-paper 元信息给。",
         "papers": old},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n清单已更新 -> {MANIFEST.relative_to(PROJECT_ROOT)}（{len(old)} 份"
          + (f"，剔除 {len(stale)} 个失效条目" if stale else "") + "）")


def export(html: Path, pdf: Path, png_dir: Path | None, expect: int) -> dict:
    pdf.parent.mkdir(parents=True, exist_ok=True)
    print_pdf(html, pdf)
    print(f"PDF -> {pdf.relative_to(PROJECT_ROOT)}（{pdf.stat().st_size / 1024:.0f} KB）")
    return report(pdf, png_dir, expect)


def main() -> int:
    ap = argparse.ArgumentParser(description="试卷导出 PDF + 版面体检 + 试卷列表清单")
    ap.add_argument("--html", default=None,
                    help=f"单个页面（默认 {RENDER_DIR / 'paper-all.html'}；给了 --docs 则忽略）")
    ap.add_argument("--pdf", default=None, help="输出 PDF（单文件模式）")
    ap.add_argument("--png", default=None, help="每页 PNG 目录；传空串则不导出")
    ap.add_argument("--docs", action="store_true",
                    help="批量导出 data/render/paper-*.html（含按卷还原的与合卷）")
    ap.add_argument("--expect-pages", type=int, default=0,
                    help="期望页数，不符则告警（0 = 不检查；合卷想凑四面就传 4）")
    args = ap.parse_args()

    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    entries: dict[str, dict] = {}

    if args.docs:
        pages = sorted(RENDER_DIR.glob("paper-*.html"))
        if not pages:
            print(f"没有 {RENDER_DIR}/paper-*.html，先跑 engine/paper.py --by-doc", file=sys.stderr)
            return 1
        for html in pages:
            print(f"\n===== {html.name}")
            entries[html.stem] = export(
                html, RENDER_DIR / f"{html.stem}.pdf",
                PROJECT_ROOT / "data" / "paper" / "preview-docs" / html.stem,
                args.expect_pages)
        write_manifest(entries)
        print(f"\n批量完成：{len(pages)} 份（PDF 与同名 HTML 同级，都在 data/render/）")
        return 0

    html = Path(args.html or RENDER_DIR / "paper-all.html")
    pdf = Path(args.pdf or RENDER_DIR / "paper-all.pdf")
    png = args.png if args.png is not None else str(PROJECT_ROOT / "data" / "paper" / "preview")
    if not html.is_file():
        print(f"找不到 {html}，先跑 engine/paper.py", file=sys.stderr)
        return 1
    entries[html.stem] = export(html, pdf, Path(png) if png else None, args.expect_pages)
    write_manifest(entries)
    return 0


if __name__ == "__main__":
    sys.exit(main())
