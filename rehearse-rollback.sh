#!/usr/bin/env bash
# rehearse-rollback.sh — 在一次性 profile 上彩排完整回滚流程

set -euo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
WORKSPACE="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
PLUGIN_DIR="${WORKSPACE}/dsh-engine-switch"
CLI="${WORKSPACE}/.recon/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
TEST_HOME="${WORKSPACE}/.recon/dsh-test-home"
ROLLBACK_SH="${PLUGIN_DIR}/rollback.sh"

PROFILE_NAME="rollback-rehearsal"
PROFILE_DIR="${TEST_HOME}/profiles/${PROFILE_NAME}"

DESKTOP_PKG="/Users/ivywu/.dsh/profiles/desktop/package.json"
DESKTOP_LOCK="/Users/ivywu/.dsh/profiles/desktop/pnpm-lock.yaml"
DESKTOP_PATCH="/Users/ivywu/.dsh/profiles/desktop/cordis.patch.yml"

# 真实 desktop 的基线 sha256（彩排前后必须一致）
DESKTOP_PKG_SHA="cdd3d4d51d79c3666332b935253a22c27525ddc5aa0c533fe658c8f2a8403e86"
DESKTOP_LOCK_SHA="783c01daf765dddb22d08c3b0762537df891d29cb628907d628ca65e3a0fcc0c"
DESKTOP_PATCH_SHA="e980f02d1fd586d4bb47d99480e74895e0ea6c4095380cb4aa712f1e528e78fd"

HITS=0
MISSES=0

hit() {
  echo "[HIT] $1"
  HITS=$((HITS + 1))
}

miss() {
  echo "[MISS] $1"
  MISSES=$((MISSES + 1))
}

sha256_file() {
  shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
}

echo "=== 回滚机制彩排 ==="
echo ""

# 断言 A：真实 desktop 基线 sha256 未变
echo "【断言 A】真实 desktop 的 package.json / pnpm-lock.yaml / cordis.patch.yml 彩排前 sha256 与基线一致"
BEFORE_PKG=$(sha256_file "$DESKTOP_PKG")
BEFORE_LOCK=$(sha256_file "$DESKTOP_LOCK")
BEFORE_PATCH=$(sha256_file "$DESKTOP_PATCH")

if [[ "$BEFORE_PKG" == "$DESKTOP_PKG_SHA" ]]; then
  hit "desktop/package.json 基线一致: $BEFORE_PKG"
else
  miss "desktop/package.json 基线不一致: 期望 $DESKTOP_PKG_SHA, 实际 $BEFORE_PKG"
fi

if [[ "$BEFORE_LOCK" == "$DESKTOP_LOCK_SHA" ]]; then
  hit "desktop/pnpm-lock.yaml 基线一致: $BEFORE_LOCK"
else
  miss "desktop/pnpm-lock.yaml 基线不一致: 期望 $DESKTOP_LOCK_SHA, 实际 $BEFORE_LOCK"
fi

if [[ "$BEFORE_PATCH" == "$DESKTOP_PATCH_SHA" ]]; then
  hit "desktop/cordis.patch.yml 基线一致: $BEFORE_PATCH"
else
  miss "desktop/cordis.patch.yml 基线不一致: 期望 $DESKTOP_PATCH_SHA, 实际 $BEFORE_PATCH"
fi

echo ""

# 断言 B：创建一次性 profile（只装本插件，建立最小干净基线）
echo "【断言 B】创建一次性 profile（只装本插件，无额外依赖）"
rm -rf "$TEST_HOME"
mkdir -p "$TEST_HOME"

# 直接装本插件触发 profile 初始化
DSH_HOME="$TEST_HOME" node "$CLI" plugin --profile "$PROFILE_NAME" add "$PLUGIN_DIR" >/dev/null 2>&1

if [[ -d "$PROFILE_DIR" ]] && [[ -f "${PROFILE_DIR}/package.json" ]]; then
  hit "一次性 profile 创建成功: $PROFILE_DIR"
else
  miss "一次性 profile 创建失败"
  echo ""
  echo "=== 汇总 ==="
  echo "HITS: $HITS"
  echo "MISSES: $MISSES"
  exit 1
fi

