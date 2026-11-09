/**
 * pi-models-sync.mjs —— 「Pi 引擎 ⇄ DSH 模型选择器」联动的确定性测试（L8）
 *
 * ## 为什么需要这一套（L8 现场）
 *
 * L7 之后桌面端在 `engine: pi` 下已经能建会话、能出话，但**模型面还是断的**：
 *   · DSH 的模型目录（`session.modelCatalog()` → `dsh-api-session-controller` 的
 *     `buildModelCatalog`）只读宿主 `ctx.llm` 的注册表；插件没往里注册任何东西 ⇒
 *     切到 Pi 之后列表里看不出 Pi 的模型（「模型列表不跟着 Pi 走」）；
 *   · `oar-engine.mjs` 里 provider/model 是**写死**的 ⇒ 在 UI 里选了模型也不会被 pi 用上
 *     （「选了不生效」）。
 *
 * 本套件把这两条闭环钉死，并且**连带把负向面钉死**：切回 Native 时 `pi` provider 必须
 * 从宿主注册表里消失、目录不得被列过、原生路径逐字直通（零替身污染）。
 *
 * ## 本套件测什么（真实内存 / 真实契约，不调模型、不联网）
 *
 * 组合是真的：真实 `@deepseek-ai/cordis` Context + 真实 `@deepseek-ai/dsh-llm` 的
 * **LlmRuntime**（宿主目录读的就是它）+ 真实 AgentRegistry + 真实 SessionStore +
 * 真实加载被测插件 `index.js`。替身只有两处，且都标注清楚：
 *   · `@botiverse/oar` 模块替身（不 spawn 任何子进程、不打任何模型；可配的模型清单 +
 *     记录每次 `piSession` 收到的 options）；
 *   · 原生 target 替身（`setFactory` 是上游公开 API）。
 *
 * 断言分组：
 *   PI_SOURCE     目录来源：OAR 优先 / models.json 兜底 / 归一化规则（disabled 剔除、id 不改写）
 *   PI_ADAPTER    适配器形状：DTO 投影、INVALID_CATALOG 不触发、UNKNOWN_MODEL、目录面之外的明确拒绝
 *   PI_CATALOG    engine=pi 时目录真的出现在宿主投影里（宿主同款三步读法）
 *   PI_SELECTION  宿主 `selectModel` 的准入路径：requireModel + resolveCallConfig 都能过
 *   PI_EXEC       透传：attempt 真的把选区交给 pi（含**中途换模型**与回落的如实标注）
 *   PI_LATE       llm 服务后到也能接上；llm 缺席时不拖累接管
 *   NEG_NATIVE    engine=native：provider 注销、目录不列、原生直通、零替身污染
 *   UNLOAD        插件卸载：provider 归还给宿主（不留残骸）
 *
 * 退出码：全部 HIT → 0；任一 MISS → 1。
 */
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = join(ROOT, 'dsh-engine-switch')
const imp = (p) => import(pathToFileURL(p).href)

// ---------------------------------------------------------------------------
// 替身 ①：@botiverse/oar —— 真货会 spawn pi 子进程并调真实模型；本套件不碰网络。
// 通过 globalThis 与测试互通：可配的模型清单 + 每次 piSession 收到的 options 记录。
// ---------------------------------------------------------------------------
const OAR_STUB_TEXT = 'PI_MODELS_STUB_TEXT'
const OAR_STUB = `
export const defaultRuntimes = {
  require(id) {
    return {
      id,
      installation: async () => ({ kind: 'available' }),
      listModels: async (_installation, options) => {
        globalThis.__l8.listCalls.push({ id, options })
        return globalThis.__l8.listResult
      },
    }
  },
}
export const piSession = async (_installation, options) => {
  globalThis.__l8.sessionCalls.push({ options })
  return {
    options,
    // 真 OAR 会读回实际生效的模型并**校验与请求一致**（不一致就抛）；
    // 替身照抄这条语义，于是「读回 == 请求」才成立。
    model: () => ({ value: options.model }),
    dispose: async () => {},
  }
}
export const promptAndWait = async (_session, text) => ({
  outcome: { kind: 'completed' },
  text: text + ' [' + ${JSON.stringify(OAR_STUB_TEXT)} + ']',
})
`
const OAR_STUB_URL = `data:text/javascript,${encodeURIComponent(OAR_STUB)}`

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
const { createUserMessage, LlmRuntime } = await imp(join(NM, 'dsh-llm/lib/index.js'))
const plug = await imp(join(WS, 'index.js'))
const models = await imp(join(WS, 'pi-models.mjs'))

let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 替身 ②：native target（setFactory 是上游公开 API）
// ---------------------------------------------------------------------------
function createNativeTarget(name = 'native-agent-sentinel') {
  const calls = []
  const sentinel = { id: name, standIn: undefined }
  const target = {
    async createAgent(_ctx, options) {
      const result = { agent: sentinel, dispose: async () => {} }
      calls.push({ kind: 'createAgent', options, result })
      return result
    },
    async resume(_ctx, options) {
      const result = { agent: sentinel, dispose: async () => {} }
      calls.push({ kind: 'resume', options, result })
      return result
    },
  }
  return { target, calls, sentinel }
}

