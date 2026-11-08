#!/usr/bin/env bash
# client-ui.sh — 「引擎 Chip」客户端 bundle 测试驱动脚本
set -euo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
cd "$SWITCH"

echo "=== client-ui: 引擎 Chip 客户端 bundle（声明 / 装载 / 判定 / 交互）确定性测试 ==="
echo ""

# client bundle 是 boot 关键路径：先过语法闸（语法错 = 整页 "Failed to load plugins"）
echo "== client-ui.sh :: node --check client.js =="
if ! node --check client.js; then
  echo "CLIENT_UI_DRIVER: FAILED"
  exit 1
fi
echo "SYNTAX_OK"
echo ""

node --no-warnings client-ui.mjs
code=$?

echo ""
if [ "$code" -eq 0 ]; then
  echo "CLIENT_UI_DRIVER: OK"
else
  echo "CLIENT_UI_DRIVER: FAILED"
fi
exit "$code"
