"""量 Chrome 打印出来的 PDF：**逐页**内容 bbox → 反推四边实际边距（mm）。
用途：验证「屏幕上的页边距 = 纸上的页边距」，不受打印对话框「边距」设置影响。

实现：Chrome 的 PDF 每页一个 FlateDecode 内容流；按 PDF 规范跟踪 CTM / 文本矩阵，
把文字基线与路径点换算到设备坐标（pt，原点在左下）。两处必须跳过，否则量出来是 0：
  ① 页面级裁切框 `0 0 W H re W* n`（不是内容）；
  ② 卷面的**白色底** `1 1 1 rg ... re f`（现在卷面自带内边距，白底等于整张纸）。
不用第三方库：zlib + 自己算矩阵。

用法：python tools/pdf_margin.py out.pdf [more.pdf ...]
"""
import re
import sys
import zlib

PT2MM = 25.4 / 72.0
A4 = (595.276, 841.89)  # pt


def mul(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
            c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def streams(buf):
    for m in re.finditer(rb"stream\r?\n", buf):
        start = m.end()
        end = buf.find(b"endstream", start)
        if end < 0:
            continue
        try:
            yield zlib.decompress(buf[start:end])
        except Exception:
            pass


NUM = r"[-+]?[0-9]*\.?[0-9]+"
TOK = re.compile(r"(%s)|(\[)|(\])|(/[^\s/\[\]<>()]+)|([A-Za-z'\"*]+)" % NUM)


def page_boxes(path):
    """-> [{'n':i,'left','right','top','bottom'}]（mm）"""
    buf = open(path, "rb").read()
    out = []
    for s in streams(buf):
        t = s.decode("latin-1", "replace")
        # 只认页面内容流：内嵌 TTF / CMap 也会被解出来，里面的字节会被当成算子
        if " cm" not in t or " Tm" not in t:
            continue
        ctm = (1, 0, 0, 1, 0, 0)
        stack, ops = [], []
        tm = tlm = (1, 0, 0, 1, 0, 0)
        fsize, whiterg = 10.0, False
        pts = []
        for m in TOK.finditer(t):
            num, ob, cb, name, op = m.groups()
            if num is not None:
                ops.append(float(num))
                continue
            if ob or cb or name:
                ops.append(None)
                continue
            if op is None:
                continue

            def n(i, default=0.0):
                return ops[i] if i < len(ops) and isinstance(ops[i], float) else default

            if op == "q":
                stack.append(ctm)
            elif op == "Q":
                if stack:
                    ctm = stack.pop()
            elif op == "cm" and len(ops) >= 6:
                ctm = mul(tuple(n(i) for i in range(6)), ctm)
            elif op == "BT":
                tm = tlm = (1, 0, 0, 1, 0, 0)
            elif op == "Tm" and len(ops) >= 6:
                tm = tlm = tuple(n(i) for i in range(6))
            elif op in ("Td", "TD") and len(ops) >= 2:
                tlm = mul((1, 0, 0, 1, n(0), n(1)), tlm)
                tm = tlm
            elif op == "Tf" and len(ops) >= 2:
                fsize = n(1, 10.0)
            elif op in ("Tj", "TJ", "'", '"', "T*"):
                pts.append(apply(mul(tm, ctm), 0, 0) + (fsize,))
            elif op == "rg" and len(ops) >= 3:
                whiterg = all(n(i) >= 0.99 for i in range(3))
            elif op == "g" and len(ops) >= 1:
                whiterg = n(0) >= 0.99
            elif op == "re" and len(ops) >= 4:
                x, y, w, h = (n(i) for i in range(4))
                if w > 400 and h > 500:       # 页面裁切框
                    ops = []
                    continue
                if whiterg:                   # 白色底，不是内容
                    ops = []
                    continue
                for cx, cy in ((x, y), (x + w, y), (x, y + h), (x + w, y + h)):
                    pts.append(apply(ctm, cx, cy) + (0.0,))
            elif op in ("m", "l") and len(ops) >= 2:
                pts.append(apply(ctm, n(0), n(1)) + (0.0,))
            ops = []
        if not pts:
            continue
        W, H = A4
        xs = [p[0] for p in pts]
        tops = [p[1] + p[2] * 0.76 for p in pts]
        bots = [p[1] - p[2] * 0.24 for p in pts]
        out.append({"left": min(xs) * PT2MM, "right": (W - max(xs)) * PT2MM,
                    "top": (H - max(tops)) * PT2MM, "bottom": min(bots) * PT2MM})
    return out


def main():
    for path in sys.argv[1:]:
        boxes = page_boxes(path)
        print("== %s（%d 页）" % (path, len(boxes)))
        for i, b in enumerate(boxes):
            print("   p%d  左 %5.1f  右 %5.1f  上 %5.1f  下(内容底) %5.1f  mm"
                  % (i + 1, b["left"], b["right"], b["top"], b["bottom"]))


if __name__ == "__main__":
    main()
