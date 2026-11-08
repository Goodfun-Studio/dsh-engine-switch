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
#
# 基线于 2026-11-08 按真实 desktop 现况刷新（老板确认）。旧值 pkg=cdd3d4d5… /
# lock=783c01da… 逐字节等于 .rollback-snapshots/desktop/{package.json,pnpm-lock.yaml}.bak
# （2026-11-08 11:11 快照）。两值之差异经 diff 核实：desktop 此后新装了
# @local/dsh-engine-switch 与 dsh-context 两个 bundle，属合法变更，故刷新基线。
#
# 【2026-11-09 00:0x 上一次刷新 DESKTOP_PATCH_SHA（只改常量）】
# 值 065021e3… 是 2026-11-08 23:55 桌面端自身重写 profile patch 后的快照。
#
# 【2026-11-09 L6 本轮：cordis.patch.yml 从「字面量哈希」改判「形状哈希」】
# 事实：该文件在 2026-11-09 00:39 又被桌面端重写了一次（raw 065021e3… → 4e2b5e4d…），
# 且**唯一**的语义差异就是本插件的 `engine: pi`（见下面 §4 的归因取证）。
# 这不是缺陷，而是本插件设计上的正常行为：`Config.engine` 是 volatile 字段，
# 设置页 / `/engine` / 本轮的引擎 Chip 每改一次值，profile patch 就重写一次 ——
# 拿字面量当基线 ⇒ 功能一被使用断言 A 就红，红线失去信号价值（前两轮各自刷新过一次）。
# 处理（采纳前一轮 §9 里提出、待定的方案）：把 cordis.patch.yml 的基线改成
# **形状哈希** —— 只把 `engine-switch` 条目里的 `engine:` 值规范化成 `<volatile>` 再取 sha256，
# 另外**单独断言**该值 ∈ {native,pi,echo,缺省}。规范化只覆盖这一行：
# 新增/删除插件行、改别的 config、改别的值 ⇒ 形状哈希照样变 ⇒ 仍会 MISS。
# package.json / pnpm-lock.yaml 两条基线仍是字面量，未动。
DESKTOP_PKG_SHA="1676854392ce0f159b7f8c8385b2c0c0b394e47e96a5e903c4e3556c257bd13d"
DESKTOP_LOCK_SHA="5731a54294252a74e93f007c7c1c6d80eabcfa6339216fa20eb78b0d6ebfd2b9"
DESKTOP_PATCH_CANON_SHA="87661f12040b227f74cff670ebba49fd5a36ce3977917b572c9031daf1607987"
# 形状基线建立时的实测 raw sha256（仅供人眼核对：本次改判前的那一份）
DESKTOP_PATCH_RAW_AT_BASELINE="4e2b5e4d0d3e7de35ce7baeb4b81cccd9b5c81d6d75ec5619563f00d269c1233"

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

