/**
 * engine-selector.mjs —— 「独立引擎选择器」确定性测试（不调模型）
 *
 * 被测对象：
 *   - engine-intent.mjs   ：引擎词汇 / 取值归一化 / 判定优先级 / 会话绑定表（纯函数）
 *   - engine-command.mjs  ：`/engine` 的命令语法与文案（纯函数）
 *   - index.js            ：路由器接线 + writeEngineSelector + registerEngineCommand
 *
 * 组合（与 preset-routing.mjs 同款）：真实 @deepseek-ai/cordis 的 Context +
 * 真实 @deepseek-ai/dsh-agent 的 AgentRegistry（经 ctx.plugin 装载）+ 真实公开 API
 * ctx.agents.setFactory() 注册「原生 target 替身」+ 真实加载被测插件 index.js。
 *
 * 验证目标（Engine ⊥ Preset）：
 *   1. 正交组合：preset=standard/cordis/minimal × engine=native/pi 六种组合各走各的
 *   2. 优先级：forceEngine > 请求 marker > 会话绑定 > agentPreset 兼容 > 选择器 > native
 *   3. 会话身份：同一会话第一次落在哪个引擎，之后本进程内一直是它（显式改选可解除）
 *   4. `/engine` 命令：注册、show/select/unknown 三态、写盘参数、写盘后真的换路由
 *   5. 负向防误杀：近似取值 / 未知 preset / 未设置选择器 ⇒ 一律原样走原生引擎
 *
 * 退出码：全部 HIT → 0；任一 MISS → 1。
 */
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = join(ROOT, 'dsh-engine-switch')
const imp = (p) => import(pathToFileURL(p).href)

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
const intent = await imp(join(WS, 'engine-intent.mjs'))
const command = await imp(join(WS, 'engine-command.mjs'))

let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/** 造一套引擎替身（记录调用次数，便于断言「谁被调了 / 谁没被调」）。 */
function mkTargets() {
  const calls = {
    native: { createAgent: 0, resume: 0 },
    pi: { createAgent: 0, resume: 0 },
    echo: { createAgent: 0, resume: 0 },
  }
  const mark = (who, kind) => async (_c, options) => {
    calls[who][kind]++
    return { handledBy: who, kind, options }
  }
  const nativeTarget = { createAgent: mark('native', 'createAgent'), resume: mark('native', 'resume') }
  const piEngine = { createAgent: mark('pi', 'createAgent'), resume: mark('pi', 'resume') }
  const echoEngine = { createAgent: mark('echo', 'createAgent'), resume: mark('echo', 'resume') }
  return { calls, nativeTarget, piEngine, echoEngine }
}

// ===========================================================================
// A. 引擎词汇与取值归一化（负向防误杀的第一道闸）
// ===========================================================================
check('VOCAB', 'ENGINE_IDS 恰为 native/pi/echo 三项且顺序固定', JSON.stringify(intent.ENGINE_IDS) === JSON.stringify(['native', 'pi', 'echo']))
check(
  'VOCAB',
  'index.js 转出的 ECHO_ENGINE_ID 与 engine-intent 同值（词汇单点定义未漂移）',
  plug.ECHO_ENGINE_ID === intent.ECHO_ENGINE_ID && plug.PI_ENGINE_ID === intent.PI_ENGINE_ID,
)

const accepted = ['native', 'pi', 'echo']
const rejected = ['PI', 'Pi', 'pi ', ' pi', 'pi-lite', 'native2', 'auto', '', ' ', null, undefined, 0, 1, true, false, {}, [], Symbol.for('pi')]
check(
  'NORMALIZE',
  `精确取值全部通过（${accepted.join('/')}）`,
  accepted.every((v) => intent.normalizeEngineId(v) === v),
)
check(
  'NORMALIZE',
  `近似/非字符串取值一律归一化为 null（${rejected.length} 例）`,
  rejected.every((v) => intent.normalizeEngineId(v) === null),
)

