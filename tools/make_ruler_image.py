# -*- coding: utf-8 -*-
"""给试卷照片加"参考网格 + 边缘刻度"，让视觉模型能**读出**坐标而不是凭印象估。

为什么需要：实测 deepseek-v4.1-flash 对密集页面的 bbox 是"局部准、全局漂移"——
同一列相邻题的间距它给得很准，但累积偏移能到 230~390px，且 x/y 压缩比不同（0.868 / 0.778）。
这是视觉模型分块看图再拼接的典型症状，靠一个全局变换修不回来。

刻度是**语义**：不管上游把图缩放成多少，"数字"不会因 resize 而变。所以给图加上带数字的
刻度 + 淡网格后，模型只要"照着读"，坐标就能落回原图坐标系。

设计要点：
- **四周加白边**：刻度数字画在白边里，绝不压在试卷内容上。
- **图内画淡网格**：每 100px 一条浅灰线。模型需要图内有参考才能外推，纯靠边缘刻度不够。
  网格线要足够淡（扫过文字但几乎不改变墨迹对比度），且颜色偏蓝灰 —— 与黑字区分明显。
- **数字标的是原图坐标**：提示词里明确要求模型按刻度数字输出，因此模型给的坐标**就是**
  原图坐标，不需要减 PAD、不需要任何换算。这是刻意的设计，少一次换算就少一处错。

用法：
    python tools/make_ruler_image.py <原图> [-o 输出] [--pad 80] [--grid 100] [--label 500]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 浅蓝灰：与黑白印刷内容区分明显，但当网格线划过文字时几乎不影响可读性
GRID_COLOR = (216, 220, 232)
AXIS_COLOR = (108, 126, 176)
MAJOR_COLOR = (150, 164, 205)
LABEL_COLOR = (52, 78, 148)
BG = (255, 255, 255)


def find_font(size: int):
    for p in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf",
              "C:/Windows/Fonts/segoeui.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


def draw_ruler(src: Path, out: Path, pad: int, grid: int, label_every: int) -> tuple[int, int]:
    im = Image.open(src).convert("RGB")
    W, H = im.size

    canvas = Image.new("RGB", (W + pad * 2, H + pad * 2), BG)
    canvas.paste(im, (pad, pad))
    d = ImageDraw.Draw(canvas)

    font = find_font(max(16, pad // 3))
    sw = max(1, round(pad / 55))          # 网格线粗细

    def ix(x): return pad + x             # 原图 x -> 画布 x
    def iy(y): return pad + y

    # ---------------- 图内淡网格 ----------------
    x = grid
    while x < W:
        major = (x % label_every == 0)
        d.line([(ix(x), iy(0)), (ix(x), iy(H))], fill=(MAJOR_COLOR if major else GRID_COLOR), width=sw)
        x += grid
    y = grid
    while y < H:
        major = (y % label_every == 0)
        d.line([(ix(0), iy(y)), (ix(W), iy(y))], fill=(MAJOR_COLOR if major else GRID_COLOR), width=sw)
        y += grid

    # ---------------- 四周白边里的刻度 ----------------
    tick_minor = max(6, pad // 5)
    tick_major = max(12, int(pad * 0.32))

    # 顶部 + 底部（横轴）
    x = grid
    while x < W:
        major = (x % label_every == 0)
        t = tick_major if major else tick_minor
        d.line([(ix(x), pad), (ix(x), pad - t)], fill=AXIS_COLOR, width=sw)
        d.line([(ix(x), iy(H)), (ix(x), iy(H) + t)], fill=AXIS_COLOR, width=sw)
        if major:
            txt = str(x)
            # 数字画在刻度内侧靠中间的位置
            for cy, anchor in ((pad - t - font.size - 2, "top"), (iy(H) + t + 2, "top")):
                w = d.textlength(txt, font=font)
                d.text((ix(x) - w / 2, cy + (2 if anchor == "top" else 0)), txt, fill=LABEL_COLOR, font=font)
        x += grid

    # 左侧 + 右侧（纵轴）
    y = grid
    while y < H:
        major = (y % label_every == 0)
        t = tick_major if major else tick_minor
        d.line([(pad, iy(y)), (pad - t, iy(y))], fill=AXIS_COLOR, width=sw)
        d.line([(ix(W), iy(y)), (ix(W) + t, iy(y))], fill=AXIS_COLOR, width=sw)
        if major:
            txt = str(y)
            w = d.textlength(txt, font=font)
            d.text((pad - t - w - 3, iy(y) - font.size / 2), txt, fill=LABEL_COLOR, font=font)
            d.text((ix(W) + t + 3, iy(y) - font.size / 2), txt, fill=LABEL_COLOR, font=font)
        y += grid

    # 四周画一圈细框，把"内容区"与"标尺区"分开，提示模型这里是页面的边界
    d.rectangle([pad - 1, pad - 1, ix(W), iy(H)], outline=AXIS_COLOR, width=sw)

    out.parent.mkdir(parents=True, exist_ok=True)
    im_out = canvas
    if out.suffix.lower() in (".jpg", ".jpeg"):
        im_out.save(out, quality=90, subsampling=0)
    else:
        im_out.save(out)
    return W, H, canvas.size


def main() -> int:
    ap = argparse.ArgumentParser(description="给试卷图加参考网格与边缘刻度")
    ap.add_argument("image", help="原始试卷图片")
    ap.add_argument("-o", "--out", default=None, help="输出路径（默认加 _ruler 后缀）")
    ap.add_argument("--pad", type=int, default=80, help="四周白边宽度（刻度画在这里）")
    ap.add_argument("--grid", type=int, default=100, help="网格间距")
    ap.add_argument("--label", type=int, default=500, help="每多少像素标一个数字")
    args = ap.parse_args()

    src = Path(args.image)
    if not src.is_file():
        print("找不到图片：", src, file=sys.stderr)
        return 1
    out = Path(args.out) if args.out else src.with_name(src.stem + "_ruler" + src.suffix)

    W, H, size = draw_ruler(src, out, args.pad, args.grid, args.label)
    print(f"原图 {W}×{H}  ->  {out}  {size[0]}×{size[1]}  "
          f"（{out.stat().st_size / 1024:.0f} KB）")
    print(f"内容区左上角在画布 ({args.pad}, {args.pad})；刻度数字标的是**原图坐标**")
    return 0


if __name__ == "__main__":
    sys.exit(main())
