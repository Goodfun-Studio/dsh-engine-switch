#!/usr/bin/env bash
# endo-session.sh — 真机「新建会话」端到端：在真实 DSH **web host** 上用 HTTP RPC
# 复现并验证桌面端的会话创建/首轮交互链路（L7）。
#
# 为什么是 web host 而不是桌面 App：桌面端（DeepSeek Harness.app）的 host 就是同一套
# dsh-web-app + dsh-api-session-controller，只是外面套了 Electron 壳。本脚本用
# `dsh web` 起一个**隔离 DSH_HOME** 的宿主，走与桌面端逐字相同的 RPC 形状
# （POST /api/session/create 等），因此能真机验证：
#
#   RPC_CREATE_OK         session/create 返回 ok（桌面端「新建会话/新建任务」走的就是它）
#   SESSION_ID_REAL       返回的 sessionId 是真实会话身份（无 engine-switch:oar-pi: 前缀）
#                       —— 修复前这里返回 `engine-switch:oar-pi:session-…`，紧接着
#                          workspace/attachSession 报
#                          `session/workspace-attach-failed: session persistence holds no such session`
#   WORKSPACE_ATTACH_OK   workspaceId 路径真的挂载成功（老板看到的报错就出在这一步）
#   AGENT_RESOLVES        session/state 能解析到 live Agent（session/prompt 准入前提）
#   PROMPT_ACCEPTED       session/prompt 被接受（走 agent.followup）
#   FIRST_TURN_TEXT       首轮真实 pi 产出落进 durable 会话日志（session/events 读得到）
#   NO_ERROR_EVIDENCE     插件证据里没有 pi-session/error、piEngineError 为空
#   PI_SESSION_DURABLE    插件证据里该会话 durable=true（有持久化句柄）
#   HOST_CLEAN            收尾杀掉宿主进程，不留孤儿
#
# L8 新增（模型面）：
#   MODEL_CATALOG_PI_GROUP      session/modelCatalog 里有「Pi」模型组（桌面端模型选择器的数据源）
#   MODEL_CATALOG_PI_IDS        组里的模型 id 是 pi 全限定选择子
#   MODEL_SELECT_ACCEPTED       session/selectModel 接受 Pi 组模型
#   MODEL_CATALOG_SOURCE        目录来自 OAR pi runtime
#   MODEL_SYNC_REGISTERED       engine=pi 时 provider 注册在宿主 llm 注册表里
#   MODEL_SELECTION_PASSTHROUGH UI 选的模型真的透传给 pi 并生效（选的是与钉死值不同的模型）
#   MODEL_SOURCE_DURABLE        durable 会话日志里的 assistant source = 所选模型
#   NEG_NATIVE_CATALOG_CLEAN    engine=native 的真机上目录里没有 pi 组（真机负向防误杀）
#   NEG_NATIVE_PROVIDER_ABSENT  证据里 engine=native / registered=false / 从没列过目录
#   NEG_NATIVE_NO_PI_PROCESS    native 宿主日志里没有 pi 会话（零替身、零 pi 子进程）
#
# 否定面（不在这台机器上跑）：Native 引擎的正/负向断言由确定性套件
# session-lifecycle.mjs 的 NEG_NATIVE 组覆盖（无网、无模型、可复跑）。
#
# 用法（可复跑）：bash endo-session.sh
# 退出码：MISS > 0 → 非 0；全部 HIT（MISS == 0）→ 0。
set -uo pipefail

ROOT="${DSH_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
SWITCH="$ROOT/dsh-engine-switch"
CLI="$ROOT/.recon/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
UPSTREAM_AI="$ROOT/.recon/dsh-src/dsh/node_modules/@deepseek-ai"
INJECT_DIR="$ROOT/.recon/dsh-session-inject"
export DSH_HOME="$ROOT/.recon/dsh-session-home"
REAL_DSH="${HOME}/.dsh"
PROFILE_NAME="testweb"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
PATCH_TEMPLATE="$SWITCH/real-pi-web-patch.yml"
PATCH="$INJECT_DIR/web-pi-patch.yml"
PI_AGENT_DIR="${PI_AGENT_DIR:-$SWITCH/.pi-agent}"
PI_CLI_PATH="${PI_CLI_PATH:-$HOME/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js}"
EVIDENCE="$INJECT_DIR/web-session-evidence.json"
LOG="$INJECT_DIR/endo-session-host.log"
PORT="${PORT:-0}"   # 0 = 让宿主自己挑空闲端口（避免与残留进程抢端口）
HOST_PID=""

HIT=0; MISS=0
hit(){  printf '[HIT]  %s\n' "$1"; HIT=$((HIT+1)); }
miss(){ printf '[MISS] %s\n' "$1"; MISS=$((MISS+1)); }

cleanup(){
  if [ -n "$HOST_PID" ] && kill -0 "$HOST_PID" 2>/dev/null; then
    kill "$HOST_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$HOST_PID" 2>/dev/null
  fi
  # 清掉 pi 子进程（若宿主被硬杀，pi 可能还在）
  pkill -f "$INJECT_DIR" 2>/dev/null
}
trap cleanup EXIT

