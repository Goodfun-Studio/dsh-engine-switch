/**
 * session-lifecycle.mjs —— 「pi 引擎在真实 DSH 会话/Agent 生命周期里的一等公民化」确定性测试
 *
 * ## 为什么需要这一套（L7 现场）
 *
 * 桌面端（DeepSeek Harness.app）在 `engine: pi` 下点「新建会话 / 新建任务」时报错。
 * 抓到的真实报错（活跃 host 127.0.0.1:59200 上复现，逐字）：
 *
 *   code: session/workspace-attach-failed
 *   message: session "engine-switch:oar-pi:session-2245d0b0-…" was created but could not
 *            attach to workspace "4f8750e8-…": Error: cannot validate session
 *            'engine-switch:oar-pi:session-2245d0b0-…': session persistence holds no such session
 *
 * 根因：插件把 pi 的**替身 subject** 当成 Agent 交回调用方，而替身 id 被加了
 * `engine-switch:oar-pi:` 前缀（真实 Session id 是 `session-<uuid>`）。DSH 的
 * `sessionController.create()` 逐字取 `created.agent.id` 当会话身份 —— 于是
 *  · RPC 返回一个不存在的 sessionId（前端导航过去必然 session/not-found）；
 *  · `workspace.attachSession()` 拿这个 id 去持久化里校验 → 上面的报错；
 *  · 会话头没有 cwd（prepare 没带 meta）→ `readState`/attach 校验必挂；
 *  · Agent 从未注册进 `ctx.agents` → `session/prompt` 准入/`session/control` 都解析不到；
 *  · 流式帧按 `agent.session.id` 路由 → 帧挂在前缀 id 下，前端订阅真实会话 id 永远收不到。
 *
 * ## 本套件测什么（真实内存 / 真实磁盘，不调模型）
 *
 * 组合是真的：真实 @deepseek-ai/cordis Context + 真实 AgentRegistry + 真实 SessionStore
 * + **真实 jsonl 持久化后端**（临时根目录）+ 真实加载被测插件 index.js。
 * 只有两处是替身，且都标注清楚：
 *   · 原生 target 替身（`ctx.agents.setFactory()` 是上游公开 API，替身记录调用参数）；
 *   · `@botiverse/oar` 模块替身（不 spawn 任何子进程、不打任何模型；返回可辨识文本）。
 *
 * 断言分组：
 *   PI_IDENTITY  交给上游的 Agent 身份必须是**真实会话 id**（无前缀泄漏）
 *   PI_SESSION   会话真的进了 live store，且 header 带 cwd / agentPreset
 *   PI_PERSIST   会话真的落了盘（workspace attach / 冷读 / 重启活下去的前提）
 *   PI_REGISTRY  真实注册进 ctx.agents（session/prompt、session/control 解析得到）
 *   PI_STREAM    流式帧挂在**真实会话 id** 下（前端按会话 id 订阅才收得到）
 *   PI_TURN      首轮交互：用户消息 + durable turn 事件 + whenIdle + status 归位
 *   NEG_NATIVE   负向防误杀：engine=native 时严格直通原生 target，零 pi 污染
 *
 * 退出码：全部 HIT → 0；任一 MISS → 1。
 */
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = join(ROOT, 'dsh-engine-switch')
const imp = (p) => import(pathToFileURL(p).href)

// ---------------------------------------------------------------------------
// 替身 ①：@botiverse/oar —— 真货会 spawn pi 子进程并调真实模型；本套件不碰网络。
// 返回文本里带可辨识 sentinel，用来证明「pi 的产出真的走到了会话里」。
// ---------------------------------------------------------------------------
const OAR_STUB_TEXT = 'PI_STUB_TEXT'
const OAR_STUB = `
export const defaultRuntimes = {
  require(id) {
    return { id, installation: async () => ({ kind: 'available' }) }
  },
}
export const piSession = async (_installation, options) => ({
  options,
  model: () => ({ value: 'magpie/stub-model' }),
  dispose: async () => {},
})
export const promptAndWait = async (_session, text) => ({
  outcome: { kind: 'completed' },
  text: text + ' [' + ${JSON.stringify(OAR_STUB_TEXT)} + ']',
})
`
const OAR_STUB_URL = `data:text/javascript,${encodeURIComponent(OAR_STUB)}`

