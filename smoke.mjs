/**
 * smoke.mjs — @local/dsh-engine-switch 冒烟测试（含真实 agent/* 事件桥验证）
 *
 * 组合：
 *   - 真实 @deepseek-ai/cordis 的 Context
 *   - 真实 @deepseek-ai/dsh-agent 的 AgentRegistry（经 ctx.plugin 装载）
 *   - 真实公开 API ctx.agents.setFactory() 注册「原生 target 替身」
 *   - 真实加载被测插件 index.js
 *   - 真实 @deepseek-ai/dsh-agent 的 agentEvents / emitAgentEvent 做**模块实例同一性**交叉校验
 *
 * 替身标注（详见 SMOKE-EVIDENCE.md）：
 *   - sessionProjections：最小测试替身 { register: async () => ({ dispose(){} }) }
 *   - 原生 target：测试替身 { createAgent, resume }，非真实 AgentLoop
 *   - 回声 subject：替身对象（kind:'echo-subject'/**standIn:true**），非真实 Agent
 *     但它承载的 dispatch 与 scope carrier 是上游真实实现
 *   - 未验证项：真实 AgentLoop 接管、真实 Agent/Session 生命周期、pi 适配器（本轮明确不做）
 *
 * 退出码：全部 HIT → 0；任一 MISS → 1。
 */
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 推导路径：优先使用环境变量，否则从 import.meta.url 推导
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = join(ROOT, 'dsh-engine-switch')
const imp = (p) => import(pathToFileURL(p).href)

// 插件内部以裸标识符 import '@deepseek-ai/dsh-agent'（上游包的真实依赖关系）。
// 工作区无 node_modules，故用 Node 官方同步解析钩子把它指到 .recon 里的真实包；
// 这保证「插件 import 到的 agentEvents」与「冒烟脚本 import 到的」是同一个模块实例。
const AGENT_ENTRY = join(NM, 'dsh-agent/lib/index.js')
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@deepseek-ai/dsh-agent') {
      return { url: pathToFileURL(AGENT_ENTRY).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

const { Context } = await imp(join(NM, 'cordis/lib/index.js'))
const upstreamAgent = await imp(AGENT_ENTRY)
const { AgentRegistry } = upstreamAgent
const plug = await imp(join(WS, 'index.js'))

let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ---- 组装最小真实组合 -------------------------------------------------------
const ctx = new Context()
ctx.provide('sessionProjections', { register: async () => ({ dispose() {} }) })
ctx.plugin(AgentRegistry)
await tick(50)

// 真实监听器：直接挂在真实 cordis Context 上，接收经真实事件设施分发的一切 agent/* 事件。
const liveFrames = []
const liveDispose = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  liveFrames.push({ agent, frame })
})
const echoFrames = () => liveFrames.filter((e) => e.agent?.standIn === true)

// 原生 target 替身（记录调用，便于断言「未打 marker → 原样委托」）
const nativeCalls = { createAgent: 0, resume: 0 }
const nativeTarget = {
  createAgent: async (_c, options) => {
    nativeCalls.createAgent++
    return { handledBy: 'native', options }
  },
  resume: async (_c, options) => {
    nativeCalls.resume++
    return { handledBy: 'native', options }
  },
}
ctx.agents.setFactory(nativeTarget) // 真实公开 API

// 加载被测插件（真实施加字段接管）
const fiber = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply })
await tick(80)

const router = ctx.agents.factory?.target
const state = router?.[plug.STATE]

// ---- 1. TAKEOVER -----------------------------------------------------------
check(
  'TAKEOVER',
  'ctx.agents.factory.target 已被替换为插件路由器（真实 AgentRegistry 上的字段接管）',
  router !== undefined &&
    router !== nativeTarget &&
    typeof router.createAgent === 'function' &&
    typeof router.resume === 'function',
)
check('TAKEOVER', '路由器暂存了原生 target（router.nativeTarget === 原生替身）',
  router?.nativeTarget === nativeTarget)