echo "== endo-session.sh :: 真机新建会话 + 首轮交互（真实 DSH web host / 真实 pi）=="
echo "DSH_HOME=$DSH_HOME   (real ~/.dsh 只读指纹，不写)"
echo "PORT=$PORT"
echo

[ -f "$CLI" ] || { echo "FATAL: CLI not found: $CLI"; exit 2; }
[ -f "$PATCH_TEMPLATE" ] || { echo "FATAL: patch template not found: $PATCH_TEMPLATE"; exit 2; }
[ -f "$SWITCH/index.js" ] || { echo "FATAL: plugin entry not found"; exit 2; }

mkdir -p "$INJECT_DIR"
sed -e "s#\${DSH_INJECT_DIR}#$INJECT_DIR#g" \
    -e "s#\${PI_AGENT_DIR}#$PI_AGENT_DIR#g" \
    -e "s#\${PI_CLI_PATH}#$PI_CLI_PATH#g" \
    -e "s#name: \./index.js#name: $SWITCH/index.js#" \
    "$PATCH_TEMPLATE" > "$PATCH"

# ---------- magpie key 传递（不落盘、不打印；与 endo-pi.sh 逐字同源） ----------
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

# ---------- 运行时依赖解析作用域（外挂不在 profiles 树内；只做符号链接，不安装、不联网） ----------
if [ -z "${DSH_SWITCH_SKIP_LINK:-}" ]; then
  mkdir -p "$SWITCH/node_modules/@deepseek-ai"
  for _pkg in dsh-agent dsh-llm dsh-session dsh-scope cordis dsh-agent-loop schemastery; do
    if [ -e "$UPSTREAM_AI/$_pkg" ] && [ ! -e "$SWITCH/node_modules/@deepseek-ai/$_pkg" ]; then
      ln -sfn "$UPSTREAM_AI/$_pkg" "$SWITCH/node_modules/@deepseek-ai/$_pkg"
    fi
  done
fi

# ---------- JSON 取值工具 ----------
jsonq(){
  node -e "
    const fs=require('fs');
    let j=null;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); }catch(e){ process.stdout.write(''); process.exit(0); }
    const \$=j;
    try{ const v=eval(process.argv[2]); process.stdout.write(v===undefined||v===null?'':String(v)); }catch(e){ process.stdout.write(''); }
  " "$1" "$2" 2>/dev/null
}

# ---------- 0) 真实 ~/.dsh 只读指纹（前） ----------
fp_dir(){
  local d="$1"
  if [ -d "$d" ]; then
    ( cd "$d" && find . -type f -size -262144c -exec shasum -a 256 {} + 2>/dev/null | LC_ALL=C sort )
  else
    echo "__ABSENT__"
  fi
}
REAL_BEFORE="$(fp_dir "$REAL_DSH" 2>/dev/null | shasum -a 256)"

# ---------- 1) 一次性 profile ----------
echo "--- [1] create/refresh one-shot profile '$PROFILE_NAME' (from shipped 'web') ---"
node "$CLI" "$PROFILE_NAME" --from-default-profile web --dump-config >/dev/null 2>&1
[ -d "$PROFILE_DIR" ] || { echo "FATAL: profile dir not created: $PROFILE_DIR"; exit 2; }
echo "profile ready: $PROFILE_DIR"
echo

# ---------- 2) 起真实 DSH web host（后台） ----------

# 起宿主 + 换 cookie 的过程在 [2] 与 [8] 各用一次（[8] 模拟桌面端重启）
# $1/$2/$3 可选：patch / log / evidence（缺省用主流程那一份；[8.5] 的原生负向用另一份）
boot_host(){
  local patch="${1:-$PATCH}" log="${2:-$LOG}" evidence="${3:-$EVIDENCE}"
  rm -f "$log" "$evidence"
  : > "$log"
  node "$CLI" "$PROFILE_NAME" --patch "$patch" --port "$PORT" --no-open >>"$log" 2>&1 &
  HOST_PID=$!
  echo "host pid=$HOST_PID log=$log"

  READY=""
  for _ in $(seq 1 120); do
    READY="$(grep -m1 -oE 'http://[0-9.]+:[0-9]+/\?token=[A-Za-z0-9_-]+' "$log" 2>/dev/null || true)"
    [ -n "$READY" ] && break
    kill -0 "$HOST_PID" 2>/dev/null || break
    sleep 0.5
  done
  if [ -z "$READY" ]; then
    echo "FATAL: host did not print a launch URL within 60s. log tail:"
    tail -25 "$log"
    return 1
  fi
  echo "launch url: ${READY%%\?token=*}?token=***"
  TOKEN="${READY##*token=}"
  AUTH_ORIGIN="$(echo "$READY" | sed -E 's#^(http://[0-9.]+:[0-9]+)/.*#\1#')"
  COOKIE_JAR="$INJECT_DIR/endo-session-cookies.txt"
  rm -f "$COOKIE_JAR"
  curl -sS -m 10 -c "$COOKIE_JAR" -o /dev/null "${AUTH_ORIGIN}/?token=${TOKEN}" || true
  COOKIE="$(awk '$6=="dsh-auth-" || $6 ~ /^dsh-auth-/ {print $6"=" $7}' "$COOKIE_JAR" | head -1)"
  [ -n "$COOKIE" ] || { echo "FATAL: 没有拿到 dsh-auth cookie（认证链路没走通）"; tail -5 "$log"; return 1; }
  echo "auth cookie acquired (dsh-auth-…, 值不打印)"
  return 0
}