check(
  'MARKER',
  "meta.engine='pi' → requestMarker pi",
  command !== undefined && intent.engineMarkerOf({ meta: { engine: 'pi' } }) === 'pi',
)
check(
  'MARKER',
  "顶层 options.engine='echo' → requestMarker echo",
  intent.engineMarkerOf({ engine: 'echo' }) === 'echo',
)
check(
  'MARKER',
  "跨字段串味保持改造前语义（meta.engine='echo' + options.engine='pi' → pi，pi 先于 echo）",
  intent.engineMarkerOf({ meta: { engine: 'echo' }, engine: 'pi' }) === 'pi',
)
check(
  'MARKER',
  "新增取值 meta.engine='native' → requestMarker native（显式要求原生）",
  intent.engineMarkerOf({ meta: { engine: 'native' } }) === 'native',
)
check(
  'MARKER',
  '近似取值 meta.engine=\'PI\' → null（不作数，不误杀）',
  intent.engineMarkerOf({ meta: { engine: 'PI' } }) === null,
)

check(
  'SESSION_ID',
  "sessionIdOf 认 sessionId 与 resumeSessionId 两种写法，缺失/空串 → null",
  intent.sessionIdOf({ sessionId: 's1' }) === 's1' &&
    intent.sessionIdOf({ resumeSessionId: 's2' }) === 's2' &&
    intent.sessionIdOf({ sessionId: '' }) === null &&
    intent.sessionIdOf(null) === null,
)

// ===========================================================================
// B. 会话 → 引擎 绑定表
// ===========================================================================
const b = intent.createEngineBindings()
check('BINDING', '空表：get 返回 null、size 为 0', b.get('x') === null && b.size() === 0)
check('BINDING', 'bind 后可读回，size 递增', b.bind('s1', 'pi') === true && b.get('s1') === 'pi' && b.size() === 1)
check('BINDING', 'bind 取值不作数时拒写（不产生脏绑定）', b.bind('s2', 'PI') === false && b.get('s2') === null && b.size() === 1)
check('BINDING', 'bind 会话身份为空时拒写', b.bind('', 'pi') === false && b.bind(null, 'pi') === false && b.size() === 1)
check('BINDING', 'bind 幂等覆盖（同会话换引擎就地改写）', b.bind('s1', 'echo') === true && b.get('s1') === 'echo')
check('BINDING', 'clear 解除后读回 null，重复 clear 返回 false', b.clear('s1') === true && b.get('s1') === null && b.clear('s1') === false)
check(
  'BINDING',
  'snapshot 是普通对象（可 JSON 落盘），种子 initial 走同一套归一化',
  typeof b.snapshot() === 'object' &&
    intent.createEngineBindings({ initial: { a: 'pi', b: 'PI' } }).snapshot().a === 'pi' &&
    intent.createEngineBindings({ initial: { a: 'pi', b: 'PI' } }).snapshot().b === undefined,
)

// ===========================================================================
// C. 判定优先级（纯函数，逐条钉死）
// ===========================================================================
const r1 = intent.resolveEngineIntent({
  forcedRoute: 'pi',
  requestMarker: 'echo',
  sessionBinding: 'native',
  presetMatched: true,
  configEngine: 'echo',
})
check('PRECEDENCE', '1 forceEngine 压过其余全部来源', r1.engine === 'pi' && r1.source === 'forceEngine')
const r2 = intent.resolveEngineIntent({
  forcedRoute: null,
  requestMarker: 'echo',
  sessionBinding: 'native',
  presetMatched: true,
  configEngine: 'pi',
})
check('PRECEDENCE', '2 请求 marker 压过会话绑定/preset/选择器', r2.engine === 'echo' && r2.source === 'requestMarker')
const r3 = intent.resolveEngineIntent({ sessionBinding: 'pi', presetMatched: true, configEngine: 'echo' })
check('PRECEDENCE', '3 会话绑定压过 preset 兼容与选择器（会话身份 ≥ 全局缺省）', r3.engine === 'pi' && r3.source === 'sessionBinding')
const r4 = intent.resolveEngineIntent({ presetMatched: true, configEngine: 'native' })
check('PRECEDENCE', '4 preset 兼容命中压过选择器（存量 agentPreset:pi 会话不被全局缺省改写）', r4.engine === 'pi' && r4.source === 'agentPreset')
const r5 = intent.resolveEngineIntent({ configEngine: 'echo' })
check('PRECEDENCE', '5 选择器命中（config.engine）', r5.engine === 'echo' && r5.source === 'config')
const r6 = intent.resolveEngineIntent({})
check('PRECEDENCE', '6 无任何来源 → native/default', r6.engine === 'native' && r6.source === 'default')
const r7 = intent.resolveEngineIntent({ configEngine: 'native', requestMarker: null, sessionBinding: null })
check('PRECEDENCE', '选择器显式 native 也是「命中来源」而非回落（可观测来源可区分）', r7.engine === 'native' && r7.source === 'config')
const r8 = intent.resolveEngineIntent({ presetMatched: false, configEngine: null, requestMarker: null, sessionBinding: null, forcedRoute: null })
check('NEG_PRECEDENCE', '全部来源缺省/不作数 → 严格走原生（负向防误杀）', r8.engine === 'native' && r8.source === 'default')