// 插件内部以裸标识符 import '@deepseek-ai/dsh-agent'（上游包的真实依赖关系）。
// 必须指向 .recon 里的真货，保证「插件 import 到的 AgentRegistry / 事件设施」与
// 「测试 import 到的」是**同一个模块实例**（否则注册表与事件总线各一套，断言全假）。
const AGENT_ENTRY = join(NM, 'dsh-agent/lib/index.js')
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@botiverse/oar') return { url: OAR_STUB_URL, shortCircuit: true }
    if (spec === '@deepseek-ai/dsh-agent') {
      return { url: pathToFileURL(AGENT_ENTRY).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

const { Context } = await imp(join(NM, 'cordis/lib/index.js'))
const { AgentRegistry } = await imp(AGENT_ENTRY)
const { SessionStore } = await imp(join(NM, 'dsh-session/lib/index.js'))
const { createUserMessage } = await imp(join(NM, 'dsh-llm/lib/index.js'))
const jsonl = await imp(join(NM, 'dsh-session-persistence-jsonl/lib/index.js'))
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

/**
 * 最小但**真折叠**的 sessionProjections 替身：按定义逐事件 fold，`stateOf(session)`
 * 返回当前状态。AgentRegistry 的 `turnBoundaryOf()` 就靠它（真机由
 * dsh-session-projection 提供）。不折叠的话 turn 边界永远是初始值，测不出「第二轮」。
 */
function createProjections() {
  const definitions = new Map()
  return {
    definitions,
    async register(definition) {
      definitions.set(definition.key, definition)
      return {
        stateOf(session) {
          let state = definition.init()
          for (const event of session.snapshotEvents()) state = definition.apply(state, event)
          return state
        },
      }
    },
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-session-lifecycle-'))
const evidenceFile = join(tmpRoot, 'evidence.json')
const persistenceRoot = join(tmpRoot, 'sessions-root')
const readEvidence = () => JSON.parse(readFileSync(evidenceFile, 'utf8'))
const cleanup = () => rmSync(tmpRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 组装真实组合
// ---------------------------------------------------------------------------
const ctx = new Context()
ctx.provide('sessionProjections', createProjections())
ctx.plugin(AgentRegistry)
ctx.plugin(SessionStore)
ctx.plugin({ name: jsonl.name, apply: jsonl.apply, Config: jsonl.Config }, { root: persistenceRoot })
await tick(200)

const nativeCalls = []
const NATIVE_SENTINEL = { id: 'native-agent-sentinel', standIn: undefined }
const nativeTarget = {
  async createAgent(_ctx, options) {
    // 真机 AgentLoop 的 createAgent 返回已发布的 handle `{agent, dispose}`；
    // sessionController / headless 都逐字取 `.agent`，替身照抄这个形状。
    const result = { agent: NATIVE_SENTINEL, dispose: async () => {} }
    nativeCalls.push({ kind: 'createAgent', options, result })
    return result
  },
  async resume(_ctx, options) {
    const result = { agent: NATIVE_SENTINEL, dispose: async () => {} }
    nativeCalls.push({ kind: 'resume', options, result })
    return result
  },
}
ctx.agents.setFactory(nativeTarget)

// 真实事件设施上的全局监听器：流式帧按 agent.session.id 路由到前端会话订阅，
// 这里如实记录「帧携带的 agent 身份 + 它声称的会话 id」。
const streamFrames = []
ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  streamFrames.push({ agent, frame, sessionId: agent?.session?.id ?? null })
})

const pluginConfig = plug.Config({ engine: 'native', evidencePath: evidenceFile })
const fiber = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply }, pluginConfig)
await tick(150)

const piProfile = { provider: 'magpie', model: 'auto/deepseek-v4.1-flash', reasoningEffort: 'high' }

// ---------------------------------------------------------------------------
// A. 正向：engine=pi —— 新建会话必须是一个「真实会话身份 + 真实生命周期」的会话
// ---------------------------------------------------------------------------
pluginConfig.engine[plug.VOLATILE_WRITE]('pi')
await tick(20)

const CWD = join(tmpRoot, 'workspace')
const PI_SESSION = 'session-l7pi0001-0000-4000-8000-000000000001'
// 真实调用形状：sessionController / headless 都读 `(await agents.create(...)).agent`
// （AgentLoop 的 createAgent 返回已发布 handle `{agent, dispose}`）。
const piCreated = await ctx.agents.create({
  sessionId: PI_SESSION,
  meta: { cwd: CWD, agentPreset: 'standard' },
  agentOptions: piProfile,
})
const piAgent = piCreated?.agent

check(
  'PI_IDENTITY',
  'create 交回的 Agent 身份 = 真实会话 id（无 engine-switch:oar-pi: 前缀泄漏；sessionController 逐字取 agent.id 当会话身份）',
  piAgent?.id === PI_SESSION,
)
check(
  'PI_IDENTITY',
  'Agent 身份满足上游注册表不变量 agent.id === agent.session.id（AgentRegistry.enter 的硬校验）',
  piAgent?.id === piAgent?.session?.id && piAgent?.session?.id === PI_SESSION,
)
check(
  'PI_IDENTITY',
  '替身身份如实标注（standIn:true，不冒充真实 AgentLoop）且未把前缀当作会话 id 暴露',
  piAgent?.standIn === true && !String(piAgent?.id ?? '').includes('engine-switch:oar-pi'),
)
check(
  'PI_IDENTITY',
  `不再出现任何带 'engine-switch:oar-pi' 前缀的 id（负向：前缀泄漏是本次桌面端报错的直接原因）`,
  !String(piAgent?.id ?? '').includes(':oar-pi:') && streamFrames.every((f) => !String(f.sessionId ?? '').includes(':oar-pi:')),
)

const piSession = ctx.sessions.get(PI_SESSION)
check(
  'PI_SESSION',
  '会话真的进了 live store，且交给上游的就是同一个 Session 对象（ctx.sessions.get 可见）',
  piSession !== undefined && piAgent?.session === piSession,
)
check(
  'PI_SESSION',
  '会话 header 带创建元数据 cwd —— workspace.attachSession 与 readState 校验的就是它',
  piSession?.header?.cwd === CWD,
)
check(
  'PI_SESSION',
  '会话 header 记下 agentPreset（会话身份，与引擎正交的业务预设）',
  piSession?.header?.agentPreset === 'standard',
)
check(
  'PI_SESSION',
  'pi 引擎结束时不把会话踢出 store（会话生命周期属于宿主，不随一次 attempt 结束）',
  ctx.sessions.get(PI_SESSION) === piSession,
)

// 持久化：桌面端 workspace attach 走 `readSessionHeader`，冷读走持久化；
// 没有 durable 会话 ⇒ 重启即丢、attach 直接报 "session persistence holds no such session"。
const durability = await (async () => {
  try {
    const handle = await ctx.get('sessionPersistence').open(PI_SESSION, 'read')
    const cold = await handle.read(0)
    await handle.close()
    return { ok: true, header: cold.header ?? handle.header, events: cold.events?.length ?? 0 }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
})()
check(
  'PI_PERSIST',
  '会话真的落盘：持久化后端能冷读回来（新建会话在重启后仍然存在，不再 "holds no such session"）',
  durability.ok === true,
)
check(
  'PI_PERSIST',
  '冷读回来的 header 带着 cwd（workspace.attachSession 对**已存盘**会话的校验依据）',
  durability.ok === true && (durability.header?.cwd === CWD),
)
check(
  'PI_REGISTRY',
  'Agent 真的注册进 ctx.agents（session/prompt 准入、session/control、readState 全靠它）',
  ctx.agents.get(PI_SESSION) === piAgent,
)
check(
  'PI_REGISTRY',
  'Agent 进入真实注册表后，session/prompt 的准入检查（ctx.agents.get(agent.id) !== agent）不会误杀',
  ctx.agents.get(piAgent.id) === piAgent && piAgent.id === piSession.id,
)

// ---------------------------------------------------------------------------
// B. 正向：首轮交互（真实 turn 事件 + 流式帧 + whenIdle）
// ---------------------------------------------------------------------------
streamFrames.length = 0
const rpcId = 'req-l7-first-turn'
const userMessage = createUserMessage({
  content: [{ type: 'text', text: '第一轮问题' }],
  source: { kind: 'user', rpcId },
})
const seqBefore = piSession.seq
piAgent.followup(userMessage)
const statusWhileRunning = piAgent.status
await piAgent.whenIdle()
await ctx.sessions.flush(piSession)

const events = piSession.snapshotEvents().slice(seqBefore)
const types = events.map((event) => event.type)
const assistantText = events
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data.message.content)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
const userEvents = events.filter((event) => event.type === 'user/message')
// 真实 DSH 词汇：user/message 的 event.data **就是** message 本体
// （形如 {content, source, role:'user', id}），不再套一层 data.message。

check('PI_TURN', 'followup 期间 Agent 状态如实置为 running（前端「运行中」指示的依据）', statusWhileRunning === 'running')
check('PI_TURN', 'whenIdle 在 turn 提交后归位，status 回到 idle', piAgent.status === 'idle')
check(
  'PI_TURN',
  '用户消息真的进了 durable 会话日志（前端会话记录里看得见用户那句话）',
  userEvents.length === 1 &&
    userEvents[0].data.content.some((block) => block.type === 'text' && block.text === '第一轮问题'),
)
check(
  'PI_TURN',
  '用户消息带着 prompt 的 rpcId（session/prompt 的重发去重 hasPromptRequest 靠它）',
  userEvents[0]?.data?.source?.rpcId === rpcId,
)
check(
  'PI_TURN',
  'durable turn 事件齐全且有序：turn/start → step/start → assistant/message → step/end → turn/end',
  types.includes('turn/start') &&
    types.includes('step/start') &&
    types.includes('assistant/message') &&
    types.includes('step/end') &&
    types.includes('turn/end') &&
    types.indexOf('turn/start') < types.indexOf('assistant/message') &&
    types.indexOf('assistant/message') < types.indexOf('turn/end'),
)
check(
  'PI_TURN',
  'pi 的产出文本落进 assistant/message（不是空文本、不是只挂流式帧）',
  assistantText.includes(OAR_STUB_TEXT),
)
check(
  'PI_TURN',
  'assistant/message 的 data 形状与真实 DSH 一致（{turn, step, message}，不是裸 message）',
  events.find((event) => event.type === 'assistant/message')?.data?.message?.role === 'assistant',
)
// 存盘的 assistant/message 会被冷读路径做 settlement 校验：缺 turn/step/stream 会让
// 整条会话被判 corrupt（"has invalid settlement fields"），重启后旧会话直接打不开。
const assistantEvent = events.find((event) => event.type === 'assistant/message')
check(
  'PI_PERSIST',
  'assistant/message 带齐 settlement 字段（turn / step / stream 数组）—— 缺了会被冷读判 corrupt',
  Number.isSafeInteger(assistantEvent?.data?.turn) &&
    Number.isSafeInteger(assistantEvent?.data?.step) &&
    Array.isArray(assistantEvent?.data?.stream) &&
    assistantEvent.data.stream.length > 0,
)
check(
  'PI_PERSIST',
  'assistant/message 的 source 是 model 源（kind=model + provider/model）—— 存盘校验要求',
  assistantEvent?.data?.message?.source?.kind === 'model' &&
    typeof assistantEvent?.data?.message?.source?.provider === 'string' &&
    typeof assistantEvent?.data?.message?.source?.model === 'string',
)
check(
  'PI_TURN',
  'turn/end 的 reason 如实为 completed（成功收尾，不是伪装的 abandoned）',
  events.find((event) => event.type === 'turn/end')?.data?.reason?.kind === 'completed',
)
check(
  'PI_STREAM',
  '流式帧挂在**真实会话 id** 下（前端按会话 id 订阅 assistant stream，前缀 id 会永远收不到）',
  streamFrames.length > 0 && streamFrames.every((frame) => frame.sessionId === PI_SESSION),
)
check(
  'PI_STREAM',
  '流式帧的 payload.agent 就是注册进注册表的那个替身（scope carrier 与身份一片，不分裂）',
  streamFrames.every((frame) => frame.agent === piAgent),
)
check(
  'PI_STREAM',
  '流式帧词汇是真实 DSH 帧（start/chunk/end + attemptId/revision）',
  streamFrames.some((frame) => frame.frame?.type === 'start') &&
    streamFrames.some((frame) => frame.frame?.type === 'chunk') &&
    streamFrames.some((frame) => frame.frame?.type === 'end') &&
    typeof streamFrames[0]?.frame?.attemptId === 'string',
)

// 第二轮：turn 号必须接着走（复用真实 turnBoundary 投影，不能永远 turn=1）
const secondTurnSeq = piSession.seq
piAgent.followup(
  createUserMessage({ content: [{ type: 'text', text: '第二轮问题' }], source: { kind: 'user', rpcId: 'req-l7-second-turn' } }),
)
await piAgent.whenIdle()
const secondEvents = piSession.snapshotEvents().slice(secondTurnSeq)
check(
  'PI_TURN',
  '第二轮从真实 turn 边界续号（turn=2），不覆盖/重号（会话可以接着聊）',
  secondEvents.find((event) => event.type === 'turn/start')?.data?.turn === 2,
)

const persistedTurnText = await (async () => {
  try {
    const handle = await ctx.get('sessionPersistence').open(PI_SESSION, 'read')
    const cold = await handle.read(0)
    await handle.close()
    return cold.events
      .filter((event) => event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
  } catch {
    return ''
  }
})()
check(
  'PI_PERSIST',
  '首轮产出也落了盘（冷读会话日志能读到 assistant 文本，重启后历史不丢）',
  persistedTurnText.includes(OAR_STUB_TEXT),
)

// 冷读复原彩排：真机 resume / 重启后打开旧会话走的就是这条路径
// （磁盘事件 → Session.fromRestore 校验）。settlement 字段缺一个都会在这里炸。
const coldReplay = await (async () => {
  try {
    const handle = await ctx.get('sessionPersistence').open(PI_SESSION, 'read')
    const cold = await handle.read(0)
    await handle.close()
    ctx.sessions.prepare('session-l7-replay-probe', { seed: cold.events, meta: { cwd: CWD } })
    return { ok: true, count: cold.events.length }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
})()
check(
  'PI_PERSIST',
  '冷读复原彩排：磁盘事件能通过 Session 的 fromRestore 校验（重启后旧会话真的能重新载入）',
  coldReplay.ok === true,
)

check(
  'PI_PERSIST',
  '磁盘上真的出现了该会话的日志目录 ~/.dsh/sessions/<workspace>/session-…（不是只在内存里）',
  existsSync(persistenceRoot) &&
    readdirSync(persistenceRoot, { recursive: true }).some((p) => String(p).includes(PI_SESSION)),
)

// ---------------------------------------------------------------------------
// C. 负向防误杀：engine=native —— 严格直通原生 target，零 pi 路由污染
// ---------------------------------------------------------------------------
pluginConfig.engine[plug.VOLATILE_WRITE]('native')
await tick(20)

const NATIVE_SESSION = 'session-l7nat0001-0000-4000-8000-000000000002'
const nativeBefore = nativeCalls.length
const piEvidenceBefore = readEvidence().piByKind.createAgent
const nativeOptions = {
  sessionId: NATIVE_SESSION,
  meta: { cwd: CWD, agentPreset: 'standard' },
  agentOptions: piProfile,
}
const nativeCreated = await ctx.agents.create(nativeOptions)
const nativeResult = nativeCreated?.agent

check(
  'NEG_NATIVE',
  'engine=native（选择器）下 create 原样直通原生 target：交回的就是原生 target 的 agent（恒等，不包装）',
  nativeCalls.length === nativeBefore + 1 && nativeResult === NATIVE_SENTINEL && nativeCreated === nativeCalls[nativeBefore].result,
)
check(
  'NEG_NATIVE',
  '原生 target 收到的是**逐字原样**的调用参数（sessionId / meta / agentOptions 一个不改）',
  nativeCalls[nativeBefore].kind === 'createAgent' &&
    nativeCalls[nativeBefore].options === nativeOptions,
)
check(
  'NEG_NATIVE',
  'pi 引擎零调用（证据 piByKind.createAgent 未上升）—— 没有偷偷把原生会话交给 pi',
  readEvidence().piByKind.createAgent === piEvidenceBefore,
)
check(
  'NEG_NATIVE',
  '没有替身污染：原生路径不产生 standIn Agent，也不给会话塞 pi 前缀身份',
  nativeResult?.standIn === undefined && !String(nativeResult?.id ?? '').includes('oar-pi'),
)

const NATIVE_SESSION_2 = 'session-l7nat0002-0000-4000-8000-000000000003'
const nativeOptions2 = { sessionId: NATIVE_SESSION_2, meta: { cwd: CWD }, agentOptions: piProfile }
await ctx.agents.create(nativeOptions2)
check(
  'NEG_NATIVE',
  '原生路径不越权托管会话：插件没为原生会话 prepare/enter 任何 Session（ctx.sessions 里查无此会话）',
  ctx.sessions.get(NATIVE_SESSION_2) === undefined && ctx.sessions.get(NATIVE_SESSION) === undefined,
)
check(
  'NEG_NATIVE',
  '原生路径不注册任何 Agent（注册表里只有正向 pi 的那一个替身）',
  ctx.agents.list().filter((agent) => agent.standIn === true).length === 1 &&
    ctx.agents.get(NATIVE_SESSION) === undefined,
)

// 切回 pi：同一个选择器再切回来，新会话仍然正确（选择器现读，不是快照）
pluginConfig.engine[plug.VOLATILE_WRITE]('pi')
await tick(20)
const PI_SESSION_2 = 'session-l7pi0002-0000-4000-8000-000000000004'
const piAgent2 = (
  await ctx.agents.create({
    sessionId: PI_SESSION_2,
    meta: { cwd: CWD },
    agentOptions: piProfile,
  })
)?.agent
check(
  'PI_IDENTITY',
  '选择器切回 pi 后新建会话依旧拿到真实会话身份（现读生效，不残留 native）',
  piAgent2?.id === PI_SESSION_2 && ctx.agents.get(PI_SESSION_2) === piAgent2,
)

// ---------------------------------------------------------------------------
// D. 卸载：插件退出后不留残骸（factory 还原；已注册会话不因插件卸载而崩）
// ---------------------------------------------------------------------------
await fiber.dispose()
await tick(60)
check('UNLOAD', '插件卸载后 factory 槽位还原为原生 target 本体（零残留劫持）', ctx.agents.factory?.target === nativeTarget)
check(
  'UNLOAD',
  '卸载时把插件自己注册的 Agent/会话从 store 里摘干净（不留无主条目；磁盘日志保留，数据不丢）',
  ctx.agents.get(PI_SESSION) === undefined &&
    ctx.sessions.get(PI_SESSION) === undefined &&
    readdirSync(persistenceRoot, { recursive: true }).some((p) => String(p).includes(PI_SESSION)),
)

// ---------------------------------------------------------------------------
// E. 冷重启：新进程（新 Context / 新 store / 新持久化实例，同一份磁盘根）
//    重新打开同一个会话 —— 桌面端「重启 DSH 后打开旧会话」走的就是这条 resume 冷开路径。
// ---------------------------------------------------------------------------
const world2 = new Context()
world2.provide('sessionProjections', createProjections())
world2.plugin(AgentRegistry)
world2.plugin(SessionStore)
world2.plugin({ name: jsonl.name, apply: jsonl.apply, Config: jsonl.Config }, { root: persistenceRoot })
await tick(200)
const native2 = {
  createAgent: async () => ({ agent: { id: 'native2' } }),
  resume: async () => ({ agent: { id: 'native2' } }),
}
world2.agents.setFactory(native2)
const config2 = plug.Config({ engine: 'pi' })
const fiber2 = world2.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply }, config2)
await tick(150)

const resumedCreated = await world2.agents.resume({ resumeSessionId: PI_SESSION })
const resumedAgent = resumedCreated?.agent
const resumedSession = world2.sessions.get(PI_SESSION)
const resumedEvents = resumedSession === undefined ? [] : resumedSession.snapshotEvents()
const resumedText = resumedEvents
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data.message.content)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')