check('TAKEOVER', '插件状态已在路由器上登记（installPromise 已兑现）',
  !!state?.installed)

// ---- 2. NATIVE_REGRESSION：未打 marker 原样委托 -----------------------------
const beforeNative = { ...nativeCalls }
const framesBeforeNative = liveFrames.length
const unmarkedCreate = await ctx.agents.create({ seed: 'no-marker' })
const unmarkedResume = await ctx.agents.resume({ seed: 'no-marker' })
check('NATIVE_REGRESSION', '未打 marker 的 create 走原生 target 且返回原样结果',
  unmarkedCreate?.handledBy === 'native' && nativeCalls.createAgent === beforeNative.createAgent + 1)
check('NATIVE_REGRESSION', '未打 marker 的 resume 走原生 target 且返回原样结果',
  unmarkedResume?.handledBy === 'native' && nativeCalls.resume === beforeNative.resume + 1)
check('NATIVE_REGRESSION', '未打 marker 的调用不产生任何 agent/assistant-stream 事件（原生路径零污染）',
  liveFrames.length === framesBeforeNative && echoFrames().length === 0)

// ---- 3. ECHO_TEXT：带 marker 交给回声引擎，不调模型 -------------------------
const echoBefore = { ...state.echoEngine.stats }
const echoA = await ctx.agents.create({ meta: { engine: 'echo' } })
const echoB = await ctx.agents.resume({ engine: 'echo' })
check('ECHO_TEXT', 'marker 形式 options.meta.engine===\"echo\" 路由到回声引擎并回显固定文本',
  echoA?.engine === 'echo' && echoA?.echo === plug.ECHO_TEXT)
check('ECHO_TEXT', 'marker 形式 options.engine===\"echo\" 路由到回声引擎并回显固定文本',
  echoB?.engine === 'echo' && echoB?.echo === plug.ECHO_TEXT)
check('ECHO_TEXT', '回声引擎计数递增（create=+1, resume=+1），全流程未调用真实模型',
  state.echoEngine.stats.createAgent === echoBefore.createAgent + 1 &&
    state.echoEngine.stats.resume === echoBefore.resume + 1)

// ---- 4. EVENT_BRIDGE：真实事件设施（非自造总线） -----------------------------
check(
  'EVENT_BRIDGE',
  '插件再导出的 agentEvents/emitAgentEvent 与上游 @deepseek-ai/dsh-agent 是同一模块实例（=== 身份相等，排除自造总线冒充）',
  plug.agentEvents === upstreamAgent.agentEvents &&
    plug.emitAgentEvent === upstreamAgent.emitAgentEvent &&
    typeof plug.agentEvents === 'function' &&
    typeof plug.emitAgentEvent === 'function',
)
check(
  'EVENT_BRIDGE',
  '真实监听器（ctx.on）确实收到事件，且 payload.agent 被事件设施注入为 exact subject（身份相等）',
  echoFrames().length > 0 && (() => {
    const first = echoFrames()[0]
    return first.agent === echoA.subject && first.agent?.standIn === true
  })(),
)
check(
  'EVENT_BRIDGE',
  '两路真实设施都被用上：单发 emitAgentEvent 发布 start + retained agentEvents dispatcher 发布 chunk/end',
  // 每个 attempt 的 start 走 emitAgentEvent，其余走 dispatcher；两路都产出帧即证明都在工作。
  echoA.frames.length >= 3 && echoA.framesEmitted === echoA.frames.length,
)

// ---- 5. ECHO_STREAM_FRAMES：三类帧的 DSH 词汇合规性 --------------------------
const attemptA = echoFrames().filter((e) => e.frame.attemptId === echoA.attemptId)
const kinds = attemptA.map((e) => e.frame.type)
const chunksA = attemptA.filter((e) => e.frame.type === 'chunk')
const startA = attemptA.find((e) => e.frame.type === 'start')
const endA = attemptA.find((e) => e.frame.type === 'end')

