// pi-probe.mjs 头部参数化（只改路径定义部分）
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = join(ROOT, 'dsh-engine-switch')
const AGENT_ENTRY = `${NM}/dsh-agent/lib/index.js`
const CORDIS_ENTRY = `${NM}/cordis/lib/index.js`
const imp = (p) => import(pathToFileURL(p).href)

// pi-engine.mjs 内部以裸标识符 import '@deepseek-ai/dsh-agent'（上游包真实依赖关系）。
// 工作区无 node_modules，故用 Node 官方同步解析钩子把它指到 .recon 里的真实包；
// 这保证「pi-engine 里 import 到的 agentEvents」与「本探针 import 到的」是同一模块实例。
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@deepseek-ai/dsh-agent') {
      return { url: pathToFileURL(AGENT_ENTRY).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

// ---------------------------------------------------------------------------
// 真实 pi 包 / 配置目录常量（与已验证的探针逐字一致）
// ---------------------------------------------------------------------------
const PI_PKG_DIR =
  '/Users/ivywu/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent'
const AGENT_DIR = `${WS}/.pi-agent`
const KEY_VAR = 'DSH_PI_SMOKE_MAGPIE_KEY'

// 从宿主配置里取 magpie 的 key（**不打印**），以环境变量形式注入子进程。
if (!process.env[KEY_VAR]) {
  const host = '/Users/ivywu/.pi/agent/models.json'
  if (existsSync(host)) {
    const j = JSON.parse(readFileSync(host, 'utf8'))
    const k = j?.providers?.magpie?.apiKey
    if (typeof k === 'string' && k.length > 0) process.env[KEY_VAR] = k
  }
}

// ---------------------------------------------------------------------------
// 断言设施
// ---------------------------------------------------------------------------
let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}

// ---------------------------------------------------------------------------
// 真实组合：真实 cordis Context + 真实监听器 + pi-engine 的映射器
// ---------------------------------------------------------------------------
const { Context } = await imp(CORDIS_ENTRY)
const upstreamAgent = await imp(AGENT_ENTRY)
const PI = await imp(`${WS}/pi-engine.mjs`)
// 插件 index.js 原样再导出上游真实 agentEvents/emitAgentEvent（与 pi-engine 同模块实例）
const plug = await imp(`${WS}/index.js`)

const ctx = new Context()
/** @type {{agent:any,frame:any}[]} 真实监听器收到的帧（经真实 cordis dispatch） */
const liveFrames = []
const dispose = ctx.on(PI.PI_STREAM_EVENT, ({ agent, frame }) => {
  liveFrames.push({ agent, frame })
})

// 复用 pi-engine.mjs 的映射状态机（不重写映射逻辑）
const subject = PI.createPiSubject({ sessionId: 'pi-probe' })
const mapper = PI.createPiFrameMapper(ctx, subject, { attemptSeq: 1 })

// ---------------------------------------------------------------------------
// 负向防误杀 #1 前置：marker 闸门 + spawn 守卫（未打 marker 严禁起子进程）
// ---------------------------------------------------------------------------
let spawnCount = 0
const spawnGuard = (options) => {
  if (!PI.isPiMarked(options)) return { spawned: false, reason: 'unmarked' }
  spawnCount += 1
  return { spawned: true, reason: 'marked' }
}

// 未打 marker / 近似值 / null / undefined / 大小写近似 → 一律不得放行 spawn
const unmarkedCandidates = [
  null,
  undefined,
  {},
  { engine: 'echo' },
  { meta: { engine: 'echo' } },
  { engine: 'pi-lite' }, // 近似值
  { meta: { engine: 'PI' } }, // 大小写近似
  { meta: { engine: 'pi ' } }, // 带空白近似
]
const unmarkedGuard = unmarkedCandidates.map((o) => spawnGuard(o))
const spawnsBeforeUnmarked = spawnCount
// 已打 marker（精确 'pi'）→ 放行（本次真实 attempt 走这条）
const markedGuardA = spawnGuard({ meta: { engine: 'pi' } })
const markedGuardB = spawnGuard({ engine: 'pi' })

// ---------------------------------------------------------------------------
// 子进程 spawn / RPC ready / 真实模型调用（**逐字复用已验证代码**）
// ---------------------------------------------------------------------------
const mod = await import(pathToFileURL(`${PI_PKG_DIR}/dist/index.js`).href)
const { RpcClient } = mod

