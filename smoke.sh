#!/usr/bin/env bash
# smoke.sh — @local/dsh-engine-switch 冒烟测试入口（可复跑）
# 用法：bash dsh-engine-switch/smoke.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="$HERE/smoke.mjs"

echo "== smoke.sh :: node --check index.js =="
if ! node --check "$HERE/index.js"; then
  echo "SYNTAX_FAIL"
  exit 1
fi
echo "SYNTAX_OK"

echo ""
echo "== smoke.sh :: node smoke.mjs =="
node "$SMOKE"
code=$?

echo ""
echo "== smoke.sh :: exit code = $code =="
if [ "$code" -eq 0 ]; then
  echo "SMOKE_SH: OK"
else
  echo "SMOKE_SH: FAILED"
fi
exit "$code"
