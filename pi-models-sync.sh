#!/usr/bin/env bash
# pi-models-sync.sh — 「Pi 引擎 ⇄ DSH 模型选择器」联动的确定性测试驱动脚本（L8）
#
# 被测：pi-models.mjs（模型面）+ pi-session.mjs 的选区现读 + oar-engine.mjs 的透传 + index.js 的接线。
# 复用子（真实）：cordis Context + @deepseek-ai/dsh-llm 的 LlmRuntime + AgentRegistry + SessionStore。
# 替身只有两处且明确标注：@botiverse/oar 模块替身（不 spawn、不调模型）、原生 target 替身。
#
# 用法（工作区根）：bash dsh-engine-switch/pi-models-sync.sh
# 退出码：全部 HIT → 0；任一 MISS → 1。
set -euo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
cd "$SWITCH"

echo "=== pi-models-sync: Pi 引擎与 DSH 模型选择器的联动（目录 / 选区 / 透传 / 负向防误杀）==="
echo ""

# 模型面是 host 关键路径（注册进宿主 llm 注册表）：先过语法闸
for f in pi-models.mjs pi-session.mjs oar-engine.mjs index.js; do
  echo "== pi-models-sync.sh :: node --check $f =="
  if ! node --check "$f"; then
    echo "PI_MODELS_SYNC_DRIVER: FAILED ($f 语法不过)"
    exit 1
  fi
done
echo "SYNTAX_OK"
echo ""

node --no-warnings pi-models-sync.mjs
code=$?

echo ""
if [ "$code" -eq 0 ]; then
  echo "PI_MODELS_SYNC_DRIVER: OK"
else
  echo "PI_MODELS_SYNC_DRIVER: FAILED"
fi
exit "$code"