// ===========================================================================
// D. 路由器接线：正交组合 + 会话身份 + 负向防误杀
// ===========================================================================
const mkRouter = (hooks) => {
  const t = mkTargets()
  const router = plug.createRouter(t.nativeTarget, t.echoEngine, t.piEngine, hooks)
  return { t, router }
}
const callWith = (router, kind, options) => router[kind]({}, options)

// 正交：preset=standard + engine=pi ⇒ pi（引擎与预设互不绑架）
const o1 = mkRouter({ readConfigEngine: () => 'pi' })
await callWith(o1.router, 'createAgent', { meta: { agentPreset: 'standard' }, sessionId: 'o1' })
check(
  'ORTHOGONAL',
  '标准模式(standard) + Pi 引擎 ⇒ 交给 pi 引擎',
  o1.t.calls.pi.createAgent === 1 && o1.t.calls.native.createAgent === 0,
)
const o2 = mkRouter({ readConfigEngine: () => 'pi' })
await callWith(o2.router, 'createAgent', { meta: { agentPreset: 'cordis' }, sessionId: 'o2' })
check(
  'ORTHOGONAL',
  '创造模式(cordis) + Pi 引擎 ⇒ 交给 pi 引擎（同一引擎可配任意预设）',
  o2.t.calls.pi.createAgent === 1 && o2.t.calls.native.createAgent === 0,
)
const o3 = mkRouter({ readConfigEngine: () => 'pi' })
await callWith(o3.router, 'resume', { meta: { agentPreset: 'minimal' }, sessionId: 'o3' })
check(
  'ORTHOGONAL',
  '极简模式(minimal) + Pi 引擎 ⇒ resume 同样交给 pi 引擎',
  o3.t.calls.pi.resume === 1 && o3.t.calls.native.resume === 0,
)
const o4 = mkRouter({ readConfigEngine: () => 'native' })
await callWith(o4.router, 'createAgent', { meta: { agentPreset: 'standard' }, sessionId: 'o4' })
check(
  'ORTHOGONAL',
  '标准模式(standard) + 原生引擎 ⇒ 严格走原生（选择器没有把引擎强加给会话）',
  o4.t.calls.native.createAgent === 1 && o4.t.calls.pi.createAgent === 0,
)
const o5 = mkRouter({ readConfigEngine: () => 'echo' })
await callWith(o5.router, 'createAgent', { meta: { agentPreset: 'ptc' }, sessionId: 'o5' })
check(
  'ORTHOGONAL',
  'PTC 模式(ptc) + 回声引擎 ⇒ 交给回声引擎（第三个引擎同样正交）',
  o5.t.calls.echo.createAgent === 1 && o5.t.calls.native.createAgent === 0 && o5.t.calls.pi.createAgent === 0,
)

