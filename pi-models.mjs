/**
 * pi-models.mjs —— 「Pi 模型面」：把 Pi 真实能跑的模型接到 DSH 的模型选择器上，
 * 并把 UI 选中的模型解析成 Pi 子进程真正吃的 `provider/model` 选择子。
 *
 * ## 为什么需要它（L8 现场）
 *
 * L1~L7 把「引擎」做成了独立选择器，但模型面还没接上：
 *   · `oar-engine.mjs` 里 provider/model 是**写死**的（`magpie/auto/deepseek-v4.1-flash`），
 *     用户在 UI 里选了模型也不会被 pi 用上；
 *   · DSH 的模型目录（`session/modelCatalog()`）由宿主 `ctx.llm` 的注册表驱动
 *     （`dsh-api-session-controller` 的 buildModelCatalog：listProviders → listModels
 *     → resolveModelInfo），插件没往里注册任何东西 ⇒ 切到 Pi 之后列表里看不出 Pi 的模型。
 *
 * 本模块把这两件事收敛到一处，**只在 engine=pi 时**把 `pi` provider 注册进 ctx.llm，
 * 切走即注销 —— 于是 Native 引擎下的目录与执行都不留任何本模块的痕迹（负向防误杀）。
 *
 * ## 三条事实依据（不是设计口味）
 *
 * 1. **目录必须与执行同源**。Pi 的 `SessionOptions.model` 由 pi 自己的 ModelRuntime 解析：
 *    `oar/dist/runtimes/pi/resolve.js` 的 `piResolveModel` 对未知模型直接抛
 *    `RuntimeFailureError(model_unavailable)`，**不回落**。所以目录若自己另解析一份
 *    `~/.pi/agent/models.json`，就会出现「列表里有、跑起来 model_unavailable」。
 *    因此首选 OAR 的 `runtime.listModels(installation, {cwd})`
 *    （`oar/dist/runtimes/pi/list-models.js`：与 `pi --list-models`、与真实会话同一条
 *    `createAgentSessionServices` 路径，含扩展注册的 provider 与认证可用性过滤）。
 *    `models.json` 只在 OAR 列不出来时兜底（同属 ModelRegistry 的配置面），并如实标注来源。
 * 2. **provider id 必须是宿主里没被占用的名字**。真机部署已经注册了 `magpie` /
 *    `magpie-responses` / `magpie-anthropic`（`~/.dsh/settings.yaml` 的 `llm-pi-ai`），
 *    拿 pi 的原生 provider 名去注册会 `DUPLICATE_ADAPTER` 直接抛。
 * 3. **选区形状与 pi 的选择子逐字相同**。DSH 的选区是 `(provider, model)`；pi 要的是
 *    `provider/modelId`。把本 provider 的 model id **定义成 pi 的全限定 id**
 *    （如 `magpie/auto/deepseek-v4.1-flash`），则 `pi` 组的选区 `(pi, magpie/auto/…)`
 *    与原生组的选区 `(magpie, auto/…)` 落到**同一个 pi 选择子**，中间不需要任何
 *    「翻译函数」（推迟逻辑分叉：能复用既有概念就不引入新概念）。
 *
 * ## 诚实边界
 *
 * · 目录是 **host 全局**的，一次只列一次（按 config 的 cwd）；pi 的 provider 也可能来自
 *   **某个工作区**的 `.pi/extensions`，那种工作区专属 provider 不在本目录里。
 * · OAR 的 `ModelEntry` 不带 contextWindow / inputModalities，所以走 OAR 路径时
 *   DSH 侧看不到这两个字段（不猜、不编）；`models.json` 兜底路径有 contextWindow 才带上。
 * · 本 provider 是**目录用**的：真要让 DSH 原生 AgentLoop 拿它去发 HTTP 请求，
 *   会拿到一个明确的 `PI_CATALOG_ONLY` 错误（而不是静默用一个假模型出话）。
 *   这是刻意的：pi 引擎执行走 OAR 子进程，不走 ctx.llm。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 侧注册的 Pi provider id（单组，组名见 {@link PI_PROVIDER_NAME}）。 */
export const PI_PROVIDER_ID = 'pi'

/** 该 provider 在模型选择器里的展示名。 */
export const PI_PROVIDER_NAME = 'Pi'

/** 目录里没有候选模型时的兜底 provider/model（与 oar-engine 的历史默认逐字同值）。 */
export const PI_DEFAULT_PROVIDER = 'magpie'
export const PI_DEFAULT_MODEL = 'auto/deepseek-v4.1-flash'

/** 本适配器只服务目录、不服务真实调用时抛出的错误码（明确，不静默）。 */
export const PI_CATALOG_ONLY_CODE = 'PI_CATALOG_ONLY'

/** 目录缓存的默认 TTL：OAR 说这份列表是「usable now」的，但每次 keypress 重列一次过重。 */
export const PI_CATALOG_TTL_MS = 30000

/** 一次模型面同步的来源标记（证据里如实标注模型列表是从哪来的）。 */
export const PI_CATALOG_SOURCES = Object.freeze(['oar', 'models.json', 'none'])