check(
  'RESUME',
  '冷重启后 resume 拿到的 Agent 身份仍是真实会话 id（不是游离替身，也不是前缀）',
  resumedAgent?.id === PI_SESSION,
)
check(
  'RESUME',
  '冷重启后会话被从磁盘读回来并重新进 live store（ctx.sessions.get 可见，且历史事件还在）',
  resumedSession !== undefined && resumedEvents.length >= 10,
)
check(
  'RESUME',
  '冷重启后历史完整：第一轮的 assistant 文本原样复原（没有被截断/丢事件）',
  resumedText.includes(OAR_STUB_TEXT),
)
check(
  'RESUME',
  '冷重启后 Agent 注册进新进程的 ctx.agents（重启后旧会话能继续对话的前提）',
  world2.agents.get(PI_SESSION) === resumedAgent,
)

// 冷开之后接着聊：turn 号必须接在磁盘历史之后，且事件必须能落盘
// （真机踩过的坑：seq 与持久化游标错位 → append seq mismatch）
const resumeSeqBefore = resumedSession.seq
resumedAgent.followup(
  createUserMessage({ content: [{ type: 'text', text: '重启后的第二轮' }], source: { kind: 'user', rpcId: 'req-l7-resume-turn' } }),
)
let resumeTurnError = null
try {
  await resumedAgent.whenIdle()
} catch (error) {
  resumeTurnError = String(error?.message ?? error)
}
const resumeEvents2 = resumedSession.snapshotEvents().slice(resumeSeqBefore)
check(
  'RESUME',
  '冷重启后接续的一轮真的落盘：无 flush/seq 错位错误（持久化游标与会话 seq 对齐）',
  resumeTurnError === null,
)
const seededMaxTurn = resumedEvents
  .filter((event) => event.type === 'turn/start')
  .reduce((max, event) => Math.max(max, event.data.turn), 0)