// 会话身份：第一次落在哪就记住哪，显式解除后才跟随选择器
const shared = intent.createEngineBindings()
const s1 = mkRouter({ readConfigEngine: () => 'native', bindings: shared })
await callWith(s1.router, 'createAgent', { meta: { engine: 'pi' }, sessionId: 'sess-A' })
check(
  'SESSION_IDENTITY',
  '请求 marker 定下 pi 后，该会话被记为 pi',
  s1.t.calls.pi.createAgent === 1 && shared.get('sess-A') === 'pi',
)
await callWith(s1.router, 'resume', { sessionId: 'sess-A' })
check(
  'SESSION_IDENTITY',
  '同一会话后续 resume 未带 marker，仍按会话身份走 pi（不被选择器的 native 改写）',
  s1.t.calls.pi.resume === 1 && s1.t.calls.native.resume === 0,
)
await callWith(s1.router, 'createAgent', { sessionId: 'sess-B' })
check(
  'SESSION_IDENTITY',
  '另一个会话没有历史身份 ⇒ 跟随选择器走原生',
  s1.t.calls.native.createAgent === 1 && shared.get('sess-B') === 'native',
)
shared.clear('sess-A')
const s1b = mkRouter({ readConfigEngine: () => 'native', bindings: shared })
await callWith(s1b.router, 'resume', { sessionId: 'sess-A' })
check(
  'SESSION_IDENTITY',
  '显式解除绑定后，同一会话重新跟随选择器（走原生）',
  s1b.t.calls.native.resume === 1 && s1b.t.calls.pi.resume === 0,
)

// 负向防误杀（路由器级）
const n1 = mkRouter({ readConfigEngine: () => null })
await callWith(n1.router, 'createAgent', { meta: { agentPreset: 'minimal' }, sessionId: 'n1' })
await callWith(n1.router, 'resume', { meta: { agentPreset: 'standard' }, sessionId: 'n2' })
await callWith(n1.router, 'createAgent', { meta: { engine: 'PI' }, sessionId: 'n3' })
await callWith(n1.router, 'resume', { meta: { engine: 'pi-lite' }, sessionId: 'n4' })
await callWith(n1.router, 'createAgent', { sessionId: 'n5' })
check(
  'NEG_NO_MISROUTE',
  '选择器未设置 + 未知/近似 marker + 非 pi 预设 ⇒ 5 次调用全部原样走原生',
  n1.t.calls.native.createAgent === 3 &&
    n1.t.calls.native.resume === 2 &&
    n1.t.calls.pi.createAgent === 0 &&
    n1.t.calls.pi.resume === 0 &&
    n1.t.calls.echo.createAgent === 0,
)
const n2 = mkRouter({ readConfigEngine: () => 'native' })
await callWith(n2.router, 'createAgent', { meta: { agentPreset: 'pi' }, sessionId: 'n6' })
check(
  'NEG_LEGACY_KEEP',
  "存量 meta.agentPreset='pi' 会话在选择器为 native 时仍走 pi（兼容路径未被删掉）",
  n2.t.calls.pi.createAgent === 1 && n2.t.calls.native.createAgent === 0,
)
const n3 = mkRouter({ forceEngine: 'pi', readConfigEngine: () => 'native' })
await callWith(n3.router, 'createAgent', { meta: { agentPreset: 'standard' }, sessionId: 'n7' })
check(
  'NEG_FORCE_STILL_FIRST',
  'forceEngine 硬开关仍然压过独立选择器（回归面：改造没有削弱强制路由）',
  n3.t.calls.pi.createAgent === 1 && n3.t.calls.native.createAgent === 0,
)

// ===========================================================================
// E. `/engine` 命令语法与文案（纯函数）
// ===========================================================================
check('CMD_PARSE', "空入参 / 纯空白 ⇒ show", command.parseEngineCommand('').kind === 'show' && command.parseEngineCommand('   ').kind === 'show')
check(
  'CMD_PARSE',
  '精确取值 ⇒ select（含两端空白容忍）',
  command.parseEngineCommand('pi').engine === 'pi' &&
    command.parseEngineCommand('  native  ').engine === 'native' &&
    command.parseEngineCommand('echo').engine === 'echo',
)
check(
  'CMD_PARSE',
  '近似取值 ⇒ unknown 且回显原文（不猜成 pi）',
  command.parseEngineCommand('PI').kind === 'unknown' &&
    command.parseEngineCommand('pi-lite').token === 'pi-lite' &&
    command.parseEngineCommand('PI').token === 'PI',
)
check('CMD_PARSE', '多参数 / 非文本 ⇒ 不作数（unknown / invalid）', command.parseEngineCommand('pi echo').kind === 'unknown' && command.parseEngineCommand(42).kind === 'invalid')