const client = new RpcClient({
  cliPath: `${PI_PKG_DIR}/dist/cli.js`,
  provider: 'magpie',
  model: 'auto/deepseek-v4.1-flash',
  args: [
    '--no-session',
    '--no-tools',
    '--no-mcp',
    '--thinking',
    'off',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
  ],
  env: {
    PI_CODING_AGENT_DIR: AGENT_DIR,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  },
})

const piEventTypes = []
const textEnds = []
let unsubscribe = null
let childPid = null
let rpcReady = false
let rpcStateKeys = []
let rpcError = null
let promptError = null
const t0 = Date.now()

try {
  await client.start()
  childPid = client.process?.pid ?? null
  console.log('[probe] RpcClient typeof =', typeof RpcClient)
  console.log('[probe] spawned pid =', childPid)

  // 先订阅再 prompt（rpc.md：订阅必须早于 prompt，否则可能错过极快的完成）。
  unsubscribe = client.onEvent((ev) => {
    piEventTypes.push(ev?.type ?? '(none)')
    if (ev?.type === 'message_update') {
      const a = ev.assistantMessageEvent
      if (a?.type === 'text_end') textEnds.push(a?.content)
      // 把 pi 事件喂给映射器（映射逻辑来自 pi-engine.mjs）
      console.log(
        '[probe] message_update ->',
        a?.type,
        JSON.stringify(a?.delta ?? a ?? {}).slice(0, 120),
      )
    } else {
      console.log('[probe] event ->', ev?.type)
    }
    mapper.onPiEvent(ev)
  })

  // RPC 就绪探测：get_state 成功返回即证明协议通道双向可用。
  try {
    const st = await client.getState()
    rpcReady = true
    rpcStateKeys = st && typeof st === 'object' ? Object.keys(st).sort() : []
    console.log('[probe] getState keys =', rpcStateKeys.join(','))
  } catch (e) {
    rpcError = e instanceof Error ? e.message : String(e)
    console.log('[probe] getState ERROR:', rpcError)
  }

  await client.promptAndWait(
    PI.PI_PROMPT,
    undefined,
    60000,
  )
  console.log('[probe] promptAndWait returned')
} catch (e) {
  promptError = e instanceof Error ? e.message : String(e)
  console.log('[probe] ERROR:', promptError)
} finally {
  try {
    if (typeof unsubscribe === 'function') unsubscribe()
    await client.stop()
  } catch (e) {
    console.log('[probe] stop ERROR:', e instanceof Error ? e.message : String(e))
  }
  mapper.finish()
}

const elapsedMs = Date.now() - t0
console.log('[probe] elapsedMs =', elapsedMs)
console.log('[probe] pi event type sequence =', JSON.stringify(piEventTypes))
console.log('[probe] text_end contents =', JSON.stringify(textEnds))

// ---------------------------------------------------------------------------
// 断言 1：PI_SPAWN —— 子进程起得来且 RPC ready（打印 pid）
// ---------------------------------------------------------------------------
check(
  'PI_SPAWN',
  'RpcClient 由官方包 dist/index.js 导出且为 function（非手写 stdio 冒充）',
  typeof RpcClient === 'function',
)
check(
  'PI_SPAWN',
  'pi RPC 子进程确实起来了（spawned pid 为有效正整数）',
  Number.isSafeInteger(childPid) && childPid > 0,
)
check(
  'PI_SPAWN',
  'RPC 通道就绪：get_state 双向可用（rpcReady===true，返回结构含 sessionId）',
  rpcReady === true && rpcStateKeys.includes('sessionId'),
)

// ---------------------------------------------------------------------------
// 断言 2：PI_TEXT —— 收到 ≥1 个 text delta 且拼接文本含 PI_OK
// ---------------------------------------------------------------------------
check(
  'PI_TEXT',
  '收到 ≥1 个 text_delta 分片（mapper.textDeltas >= 1）',
  mapper.textDeltas >= 1,
)
check(
  'PI_TEXT',
  'pi 分片拼接文本含 PI_OK，且与 pi 侧 text_end.content 一致（非本地伪造）',
  mapper.text.includes(PI.PI_OK_MARKER) && textEnds.includes(PI.PI_OK_MARKER),
)

