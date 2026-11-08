#!/usr/bin/env bash
# pi-probe.sh — @local/dsh-engine-switch 真引擎探针入口（可复跑）
#
# 用法（工作区根）：
#   bash dsh-engine-switch/pi-probe.sh
#
# 职责：
#   1) node --check pi-probe.mjs   —— 语法闸门
#   2) node pi-probe.mjs           —— 真起 pi RPC 子进程 + 一次真实模型调用
#      · 逐条打印 [HIT]/[MISS]（由 pi-probe.mjs 输出）
#      · 收尾打印 SUMMARY / PI_PROBE_RESULT
#   3) 透传退出码（全 HIT → 0；任一 MISS → 1）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/pi-probe.mjs"

echo "== pi-probe.sh :: node --check pi-probe.mjs =="
if ! node --check "$PROBE"; then
  echo "SYNTAX_FAIL"
  exit 1
fi
echo "SYNTAX_OK"

echo ""
echo "== pi-probe.sh :: node pi-probe.mjs =="
node "$PROBE"
code=$?

echo ""
echo "== pi-probe.sh :: exit code = $code =="
if [ "$code" -eq 0 ]; then
  echo "PI_PROBE_SH: OK"
else
  echo "PI_PROBE_SH: FAILED"
fi
exit "$code"
