#!/usr/bin/env bash
# test-safe-mode.sh — 真机：验证 DSH_ENGINE_SWITCH_DISABLE=1 启用安全模式，零 pi 调用
#
# 断言（4 条）：
#   [不设环境变量] SAFE_MODE_OFF：safeMode===false, routerInstalled===true
#   [设 DSH_ENGINE_SWITCH_DISABLE=1] SAFE_MODE_ON：safeMode===true, routerInstalled===false, agentsFactorySlotIsRouter===false
#   SAFE_MODE_NO_PI：安全模式下 piByKind.createAgent === 0（负向防误杀：确保 pi 引擎零调用）
#
# 用法：bash test-safe-mode.sh
# 退出码：MISS > 0 → 非 0；全部 HIT（MISS == 0）→ 0
set -uo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
CLI="$ROOT/.recon/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
INJECT_DIR="$ROOT/.recon/dsh-real-inject"
UPSTREAM_AI="$ROOT/.recon/dsh-src/dsh/node_modules/@deepseek-ai"

# DSH_HOME 重定向到工作区；真实 ~/.dsh 全程只读
export DSH_HOME="$ROOT/.recon/dsh-test-home"
PROFILE_NAME="testh-safe"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

# 两次测试各用独立 patch 与 evidence
PATCH_OFF="$INJECT_DIR/safe-mode-off-patch.yml"
PATCH_ON="$INJECT_DIR/safe-mode-on-patch.yml"
EVIDENCE_OFF="$INJECT_DIR/safe-mode-off-evidence.json"
EVIDENCE_ON="$INJECT_DIR/safe-mode-on-evidence.json"
LOG_OFF="$INJECT_DIR/safe-mode-off-run.log"
LOG_ON="$INJECT_DIR/safe-mode-on-run.log"

TASK="reply with exactly: SAFE_MODE_TEST"

mkdir -p "$INJECT_DIR"

HIT=0; MISS=0
hit(){  printf '[HIT]  %s\n' "$1"; HIT=$((HIT+1)); }
miss(){ printf '[MISS] %s\n' "$1"; MISS=$((MISS+1)); }

echo "== test-safe-mode.sh :: verify DSH_ENGINE_SWITCH_DISABLE safety gate =="
echo "ROOT=$ROOT"
echo "DSH_HOME=$DSH_HOME"
echo "CLI=$CLI"
echo

# ---------- 前置检查 ----------
[ -f "$CLI" ] || { echo "FATAL: CLI not found: $CLI"; exit 2; }
[ -f "$SWITCH/index.js" ] || { echo "FATAL: plugin entry not found: $SWITCH/index.js"; exit 2; }

# 检查 jsonq 依赖（node）
if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node not found (required for jsonq)"
  exit 2
fi

# ---------- 运行时依赖符号链接 ----------
if [ -z "${DSH_SWITCH_SKIP_LINK:-}" ]; then
  mkdir -p "$SWITCH/node_modules/@deepseek-ai"
  for _pkg in dsh-agent dsh-llm dsh-scope cordis; do
    if [ -e "$UPSTREAM_AI/$_pkg" ] && [ ! -e "$SWITCH/node_modules/@deepseek-ai/$_pkg" ]; then
      ln -sfn "$UPSTREAM_AI/$_pkg" "$SWITCH/node_modules/@deepseek-ai/$_pkg"
      echo "dep-scope: linked @deepseek-ai/$_pkg"
    fi
  done
fi
echo

# ---------- JSON 取值工具（照抄 endo-pi.sh） ----------
jsonq(){
  node -e "
    const fs=require('fs');
    let j=null;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); }catch(e){ process.stdout.write(''); process.exit(0); }
    const \$=j;
    try{ const v=eval(process.argv[2]); process.stdout.write(v===undefined||v===null?'':String(v)); }catch(e){ process.stdout.write(''); }
  " "$1" "$2" 2>/dev/null
}

# ---------- 准备两套 patch 文件 ----------
echo "--- prepare patch files ---"

# 安全模式 OFF patch（forceEngine: 'pi'）
cat > "$PATCH_OFF" <<EOF_OFF
- insert:
  - id: engine-switch-safe-off
    name: $SWITCH/index.js
    config:
      evidencePath: $INJECT_DIR/safe-mode-off-evidence.json
      forceEngine: pi
EOF_OFF
echo "  created: $PATCH_OFF"

# 安全模式 ON patch（无 forceEngine，只注入插件收集 safeMode 等字段）
cat > "$PATCH_ON" <<EOF_ON
- insert:
  - id: engine-switch-safe-on
    name: $SWITCH/index.js
    config:
      evidencePath: $INJECT_DIR/safe-mode-on-evidence.json
EOF_ON
echo "  created: $PATCH_ON"
echo

# ---------- 1) 建/刷新一次性 profile ----------
echo "--- [1] create/refresh profile '$PROFILE_NAME' ---"
node "$CLI" "$PROFILE_NAME" --from-default-profile headless --dump-config >/dev/null 2>&1
if [ ! -d "$PROFILE_DIR" ]; then
  echo "FATAL: profile dir not created: $PROFILE_DIR"
  exit 2
fi
echo "profile created at: $PROFILE_DIR"
echo

