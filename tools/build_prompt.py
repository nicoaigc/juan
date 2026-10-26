# -*- coding: utf-8 -*-
"""把 prompts/auto-recognize-prompt.md 编译成前端能直接引用的 JS。

为什么需要这一步：网页应用读不到项目里的 .md（它是随应用发布的静态站点，
没有读任意文件的能力，fetch 一个 md 也只是拿文本、还得处理路径与缓存）。
而提示词又必须**只有一份正本**——不然规范一改、两边就悄悄跑偏。

所以：正本仍是 prompts/auto-recognize-prompt.md，本脚本把它编译成
app/js/recognize-prompt.js（window.RECOGNIZE_PROMPT），前端只引用产物。
改了 .md 就要重跑本脚本，README 的日常流程里写了这一步。

用法：
    python tools/build_prompt.py [--check]
      --check  只校验产物是否与正本一致（CI/预览前用），不写文件
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "prompts" / "auto-recognize-prompt.md"
OUT = ROOT / "app" / "js" / "recognize-prompt.js"


def extract(md: str) -> dict:
    def block_after(heading: str) -> str:
        i = md.find(heading)
        if i < 0:
            raise SystemExit("提示词正本里找不到小节：%s" % heading)
        fence = md.find("```", i)
        if fence < 0:
            raise SystemExit("%s 后面没有代码块" % heading)
        body = md.find("\n", fence)
        end = md.find("```", body)
        if end < 0:
            raise SystemExit("%s 的代码块没有闭合" % heading)
        return md[body + 1:end].rstrip()

    return {"system": block_after("### SYSTEM"), "user": block_after("### USER")}


def render(prompt: dict, md: str, stamp: str | None = None) -> str:
    # stamp 可外部传入：--check 时要用 **产物里记的那个时间** 重渲染再比，
    # 否则拿"此刻"去比必然不等（每次编译时间都不同），校验就永远失败。
    if stamp is None:
        stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    digest = hashlib.sha1(md.encode("utf-8")).hexdigest()[:12]
    return (
        "/* 自动生成，请勿直接编辑 —— 正本是 prompts/auto-recognize-prompt.md\n"
        f"   由 tools/build_prompt.py 于 {stamp} 编译（源文件 sha1 {digest}）\n"
        "   改了正本要重跑：python tools/build_prompt.py */\n"
        "(function () {\n"
        "  \"use strict\";\n"
        "  window.RECOGNIZE_PROMPT = {\n"
        "    system: " + json.dumps(prompt["system"], ensure_ascii=False) + ",\n"
        "    user: " + json.dumps(prompt["user"], ensure_ascii=False) + ",\n"
        "    source: " + json.dumps("prompts/auto-recognize-prompt.md") + ",\n"
        "    sourceSha1: " + json.dumps(digest) + ",\n"
        "    builtAt: " + json.dumps(stamp) + ",\n"
        "  };\n"
        "})();\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    a = ap.parse_args()

    md = SRC.read_text(encoding="utf-8")
    prompt = extract(md)

    if a.check:
        if not OUT.is_file():
            print("产物不存在：%s（跑 python tools/build_prompt.py 生成）" % OUT, file=sys.stderr)
            return 1
        cur = OUT.read_text(encoding="utf-8")
        # 用产物里记着的时间戳重渲染再逐字节比。这样时间戳被排除在比较之外，
        # 「正本改了没重编译」和「产物被手改」都仍然报得出来。
        m = re.search(r'\bbuiltAt:\s*"([^"]*)"', cur)
        if not m:
            print("产物格式不对：读不到 builtAt。重跑：python tools/build_prompt.py", file=sys.stderr)
            return 1
        js = render(prompt, md, stamp=m.group(1))
        if cur != js:
            print("产物与正本不一致 —— 正本改了但没重新编译。跑：python tools/build_prompt.py",
                  file=sys.stderr)
            return 1
        print("✓ 提示词产物与正本一致（源 sha1 %s，编译于 %s）"
              % (hashlib.sha1(md.encode("utf-8")).hexdigest()[:12], m.group(1)))
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    js = render(prompt, md)
    OUT.write_text(js, encoding="utf-8")
    print("正本    %s" % SRC.relative_to(ROOT))
    print("产物    %s  (%.1f KB)" % (OUT.relative_to(ROOT), len(js.encode("utf-8")) / 1024))
    print("        system %d 字 / user %d 字（含 {W} {H} 占位）" % (len(prompt["system"]), len(prompt["user"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
