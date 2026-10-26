# -*- coding: utf-8 -*-
"""生成 data/benchmark/_sizes.json：每张原图的像素尺寸与字节数。

网页端「按 source.bbox 从原图实时抠图」要有原图的像素宽高才能算缩放，
所以尺寸必须随原图一起登记进云端的 paper_files。

需要 Pillow（隔离 venv）：
    C:\\Users\\1\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe tools/bench_sizes.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "data" / "benchmark"
OUT = BENCH / "_sizes.json"


def main() -> int:
    try:
        from PIL import Image
    except ImportError:
        print("需要 Pillow：用隔离 venv 的 python 运行本脚本（见文件头注释）", file=sys.stderr)
        return 2

    sizes = {}
    for f in sorted(BENCH.iterdir()):
        if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
            continue
        with Image.open(f) as im:
            w, h = im.size
        sizes[f.name] = {"w": w, "h": h, "bytes": f.stat().st_size}
        print(f"{f.name:44s} {w}x{h}  {f.stat().st_size / 1024:7.0f} KB")

    OUT.write_text(json.dumps(sizes, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    print(f"\n{len(sizes)} 张 -> {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