/**
 * 宿主同款目录投影（`dsh-api-session-controller` 的 buildModelCatalog 的三步读法：
 * `listProviders()` → `listModels(id)` → `resolveModelInfo(id, model.id)`，失败隔离成 failures）。
 * 刻意不去 import 那个内部函数（它没导出），而是逐字照它读的三个接口调用：
 * 这三个接口就是 LlmRuntime 的公开面，也是本插件唯一被允许碰的面。
 */
async function projectCatalog(llm) {
  const groups = []
  const failures = []
  for (const provider of llm.listProviders()) {
    try {
      const list = await llm.listModels(provider.id)
      const entries = []
      for (const model of list) {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        entries.push({
          id: model.id,
          name: model.name,
          description: model.description,
          reasoning: info.reasoning,
        })
      }
      if (entries.length > 0) groups.push({ id: provider.id, name: provider.name, models: entries })
    } catch (error) {
      failures.push({ id: provider.id, message: String(error?.message ?? error) })
    }
  }
  return { groups, failures }
}

// ---------------------------------------------------------------------------
// 共享替身状态（globalThis.__l8）
// ---------------------------------------------------------------------------
const CATALOG_MODELS = [
  {
    id: 'magpie/auto/deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash · routing group',
    effortLevels: ['low', 'high', 'max'],
    provider: { id: 'magpie', displayName: 'Magpie' },
    default: true,
  },
  {
    id: 'neuracraft/claude-opus-5-5',
    displayName: 'claude-opus-5-5',
    effortLevels: ['low', 'medium', 'high'],
    provider: { id: 'neuracraft', displayName: 'Neuracraft' },
  },
  {
    id: 'studio-ollama/qwen3.8:27b-mlx',
    displayName: 'Studio Ollama / qwen3.8:27b-mlx',
    provider: { id: 'studio-ollama', displayName: 'Studio Ollama' },
  },
  {
    id: 'magpie/auto/no-credentials',
    displayName: 'No credentials',
    provider: { id: 'magpie', displayName: 'Magpie' },
    disabled: { reason: 'no credentials configured' },
  },
]
globalThis.__l8 = {
  listResult: { kind: 'ok', models: CATALOG_MODELS },
  listCalls: [],
  sessionCalls: [],
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-pi-models-'))
const cleanup = () => rmSync(tmpRoot, { recursive: true, force: true })

/**
 * 把引擎选择器切到新值，**复现真实 host 的两次动作与其顺序**：
 *
 *   ① 写 volatile 引用（真机上这一步是 loader 的 `_commitVolatile`，由
 *      `dsh-settings` 的 `write()` 里的 `configEditor.edit()` 同步完成 ——
 *      已由 ENGINE-SELECTOR-EVIDENCE.md §4 的真机探针验过「写与现读同一毫秒」）；
 *   ② emit `settings/document-updated`（真机上是 `write()` 之后的 `describe()`
 *      在 raw 变了时发的，见 dsh-settings 的 describe/write）。
 *
 * 顺序很重要：事件**在 volatile 提交之后**才发，所以监听器现读到的已经是新值。
 * 本套件不挂真 settings 服务（那要 configEditor + profile 写盘），但事件名、参数形状、
 * 以及「提交先于事件」这个顺序都与真机一致 —— 断言的是插件对契约的反应，不是对测试的反应。
 */
const setEngine = (ctx, pluginConfig, engine) => {
  pluginConfig.engine[plug.VOLATILE_WRITE](engine)
  ctx.emit('settings/document-updated', 'engine-switch', 1)
}

/**
 * 最小但**真折叠**的 sessionProjections 替身（与 session-lifecycle.mjs 同款）：
 * AgentRegistry 硬依赖 sessionProjections（turn 边界投影就从它来），缺了它 `ctx.agents` 根本不会
 * 被提供 —— 那时测的就不是插件而是「组装错了」。按定义逐事件 fold，够真。
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

/** 造一个「真实组合」：真实 cordis + 真实 llm（可选）+ 真实 AgentRegistry + 真实 SessionStore。 */
async function createRig({ withLlm = true, evidenceName = 'evidence.json' } = {}) {
  const ctx = new Context()
  ctx.provide('sessionProjections', createProjections())
  ctx.plugin(AgentRegistry)
  ctx.plugin(SessionStore)
  await tick(150)
  const native = createNativeTarget()
  ctx.agents.setFactory(native.target)
  const evidenceFile = join(tmpRoot, evidenceName)
  const pluginConfig = plug.Config({
    engine: 'native',
    evidencePath: evidenceFile,
    pi: {
      agentDir: join(tmpRoot, 'pi-agent'),
      provider: 'magpie',
      model: 'auto/deepseek-v4.1-flash',
      cwd: join(tmpRoot, 'workspace'),
      timeoutMs: 5000,
    },
  })
  return { ctx, native, evidenceFile, pluginConfig }
}

const readEvidence = (file) => JSON.parse(readFileSync(file, 'utf8'))
const llmOf = (ctx) => ctx.get('llm')

// ===========================================================================
// A. PI_SOURCE —— 目录来源与归一化（纯函数 + 真实兜底路径）
// ===========================================================================
{
  const split = models.splitPiModelId('magpie/auto/deepseek-v4.1-flash')
  check(
    'PI_SOURCE',
    'splitPiModelId 在**首个**斜杠处切（model id 自己可以带斜杠）—— 与 OAR 的 splitPiModelId 同规则',
    split?.providerId === 'magpie' && split?.modelId === 'auto/deepseek-v4.1-flash',
  )
  check(
    'PI_SOURCE',
    'splitPiModelId 对非法形状回 null（不抛）：空串 / 无斜杠 / 尾随斜杠',
    models.splitPiModelId('') === null &&
      models.splitPiModelId('magpie') === null &&
      models.splitPiModelId('magpie/') === null &&
      models.splitPiModelId(null) === null,
  )
  check(
    'PI_SOURCE',
    '选区→pi 选择子：`pi` 组直接透传 model（它本身就是全限定 id），其余拼 provider/model',
    models.piModelIdOfSelection({ provider: 'pi', model: 'magpie/auto/x' }) === 'magpie/auto/x' &&
      models.piModelIdOfSelection({ provider: 'magpie', model: 'auto/x' }) === 'magpie/auto/x',
  )
  check(
    'PI_SOURCE',
    '归一化不改写 model id（目录⟷执行必须逐字同一选择子）',
    models.normalizePiModels(CATALOG_MODELS).every(
      (model, index) => model.id === CATALOG_MODELS[index].id,
    ),
  )
  const normalized = models.normalizePiModels(CATALOG_MODELS)
  check(
    'PI_SOURCE',
    'OAR 标注 disabled 的模型不进目录（列出来但按现状跑不动 ⇒ 选了必炸，不如不列）',
    normalized.length === 3 && !normalized.some((model) => model.id.includes('no-credentials')),
  )
  check(
    'PI_SOURCE',
    '每条模型的 provider 标签来自 OAR 的 provider.displayName（展示用），id 保持原样',
    normalized[0].providerLabel === 'Magpie' && normalized[0].providerId === 'magpie',
  )
  check(
    'PI_SOURCE',
    'effortLevels 逐字来自 OAR（只有该模型真的提供的等级才会被透传给 pi）',
    normalized[0].effortLevels.join(',') === 'low,high,max' &&
      normalized[2].effortLevels.length === 0,
  )
  check(
    'PI_SOURCE',
    '目录默认标记来自 OAR 的 `default: true`（用于「选区不可用」时的回落选择）',
    normalized[0].isDefault === true && normalized[1].isDefault === false,
  )
  check(
    'PI_SOURCE',
    'thinkingLevelMap 归一化：值为 null 的等级不提供（与 pi 自己的 projectPiModels 同规则）',
    models
      .effortLevelsOfThinkingMap({ low: 'low', high: 'high', medium: null, max: 'max' })
      .join(',') === 'low,high,max',
  )

  // models.json 兜底路径（OAR 列不出来时）
  const agentDir = join(tmpRoot, 'fallback-pi-agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        magpie: {
          name: 'Magpie',
          models: [
            {
              id: 'auto/deepseek-v4.1-flash',
              name: 'DeepSeek V4.1 Flash',
              reasoning: true,
              thinkingLevelMap: { low: 'low', high: 'high', medium: null },
              contextWindow: 1048576,
            },
          ],
        },
        neuracraft: { models: [{ id: 'claude-opus-5-5' }] },
        empty: { name: 'Empty', models: [] },
      },
    }),
    'utf8',
  )
  const fromFile = models.readPiModelsJson(agentDir)
  check(
    'PI_SOURCE',
    'models.json 兜底读到 `<providerId>/<model.id>` 全限定 id（与 OAR 同拼法）',
    fromFile.ok === true &&
      fromFile.models.some((model) => model.id === 'magpie/auto/deepseek-v4.1-flash'),
  )
  check(
    'PI_SOURCE',
    'models.json 兜底把 contextWindow 带上（OAR 的 ModelEntry 不带这个字段）',
    fromFile.models.find((model) => model.id === 'magpie/auto/deepseek-v4.1-flash')?.contextWindow === 1048576,
  )
  check(
    'PI_SOURCE',
    'models.json 兜底给没写 name 的模型用 model.id 当展示名（不编假名字）',
    fromFile.models.find((model) => model.id === 'neuracraft/claude-opus-5-5')?.displayName === 'claude-opus-5-5',
  )

  const source = models.createPiCatalogSource({
    agentDir,
    listModels: async () => ({ kind: 'unsupported', reason: 'pi runtime not available: missing' }),
  })
  const snapshot = await source.load()
  check(
    'PI_SOURCE',
    'OAR 不可用 → 自动落到 models.json，并把来源如实标成 `models.json`（不假装 OAR）',
    snapshot.source === 'models.json' && snapshot.models.length === 2,
  )
  check(
    'PI_SOURCE',
    '兜底时仍保留 OAR 的失败原因（`reason`）—— 证据里能看出「为什么走了兜底」',
    typeof snapshot.reason === 'string' && snapshot.reason.includes('not available'),
  )
  await source.load()
  check(
    'PI_SOURCE',
    'TTL 内复用缓存（一次引擎激活 = 一次真实列表，不是每次读目录都去 spawn 一次 pi 服务栈）',
    source.snapshot().loads === 1,
  )
  source.invalidate()
  await source.load()
  check('PI_SOURCE', 'invalidate() 后强制重新真列一次（切换引擎时调用）', source.snapshot().loads === 2)

  const broken = models.createPiCatalogSource({
    agentDir: join(tmpRoot, 'no-such-agent-dir'),
    listModels: async () => ({ kind: 'unsupported', reason: 'nope' }),
  })
  const brokenSnapshot = await broken.load()
  check(
    'PI_SOURCE',
    '两边都拿不到时如实回 `source: "none"` + 原因，且**不抛**（目录面缺了不该炸宿主）',
    brokenSnapshot.source === 'none' &&
      brokenSnapshot.models.length === 0 &&
      typeof brokenSnapshot.error === 'string',
  )
  check(
    'PI_SOURCE',
    '目录来源只有 PI_CATALOG_SOURCES 收的那三个取值（词汇唯一，证据里不会冒出第四种拼法）',
    [snapshot.source, brokenSnapshot.source].every((value) =>
      models.PI_CATALOG_SOURCES.includes(value),
    ) && models.PI_CATALOG_SOURCES.length === 3,
  )
}

