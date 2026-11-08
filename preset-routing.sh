#!/usr/bin/env bash
# preset-routing.sh — agentPreset 路由确定性测试驱动脚本
set -euo pipefail

WS="/Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch"
cd "$WS"

echo "=== preset-routing: agentPreset 路由确定性测试 ==="
echo ""

# 执行测试
node --no-warnings preset-routing.mjs

echo ""
echo "preset-routing 测试完成"