const showText = command.showResultText({ selectorEngine: 'pi', sessionEngine: 'native', sessionId: 's1' })
check(
  'CMD_TEXT',
  'show 文案含选择器值、本会话值与全部可选值',
  showText.includes('Pi 引擎') && showText.includes('本会话') && showText.includes('native | pi | echo'),
)
const showUnset = command.showResultText({ selectorEngine: null, sessionId: 's1' })
check('CMD_TEXT', 'show 在选择器未设置时如实说「未设置」，不假装有值', showUnset.includes('未设置'))
const selectOk = command.selectResultText({ engine: 'pi', bindingCleared: false })
check(
  'CMD_TEXT',
  'select 文案说清「之后新建/重新载入的任务生效」而不是假装当前会话已切换',
  selectOk.includes('Pi 引擎') && selectOk.includes('新建') && selectOk.includes('不受影响'),
)
const selectCleared = command.selectResultText({ engine: 'echo', bindingCleared: true })
check('CMD_TEXT', 'select 文案在解除本会话绑定时如实说明', selectCleared.includes('绑定已解除'))
const errUnknown = command.errorResultText({ error: 'unknown-engine', token: 'PI' })
check('CMD_TEXT', 'unknown 文案回显原文并列出可选值', errUnknown.includes('PI') && errUnknown.includes('native | pi | echo'))
check(
  'CMD_TEXT',
  '其余失败原因各有专文案（settings 缺失 / 命名空间缺失 / 写失败）',
  command.errorResultText({ error: 'settings-unavailable' }).includes('settings') &&
    command.errorResultText({ error: 'namespace-unavailable', detail: 'engine-switch' }).includes('engine-switch') &&
    command.errorResultText({ error: 'write-failed', detail: 'boom' }).includes('boom'),
)
check('CMD_TEXT', '未知 error 键不静默：文案里带上原 key', command.errorResultText({ error: 'some-new-failure' }).includes('some-new-failure'))

// ===========================================================================
// F. writeEngineSelector：设置页/命令共用的写入口（用替身 settings 服务）
// ===========================================================================
const mkSettingsCtx = (impl) => ({ get: (key) => (key === 'settings' ? impl : undefined) })
const writes = []
const okCtx = mkSettingsCtx({
  describe: () => [{ ns: 'engine-switch', revision: 7 }],
  update: async (ns, patch, rev) => {
    writes.push({ ns, patch, rev })
  },
})
const w1 = await plug.writeEngineSelector(okCtx, 'engine-switch', 'pi')
check(
  'WRITE',
  '正常写入：带上 namespace / 归一化后的值 / 读到的 revision',
  w1.ok === true && writes.length === 1 && writes[0].ns === 'engine-switch' && writes[0].patch.engine === 'pi' && writes[0].rev === 7,
)
const w2 = await plug.writeEngineSelector(okCtx, 'engine-switch', 'PI')
check('WRITE', '近似取值在写入口就被挡下（unknown-engine，且没有落到 update）', w2.ok === false && w2.error === 'unknown-engine' && writes.length === 1)
const w3 = await plug.writeEngineSelector(mkSettingsCtx(undefined), 'engine-switch', 'pi')
check('WRITE', 'settings 服务缺席 ⇒ settings-unavailable（不抛、不静默）', w3.ok === false && w3.error === 'settings-unavailable')
const w4 = await plug.writeEngineSelector(mkSettingsCtx({ describe: () => [], update: async () => {} }), 'engine-switch', 'pi')
check('WRITE', '命名空间不在 describe 里 ⇒ namespace-unavailable 并回显 ns', w4.ok === false && w4.error === 'namespace-unavailable' && w4.detail === 'engine-switch')
const w5 = await plug.writeEngineSelector(
  mkSettingsCtx({
    describe: () => [{ ns: 'engine-switch', revision: 1 }],
    update: async () => {
      throw new Error('stale')
    },
  }),
  'engine-switch',
  'pi',
)
check('WRITE', 'provider 拒绝（如 revision 冲突）⇒ write-failed 且带上原因', w5.ok === false && w5.error === 'write-failed' && String(w5.detail).includes('stale'))