// ---------------------------------------------------------------------------
// 断言 3：PI_BRIDGE —— 三类 DSH 帧确有产生且帧内文本含 PI_OK
// ---------------------------------------------------------------------------
const got = liveFrames.filter((e) => e.frame?.attemptId === mapper.attemptId)
const kinds = got.map((e) => e.frame.type)
const starts = got.filter((e) => e.frame.type === 'start')
const chunks = got.filter((e) => e.frame.type === 'chunk')
const ends = got.filter((e) => e.frame.type === 'end')
const endFrame = ends[0]

check(
  'PI_BRIDGE',
  '发射设施是上游真货：插件再导出的 agentEvents/emitAgentEvent === @deepseek-ai/dsh-agent 本体（=== 身份相等，排除自造总线），且事件名是真 DSH 词汇 agent/assistant-stream',
  plug.agentEvents === upstreamAgent.agentEvents &&
    plug.emitAgentEvent === upstreamAgent.emitAgentEvent &&
    typeof upstreamAgent.agentEvents === 'function' &&
    typeof upstreamAgent.emitAgentEvent === 'function' &&
    PI.PI_STREAM_EVENT === 'agent/assistant-stream',
)
check(
  'PI_BRIDGE',
  '第 1 类帧 start：真实监听器收到 start 帧，且携带 DSH 词汇字段 attemptId/revision/turn/step，payload.agent 为 exact subject（身份相等）',
  starts.length === 1 &&
    kinds[0] === 'start' &&
    typeof starts[0].frame.attemptId === 'string' &&
    Number.isSafeInteger(starts[0].frame.revision) &&
    Number.isSafeInteger(starts[0].frame.turn) &&
    Number.isSafeInteger(starts[0].frame.step) &&
    starts[0].agent === subject,
)
check(
  'PI_BRIDGE',
  '第 2 类帧 chunk：≥1 个分片，frame.index 从 0 稠密递增，chunk.type==="text-delta"',
  chunks.length >= 1 &&
    chunks.every(
      (e, i) =>
        e.frame.index === i &&
        e.frame.chunk?.type === 'text-delta' &&
        typeof e.frame.chunk?.text === 'string' &&
        Number.isSafeInteger(e.frame.time),
    ),
)
check(
  'PI_BRIDGE',
  '第 3 类帧 end：存在且 end.index === 下一个分片位置（=== 已发布分片数）',
  endFrame !== undefined && endFrame.frame.index === chunks.length && endFrame.frame.index > 0,
)
check(
  'PI_BRIDGE',
  '帧内文本含 PI_OK：所有 text-delta 拼接 === mapper.text，且含 PI_OK；帧序为 start→chunk*→end',
  chunks.map((e) => e.frame.chunk.text).join('') === mapper.text &&
    mapper.text.includes(PI.PI_OK_MARKER) &&
    kinds.join(',') === `start,${Array(chunks.length).fill('chunk').join(',')},end`,
)
check(
  'PI_BRIDGE',
  'revision 严格递增；end 帧 outcome 如实为 abandoned（pi 侧未提交 durable DSH attempt，不伪称 committed）',
  got.every((e, i) => i === 0 || e.frame.revision > got[i - 1].frame.revision) &&
    endFrame?.frame.outcome?.kind === 'abandoned',
)
check(
  'PI_BRIDGE',
  '真实设施双向可用：用上游真货 emitAgentEvent 单发一帧，被同一真实监听器（ctx.on）原样收到（证明发射与订阅同在真实设施上，非自造总线）',
  (() => {
    const ctrl = PI.createPiSubject({ sessionId: 'pi-probe-ctrl' })
    const before = liveFrames.length
    upstreamAgent.emitAgentEvent(ctx, ctrl, PI.PI_STREAM_EVENT, {
      frame: { type: 'start', attemptId: 'ctrl', revision: 1, turn: 0, step: 0 },
    })
    const gotCtrl = liveFrames.slice(before)
    return (
      gotCtrl.length === 1 &&
      gotCtrl[0].agent === ctrl &&
      gotCtrl[0].frame?.attemptId === 'ctrl'
    )
  })(),
)

