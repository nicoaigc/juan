# -*- coding: utf-8 -*-
"""裁剪质量自检：检查每道题的裁剪边界是否切进了内容。

为什么需要它：识别规范要求「裁剪必须框全题面」。凭肉眼复核裁剪图很容易漏掉
"边角切掉半个字"或"边上残留板块标题/印刷序号"这类问题（q-20260930-050 的
序号残留就是这么漏掉的）。本工具用像素统计把这类问题自动化地暴露出来。

原理：对每道题的 bbox 取四条边各 1px（及 3px 带）的"墨迹"像素数。题面内容
若被边界切断，该边必然留下明显墨迹；正常留白边界则为 0 或接近 0。

同时按 `figure.bbox` 检查题内插图子图（显示为 `q-xxxxx#figN`）——图形切边同样常见。

用法（在项目根目录）：
    python engine/crop_check.py                  # 检查全部题目（已复核的不计入）
    python engine/crop_check.py q-20260930-050   # 只检查指定题（可多个）
    python engine/crop_check.py --all            # 打印全部明细（含通过项与已复核项）

原图从 data/benchmark/<source.file> 读取（入库时已复制到那里）。

关于误报：手写卷里学生的笔迹经常越出题区边界，边沿必然有墨迹；被有意剔除了
卷面印刷序号的题，左边界外也一定有墨迹（就是那个序号）。这类情况经人工放大
核对确认题面完整后，在 JSON 里置 `source.crop_reviewed = true` 并写明理由
（`source.review_note`），本工具即不再对其告警——避免告警疲劳。

退出码：0 = 无待复核的可疑裁剪；1 = 存在可疑裁剪。
"""
import sys
import json
from pathlib import Path

try:
    from PIL import Image, ImageFilter
    import numpy as np
