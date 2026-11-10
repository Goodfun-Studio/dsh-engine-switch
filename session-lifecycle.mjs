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
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
// DSH_WORKSPACE names the host workspace that owns `.recon`; DSH_SWITCH names the
// plugin checkout under test. They coincide in the normal install layout, but an
// isolated git worktree is itself the plugin root, so keep the two roots separate.
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const SWITCH = process.env.DSH_SWITCH || __dirname
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = SWITCH
const imp = (p) => import(pathToFileURL(p).href)

// ---------------------------------------------------------------------------
// 替身 ①：@botiverse/oar —— 真货会 spawn pi 子进程并调真实模型；本套件不碰网络。
// 返回文本里带可辨识 sentinel，用来证明「pi 的产出真的走到了会话里」。
// ---------------------------------------------------------------------------
const OAR_STUB_TEXT = 'PI_STUB_TEXT'
const OAR_STUB = `
const state = {
  calls: [],
  histories: new Map(),
  failedResumes: new Set(),
  nextId: 1,
  activePrompts: 0,
  maxConcurrentPrompts: 0,
  promptDelayMs: 0,
}
export const oarCalls = state.calls
export const oarControl = {
  histories: state.histories,
  failedResumes: state.failedResumes,
  activePrompts: () => state.activePrompts,
  maxConcurrentPrompts: () => state.maxConcurrentPrompts,
  resetMaxConcurrentPrompts: () => { state.maxConcurrentPrompts = state.activePrompts },
  setPromptDelay: (ms) => { state.promptDelayMs = ms },
}
export const defaultRuntimes = {
  require(id) {
    return { id, installation: async () => ({ kind: 'available' }) }
  },
}
export const piSession = async (_installation, options) => {
  const call = {
    options,
    resume: options.resume ?? null,
    piSessionId: null,
    prompt: null,
    error: null,
    disposed: false,
  }
  state.calls.push(call)
  if (options.resume !== undefined && state.failedResumes.has(options.resume)) {
    const error = new Error('pi session ' + options.resume + ' not found')
    error.name = 'SessionNotFoundError'
    call.error = error.message
    throw error
  }
  const id = options.resume ?? 'pi-native-' + state.nextId++
  call.piSessionId = id
  if (!state.histories.has(id)) state.histories.set(id, [])
  return {
    id,
    call,
    options,
    model: () => ({ value: options.model ?? 'magpie/stub-model' }),
    dispose: async () => { call.disposed = true },
  }
}
export const promptAndWait = async (session, text) => {
  session.call.prompt = text
  state.activePrompts += 1
  state.maxConcurrentPrompts = Math.max(state.maxConcurrentPrompts, state.activePrompts)
  if (state.promptDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, state.promptDelayMs))
  }
  const history = state.histories.get(session.id) ?? []
  let answer = text + ' [' + ${JSON.stringify(OAR_STUB_TEXT)} + ']'
  if (text.includes('__RECALL__')) {
    let token = null
    for (const previous of [...history, text]) {
      const match = /TOKEN=([A-Z0-9-]+)/.exec(previous)
      if (match !== null) token = match[1]
    }
    answer = 'RECALLED:' + (token ?? 'MISSING') + ' [' + ${JSON.stringify(OAR_STUB_TEXT)} + ']'
  }
  history.push(text)
  state.activePrompts -= 1
  return {
    outcome: { kind: 'completed' },
    text: answer,
  }
}
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

const oar = await import('@botiverse/oar')
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

const deepSnapshot = (value) => structuredClone(value)

/**
 * Binding 存储的完整测试快照：相对路径、类型、mtime、大小与内容 hash 都纳入。
 * 这样读取本身不会改变快照，而 create/update/delete 任一动作都会让对应字段变化。
 */
function snapshotTree(root) {
  if (typeof root !== 'string' || root === '' || !existsSync(root)) {
    return { root: root ?? null, entries: [] }
  }
  const entries = []
  const walk = (relative = '') => {
    const absolute = relative === '' ? root : join(root, relative)
    const children = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const child of children) {
      const childRelative = relative === '' ? child.name : join(relative, child.name)
      const childAbsolute = join(root, childRelative)
      const stat = lstatSync(childAbsolute)
      const common = {
        path: childRelative,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }
      if (child.isDirectory()) {
        entries.push({ ...common, type: 'dir' })
        walk(childRelative)
      } else if (child.isFile()) {
        entries.push({
          ...common,
          type: 'file',
          sha256: createHash('sha256').update(readFileSync(childAbsolute)).digest('hex'),
        })
      } else {
        entries.push({ ...common, type: 'other' })
      }
    }
  }
  walk()
  return { root, entries }
}

/**
 * Native 负向守卫的独立故障注入 harness。
 *
 * 正常调用必须同时满足：options 前后深相等、receiver 收到深快照、binding 树不变、
 * binding read/write/clear 均为 0、Pi runner 与 Bootstrap 均未调用。
 * fault 参数只改变 target 的行为，不进入生产路由；子进程应因对应守卫 MISS 而 exit=1。
 */
async function runNativeGuard(fault = null) {
  const options = {
    sessionId: `native-guard-${fault ?? 'baseline'}`,
    meta: {
      cwd: '/tmp/dsh-native-guard/workspace',
      agentPreset: 'standard',
      routeProbe: {
        flags: [true, false, true],
        nested: { mode: 'strict', labels: ['alpha', 'beta'] },
      },
    },
    agentOptions: {
      provider: 'magpie',
      model: 'auto/deepseek-v4.1-flash',
      reasoningEffort: 'high',
      routingProbe: {
        levels: [
          { id: 1, enabled: true },
          { id: 2, enabled: false },
        ],
        tags: ['one', 'two'],
      },
    },
  }
  const before = deepSnapshot(options)
  const bindingState = new Map([
    ['existing-session', { piSessionId: 'pi-existing', cwd: '/tmp/dsh-native-guard/workspace' }],
  ])
  const bindingCalls = { read: 0, write: 0, clear: 0 }
  const bindingSnapshot = () => deepSnapshot([...bindingState.entries()])
  const bindingsBefore = bindingSnapshot()
  const bindingStore = {
    read(sessionId) {
      bindingCalls.read += 1
      const entry = bindingState.get(sessionId) ?? null
      return { ok: entry !== null, entry, file: null, error: entry === null ? 'not-found' : null }
    },
    write(sessionId, entry) {
      bindingCalls.write += 1
      bindingState.set(sessionId, deepSnapshot(entry))
      return { ok: true, file: null, entry, error: null }
    },
    clear(sessionId) {
      bindingCalls.clear += 1
      const removed = bindingState.delete(sessionId)
      return { ok: true, removed, file: null, error: null }
    },
  }
  const piCalls = { runner: 0, bootstrap: 0 }
  const piEngine = {
    async createAgent() {
      piCalls.runner += 1
      return { agent: { id: 'unexpected-pi-agent' } }
    },
    async resume() {
      piCalls.runner += 1
      return { agent: { id: 'unexpected-pi-agent' } }
    },
  }
  const nativeResult = { agent: { id: 'native-guard-sentinel' } }
  const received = []
  const nativeTarget = {
    async createAgent(_ctx, callOptions) {
      received.push(callOptions)
      if (fault === 'mutate-meta-cwd') callOptions.meta.cwd = '/tmp/dsh-native-guard/mutated'
      if (fault === 'mutate-nested-options') {
        callOptions.agentOptions.routingProbe.levels[1].enabled = true
        callOptions.meta.routeProbe.flags[1] = true
      }
      if (fault === 'read-binding') bindingStore.read('existing-session')
      if (fault === 'create-binding') {
        bindingStore.write('created-session', {
          piSessionId: 'pi-created',
          cwd: '/tmp/dsh-native-guard/workspace',
        })
      }
      if (fault === 'update-binding') {
        bindingStore.write('existing-session', {
          piSessionId: 'pi-updated',
          cwd: '/tmp/dsh-native-guard/workspace',
        })
      }
      if (fault === 'clear-binding') bindingStore.clear('existing-session')
      if (fault === 'call-pi') await piEngine.createAgent({}, callOptions)
      if (fault === 'call-bootstrap') piCalls.bootstrap += 1
      return nativeResult
    },
    async resume() {
      return nativeResult
    },
  }
  const router = plug.createRouter(
    nativeTarget,
    { async createAgent() {}, async resume() {} },
    piEngine,
    { forceEngine: 'native', readConfigEngine: () => 'native' },
  )
  const result = await router.createAgent({}, options)
  const after = deepSnapshot(options)
  const receivedBefore = received[0] === undefined ? null : deepSnapshot(received[0])
  const bindingsAfter = bindingSnapshot()
  const checks = [
    {
      name: 'NATIVE_TARGET_ONCE',
      ok: received.length === 1 && result === nativeResult,
    },
    {
      name: 'NATIVE_OPTIONS_CALLER_SNAPSHOT_STABLE',
      ok: isDeepStrictEqual(after, before),
    },
    {
      name: 'NATIVE_OPTIONS_RECEIVER_DEEP_EQUAL',
      ok: receivedBefore !== null && isDeepStrictEqual(receivedBefore, before),
    },
    {
      name: 'NATIVE_OPTIONS_RECEIVER_AFTER_CALL_STABLE',
      ok: received[0] !== undefined && isDeepStrictEqual(received[0], before),
    },
    {
      name: 'NATIVE_BINDING_STORE_SNAPSHOT_STABLE',
      ok: isDeepStrictEqual(bindingsAfter, bindingsBefore),
    },
    {
      name: 'NATIVE_BINDING_READ_ZERO',
      ok: bindingCalls.read === 0,
    },
    {
      name: 'NATIVE_BINDING_WRITE_CREATE_UPDATE_ZERO',
      ok: bindingCalls.write === 0,
    },
    {
      name: 'NATIVE_BINDING_CLEAR_DELETE_ZERO',
      ok: bindingCalls.clear === 0,
    },
    {
      name: 'NATIVE_PI_RUNNER_ZERO',
      ok: piCalls.runner === 0,
    },
    {
      name: 'NATIVE_BOOTSTRAP_ZERO',
      ok: piCalls.bootstrap === 0,
    },
  ]
  return { checks, bindingCalls, piCalls, received: received.length }
}

const nativeGuardChildSeparator = process.argv.indexOf('--native-guard-child')
if (nativeGuardChildSeparator !== -1) {
  const fault = process.argv[nativeGuardChildSeparator + 1] ?? null
  const guard = await runNativeGuard(fault)
  for (const assertion of guard.checks) {
    console.log(`[${assertion.ok ? 'HIT' : 'MISS'}] NATIVE_GUARD :: ${assertion.name}`)
  }
  const misses = guard.checks.filter((assertion) => !assertion.ok)
  console.log(`GUARD_RESULT: ${misses.length === 0 ? 'PASS' : 'FAIL'} (${fault ?? 'baseline'})`)
  process.exit(misses.length === 0 ? 0 : 1)
}

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
const piAgentDir = join(tmpRoot, 'pi-agent')
const priorPiAgentDir = process.env.PI_CODING_AGENT_DIR
process.env.PI_CODING_AGENT_DIR = piAgentDir
mkdirSync(piAgentDir, { recursive: true })
writeFileSync(
  join(piAgentDir, 'models.json'),
  JSON.stringify({
    providers: {
      magpie: {
        name: 'Magpie',
        models: [
          { id: 'auto/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { id: 'auto/claude-fable-5', name: 'Claude Fable 5' },
        ],
      },
    },
  }),
)
const readEvidence = () => JSON.parse(readFileSync(evidenceFile, 'utf8'))
const cleanup = () => {
  if (priorPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = priorPiAgentDir
  rmSync(tmpRoot, { recursive: true, force: true })
}

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

// L10：建会话时第一次 Pi attempt 打开原生会话，并把 id 按 DSH session 持久化。
const createOarCall = oar.oarCalls.find(
  (call) => call.options.cwd === CWD && call.prompt === plug.PI_PROMPT,
)
const firstNativePiId = createOarCall?.piSessionId ?? null
check(
  'PI_CONTEXT',
  '首次 Pi attempt 没有 resume（新建原生会话），并返回可复用的 native session id',
  createOarCall !== undefined &&
    createOarCall.resume === null &&
    typeof firstNativePiId === 'string' &&
    firstNativePiId !== '',
)
check(
  'PI_CONTEXT',
  '首次 Pi attempt 使用 DSH session 的真实 cwd（不是 desktop profile / process.cwd）',
  createOarCall?.options?.cwd === CWD,
)
check(
  'PI_CONTEXT',
  '单轮/首次 attempt 不生成多余历史包装（无 <dsh_conversation_history>，prompt 原样）',
  createOarCall?.prompt === plug.PI_PROMPT,
)
const nativeStoreDir = join(piAgentDir, 'dsh-engine-switch', 'native-sessions')
const nativeBindingFile =
  existsSync(nativeStoreDir)
    ? readdirSync(nativeStoreDir).find((name) => name.endsWith('.json'))
    : undefined
const nativeBinding =
  nativeBindingFile === undefined
    ? null
    : JSON.parse(readFileSync(join(nativeStoreDir, nativeBindingFile), 'utf8'))
check(
  'PI_CONTEXT',
  'native session id 按 DSH session 原子持久化（文件里 dshSessionId / piSessionId / cwd 全部一致）',
  nativeBinding?.version === 1 &&
    nativeBinding?.dshSessionId === PI_SESSION &&
    nativeBinding?.piSessionId === firstNativePiId &&
    nativeBinding?.cwd === CWD,
)
const bindingFileFor = (sessionId) => {
  if (!existsSync(nativeStoreDir)) return null
  for (const name of readdirSync(nativeStoreDir)) {
    if (!name.endsWith('.json')) continue
    const file = join(nativeStoreDir, name)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.dshSessionId === sessionId) return file
    } catch {
      // 损坏文件由生产代码负责回退；测试 helper 继续找下一个。
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// B. 正向：首轮交互（真实 turn 事件 + 流式帧 + whenIdle）
// ---------------------------------------------------------------------------
streamFrames.length = 0
const RECALL_TOKEN = 'CS329Z-L10-ALPHA'
const rpcId = 'req-l7-first-turn'
const userMessage = createUserMessage({
  content: [{ type: 'text', text: `第一轮问题 TOKEN=${RECALL_TOKEN}` }],
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
    userEvents[0].data.content.some(
      (block) => block.type === 'text' && block.text === `第一轮问题 TOKEN=${RECALL_TOKEN}`,
    ),
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

const firstTurnOarCall =
  createOarCall === undefined ? undefined : oar.oarCalls[oar.oarCalls.indexOf(createOarCall) + 1]
check(
  'PI_CONTEXT',
  '首轮用户消息复用建会话时的同一个 Pi native session id（不是再开一个新会话）',
  firstTurnOarCall?.resume === firstNativePiId &&
    firstTurnOarCall?.piSessionId === firstNativePiId,
)
check(
  'PI_CONTEXT',
  '成功 resume 时只把本轮用户文本交给 Pi，不重复注入 DSH 历史',
  firstTurnOarCall?.prompt === `第一轮问题 TOKEN=${RECALL_TOKEN}`,
)

// 第二轮：turn 号必须接着走（复用真实 turnBoundary 投影，不能永远 turn=1）
const SWITCHED_MODEL = 'magpie/auto/claude-fable-5'
piAgent.model.select({
  provider: 'magpie',
  model: 'auto/claude-fable-5',
  reasoningEffort: 'high',
})
const secondTurnSeq = piSession.seq
piAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: '请复述第一轮的 TOKEN；__RECALL__' }],
    source: { kind: 'user', rpcId: 'req-l7-second-turn' },
  }),
)
await piAgent.whenIdle()
const secondEvents = piSession.snapshotEvents().slice(secondTurnSeq)
const secondTurnOarCall =
  firstTurnOarCall === undefined ? undefined : oar.oarCalls[oar.oarCalls.indexOf(firstTurnOarCall) + 1]
const secondTurnAssistantText = secondEvents
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data.message.content)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
check(
  'PI_TURN',
  '第二轮从真实 turn 边界续号（turn=2），不覆盖/重号（会话可以接着聊）',
  secondEvents.find((event) => event.type === 'turn/start')?.data?.turn === 2,
)
check(
  'PI_CONTEXT',
  '第二轮继续 resume 同一个 Pi native session id，且改了模型后 resumed attempt 使用新模型',
  secondTurnOarCall?.resume === firstNativePiId &&
    secondTurnOarCall?.options?.model === SWITCHED_MODEL &&
    secondTurnOarCall?.options?.cwd === CWD,
)
check(
  'PI_CONTEXT',
  '第二轮真实复述第一轮 token（Pi 原生上下文确实跨轮可见）',
  secondTurnAssistantText.includes(`RECALLED:${RECALL_TOKEN}`),
)

// 并发/重投负向：DSH 的 session/prompt 不 await agent.followup，客户端重投或下一条
// 消息可能在前一轮结束前到达。替身必须像 AgentLoop 一样串行，并按 rpcId 合并重投。
const QUEUE_SESSION = 'session-l10queue01-0000-4000-8000-000000000009'
const queueAgent = (
  await ctx.agents.create({
    sessionId: QUEUE_SESSION,
    meta: { cwd: CWD, agentPreset: 'standard' },
    agentOptions: piProfile,
  })
)?.agent
const queueSession = ctx.sessions.get(QUEUE_SESSION)
const queueCallsBefore = oar.oarCalls.length
oar.oarControl.setPromptDelay(40)
oar.oarControl.resetMaxConcurrentPrompts()

const duplicateSeq = queueSession.seq
const duplicateMessage = createUserMessage({
  content: [{ type: 'text', text: 'duplicate request must run once; __RECALL__' }],
  source: { kind: 'user', rpcId: 'req-l10-duplicate-inflight' },
})
const duplicateFirst = queueAgent.followup(duplicateMessage)
const duplicateSecond = queueAgent.followup(
  createUserMessage({
    content: duplicateMessage.content,
    source: duplicateMessage.source,
  }),
)
const duplicateQueuedVisible =
  queueAgent.inbox.nextTurn.length === 1 &&
  queueAgent.inbox.nextTurn[0]?.source?.rpcId === 'req-l10-duplicate-inflight'
await Promise.all([duplicateFirst, duplicateSecond])
await queueAgent.whenIdle()
await ctx.sessions.flush(queueSession)
const duplicateEvents = queueSession.snapshotEvents().slice(duplicateSeq)
const duplicateCalls = oar.oarCalls.slice(queueCallsBefore)
check(
  'PI_QUEUE',
  '同一 rpcId 的同步重投返回同一个 promise，并且只产生一个等待项（DSH hasPromptRequest 也能看见）',
  duplicateFirst === duplicateSecond && duplicateQueuedVisible,
)
check(
  'PI_QUEUE',
  '同一 rpcId 的 in-flight 重投只打开一个 Pi attempt、只落一条 user/assistant/turn',
  duplicateCalls.length === 1 &&
    duplicateEvents.filter((event) => event.type === 'user/message').length === 1 &&
    duplicateEvents.filter((event) => event.type === 'assistant/message').length === 1 &&
    duplicateEvents.filter((event) => event.type === 'turn/start').length === 1 &&
    duplicateEvents.filter((event) => event.type === 'turn/end').length === 1,
)

const serialSeq = queueSession.seq
const serialCallsBefore = oar.oarCalls.length
oar.oarControl.resetMaxConcurrentPrompts()
const serialFirst = queueAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: 'serial request A; __RECALL__' }],
    source: { kind: 'user', rpcId: 'req-l10-serial-a' },
  }),
)
const serialSecond = queueAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: 'serial request B; __RECALL__' }],
    source: { kind: 'user', rpcId: 'req-l10-serial-b' },
  }),
)
const distinctQueuedVisible = queueAgent.inbox.nextTurn.length === 2
await Promise.all([serialFirst, serialSecond])
await queueAgent.whenIdle()
await ctx.sessions.flush(queueSession)
const serialEvents = queueSession.snapshotEvents().slice(serialSeq)
const serialCalls = oar.oarCalls.slice(serialCallsBefore)
check(
  'PI_QUEUE',
  '两个不同 rpcId 同时到达时都进入队列，不丢请求',
  distinctQueuedVisible &&
    serialEvents.filter((event) => event.type === 'user/message').length === 2 &&
    serialEvents.filter((event) => event.type === 'assistant/message').length === 2,
)
check(
  'PI_QUEUE',
  '同一 DSH session 的 Pi attempt 严格串行（最大并发=1），没有两个 embedded Pi session 争用进程状态',
  serialCalls.length === 2 &&
    oar.oarControl.maxConcurrentPrompts() === 1 &&
    oar.oarControl.activePrompts() === 0 &&
    queueAgent.status === 'idle',
)
oar.oarControl.setPromptDelay(0)

// 旧会话没有 native id：删掉绑定后，下一轮必须用 DSH 历史 Bootstrap，而不是失忆。
const OLD_SESSION = 'session-l10old001-0000-4000-8000-000000000010'
const OLD_TOKEN = 'CS329Z-L10-OLD'
const oldStartIndex = oar.oarCalls.length
const oldAgent = (
  await ctx.agents.create({
    sessionId: OLD_SESSION,
    meta: { cwd: CWD, agentPreset: 'standard' },
    agentOptions: piProfile,
  })
)?.agent
await oldAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: `旧会话第一轮 TOKEN=${OLD_TOKEN}` }],
    source: { kind: 'user', rpcId: 'req-l10-old-first' },
  }),
)
await oldAgent.whenIdle()
const oldFirstCall = oar.oarCalls[oldStartIndex + 1]
const oldNativeId = oldFirstCall?.piSessionId
const oldBindingFile = bindingFileFor(OLD_SESSION)
const oldBindingRemoved = oldBindingFile !== null
if (oldBindingFile !== null) unlinkSync(oldBindingFile)
const oldSecondSeq = oldAgent.session.seq
const OLD_CURRENT = '请回答旧会话下一轮的问题；__RECALL__'
await oldAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: OLD_CURRENT }],
    source: { kind: 'user', rpcId: 'req-l10-old-second' },
  }),
)
await oldAgent.whenIdle()
const oldSecondCall = oar.oarCalls[oldStartIndex + 2]
const oldAssistantText = oldAgent.session
  .snapshotEvents()
  .slice(oldSecondSeq)
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data.message.content)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
const oldRepersisted = bindingFileFor(OLD_SESSION)
check(
  'PI_CONTEXT',
  '旧 DSH 会话绑定丢失时不复用错误/游离 id，而是新开 Pi 会话并注入历史',
  oldBindingRemoved === true &&
    oldSecondCall?.resume === null &&
    typeof oldSecondCall?.piSessionId === 'string' &&
    oldSecondCall.piSessionId !== oldNativeId,
)
check(
  'PI_CONTEXT',
  '旧会话 Bootstrap 同时包含前序 User + Assistant 与当前问题，当前问题只出现一次',
  typeof oldSecondCall?.prompt === 'string' &&
    oldSecondCall.prompt.includes('<dsh_conversation_history>') &&
    oldSecondCall.prompt.includes(`User:\n旧会话第一轮 TOKEN=${OLD_TOKEN}`) &&
    oldSecondCall.prompt.includes('Assistant:') &&
    oldSecondCall.prompt.includes(OAR_STUB_TEXT) &&
    oldSecondCall.prompt.split(OLD_CURRENT).length - 1 === 1,
)
check(
  'PI_CONTEXT',
  '旧会话 Bootstrap 后真的能回忆前轮 token，并写回 assistant/message',
  oldAssistantText.includes(`RECALLED:${OLD_TOKEN}`),
)
check(
  'PI_CONTEXT',
  '旧会话 Bootstrap 打开的新 native id 已重新持久化，下一轮又能走 resume',
  oldRepersisted !== null &&
    JSON.parse(readFileSync(oldRepersisted, 'utf8')).piSessionId === oldSecondCall?.piSessionId,
)

// resume 失败（SessionNotFound）：同样必须回退到新会话 + 历史，不得静默失忆。
const FALLBACK_SESSION = 'session-l10fall001-0000-4000-8000-000000000011'
const FALLBACK_TOKEN = 'CS329Z-L10-FALLBACK'
const fallbackStartIndex = oar.oarCalls.length
const fallbackAgent = (
  await ctx.agents.create({
    sessionId: FALLBACK_SESSION,
    meta: { cwd: CWD, agentPreset: 'standard' },
    agentOptions: piProfile,
  })
)?.agent
await fallbackAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: `resume 前一轮 TOKEN=${FALLBACK_TOKEN}` }],
    source: { kind: 'user', rpcId: 'req-l10-fallback-first' },
  }),
)
await fallbackAgent.whenIdle()
const fallbackFirstCall = oar.oarCalls[fallbackStartIndex + 1]
const fallbackNativeId = fallbackFirstCall?.piSessionId
oar.oarControl.failedResumes.add(fallbackNativeId)
const fallbackSecondSeq = fallbackAgent.session.seq
const FALLBACK_CURRENT = 'resume 失败后仍请回忆；__RECALL__'
await fallbackAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: FALLBACK_CURRENT }],
    source: { kind: 'user', rpcId: 'req-l10-fallback-second' },
  }),
)
await fallbackAgent.whenIdle()
const failedResumeCall = oar.oarCalls[fallbackStartIndex + 2]
const fallbackNewCall = oar.oarCalls[fallbackStartIndex + 3]
const fallbackAssistantText = fallbackAgent.session
  .snapshotEvents()
  .slice(fallbackSecondSeq)
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data.message.content)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
const fallbackBindingFile = bindingFileFor(FALLBACK_SESSION)
const fallbackBinding =
  fallbackBindingFile === null ? null : JSON.parse(readFileSync(fallbackBindingFile, 'utf8'))
check(
  'PI_CONTEXT',
  'Pi resume 返回 SessionNotFound 后自动回退新会话，并在证据里如实记录 resume-failed',
  failedResumeCall?.resume === fallbackNativeId &&
    failedResumeCall?.error?.includes('not found') === true &&
    fallbackNewCall?.resume === null &&
    readEvidence().modelAttempt?.nativeSessionFallback === 'resume-failed' &&
    readEvidence().modelAttempt?.nativeSessionFallbackError?.includes('not found') === true &&
    readEvidence().piContinuityAttempt?.mode === 'bootstrap' &&
    readEvidence().piContinuityAttempt?.fallbackReason?.includes('not found') === true,
)
check(
  'PI_CONTEXT',
  'resume 失败回退的 Bootstrap 含前序 user/assistant 与本轮问题一次，且 token 真被回忆',
  fallbackNewCall?.prompt?.includes('<dsh_conversation_history>') === true &&
    fallbackNewCall.prompt.includes(`TOKEN=${FALLBACK_TOKEN}`) &&
    fallbackNewCall.prompt.includes(OAR_STUB_TEXT) &&
    fallbackNewCall.prompt.split(FALLBACK_CURRENT).length - 1 === 1 &&
    fallbackAssistantText.includes(`RECALLED:${FALLBACK_TOKEN}`),
)
check(
  'PI_CONTEXT',
  'resume 失败后坏绑定被替换成新 native id（不是保留失效 id 让下一轮继续炸）',
  fallbackBinding?.piSessionId === fallbackNewCall?.piSessionId &&
    fallbackNewCall?.piSessionId !== fallbackNativeId,
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
const nativeState = ctx.agents.factory?.target?.[plug.STATE]
const nativeSessionStore = nativeState?.nativeSessionStore ?? null
const nativePiEngine = nativeState?.piEngine ?? null
const observedNativeStoreDir =
  nativeSessionStore?.dir ?? join(piAgentDir, 'dsh-engine-switch', 'native-sessions')
const nativePathBoundary = () => ({
  storeStats: nativeSessionStore === null ? null : deepSnapshot(nativeSessionStore.stats),
  bindingTree: snapshotTree(observedNativeStoreDir),
  piAttempts: nativePiEngine?.stats?.attempts ?? null,
  piAttemptRecords: nativePiEngine?.attempts?.length ?? null,
  oarCalls: oar.oarCalls.length,
})
const nativeBefore = nativeCalls.length
const piEvidenceBefore = readEvidence().piByKind.createAgent
const nativeOptions = {
  sessionId: NATIVE_SESSION,
  meta: {
    cwd: CWD,
    agentPreset: 'standard',
    routeProbe: {
      flags: [true, false, true],
      nested: { mode: 'strict', labels: ['alpha', 'beta'] },
    },
  },
  agentOptions: {
    ...piProfile,
    routingProbe: {
      levels: [
        { id: 1, enabled: true },
        { id: 2, enabled: false },
      ],
      tags: ['one', 'two'],
    },
  },
}
const nativeOptionsBefore = deepSnapshot(nativeOptions)
const nativeBoundaryBeforeCreate = nativePathBoundary()
check(
  'NEG_NATIVE_STORE',
  'binding 操作计数是活信号：Native 测试前 Pi 路径已真实累计 read/write/clear，且 store 没有 create/update/delete 旁路 API',
  nativeSessionStore !== null &&
    nativeSessionStore.stats.read > 0 &&
    nativeSessionStore.stats.write > 0 &&
    nativeSessionStore.stats.clear > 0 &&
    typeof nativeSessionStore.create !== 'function' &&
    typeof nativeSessionStore.update !== 'function' &&
    typeof nativeSessionStore.delete !== 'function',
)
const nativeCreated = await ctx.agents.create(nativeOptions)
const nativeResult = nativeCreated?.agent
const nativeOptionsAfter = deepSnapshot(nativeOptions)
const nativeBoundaryAfterCreate = nativePathBoundary()
const nativeCall = nativeCalls[nativeBefore]

check(
  'NEG_NATIVE',
  'engine=native（选择器）下 create 原样直通原生 target：交回的就是原生 target 的 agent（恒等，不包装）',
  nativeCalls.length === nativeBefore + 1 &&
    nativeResult === NATIVE_SENTINEL &&
    nativeCreated === nativeCall?.result,
)
check(
  'NEG_NATIVE_OPTIONS',
  'Native create 的 caller options 在调用前保存深快照，调用后再次深比较完全不变（含 cwd/meta/agentOptions）',
  isDeepStrictEqual(nativeOptionsAfter, nativeOptionsBefore) &&
    nativeOptionsAfter.meta.cwd === CWD,
)
check(
  'NEG_NATIVE_OPTIONS',
  'Native target 收到的 options 按值深等于调用前快照：嵌套对象/数组逐字段不变（不只比较对象引用）',
  nativeCall?.kind === 'createAgent' &&
    isDeepStrictEqual(nativeCall.options, nativeOptionsBefore) &&
    isDeepStrictEqual(
      nativeCall.options.meta.routeProbe.nested.labels,
      nativeOptionsBefore.meta.routeProbe.nested.labels,
    ) &&
    isDeepStrictEqual(
      nativeCall.options.agentOptions.routingProbe.levels,
      nativeOptionsBefore.agentOptions.routingProbe.levels,
    ),
)
check(
  'NEG_NATIVE_STORE',
  'Native create 前后 binding 存储完整快照不变（路径/类型/mtime/size/content hash 全相等）',
  isDeepStrictEqual(
    nativeBoundaryAfterCreate.bindingTree,
    nativeBoundaryBeforeCreate.bindingTree,
  ),
)
check(
  'NEG_NATIVE_STORE',
  'Native create 的 binding read/write/clear 计数均为 0（write 覆盖 create/update，clear 覆盖 delete）',
  nativeSessionStore !== null &&
    isDeepStrictEqual(
      nativeBoundaryAfterCreate.storeStats,
      nativeBoundaryBeforeCreate.storeStats,
    ) &&
    nativeBoundaryAfterCreate.storeStats.read === nativeBoundaryBeforeCreate.storeStats.read &&
    nativeBoundaryAfterCreate.storeStats.write === nativeBoundaryBeforeCreate.storeStats.write &&
    nativeBoundaryAfterCreate.storeStats.clear === nativeBoundaryBeforeCreate.storeStats.clear,
)
check(
  'NEG_NATIVE',
  'pi 引擎零调用（证据 piByKind.createAgent 未上升）—— 没有偷偷把原生会话交给 pi',
  readEvidence().piByKind.createAgent === piEvidenceBefore &&
    nativeBoundaryAfterCreate.piAttempts === nativeBoundaryBeforeCreate.piAttempts &&
    nativeBoundaryAfterCreate.oarCalls === nativeBoundaryBeforeCreate.oarCalls,
)
check(
  'NEG_NATIVE',
  'Native create 不新增任何 Pi attempt 记录，因此也不可能执行 Bootstrap formatter',
  nativePiEngine !== null &&
    nativeBoundaryAfterCreate.piAttemptRecords ===
      nativeBoundaryBeforeCreate.piAttemptRecords,
)
check(
  'NEG_NATIVE',
  '没有替身污染：原生路径不产生 standIn Agent，也不给会话塞 pi 前缀身份',
  nativeResult?.standIn === undefined && !String(nativeResult?.id ?? '').includes('oar-pi'),
)

const nativeResumeOptions = {
  resumeSessionId: NATIVE_SESSION,
  meta: {
    cwd: CWD,
    agentPreset: 'standard',
    routeProbe: {
      flags: ['resume', false],
      nested: { mode: 'strict-resume', labels: ['gamma', 'delta'] },
    },
  },
  agentOptions: {
    ...piProfile,
    routingProbe: {
      levels: [
        { id: 10, enabled: true },
        { id: 20, enabled: false },
      ],
      tags: ['resume-one', 'resume-two'],
    },
  },
}
const nativeResumeSnapshot = deepSnapshot(nativeResumeOptions)
const nativeResumeBoundaryBefore = nativePathBoundary()
const nativeResumeIndex = nativeCalls.length
await ctx.agents.resume(nativeResumeOptions)
const nativeResumeCall = nativeCalls[nativeResumeIndex]
const nativeResumeBoundaryAfter = nativePathBoundary()
check(
  'NEG_NATIVE_OPTIONS',
  'Native resume 同样保留调用前快照，target 收到的 options 与调用后 caller options 均深相等',
  isDeepStrictEqual(nativeResumeOptions, nativeResumeSnapshot) &&
    nativeResumeCall?.kind === 'resume' &&
    isDeepStrictEqual(nativeResumeCall.options, nativeResumeSnapshot),
)
check(
  'NEG_NATIVE_STORE',
  'Native resume 前后 binding 树不变且 read/write/clear 计数仍为 0',
  nativeSessionStore !== null &&
    isDeepStrictEqual(
      nativeResumeBoundaryAfter.bindingTree,
      nativeResumeBoundaryBefore.bindingTree,
    ) &&
    isDeepStrictEqual(
      nativeResumeBoundaryAfter.storeStats,
      nativeResumeBoundaryBefore.storeStats,
    ),
)
check(
  'NEG_NATIVE',
  'Native resume 不调用 Pi runner、不新增 Bootstrap attempt、不增加 OAR 调用数',
  nativePiEngine !== null &&
    nativeResumeBoundaryAfter.piAttempts === nativeResumeBoundaryBefore.piAttempts &&
    nativeResumeBoundaryAfter.piAttemptRecords ===
      nativeResumeBoundaryBefore.piAttemptRecords &&
    nativeResumeBoundaryAfter.oarCalls === nativeResumeBoundaryBefore.oarCalls,
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
  '原生路径不注册 Agent（注册表里的 standIn 全属于正向 pi 会话；native 两个会话都查不到）',
  ctx.agents
    .list()
    .filter((agent) => agent.standIn === true)
    .every((agent) => !String(agent.id).startsWith('session-l7nat')) &&
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
const coldResumeOarCall = oar.oarCalls.at(-1)
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
check(
  'PI_CONTEXT',
  '宿主冷重启后仍从持久绑定找回同一个 Pi native session id（不是只靠进程内 Map）',
  coldResumeOarCall?.resume === firstNativePiId &&
    coldResumeOarCall?.piSessionId === firstNativePiId,
)

// 冷开之后接着聊：turn 号必须接在磁盘历史之后，且事件必须能落盘
// （真机踩过的坑：seq 与持久化游标错位 → append seq mismatch）
const resumeSeqBefore = resumedSession.seq
resumedAgent.followup(
  createUserMessage({
    content: [{ type: 'text', text: '重启后请复述第一轮 TOKEN；__RECALL__' }],
    source: { kind: 'user', rpcId: 'req-l7-resume-turn' },
  }),
)
let resumeTurnError = null
try {
  await resumedAgent.whenIdle()
} catch (error) {
  resumeTurnError = String(error?.message ?? error)
}
const resumeEvents2 = resumedSession.snapshotEvents().slice(resumeSeqBefore)
const resumeAssistantText = resumeEvents2
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data.message.content)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
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
check(
  'PI_CONTEXT',
  '冷重启后的续聊仍能复述最初 token（Pi 原生会话通过持久 id 真接上，不是只把 DSH 两轮事件堆起来）',
  resumeAssistantText.includes(`RECALLED:${RECALL_TOKEN}`),
)
const cumulativeContinuity = readEvidence().piContinuity
check(
  'PI_CONTEXT',
  'resume 失效信号按类型累计保留：后续恢复正常 resume 不会把此前 fallback 覆盖掉',
  cumulativeContinuity?.attempts >= 10 &&
    cumulativeContinuity?.modeCounts?.resume >= 5 &&
    cumulativeContinuity?.modeCounts?.bootstrap >= 2 &&
    cumulativeContinuity?.fallbackCounts?.['binding-missing'] >= 1 &&
    cumulativeContinuity?.fallbackCounts?.['resume-failed'] >= 1,
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

// ---------------------------------------------------------------------------
// F. Native 负向守卫 mutation：baseline 必须全 HIT；每个独立子进程故障必须
//    在对应断言上 MISS 且 exit=1。故障只注入 target spy，不进生产路由分支。
// ---------------------------------------------------------------------------
const nativeGuardBaseline = await runNativeGuard()
for (const assertion of nativeGuardBaseline.checks) {
  check(
    'NEG_NATIVE_HARNESS',
    `baseline ${assertion.name}（正常 Native 路径不得触发守卫）`,
    assertion.ok,
  )
}

const nativeGuardFaults = [
  ['mutate-meta-cwd', 'NATIVE_OPTIONS_CALLER_SNAPSHOT_STABLE'],
  ['mutate-nested-options', 'NATIVE_OPTIONS_CALLER_SNAPSHOT_STABLE'],
  ['read-binding', 'NATIVE_BINDING_READ_ZERO'],
  ['create-binding', 'NATIVE_BINDING_WRITE_CREATE_UPDATE_ZERO'],
  ['update-binding', 'NATIVE_BINDING_WRITE_CREATE_UPDATE_ZERO'],
  ['clear-binding', 'NATIVE_BINDING_CLEAR_DELETE_ZERO'],
  ['call-pi', 'NATIVE_PI_RUNNER_ZERO'],
  ['call-bootstrap', 'NATIVE_BOOTSTRAP_ZERO'],
]
for (const [fault, expectedMiss] of nativeGuardFaults) {
  const child = spawnSync(
    process.execPath,
    ['--no-warnings', fileURLToPath(import.meta.url), '--native-guard-child', fault],
    {
      cwd: SWITCH,
      env: process.env,
      encoding: 'utf8',
    },
  )
  const stdout = String(child.stdout ?? '')
  const caught =
    child.error === undefined &&
    child.status === 1 &&
    stdout.includes(`[MISS] NATIVE_GUARD :: ${expectedMiss}`) &&
    stdout.includes('GUARD_RESULT: FAIL')
  console.log(
    `[FAULT] ${fault} expected_MISS=${expectedMiss} child_EXIT=${String(child.status)}`,
  )
  check(
    'NEG_NATIVE_MUTATION',
    `${fault} 故障被独立 mutation 捕获：${expectedMiss}=MISS / child exit=1`,
    caught,
  )
}

console.log(`\nSUMMARY: ${pass} HIT / ${fail} MISS`)
console.log(
  'ASSERTION_CLASSES: PI_IDENTITY, PI_SESSION, PI_PERSIST, PI_REGISTRY, PI_STREAM, PI_TURN, PI_CONTEXT, NEG_NATIVE, NEG_NATIVE_OPTIONS, NEG_NATIVE_STORE, NEG_NATIVE_HARNESS, NEG_NATIVE_MUTATION, RESUME, UNLOAD',
)
console.log(fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(fail === 0 ? 0 : 1)
