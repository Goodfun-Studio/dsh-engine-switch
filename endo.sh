#!/usr/bin/env bash
# endo.sh — 真机接管（real takeover）端到端冒烟：自包含、可复跑、退出码 0。
#
# 目标：在**重定向的 DSH_HOME**（绝不碰真实 ~/.dsh）下，建一次性 profile，
# 用 real-takeover-patch.yml 把 dsh-engine-switch 外挂注入真实 DSH 装配树，
# 跑一次真 DSH，读插件写出的证据 JSON，打印五条断言。
#
# 断言：TAKEOVER_REAL / DELEGATION / PROFILE_UNTOUCHED / HOMEDIR_UNTOUCHED / NO_BUNDLE_INSTALL
#
# 用法：bash /path/to/dsh-engine-switch/endo.sh
set -uo pipefail

WS="/Users/ivywu/Documents/deepseek-harness/default-workspace"
SWITCH="$WS/dsh-engine-switch"
CLI="$WS/.recon/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
INJECT_DIR="$WS/.recon/dsh-real-inject"
# 上游真实包所在（本地已解出的 dsh-desktop-runtime 依赖树；只做符号链接，绝不安装/联网）
UPSTREAM_AI="$WS/.recon/dsh-src/dsh/node_modules/@deepseek-ai"

# ① DSH_HOME 重定向到工作区；真实 ~/.dsh 全程只读指纹，绝不写入
export DSH_HOME="$WS/.recon/dsh-test-home"
REAL_DSH="${HOME}/.dsh"
PROFILE_NAME="testh"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

PATCH="$SWITCH/real-takeover-patch.yml"
EVIDENCE="$INJECT_DIR/real-takeover-evidence.json"
LOG="$INJECT_DIR/endo-run.log"

TMPD="$(mktemp -d 2>/dev/null || mktemp -d -t endo)"
cleanup(){ rm -rf "$TMPD"; }
trap cleanup EXIT

HIT=0; MISS=0
hit(){  printf '[HIT]  %s\n' "$1"; HIT=$((HIT+1)); }
miss(){ printf '[MISS] %s\n' "$1"; MISS=$((MISS+1)); }

echo "== endo.sh :: real takeover smoke =="
echo "WS=$WS"
echo "DSH_HOME=$DSH_HOME  (real ~/.dsh NOT touched)"
echo "CLI=$CLI"
echo

# ---------- 前置检查（缺件则如实失败，不伪造） ----------
[ -f "$CLI" ]  || { echo "FATAL: CLI not found: $CLI"; exit 2; }
[ -f "$PATCH" ]|| { echo "FATAL: patch not found: $PATCH"; exit 2; }
[ -f "$SWITCH/index.js" ] || { echo "FATAL: plugin entry not found: $SWITCH/index.js"; exit 2; }

# ---------- 运行时依赖解析作用域（唯一新增的可选准备步骤，可由 DSH_SWITCH_SKIP_LINK=1 跳过） ----------
# 外挂目录原不在 profiles 树内，上游 ESM 加载器对其裸导入不做重写；
# 故把它声明的 @deepseek-ai/dsh-agent 在本目录内符号链接到已解出的上游真货。
# 这不是安装：不写任何 lockfile、不联网、不改 profile/node_modules 内的任何真实文件。
if [ -z "${DSH_SWITCH_SKIP_LINK:-}" ]; then
  mkdir -p "$SWITCH/node_modules/@deepseek-ai"
  for _pkg in dsh-agent cordis; do
    if [ -e "$UPSTREAM_AI/$_pkg" ] && [ ! -e "$SWITCH/node_modules/@deepseek-ai/$_pkg" ]; then
      ln -sfn "$UPSTREAM_AI/$_pkg" "$SWITCH/node_modules/@deepseek-ai/$_pkg"
      echo "dep-scope: linked @deepseek-ai/$_pkg -> $UPSTREAM_AI/$_pkg"
    fi
  done
fi

# 被注入的外挂包名（用于 NO_BUNDLE_INSTALL 断言）
PLUGIN_PKG="$(node -e "try{process.stdout.write(require('$SWITCH/package.json').name||'')}catch(e){}" 2>/dev/null)"
echo "plugin package name = '${PLUGIN_PKG}'"
echo

# ---------- 指纹工具 ----------
# 目录指纹（路径 + 摘要，排序稳定）：<=256KB 小文件走 sha256 内容摘要；
# 更大的文件（node/pnpm 等巨物）走 size+mtime，避免全量哈希拖慢（本冒烟约 260s -> 数秒）。
# 仍能证伪「测试动过用户真实数据」：新增/删除/改名/改内容/改大小/改 mtime 全部会被捕获。
fp_dir(){
  local d="$1"
  if [ -d "$d" ]; then
    ( cd "$d" && {
        find . -type f -size -262144c -exec shasum -a 256 {} + 2>/dev/null
        find . -type f -size +262143c -exec stat -f '%N %z %m' {} + 2>/dev/null
      } | LC_ALL=C sort )
  else
    echo "__ABSENT__"
  fi
}

# Helm：JSON 取值。用法: jsonq <file> <js-expr>，expr 里用 $ 表示解析出的对象
jsonq(){
  node -e "
    const fs=require('fs');
    let j=null;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); }catch(e){ process.stdout.write(''); process.exit(0); }
    const \$=j;
    try{ const v=eval(process.argv[2]); process.stdout.write(v===undefined||v===null?'':String(v)); }catch(e){ process.stdout.write(''); }
  " "$1" "$2" 2>/dev/null
}