check(
  'ECHO_STREAM_FRAMES',
  '第 1 类帧 start 存在且携带 DSH 词汇字段 attemptId/revision/turn/step（turn/step 为占位 0）',
  kinds[0] === 'start' &&
    typeof startA?.frame.attemptId === 'string' &&
    Number.isSafeInteger(startA?.frame.revision) &&
    startA?.frame.turn === plug.ECHO_PLACEHOLDER_TURN &&
    startA?.frame.step === plug.ECHO_PLACEHOLDER_STEP,
)
check(
  'ECHO_STREAM_FRAMES',
  '第 2 类帧 >=1 个瞬态分片，且 chunk.index 从 0 稠密递增、chunk.type===\"text-delta\"',
  chunksA.length >= 1 &&
    chunksA.every(
      (e, i) =>
        e.frame.index === i &&
        e.frame.chunk?.type === 'text-delta' &&
        e.frame.chunk?.index === 0 &&
        Number.isSafeInteger(e.frame.time),
    ),
)
check(
  'ECHO_STREAM_FRAMES',
  '第 3 类帧 end 存在且 end.index === 下一个分片位置（=== 已发布分片数）',
  endA !== undefined && endA.frame.index === chunksA.length && endA.frame.index > 0,
)
check(
  'ECHO_STREAM_FRAMES',
  '帧内文本与回声固定文本一致：所有 text-delta 拼接 === plug.ECHO_TEXT === 返回体 echo',
  chunksA.map((e) => e.frame.chunk.text).join('') === plug.ECHO_TEXT &&
    echoA.echo === plug.ECHO_TEXT &&
    echoA.frames.map((f) => f.type).join(',') === kinds.join(','),
)
check(
  'ECHO_STREAM_FRAMES',
  'revision 严格递增且 end 帧 outcome 如实为 abandoned（未提交任何 durable attempt）',
  attemptA.every((e, i) => i === 0 || e.frame.revision > attemptA[i - 1].frame.revision) &&
    endA?.frame.outcome?.kind === 'abandoned',
)
check(
  'ECHO_STREAM_FRAMES',
  'resume 路径同样产出完整三类帧（start → 分片 → end），帧数一致',
  (() => {
    const at = echoFrames().filter((e) => e.frame.attemptId === echoB.attemptId)
    const ks = at.map((e) => e.frame.type)
    return (
      ks[0] === 'start' &&
      ks[ks.length - 1] === 'end' &&
      at.filter((e) => e.frame.type === 'chunk').length >= 1 &&
      at.find((e) => e.frame.type === 'end')?.frame.index ===
        at.filter((e) => e.frame.type === 'chunk').length
    )
  })(),
)

// ---- 6. RESTORE：卸载还原 ---------------------------------------------------
const echoCountBeforeUnload = echoFrames().length
await fiber.dispose()
await tick(40)
check('RESTORE', '卸载后 ctx.agents.factory.target 还原为原生 target',
  ctx.agents.factory?.target === nativeTarget)
check('RESTORE', '卸载后路由器已不再出现在 factory 槽位',
  ctx.agents.factory?.target !== router)

// ---- 负向防误杀（≥2 条，打印 NEG_ 标记）------------------------------------
// 重新装载一轮，专门做负向断言。
const fiber2 = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply })
await tick(80)
const router2 = ctx.agents.factory.target
const st2 = router2[plug.STATE]
const negEchoBefore = { ...st2.echoEngine.stats }
const negNativeBefore = { ...nativeCalls }
const negFramesBefore = liveFrames.length
const negEchoFramesBefore = echoFrames().length