// ---------------------------------------------------------------------------
// 负向防误杀 #1：NEG_MARKER_GATE
// ---------------------------------------------------------------------------
check(
  'NEG_MARKER_GATE',
  '未打 marker / 近似值 / 大小写近似 / null / undefined 时 isPiMarked 一律 false，且 spawn 守卫一律不放行（子进程零新增）',
  unmarkedGuard.every((g) => g.spawned === false && g.reason === 'unmarked') &&
    spawnsBeforeUnmarked === 0 &&
    unmarkedCandidates.every((o) => PI.isPiMarked(o) === false),
)
check(
  'NEG_MARKER_GATE',
  '仅精确 marker "pi" 放行：两次带 marker 检查均放行，累计 spawn 计数 === 2（其中 1 次为本次真实 attempt）',
  markedGuardA.spawned === true &&
    markedGuardB.spawned === true &&
    PI.isPiMarked({ meta: { engine: 'pi' } }) === true &&
    PI.isPiMarked({ engine: 'pi' }) === true &&
    spawnCount === 2,
)

// ---------------------------------------------------------------------------
// 负向防误杀 #2：NEG_NON_TEXT_NO_FRAME —— 非文本/未知 pi 事件不得产帧
// ---------------------------------------------------------------------------
const negSubject = PI.createPiSubject({ sessionId: 'pi-probe-neg' })
const negMapper = PI.createPiFrameMapper(ctx, negSubject, { attemptSeq: 99 })
const negFramesBefore = liveFrames.length
negMapper.onPiEvent({ type: 'message_start' })
negMapper.onPiEvent({ type: 'message_end' })
negMapper.onPiEvent({ type: 'tool_execution_start', toolName: 'noop' })
negMapper.onPiEvent({ type: 'unknown_type_xyz' })
negMapper.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } })
negMapper.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'X' } })
const negProduced = liveFrames.length - negFramesBefore
check(
  'NEG_NON_TEXT_NO_FRAME',
  '非 text_delta 的 pi 事件（message_start/end、未知类型、text_start/text_end）一律不产生任何 DSH 帧，也不误计 text delta',
  negProduced === 0 && negMapper.frames.length === 0 && negMapper.textDeltas === 0,
)
check(
  'NEG_NON_TEXT_NO_FRAME',
  '仅真 text_delta 才产帧：人工喂一条 text_delta 后恰好产生 start+1 chunk（证明判据是 delta 本身，非事件到达）',
  (() => {
    const before = liveFrames.length
    negMapper.onPiEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Z' },
    })
    const added = liveFrames.slice(before).map((e) => e.frame.type)
    return added.join(',') === 'start,chunk' && negMapper.textDeltas === 1 && negMapper.text === 'Z'
  })(),
)

// ---------------------------------------------------------------------------
// 负向防误杀 #3：NEG_NO_RESIDUE —— 探针结束 pi 子进程必须回收（无残留）
// ---------------------------------------------------------------------------
const pidAlive = (() => {
  if (!Number.isSafeInteger(childPid)) return null
  try {
    process.kill(childPid, 0)
    return true
  } catch {
    return false
  }
})()
check(
  'NEG_NO_RESIDUE',
  '探针结束时 pi 子进程已回收：client.process === null，且该 pid 已不可见（无残留子进程）',
  client.process === null && pidAlive === false,
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
dispose()
console.log('')
console.log(`SUMMARY: ${pass} HIT / ${fail} MISS (total ${pass + fail})`)
console.log(
  'ASSERTION_CLASSES: PI_SPAWN, PI_TEXT, PI_BRIDGE, NEG_MARKER_GATE, NEG_NON_TEXT_NO_FRAME, NEG_NO_RESIDUE',
)
console.log(
  `PI_EVIDENCE: childPid=${childPid} rpcReady=${rpcReady} elapsedMs=${elapsedMs} textDeltas=${mapper.textDeltas} text=${JSON.stringify(mapper.text)} frames=${kinds.join('|')}`,
)
console.log(`PI_FRAMES_OBSERVED: ${got.length}`)
if (promptError) console.log(`PI_MODEL_CALL_ERROR: ${promptError}`)
if (fail === 0) {
  console.log('PI_PROBE_RESULT: PASS')
  process.exit(0)
} else {
  console.log('PI_PROBE_RESULT: FAIL')
  process.exit(1)
}
