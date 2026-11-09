#!/usr/bin/env bash
# endo-pi.sh — 真机「最后一跳」：让 pi 在真实 DSH 里承担**主会话引擎**（forceEngine: 'pi'）。
#
# 结构逐字对齐已跑通 5/5 的 endo.sh：
#   指纹对比(~/.dsh、profile) + 建一次性 profile + 真 DSH + --patch 注入 + 读证据 JSON + 断言 + 退出码语义。
#
# 断言（3 条本轮新增 + 1 条负向防误杀 + 3 条隔离不回归）：
#   PI_FORCED / PI_ENGINE_IN_REAL_DSH / PI_TEXT_IN_REAL_DSH
#   NEG_NOT_ECHO_NOT_DOUBLE
#   PROFILE_UNTOUCHED / HOMEDIR_UNTOUCHED / NO_BUNDLE_INSTALL
#
# 用法（可复跑）：bash endo-pi.sh
# 退出码：MISS > 0 → 非 0；全部 HIT（MISS == 0）→ 0。
#
# HOMEDIR_UNTOUCHED 的诚实归因（本轮加固）：
#   真实 ~/.dsh 由**常驻的 DeepSeek Harness 桌面端**持续重写
#   （storages/session_projcache/sessions/*.json 每秒级抖动），因此「前后指纹相同」
#   这一朴素判据会假阳性失败。本脚本先采一段**对照样本**（不跑插件的时间窗）得到
#   「环境自身漂移路径集合」，再把运行窗内的变化减去该集合；只有当运行窗引入了
#   环境漂移之外的**新变化路径**时才判 CHANGED —— 既不被环境噪声骗过，也不会漏杀
#   真实污染（防误杀反向用例见 force-engine.test.mjs 的 FINGERPRINT_ATTRIBUTION 组）。
set -uo pipefail

# 推导根目录：优先使用 DSH_WORKSPACE 环境变量，否则从脚本位置推导
ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
CLI="$ROOT/.recon/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
INJECT_DIR="$ROOT/.recon/dsh-real-inject"
UPSTREAM_AI="$ROOT/.recon/dsh-src/dsh/node_modules/@deepseek-ai"

# ① DSH_HOME 重定向到工作区；真实 ~/.dsh 全程只读指纹，绝不写入
export DSH_HOME="$ROOT/.recon/dsh-test-home"
REAL_DSH="${HOME}/.dsh"
PROFILE_NAME="testh"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

PATCH_TEMPLATE="$SWITCH/real-pi-patch.yml"
PATCH="$INJECT_DIR/real-pi-patch.yml"
PI_AGENT_DIR="${PI_AGENT_DIR:-$SWITCH/.pi-agent}"
PI_CLI_PATH="${PI_CLI_PATH:-$HOME/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js}"
EVIDENCE="$INJECT_DIR/real-pi-evidence.json"
LOG="$INJECT_DIR/endo-pi-run.log"
TASK="${TASK:-reply with exactly: PI_OK}"   # 可被外部覆盖
CONTROL_SECONDS=6                   # 对照样本时间窗（只为度量环境自身漂移）

# ---------- magpie key 传递（不落盘、不打印） ----------
# 工作区内 .pi-agent/models.json 里 magpie.apiKey 被有意写成 `$DSH_PI_SMOKE_MAGPIE_KEY`
# （密钥卫生：配置目录内不放明文），因此必须把该变量交给 DSH 父进程；
# pi 子进程经 RpcClient 的 `{...process.env, ...options.env}` 继承。
# 取值来源与已跑通 17/17 的 pi-probe.mjs 逐字一致（只读宿主配置，不写回、不落盘、不打印）。
KEY_ENV="DSH_PI_SMOKE_MAGPIE_KEY"
if [ -z "${!KEY_ENV:-}" ] && [ -f "$HOME/.pi/agent/models.json" ]; then
  MV="$(node -e "
    const j=require(process.env.HOME+'/.pi/agent/models.json');
    const k=j?.providers?.magpie?.apiKey;
    if (typeof k==='string' && k.length>0 && k[0]!=='$') process.stdout.write(k);
  " 2>/dev/null)"
  if [ -n "$MV" ]; then export DSH_PI_SMOKE_MAGPIE_KEY="$MV"; fi
  unset MV
fi

mkdir -p "$INJECT_DIR"
sed -e "s#\${DSH_INJECT_DIR}#$INJECT_DIR#g" \
    -e "s#\${PI_AGENT_DIR}#$PI_AGENT_DIR#g" \
    -e "s#\${PI_CLI_PATH}#$PI_CLI_PATH#g" \
    -e "s#name: \./index.js#name: $SWITCH/index.js#" \
    "$PATCH_TEMPLATE" > "$PATCH"