# 等待 pnpm-lock.yaml 出现
for i in {1..10}; do
  if [[ -f "${PROFILE_DIR}/pnpm-lock.yaml" ]]; then
    break
  fi
  sleep 0.5
done

if [[ ! -f "${PROFILE_DIR}/pnpm-lock.yaml" ]]; then
  # pnpm-lock.yaml 可能不会立即生成（link: 依赖不触发 lock 更新）
  # 这种情况下记录为已知限制
  echo "   注意：pnpm-lock.yaml 未生成（link: 依赖可能不触发 lock 文件）"
fi

if grep -q "dsh-engine-switch" "${PROFILE_DIR}/package.json" 2>/dev/null; then
  hit "插件已装入 package.json"
else
  miss "插件未出现在 package.json"
fi

if jq -e '.dsh.profile.bundles | map(select(. == "@local/dsh-engine-switch")) | length > 0' "${PROFILE_DIR}/package.json" >/dev/null 2>&1; then
  hit "bundles 数组包含 @local/dsh-engine-switch"
else
  miss "bundles 数组不包含插件"
fi

FIRST_INSTALL_PKG=$(sha256_file "${PROFILE_DIR}/package.json")
FIRST_INSTALL_LOCK=$(sha256_file "${PROFILE_DIR}/pnpm-lock.yaml")

echo "   首次装入后 package.json  sha256: $FIRST_INSTALL_PKG"
echo "   首次装入后 pnpm-lock.yaml sha256: ${FIRST_INSTALL_LOCK:-<不存在>}"
echo ""

# 断言 C：移除插件，建立干净基线
echo "【断言 C】移除插件，建立干净基线"

DSH_HOME="$TEST_HOME" node "$CLI" plugin --profile "$PROFILE_NAME" remove @local/dsh-engine-switch >/dev/null 2>&1

BEFORE_INSTALL_PKG=$(sha256_file "${PROFILE_DIR}/package.json")
BEFORE_INSTALL_LOCK=$(sha256_file "${PROFILE_DIR}/pnpm-lock.yaml")

echo "   移除后 package.json  sha256: $BEFORE_INSTALL_PKG"
echo "   移除后 pnpm-lock.yaml sha256: ${BEFORE_INSTALL_LOCK:-<不存在>}"

if ! grep -q "dsh-engine-switch" "${PROFILE_DIR}/package.json" 2>/dev/null; then
  hit "插件已从 package.json 移除"
else
  miss "插件仍在 package.json 中"
fi

echo ""

# 断言 D：snapshot 干净状态
echo "【断言 D】对干净状态进行 snapshot"

SNAPSHOT_DIR="${PLUGIN_DIR}/.rollback-snapshots" "$ROLLBACK_SH" snapshot --profile "$PROFILE_NAME" --home "$TEST_HOME" >/dev/null 2>&1

SNAPSHOT_BASE="${PLUGIN_DIR}/.rollback-snapshots/${PROFILE_NAME}"
if [[ -f "${SNAPSHOT_BASE}/package.json.bak" ]]; then
  hit "快照已保存: ${SNAPSHOT_BASE}/package.json.bak"
else
  miss "快照保存失败"
fi

if [[ -f "${SNAPSHOT_BASE}/pnpm-lock.yaml.bak" ]] || [[ ! -f "${PROFILE_DIR}/pnpm-lock.yaml" ]]; then
  hit "pnpm-lock.yaml 快照已保存（或原本不存在）"
else
  miss "pnpm-lock.yaml 快照保存失败"
fi

echo ""

# 断言 E：重新装入插件后 sha256 改变
echo "【断言 E】重新装入插件，确认 package.json 发生变化"

DSH_HOME="$TEST_HOME" node "$CLI" plugin --profile "$PROFILE_NAME" add "$PLUGIN_DIR" >/dev/null 2>&1

AFTER_PLUGIN_PKG=$(sha256_file "${PROFILE_DIR}/package.json")
AFTER_PLUGIN_LOCK=$(sha256_file "${PROFILE_DIR}/pnpm-lock.yaml")

if [[ "$AFTER_PLUGIN_PKG" != "$BEFORE_INSTALL_PKG" ]]; then
  hit "package.json 装入后发生变化: $AFTER_PLUGIN_PKG"