// ===========================================================================
// F2. entry id 解析（真机启动里踩过的坑：树内限定 id ≠ 声明 id）
// ===========================================================================
check(
  'ENTRY_ID',
  '有 loader 条目时取【声明 id】而不是树内限定 id（真机 bundle patch 的 insert 行实测是 include:engine-switch）',
  JSON.stringify(plug.resolveEngineEntryId({ id: 'include:engine-switch', options: { id: 'engine-switch' } }, {})) ===
    JSON.stringify({ entryId: 'engine-switch', source: 'fiber-options' }),
)
check(
  'ENTRY_ID',
  '只有限定 id 时如实回落并标明来源（不假装拿到了声明 id）',
  JSON.stringify(plug.resolveEngineEntryId({ id: 'include:engine-switch' }, {})) ===
    JSON.stringify({ entryId: 'include:engine-switch', source: 'fiber-entry' }),
)
check(
  'ENTRY_ID',
  '无 loader 条目时回落 config.entryId（裸 cordis 组装路径）',
  JSON.stringify(plug.resolveEngineEntryId(undefined, { entryId: 'my-engine' })) ===
    JSON.stringify({ entryId: 'my-engine', source: 'config' }),
)
check(
  'ENTRY_ID',
  '什么都没有时回落内置缺省 engine-switch',
  JSON.stringify(plug.resolveEngineEntryId(undefined, {})) ===
    JSON.stringify({ entryId: 'engine-switch', source: 'default' }) &&
    plug.DEFAULT_ENTRY_ID === 'engine-switch',
)

// ===========================================================================
// G. 真实组合：cordis + AgentRegistry + 插件 + `/engine` 命令 + 写盘后真的换路由
// ===========================================================================
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
/** 证据落盘路径（临时目录）：本套件读真实运行期落下的证据 JSON，不靠内存变量。 */
const evidenceDir = mkdtempSync(join(tmpdir(), 'dsh-engine-selector-'))
const evidenceFile = join(evidenceDir, 'engine-selector-evidence.json')
const readEvidence = () => JSON.parse(readFileSync(evidenceFile, 'utf8'))
const pluginConfig = plug.Config({ engine: 'native', evidencePath: evidenceFile })

const ctx = new Context()
ctx.provide('sessionProjections', { register: async () => ({ dispose() {} }) })
const commands = { registered: null, register(definition) { this.registered = definition; return () => {} } }
ctx.provide('commands', commands)
const gWrites = []
ctx.provide('settings', {
  describe: () => [{ ns: 'engine-switch', revision: 3 }],
  update: async (ns, patch, rev) => {
    gWrites.push({ ns, patch, rev })
    // 模拟 loader 的 _commitVolatile：配置层变化后，volatile 引用换成新值。
    pluginConfig.engine[VOLATILE_WRITE](patch.engine)
  },
})
ctx.plugin(AgentRegistry)
await tick(50)
// 只放一个「原生 target 替身」：pi / echo 两个引擎由插件自己构造（真实现），
// 所以「谁被调了」的断言要读证据里的 piByKind/nativeByKind，而不是替身里的计数器。
const g = mkTargets()
ctx.agents.setFactory(g.nativeTarget)
const gFiber = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply }, pluginConfig)
await tick(120)