echo "--- [2] boot real DSH web host (isolated DSH_HOME, --patch injects the plugin) ---"
boot_host || exit 2
echo
# ---------- 3) RPC 调用器（与桌面端逐字同款信封：client-request / payload.args） ----------
rpc(){
  local method="$1" args="$2" rpcid="req-$RANDOM$RANDOM"
  curl -sS -m 120 -X POST "${AUTH_ORIGIN}/api/${method}" \
    -H 'Content-Type: application/json' -H "Cookie: $COOKIE" \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$rpcid\",\"method\":\"$method\",\"payload\":{\"args\":$args}}"
}

# ---------- 4) workspaceId（桌面端新建任务用的就是它） ----------
WS_FILE="$DSH_HOME/storages/workspace.json"
WS_DIR="$INJECT_DIR/workspace"
mkdir -p "$WS_DIR"
WS_ID=""
# 宿主启动后自动初始化默认工作区（可能晚一点落盘），先等一等；拿不到就显式建一个
for _ in $(seq 1 30); do
  WS_ID="$(jsonq "$WS_FILE" '$ && $.global && $.global.defaultWorkspaceId')"
  [ -n "$WS_ID" ] && break
  sleep 0.5
done
if [ -z "$WS_ID" ]; then
  WS_CREATE_RES="$(rpc workspace/create "{\"request\":{\"path\":\"$WS_DIR\"}}")"
  echo "workspace/create → $(echo "$WS_CREATE_RES" | head -c 300)"
  WS_ID="$(echo "$WS_CREATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=j?.result?.value??{};process.stdout.write(String(v.workspaceId??v.id??v.workspace?.workspaceId??v.workspace?.id??''))}catch(e){}})")"
  [ -n "$WS_ID" ] || WS_ID="$(jsonq "$WS_FILE" '$ && $.global && $.global.workspaceIds && $.global.workspaceIds[0]')"
fi
WS_PATH="$(jsonq "$WS_FILE" "\$ && \$.tables && \$.tables.workspaces && \$.tables.workspaces['$WS_ID'] && \$.tables.workspaces['$WS_ID'].path")"
[ -n "$WS_PATH" ] || WS_PATH="$WS_DIR"
echo "workspace: id=$WS_ID path=$WS_PATH"
echo

if [ -z "$WS_ID" ]; then
  echo "FATAL: 拿不到 workspaceId，无法复现桌面端的新建路径"
  exit 2
fi

# ---------- 5) 正向：新建会话 ----------
echo "--- [3] session/create（选择器 engine=pi；桌面端「新建会话/新建任务」的同一个 RPC）---"
CREATE_RES="$(rpc session/create "{\"request\":{\"workspaceId\":\"$WS_ID\"}}")"
echo "session/create → $(echo "$CREATE_RES" | head -c 600)"
echo

CREATE_OK="$(echo "$CREATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
SESSION_ID="$(echo "$CREATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.value?.sessionId??''))}catch(e){}})")"
CREATE_ERR_CODE="$(echo "$CREATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.error?.code??''))}catch(e){}})")"
CREATE_ERR_MSG="$(echo "$CREATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.error?.message??''))}catch(e){}})")"

if [ "$CREATE_OK" = "true" ]; then
  hit "RPC_CREATE_OK  (session/create ok:true, sessionId=$SESSION_ID)"
else
  miss "RPC_CREATE_OK  (session/create ok:false code='$CREATE_ERR_CODE' msg='$CREATE_ERR_MSG')"
fi

case "$SESSION_ID" in
  session-*)
    if echo "$SESSION_ID" | grep -q 'oar-pi'; then
      miss "SESSION_ID_REAL  (返回的会话 id 仍带 pi 前缀: $SESSION_ID)"
    else
      hit "SESSION_ID_REAL  (真实会话身份 '$SESSION_ID'，无 engine-switch:oar-pi: 前缀)"
    fi
    ;;
  *) miss "SESSION_ID_REAL  (sessionId 形状不对: '$SESSION_ID')" ;;
esac

if [ "$CREATE_ERR_CODE" = "session/workspace-attach-failed" ]; then
  miss "WORKSPACE_ATTACH_OK  (工作区挂载仍失败：$CREATE_ERR_MSG)"