// NEG_1：未打 marker 的调用不得进入回声引擎，且不得产生任何回声事件
await ctx.agents.create({ meta: { engine: 'native' } })
await ctx.agents.resume({ meta: { engine: 'claude' } })
await ctx.agents.create(null)
await ctx.agents.resume(undefined)
await ctx.agents.create({ engine: 'echo-lite' }) // 近似值也不得误命中
check(
  'NEG_UNMARKED_NOT_ECHO',
  '未打 marker / marker 为近似值 / null / undefined 的调用均不得进入回声引擎（回声计数不变）',
  st2.echoEngine.stats.createAgent === negEchoBefore.createAgent &&
    st2.echoEngine.stats.resume === negEchoBefore.resume,
)
check(
  'NEG_UNMARKED_NOT_ECHO',
  '上述未打 marker 的调用确实原样落到原生 target（native 计数 +5）',
  nativeCalls.createAgent + nativeCalls.resume ===
    negNativeBefore.createAgent + negNativeBefore.resume + 5,
)
check(
  'NEG_UNMARKED_NOT_ECHO',
  '未打 marker 的调用**不产生任何回声事件**（回声帧数纹丝不动，全局 agent/assistant-stream 帧数也不增）',
  echoFrames().length === negEchoFramesBefore &&
    liveFrames.length === negFramesBefore &&
    st2.echoEngine.stats.framesEmitted === negEchoBefore.framesEmitted,
)

// NEG_2：卸载后不得永久劫持——factory.target 必须回到原生 target 本体
await fiber2.dispose()
await tick(40)
check(
  'NEG_NO_PERMANENT_HIJACK',
  '卸载后 ctx.agents.factory.target 严格等于原生 target 本体（=== 身份相等，非包装）',
  ctx.agents.factory?.target === nativeTarget &&
    ctx.agents.factory.target !== router2,
)
const postUnload = await ctx.agents.create({ seed: 'post-unload' })
check(
  'NEG_NO_PERMANENT_HIJACK',
  '卸载后新调用直达原生 target（handledBy===\"native\"）',
  postUnload?.handledBy === 'native',
)
// 卸载后即便显式打 marker 也不得再产生回声事件（工厂槽位已还原，插件不再介入）
const framesBeforePostMark = liveFrames.length
const echoFramesBeforePostMark = echoFrames().length
const postMark = await ctx.agents.create({ meta: { engine: 'echo' } })
check(
  'NEG_NO_ECHO_EVENT_AFTER_UNLOAD',
  '卸载后带 marker 的调用不再被接管（走原生 target，handledBy===\"native\"）',
  postMark?.handledBy === 'native',
)
check(
  'NEG_NO_ECHO_EVENT_AFTER_UNLOAD',
  '卸载后**不再产生任何回声事件**（回声帧与全局 agent/assistant-stream 帧均零新增）',
  echoFrames().length === echoFramesBeforePostMark &&
    liveFrames.length === framesBeforePostMark,
)

// ---- 汇总 -------------------------------------------------------------------
liveDispose()
console.log('')
console.log(`SUMMARY: ${pass} HIT / ${fail} MISS (total ${pass + fail})`)
console.log(
  'ASSERTION_CLASSES: TAKEOVER, NATIVE_REGRESSION, ECHO_TEXT, EVENT_BRIDGE, ECHO_STREAM_FRAMES, RESTORE, NEG_UNMARKED_NOT_ECHO, NEG_NO_PERMANENT_HIJACK, NEG_NO_ECHO_EVENT_AFTER_UNLOAD',
)
console.log(
  `EVENT_BRIDGE_MODULE_IDENTITY: agentEvents===upstream ${plug.agentEvents === upstreamAgent.agentEvents}, emitAgentEvent===upstream ${plug.emitAgentEvent === upstreamAgent.emitAgentEvent}`,
)
console.log(`ECHO_FRAMES_OBSERVED: ${echoFrames().length}`)
if (fail === 0) {
  console.log('SMOKE_RESULT: PASS')
  process.exit(0)
} else {
  console.log('SMOKE_RESULT: FAIL')
  process.exit(1)
}
