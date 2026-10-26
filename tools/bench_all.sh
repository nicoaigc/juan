#!/usr/bin/env bash
# 一把跑完 5 张卷 / 10 次识别的对账。用法: tools/bench_all.sh [--set k=v ...]
set -e
cd "$(dirname "$0")/.."
P="C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
R=.workbuddy/tmp/recog_pilot
D=data/benchmark
ARGS=(
  --match both
  --cfg "密集页1=$R/e2e_final.raw.json|$D/2026-10-01-第2单元练习卷-p1.jpg"
  --cfg "密集页2=$R/e2e_p2p1b.raw.json|$D/2026-10-01-第2单元练习卷-p1.jpg"
  --cfg "应用题1=$R/e2e_final_fig.raw.json|$D/2026-09-30-选择与应用题.jpg"
  --cfg "应用题2=$R/e2e_fig.raw.json|$D/2026-09-30-选择与应用题.jpg"
  --cfg "小学练习页1=$R/nd_page1.raw.json|$D/2026-09-30-小学练习页.jpg"
  --cfg "小学练习页2=$R/nd_page2.raw.json|$D/2026-09-30-小学练习页.jpg"
  --cfg "乘法综合1=$R/nd_mix1.raw.json|$D/2026-10-01-乘法综合练习.jpg"
  --cfg "乘法综合2=$R/nd_mix2.raw.json|$D/2026-10-01-乘法综合练习.jpg"
  --cfg "乘法练习卷2-1=$R/nd_png1.raw.json|$D/2026-09-30-乘法练习卷2.png"
  --cfg "乘法练习卷2-2=$R/nd_png2.raw.json|$D/2026-09-30-乘法练习卷2.png"
)
"$P" tools/refine_bench.py "${ARGS[@]}" "$@"