else
  miss "package.json 装入后未变化（异常）"
fi

echo "   装入后 package.json  sha256: $AFTER_PLUGIN_PKG"
echo "   装入后 pnpm-lock.yaml sha256: ${AFTER_PLUGIN_LOCK:-<不存在>}"
echo ""

# 断言 F：restore 后 sha256 一致
echo "【断言 F】restore 后 package.json 逐字节还原"
SNAPSHOT_DIR="${PLUGIN_DIR}/.rollback-snapshots" "$ROLLBACK_SH" restore --profile "$PROFILE_NAME" --home "$TEST_HOME" >/dev/null 2>&1

AFTER_RESTORE_PKG=$(sha256_file "${PROFILE_DIR}/package.json")
AFTER_RESTORE_LOCK=$(sha256_file "${PROFILE_DIR}/pnpm-lock.yaml")

if [[ "$AFTER_RESTORE_PKG" == "$BEFORE_INSTALL_PKG" ]]; then
  hit "package.json 逐字节还原: $AFTER_RESTORE_PKG"
else
  miss "package.json sha256 不一致: 移除后 $BEFORE_INSTALL_PKG, 还原后 $AFTER_RESTORE_PKG"
fi

if [[ -f "${PROFILE_DIR}/pnpm-lock.yaml" ]] && [[ -n "$BEFORE_INSTALL_LOCK" ]]; then
  if [[ "$AFTER_RESTORE_LOCK" == "$BEFORE_INSTALL_LOCK" ]]; then
    hit "pnpm-lock.yaml 逐字节还原: $AFTER_RESTORE_LOCK"
  else
    miss "pnpm-lock.yaml sha256 不一致: 移除后 $BEFORE_INSTALL_LOCK, 还原后 $AFTER_RESTORE_LOCK"
  fi
elif [[ ! -f "${PROFILE_DIR}/pnpm-lock.yaml" ]] && [[ -z "$BEFORE_INSTALL_LOCK" ]]; then
  hit "pnpm-lock.yaml 原本不存在，还原后也不存在（一致）"
else
  miss "pnpm-lock.yaml 状态不一致"
fi

echo ""

# 断言 G：真实 desktop 彩排后 sha256 不变
echo "【断言 G】彩排后真实 desktop 的三文件 sha256 与彩排前完全一致（DESKTOP_UNTOUCHED）"
AFTER_PKG=$(sha256_file "$DESKTOP_PKG")
AFTER_LOCK=$(sha256_file "$DESKTOP_LOCK")
AFTER_PATCH=$(sha256_file "$DESKTOP_PATCH")

ALL_UNCHANGED=true

if [[ "$AFTER_PKG" == "$BEFORE_PKG" ]]; then
  hit "desktop/package.json 彩排后未变: $AFTER_PKG"
else
  miss "desktop/package.json 彩排后已变: 彩排前 $BEFORE_PKG, 彩排后 $AFTER_PKG"
  ALL_UNCHANGED=false
fi

if [[ "$AFTER_LOCK" == "$BEFORE_LOCK" ]]; then
  hit "desktop/pnpm-lock.yaml 彩排后未变: $AFTER_LOCK"
else
  miss "desktop/pnpm-lock.yaml 彩排后已变: 彩排前 $BEFORE_LOCK, 彩排后 $AFTER_LOCK"
  ALL_UNCHANGED=false
fi

if [[ "$AFTER_PATCH" == "$BEFORE_PATCH" ]]; then
  hit "desktop/cordis.patch.yml 彩排后未变: $AFTER_PATCH"
else
  miss "desktop/cordis.patch.yml 彩排后已变: 彩排前 $BEFORE_PATCH, 彩排后 $AFTER_PATCH"
  ALL_UNCHANGED=false
fi

if $ALL_UNCHANGED; then
  echo "[HIT] DESKTOP_UNTOUCHED"
  HITS=$((HITS + 1))
else
  echo "[MISS] DESKTOP_UNTOUCHED (真实 desktop 被彩排改动)"
  MISSES=$((MISSES + 1))
fi

echo ""
echo "=== 汇总 ==="
echo "HITS: $HITS"
echo "MISSES: $MISSES"

if [[ $MISSES -eq 0 ]]; then
  exit 0
else
  exit 1
fi