// ===========================================================================
// B. PI_ADAPTER —— 适配器形状（真实 LlmRuntime 上跑）
// ===========================================================================
{
  const ctx = new Context()
  ctx.plugin(LlmRuntime)
  await tick(120)
  const llm = llmOf(ctx)
  check('PI_ADAPTER', '测试用的是真实 LlmRuntime（宿主目录读的就是它）', llm?.constructor?.name === 'LlmRuntime')

  const source = models.createPiCatalogSource({
    listModels: async () => ({ kind: 'ok', models: CATALOG_MODELS }),
  })
  const adapter = models.createPiProviderAdapter({ source })
  const handle = llm.registerAdapter([models.PI_PROVIDER_ID], adapter)
  check(
    'PI_ADAPTER',
    '注册后宿主的 provider 表里出现 `pi` 组（组名 Pi）',
    llm.listProviders().some((provider) => provider.id === 'pi' && provider.name === 'Pi'),
  )
  const list = await llm.listModels('pi')
  check(
    'PI_ADAPTER',
    'listModels 过宿主的 INVALID_CATALOG 校验（provider 字段必须等于注册的 provider id）',
    list.length === 3 && list.every((model) => model.provider === 'pi'),
  )
  check(
    'PI_ADAPTER',
    'listModels 的 id 就是 pi 的全限定选择子（`magpie/auto/…`），不是二次编码过的 id',
    list[0].id === 'magpie/auto/deepseek-v4.1-flash',
  )
  check(
    'PI_ADAPTER',
    'listModels 带 description = pi 原生 provider 名（跨 provider 同名模型能分清是谁）',
    list[0].description === 'Magpie' && list[1].description === 'Neuracraft',
  )
  const info = await llm.resolveModelInfo('pi', 'magpie/auto/deepseek-v4.1-flash')
  check(
    'PI_ADAPTER',
    'resolveModelInfo 带 reasoning.efforts（逐字来自 pi 的等级菜单），且**不给** defaultEffort（不编 pi 的默认值）',
    info.reasoning?.efforts?.map((effort) => effort.id).join(',') === 'low,high,max' &&
      info.reasoning.defaultEffort === undefined,
  )
  check(
    'PI_ADAPTER',
    'reasoning.efforts 的展示名与官方 pi-ai 适配器同规则（首字母大写）',
    info.reasoning.efforts[0].name === 'Low' && info.reasoning.efforts[2].name === 'Max',
  )
  const noReasoning = await llm.resolveModelInfo('pi', 'studio-ollama/qwen3.8:27b-mlx')
  check(
    'PI_ADAPTER',
    '没有思考等级菜单的模型不给 reasoning（不编一个 pi 会 clamp 掉的假菜单）',
    noReasoning.reasoning === undefined,
  )
  check(
    'PI_ADAPTER',
    '选区校验路径可用：resolveCallConfig 对目录里的模型 + 它真的提供的等级都能过',
    JSON.stringify(await llm.resolveCallConfig({
      provider: 'pi',
      model: 'magpie/auto/deepseek-v4.1-flash',
      reasoningEffort: 'max',
    })) === JSON.stringify({
      provider: 'pi',
      model: 'magpie/auto/deepseek-v4.1-flash',
      reasoningEffort: 'max',
    }),
  )
  let unsupportedEffort = null
  try {
    await llm.resolveCallConfig({
      provider: 'pi',
      model: 'studio-ollama/qwen3.8:27b-mlx',
      reasoningEffort: 'max',
    })
  } catch (error) {
    unsupportedEffort = error
  }
  check(
    'PI_ADAPTER',
    '模型不支持的等级在选模型那一刻就被拒（UNSUPPORTED_REASONING_EFFORT，不 clamp 不糊弄）',
    unsupportedEffort?.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
  let unknown = null
  try {
    await llm.resolveCallConfig({ provider: 'pi', model: 'magpie/auto/nope' })
  } catch (error) {
    unknown = error
  }
  check(
    'PI_ADAPTER',
    '目录外的模型给明确的 UNKNOWN_MODEL（不静默挑一个别的模型跑）',
    unknown?.code === 'UNKNOWN_MODEL' && String(unknown.message).includes('not in the Pi model catalog'),
  )
  // 鸭子类型的适配器必须把 `LlmRuntime` 会调到的**每一个**方法都实现（它不走基类默认值）：
  // 少一个 `imageRequestPricing` / `imageRequestTarget` 就是一个潜伏的 TypeError。
  const optionalSurface = [
    'providerInfo',
    'providerRetryPolicy',
    'listModels',
    'resolveModel',
    'prepareCall',
    'stream',
    'imageRequestPricing',
    'imageRequestTarget',
  ]
  check(
    'PI_ADAPTER',
    '适配器实现了 LlmRuntime 会调到的全部方法（缺一个就是潜伏的 TypeError；`imageRequest*` 两条最易漏）',
    optionalSurface.every((method) => typeof adapter[method] === 'function'),
  )
  check(
    'PI_ADAPTER',
    'imageRequestPricing 如实回 undefined（不声明路由自有定价 → 宿主用中性估算）',
    adapter.imageRequestPricing('pi', 'magpie/auto/deepseek-v4.1-flash') === undefined,
  )
  check(
    'PI_ADAPTER',
    'imageRequestTarget 保持归一化原样（与 LlmAdapter 基类默认实现同款）',
    JSON.stringify(adapter.imageRequestTarget('pi', 'magpie/auto/x', { width: 10, height: 20, bytes: 30 })) ===
      JSON.stringify({ width: 10, height: 20, maxBytes: 30 }),
  )
  let catalogOnly = null
  try {
    const prepared = await adapter.prepareCall('pi', 'magpie/auto/deepseek-v4.1-flash')
    for await (const _chunk of prepared.stream()) {
      break
    }
  } catch (error) {
    catalogOnly = error
  }
  check(
    'PI_ADAPTER',
    '适配器自己的 stream 明确 PI_CATALOG_ONLY 拒绝（pi 出话走 OAR 子进程，不走 ctx.llm）',
    catalogOnly?.code === 'PI_CATALOG_ONLY',
  )
  let syncRefusal = null
  try {
    adapter.stream({ provider: 'pi', model: 'magpie/auto/deepseek-v4.1-flash' })
  } catch (error) {
    syncRefusal = error
  }
  check(
    'PI_ADAPTER',
    '同步 dispatch 入口也是同一道明确拒绝（两条路都不存在「静默出话」）',
    syncRefusal?.code === 'PI_CATALOG_ONLY',
  )
  handle()
  check(
    'PI_ADAPTER',
    '注销句柄一调，providers 表里就没有 `pi` 了（宿主注册表是唯一权威，事后再问也对不上）',
    !llm.listProviders().some((provider) => provider.id === 'pi'),
  )
  await ctx.stop?.()
}

// ===========================================================================
// C. PI_CATALOG / PI_SELECTION / PI_EXEC / NEG_NATIVE —— 真实插件装配
// ===========================================================================
{
  const { ctx, native, evidenceFile, pluginConfig } = await createRig({ withLlm: true })
  ctx.plugin(LlmRuntime)
  await tick(120)
  const llm = llmOf(ctx)
  const fiber = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply }, pluginConfig)
  await tick(150)

  // 基线：native 引擎下什么都不该有
  const beforeCatalog = await projectCatalog(llm)
  check(
    'NEG_NATIVE',
    'engine=native（apply 时的选择器缺省值）下宿主 provider 表里没有 `pi`（零污染）',
    !llm.listProviders().some((provider) => provider.id === 'pi'),
  )
  check(
    'NEG_NATIVE',
    'engine=native 下目录投影里没有 pi 组（Native 看到的还是它原生的模型组）',
    !beforeCatalog.groups.some((group) => group.id === 'pi'),
  )
  check(
    'NEG_NATIVE',
    'engine=native 下**一次都没去列过 pi 模型**（不是「列了不用」，是压根不动）',
    globalThis.__l8.listCalls.length === 0,
  )

  // ---- 切到 pi：目录出现 ----
  setEngine(ctx, pluginConfig, 'pi')
  await tick(30)
  check(
    'PI_CATALOG',
    'engine=pi 后宿主 provider 表里出现 `pi` 组（`ctx.llm` 是宿主的模型选择器的唯一数据源）',
    llm.listProviders().some((provider) => provider.id === 'pi' && provider.name === 'Pi'),
  )
  const piCatalog = await projectCatalog(llm)
  const piGroup = piCatalog.groups.find((group) => group.id === 'pi')
  check(
    'PI_CATALOG',
    '目录投影里 `pi` 组带 3 个模型（disabled 的没进来），且不是 failure',
    piGroup?.models.length === 3 && !piCatalog.failures.some((failure) => failure.id === 'pi'),
  )
  check(
    'PI_CATALOG',
    '组里的模型 id 是 pi 全限定选择子（`magpie/auto/…` / `neuracraft/…`）',
    piGroup.models.map((model) => model.id).join(',') ===
      'magpie/auto/deepseek-v4.1-flash,neuracraft/claude-opus-5-5,studio-ollama/qwen3.8:27b-mlx',
  )
  check(
    'PI_CATALOG',
    '组里的模型带思考等级（前端模型下拉框的思考档位菜单从这来）',
    piGroup.models[0].reasoning.efforts.map((effort) => effort.id).join(',') === 'low,high,max',
  )
  check(
    'PI_CATALOG',
    '列模型真的走了 OAR 的 runtime.listModels（与真实会话同一条 pi 服务栈，不是自己解析配置）',
    globalThis.__l8.listCalls.length === 1 && globalThis.__l8.listCalls[0].id === 'pi',
  )
  check(
    'PI_CATALOG',
    '证据里记下了目录来源与条数（modelCatalogSource / models）',
    readEvidence(evidenceFile).modelCatalogSource === 'oar' &&
      readEvidence(evidenceFile).modelCatalogModels === 3,
  )

  // ---- 宿主 selectModel 的准入路径：requireModel + resolveCallConfig ----
  const selected = { provider: 'pi', model: 'neuracraft/claude-opus-5-5', reasoningEffort: 'high' }
  const available = (await llm.listModels('pi')).some((model) => model.id === selected.model)
  check(
    'PI_SELECTION',
    'session.selectModel 的第一道闸（requireModel → listModels 成员检查）能过',
    available === true,
  )
  let callConfigOk = false
  try {
    await llm.resolveCallConfig(selected)
    callConfigOk = true
  } catch {
    callConfigOk = false
  }
  check(
    'PI_SELECTION',
    'session.selectModel 的第二道闸（resolveCallConfig → 适配器 resolveModel）也能过',
    callConfigOk === true,
  )
  let nonPiRejected = false
  try {
    await llm.resolveCallConfig({ provider: 'magpie-responses', model: 'auto/deepseek-v4.1-flash' })
  } catch {
    nonPiRejected = true
  }
  check(
    'PI_SELECTION',
    '别人家的 provider（如 magpie-responses）不因为注册了 `pi` 就变得可解析（我们只碰自己那一组）',
    nonPiRejected === true,
  )

  // ---- PI_EXEC：选区真的透传给 pi ----
  const CWD = join(tmpRoot, 'workspace')
  const PI_SESSION = 'session-l8pi0001-0000-4000-8000-000000000001'
  const defaultSelection = { provider: 'magpie', model: 'auto/deepseek-v4.1-flash', reasoningEffort: 'high' }
  const created = await ctx.agents.create({
    sessionId: PI_SESSION,
    meta: { cwd: CWD, agentPreset: 'standard' },
    agentOptions: defaultSelection,
  })
  const piAgent = created?.agent
  check(
    'PI_EXEC',
    'engine=pi 下建会话仍然拿到真实会话身份（L7 的不变量没被本轮改动碰到）',
    piAgent?.id === PI_SESSION && ctx.agents.get(PI_SESSION) === piAgent,
  )
  check(
    'PI_EXEC',
    '首次 attempt 把 `agentOptions` 的选区（原生拼法 magpie/auto/…）交给 pi —— 不再是写死的常量',
    globalThis.__l8.sessionCalls.length === 1 &&
      globalThis.__l8.sessionCalls[0].options.model === 'magpie/auto/deepseek-v4.1-flash',
  )
  check(
    'PI_EXEC',
    '思考等级也透传（选区里有、且该模型真的提供 → 交给 pi 的 thinking level）',
    globalThis.__l8.sessionCalls[0].options.effort === 'high',
  )
  const createdAttempt = readEvidence(evidenceFile).modelAttempt
  check(
    'PI_EXEC',
    '证据：选区与解析结果都如实落盘（D → pi 拼法的对应关系可审计，含 create 那一轮）',
    createdAttempt?.kind === 'createAgent' &&
      createdAttempt?.modelSource === 'selection' &&
      createdAttempt?.piModel === 'magpie/auto/deepseek-v4.1-flash' &&
      createdAttempt?.requested === 'magpie/auto/deepseek-v4.1-flash' &&
      createdAttempt?.effort === 'high' &&
      createdAttempt?.effectiveModel === 'magpie/auto/deepseek-v4.1-flash',
  )
  check(
    'PI_EXEC',
    'pi 读回的生效模型与交给它的模型逐字一致（OAR 自己也做这道校验，本处再留一份证据）',
    createdAttempt?.mismatch === null,
  )
  check(
    'PI_EXEC',
    '证据里同时留下选区原文（`{provider:"magpie", model:"auto/…"}`）—— 出问题时能看出用户选的是什么',
    createdAttempt?.selection?.provider === 'magpie' &&
      createdAttempt?.selection?.model === 'auto/deepseek-v4.1-flash',
  )

  // ---- 中途换模型：下一次 attempt 必须用新模型（现读，不是建会话时的快照） ----
  piAgent.model.select({ provider: 'pi', model: 'neuracraft/claude-opus-5-5' })
  check(
    'PI_EXEC',
    'agent.model.select 把新选区记在会话条目上（宿主 selectModel 走的正是这条路）',
    piAgent.model.current()?.provider === 'pi' && piAgent.model.current()?.model === 'neuracraft/claude-opus-5-5',
  )
  const followUp = async (text, rpcId) => {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })
    piAgent.followup(message)
    await piAgent.whenIdle()
  }
  await followUp('第二轮问题', 'req-l8-second')
  check(
    'PI_EXEC',
    '第二轮 attempt 用的是**新**选区（`pi` 组拼法 → 同一个 pi 选择子），不是建会话时的旧值',
    globalThis.__l8.sessionCalls.length === 2 &&
      globalThis.__l8.sessionCalls[1].options.model === 'neuracraft/claude-opus-5-5',
  )
  check(
    'PI_EXEC',
    '新区选没写思考等级 → 就不给 pi 传等级（不拿上一个模型的档位回填）',
    globalThis.__l8.sessionCalls[1].options.effort === undefined &&
      readEvidence(evidenceFile).modelAttempt?.effort === null,
  )
  check(
    'PI_EXEC',
    'assistant/message 的 source 从**有效模型**拆（provider 换了也不会写错 source）',
    readEvidence(evidenceFile).provider === 'neuracraft' &&
      readEvidence(evidenceFile).effectiveModel === 'neuracraft/claude-opus-5-5',
  )
  const durableSourceOf = () =>
    piAgent.session
      .snapshotEvents()
      .filter((event) => event.type === 'assistant/message')
      .map((event) => event.data.message.source)
  const firstDurableSource = durableSourceOf()
  check(
    'PI_EXEC',
    'durable 会话日志里的 assistant source 与真实跑的模型一致（历史不会说谎）',
    firstDurableSource.length === 1 &&
      firstDurableSource[0].provider === 'neuracraft' &&
      firstDurableSource[0].model === 'claude-opus-5-5',
  )
  check(
    'PI_EXEC',
    '会话条目上的选区随 select 更新（引擎现读读的就是它，证据快照也能看到）',
    readEvidence(evidenceFile).piSession?.sessions?.find((row) => row.sessionId === PI_SESSION)?.selection?.model ===
      'neuracraft/claude-opus-5-5',
  )

  // ---- 选区命中但该模型不提供这个档位：丢掉档位并如实记，不让整轮开会话失败 ----
  piAgent.model.select({ provider: 'pi', model: 'studio-ollama/qwen3.8:27b-mlx', reasoningEffort: 'max' })
  await followUp('第三轮问题', 'req-l8-third')
  check(
    'PI_EXEC',
    '选区命中目录 → 模型逐字照用（即便档位不匹配也不是换模型，是丢档位）',
    globalThis.__l8.sessionCalls[2].options.model === 'studio-ollama/qwen3.8:27b-mlx',
  )
  check(
    'PI_EXEC',
    '模型不提供该档位 → 不透传给 pi（OAR 会因此直接拒绝开会话），并如实记 effortOmitted',
    globalThis.__l8.sessionCalls[2].options.effort === undefined &&
      readEvidence(evidenceFile).modelAttempt?.effortOmitted?.requested === 'max' &&
      readEvidence(evidenceFile).modelAttempt?.effortOmitted?.advertised.length === 0,
  )

  // ---- 回落：选区不在 pi 目录里 ----
  piAgent.model.select({ provider: 'magpie-responses', model: 'auto/deepseek-v4.1-flash', reasoningEffort: 'max' })
  await followUp('第四轮问题', 'req-l8-fourth')
  check(
    'PI_EXEC',
    '选区不在 pi 目录里 → 回落 config 钉死值（不硬塞给 pi 让它 model_unavailable 炸掉整轮）',
    globalThis.__l8.sessionCalls[3].options.model === 'magpie/auto/deepseek-v4.1-flash',
  )
  check(
    'PI_EXEC',
    '回落**如实标注**：modelSource=fallback + 原因写明是哪个选区没命中（不假装用了选区）',
    readEvidence(evidenceFile).modelAttempt?.modelSource === 'fallback' &&
      readEvidence(evidenceFile).modelAttempt?.modelFallbackReason === 'requested-not-in-pi-catalog' &&
      readEvidence(evidenceFile).modelAttempt?.requested === 'magpie-responses/auto/deepseek-v4.1-flash',
  )
  check(
    'PI_EXEC',
    '回落时思考等级不跟着走（选区没被采纳，它的一部分也不该被采纳）',
    globalThis.__l8.sessionCalls[3].options.effort === undefined &&
      readEvidence(evidenceFile).modelAttempt?.effort === null &&
      readEvidence(evidenceFile).modelAttempt?.effortOmitted === null,
  )

  // ---- PI_ENGINE_DIRECT：没有模型面接线时的既有行为（独立使用 oar-engine 的路径） ----
  // `session-lifecycle.mjs` / `endo-pi.sh` 都走这条：没有 resolveAttemptModel ⇒ 用 config 钉死值。
  const directEngine = plug.createOarEngine({
    provider: 'magpie',
    model: 'auto/deepseek-v4.1-flash',
    timeoutMs: 5000,
  })
  const direct = await directEngine.runAttempt(ctx, {
    sessionId: 'session-l8direct-0000-4000-8000-000000000003',
    prompt: 'direct probe',
    agentOptions: { provider: 'pi', model: 'neuracraft/claude-opus-5-5', reasoningEffort: 'high' },
  })
  check(
    'PI_ENGINE_DIRECT',
    '没有模型面接线的 oar-engine 仍用 config 钉死值（L8 之前的行为逐字不变，独立使用不被牵连）',
    direct.piModel === 'magpie/auto/deepseek-v4.1-flash' &&
      direct.modelSource === 'config' &&
      direct.modelFallbackReason === 'no-model-plane',
  )
  check(
    'PI_ENGINE_DIRECT',
    '选区原文与它的 pi 拼法都被如实记录（既不静默丢掉选区，也不假装用了它）',
    direct.selection?.provider === 'pi' &&
      direct.selection?.model === 'neuracraft/claude-opus-5-5' &&
      direct.modelRequested === 'neuracraft/claude-opus-5-5',
  )
  check(
    'PI_ENGINE_DIRECT',
    '独立路径下 pi 读回的生效值 = 钉死值（stub 的 model() 照 OAR 语义回读请求值）',
    direct.effectiveModel === 'magpie/auto/deepseek-v4.1-flash' && direct.modelMismatch === undefined,
  )
  check(
    'PI_ENGINE_DIRECT',
    '档位也不跟选区走（当选区没被采纳时）—— 独立路径不会因为 selection 里有 effort 就透传',
    direct.modelEffort === null && direct.modelEffortOmitted === null,
  )

  // ---- NEG_NATIVE：切回原生 ----
  setEngine(ctx, pluginConfig, 'native')
  await tick(30)
  const nativeCatalog = await projectCatalog(llm)
  check(
    'NEG_NATIVE',
    '切回 native 后 `pi` provider 从宿主注册表里注销（模型选择器恢复原生模型组）',
    !llm.listProviders().some((provider) => provider.id === 'pi'),
  )
  check(
    'NEG_NATIVE',
    '切回 native 后目录投影里没有 pi 组、也没有 pi 的 failure 条目（干净地来、干净地走）',
    !nativeCatalog.groups.some((group) => group.id === 'pi') &&
      !nativeCatalog.failures.some((failure) => failure.id === 'pi'),
  )
  const listCallsAfterWithdraw = globalThis.__l8.listCalls.length
  await projectCatalog(llm)
  check(
    'NEG_NATIVE',
    'native 下再怎么读目录也不会去列 pi 模型（注销之后一个请求都不发）',
    globalThis.__l8.listCalls.length === listCallsAfterWithdraw,
  )
  const NATIVE_SESSION = 'session-l8nat0001-0000-4000-8000-000000000002'
  const nativeOptions = {
    sessionId: NATIVE_SESSION,
    meta: { cwd: CWD, agentPreset: 'standard' },
    agentOptions: defaultSelection,
  }
  const nativeBefore = native.calls.length
  // 用「调用次数不变」而不是写死数字：后面新增用例不会悄悄把这条负向断言变成同义反复。
  const piCallsBeforeNative = globalThis.__l8.sessionCalls.length
  const nativeCreated = await ctx.agents.create(nativeOptions)
  check(
    'NEG_NATIVE',
    'native 下 create 原样直通原生 target（恒等交回、参数逐字不改）',
    native.calls.length === nativeBefore + 1 &&
      nativeCreated?.agent === native.sentinel &&
      native.calls[nativeBefore].options === nativeOptions,
  )
  check(
    'NEG_NATIVE',
    'native 下不产生任何 pi 调用（既没 spawn pi，也没替身污染）',
    globalThis.__l8.sessionCalls.length === piCallsBeforeNative &&
      nativeCreated?.agent?.standIn === undefined,
  )
  check(
    'NEG_NATIVE',
    'native 下模型面的可观测证据是「已注销」（registered=false / engine=native）',
    readEvidence(evidenceFile).modelSync?.registered === false &&
      readEvidence(evidenceFile).modelSync?.engine === 'native',
  )

  // 再切回 pi：目录恢复（幂等 + 可逆）
  setEngine(ctx, pluginConfig, 'pi')
  await tick(30)
  check(
    'PI_CATALOG',
    '再切回 pi 时目录恢复（注册/注销是可逆的，不是一次性开关）',
    llm.listProviders().some((provider) => provider.id === 'pi') &&
      (await llm.listModels('pi')).length === 3,
  )

  // ---- UNLOAD ----
  await fiber.dispose()
  await tick(80)
  check(
    'UNLOAD',
    '插件卸载后 `pi` provider 归还宿主注册表（不留「插件没了、provider 还在」的残骸）',
    !llm.listProviders().some((provider) => provider.id === 'pi'),
  )
  check(
    'UNLOAD',
    '卸载时 factory 槽位仍旧还原成原生 target（L6/L7 的不变量没被本轮改动碰到）',
    ctx.agents.factory?.target === native.target,
  )
  await ctx.stop?.()
}