TMPD="$(mktemp -d 2>/dev/null || mktemp -d -t endopi)"
cleanup(){ rm -rf "$TMPD"; }
trap cleanup EXIT

HIT=0; MISS=0
hit(){  printf '[HIT]  %s\n' "$1"; HIT=$((HIT+1)); }
miss(){ printf '[MISS] %s\n' "$1"; MISS=$((MISS+1)); }

echo "== endo-pi.sh :: pi as main session engine in REAL DSH =="
echo "ROOT=$ROOT"
echo "DSH_HOME=$DSH_HOME  (real ~/.dsh NOT touched)"
echo "CLI=$CLI"
echo "PATCH=$PATCH"
echo "TASK=\"$TASK\""
echo "magpie key env: $KEY_ENV set=${DSH_PI_SMOKE_MAGPIE_KEY:+yes} (len=${#DSH_PI_SMOKE_MAGPIE_KEY}, value never printed)"
echo

# ---------- 前置检查（缺件则如实失败，不伪造） ----------
[ -f "$CLI" ] || { echo "FATAL: CLI not found: $CLI"; exit 2; }
[ -f "$PATCH" ] || { echo "FATAL: patch not found: $PATCH"; exit 2; }
[ -f "$SWITCH/index.js" ] || { echo "FATAL: plugin entry not found: $SWITCH/index.js"; exit 2; }

# ---------- 运行时依赖解析作用域（可选准备步骤；符号链接，非安装） ----------
if [ -z "${DSH_SWITCH_SKIP_LINK:-}" ]; then
  mkdir -p "$SWITCH/node_modules/@deepseek-ai"
  for _pkg in dsh-agent dsh-llm dsh-scope cordis; do
    if [ -e "$UPSTREAM_AI/$_pkg" ] && [ ! -e "$SWITCH/node_modules/@deepseek-ai/$_pkg" ]; then
      ln -sfn "$UPSTREAM_AI/$_pkg" "$SWITCH/node_modules/@deepseek-ai/$_pkg"
      echo "dep-scope: linked @deepseek-ai/$_pkg -> $UPSTREAM_AI/$_pkg"
    fi
  done
fi

PLUGIN_PKG="$(node -e "try{process.stdout.write(require('$SWITCH/package.json').name||'')}catch(e){}" 2>/dev/null)"
echo "plugin package name = '${PLUGIN_PKG}'"
echo

# ---------- 指纹工具（与 endo.sh 同形） ----------
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

# JSON 取值：jsonq <file> <js-expr>（expr 里用 $ 表示解析出的对象）
jsonq(){
  node -e "
    const fs=require('fs');
    let j=null;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); }catch(e){ process.stdout.write(''); process.exit(0); }
    const \$=j;
    try{ const v=eval(process.argv[2]); process.stdout.write(v===undefined||v===null?'':String(v)); }catch(e){ process.stdout.write(''); }
  " "$1" "$2" 2>/dev/null
}

# 指纹归因：把「运行窗内变化」减去「对照窗内环境自身漂移」，只报真正由本次运行引入的新变化。
# 入参（环境变量）：FP_BASE / FP_CONTROL / FP_AFTER；仅读文件，不写任何东西。
# 输出：首行 "ATTRIBUTABLE <n>  AMBIENT <m>"；其后逐行列出应归因于本次运行的路径（<=10）。
# 退出码：0 = 无本次运行引入的新变化；1 = 存在（证明真被污染）。
fp_attrib(){
  node -e '
    const fs=require("fs");
    const parse=(file)=>{
      const m=new Map();
      if(!file || !fs.existsSync(file)) return m;
      for(const raw of fs.readFileSync(file,"utf8").split("\n")){
        const line=raw.trim(); if(line==="") continue;
        if(line==="__ABSENT__") continue;
        const i=line.indexOf("./");
        if(i<0) continue;
        const path=line.slice(i).trim();
        m.set(path, line.slice(0,i).trim());
      }
      return m;
    };
    const base=parse(process.env.FP_BASE);
    const control=parse(process.env.FP_CONTROL);
    const after=parse(process.env.FP_AFTER);
    const changed=(x,y)=>{ const out=new Set();
      for(const p of new Set([...x.keys(),...y.keys()])) if(x.get(p)!==y.get(p)) out.add(p);
      return out; };
    const ambient=changed(base,control);      // 环境自身漂移（对照窗）
    const run=changed(base,after);            // 运行窗内观察到的全部变化
    const attributable=[...run].filter((p)=>!ambient.has(p)).sort();
    console.log("ATTRIBUTABLE "+attributable.length+"  AMBIENT "+ambient.size);
    if(ambient.size>0){
      console.log("ambient-drift sample (>0 means the env rewrites these on its own):");
      [...ambient].sort().slice(0,5).forEach((p)=>console.log("  ~ "+p));
    }
    if(attributable.length>0){
      console.log("NEW-CHANGE (caused by this run, NOT explained by ambient drift):");
      attributable.slice(0,10).forEach((p)=>console.log("  ! "+p));
    }
    process.exit(attributable.length===0?0:1);
  '
}

