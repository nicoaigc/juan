# -*- coding: utf-8 -*-
"""把 KaTeX 的静态资源落到 engine/vendor/katex/（供 render.py 内联，离线可用）。

为什么需要它：校对页是**单文件自包含**的，KaTeX 的 CSS / JS / 20 个 woff2 字体
必须在本地存在，render.py 才能把它们 base64 内联进 HTML。CDN 不能用——预览面板
的 CSP 是 `default-src 'self' ...`，外链会被 blocked。

用法:
    python tools/install_katex.py                # 默认 0.16.11
    python tools/install_katex.py --version 0.16.11 --force

仅依赖标准库（urllib + tarfile）。从 npm registry / jsdelivr 取 tarball，
只保留 woff2（丢掉 ttf/woff，省 900KB 且现代浏览器用不到）。
"""
import argparse
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = PROJECT_ROOT / "engine" / "vendor" / "katex"
DEFAULT_VERSION = "0.16.11"

MIRRORS = [
    "https://registry.npmjs.org/katex/-/katex-{v}.tgz",
    "https://registry.npmmirror.com/katex/-/katex-{v}.tgz",
]

KEEP_FILES = ["katex.min.css", "katex.min.js", "contrib/auto-render.min.js"]


def download(version: str, dest: Path) -> None:
    last_err = None
    for tpl in MIRRORS:
        url = tpl.format(v=version)
        try:
            print(f"下载 {url}")
            with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as f:
                shutil.copyfileobj(resp, f)
            if dest.stat().st_size > 100_000:
                return
            last_err = RuntimeError(f"{url} 返回内容过小（{dest.stat().st_size} 字节）")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            print(f"  失败：{exc}", file=sys.stderr)
    raise SystemExit(f"下载 KaTeX {version} 失败：{last_err}")


def install(version: str, force: bool) -> int:
    css = VENDOR_DIR / "katex.min.css"
    if css.is_file() and not force:
        print(f"已存在：{VENDOR_DIR}（要覆盖请加 --force）")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        tgz = Path(tmp) / "katex.tgz"
        download(version, tgz)
        with tarfile.open(tgz) as tar:
            members = {}
            for m in tar.getmembers():
                if not m.isfile():
                    continue
                # tarball 内路径形如 package/dist/...
                rest = m.name.split("dist/", 1)
                if len(rest) != 2:
                    continue
                members[rest[1]] = m
            wanted = list(KEEP_FILES) + [
                n for n in members if n.startswith("fonts/") and n.endswith(".woff2")
            ]
            if not all(w in members for w in KEEP_FILES):
                raise SystemExit(f"tarball 结构异常，缺少 {KEEP_FILES}")

            VENDOR_DIR.mkdir(parents=True, exist_ok=True)
            (VENDOR_DIR / "fonts").mkdir(parents=True, exist_ok=True)
            for name in wanted:
                target = VENDOR_DIR / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(members[name]) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)

    cache = VENDOR_DIR / "katex-inline.html"
    if cache.is_file():
        cache.unlink()  # 版本变了，缓存的内联包作废，下次渲染自动重建

    size = sum(p.stat().st_size for p in VENDOR_DIR.rglob("*") if p.is_file())
    n_font = len(list((VENDOR_DIR / "fonts").glob("*.woff2")))
    print(f"完成：KaTeX {version} -> {VENDOR_DIR}"
          f"（{n_font} 个 woff2，共 {size / 1024:.0f} KB）")
    (VENDOR_DIR / "VERSION.txt").write_text(
        f"katex {version}\n来源：https://registry.npmjs.org/katex/-/katex-{version}.tgz\n"
        f"仅保留 dist/{{katex.min.css,katex.min.js,contrib/auto-render.min.js,fonts/*.woff2}}\n",
        encoding="utf-8",
    )
    print("下一步：python engine/render.py data/questions")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="安装 KaTeX 本地资源（供 render.py 内联）")
    ap.add_argument("--version", default=DEFAULT_VERSION)
    ap.add_argument("--force", action="store_true", help="已存在也重新下载")
    args = ap.parse_args()
    return install(args.version, args.force)


if __name__ == "__main__":
    sys.exit(main())