except ImportError:  # pragma: no cover
    print("需要 Pillow 与 numpy：", file=sys.stderr)
    print(r"  C:\Users\1\.workbuddy\binaries\python\envs\default\Scripts\python.exe -m pip install pillow numpy",
          file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS = ROOT / "data" / "questions"
BENCHMARK = ROOT / "data" / "benchmark"

EDGE_TOL = 3        # 边沿墨迹像素数超过此值即判可疑
MIN_INK = 2         # 判定"某行/列有内容"所需的最少墨迹像素数


def ink_mask(path: Path):
    """自适应二值：比局部背景明显暗的像素视为墨迹。"""
    im = Image.open(path).convert("L")
    a = np.asarray(im).astype(np.float32)
    bg = np.asarray(im.filter(ImageFilter.GaussianBlur(14))).astype(np.float32)
    return (a < bg - 26).astype(np.int8), a


def edge_report(mask: np.ndarray, bbox) -> dict:
    """返回四条边的墨迹像素数 + 内容到各边的余量（px）。"""
    h, w = mask.shape
    x0, y0, x1, y1 = [int(v) for v in bbox]
    if not (0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h):
        return {"error": f"bbox 越界：{bbox}（原图 {w}x{h}）"}
    sub = mask[y0:y1, x0:x1]
    out = {}
    out["top"] = int(sub[0, :].sum())
    out["bottom"] = int(sub[-1, :].sum())
    out["left"] = int(sub[:, 0].sum())
    out["right"] = int(sub[:, -1].sum())
    rows = sub.sum(axis=1)
    cols = sub.sum(axis=0)
    ys = np.nonzero(rows >= MIN_INK)[0]
    xs = np.nonzero(cols >= MIN_INK)[0]
    if len(ys) == 0 or len(xs) == 0:
        out["margin"] = None          # 空裁剪
    else:
        out["margin"] = {
            "top": int(ys[0]), "bottom": int(sub.shape[0] - 1 - ys[-1]),
            "left": int(xs[0]), "right": int(sub.shape[1] - 1 - xs[-1]),
        }
    out["size"] = (int(x1 - x0), int(y1 - y0))
    return out


def quad_submask(mask: np.ndarray, quad, pad: int = 8) -> np.ndarray:
    """按 4 角点重建「摆平后」的裁剪掩膜 —— 与识别脚本的 crop_quad 用同一变换。

    有些题所在的文本行**又斜又挤**（第 8 份卷「六、判断」第 1、2 小题：行距仅 5px 而该处
    斜率 0.136），矩形窗口切不开，只能用平行四边形采样；这类题的 `source.quad` 记 4 个
    角点，本函数据此从原图重建出真正被裁下的那块，再照常查四边。
    """
    (qx0, qy0), (qx1, qy1r), (qx2, qy2), (qx3, qy3) = [(float(p[0]), float(p[1])) for p in quad]
    w = int(round(qx1 - qx0))
    s = ((qy1r - qy0) + (qy2 - qy3)) / 2.0 / w
    h = int(round(max(qy3 - qy0, qy2 - qy1r))) + 2 * pad
    u = np.arange(w, dtype=np.float32)[None, :]
    v = np.arange(h, dtype=np.float32)[:, None]
    xi = np.clip(np.round(u + qx0).astype(int), 0, mask.shape[1] - 1)
    yi = np.clip(np.round(s * u + v + qy0 - pad).astype(int), 0, mask.shape[0] - 1)
    return mask[yi, xi]


def check_bbox(label, mask, bbox, reviewed_flag, note, show_margin, bad, reviewed):
    """检查单个 bbox：可疑则记入 bad/reviewed，并按需打印明细行。

    label 形如 `q-20260930-055`（题区）或 `q-20260930-055#fig1`（题内插图子图）。
    """
    r = edge_report(mask, bbox)
    if "error" in r:
        print(f"{label:26s} {r['error']}")
        bad.append(label)
        return
    flags = [cn for side, cn in (("top", "上"), ("bottom", "下"), ("left", "左"), ("right", "右"))
             if r[side] > EDGE_TOL]
    m = r["margin"]
    mstr = "-" if m is None else "/".join(str(m[k]) for k in ("top", "bottom", "left", "right"))
    if m is None:
        flags.append("空裁剪")
    line = f'{label:26s} {r["top"]:4d} {r["bottom"]:4d} {r["left"]:4d} {r["right"]:4d}  {mstr}'
    if flags:
        if reviewed_flag:
            reviewed.append(label)
            if not show_margin:
                return
            line += "   已复核：" + str(note)
        else:
            line += "   <-- 可疑：" + "".join(flags) + "边有墨迹"
            bad.append(label)
    elif not show_margin:
        return
    print(line)


def main(argv):
    show_margin = "--all" in argv or "-a" in argv
    wanted = [a for a in argv if not a.startswith("-")]
    files = sorted(QUESTIONS.glob("*.json"))
    if wanted:
        files = [f for f in files if f.stem in wanted or f.name in wanted]
        if not files:
            print("未找到匹配的题目文件：", ", ".join(wanted))
            return 1

    masks = {}
    bad, reviewed = [], []
    print(f'{"题目":26s} {"上":>4s} {"下":>4s} {"左":>4s} {"右":>4s}  余量(上/下/左/右)')
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        src = d.get("source", {})
        name = src.get("file")
        if name not in masks:
            p = BENCHMARK / str(name)
            if not p.exists():
                print(f"{d['id']:26s} 原图缺失：{p}（跳过）")
                continue
            masks[name] = ink_mask(p)[0]
        mask = masks[name]
        reviewed_flag = bool(src.get("crop_reviewed"))
        note = src.get("review_note", "")

        # 1) 题区裁剪（有 quad 的题按平行四边形重建后再查）
        quad = src.get("quad")
        if quad:
            sub = quad_submask(mask, quad, int(src.get("quad_pad", 8)))
            check_bbox(d["id"], sub, [0, 0, sub.shape[1], sub.shape[0]],
                       reviewed_flag, note, show_margin, bad, reviewed)
        else:
            check_bbox(d["id"], mask, src.get("bbox", [0, 0, 0, 0]),
                       reviewed_flag, note, show_margin, bad, reviewed)

        # 2) 题内插图子图（figure.bbox 记的是原图坐标，与题区同一坐标系）
        n_fig = 0
        for seg in d.get("stem", []):
            if isinstance(seg, dict) and seg.get("t") == "figure":
                n_fig += 1
                fb = seg.get("bbox")
                if not fb:
                    continue
                check_bbox(f'{d["id"]}#fig{n_fig}', mask, fb,
                           reviewed_flag, note, show_margin, bad, reviewed)

    print()
    if reviewed and not show_margin:
        print(f"另有 {len(reviewed)} 处告警已人工复核确认（crop_reviewed=true）：{', '.join(reviewed)}")
    if bad:
        print(f"待复核的可疑裁剪 {len(bad)} 处：{', '.join(bad)}")
        print("处理建议：把边界向可疑边外扩，或把该题的搜索窗口重新划到只含本题内容，"
              "再重写 bbox 与裁剪图（见 prompts/recognition-spec.md 的裁剪章节）。")
        return 1
    n_all = sum(1 for f in files)
    print(f"全部 {n_all} 道题裁剪无需处理（告警项均已复核）。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
