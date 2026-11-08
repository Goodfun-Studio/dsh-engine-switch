#!/usr/bin/env bash
# rollback.sh — 快照 / 还原 DSH profile 的 package.json 与 pnpm-lock.yaml（逐字节）

set -euo pipefail

SCRIPT_NAME="rollback.sh"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-.rollback-snapshots}"

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME <command> --profile <name> [--home <path>]

Commands:
  snapshot   备份指定 profile 的 package.json / pnpm-lock.yaml
  restore    逐字节还原已备份的文件并清理 node_modules 下的插件符号链接

Options:
  --profile <name>   目标 profile 名称（必填）
  --home <path>      DSH_HOME 路径（默认: ~/.dsh）

Examples:
  $SCRIPT_NAME snapshot --profile test-profile
  $SCRIPT_NAME restore --profile test-profile --home /tmp/dsh-test-home
EOF
  exit 1
}

# 解析参数
COMMAND=""
PROFILE=""
DSH_HOME="${HOME}/.dsh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    snapshot|restore)
      COMMAND="$1"
      shift
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --home)
      DSH_HOME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "❌ 未知参数: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  echo "❌ 缺少命令（snapshot / restore）" >&2
  usage
fi

if [[ -z "$PROFILE" ]]; then
  echo "❌ 缺少 --profile 参数" >&2
  usage
fi

PROFILE_DIR="${DSH_HOME}/profiles/${PROFILE}"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "❌ profile 目录不存在: $PROFILE_DIR" >&2
  exit 1
fi

PACKAGE_JSON="${PROFILE_DIR}/package.json"
PNPM_LOCK="${PROFILE_DIR}/pnpm-lock.yaml"
SNAPSHOT_BASE="${SNAPSHOT_DIR}/${PROFILE}"

snapshot_cmd() {
  mkdir -p "$SNAPSHOT_BASE"
  
  if [[ ! -f "$PACKAGE_JSON" ]]; then
    echo "❌ package.json 不存在: $PACKAGE_JSON" >&2
    exit 1
  fi
  
  if [[ ! -f "$PNPM_LOCK" ]]; then
    echo "❌ pnpm-lock.yaml 不存在: $PNPM_LOCK" >&2
    exit 1
  fi
  
  cp -f "$PACKAGE_JSON" "${SNAPSHOT_BASE}/package.json.bak"
  cp -f "$PNPM_LOCK" "${SNAPSHOT_BASE}/pnpm-lock.yaml.bak"
  
  # 记录 dsh.profile.bundles 原始状态（用于还原时清理 node_modules）
  jq -r '.dsh.profile.bundles // [] | .[]' "$PACKAGE_JSON" > "${SNAPSHOT_BASE}/bundles.txt" || true
  
  echo "✅ 快照已保存到: $SNAPSHOT_BASE"
  echo "   - package.json.bak"
  echo "   - pnpm-lock.yaml.bak"
  echo "   - bundles.txt (当前已装 bundles)"
}

restore_cmd() {
  local PACKAGE_BAK="${SNAPSHOT_BASE}/package.json.bak"
  local PNPM_BAK="${SNAPSHOT_BASE}/pnpm-lock.yaml.bak"
  local BUNDLES_TXT="${SNAPSHOT_BASE}/bundles.txt"
  
  if [[ ! -f "$PACKAGE_BAK" ]]; then
    echo "❌ 快照不存在: $PACKAGE_BAK" >&2
    exit 1
  fi
  
  if [[ ! -f "$PNPM_BAK" ]]; then
    echo "❌ 快照不存在: $PNPM_BAK" >&2
    exit 1
  fi
  
  # 逐字节还原
  cp -f "$PACKAGE_BAK" "$PACKAGE_JSON"
  cp -f "$PNPM_BAK" "$PNPM_LOCK"
  
  echo "✅ 已还原 package.json 与 pnpm-lock.yaml"
  
  # 清理 node_modules 下的插件符号链接（避免残留）
  if [[ -f "$BUNDLES_TXT" ]] && [[ -d "${PROFILE_DIR}/node_modules" ]]; then
    while IFS= read -r bundle; do
      # bundle 格式可能是包名（如 @local/dsh-engine-switch）
      local pkg_name
      pkg_name=$(jq -r --arg b "$bundle" '.dsh.profile.bundles[] | select(. == $b) | . // empty' "$PACKAGE_BAK" 2>/dev/null || echo "")
      
      # 从当前 package.json dependencies 中找到对应的 link: 路径
      local link_path
      link_path=$(jq -r --arg b "$bundle" '.dependencies[$b] // empty' "$PACKAGE_JSON" 2>/dev/null || echo "")
      
      if [[ -n "$pkg_name" ]]; then
        local node_module_path="${PROFILE_DIR}/node_modules/${pkg_name}"
        if [[ -L "$node_module_path" ]]; then
          rm -f "$node_module_path"
          echo "   - 已清理符号链接: $node_module_path"
        fi
      fi
    done < "$BUNDLES_TXT"
  fi
  
  echo "✅ 回滚完成"
}

case "$COMMAND" in
  snapshot)
    snapshot_cmd
    ;;
  restore)
    restore_cmd
    ;;
  *)
    echo "❌ 未知命令: $COMMAND" >&2
    usage
    ;;
esac
