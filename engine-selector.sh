#!/usr/bin/env bash
# engine-selector.sh — 独立引擎选择器（Engine ⊥ Preset）确定性测试驱动脚本
set -euo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
cd "$SWITCH"

echo "=== engine-selector: 独立引擎选择器（Engine ⊥ Preset）确定性测试 ==="
echo ""

# 执行测试
node --no-warnings engine-selector.mjs

echo ""
echo "engine-selector 测试完成"
