/**
 * engine-intent.mjs —— 「引擎意图（engine intent）」判定的唯一权威处。
 *
 * ## 词汇（本模块是这三个 id 的唯一定义处）
 *
 *   native —— DSH 原生 AgentLoop（缺省）
 *   pi     —— OAR 驱动的 pi 引擎（真子进程真模型，见 oar-engine.mjs）
 *   echo   —— 回声替身引擎（只回显固定文本、不起模型；测试/联调用）
 *
 * ## 为什么单独一个模块
 *
 * 「谁在当底座」和「系统提示词/角色/工具集长什么样」是**两个正交维度**：
 *
 *   - Agent Preset（业务预设：标准/极简/创造…）→ 决定会话内容面
 *   - Engine（底座引擎：原生/pi/回声）      → 决定会话由谁驱动
 *
 * 把 engine 判定塞进 preset 判定（例如只认 `meta.agentPreset === 'pi'`）会让
 * 两者互相绑架：新增一个引擎就得往 UI 的 preset 下拉框里塞一项，等于把引擎降格
 * 成「预设的一种」。本模块把 engine 判定单独收敛成一处，preset 只是它的**一个
 * 兼容输入**（见下方优先级第 4 条），不再是它的定义。
 *
 * ## 判定优先级（高 → 低，逐条可测）
 *
 *   1. forceEngine     —— 运维/测试硬开关（config.forceEngine 命中已知引擎时）
 *   2. requestMarker   —— 请求自带的分流意图（`options.meta.engine` / `options.engine`）
 *   3. sessionBinding  —— 本会话此前已落到哪个引擎（create/resume 时记忆，进程内）
 *   4. agentPreset     —— 兼容旧路径：`meta.agentPreset === config.piPreset` → pi
 *   5. config          —— 用户在独立选择器里选的引擎（config.engine）
 *   6. default         —— native
 *
 * 第 4 条在**第 5 条之上**是刻意的：`agentPreset` 是**会话自己的身份**（写在该会话
 * 的 session header 里），而 `config.engine` 只是一个**全局缺省**。会话身份强于全局
 * 缺省 —— 与 DSH 自己的模型选型语义一致（会话记录下来的模型压过默认模型）。
 *
 * 第 2 条在**第 3 条之上**同理：请求级显式意图压过历史记忆。
 *
 * ## 取值纪律（负向防误杀）
 *
 * 任何来源里出现的引擎取值只有三种形态被承认：'native' / 'pi' / 'echo'。
 * 大小写不同、带空白、近似值（'PI' / 'pi ' / 'pi-lite' / 'auto' / '' / null /
 * 数字 / 对象）**一律归一化为 null = 该来源不作数**，继续往下一条判据走，
 * 最终落到 native。绝不会因为「看起来像 pi」而把会话交给 pi 引擎。
 */

/** 原生引擎（DSH AgentLoop）。 */
export const NATIVE_ENGINE_ID = 'native'

/** pi 引擎（OAR 驱动）。与 oar-engine.mjs / pi-engine.mjs 的 PI_ENGINE_ID 同值。 */
export const PI_ENGINE_ID = 'pi'

/** 回声替身引擎。 */
export const ECHO_ENGINE_ID = 'echo'

/** 全部被承认的引擎 id（顺序即 UI 展示顺序）。 */
export const ENGINE_IDS = Object.freeze([
  NATIVE_ENGINE_ID,
  PI_ENGINE_ID,
  ECHO_ENGINE_ID,
])

/** 请求级分流意图的字段名（`meta.engine` / `options.engine` 共用）。 */
export const ENGINE_MARKER_FIELD = 'engine'

/** 判定来源标记。 */
export const ENGINE_SOURCES = Object.freeze([
  'forceEngine',
  'requestMarker',
  'sessionBinding',
  'agentPreset',
  'config',
  'default',
])

/**
 * 归一化一个引擎取值：只承认三个精确 id，其余一律 null。
 * @param {unknown} value 任意来源的原始值
 * @returns {'native'|'pi'|'echo'|null} 归一化后的引擎 id，或 null（该来源不作数）
 */
export function normalizeEngineId(value) {
  if (typeof value !== 'string') return null
  return ENGINE_IDS.includes(value) ? value : null
}

/**
 * 读一次 create/resume 请求自带的引擎意图（marker）。
 *
 * **刻意保持改造前的串味语义**：pi 判定先于 echo，且 `meta.engine` 与
 * `options.engine` 两个字段都参与判定（改造前是 `isPiMarked(options) || isEchoMarked(options)`
 * 两个函数各自跨字段取或）。这不是好 API，但它是存量行为：既然本轮任务没要求改它，
 * 就不能顺手把「`meta.engine='echo'` + `options.engine='pi'` 判成 pi」悄悄改成 echo。
 * 新增的只是 `'native'` 这个取值（改造前不存在，属纯新增）。
 *
 * @param {unknown} options create/resume 的调用参数
 * @returns {'native'|'pi'|'echo'|null} 请求级意图，或 null（未携带/取值不作数）
 */