check(
  'E2E',
  '真实 cordis 组合下 factory 槽位被替换为插件路由器（router[STATE] 可观察、原生 target 已暂存）',
  ctx.agents.factory?.target?.[plug.STATE] !== undefined &&
    ctx.agents.factory?.target?.nativeTarget === g.nativeTarget,
)
check(
  'E2E',
  '证据里记下了引擎选择器初值 native（volatile 现读，阶段 apply）',
  readEvidence().engineSelector === 'native' && readEvidence().engineSelectorPhase === 'apply',
)
check(
  'E2E',
  'entry id 解析：无 loader 时回落到 config.entryId 且来源如实记为 config',
  readEvidence().engineEntryId === 'engine-switch' && readEvidence().engineEntryIdSource === 'config',
)

check('E2E', '/engine 已注册进 commands 服务（输入区域菜单可见）', commands.registered?.name === 'engine')
check(
  'E2E',
  '/engine 的描述与入参提示来自 engine-command.mjs（单一文案来源）',
  commands.registered?.description === command.ENGINE_COMMAND_DESCRIPTION &&
    commands.registered?.input?.hint === command.ENGINE_COMMAND_HINT,
)
check(
  'E2E',
  '/engine 不把命令原文写进会话史（recordInput: false，权威记录在 settings 文档）',
  commands.registered?.recordInput === false,
)

const handler = commands.registered.handler
const showRes = await handler({ agent: { session: { id: 'sess-before' } }, rawInput: '' })
check('E2E', '/engine（无参数）返回 success 且是「展示」文案', showRes.kind === 'success' && showRes.text.includes('引擎选择器'))

// —— 写盘前：标准模式 + 选择器 native ⇒ 原生 ——
await ctx.agents.create({ sessionId: 'sess-before', meta: { agentPreset: 'standard' } })
check(
  'E2E',
  '写盘前：标准模式 + 选择器 native ⇒ 交给原生 target（nativeByKind.createAgent=1，piByKind=0）',
  readEvidence().nativeByKind.createAgent === 1 && readEvidence().piByKind.createAgent === 0,
)
check(
  'E2E',
  '写盘前证据判定为 {engine:native, source:config}（选择器的 schema 默认值也在「做决定」，来源如实可查）',
  readEvidence().engineIntent?.engine === 'native' && readEvidence().engineIntent?.source === 'config',
)

// —— 切换：/engine pi ——
const selectRes = await handler({ agent: { session: { id: 'sess-before' } }, rawInput: ' pi ' })
check(
  'E2E',
  '/engine pi 返回 success，且写盘参数正确（ns / 归一化值 / 读到的 revision）',
  selectRes.kind === 'success' &&
    gWrites.length === 1 &&
    gWrites[0].ns === 'engine-switch' &&
    gWrites[0].patch.engine === 'pi' &&
    gWrites[0].rev === 3,
)
check('E2E', '/engine pi 文案提示「之后新建/重新载入的任务生效」', selectRes.text.includes('新建'))
check(
  'E2E',
  '/engine pi 是「显式改选」：解除该会话的历史绑定（否则绑定会压过选择器）',
  readEvidence().commandLastBindingCleared === true,
)

// —— 负向：近似取值不误命中、不写盘 ——
const unknownRes = await handler({ agent: { session: { id: 'sess-before' } }, rawInput: 'PI' })
check(
  'E2E',
  '/engine PI 返回 error、不写盘、文案列出可选值（负向防误杀）',
  unknownRes.kind === 'error' && gWrites.length === 1 && unknownRes.text.includes('native | pi | echo'),
)

// —— 选择器的现读：写盘后 show 应该报 Pi ——
const showAfter = await handler({ agent: { session: { id: 'sess-before' } }, rawInput: '' })
check(
  'E2E',
  '写盘后 /engine（show）现读选择器已是 Pi（volatile 引用真的换了值）',
  readEvidence().engineSelector === 'pi' && showAfter.text.includes('Pi 引擎'),
)