# ---------- 0) 真实 ~/.dsh 基线 + 对照样本（环境自身漂移） ----------
echo "--- [0] real ~/.dsh fingerprints: baseline + ${CONTROL_SECONDS}s control sample ---"
if [ -d "$REAL_DSH" ]; then
  fp_dir "$REAL_DSH" > "$TMPD/real-base.txt"
  echo "  baseline captured: $(wc -l < "$TMPD/real-base.txt" | tr -d ' ') entries"
  sleep "$CONTROL_SECONDS"
  fp_dir "$REAL_DSH" > "$TMPD/real-control.txt"
  echo "  control  captured: $(wc -l < "$TMPD/real-control.txt" | tr -d ' ') entries (after ${CONTROL_SECONDS}s idle)"
else
  echo "  (~/.dsh absent)"
  echo "__ABSENT__" > "$TMPD/real-base.txt"
  echo "__ABSENT__" > "$TMPD/real-control.txt"
fi
REAL_BASE_TXT="$(cat "$TMPD/real-base.txt")"
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

# ---------- 3) 跑真 DSH（--patch 注入 + forceEngine:'pi'） ----------
# 参数顺序（已实测确认，照抄）：CLI <profile> --patch <abs-patch> "<task>"
echo "--- [2] run real DSH with --patch injection + forceEngine=pi ---"
rm -f "$EVIDENCE"
: > "$LOG"
set +e
node "$CLI" "$PROFILE_NAME" --patch "$PATCH" "$TASK" >"$LOG" 2>&1
RC_RUN=$?
set -e 2>/dev/null || true
echo "real-DSH exit=$RC_RUN"
echo "log tail:"; tail -n 20 "$LOG" 2>/dev/null | sed 's/^/  | /'
echo

# ---------- 4) 指纹（后） ----------
PROF_AFTER="$(fp_dir "$PROFILE_DIR")"
fp_dir "$REAL_DSH" > "$TMPD/real-after.txt"
echo

# ---------- 5) 读证据 JSON ----------
echo "--- [3] evidence JSON ---"
if [ -f "$EVIDENCE" ]; then
  echo "evidence: $EVIDENCE"
  node -e "console.log(JSON.stringify(require('$EVIDENCE'),null,2));" 2>/dev/null | sed 's/^/  /'
else
  echo "evidence: NOT WRITTEN ($EVIDENCE)"
  echo "  -> plugin likely not loaded; log tail:"
  tail -n 25 "$LOG" 2>/dev/null | sed 's/^/  | /'
fi
echo

# ---------- 6) 断言 ----------
echo "=== ASSERTIONS ==="

# A. PI_FORCED —— 证据 JSON 里 forcedEngine==='pi'
JFE="$(jsonq "$EVIDENCE" '$ && $.forcedEngine')"
JFR="$(jsonq "$EVIDENCE" '$ && $.forcedRoute')"
if [ "$JFE" = "pi" ] && [ "$JFR" = "pi" ]; then
  hit "PI_FORCED  (evidence.forcedEngine='$JFE', forcedRoute='$JFR')"
else
  miss "PI_FORCED  (forcedEngine='$JFE', forcedRoute='$JFR')"
fi

# B. PI_ENGINE_IN_REAL_DSH —— 真实 headless 运行中 piByKind.createAgent >= 1
JPC="$(jsonq "$EVIDENCE" '$ && $.piByKind && $.piByKind.createAgent')"
JDP="$(jsonq "$EVIDENCE" '$ && $.delegationsToPi')"
if [ -n "$JPC" ] && [ "$JPC" -ge 1 ] 2>/dev/null; then
  hit "PI_ENGINE_IN_REAL_DSH  (piByKind.createAgent=$JPC >= 1, delegationsToPi=$JDP, nativeCreate=$(jsonq "$EVIDENCE" '$ && $.nativeByKind && $.nativeByKind.createAgent'))"