/** pi 的 thinking level 全表（顺序即展示顺序；`oar/dist/runtimes/pi/open.js` 同款）。 */
export const PI_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/**
 * 拆 pi 的全限定模型 id：**首个** `/` 处切，model id 自己可以再带 `/`。
 * 与 OAR 的 `splitPiModelId`（`oar/dist/runtimes/pi/resolve.js`）逐字同规则。
 * 非法形状返回 null（不抛：调用方需要判断「这压根不是 pi 选择子」）。
 * @param {unknown} fullId 候选全限定 id
 * @returns {{providerId:string, modelId:string}|null} 拆解结果或 null
 */
export function splitPiModelId(fullId) {
  if (typeof fullId !== 'string') return null
  const slash = fullId.indexOf('/')
  if (slash <= 0 || slash === fullId.length - 1) return null
  return { providerId: fullId.slice(0, slash), modelId: fullId.slice(slash + 1) }
}

/**
 * 把一次 DSH 选区解析成 **pi 的全限定模型 id**。
 *
 * 两条拼法（都指向同一个 pi 选择子）：
 *   · 本插件注册的 `pi` 组：`(pi, magpie/auto/x)` → `magpie/auto/x`（model id 本身已是全限定）
 *   · 原生/别人的组：`(magpie, auto/x)`            → `magpie/auto/x`
 *
 * @param {unknown} selection DSH 选区（`{provider, model}`）
 * @returns {string|null} pi 全限定 id，或 null（选区不成立）
 */
export function piModelIdOfSelection(selection) {
  if (selection === null || typeof selection !== 'object') return null
  const provider = selection.provider
  const model = selection.model
  if (typeof provider !== 'string' || provider.length === 0) return null
  if (typeof model !== 'string' || model.length === 0) return null
  if (provider === PI_PROVIDER_ID) return model
  return `${provider}/${model}`
}

/**
 * 从「DSH 选区形状」的任意对象里取一份**脱钩的快照**。
 *
 * 为什么不直接留引用：`options.agentOptions` 在真机上是带 getter 的活对象
 * （`agentDefaultModel.currentSelection()` 每次现读），按引用留存会把「某次 attempt 用
 * 了哪个模型」变成「看的时候是什么就是什么」。快照才是可断言的证据。
 *
 * @param {unknown} source 候选对象（`agentOptions` / `model.select()` 的参数）
 * @returns {{provider:string, model:string, reasoningEffort?:string}|null} 选区快照或 null
 */
export function pickModelSelection(source) {
  if (source === null || typeof source !== 'object') return null
  const provider = source.provider
  const model = source.model
  if (typeof provider !== 'string' || provider.length === 0) return null
  if (typeof model !== 'string' || model.length === 0) return null
  const reasoningEffort = source.reasoningEffort
  return {
    provider,
    model,
    ...typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? { reasoningEffort }
      : {},
  }
}

/**
 * pi 的 thinking level → 展示名（与官方 pi-ai 适配器的写法同款）。
 * @param {string} level 级别 id
 * @returns {string} 展示名
 */
export function effortLabelOf(level) {
  return typeof level === 'string' && level.length > 0
    ? `${level.charAt(0).toUpperCase()}${level.slice(1)}`
    : String(level)
}

/**
 * 从 `thinkingLevelMap` 推 pi 的思考等级菜单。
 *
 * pi 自己的规则（`oar/dist/runtimes/pi/model-projection.js` 逐字）：
 * 「`thinkingLevelMap` drops levels mapped to null」——所以映射值为 null 的等级**不提供**。
 * 没有 map 时**不猜**：给空菜单（宁可少一个菜单，也不给一个 pi 会 clamp 掉的假菜单）。
 *
 * @param {unknown} map models.json 里的 `thinkingLevelMap`
 * @returns {string[]} 可用的等级 id（按 {@link PI_THINKING_LEVELS} 顺序）
 */
export function effortLevelsOfThinkingMap(map) {
  if (map === null || typeof map !== 'object') return []
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level]
    return typeof mapped === 'string' && mapped.length > 0
  })
}

/**
 * 把 OAR / models.json 的模型条目规范成一种形状。
 *
 * 归一化只做「删掉不可用的 + 补齐展示字段」，**不做**任何 provider/model 改名：
 * model id 必须逐字等于将来交给 pi 的选择子，否则目录⟷执行就会错位。
 *
 * @param {unknown} raw 候选条目数组（OAR `ModelEntry[]`）
 * @returns {Array<{id:string, providerId:string, modelId:string, displayName:string, providerLabel:string, effortLevels:string[], isDefault:boolean, contextWindow:number|null}>}
 */