// —— 生效：同一个 preset，新建的会话由 pi 引擎接管 ——
await ctx.agents.create({ sessionId: 'sess-pi', meta: { agentPreset: 'standard' } })
check(
  'E2E',
  '写盘后：同一个标准模式会话 ⇒ 改由 pi 引擎接管（delegationsToPi/piByKind 上升，原生不再多接一次）',
  readEvidence().engineIntent?.engine === 'pi' &&
    readEvidence().piByKind.createAgent === 1 &&
    readEvidence().nativeByKind.createAgent === 1,
)
check(
  'E2E',
  '证据里记下了判定来源为 config（不是 forceEngine / agentPreset / marker）',
  readEvidence().engineIntent?.source === 'config' && readEvidence().engineSourceCounts.config >= 1,
)
check(
  'E2E',
  '证据里按来源计数：选择器决定多次、会话绑定决定 1 次、default 从未出现（schema 默认值让选择器总是在决定）',
  readEvidence().engineSourceCounts.config >= 2 && readEvidence().engineSourceCounts.default === 0,
)

// —— 会话身份：resume 未带任何意图时，按本会话已绑定的引擎走 ——
await ctx.agents.resume({ resumeSessionId: 'sess-pi' })
check(
  'E2E',
  'resume 同一会话（未带 marker）⇒ 按会话绑定走 pi（来源 sessionBinding）',
  readEvidence().engineIntent?.engine === 'pi' &&
    readEvidence().engineIntent?.source === 'sessionBinding' &&
    readEvidence().piByKind.resume === 1,
)
check(
  'E2E',
  '证据里记下了会话绑定（sess-pi → pi），且被显式改选过的 sess-before 已从绑定表移除',
  readEvidence().engineBindings?.['sess-pi'] === 'pi' &&
    readEvidence().engineBindings?.['sess-before'] === undefined &&
    readEvidence().engineBindingCount >= 1,
)

// —— 切回原生：显式改选解除绑定后，同一会话下次落回原生 ——
const closeRes = await handler({ agent: { session: { id: 'sess-pi' } }, rawInput: 'native' })
check(
  'E2E',
  '/engine native 把选择器切回原生、解除本会话绑定并如实说明',
  closeRes.kind === 'success' &&
    gWrites.length === 2 &&
    gWrites[1].patch.engine === 'native' &&
    readEvidence().commandLastBindingCleared === true,
)
await ctx.agents.create({ sessionId: 'sess-native', meta: { agentPreset: 'standard' } })
check(
  'E2E',
  '切回后：新建会话重新走原生（nativeByKind.createAgent=2，pi 不再上升）',
  readEvidence().nativeByKind.createAgent === 2 && readEvidence().piByKind.createAgent === 1,
)
check(
  'E2E',
  '命令执行累计与最后一次结果都记在证据里（共 5 次调用，最后一次 native）',
  readEvidence().commandRuns === 5 && readEvidence().commandLastEngine === 'native',
)
check(
  'E2E',
  '来源配比精确可查：config×3（三次 create）+ sessionBinding×1（一次 resume）+ default×0',
  readEvidence().engineSourceCounts.config === 3 &&
    readEvidence().engineSourceCounts.sessionBinding === 1 &&
    readEvidence().engineSourceCounts.default === 0 &&
    readEvidence().engineSourceCounts.forceEngine === 0 &&
    readEvidence().engineSourceCounts.agentPreset === 0 &&
    readEvidence().engineSourceCounts.requestMarker === 0,
)

await gFiber.dispose()
await tick(40)
check('E2E', '卸载后 factory 槽位还原为原生 target 本体（零残留劫持）', ctx.agents.factory?.target === g.nativeTarget)
rmSync(evidenceDir, { recursive: true, force: true })

console.log(`\nSUMMARY: ${pass} HIT / ${fail} MISS`)
console.log(
  'ASSERTION_CLASSES: VOCAB, NORMALIZE, MARKER, SESSION_ID, BINDING, PRECEDENCE, NEG_PRECEDENCE, ORTHOGONAL, SESSION_IDENTITY, NEG_NO_MISROUTE, NEG_LEGACY_KEEP, NEG_FORCE_STILL_FIRST, CMD_PARSE, CMD_TEXT, WRITE, ENTRY_ID, E2E',
)
console.log(fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(fail === 0 ? 0 : 1)
