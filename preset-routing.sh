#!/usr/bin/env bash
# preset-routing.sh — agentPreset 路由确定性测试驱动脚本
set -euo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
cd "$SWITCH"

echo "=== preset-routing: agentPreset 路由确定性测试 ==="
echo ""

# 执行测试
node --no-warnings preset-routing.mjs

echo ""
echo "preset-routing 测试完成"