elif [ "$CREATE_OK" = "true" ]; then
  hit "WORKSPACE_ATTACH_OK  (workspaceId 路径挂载成功 —— 老板看到的报错就在这一步)"
else
  miss "WORKSPACE_ATTACH_OK  (create 没成功，无法判断 attach: $CREATE_ERR_CODE)"
fi

# 工作区名单里真的记下了这个会话（attachSession 的落库结果）
ATTACHED="$(jsonq "$WS_FILE" "\$ && \$.tables && \$.tables.workspaces && \$.tables.workspaces['$WS_ID'] && \$.tables.workspaces['$WS_ID'].sessionIds && \$.tables.workspaces['$WS_ID'].sessionIds.includes('$SESSION_ID')")"
[ "$ATTACHED" = "true" ] && hit "WORKSPACE_MEMBERSHIP  (workspace.sessionIds 里记下了该会话)" || miss "WORKSPACE_MEMBERSHIP  (workspace.sessionIds 里没有该会话)"

# ---------- 5.5) 正向：模型面（L8）—— 目录跟着 Pi 走 + 选中的模型真的透传 ----------
echo
echo "--- [3.5] session/modelCatalog（真实 host 的模型目录：切到 Pi 后必须有「Pi」模型组）---"
CAT_RES="$(rpc session/modelCatalog '{}')"
CAT_OK="$(echo "$CAT_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
PI_GROUP="$(echo "$CAT_RES" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{
  const j=JSON.parse(s); const groups=j?.result?.value?.groups??[];
  const pi=groups.find(g=>g.id==='pi');
  process.stdout.write(pi?JSON.stringify({name:pi.name,count:pi.models.length,first:pi.models[0]?.id,ids:pi.models.map(m=>m.id)}):'');
}catch(e){}})")"
FAILURES="$(echo "$CAT_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const f=j?.result?.value?.failures??[];process.stdout.write(JSON.stringify(f))}catch(e){process.stdout.write('[]')}})")"
echo "catalog groups: $(echo "$CAT_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(JSON.stringify((j?.result?.value?.groups??[]).map(g=>({id:g.id,n:g.models.length}))))}catch(e){process.stdout.write('?')}})")"
echo "pi group: ${PI_GROUP:-<none>}  failures: $FAILURES"

if [ "$CAT_OK" = "true" ] && [ -n "$PI_GROUP" ]; then
  PIC=$(echo "$PI_GROUP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.count))})")
  PIN="$(echo "$PI_GROUP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.name))})")"
  hit "MODEL_CATALOG_PI_GROUP  (session/modelCatalog 里有「${PIN}」组，${PIC} 个模型；桌面端模型选择器的数据源就是它)"
else
  miss "MODEL_CATALOG_PI_GROUP  (catalog ok=$CAT_OK, pi group='${PI_GROUP:-<none>}')"