export function normalizePiModels(raw) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const models = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    // OAR 用 `disabled` 如实标出「列出来但按现状不能跑」的模型：不放进目录（否则选了必炸）。
    if (entry.disabled !== undefined && entry.disabled !== null) continue
    const split = splitPiModelId(entry.id)
    if (split === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    const providerId =
      entry.provider !== null && typeof entry.provider === 'object'
        && typeof entry.provider.id === 'string' && entry.provider.id.length > 0
        ? entry.provider.id
        : split.providerId
    const providerLabel =
      entry.provider !== null && typeof entry.provider === 'object'
        && typeof entry.provider.displayName === 'string' && entry.provider.displayName.length > 0
        ? entry.provider.displayName
        : providerId
    const displayName =
      typeof entry.displayName === 'string' && entry.displayName.length > 0
        ? entry.displayName
        : typeof entry.name === 'string' && entry.name.length > 0
          ? entry.name
          : split.modelId
    const effortLevels = Array.isArray(entry.effortLevels)
      ? entry.effortLevels.filter((level) => typeof level === 'string' && level.length > 0)
      : effortLevelsOfThinkingMap(entry.thinkingLevelMap)
    const contextWindow =
      Number.isInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : null
    models.push({
      id: entry.id,
      providerId,
      modelId: split.modelId,
      displayName,
      providerLabel,
      effortLevels,
      isDefault: entry.default === true,
      contextWindow,
    })
  }
  return models
}

/**
 * 目录兜底：直接读 pi 的 `models.json`（`<agentDir>/models.json`）。
 *
 * 只在 OAR 列不出来时用，并且**如实标注来源** `models.json`。它与 OAR 的差别写在模块头：
 * 少了扩展注册的 provider 与「认证可用性」过滤，所以它可能列出选不动的模型
 * （执行期 pi 会给明确错误，不会静默换模型）。
 *
 * @param {string} agentDir pi 的配置目录
 * @returns {{ok:boolean, models:Array<object>, error:string|null}} 读取结果
 */
export function readPiModelsJson(agentDir) {
  const file = join(agentDir, 'models.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, models: [], error: String(error?.message ?? error) }
  }
  const providers = parsed !== null && typeof parsed === 'object' ? parsed.providers : undefined
  if (providers === null || typeof providers !== 'object') {
    return { ok: false, models: [], error: 'models.json has no providers object' }
  }
  const flat = []
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = provider !== null && typeof provider === 'object' ? provider.models : undefined
    if (!Array.isArray(models)) continue
    const providerLabel =
      typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : providerId
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue
      if (typeof model.id !== 'string' || model.id.length === 0) continue
      flat.push({
        id: `${providerId}/${model.id}`,
        displayName: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        provider: { id: providerId, displayName: providerLabel },
        ...model.reasoning === true
          ? { effortLevels: effortLevelsOfThinkingMap(model.thinkingLevelMap) }
          : {},
        ...Number.isInteger(model.contextWindow) && model.contextWindow > 0
          ? { contextWindow: model.contextWindow }
          : {},
      })
    }
  }
  return { ok: true, models: normalizePiModels(flat), error: null }
}

/**
 * pi 配置目录的缺省位置（与 pi/OAR 的 `getAgentDir` 同规则：`PI_CODING_AGENT_DIR` 否则 `~/.pi/agent`）。
 * @returns {string} 目录绝对路径
 */
export function defaultPiAgentDir() {
  const pinned = process.env.PI_CODING_AGENT_DIR
  if (typeof pinned === 'string' && pinned.length > 0) return pinned
  return join(homedir(), '.pi', 'agent')
}

/**
 * 用 OAR 的 pi runtime 列模型：与真实会话同一条 `createAgentSessionServices` 路径。
 *
 * 为什么不复用 OAR 的 `piListModels` 顶层导出：它要求调用方自己 createRuntime
 * （见 `oar/dist/runtimes/pi/list-models.js` 的 `createPiListModels`），而插件要的是
 * 「用 runtime 自己的能力」这一条稳定面 —— `runtime.listModels(installation, options)`，
 * 省掉一次 SDK 细节的内联复制。两条路的 `kind` 判别集完全一致。
 *
 * 失败**不抛**：回成 `{kind:'unsupported'}`，由调用方兜底并落证据（拿不到目录不该炸宿主）。
 *
 * `@botiverse/oar` 是**动态**import 的：本模块的其余部分是纯函数，不该因为藏在同一文件里
 * 就被 OAR（及其背后的 pi SDK 装载面）绑定；真正要列模型的路径才付这份代价。
 *
 * @param {{agentDir?:string, cwd?:string, timeoutMs?:number}} [options] 列模型的上下文
 * @returns {Promise<{kind:string, models?:Array<object>, reason?:string, detail?:string}>}
 */
