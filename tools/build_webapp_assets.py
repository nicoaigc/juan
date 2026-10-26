# -*- coding: utf-8 -*-
"""把校对页用的 KaTeX 资源搬成网页应用可直接引用的静态文件。

为什么要搬而不是引 CDN：应用要能在**离线/内网**和带 CSP 的预览面板里打开，
外链 CDN 会被 `default-src 'self'` 拦掉。做法与 engine/render.py 一致——
CSS 里的 20 个 woff2 全部转成 data: URI（丢弃 woff/ttf 备选源），so 零外部请求。

生成：
    app/css/katex.css            字体已内联
    app/js/vendor/katex.min.js
    app/js/vendor/auto-render.min.js
用法：
    python tools/build_webapp_assets.py
"""
from __future__ import annotations

import base64
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "engine" / "vendor" / "katex"
APP = ROOT / "app"

# 与 engine/render.py 同一套正则：现代浏览器只吃 woff2，备选的 woff/ttf 直接删掉省 200KB
_DROP_FALLBACK = re.compile(
    r',\s*url\(fonts/[A-Za-z0-9_\-]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)'
)
_WOFF2_URL = re.compile(r'url\(fonts/([A-Za-z0-9_\-]+\.woff2)\)')


def woff2_data_uri(name: str) -> str:
    path = VENDOR / "fonts" / name
    if not path.is_file():
        raise FileNotFoundError(f"缺少 KaTeX 字体：{path}")
    return "data:font/woff2;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def main() -> int:
    css_path = VENDOR / "katex.min.css"
    for p in (css_path, VENDOR / "katex.min.js", VENDOR / "auto-render.min.js"):
        if not p.is_file():
            raise SystemExit(f"缺少 KaTeX 资源：{p}（见 README · KaTeX 资源）")

    css = css_path.read_text(encoding="utf-8")
    css = _DROP_FALLBACK.sub("", css)
    css, n_font = _WOFF2_URL.subn(lambda m: "url(" + woff2_data_uri(m.group(1)) + ")", css)
    if n_font == 0:
        raise SystemExit("CSS 里没有匹配到 woff2 引用，KaTeX 版本或结构变了？")
    # 字体已内联，CSS 不再需要相对路径；加一条注释说明来源，方便下次重装
    header = f"/* KaTeX（VERSION.txt: {(VENDOR / 'VERSION.txt').read_text(encoding='utf-8').strip() if (VENDOR / 'VERSION.txt').is_file() else '?'}）\n" \
             f"   由 tools/build_webapp_assets.py 生成：{n_font} 个 woff2 字体已内联为 data: URI。不要手改。 */\n"

    (APP / "css").mkdir(parents=True, exist_ok=True)
    (APP / "js" / "vendor").mkdir(parents=True, exist_ok=True)
    (APP / "css" / "katex.css").write_text(header + css, encoding="utf-8")
    shutil.copyfile(VENDOR / "katex.min.js", APP / "js" / "vendor" / "katex.min.js")
    shutil.copyfile(VENDOR / "auto-render.min.js", APP / "js" / "vendor" / "auto-render.min.js")

    for f in ("css/katex.css", "js/vendor/katex.min.js", "js/vendor/auto-render.min.js"):
        print(f"{f:34s} {(APP / f).stat().st_size / 1024:8.1f} KB")
    print(f"内联字体 {n_font} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