// ===========================================================================
// D. PI_LATE —— llm 后到 / llm 缺席
// ===========================================================================
{
  const { ctx, native, evidenceFile, pluginConfig } = await createRig({
    withLlm: false,
    evidenceName: 'late-evidence.json',
  })
  // 先 apply（此时宿主还没有 llm 服务）
  const fiber = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply }, pluginConfig)
  await tick(120)
  check(
    'PI_LATE',
    'llm 服务缺席时插件照样接管 agents（模型面是旁路能力，不拖累接管）',
    ctx.agents.factory?.target !== native.target,
  )
  setEngine(ctx, pluginConfig, 'pi')
  await tick(30)
  check(
    'PI_LATE',
    'llm 还没来，目录面如实记为「没接上」而不是假装成功',
    readEvidence(evidenceFile).modelSync?.attached === false &&
      readEvidence(evidenceFile).modelSync?.registered === false,
  )
  // llm 后到
  ctx.plugin(LlmRuntime)
  await tick(200)
  check(
    'PI_LATE',
    'llm 服务后到时能接上并注册 `pi` 组（`internal/service` 事件路径）',
    llmOf(ctx).listProviders().some((provider) => provider.id === 'pi'),
  )
  check(
    'PI_LATE',
    '后到路径下目录内容也是真的（不是空壳注册）',
    (await llmOf(ctx).listModels('pi')).length === 3,
  )
  await fiber.dispose()
  await tick(60)
  check(
    'PI_LATE',
    '后到路径卸载后同样注销（两条装配路径的收尾一致）',
    !llmOf(ctx).listProviders().some((provider) => provider.id === 'pi'),
  )
  await ctx.stop?.()
}

// ===========================================================================
// 汇总
// ===========================================================================
cleanup()
console.log('')
console.log(`SUMMARY: ${pass} HIT / ${fail} MISS (total ${pass + fail})`)
console.log(
  'ASSERTION_CLASSES: PI_SOURCE, PI_ADAPTER, PI_CATALOG, PI_SELECTION, PI_EXEC, PI_ENGINE_DIRECT, PI_LATE, NEG_NATIVE, UNLOAD',
)
console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