export async function listPiModelsViaOar(options = {}) {
  const agentDir = typeof options.agentDir === 'string' && options.agentDir.length > 0
    ? options.agentDir
    : defaultPiAgentDir()
  // pi 的全局配置目录是**进程全局环境变量**读的（OAR 的 piAgentDir / pi 的 getAgentDir 都如此）。
  // 列一次模型要临时钉住它，列完还原 —— 不留一个「列完模型后别的代码看到的 agentDir 变了」的坑。
  const previous = process.env.PI_CODING_AGENT_DIR
  const pinned = process.env.OAR_PI_AGENT_DIR
  const overriding = !(typeof pinned === 'string' && pinned.length > 0)
  if (overriding) process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const { defaultRuntimes } = await import('@botiverse/oar')
    const runtime = defaultRuntimes.require('pi')
    if (runtime === null || typeof runtime !== 'object') {
      return { kind: 'unsupported', reason: 'pi runtime is unavailable' }
    }
    const installation = await runtime.installation()
    if (installation?.kind !== 'available') {
      return { kind: 'unsupported', reason: `pi runtime not available: ${installation?.kind ?? 'unknown'}` }
    }
    if (typeof runtime.listModels !== 'function') {
      return { kind: 'unsupported', reason: 'pi runtime exposes no listModels()' }
    }
    const result = await runtime.listModels(installation, {
      ...typeof options.cwd === 'string' && options.cwd.length > 0 ? { cwd: options.cwd } : {},
      ...Number.isFinite(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : {},
    })
    if (result === null || typeof result !== 'object') {
      return { kind: 'unsupported', reason: 'pi runtime returned no list result' }
    }
    return result
  } catch (error) {
    return { kind: 'unsupported', reason: String(error?.message ?? error) }
  } finally {
    if (overriding) {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
    }
  }
}

/** 空的目录快照（一切都拿不到时的诚实值，不是「忘了填」）。 */
function emptyCatalog(detail = {}) {
  return {
    models: [],
    byId: new Map(),
    source: 'none',
    error: null,
    reason: null,
    at: 0,
    ...detail,
  }
}

/**
 * 造一份「Pi 模型目录」源：带缓存与并发去重的 `load()`。
 *
 * 缓存策略是刻意的折中：OAR 文档说这份列表是 usable-now（该每次现查），
 * 但 DSH 的目录刷新由多个事件触发（`llm/adapters-updated` / `settings/document-updated` …），
 * 每次都去 spawn 一次 pi 服务栈太重。所以 **TTL 内复用 + 引擎切换时强制失效**：
 * 一次引擎激活 = 一次真实列表。
 *
 * @param {object} [config]
 * @param {string} [config.agentDir] pi 配置目录（缺省 {@link defaultPiAgentDir}）
 * @param {string} [config.cwd] 列表用的工作目录（pi 的 provider 可能来自项目扩展）
 * @param {number} [config.timeoutMs] 列表超时
 * @param {number} [config.ttlMs] 缓存时长（默认 {@link PI_CATALOG_TTL_MS}）
 * @param {Function} [config.now] 时钟（测试注入用）
 * @param {Function} [config.listModels] 列表实现（缺省 OAR；测试注入用）
 * @param {Function} [config.onLoad] 真列完一次的回调（证据用：来源/条数/失败原因）
 * @returns {{load:Function, peek:Function, invalidate:Function, snapshot:Function}}
 */
export function createPiCatalogSource(config = {}) {
  const agentDir = typeof config.agentDir === 'string' && config.agentDir.length > 0
    ? config.agentDir
    : defaultPiAgentDir()
  const cwd = typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : process.cwd()
  const ttlMs = Number.isFinite(config.ttlMs) ? config.ttlMs : PI_CATALOG_TTL_MS
  const now = typeof config.now === 'function' ? config.now : () => Date.now()
  const listModels = typeof config.listModels === 'function' ? config.listModels : listPiModelsViaOar
  const onLoad = typeof config.onLoad === 'function' ? config.onLoad : () => {}

  let cached = null
  let inflight = null
  let loads = 0
  let fileFallbackUsed = false

  /** 真列一次：OAR 优先，`models.json` 兜底（来源如实记在快照里）。 */
  async function listOnce() {
    loads += 1
    let failure = null
    try {
      const raw = await listModels({ agentDir, cwd, timeoutMs: config.timeoutMs })
      if (raw?.kind === 'ok') {
        return { models: normalizePiModels(raw.models), source: 'oar', error: null, reason: null }
      }
      failure = typeof raw?.reason === 'string' && raw.reason.length > 0
        ? raw.reason
        : `pi model listing returned kind=${raw?.kind ?? 'unknown'}`
    } catch (error) {
      failure = String(error?.message ?? error)
    }
    const fromFile = readPiModelsJson(agentDir)
    if (fromFile.ok && fromFile.models.length > 0) {
      fileFallbackUsed = true
      return { models: fromFile.models, source: 'models.json', error: null, reason: failure }
    }
    return {
      models: [],
      source: 'none',
      error: failure,
      reason: fromFile.ok ? null : fromFile.error,
    }
  }

  function materialize(result) {
    return {
      models: result.models,
      byId: new Map(result.models.map((model) => [model.id, model])),
      source: result.source,
      error: result.error,
      reason: result.reason,
      at: now(),
    }
  }

  return {
    agentDir,
    cwd,
    /**
     * 取目录（TTL 内复用；并发共用一次真实列表）。
     * @param {{force?:boolean}} [options] force=true 忽略缓存
     * @returns {Promise<object>} 目录快照
     */
    async load(options = {}) {
      const at = now()
      if (options.force !== true && cached !== null && at - cached.at < ttlMs) return cached
      if (inflight !== null) return inflight
      inflight = (async () => {
        try {
          cached = materialize(await listOnce())
        } catch (error) {
          // listOnce 自己已经吞掉失败；这里只防「吞不干净」的实现被注入。
          cached = emptyCatalog({ error: String(error?.message ?? error), at: now() })
        } finally {
          inflight = null
        }
        // 真列完一次就通知一次（证据里能看到「引擎激活时目录长什么样」，
        // 而不是只能看到「注册了，但不知道列出了什么」）。通知失败不影响加载结果。
        try {
          onLoad({
            source: cached.source,
            models: cached.models.length,
            error: cached.error,
            reason: cached.reason,
            at: cached.at,
          })
        } catch {
          // 证据回调是旁路：它炸了也不能让目录加载失败。
        }
        return cached
      })()
      return inflight
    },
    /**
     * 现读缓存（不触发加载）。
     * @returns {object|null} 缓存快照或 null
     */
    peek() {
      return cached
    },
    /** 让缓存失效（引擎切换时调用：换引擎 = 换一次真实列表）。 */
    invalidate() {
      cached = null
      inflight = null
    },
    /** @returns {object} 证据用快照（含来源与失败原因，绝不假装成功） */
    snapshot() {
      return {
        agentDir,
        cwd,
        ttlMs,
        loads,
        fileFallbackUsed,
        cached: cached === null
          ? null
          : {
              source: cached.source,
              models: cached.models.length,
              error: cached.error,
              reason: cached.reason,
              at: cached.at,
            },
      }
    },
  }
}