fi
# 目录里的模型 id 必须是 pi 的全限定选择子（`provider/modelId`），否则选中了也跑不了
PI_ONE="$(echo "$PI_GROUP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.first??''))}catch(e){}})")"
case "$PI_ONE" in
  */*) hit "MODEL_CATALOG_PI_IDS  (目录里的模型 id 是 pi 全限定选择子，例 '$PI_ONE')" ;;
  *)   miss "MODEL_CATALOG_PI_IDS  (模型 id 形状不对: '$PI_ONE')" ;;
esac
# 选一个刚列出来的模型（不硬编码，避免机器之间模型清单不同导致的假红）
# 刻意避开 config 里钉死的那个模型（`magpie/auto/deepseek-v4.1-flash`）：
# 否则「透传生效」与「回落钉死值」两种情形在证据上无法区分。
PINNED_DEFAULT="magpie/auto/deepseek-v4.1-flash"
export PINNED_DEFAULT   # node -e 里按 process.env.PINNED_DEFAULT 读同一份事实
SEL_ONE="$(echo "$PI_GROUP" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{
  const j=JSON.parse(s); const ids=j.ids??[]; const pinned=process.env.PINNED_DEFAULT;
  const magpie=ids.filter(id=>id.split('/')[0]==='magpie' && id!==pinned);
  process.stdout.write(magpie[0]??ids.find(id=>id!==pinned)??'');
}catch(e){}})")"
echo "selecting model: '$SEL_ONE'"
SEL_RES="$(rpc session/selectModel "{\"request\":{\"sessionId\":\"$SESSION_ID\",\"provider\":\"pi\",\"model\":\"$SEL_ONE\"}}")"
SEL_OK="$(echo "$SEL_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
SEL_ERR="$(echo "$SEL_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.error?.code??''))}catch(e){}})")"
if [ "$SEL_OK" = "true" ]; then
  hit "MODEL_SELECT_ACCEPTED  (session/selectModel 接受 Pi 组模型 '$SEL_ONE' —— requireModel + resolveCallConfig 双闸都过)"
else
  miss "MODEL_SELECT_ACCEPTED  (selectModel 被拒: code='$SEL_ERR' msg=$(echo "$SEL_RES" | head -c 200))"
fi

# 负向防误杀（真机面）单独用**第二次启动**做：本 harness 用 `--patch`（命令行 overlay）
# 注入插件，host 会拒绝对该 entry 的 settings 写入
# （`settings/rejected: Configuration for "…" is overridden by a home patch or command-line overlay`），
# 所以「切回 native」在真机上只能靠一次以 `engine: native` 注入的启动来复现 —— 见 [8.5]。
echo

# ---------- 6) 正向：Agent 解析 + 首轮交互 ----------
echo
echo "--- [4] session/state（解析 live Agent）---"
STATE_RES="$(rpc session/state "{\"request\":{\"sessionId\":\"$SESSION_ID\"}}")"
echo "session/state → $(echo "$STATE_RES" | head -c 400)"
STATE_OK="$(echo "$STATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
STATE_ERR="$(echo "$STATE_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.error?.code??''))}catch(e){}})")"
[ "$STATE_OK" = "true" ] && hit "AGENT_RESOLVES  (session/state ok —— Agent 已注册进 ctx.agents)" || miss "AGENT_RESOLVES  (session/state 失败: $STATE_ERR)"

echo
echo "--- [5] session/prompt（首轮真实 pi 调用）---"
TASK_TEXT="${TASK:-reply with exactly: L7_SESSION_OK}"
PROMPT_RES="$(rpc session/prompt "{\"request\":{\"sessionId\":\"$SESSION_ID\",\"mode\":\"queue\",\"requestId\":\"l7-first-turn\",\"content\":[{\"type\":\"text\",\"text\":\"$TASK_TEXT\"}]}}")"
echo "session/prompt → $(echo "$PROMPT_RES" | head -c 400)"
PROMPT_OK="$(echo "$PROMPT_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
PROMPT_ERR="$(echo "$PROMPT_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.error?.code??''))}catch(e){}})")"
[ "$PROMPT_OK" = "true" ] && hit "PROMPT_ACCEPTED  (session/prompt 被接受，走 agent.followup)" || miss "PROMPT_ACCEPTED  (session/prompt 失败: $PROMPT_ERR)"

# 等 pi 跑完（真实模型调用；最多 90s）。
# 读**落盘**的会话日志（真正的 durable 证据），而不是内存态：这才能证明首轮真的写进了历史。
SESSION_LOG_DIR=""
for _ in $(seq 1 90); do
  SESSION_LOG_DIR="$(find "$DSH_HOME/sessions" -maxdepth 2 -type d -name "$SESSION_ID" 2>/dev/null | head -1)"
  if [ -n "$SESSION_LOG_DIR" ] && [ -f "$SESSION_LOG_DIR/session.v4.jsonl.zstd" ]; then
    if zstdcat "$SESSION_LOG_DIR/session.v4.jsonl.zstd" 2>/dev/null | grep -q '"type":"turn/end"'; then
      break
    fi
  fi
  sleep 1
done

LOG_JSON="$(zstdcat "$SESSION_LOG_DIR/session.v4.jsonl.zstd" 2>/dev/null | head -60)"
LOG_SUMMARY="$(echo "$LOG_JSON" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const types=[]; let user=''; let assistant='';
  for(const l of s.split('\n').filter(Boolean)){
    let j; try{ j=JSON.parse(l) }catch(e){ continue }
    types.push(j.type);
    if(j.type==='user/message') for(const b of (j.data?.content??[])) if(b.type==='text') user+=b.text;
    if(j.type==='assistant/message') for(const b of (j.data?.message?.content??[])) if(b.type==='text') assistant+=b.text;
  }
  process.stdout.write(types.join(',')+'\n'+user.replace(/\n/g,' ')+'\n'+assistant.replace(/\n/g,' '));
})")"
TURN_TYPES="$(echo "$LOG_SUMMARY" | sed -n '1p')"
DURABLE_USER_TEXT="$(echo "$LOG_SUMMARY" | sed -n '2p')"
DURABLE_ASSISTANT_TEXT="$(echo "$LOG_SUMMARY" | sed -n '3p')"
echo "durable log types: $TURN_TYPES"
echo "durable user text: $(echo "$DURABLE_USER_TEXT" | head -c 60)"
echo "durable assistant text: $(echo "$DURABLE_ASSISTANT_TEXT" | head -c 80)"

case "$TURN_TYPES" in
  *turn/start*user/message*step/start*assistant/message*step/end*turn/end*)
    hit "FIRST_TURN_SHAPE  (durable turn 事件齐全有序: turn/start → user/message → step/start → assistant/message → step/end → turn/end)" ;;
  *)
    miss "FIRST_TURN_SHAPE  (会话日志事件形状不对: '$TURN_TYPES')" ;;
esac

if [ "$DURABLE_USER_TEXT" = "$TASK_TEXT" ]; then
  hit "FIRST_TURN_PROMPT_PERSISTED  (用户首句真的进了 durable 历史: '$DURABLE_USER_TEXT')"
else
  miss "FIRST_TURN_PROMPT_PERSISTED  (历史里的用户文本='$DURABLE_USER_TEXT' 期望='$TASK_TEXT')"
fi

if [ -n "$DURABLE_ASSISTANT_TEXT" ]; then
  hit "FIRST_TURN_TEXT  (首轮真实 pi 产出落进 durable 会话日志: \"$(echo "$DURABLE_ASSISTANT_TEXT" | head -c 60)\")"
else
  miss "FIRST_TURN_TEXT  (会话日志里没有 assistant 文本)"
fi

# RPC 面也读一次（前端读历史走的就是 session/events）
EV_RES="$(rpc session/events "{\"request\":{\"address\":{\"kind\":\"session\",\"sessionId\":\"$SESSION_ID\"},\"maxMessages\":40}}")"
EV_OK="$(echo "$EV_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
[ "$EV_OK" = "true" ] && hit "SESSION_EVENTS_RPC_OK  (session/events 可读回历史 —— 前端会话记录的数据源)" || miss "SESSION_EVENTS_RPC_OK  (session/events 失败)"

# ---------- 7) 插件证据（真实运行期落盘） ----------
echo
echo "--- [6] plugin evidence ---"
JERR="$(jsonq "$EVIDENCE" '$ && $.piSessionError')"
JENG="$(jsonq "$EVIDENCE" '$ && $.piEngineError')"
JSESS="$(jsonq "$EVIDENCE" "\$ && \$.piSession && \$.piSession.sessions && \$.piSession.sessions.find(s=>s.sessionId==='$SESSION_ID') && \$.piSession.sessions.find(s=>s.sessionId==='$SESSION_ID').durable")"
JSID="$(jsonq "$EVIDENCE" '$ && $.sessionId')"
JTEXT="$(jsonq "$EVIDENCE" '$ && $.piText')"
echo "evidence.piSessionError='$JERR'  piEngineError='$JENG'  piSession.durable='$JSESS'  evidence.sessionId='$JSID'"
[ -z "$JERR" ] && hit "NO_ERROR_EVIDENCE  (插件证据里没有 pi-session/error)" || miss "NO_ERROR_EVIDENCE  (pi-session/error: $JERR)"
# L8 模型面证据（真机）：目录来源 + 选中的模型真的透传给了 pi
JMSRC="$(jsonq "$EVIDENCE" '$ && $.modelCatalogSource')"
JMSYNC="$(jsonq "$EVIDENCE" '$ && $.modelSync && $.modelSync.registered')"
JMPICK="$(jsonq "$EVIDENCE" '$ && $.modelAttempt && $.modelAttempt.piModel')"
JMSEL="$(jsonq "$EVIDENCE" '$ && $.modelAttempt && $.modelAttempt.modelSource')"
JMEFF="$(jsonq "$EVIDENCE" '$ && $.modelAttempt && $.modelAttempt.effectiveModel')"
echo "evidence.modelCatalogSource='$JMSRC' modelSync.registered='$JMSYNC' modelAttempt.piModel='$JMPICK'"
[ "$JMSRC" = "oar" ] && hit "MODEL_CATALOG_SOURCE  (目录来自 OAR pi runtime —— 与真实会话同一条模型栈)" || miss "MODEL_CATALOG_SOURCE  (modelCatalogSource='$JMSRC')"
[ "$JMSYNC" = "true" ] && hit "MODEL_SYNC_REGISTERED  (engine=pi 时 pi provider 注册在宿主 llm 注册表里)" || miss "MODEL_SYNC_REGISTERED  (modelSync.registered='$JMSYNC')"
if [ "$SEL_ONE" = "$PINNED_DEFAULT" ]; then
  miss "MODEL_SELECTION_PASSTHROUGH  (没挑到与钉死值不同的模型，无法区分「透传」与「回落」)"
elif [ "$JMSEL" = "selection" ] && [ "$JMPICK" = "$SEL_ONE" ] && [ "$JMEFF" = "$SEL_ONE" ]; then
  hit "MODEL_SELECTION_PASSTHROUGH  (UI 选的 '$SEL_ONE' 真的透传并生效: pi=${JMPICK} source=${JMSEL}; 与 config 钉死值 '${PINNED_DEFAULT}' 不同)"
else
  miss "MODEL_SELECTION_PASSTHROUGH  (piModel='$JMPICK' expected='$SEL_ONE'; source='$JMSEL'; effective='$JMEFF')"
fi
# durable assistant/message 的 source 必须与所选模型一致（历史不会说谎）
LOG_SRC="$(zstdcat "$SESSION_LOG_DIR/session.v4.jsonl.zstd" 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let out='';
  for(const l of s.split('\n').filter(Boolean)){ try{ const j=JSON.parse(l);
    if(j.type==='assistant/message'){ const src=j.data?.message?.source; if(src) out=String(src.provider)+'/'+String(src.model); }
  }catch(e){} }
  process.stdout.write(out);})")"
echo "durable assistant source: '$LOG_SRC'  (selected '$SEL_ONE')"
[ "$LOG_SRC" = "$SEL_ONE" ] \
  && hit "MODEL_SOURCE_DURABLE  (durable 会话日志里的 assistant source = 所选模型 '$SEL_ONE')" \
  || miss "MODEL_SOURCE_DURABLE  (durable source='$LOG_SRC' expected='$SEL_ONE')"
[ "$JSESS" = "true" ] && hit "PI_SESSION_DURABLE  (该会话 durable=true —— 有持久化句柄)" || miss "PI_SESSION_DURABLE  (durable='$JSESS')"
[ "$JSID" = "$SESSION_ID" ] && hit "EVIDENCE_SESSION_ID  (证据里的 sessionId 与 RPC 返回一致)" || miss "EVIDENCE_SESSION_ID  (证据 sessionId='$JSID' vs rpc='$SESSION_ID')"

# ---------- 8) 重启宿主后：旧会话还能打开并接着聊（桌面端重启后的第二条路径） ----------
echo
echo "--- [8] restart host, then re-prompt the SAME session (cold resume) ---"
kill "$HOST_PID" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 0.5; done
kill -9 "$HOST_PID" 2>/dev/null
HOST_PID=""
sleep 1

PORT=0
boot_host || exit 2

TASK2_TEXT="${TASK2:-reply with exactly: L7_RESUME_OK}"
RESUME_RES="$(rpc session/prompt "{\"request\":{\"sessionId\":\"$SESSION_ID\",\"mode\":\"queue\",\"requestId\":\"l7-second-turn\",\"content\":[{\"type\":\"text\",\"text\":\"$TASK2_TEXT\"}]}}")"
echo "session/prompt (after restart) → $(echo "$RESUME_RES" | head -c 400)"
RESUME_OK="$(echo "$RESUME_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
RESUME_ERR="$(echo "$RESUME_RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.error?.code??'')+':'+String(j?.result?.error?.message??''))}catch(e){}})")"
if [ "$RESUME_OK" = "true" ]; then
  hit "RESUME_AFTER_RESTART  (重启后旧会话仍可续聊：session/prompt ok —— 走的是 pi 的 resume 冷开路径)"
else
  miss "RESUME_AFTER_RESTART  (重启后 session/prompt 失败: $RESUME_ERR)"
fi

# 等第二轮落盘（真实模型调用；最多 90s）
for _ in $(seq 1 90); do
  if zstdcat "$SESSION_LOG_DIR/session.v4.jsonl.zstd" 2>/dev/null | grep -q '"turn":2'; then
    break
  fi
  sleep 1
done
LOG_JSON2="$(zstdcat "$SESSION_LOG_DIR/session.v4.jsonl.zstd" 2>/dev/null | head -80)"
TURNS2="$(echo "$LOG_JSON2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let n=0;for(const l of s.split('\n').filter(Boolean)){try{const j=JSON.parse(l);if(j.type==='turn/start')n++}catch(e){}}process.stdout.write(String(n))})")"
HISTORY_KEPT="$(echo "$LOG_JSON2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let t='';for(const l of s.split('\n').filter(Boolean)){try{const j=JSON.parse(l);if(j.type==='user/message')for(const b of (j.data?.content??[]))if(b.type==='text')t+=b.text}catch(e){}}process.stdout.write(t.includes('L7_SESSION_OK')?'kept':'lost')})")"
echo "durable turns after restart: $TURNS2   first-turn history: $HISTORY_KEPT"
[ "$TURNS2" = "2" ] && hit "SECOND_TURN_DURABLE  (重启后第二轮也写进了 durable 历史，turn 号续到 2)" || miss "SECOND_TURN_DURABLE  (历史里 turn 数=$TURNS2)"
[ "$HISTORY_KEPT" = "kept" ] && hit "HISTORY_PRESERVED   (冷开复原了第一轮历史，没有被截断)" || miss "HISTORY_PRESERVED   (第一轮历史丢了)"

# ---------- 8.5) 真机负向防误杀：以 engine=native 注入再起一次，模型目录里不得有 pi 组 ----------
echo
echo "--- [8.5] negative guard: boot again with engine=native (real host) ---"
kill "$HOST_PID" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 0.5; done
kill -9 "$HOST_PID" 2>/dev/null
HOST_PID=""
sleep 1

# 从主 patch 派生出原生那一份（同一形状，只有 engine 取值 / entry id / 证据路径不同）：
# patch 文件里放绝对路径是本 harness 的既有做法（见 real-pi-web-patch.yml 的说明）。
NATIVE_PATCH="$INJECT_DIR/web-native-patch.yml"
NATIVE_EVIDENCE="$INJECT_DIR/web-native-evidence.json"
# `insert.name` 的相对路径是**相对补丁文件目录**解析的（见 real-pi-web-patch.yml 的说明），
# 而这份派生 patch 落在 $INJECT_DIR 而不是插件目录 —— 所以这里必须写成插件目录的绝对路径。
sed -e 's/^\( *\)engine: pi$/\1engine: native/' \
    -e 's#web-session-evidence.json#web-native-evidence.json#' \
    -e 's/id: engine-switch-web-pi/id: engine-switch-web-native/' \
    -e "s#name: \./index.js#name: $SWITCH/index.js#" \
    "$PATCH" > "$NATIVE_PATCH"
echo "native patch: $NATIVE_PATCH  (engine: $(grep -m1 -oE 'engine: (pi|native|echo)' "$NATIVE_PATCH"))"

PORT=0
boot_host "$NATIVE_PATCH" "$INJECT_DIR/endo-session-native-host.log" "$NATIVE_EVIDENCE" || exit 2

NAT_CAT="$(rpc session/modelCatalog '{}')"
NAT_OK="$(echo "$NAT_CAT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.result?.ok===true))}catch(e){process.stdout.write('false')}})")"
NAT_GROUPS="$(echo "$NAT_CAT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(JSON.stringify((j?.result?.value?.groups??[]).map(g=>g.id)))}catch(e){process.stdout.write('?')}})")"
NAT_HAS_PI="$(echo "$NAT_CAT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String((j?.result?.value?.groups??[]).some(g=>g.id==='pi')))}catch(e){process.stdout.write('?')}})")"
echo "native catalog ok=$NAT_OK groups=$NAT_GROUPS"
if [ "$NAT_OK" = "true" ] && [ "$NAT_HAS_PI" = "false" ]; then
  hit "NEG_NATIVE_CATALOG_CLEAN  (engine=native 的真机上目录里没有 pi 组 —— 模型选择器不展示 Pi 模型，原生模型组原样)"
else
  miss "NEG_NATIVE_CATALOG_CLEAN  (native 目录里仍有 pi 组: ok=$NAT_OK has_pi=$NAT_HAS_PI groups=$NAT_GROUPS)"
fi
NAT_MSYNC_ENG="$(jsonq "$NATIVE_EVIDENCE" '$ && $.modelSync && $.modelSync.engine')"
NAT_MSYNC_REG="$(jsonq "$NATIVE_EVIDENCE" '$ && $.modelSync && $.modelSync.registered')"
NAT_MCAT="$(jsonq "$NATIVE_EVIDENCE" '$ && $.modelCatalogSource')"
echo "native evidence: modelSync.engine='$NAT_MSYNC_ENG' registered='$NAT_MSYNC_REG' modelCatalogSource='$NAT_MCAT'"
if [ "$NAT_MSYNC_ENG" = "native" ] && [ "$NAT_MSYNC_REG" = "false" ] && [ -z "$NAT_MCAT" ]; then
  hit "NEG_NATIVE_PROVIDER_ABSENT  (证据里 engine=native / registered=false / 目录从没列过 —— 不是「列了不用」)"
else
  miss "NEG_NATIVE_PROVIDER_ABSENT  (engine='$NAT_MSYNC_ENG' registered='$NAT_MSYNC_REG' catalogSource='$NAT_MCAT')"
fi
NAT_PI_CALLS="$(grep -c 'piSession' "$INJECT_DIR/endo-session-native-host.log" 2>/dev/null || true)"
[ "$NAT_PI_CALLS" = "0" ] \
  && hit "NEG_NATIVE_NO_PI_PROCESS  (native 宿主日志里没有 pi 会话 —— 零替身、零 pi 子进程)" \
  || miss "NEG_NATIVE_NO_PI_PROCESS  (native 宿主日志里出现 piSession $NAT_PI_CALLS 次)"
kill "$HOST_PID" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 0.5; done
kill -9 "$HOST_PID" 2>/dev/null
HOST_PID=""
sleep 1

# ---------- 9) 收尾：宿主干净退出 + 真实 ~/.dsh 未被写 ----------
echo
echo "--- [9] teardown ---"
kill "$HOST_PID" 2>/dev/null
sleep 2
if kill -0 "$HOST_PID" 2>/dev/null; then
  miss "HOST_CLEAN  (宿主进程未在 2s 内退出)"
else
  hit "HOST_CLEAN  (宿主进程已退出)"
  HOST_PID=""
fi

REAL_AFTER="$(fp_dir "$REAL_DSH" 2>/dev/null | shasum -a 256)"
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  hit "REAL_HOMEDIR_UNTOUCHED  (真实 ~/.dsh 指纹前后一致)"
else
  miss "REAL_HOMEDIR_UNTOUCHED  (真实 ~/.dsh 指纹变了 —— 本测试只应写隔离 DSH_HOME)"
fi

echo
echo "SUMMARY: $HIT HIT / $MISS MISS"
if [ "$MISS" -eq 0 ]; then
  echo "RESULT: PASS (real host new-session + first turn)"
  exit 0
fi
echo "RESULT: FAIL"
exit 1
