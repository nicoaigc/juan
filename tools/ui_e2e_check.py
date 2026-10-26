# -*- coding: utf-8 -*-
"""UI 端到端自检：在**带预览面板 CSP 的本地服务器**上跑一遍三层页面 + 筛选交互。

为什么需要它：`file://` 下没有 CSP、路径就是磁盘路径，资源类改动（外链 / 图片 /
字体）全都能过，测不出问题；而筛选、跳转这类交互，静态截图也看不出来。
所以这里用「iframe 驱动点击 + 把结果写在页顶」的方式做无头验证，不需要装
Playwright / agent-browser。

前置：另开终端常驻 `python tools/serve_with_csp.py --port 64907`（后台起，别让命令结束）。

用法:
    C:\\Users\\1\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe tools\\ui_e2e_check.py
    ... tools\\ui_e2e_check.py --port 64907 --out .workbuddy/tmp/sj/e2e.png

判读：截图顶部黑条就是自检结论（每步的期望值都写在里面，出错会显式写「错误！」）；
     退出码非 0 或日志里出现 CSP 违规就直接失败。
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TEMPLATE = ROOT / "tools" / "ui_e2e_test.html"
BAD = ("refused", "blocked", "violat", "uncaught", "failed to load", "not found")


def main() -> int:
    ap = argparse.ArgumentParser(description="三层 UI 端到端自检（需先起 serve_with_csp.py）")
    ap.add_argument("--port", type=int, default=64907)
    ap.add_argument("--root", default=str(ROOT / "data"), help="静态根目录（须与服务器一致）")
    ap.add_argument("--out", default=str(ROOT / ".workbuddy" / "tmp" / "sj" / "e2e.png"))
    args = ap.parse_args()

    root = Path(args.root)
    served = root / "_ui_e2e_test.html"      # 必须落在服务器根下才同源，才能驱动 iframe
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TEMPLATE, served)
    try:
        proc = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--enable-logging=stderr", "--virtual-time-budget=20000",
             "--window-size=1260,1000", f"--screenshot={out}",
             f"http://127.0.0.1:{args.port}/_ui_e2e_test.html"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        log = out.with_suffix(".log")
        log.write_text(proc.stderr or "", encoding="utf-8")
        hits = [ln.strip() for ln in (proc.stderr or "").splitlines()
                if any(b in ln.lower() for b in BAD)]
        print(f"截图: {out}")
        print(f"console 日志: {log}")
        if hits:
            print(f"[失败] 发现 {len(hits)} 条 CSP / 加载违规：", file=sys.stderr)
            for ln in hits[:20]:
                print("   " + ln, file=sys.stderr)
            return 1
        if proc.returncode != 0:
            print(f"[失败] Chrome 退出码 {proc.returncode}", file=sys.stderr)
            return 1
        print("通过：0 条 CSP / 加载违规。请打开截图核对顶部黑条里的每一步结论。")
        return 0
    finally:
        if served.exists():
            served.unlink()


if __name__ == "__main__":
    sys.exit(main())