else
  miss "PI_ENGINE_IN_REAL_DSH  (piByKind.createAgent='$JPC')"
fi

# C. PI_TEXT_IN_REAL_DSH —— 证据 JSON 记录了 pi 真实产出的 assistant 文本且非空
JTEXT="$(jsonq "$EVIDENCE" '$ && $.piText')"
JTLEN="$(jsonq "$EVIDENCE" '$ && $.piTextLength')"
JTERR="$(jsonq "$EVIDENCE" '$ && $.piEngineError')"
if [ -n "$JTEXT" ] && [ "$JTLEN" -ge 1 ] 2>/dev/null && [ -z "$JTERR" ]; then
  hit "PI_TEXT_IN_REAL_DSH  (piText=\"$JTEXT\", len=$JTLEN, deltas=$(jsonq "$EVIDENCE" '$ && $.piTextDeltas'), pid=$(jsonq "$EVIDENCE" '$ && $.piChildPid'), engineError=null)"
else
  miss "PI_TEXT_IN_REAL_DSH  (piText='$JTEXT', len='$JTLEN', engineError='$JTERR')"
fi


# 打印三个观测性字段（runtime id / provider / effectiveModel）
JRUNTIME="$(jsonq "$EVIDENCE" '$ && $.runtimeId')"
JPROVIDER="$(jsonq "$EVIDENCE" '$ && $.provider')"
JEFFMODEL="$(jsonq "$EVIDENCE" '$ && $.effectiveModel')"
echo "evidence.runtimeId: '$JRUNTIME'"
echo "evidence.provider: '$JPROVIDER'"
echo "evidence.effectiveModel: '$JEFFMODEL'"
echo

# C3. MODEL_PINNED —— effectiveModel 等于钉死值（magpie/auto/deepseek-v4.1-flash 或配置传入的值）
PINNED_MODEL="magpie/auto/deepseek-v4.1-flash"
if [ "$JEFFMODEL" = "$PINNED_MODEL" ]; then
  hit "MODEL_PINNED  (effectiveModel='$JEFFMODEL' matches pinned value '$PINNED_MODEL')"
else
  miss "MODEL_PINNED  (effectiveModel='$JEFFMODEL' != '$PINNED_MODEL')"
fi

# C4. NOT_OLLAMA（负向）—— 输出中不得出现 studio-ollama（防止 OAR 自选本机模型）
if echo "$JEFFMODEL" | grep -q "studio-ollama" 2>/dev/null || \
   echo "$JRUNTIME" | grep -q "studio-ollama" 2>/dev/null || \
   grep -q "studio-ollama" "$LOG" 2>/dev/null; then
  miss "NOT_OLLAMA  (studio-ollama found in output → OAR selected local model, pinning failed)"
else
  hit "NOT_OLLAMA  (studio-ollama NOT found → did not fall back to local ollama model)"
fi

# C2. 负向防误杀：pi 文本不得来自回声引擎替身，且不得同时双路委托给原生
JECHO="$(jsonq "$EVIDENCE" '$ && $.spawnedEchoEngineCalls')"
JNAT="$(jsonq "$EVIDENCE" '$ && $.nativeByKind && $.nativeByKind.createAgent')"
if [ "$JECHO" = "0" ] && [ "$JNAT" = "0" ] && [ "$JTEXT" != "[engine-switch:echo] echo engine handled this call; no model was invoked" ]; then
  hit "NEG_NOT_ECHO_NOT_DOUBLE  (spawnedEchoEngineCalls=0, nativeByKind.createAgent=0 → 文本确由 pi 引擎产出，非回声替身/非双路重复委托)"
else
  miss "NEG_NOT_ECHO_NOT_DOUBLE  (echoCalls='$JECHO', nativeCreate='$JNAT')"
fi

# D. PROFILE_UNTOUCHED
if [ "$PROF_BEFORE" = "$PROF_AFTER" ]; then
  hit "PROFILE_UNTOUCHED  (profile fingerprint identical before/after)"
else
  miss "PROFILE_UNTOUCHED  (profile changed)"
  diff <(echo "$PROF_BEFORE") <(echo "$PROF_AFTER") | sed 's/^/  /' || true
fi

# E. HOMEDIR_UNTOUCHED（带对照样本归因）
FP_BASE="$TMPD/real-base.txt" FP_CONTROL="$TMPD/real-control.txt" FP_AFTER="$TMPD/real-after.txt" \
  fp_attrib > "$TMPD/attrib.txt" 2>&1