# ---------- 0) 真实 ~/.dsh 指纹（前） ----------
REAL_BEFORE="$(fp_dir "$REAL_DSH")"
echo "--- real ~/.dsh fingerprint (before) ---"
if [ -d "$REAL_DSH" ]; then echo "$REAL_BEFORE" | head -20; else echo "(~/.dsh absent)"; fi
echo

# ---------- 1) 建/刷新一次性 profile ----------
echo "--- [1] create/refresh one-shot profile '$PROFILE_NAME' ---"
node "$CLI" testh --from-default-profile headless --dump-config >/dev/null 2>&1
RC_PROFILE=$?
echo "create-profile exit=$RC_PROFILE"
if [ ! -d "$PROFILE_DIR" ]; then
  echo "FATAL: profile dir not created: $PROFILE_DIR"
  exit 2
fi
ls -1 "$PROFILE_DIR" 2>/dev/null | sed 's/^/  profile: /'
echo

# ---------- 2) 一次性 profile 指纹（前） ----------
PROF_BEFORE="$(fp_dir "$PROFILE_DIR")"
echo "--- profile fingerprint (before) ---"
echo "$PROF_BEFORE" | sed 's/^/  /'
echo

# ---------- 3) 跑真 DSH（--patch 注入外挂） ----------
echo "--- [2] run real DSH with --patch injection ---"
rm -f "$EVIDENCE"
: > "$LOG"
set +e
node "$CLI" testh --patch "$PATCH" "probe: reply PI_OK" >"$LOG" 2>&1
RC_RUN=$?
set -e 2>/dev/null || true
echo "real-DSH exit=$RC_RUN (non-zero allowed: app may exit without a model)"
echo "log tail:"; tail -n 15 "$LOG" 2>/dev/null | sed 's/^/  | /'
echo

# ---------- 4) 指纹（后） ----------
PROF_AFTER="$(fp_dir "$PROFILE_DIR")"
REAL_AFTER="$(fp_dir "$REAL_DSH")"
echo

# ---------- 5) 读证据 JSON ----------
echo "--- [3] evidence JSON ---"
if [ -f "$EVIDENCE" ]; then
  echo "evidence: $EVIDENCE"
  node -e "const j=require('$EVIDENCE'); console.log(JSON.stringify(j,null,2));" 2>/dev/null | sed 's/^/  /'
else
  echo "evidence: NOT WRITTEN ($EVIDENCE)"
  echo "  -> plugin likely not loaded; log tail:"
  tail -n 25 "$LOG" 2>/dev/null | sed 's/^/  | /'
fi
echo

# ---------- 6) 断言 ----------
echo "=== ASSERTIONS ==="

# A. TAKEOVER_REAL
JT="$(jsonq "$EVIDENCE" '$ && $.nativeTargetIsAgentLoop')"
JC="$(jsonq "$EVIDENCE" '$ && $.nativeTargetEqualsCtxAgentLoop')"
if [ "$JT" = "true" ] && [ "$JC" = "true" ]; then
  hit "TAKEOVER_REAL  (nativeTargetIsAgentLoop=true, nativeTargetEqualsCtxAgentLoop=true)"
else
  miss "TAKEOVER_REAL  (nativeTargetIsAgentLoop='$JT', nativeTargetEqualsCtxAgentLoop='$JC')"
fi

# B. DELEGATION
JD="$(jsonq "$EVIDENCE" '$ && $.delegationsToNative')"
if [ -n "$JD" ] && [ "$JD" -ge 1 ] 2>/dev/null; then
  hit "DELEGATION  (delegationsToNative=$JD >= 1)"
else
  miss "DELEGATION  (delegationsToNative='$JD')"
fi

# C. PROFILE_UNTOUCHED
if [ "$PROF_BEFORE" = "$PROF_AFTER" ]; then
  hit "PROFILE_UNTOUCHED  (profile fingerprint identical before/after)"
else
  miss "PROFILE_UNTOUCHED  (profile changed)"
  diff <(echo "$PROF_BEFORE") <(echo "$PROF_AFTER") | sed 's/^/  /' || true
fi

# D. HOMEDIR_UNTOUCHED
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  hit "HOMEDIR_UNTOUCHED  (real ~/.dsh fingerprint identical before/after)"
else
  miss "HOMEDIR_UNTOUCHED  (real ~/.dsh changed)"
  diff <(echo "$REAL_BEFORE") <(echo "$REAL_AFTER") | sed 's/^/  /' || true
fi

# E. NO_BUNDLE_INSTALL
NOBUNDLE=1
if [ -f "$PROFILE_DIR/package.json" ]; then
  if [ -n "$PLUGIN_PKG" ]; then
    if node -e "
      const p=require('$PROFILE_DIR/package.json');
      const d=Object.assign({},p.dependencies||{},p.devDependencies||{},p.optionalDependencies||{});
      process.exit(Object.prototype.hasOwnProperty.call(d,process.argv[1])?0:1);
    " "$PLUGIN_PKG" 2>/dev/null; then
      NOBUNDLE=0
    fi
  fi
fi
if [ "$NOBUNDLE" = "1" ]; then
  hit "NO_BUNDLE_INSTALL  (profile deps do NOT contain '$PLUGIN_PKG')"
else
  miss "NO_BUNDLE_INSTALL  (profile deps contain '$PLUGIN_PKG')"
fi

echo
echo "SUMMARY: $HIT HIT / $MISS MISS"
echo "note: engine text reaching a real session/UI is OUT OF SCOPE for this smoke."
# 退出码语义：MISS > 0 => 非 0 退出；仅当全部 HIT（MISS == 0）才退 0。
if [ "$MISS" -gt 0 ]; then
  echo "RESULT: FAIL ($MISS MISS) - exiting non-zero"
  exit 1
fi
echo "RESULT: PASS (all $HIT assertions HIT)"
exit 0