/**
 * 把一条 pi 模型投影成 DSH 的 `listModels()` 条目。
 *
 * 硬要求（`dsh-llm` 的 `listModels` 会逐条校验，错一个整组判 INVALID_CATALOG）：
 * `provider` 必须等于注册的 provider id、`id` 非空且唯一、`name` 非空。
 *
 * @param {object} model 归一化后的 pi 模型
 * @param {string} provider 注册的 provider id
 * @returns {object} DSH 目录条目
 */
export function dshListEntryOf(model, provider) {
  return {
    provider,
    id: model.id,
    name: model.displayName,
    // 描述里带 pi 原生 provider 名：同名的模型（跨 provider）在多组里能分清是谁。
    ...model.providerLabel !== model.displayName ? { description: model.providerLabel } : {},
  }
}

/**
 * 把一条 pi 模型投影成 DSH 的 `resolveModel()` 结果（精确模型元数据）。
 *
 * `reasoning` 从 pi 自己的思考等级菜单来；**不给 `defaultEffort`** —— pi 的默认等级是
 * 它自己的 settings 值（按模型 clamp），我们不知道就不编（OAR 的 model-projection 同款理由）。
 *
 * @param {object} model 归一化后的 pi 模型
 * @param {string} provider 注册的 provider id
 * @returns {object} DSH 精确元数据
 */
export function dshModelInfoOf(model, provider) {
  return {
    provider,
    id: model.id,
    name: model.displayName,
    ...model.providerLabel !== model.displayName ? { description: model.providerLabel } : {},
    ...model.contextWindow === null ? {} : { context: { contextWindow: model.contextWindow } },
    ...model.effortLevels.length === 0
      ? {}
      : { reasoning: { efforts: model.effortLevels.map((level) => ({ id: level, name: effortLabelOf(level) })) } },
  }
}

/** 造「本适配器只做目录」的明确错误。 */
function catalogOnlyError(provider, model) {
  const error = new Error(
    `provider "${provider}" is a Pi model catalog only: model "${model}" runs through the OAR Pi engine, `
    + 'not through ctx.llm. Switch the engine to "pi" (or pick a native model) instead of calling it directly.',
  )
  error.code = PI_CATALOG_ONLY_CODE
  return error
}

/** 造「目录里没有这个模型」的明确错误。 */
function unknownPiModelError(model) {
  const error = new Error(
    `pi model "${model}" is not in the Pi model catalog; pick a model from the "${PI_PROVIDER_NAME}" group `
    + '(the catalog is what the Pi runtime currently accepts).',
  )
  error.code = 'UNKNOWN_MODEL'
  return error
}

/**
 * 造 pi 的 DSH 侧 provider 适配器（鸭子类型，形状照 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`）。
 *
 * 它只实现**目录面**：`listModels` / `resolveModel`。真实调用面（`prepareCall` / `stream`）
 * 一律抛 {@link PI_CATALOG_ONLY_CODE} —— pi 引擎出话走 OAR 子进程，不走 ctx.llm，
 * 若真有人让原生 AgentLoop 用这个 provider 发请求，应当**响亮地失败**而不是静默出话。
 *
 * @param {{providerId?:string, providerName?:string, source:object}} config 配置
 * @returns {object} 适配器
 */
