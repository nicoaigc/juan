# -*- coding: utf-8 -*-
"""本地静态服务器：发出与 WorkBuddy 预览面板**完全相同**的 CSP 头。

用途：校对页是单文件自包含的，但「资源类改动」（外链、图片路径、字体）用 `file://`
截图**测不出问题**——本地没有 CSP、路径就是磁盘路径，全都通。要复刻预览面板环境
（CSP 拦外链 + 页面挂在嵌套路径下导致 ../ 越界 404），必须走这个服务器。

用法:
    python tools/serve_with_csp.py                 # 默认 127.0.0.1:64899，根目录 data/
    python tools/serve_with_csp.py --port 64900

    # 另开一个终端（务必后台常驻，否则命令结束进程就被回收）
    "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
      --enable-logging=stderr --virtual-time-budget=5000 --window-size=1440,620 \
      --screenshot=out.png "http://127.0.0.1:64899/render/q-xxx.html" 2>log
    grep -i "refused\\|blocked\\|404\\|violat" log      # 必须为空

仅依赖标准库。
"""
import argparse
import functools
import http.server
import sys
from pathlib import Path

# 与预览面板一致的 CSP（外链一律被拦；data: / blob: / 内联脚本样式放行）
CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


class CspHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    ap = argparse.ArgumentParser(description="带预览面板 CSP 的本地静态服务器")
    ap.add_argument("--port", type=int, default=64899)
    ap.add_argument("--root", default=str(PROJECT_ROOT / "data"),
                    help="静态根目录（默认 data/，于是页面地址形如 /render/q-xxx.html）")
    args = ap.parse_args()

    handler = functools.partial(CspHandler, directory=args.root)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"服务 {args.root} -> http://127.0.0.1:{args.port}/   CSP: {CSP}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