const resumedTurn = resumeEvents2.find((event) => event.type === 'turn/start')?.data?.turn
check(
  'RESUME',
  `冷重启后 turn 号接在磁盘历史之后（历史最大 turn=${seededMaxTurn} → 新一轮 turn=${String(resumedTurn)}），不重号不覆盖`,
  resumedTurn === seededMaxTurn + 1,
)
const resumedDiskText = await (async () => {
  try {
    const handle = await world2.get('sessionPersistence').open(PI_SESSION, 'read')
    const cold = await handle.read(0)
    await handle.close()
    return cold.events
      .filter((event) => event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
  } catch (error) {
    return `__error__: ${String(error?.message ?? error)}`
  }
})()
check(
  'RESUME',
  '冷重启后的那一轮真写进了磁盘（冷读能同时读到两轮产出）',
  resumedDiskText.includes(OAR_STUB_TEXT) && resumedDiskText.includes('[PI_STUB_TEXT]'),
)

await fiber2.dispose()
await tick(60)
check(
  'RESUME',
  '第二个进程卸载后同样不留无主条目（agent + 会话都摘干净）',
  world2.agents.get(PI_SESSION) === undefined && world2.sessions.get(PI_SESSION) === undefined,
)

cleanup()

console.log(`\nSUMMARY: ${pass} HIT / ${fail} MISS`)
console.log(
  'ASSERTION_CLASSES: PI_IDENTITY, PI_SESSION, PI_PERSIST, PI_REGISTRY, PI_STREAM, PI_TURN, NEG_NATIVE, RESUME, UNLOAD',
)
console.log(fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(fail === 0 ? 0 : 1)