export function createPiProviderAdapter(config = {}) {
  const providerId =
    typeof config.providerId === 'string' && config.providerId.length > 0
      ? config.providerId
      : PI_PROVIDER_ID
  const providerName =
    typeof config.providerName === 'string' && config.providerName.length > 0
      ? config.providerName
      : PI_PROVIDER_NAME
  const source = config.source ?? createPiCatalogSource()

  return {
    /** @param {string} provider 注册的 provider 路由 @returns {{id:string,name:string}} 展示元数据 */
    providerInfo(provider) {
      return { id: provider, name: providerName }
    },
    /** @returns {undefined} 用宿主默认重试策略（本适配器不发请求，没有自己的策略） */
    providerRetryPolicy() {
      return undefined
    },
    /**
     * 图片请求定价：本适配器不发请求，因此也不声明路由级定价
     * （宿主会回落到它自己的中性估算）。
     *
     * 为什么这个「空实现」不能省：`LlmRuntime.imageRequestPricing()` 是
     * `this.adapters.get(provider)?.adapter.imageRequestPricing(...)` —— 鸭子类型的适配器缺了它，
     * 一旦有人给我们这条路由定价（例如会话里带图 + 这条路由的历史），就是**TypeError**。
     * @returns {undefined} 不声明路由自有定价
     */
    imageRequestPricing() {
      return undefined
    },
    /**
     * 图片请求投影：默认保持归一化后的原样（与 `LlmAdapter` 基类默认实现逐字同款）。
     * 同样不能省：`LlmRuntime.imageRequestTarget()` 直接调适配器上的这个方法。
     * @param {string} _provider 注册的 provider 路由
     * @param {string} _model pi 全限定 model id
     * @param {object} image 归一化后的图片引用
     * @returns {{width:number, height:number, maxBytes:number}} 请求投影目标
     */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },
    /**
     * @param {string} provider 注册的 provider 路由
     * @returns {Promise<Array<object>>} DSH 目录条目
     */
    async listModels(provider) {
      const snapshot = await source.load()
      return snapshot.models.map((model) => dshListEntryOf(model, provider))
    },
    /**
     * @param {string} provider 注册的 provider 路由
     * @param {string} model pi 全限定 model id
     * @returns {Promise<object>} DSH 精确元数据
     */
    async resolveModel(provider, model) {
      // 现读缓存优先（`session.modelCatalog()` 的流程是 listModels → resolveModelInfo，
      // 那时缓存已经在了）；拿不到才真加载一次。两步都不改投影规则。
      let found = source.peek()?.byId?.get(model)
      if (found === undefined) found = (await source.load()).byId.get(model)
      if (found === undefined) throw unknownPiModelError(model)
      return dshModelInfoOf(found, provider)
    },
    /**
     * 目录面绑定：元数据给真的，stream 明确不给（见 {@link createPiProviderAdapter}）。
     * @param {string} provider 注册的 provider 路由
     * @param {string} model pi 全限定 model id
     * @returns {Promise<{model:object, stream:Function}>} 绑定结果
     */
    async prepareCall(provider, model) {
      const info = await this.resolveModel(provider, model)
      return {
        model: info,
        // eslint-disable-next-line require-yield -- 刻意在首次迭代就抛：这是「不支持」而不是「空流」。
        stream: async function* stream() {
          throw catalogOnlyError(provider, model)
        },
      }
    },
    /** @returns {never} 见 {@link createPiProviderAdapter} */
    stream(options) {
      throw catalogOnlyError(options?.provider ?? providerId, options?.model ?? '')
    },
  }
}

/**
 * 把「DSH 选区」解析成本次 pi attempt 真正要用的模型与思考等级（**纯函数**，好断言）。
 *
 * 优先级与理由：
 *   1. 选区**在 pi 目录里** → 逐字用选区（这是本轮的核心承诺：选什么跑什么）；
 *   2. 选区不在目录里 → 回落 config 的显式钉死值（运维的钉子优先），并记 `fallback` 原因；
 *   3. 没有选区 → 用 config 的钉死值，记 `default`；
 *   4. 目录列不出来（OAR 不可用）→ 用 config 的钉死值，记 `config`（= L8 之前的既有行为）。
 * 任何回落都**如实记录**在返回值里（`source` / `reason` / `requested`），
 * 由调用方写进证据与 assistant/message.source —— 绝不假装用了选区。
 *
 * @param {object} input
 * @param {unknown} input.selection DSH 选区（可为 null）
 * @param {{models:Array<object>, byId:Map<string,object>}|null} input.catalog 目录快照
 * @param {{provider?:string, model?:string}|null} [input.defaultModel] config 的显式钉死值
 * @returns {{model:string|null, effort:string|null, source:string, reason:string|null,
 *            requested:string|null, selection:object|null, effortOmitted:object|null}} 解析结果
 */