export function engineMarkerOf(options) {
  if (options === null || typeof options !== 'object') return null
  const meta = options.meta
  const fromMeta =
    meta !== null && typeof meta === 'object' ? meta[ENGINE_MARKER_FIELD] : undefined
  const fromOptions = options[ENGINE_MARKER_FIELD]
  if (fromMeta === PI_ENGINE_ID || fromOptions === PI_ENGINE_ID) return PI_ENGINE_ID
  if (fromMeta === ECHO_ENGINE_ID || fromOptions === ECHO_ENGINE_ID) return ECHO_ENGINE_ID
  if (fromMeta === NATIVE_ENGINE_ID || fromOptions === NATIVE_ENGINE_ID) return NATIVE_ENGINE_ID
  return null
}

/**
 * 从一次 create/resume 请求里取会话身份（用于记忆/查询会话级引擎绑定）。
 * @param {unknown} options create/resume 的调用参数
 * @returns {string|null} 会话 id，或 null（请求未命名会话）
 */
export function sessionIdOf(options) {
  if (options === null || typeof options !== 'object') return null
  const raw = options.sessionId ?? options.resumeSessionId
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * 造一个「会话 → 引擎」绑定表（进程内）。
 *
 * 存在的理由：`config.engine` 是全局缺省，但**一次会话只能有一个底座** —— 一个
 * 会话前半程由 pi 写、后半程换原生读，历史错位。所以某个会话第一次落下时用哪个
 * 引擎，之后这个进程内就一直用它（会话身份 ≥ 全局缺省）。
 *
 * 边界（如实声明，不假装）：本表**只在进程内**，桌面端重启即清空；跨重启的持久化
 * 需要一等公民的写入口（第三方插件拿不到 session header / 请求 schema 的扩展位），
 * 故本轮不做。见 `resolveEngineIntent` 的 `sessionBinding` 输入。
 *
 * @param {{initial?: Record<string,string>}} [seed] 可选的初始绑定（测试用）
 * @returns {{get:Function, bind:Function, clear:Function, size:Function, snapshot:Function}}
 */
export function createEngineBindings(seed = {}) {
  const table = new Map()
  const initial = seed.initial ?? {}
  for (const [sessionId, engine] of Object.entries(initial)) {
    const normalized = normalizeEngineId(engine)
    if (typeof sessionId === 'string' && sessionId.length > 0 && normalized !== null) {
      table.set(sessionId, normalized)
    }
  }
  return {
    /**
     * 读一个会话已绑定的引擎。
     * @param {unknown} sessionId 会话 id
     * @returns {'native'|'pi'|'echo'|null} 已绑定引擎，或 null（没绑过/取值不作数）
     */
    get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      return table.get(sessionId) ?? null
    },
    /**
     * 记下一个会话落在哪个引擎（幂等覆盖；取值不作数时不写）。
     * @param {unknown} sessionId 会话 id
     * @param {unknown} engine 引擎取值
     * @returns {boolean} 是否确实写入
     */
    bind(sessionId, engine) {
      const normalized = normalizeEngineId(engine)
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      if (normalized === null) return false
      table.set(sessionId, normalized)
      return true
    },
    /**
     * 解除一个会话的绑定（用户在会话里显式改选时用）。
     * @param {unknown} sessionId 会话 id
     * @returns {boolean} 是否删掉了既有绑定
     */
    clear(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      return table.delete(sessionId)
    },
    /** @returns {number} 已绑定会话数 */
    size() {
      return table.size
    },
    /** @returns {Record<string,string>} 绑定表快照（落证据用） */
    snapshot() {
      return Object.fromEntries(table)
    },
  }
}

/**
 * 把多个来源收敛成唯一引擎结论。
 *
 * 纯函数：不读环境、不读 ctx、不抛异常 —— 判据只来自入参，便于逐条断言。
 *
 * @param {object} sources 各来源（都允许缺省）
 * @param {'pi'|'echo'|null} [sources.forcedRoute] 硬开关已解析出的强制路由
 * @param {'native'|'pi'|'echo'|null} [sources.requestMarker] 请求级意图
 * @param {'native'|'pi'|'echo'|null} [sources.sessionBinding] 会话级记忆
 * @param {boolean} [sources.presetMatched] 请求的 agentPreset 命中兼容 preset
 * @param {'native'|'pi'|'echo'|null} [sources.configEngine] 独立选择器选中的引擎
 * @returns {{engine:'native'|'pi'|'echo', source:string}} 结论与它的来源
 */
export function resolveEngineIntent(sources = {}) {
  const forced = sources.forcedRoute ?? null
  if (forced !== null) return { engine: forced, source: 'forceEngine' }

  const marker = sources.requestMarker ?? null
  if (marker !== null) return { engine: marker, source: 'requestMarker' }

  const binding = sources.sessionBinding ?? null
  if (binding !== null) return { engine: binding, source: 'sessionBinding' }

  if (sources.presetMatched === true) {
    return { engine: PI_ENGINE_ID, source: 'agentPreset' }
  }

  const selected = sources.configEngine ?? null
  if (selected !== null) return { engine: selected, source: 'config' }

  return { engine: NATIVE_ENGINE_ID, source: 'default' }
}