# 读 desktop profile patch 里本插件的 volatile 选择器值，并给出「形状哈希」：
# 只把 `engine-switch` 条目里的 `engine:` 一行规范化成 `<volatile>`，其余逐字节保留。
# 输出：`<engine 取值> <形状 sha256>`
patch_shape_report() {
  node -e '
const fs = require("node:fs")
const crypto = require("node:crypto")
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n")
let start = -1
let end = lines.length
for (let i = 0; i < lines.length; i++) if (/^- id:\s*engine-switch\s*(#.*)?$/.test(lines[i])) { start = i; break }
if (start >= 0) for (let i = start + 1; i < lines.length; i++) if (/^- id:/.test(lines[i])) { end = i; break }
let engine = "<absent>"
const out = lines.slice()
if (start >= 0) for (let i = start; i < end; i++) {
  const match = /^(\s*)engine:\s*(\S+)\s*$/.exec(lines[i])
  if (match !== null) { engine = match[2]; out[i] = match[1] + "engine: <volatile>" }
}
process.stdout.write(engine + " " + crypto.createHash("sha256").update(out.join("\n")).digest("hex") + "\n")
' "$1"
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

# cordis.patch.yml：形状哈希（engine 选择器值按设计会浮动，见文件头注释）
read -r PATCH_ENGINE PATCH_CANON_SHA <<< "$(patch_shape_report "$DESKTOP_PATCH")"

if [[ "$PATCH_CANON_SHA" == "$DESKTOP_PATCH_CANON_SHA" ]]; then
  hit "desktop/cordis.patch.yml 形状基线一致（engine 值规范化后）: canon=$PATCH_CANON_SHA engine=$PATCH_ENGINE raw=$BEFORE_PATCH"
else
  miss "desktop/cordis.patch.yml 形状基线不一致: 期望 canon=$DESKTOP_PATCH_CANON_SHA, 实际 canon=$PATCH_CANON_SHA（engine=$PATCH_ENGINE raw=$BEFORE_PATCH）"
fi

if [[ "$PATCH_ENGINE" == "native" || "$PATCH_ENGINE" == "pi" || "$PATCH_ENGINE" == "echo" || "$PATCH_ENGINE" == "<absent>" ]]; then
  hit "desktop/cordis.patch.yml 的 engine 取值合法（native|pi|echo|缺省）: $PATCH_ENGINE"
else
  miss "desktop/cordis.patch.yml 的 engine 取值非法（不是三个精确取值之一）: $PATCH_ENGINE"
fi

# 断言 A2：形状哈希的**边界自证** —— 证明放宽的**只有**「engine 取值」这一个维度。
# 三个合成样本：新增插件行、把 engine 改成非法值 ⇒ 必须变（仍会红）；
# 只换一个合法 engine 值 ⇒ 必须不变（本插件功能被使用，不该红）。
SHAPE_PROBE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-patch-shape.XXXXXX")"
node -e '
const fs = require("node:fs")
const text = fs.readFileSync(process.argv[1], "utf8")
const dir = process.argv[2]
// 变量一：多一行插件（结构变了）
fs.writeFileSync(dir + "/extra-row.yml", text + "- id: probe-plugin\n  name: \"@local/probe\"\n  config: {}\n")
// 变量二：engine 改成非法值
fs.writeFileSync(dir + "/bad-engine.yml", text.replace(/\n    engine: \S+\n/, "\n    engine: v8\n"))
// 变量三：只换一个合法 engine 值（设计上应该放行的那个维度）
fs.writeFileSync(dir + "/swapped-engine.yml", text.replace(/\n    engine: \S+\n/, "\n    engine: echo\n"))
' "$DESKTOP_PATCH" "$SHAPE_PROBE"

read -r PROBE_EXTRA_ROWS_ENGINE PROBE_EXTRA_ROWS_SHA <<< "$(patch_shape_report "$SHAPE_PROBE/extra-row.yml")"
read -r PROBE_BAD_ENGINE PROBE_BAD_SHA <<< "$(patch_shape_report "$SHAPE_PROBE/bad-engine.yml")"
read -r PROBE_SWAPPED_ENGINE PROBE_SWAPPED_SHA <<< "$(patch_shape_report "$SHAPE_PROBE/swapped-engine.yml")"
if [[ "$PROBE_EXTRA_ROWS_SHA" != "$DESKTOP_PATCH_CANON_SHA" ]]; then
  hit "形状哈希边界自证①：新增一行插件（结构变了）⇒ 形状哈希必变（仍会红）: canon=$PROBE_EXTRA_ROWS_SHA"
else
  miss "形状哈希边界自证①失败：多了一行插件形状哈希竟然没变（放宽过度）: canon=$PROBE_EXTRA_ROWS_SHA"
fi
if [[ "$PROBE_BAD_SHA" == "$DESKTOP_PATCH_CANON_SHA" && "$PROBE_BAD_ENGINE" == "v8" ]]; then
  hit "形状哈希边界自证②：engine 取值被规范化（哈希盲于取值，设计如此），但取值仍被逐字读出（v8）⇒ 由「取值合法」那条断言接住"
else
  miss "形状哈希边界自证②失败: canon=$PROBE_BAD_SHA engine=$PROBE_BAD_ENGINE"
fi
if [[ "$PROBE_SWAPPED_SHA" == "$DESKTOP_PATCH_CANON_SHA" && "$PROBE_SWAPPED_ENGINE" == "echo" ]]; then
  hit "形状哈希边界自证③：只换一个合法 engine 值（pi → echo）⇒ 形状哈希不变（放行的就是这一个维度）"
else
  miss "形状哈希边界自证③失败：合法 engine 值互换竟然变了形状 canon=$PROBE_SWAPPED_SHA engine=$PROBE_SWAPPED_ENGINE"
fi
rm -rf "$SHAPE_PROBE"

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