export function resolvePiAttempt(input = {}) {
  const selection = pickModelSelection(input.selection)
  const requested = piModelIdOfSelection(selection)
  const catalog = input.catalog ?? null
  const byId = catalog?.byId instanceof Map ? catalog.byId : null
  const configured = pickModelSelection(input.defaultModel)
  const configuredId = configured === null ? null : `${configured.provider}/${configured.model}`

  const result = (model, source, reason, effort) => ({
    model,
    effort: effort ?? null,
    source,
    reason: reason ?? null,
    requested,
    // 选区原文（DSH 拼法）也回出去：证据里要能看出「用户选的是什么」，
    // 而不只是它换算成 pi 拼法之后的样子。
    selection,
    effortOmitted: null,
  })

  // ① 选区命中目录：逐字用。**只有这条路才带思考等级** ——
  // 等级是选区的一部分，选区没被采纳时它也不该跟着走（否则会出现「模型是回落的那个、
  // 档位是别的模型的那个」这种拼出来的组合）。
  if (requested !== null && byId !== null && byId.has(requested)) {
    return effortOf(result(requested, 'selection', null), selection, byId.get(requested))
  }
  // 目录拿不到：用钉死值（L8 之前的既有行为），如实标注。
  if (byId === null) {
    return result(configuredId, configuredId === null ? 'none' : 'config', 'catalog-unavailable')
  }
  const reason = requested === null ? 'config-default-not-in-pi-catalog' : 'requested-not-in-pi-catalog'
  // ② 钉死值在目录里：用它（有选区 = 回落，无选区 = 默认）。
  if (configuredId !== null && byId.has(configuredId)) {
    return result(configuredId, requested === null ? 'default' : 'fallback', requested === null ? null : reason)
  }
  // ③ 目录自己报了默认 → 用默认；④ 否则用目录第一条（都如实记原因）。
  const catalogDefault = catalog.models.find((model) => model.isDefault === true)
  if (catalogDefault !== undefined) {
    return result(catalogDefault.id, 'fallback', reason)
  }
  if (catalog.models.length > 0) {
    return result(catalog.models[0].id, 'fallback', reason)
  }
  // ⑤ 目录是空的：钉子优先（可能随后就能连上）。
  return result(configuredId, configuredId === null ? 'none' : 'config', reason)
}

/**
 * 决定思考等级要不要透传：**只透传该模型真的提供的等级**。
 *
 * 为什么不能无条件透传：pi 的 `SessionOptions.effort` 会被 OAR 校验
 * （`oar/dist/runtimes/pi/open.js` 的 `piThinkingLevel` / `piEffortRefusal`），
 * 模型不提供的等级会让**开会话直接失败**。宁可丢掉等级并如实记
 * `effortOmitted`（pi 用自己的默认等级），也不要让一次输入整轮报错。
 *
 * @param {object} result 解析结果
 * @param {object|null} selection 选区快照
 * @param {object} model 命中的 pi 模型
 * @returns {object} 补好 effort / effortOmitted 的结果
 */
function effortOf(result, selection, model) {
  const requested = selection?.reasoningEffort
  if (typeof requested !== 'string' || requested.length === 0) return result
  if (model.effortLevels.includes(requested)) return { ...result, effort: requested }
  return { ...result, effort: null, effortOmitted: { requested, advertised: [...model.effortLevels] } }
}

/** 归一化引擎取值：只有精确的 `pi` 才注册目录（近似值一律当作「不是 pi」）。 */
function isPiEngine(engine) {
  return engine === PI_PROVIDER_ID
}

/**
 * 造「目录注册」绑定：engine=pi 时注册、切走即注销（负向防误杀的唯一开关）。
 *
 * 注册/注销都走 `ctx.llm.registerAdapter`：它在提交时会 emit `llm/adapters-updated`，
 * 浏览器半边（`@deepseek-ai/dsh-client-ui-model-selection`）订阅该事件并刷新目录
 * ⇒ 「切到 Pi，模型下拉框跟着出现 Pi 组」不需要任何自定客户端逻辑。
 *
 * 失败面纪律：拿不到 llm 服务 / 注册被拒（例如 provider 名已被占）一律**不抛**，
 * 只记 `lastError` 与证据 —— 目录面缺了不该把宿主拖下水，接管能力不受影响。
 *
 * @param {object} [config]
 * @param {object} [config.source] 目录源（缺省自造一个）
 * @param {string} [config.providerId] provider id（缺省 {@link PI_PROVIDER_ID}）
 * @param {string} [config.providerName] 展示名（缺省 {@link PI_PROVIDER_NAME}）
 * @param {(event:string, detail:object)=>void} [config.onEvent] 证据回调
 * @param {Function} [config.now] 时钟（测试注入用）
 * @returns {{attach:Function, detach:Function, sync:Function, snapshot:Function, source:object, dispose:Function}}
 */
