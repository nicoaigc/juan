# -*- coding: utf-8 -*-
"""为「卷」列表页生成原图缩略图。

为什么单独一步：`engine/render.py` 只用标准库（不能依赖 Pillow），而列表页要放
每份卷的原图缩略图 —— 直接内联原图（每张 100KB–900KB）会把首页撑到几 MB。
所以这里预生成 `data/thumbs/<原图同名>.jpg`（宽度 520，质量 72），render.py 优先
内联缩略图；缩略图缺失时回退到原图（页面会大一些，但不会裂图）。

用法（图像处理隔离 venv）:
    C:\\Users\\1\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe tools/make_thumbs.py
    ... tools/make_thumbs.py --width 640 --force
"""
import argparse
import sys
from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = PROJECT_ROOT / "data" / "benchmark"
OUT_DIR = PROJECT_ROOT / "data" / "thumbs"
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def main() -> int:
    ap = argparse.ArgumentParser(description="生成原图缩略图（卷列表页用）")
    ap.add_argument("--src", default=str(SRC_DIR))
    ap.add_argument("-o", "--out", default=str(OUT_DIR))
    ap.add_argument("--width", type=int, default=520, help="缩略图宽度（等比缩放，默认 520）")
    ap.add_argument("--quality", type=int, default=72)
    ap.add_argument("--force", action="store_true", help="源更新时也重建")
    args = ap.parse_args()

    src_dir, out_dir = Path(args.src), Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        print(f"没有原图：{src_dir}", file=sys.stderr)
        return 1

    made = skipped = 0
    for p in files:
        dst = out_dir / (p.stem + ".jpg")
        if dst.is_file() and not args.force and dst.stat().st_mtime >= p.stat().st_mtime:
            skipped += 1
            continue
        with Image.open(p) as im:
            im = im.convert("RGB")
            w, h = im.size
            if w > args.width:
                im = im.resize((args.width, max(1, round(h * args.width / w))), Image.LANCZOS)
            im.save(dst, "JPEG", quality=args.quality, optimize=True, progressive=True)
        print(f"  {p.name}  {w}px -> {im.width}px  {dst.stat().st_size // 1024} KB")
        made += 1

    print(f"完成：新建/更新 {made} 张，跳过 {skipped} 张 -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