# ========== TEST 1: 安全模式 OFF（不设环境变量） ==========
echo "=== TEST 1: SAFE_MODE_OFF (DSH_ENGINE_SWITCH_DISABLE unset) ==="
rm -f "$EVIDENCE_OFF"
: > "$LOG_OFF"

# 确保 DSH_ENGINE_SWITCH_DISABLE 未设置
unset DSH_ENGINE_SWITCH_DISABLE 2>/dev/null || true

set +e
node "$CLI" "$PROFILE_NAME" --patch "$PATCH_OFF" "$TASK" >"$LOG_OFF" 2>&1 &
PID_OFF=$!
sleep 4
kill "$PID_OFF" 2>/dev/null || true
wait "$PID_OFF" 2>/dev/null || true
RC_OFF=$?
set -e 2>/dev/null || true
echo "test 1 exit=$RC_OFF (informational)"
echo "log tail:"; tail -n 15 "$LOG_OFF" 2>/dev/null | sed 's/^/  | /'
echo

echo "--- TEST 1 evidence ---"
if [ -f "$EVIDENCE_OFF" ]; then
  echo "evidence: $EVIDENCE_OFF"
  node -e "console.log(JSON.stringify(require('$EVIDENCE_OFF'),null,2));" 2>/dev/null | sed 's/^/  /'
else
  echo "evidence: NOT WRITTEN ($EVIDENCE_OFF)"
  tail -n 20 "$LOG_OFF" 2>/dev/null | sed 's/^/  | /'
fi
echo

# 断言 TEST 1
JSM_OFF="$(jsonq "$EVIDENCE_OFF" '$ && $.safeMode')"
JRI_OFF="$(jsonq "$EVIDENCE_OFF" '$ && $.routerInstalled')"

if [ "$JSM_OFF" = "false" ] && [ "$JRI_OFF" = "true" ]; then
  hit "SAFE_MODE_OFF  (safeMode=false, routerInstalled=true)"
else
  miss "SAFE_MODE_OFF  (safeMode='$JSM_OFF', routerInstalled='$JRI_OFF')"
fi

# ========== TEST 2: 安全模式 ON（设 DSH_ENGINE_SWITCH_DISABLE=1） ==========
echo
echo "=== TEST 2: SAFE_MODE_ON (DSH_ENGINE_SWITCH_DISABLE=1) ==="
rm -f "$EVIDENCE_ON"
: > "$LOG_ON"

export DSH_ENGINE_SWITCH_DISABLE=1

set +e
node "$CLI" "$PROFILE_NAME" --patch "$PATCH_ON" "$TASK" >"$LOG_ON" 2>&1 &
PID_ON=$!
sleep 4
kill "$PID_ON" 2>/dev/null || true
wait "$PID_ON" 2>/dev/null || true
RC_ON=$?
set -e 2>/dev/null || true
echo "test 2 exit=$RC_ON (informational)"
echo "log tail:"; tail -n 15 "$LOG_ON" 2>/dev/null | sed 's/^/  | /'
echo

echo "--- TEST 2 evidence ---"
if [ -f "$EVIDENCE_ON" ]; then
  echo "evidence: $EVIDENCE_ON"
  node -e "console.log(JSON.stringify(require('$EVIDENCE_ON'),null,2));" 2>/dev/null | sed 's/^/  /'
else
  echo "evidence: NOT WRITTEN ($EVIDENCE_ON)"
  tail -n 20 "$LOG_ON" 2>/dev/null | sed 's/^/  | /'
fi
echo

# 断言 TEST 2
JSM_ON="$(jsonq "$EVIDENCE_ON" '$ && $.safeMode')"
JRI_ON="$(jsonq "$EVIDENCE_ON" '$ && $.routerInstalled')"
JAFS_ON="$(jsonq "$EVIDENCE_ON" '$ && $.agentsFactorySlotIsRouter')"
JPC_ON="$(jsonq "$EVIDENCE_ON" '$ && $.piByKind && $.piByKind.createAgent')"

if [ "$JSM_ON" = "true" ] && [ "$JRI_ON" = "false" ] && [ "$JAFS_ON" = "false" ]; then
  hit "SAFE_MODE_ON  (safeMode=true, routerInstalled=false, agentsFactorySlotIsRouter=false)"
else
  miss "SAFE_MODE_ON  (safeMode='$JSM_ON', routerInstalled='$JRI_ON', agentsFactorySlotIsRouter='$JAFS_ON')"
fi

# 负向防误杀：安全模式下 pi 引擎零调用
if [ -z "$JPC_ON" ] || [ "$JPC_ON" = "0" ] 2>/dev/null; then
  hit "SAFE_MODE_NO_PI  (piByKind.createAgent=0 or absent → pi engine NOT called)"
else
  miss "SAFE_MODE_NO_PI  (piByKind.createAgent='$JPC_ON', expected 0)"
fi

echo
echo "=== SUMMARY ==="
echo "$HIT HIT / $MISS MISS"
if [ "$MISS" -gt 0 ]; then
  echo "RESULT: FAIL ($MISS MISS) - exiting non-zero"
  exit 1
fi
echo "RESULT: PASS (all $HIT assertions HIT)"
exit 0