export function createPiCatalogBinding(config = {}) {
  const providerId =
    typeof config.providerId === 'string' && config.providerId.length > 0
      ? config.providerId
      : PI_PROVIDER_ID
  const providerName =
    typeof config.providerName === 'string' && config.providerName.length > 0
      ? config.providerName
      : PI_PROVIDER_NAME
  const source = config.source ?? createPiCatalogSource()
  const now = typeof config.now === 'function' ? config.now : () => Date.now()
  const onEvent = typeof config.onEvent === 'function' ? config.onEvent : () => {}
  const adapter = createPiProviderAdapter({ providerId, providerName, source })

  let llm = null
  let handle = null
  /** 最近一次被 sync 进来的引擎取值（null = 还不知道）。 */
  let engine = null
  let lastError = null
  let lastErrorPhase = null
  let syncCount = 0
  let registerCount = 0
  let withdrawCount = 0
  let registeredAt = null
  let withdrawnAt = null
  let disposed = false

  const record = (event, detail) => {
    try {
      onEvent(event, detail)
    } catch {
      // 证据写入失败绝不影响主流程（证据是旁路）。
    }
  }

  const visibleProviders = () => {
    if (llm === null || typeof llm.listProviders !== 'function') return null
    try {
      return llm.listProviders().map((provider) => provider.id)
    } catch {
      return null
    }
  }

  const snapshot = () => {
    const catalog = source.peek()
    return {
      providerId,
      providerName,
      engine,
      attached: llm !== null,
      registered: handle !== null,
      catalogLoaded: catalog !== null,
      catalogSource: catalog?.source ?? null,
      models: catalog?.models?.length ?? 0,
      catalogError: catalog?.error ?? null,
      catalogReason: catalog?.reason ?? null,
      visibleProviders: visibleProviders(),
      syncCount,
      registerCount,
      withdrawCount,
      registeredAt,
      withdrawnAt,
      lastError,
      lastErrorPhase,
      disposed,
    }
  }

  /** 注册（同步；失败只记不抛）。 */
  function register() {
    if (disposed || llm === null || handle !== null) return false
    try {
      handle = llm.registerAdapter([providerId], adapter)
      registerCount += 1
      registeredAt = now()
      record('pi-models/registered', { providerId, providerName })
      return true
    } catch (error) {
      lastError = String(error?.message ?? error)
      lastErrorPhase = 'register'
      handle = null
      record('pi-models/error', { phase: 'register', providerId, error: lastError })
      return false
    }
  }

  /** 注销（把 provider 从宿主注册表里摘干净）。 */
  function withdraw() {
    if (handle === null) return false
    const current = handle
    handle = null
    withdrawCount += 1
    withdrawnAt = now()
    try {
      current()
    } catch (error) {
      lastError = String(error?.message ?? error)
      lastErrorPhase = 'withdraw'
      record('pi-models/error', { phase: 'withdraw', providerId, error: lastError })
    }
    record('pi-models/withdrawn', { providerId })
    return true
  }

  /** 让目录与当前引擎取值一致（幂等：取值没变时零动作）。 */
  function applyEngine() {
    if (disposed) return false
    if (isPiEngine(engine)) return handle === null ? register() : false
    return withdraw()
  }

  return {
    providerId,
    providerName,
    source,
    adapter,
    /**
     * 接上 llm 服务（幂等）。拿不到 llm 时不注册、不抛。
     * @param {object|null|undefined} llmService 真实的 ctx.llm
     * @returns {boolean} 是否已接上
     */
    attach(llmService) {
      if (disposed) return false
      if (llmService === null || llmService === undefined || typeof llmService.registerAdapter !== 'function') {
        return false
      }
      if (llm === llmService) return true
      withdraw()
      llm = llmService
      record('pi-models/attached', { providerId })
      lastError = null
      lastErrorPhase = null
      applyEngine()
      return true
    },
    /** 断开 llm 服务（同时注销）。 */
    detach() {
      withdraw()
      llm = null
    },
    /**
     * 通知「当前引擎是什么」：pi ⇒ 注册，其余 ⇒ 注销（并让缓存失效，下次重新真列一次）。
     * @param {string|null} nextEngine 当前引擎取值
     * @returns {object} 同步后的证据快照
     */
    sync(nextEngine) {
      if (disposed) return snapshot()
      const next = typeof nextEngine === 'string' ? nextEngine : null
      if (next === engine) return snapshot()
      syncCount += 1
      engine = next
      source.invalidate()
      applyEngine()
      return snapshot()
    },
    snapshot,
    /** 卸载：注销 provider，不留任何「插件没了、provider 还在」的残骸。 */
    dispose() {
      if (disposed) return false
      withdraw()
      llm = null
      disposed = true
      return true
    },
  }
}

export default {
  PI_PROVIDER_ID,
  PI_PROVIDER_NAME,
  PI_DEFAULT_PROVIDER,
  PI_DEFAULT_MODEL,
  PI_CATALOG_ONLY_CODE,
  PI_THINKING_LEVELS,
  PI_CATALOG_SOURCES,
  splitPiModelId,
  piModelIdOfSelection,
  pickModelSelection,
  effortLabelOf,
  effortLevelsOfThinkingMap,
  normalizePiModels,
  readPiModelsJson,
  defaultPiAgentDir,
  listPiModelsViaOar,
  createPiCatalogSource,
  dshListEntryOf,
  dshModelInfoOf,
  createPiProviderAdapter,
  resolvePiAttempt,
  createPiCatalogBinding,
}
