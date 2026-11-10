#!/usr/bin/env bash
# session-lifecycle.sh — 「pi 会话/Agent 生命周期」确定性测试驱动脚本
#
# 被测：pi-session.mjs（会话/Agent 生命周期宿主）+ index.js 的 pi 路由接线。
# 复用子（真实）：cordis Context + AgentRegistry + SessionStore + jsonl 持久化（临时根）；
# 替身只有两处且明确标注：原生 target 替身、@botiverse/oar 模块替身（不 spawn、不调模型）。
#
# 用法（工作区根）：bash dsh-engine-switch/session-lifecycle.sh
# 退出码：全部 HIT → 0；任一 MISS → 1。
set -euo pipefail

# 推导依赖根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导。
# 隔离 worktree 本身就是插件根；常规安装布局则是 workspace/dsh-engine-switch。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DSH_WORKSPACE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
if [ -n "${DSH_SWITCH:-}" ]; then
  SWITCH="$DSH_SWITCH"
elif [ -f "$SCRIPT_DIR/package.json" ]; then
  SWITCH="$SCRIPT_DIR"
else
  SWITCH="$ROOT/dsh-engine-switch"
fi
cd "$SWITCH"

echo "=== session-lifecycle: pi 引擎的会话 / Agent 生命周期（身份 / 落盘 / 注册 / 首轮 / 负向）==="
echo ""

# 生命周期宿主是 host 关键路径：先过语法闸
echo "== session-lifecycle.sh :: node --check pi-session.mjs =="
if ! node --check pi-session.mjs; then
  echo "SESSION_LIFECYCLE_DRIVER: FAILED"
  exit 1
fi
echo "SYNTAX_OK"
echo ""

node --no-warnings session-lifecycle.mjs
code=$?

echo ""
if [ "$code" -eq 0 ]; then
  echo "SESSION_LIFECYCLE_DRIVER: OK"
else
  echo "SESSION_LIFECYCLE_DRIVER: FAILED"
fi
exit "$code"