RC_ATTRIB=$?
sed 's/^/  /' "$TMPD/attrib.txt"
if [ "$RC_ATTRIB" -eq 0 ]; then
  hit "HOMEDIR_UNTOUCHED  (no change path attributable to this run; ambient drift from the resident DSH desktop app subtracted)"
else
  miss "HOMEDIR_UNTOUCHED  (this run introduced change paths NOT explained by ambient drift)"
fi

# F. NO_BUNDLE_INSTALL
NOBUNDLE=1
if [ -f "$PROFILE_DIR/package.json" ] && [ -n "$PLUGIN_PKG" ]; then
  if node -e "
    const p=require('$PROFILE_DIR/package.json');
    const d=Object.assign({},p.dependencies||{},p.devDependencies||{},p.optionalDependencies||{});
    process.exit(Object.prototype.hasOwnProperty.call(d,process.argv[1])?0:1);
  " "$PLUGIN_PKG" 2>/dev/null; then
    NOBUNDLE=0
  fi
fi
if [ "$NOBUNDLE" = "1" ]; then
  hit "NO_BUNDLE_INSTALL  (profile deps do NOT contain '$PLUGIN_PKG')"
else
  miss "NO_BUNDLE_INSTALL  (profile deps contain '$PLUGIN_PKG')"
fi

# ========== 新增：随机串转发断言（FORWARDED_TEXT + NOT_FALLBACK） ==========
echo
echo "=== RANDOM-TOKEN FORWARDING TEST ==="
TOKEN="FWD-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "generated random token: $TOKEN"
TASK="reply with exactly: $TOKEN"
echo "running real DSH with forwarded task: \"$TASK\""
rm -f "$EVIDENCE"
LOG_FWD="$INJECT_DIR/endo-pi-fwd.log"
: > "$LOG_FWD"
set +e
node "$CLI" "$PROFILE_NAME" --patch "$PATCH" "$TASK" >"$LOG_FWD" 2>&1
RC_FWD=$?
set -e 2>/dev/null || true
echo "real-DSH (forwarding test) exit=$RC_FWD"
echo "log tail:"; tail -n 15 "$LOG_FWD" 2>/dev/null | sed 's/^/  | /'

# 读证据 JSON（转发测试）
if [ -f "$EVIDENCE" ]; then
  JTEXT_FWD="$(jsonq "$EVIDENCE" '$ && $.piText')"
  JCOMMITTED="$(jsonq "$EVIDENCE" '$ && $.committedText')"
  echo "evidence.piText: \"$JTEXT_FWD\""
  echo "evidence.committedText: \"$JCOMMITTED\""
else
  JTEXT_FWD=""
  JCOMMITTED=""
  echo "evidence: NOT WRITTEN"
fi

# G. FORWARDED_TEXT —— 随机串出现在 piText 或 committedText 或 stdout 中
if echo "$JTEXT_FWD" | grep -q "$TOKEN" 2>/dev/null || \
   echo "$JCOMMITTED" | grep -q "$TOKEN" 2>/dev/null || \
   grep -q "$TOKEN" "$LOG_FWD" 2>/dev/null; then
  hit "FORWARDED_TEXT  (random token \"$TOKEN\" found in output → forwarding succeeded)"
else
  miss "FORWARDED_TEXT  (random token \"$TOKEN\" NOT found → forwarding failed or config.prompt was used)"
fi

# H. NOT_FALLBACK —— 输出中不得出现 CONFIG_FALLBACK 哨兵
if echo "$JTEXT_FWD" | grep -q "CONFIG_FALLBACK" 2>/dev/null || \
   echo "$JCOMMITTED" | grep -q "CONFIG_FALLBACK" 2>/dev/null || \
   grep -q "CONFIG_FALLBACK" "$LOG_FWD" 2>/dev/null; then
  miss "NOT_FALLBACK  (CONFIG_FALLBACK found → fell back to config.prompt, forwarding did NOT work)"
else
  hit "NOT_FALLBACK  (CONFIG_FALLBACK NOT found → did not fall back to config.prompt)"
fi

echo
echo "SUMMARY: $HIT HIT / $MISS MISS"
if [ "$MISS" -gt 0 ]; then
  echo "RESULT: FAIL ($MISS MISS) - exiting non-zero"
  exit 1
fi
echo "RESULT: PASS (all $HIT assertions HIT)"
exit 0
