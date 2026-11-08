/**
 * @local/dsh-engine-switch — ctx.agents.factory 槽位字段接管外挂 + 真实 agent/* 事件桥
 *
 * 机制（本轮范围）：
 *   1. 等 ctx.agents.factory 槽位存在（原生 AgentLoop 已 setFactory）
 *   2. 暂存原生 target
 *   3. 把「路由器」写回 ctx.agents.factory = { target: router }
 *   4. 用 ctx.effect 登记卸载时还原原生 target
 *
 * 路由分流（**Engine 与 Preset 正交**）：
 *   - 引擎结论由 engine-intent.mjs 按固定优先级收敛（见那里的表），本文件只做接线
 *   - 未命中任何引擎选择的调用 → 原样委托暂存的原生 target（零语义变更）
 *
 * 分流优先级（高 → 低，逐条可测）：
 *   forceEngine > 请求 marker（meta.engine/engine） > 会话已绑定引擎
 *     > agentPreset 兼容命中 > config.engine（独立选择器） > 原生 target
 *
 * Engine 与 Preset 为什么必须分开：
 *   Agent Preset 决定**会话内容面**（系统提示词模板 / 角色 / 工具插件集：标准、极简、
 *   创造…）；Engine 决定**底座谁在驱动**（DSH 原生 AgentLoop / OAR 驱动的 pi / 回声）。
 *   把引擎塞进 preset 下拉框（例如声明一个 `preset-pi` 业务预设）会让两个维度互相
 *   绑架：新增一个引擎就得往「标准模式/创造模式」那一列里加一项。故本插件**不再**
 *   声明任何 pi preset（cordis.patch.yml 里没有 preset-pi），引擎走自己的入口：
 *     ① 斜杠命令 `/engine [native|pi|echo]`（输入区域，见 engine-command.mjs）
 *     ② 本插件自己的配置字段 `engine`（volatile ⇒ 设置页可编辑）
 *     ③ 请求级 marker（headless / ACP / 脚本按次钉死）
 *
 * preset 兼容约定（config.piPreset，缺省 'pi'，**保留但不暴露 UI**）：
 *   options.meta.agentPreset === piPreset  → pi 引擎（真引擎，见 oar-engine.mjs）
 *   缺失或为别的值（如 'standard'）        → 不触发 preset 分流，回落后续判据，
 *                                            最终原样直通原生 target（负向防误杀）
 *   保留它的理由：改造前已建/已存量的会话可能在 header 里记着 `agentPreset: pi`，
 *   那条会话身份必须继续被认下来；它**不是**引擎的定义，只是引擎的一个兼容输入。
 *
 * marker 约定（请求级分流意图，两者自动兼容）：
 *   options.meta.engine === 'echo'  ||  options.engine === 'echo'  → 回声引擎（合成帧）
 *   options.meta.engine === 'pi'    ||  options.engine === 'pi'    → pi 引擎（真引擎，见 pi-engine.mjs）
 *   options.meta.engine === 'native'||  options.engine === 'native'→ 显式要求原生（新增取值）
 *   其余取值（'PI' / 'pi ' / 'pi-lite' / 空串 …）一律不作数（负向防误杀）
 *
 * 事件桥（本轮新增的「打通的那半步」）：
 *   - 事件分发设施来自真实上游包 `@deepseek-ai/dsh-agent` 的公开导出
 *     `agentEvents` / `emitAgentEvent`（DSH 词汇：agent/assistant-stream）。
 *   - **不使用自造事件总线**，不使用 EventEmitter 冒充；帧一律经
 *     `ctx.events`（真实 cordis Context 的 EventsService）scope-filtered dispatch 投递。
 *   - start 帧走 `emitAgentEvent`（一次性冷路径发布）；
 *     chunk / end 帧复用 `agentEvents(ctx, subject)` 构造的 retained dispatcher
 *     （热路径，与真实 AgentLoop 的 `this.dispatch = agentEvents(loopCtx, this)` 同形）。
 *
 * 诚实边界（详见 SMOKE-EVIDENCE.md）：
 *   - 本轮**不**创建真实 Agent、**不**接管真实 AgentLoop、**不**调真实模型；
 *     subject 是一个最低限度的替身对象（`kind: 'echo-subject'`），
 *     但承载它的 dispatch 与 scope carrier 全部是上游真实实现。
 *   - end 帧 outcome 为 `{ kind: 'abandoned' }`：回声引擎确实**没有**提交
 *     任何 durable 的 `assistant/message` / `assistant/attempt`（那需要真实 Session），
 *     因此不能伪称 `committed`。start.turn / start.step 亦为占位 0（无 durable turn）。
 */

import z from '@deepseek-ai/schemastery'
import { agentEvents, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import {
  createOarEngine,
  isPiMarked,
  PI_ENGINE_ID,
  PI_PROMPT,
  PI_OK_MARKER,
} from './oar-engine.mjs'
import {
  createEngineBindings,
  ECHO_ENGINE_ID as ECHO_ID,
  engineMarkerOf,
  ENGINE_IDS,
  ENGINE_SOURCES,
  NATIVE_ENGINE_ID,
  normalizeEngineId,
  resolveEngineIntent,
  sessionIdOf,
} from './engine-intent.mjs'
import {
  ENGINE_COMMAND_DESCRIPTION,
  ENGINE_COMMAND_HINT,
  ENGINE_COMMAND_NAME,
  errorResultText,
  parseEngineCommand,
  selectResultText,
  showResultText,
} from './engine-command.mjs'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'

/** agentPreset 兼容命中后路由到 pi 引擎的默认 preset 名（config.piPreset 的默认值）。 */
export const DEFAULT_PI_PRESET = 'pi'

/** 本插件在 profile 里的缺省 entry id（= settings 命名空间名，见 resolveEntryId）。 */
export const DEFAULT_ENTRY_ID = 'engine-switch'

/** cosmokit 的 volatile 写标记（跨 ESM/CJS 副本同款共享符号；只读不写）。 */
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 判定一个值是不是 cosmokit 的 volatile config 引用。
 * 用共享符号判身份（与 cosmokit 自己的 isVolatile 同款），不靠 `typeof value.get`
 * 这种形似判据 —— 普通对象带个 get 方法不该被当成引用。
 * @param {unknown} value 候选值
 * @returns {boolean} 是否为 volatile 引用
 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * 读一个 config 字段的**当前**值：volatile 引用取 get()，普通值原样返回。
 * volatile 字段会随配置层更新自动换值（loader 的 _commitVolatile），所以这里必须
 * 每次现读，不能在 apply 时快照。
 * @param {unknown} value config 字段
 * @returns {unknown} 当前值
 */
export function readVolatile(value) {
  if (!isVolatileRef(value)) return value
  try {
    return value.get()
  } catch {
    return undefined
  }
}

/**
 * schemastery Config 导出。
 *
 * - `engine`：**独立引擎选择器**（与 Agent Preset 正交）。volatile ⇒ 进 settings
 *   命名空间，设置页可编辑，且值随写入实时生效（本进程内无需重启）。
 * - `forceEngine`：运维/测试硬开关，优先级最高，语义与改造前逐字一致。
 * - `piPreset`：**兼容**用的 agentPreset 名（不再向 UI 暴露任何 pi preset）。
 * - `entryId` / `commandName` / `commandsEnabled`：`/engine` 命令与 settings 命名空间的接线。
 */
export const Config = z.object({
  engine: z.union(['native', 'pi', 'echo']).default(NATIVE_ENGINE_ID).volatile(),
  forceEngine: z.union(['native', 'pi', 'echo']).default(NATIVE_ENGINE_ID),
  piPreset: z.string().default(DEFAULT_PI_PRESET),
  entryId: z.string().default(DEFAULT_ENTRY_ID),
  commandName: z.string().default(ENGINE_COMMAND_NAME),
  commandsEnabled: z.boolean().default(true),
  evidencePath: z.string(),
  timeoutMs: z.number().default(10000),
})

/**
 * 原样再导出上游真实事件设施，供冒烟脚本做**模块实例同一性**断言：
 * 若插件用的是自造总线，`plug.agentEvents !== 上游 agentEvents` 会立刻暴露。
 * 这不是新 API，只是把「用的是真货」变成可证伪事实。
 */
export { agentEvents, emitAgentEvent }

/**
 * 再导出 pi 引擎适配器的公开面，方便冒烟脚本与宿主取用同一实例
 * （与 pi-engine.mjs 是同一模块实例，可用 === 做身份校验）。
 */
export { createOarEngine, isPiMarked, PI_ENGINE_ID, PI_PROMPT, PI_OK_MARKER }

/** 插件名（日志/效果名可读性）。 */
export const PLUGIN_NAME = '@local/dsh-engine-switch'

/** 回声引擎标识（词汇的唯一定义处是 engine-intent.mjs，此处只是转出去）。 */
export const ECHO_ENGINE_ID = ECHO_ID

/** 全部被承认的引擎 id（转出 engine-intent.mjs 的词汇）。 */
export const ENGINE_IDS_ALL = ENGINE_IDS

/** 判定来源的全部取值（转出 engine-intent.mjs 的词汇）。 */
export const ENGINE_INTENT_SOURCES = ENGINE_SOURCES

/** DSH 流式帧事件名（真实词汇，来自 dsh-agent 的 agent/* 契约）。 */
export const ECHO_STREAM_EVENT = 'agent/assistant-stream'

/** 回声替身 subject 的默认 id（非真实 Agent，仅作 scope carrier 的 key）。 */
export const ECHO_SUBJECT_ID = 'engine-switch:echo'

/** 回声引擎回显的固定文本（不调用任何真实模型）。 */
export const ECHO_TEXT =
  '[engine-switch:echo] echo engine handled this call; no model was invoked'

/** start 帧的 turn 占位值：回声引擎没有 durable turn，如实用 0。 */
export const ECHO_PLACEHOLDER_TURN = 0

/** start 帧的 step 占位值：回声引擎没有 durable step，如实用 0。 */
export const ECHO_PLACEHOLDER_STEP = 0

/**
 * 判定一次 create/resume 调用是否携带回声 marker。
 * 兼容 options.meta.engine 与 options.engine 两种写法。
 * @param {unknown} options create/resume 的调用参数
 * @returns {boolean} true 表示应交给回声引擎
 */
export function isEchoMarked(options) {
  if (options === null || typeof options !== 'object') return false
  const meta = options.meta
  const fromMeta =
    meta !== null && typeof meta === 'object' ? meta.engine : undefined
  return fromMeta === ECHO_ENGINE_ID || options.engine === ECHO_ENGINE_ID
}

/**
 * 造一个回声 subject 替身：它只做两件事——给真实 `agentEvents` 当 scope carrier 的 key、
 * 给监听器当 `agent` 身份。它**不是**真实 Agent（没有 driver、没有 session 持久化）。
 * @param {object|null|undefined} options 调用参数（用于派生可辨识的 id）
 * @returns {{id:string, session:{id:string}, kind:string, engine:string, standIn:boolean}}
 */
export function createEchoSubject(options) {
  const raw =
    options !== null && typeof options === 'object'
      ? options.sessionId ?? options.id ?? options.seed
      : undefined
  const id =
    typeof raw === 'string' && raw.length > 0
      ? `${ECHO_SUBJECT_ID}:${raw}`
      : ECHO_SUBJECT_ID
  return {
    id,
    session: { id },
    kind: 'echo-subject',
    engine: ECHO_ENGINE_ID,
    standIn: true,
  }
}

/**
 * 把固定回显文本切成 >=1 段，保证 join === 原文（用于模拟流式分片）。
 * @param {string} text 固定回显文本
 * @param {number} parts 期望分片数（文本过短时自动缩减）
 * @returns {string[]} 按顺序拼接后等于入参的分片数组
 */
export function splitEchoText(text, parts = 3) {
  const want = Math.max(1, Math.min(Math.trunc(parts) || 1, text.length))
  const out = []
  const size = Math.ceil(text.length / want)
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length > 0 ? out : ['']
}

/** 构造 start 帧（词汇对齐 dsh-agent-loop 的 AssistantStreamAttempt.start）。 */
function startFrame(attemptId, revision, turn, step) {
  return { type: 'start', attemptId, revision, turn, step }
}

/** 构造瞬态 chunk 帧（分片用 text-delta，index 从 0 稠密递增）。 */
function chunkFrame(attemptId, revision, index, time, chunk) {
  return { type: 'chunk', attemptId, revision, index, time, chunk }
}

/**
 * 构造 end 帧。index = 下一个分片位置（即已发布分片数）。
 * outcome 如实为 `abandoned`：没有任何 durable attempt 事件被提交。
 */
function endFrame(attemptId, revision, index) {
  return { type: 'end', attemptId, revision, index, outcome: { kind: 'abandoned' } }
}

/**
 * 构造一次回声 attempt 的完整有序帧序列：start → N(>=1) 个瞬态分片 → end。
 * @param {{id:string}} subject 回声 subject（仅用于 attemptId 可辨识性）
 * @param {string} text 固定回显文本
 * @param {{attemptSeq?:number, parts?:number, now?:number}} [opts]
 * @returns {{attemptId:string, frames:object[], text:string}}
 */
export function buildEchoFrames(subject, text, opts = {}) {
  const attemptSeq = Number.isFinite(opts.attemptSeq) ? opts.attemptSeq : 1
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const attemptId = `${subject?.id ?? ECHO_SUBJECT_ID}#attempt-${attemptSeq}`
  const fragments = splitEchoText(text, opts.parts ?? 3)
  let revision = 0
  const nextRevision = () => (revision += 1)
  const frames = [
    startFrame(
      attemptId,
      nextRevision(),
      ECHO_PLACEHOLDER_TURN,
      ECHO_PLACEHOLDER_STEP,
    ),
  ]
  fragments.forEach((fragment, index) => {
    frames.push(
      chunkFrame(attemptId, nextRevision(), index, now + index, {
        type: 'text-delta',
        index: 0,
        text: fragment,
      }),
    )
  })
  frames.push(endFrame(attemptId, nextRevision(), fragments.length))
  return { attemptId, frames, text }
}

/**
 * 把一次 attempt 的帧经**真实 DSH 事件设施**发出。
 * start 走 `emitAgentEvent`（单发冷路径）；其余帧复用 `agentEvents` 的 retained dispatcher。
 * @param {object} ctx 真实 cordis Context（任一 app 上下文均可，与上游文档一致）
 * @param {object} subject 事件主体（同时是 scope carrier 的 key）
 * @param {object[]} frames 有序帧序列
 * @returns {number} 已发布的帧数
 */
export function emitEchoFrames(ctx, subject, frames) {
  if (frames.length === 0) return 0
  const [head, ...tail] = frames
  // 真实导出 #1：单发一次 agent-subject 通知，不保留 dispatcher。
  emitAgentEvent(ctx, subject, ECHO_STREAM_EVENT, { frame: head })
  if (tail.length > 0) {
    // 真实导出 #2：与真实 AgentLoop 同形的 retained dispatcher（热路径复用）。
    const dispatch = agentEvents(ctx, subject)
    for (const frame of tail) dispatch.emit(ECHO_STREAM_EVENT, { frame })
  }
  return frames.length
}

/**
 * 构造回声引擎：不调模型，只回显固定文本并经真实事件设施发布合成帧。
 * stats 用于正/负向断言（未打 marker 的调用不得进入这里）。
 * @param {{streamEvent?:string}} [config]
 * @returns {{createAgent:Function, resume:Function, stats:object, runAttempt:Function}}
 */
export function createEchoEngine(config = {}) {
  const stats = {
    createAgent: 0,
    resume: 0,
    attempts: 0,
    framesEmitted: 0,
    dispatchErrors: 0,
  }

  /**
   * 一次回声 attempt：构造帧 → 经真实事件设施发布。
   * @param {object} engineCtx 真实调用方上下文（AgentRegistry 传入的 owner ctx）
   * @param {object|null} options create/resume 参数
   * @param {'createAgent'|'resume'} kind
   */
  function runAttempt(engineCtx, options, kind) {
    stats[kind] += 1
    stats.attempts += 1
    const subject = createEchoSubject(options)
    const { attemptId, frames } = buildEchoFrames(subject, ECHO_TEXT, {
      attemptSeq: stats.attempts,
    })
    let framesEmitted = 0
    try {
      framesEmitted = emitEchoFrames(engineCtx, subject, frames)
      stats.framesEmitted += framesEmitted
    } catch (error) {
      stats.dispatchErrors += 1
      throw error
    }
    return {
      engine: ECHO_ENGINE_ID,
      handledBy: `${PLUGIN_NAME}/${kind}`,
      echo: ECHO_TEXT,
      streamEvent: config.streamEvent ?? ECHO_STREAM_EVENT,
      subject,
      attemptId,
      frames,
      framesEmitted,
      options,
    }
  }

  return {
    stats,
    runAttempt,
    createAgent: async (engineCtx, options) =>
      runAttempt(engineCtx, options, 'createAgent'),
    resume: async (engineCtx, options) => runAttempt(engineCtx, options, 'resume'),
  }
}

/**
 * 构造路由器：按 marker 分流到 pi 引擎 / 回声引擎 / 暂存的原生 target。
 *
 * 分流优先级：pi marker > echo marker > 原生 target（未打 marker 一律原样委托，零回归）。
 * piEngine 可省略（省略时 pi marker 退化为原生委托，便于未接引擎的单测）。
 *
 * @param {object} nativeTarget 暂存的原生 factory target（含 createAgent/resume）
 * @param {object} echoEngine 回声引擎
 * @param {object} [piEngine] 真实 pi 引擎（pi-engine.mjs 的 createPiEngine）
 */
/** forceEngine 允许取值（精确匹配，不做近似/大小写/去空白容忍）。 */
export const FORCE_ENGINE_IDS = Object.freeze([PI_ENGINE_ID, ECHO_ENGINE_ID])

/**
 * 归一化 forceEngine 配置：非字符串 / 空串 / 纯空白 一律回落 null（= 原 marker 分流）。
 * @param {unknown} value config.forceEngine 的原始值
 * @returns {string|null} 归一化后的强制引擎标识，或 null
 */
export function normalizeForceEngine(value) {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.trim() === '') return null
  return value
}

/**
 * 归一化 piPreset 配置：非字符串 / 空串一律回落到默认 'pi'。
 * 与 forceEngine 的默认语义**刻意相反**：
 *   - forceEngine 缺省必须「不生效」，否则装了插件就回归；
 *   - piPreset 缺省必须「可用」，否则 agentPreset 分流永远开不起来。
 * @param {unknown} value config.piPreset 的原始值
 * @returns {string} 生效的 pi preset 名（默认 {@link DEFAULT_PI_PRESET}）
 */
export function normalizePiPreset(value) {
  if (typeof value !== 'string') return DEFAULT_PI_PRESET
  if (value.length === 0) return DEFAULT_PI_PRESET
  return value
}

/**
 * 判定一次 create/resume 调用是否「按 agentPreset 命中 pi」。
 *
 * 负向防误杀守卫（本函数是该守卫的唯一定义处）：
 *   meta 缺失 / meta 非对象 / agentPreset 非字符串 / agentPreset 为空串 /
 *   agentPreset !== piPreset（例如 'standard'）
 *   → 一律返回 false，调用方必须原样直通原生 target，绝不碰 pi 引擎。
 *
 * @param {unknown} options create/resume 的调用参数
 * @param {string} piPreset 生效的 pi preset 名
 * @returns {boolean} true 表示应交给 pi 引擎
 */
export function isPiPreset(options, piPreset) {
  if (options === null || typeof options !== 'object') return false
  const meta = options.meta
  if (meta === null || typeof meta !== 'object') return false
  const agentPreset = meta.agentPreset
  return typeof agentPreset === 'string' && agentPreset.length > 0 && agentPreset === piPreset
}

/**
 * 解析「强制路由」：仅当 forceEngine 精确命中已知引擎**且**该引擎实例存在时才生效；
 * 未知值（'pi '、'PI'、'auto'、'pi-lite' …）或引擎缺位一律返回 null，
 * 交由原有 marker 分流处理 —— 保证默认/异常配置下行为与改造前逐字一致。
 * @param {string|null} forceEngine 归一化后的配置值
 * @param {{piEngine?:object, echoEngine?:object}} [engines] 可用引擎实例
 * @returns {'pi'|'echo'|null} 强制路由目标，或 null（不强制）
 */
export function resolveForcedRoute(forceEngine, engines = {}) {
  if (forceEngine === PI_ENGINE_ID) return engines.piEngine ? 'pi' : null
  if (forceEngine === ECHO_ENGINE_ID) return engines.echoEngine ? 'echo' : null
  return null
}

/**
 * 构造路由器：按「引擎意图」分流到 pi 引擎 / 回声引擎 / 暂存的原生 target。
 *
 * 路由结论本身不在本函数里：它由 {@link resolveEngineIntent} 按固定优先级收敛
 * （forceEngine > 请求 marker > 会话已绑定引擎 > agentPreset 兼容命中 > config.engine
 * > 原生 target）。本函数只管：读来源 → 问结论 → 记会话绑定 → 调用对应引擎。
 *
 * 负向防误杀：任何来源里引擎取值不作数（'PI' / 'pi ' / 'pi-lite' / 空串 / null /
 * 非字符串）时该来源直接跳过；agentPreset 缺失或为别的值（如 'standard'）时
 * preset 兼容命中为 false。两者叠加的最终结果是**原样直通原生 target**，与改造前一致。
 *
 * piEngine 可省略（省略时 pi 路由退化为原生委托，便于未接引擎的单测）。
 *
 * @param {object} nativeTarget 暂存的原生 factory target（含 createAgent/resume）
 * @param {object} echoEngine 回声引擎
 * @param {object} [piEngine] 真实 pi 引擎（oar-engine.mjs 的 createOarEngine）
 * @param {{forceEngine?:string|null, piPreset?:string, readConfigEngine?:Function,
 *          bindings?:object, onNative?:Function, onEcho?:Function, onPi?:Function,
 *          onResolved?:Function, onPiResult?:Function}} [hooks]
 *   `readConfigEngine` 必须是**现读函数**而不是值：选择器是 volatile 字段，用户在设置页
 *   或 `/engine` 改了它必须立刻生效，不能在 install 时快照下来。
 */
export function createRouter(nativeTarget, echoEngine, piEngine, hooks = {}) {
  /** forceEngine 生效后的强制路由目标（null = 不强制，走引擎意图判定）。 */
  const forcedRoute = resolveForcedRoute(hooks.forceEngine ?? null, { piEngine, echoEngine })
  /** 兼容用的 agentPreset 名。 */
  const piPreset = normalizePiPreset(hooks.piPreset)
  /** 独立选择器的现读函数（缺省读不到 ⇒ null ⇒ 不作数）。 */
  const readConfigEngine = typeof hooks.readConfigEngine === 'function' ? hooks.readConfigEngine : () => null
  /** 会话 → 引擎 绑定表（进程内）：同一会话只认一个底座，见 engine-intent.mjs。 */
  const bindings = hooks.bindings ?? createEngineBindings()
  const delegate = (kind, engineCtx, options) => {
    const sessionId = sessionIdOf(options)
    const resolution = resolveEngineIntent({
      forcedRoute,
      requestMarker: engineMarkerOf(options),
      sessionBinding: bindings.get(sessionId),
      presetMatched: isPiPreset(options, piPreset),
      configEngine: normalizeEngineId(readConfigEngine()),
    })
    const route = resolution.engine
    if (sessionId !== null) bindings.bind(sessionId, route)
    if (typeof hooks.onResolved === 'function') {
      hooks.onResolved(kind, resolution, engineCtx, options)
    }
    const receiver =
      route === 'pi' ? piEngine ?? nativeTarget : route === 'echo' ? echoEngine : nativeTarget
    const notify = hooks[`on${route[0].toUpperCase()}${route.slice(1)}`]
    if (typeof notify === 'function') notify(kind, route)
    const result = Reflect.apply(receiver[kind], receiver, [engineCtx, options])
    if (route === 'pi' && typeof hooks.onPiResult === 'function') {
      // pi 引擎 attempt 是异步的：文本落证据必须发生在把结果交回调用方之前，
      // 否则 headless 进程可能在 attempt 结算前退出、pi 文本丢失。
      return Promise.resolve(result).then(
        (value) => {
          hooks.onPiResult(kind, value, null, engineCtx, options)
          return value
        },
        (error) => {
          hooks.onPiResult(kind, null, error, engineCtx, options)
          throw error
        },
      )
    }
    return result
  }
  return {
    nativeTarget,
    echoEngine,
    piEngine: piEngine ?? null,
    forceEngine: hooks.forceEngine ?? null,
    forcedRoute,
    piPreset,
    /** 选择器当前值（现读，不是 install 时的快照）。 */
    get configEngine() {
      return normalizeEngineId(readConfigEngine())
    },
    bindings,
    createAgent(engineCtx, options) {
      return delegate('createAgent', engineCtx, options)
    },
    resume(engineCtx, options) {
      return delegate('resume', engineCtx, options)
    },
  }
}

/**
 * 轮询等待 ctx.agents.factory 槽位出现（原生 AgentLoop 可能后到）。
 * @param {object} agents AgentRegistry 实例
 * @param {number} timeoutMs 等待上限
 * @returns {Promise<object>} 暂存的原生 target
 */
export function waitForFactory(agents, timeoutMs = 10000) {
  const read = () => agents && agents.factory && agents.factory.target
  const current = read()
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const target = read()
      if (target) {
        clearInterval(timer)
        resolve(target)
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        reject(
          new Error(
            `${PLUGIN_NAME}: timed out waiting for ctx.agents.factory after ${timeoutMs}ms`,
          ),
        )
      }
    }, 5)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** 状态符号：挂在路由器上供冒烟测试观察接管结果（非对外契约）。 */
export const STATE = Symbol.for('@local/dsh-engine-switch#state')

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{timeoutMs?: number}} [config]
 */
/** 接管证据 JSON 的结构版本号（字段变更时递增）。 */
export const EVIDENCE_VERSION = 2

/** 证据里保存的会话→引擎绑定条数上限（只保尾部，不随会话数无限膨胀）。 */
export const BINDING_SNAPSHOT_LIMIT = 50

/** 上游共享符号：cordis 追踪代理上指向真实服务实例（与 AgentRegistry.setFactory 同一约定）。 */
export const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * 接管证据落盘器：把「外挂是否真的接管了真实 ctx.agents.factory」写成一份
 * 可被 endo.sh 独立读取、逐字段断言的 JSON。
 *
 * 写入时机：apply 阶段（同步快路径接管完成即刻）、每次路由委托、进程退出，
 * 因此 delegationsToNative 反映**真实运行期**被委托到原生 AgentLoop 的次数。
 *
 * @param {{evidencePath?: string}} [config] 插件 config；evidencePath 为落盘路径
 * @returns {{file: string|null, evidence: object, write: (phase?: string) => object}}
 */
export function createEvidenceStore(config = {}) {
  const file =
    typeof config.evidencePath === 'string' && config.evidencePath.trim() !== ''
      ? config.evidencePath
      : null
  const evidence = {
    plugin: PLUGIN_NAME,
    evidenceVersion: EVIDENCE_VERSION,
    evidencePath: file,
    safeMode: false,
    nativeTargetIsAgentLoop: false,
    nativeTargetCtorName: null,
    nativeTargetEqualsCtxAgentLoop: false,
    ctxAgentLoopCtorName: null,
    ctxAgentLoopUnwrapped: false,
    routerInstalled: false,
    agentsFactorySlotIsRouter: false,
    delegationsToNative: 0,
    delegationsToPi: 0,
    spawnedEchoEngineCalls: 0,
    nativeByKind: { createAgent: 0, resume: 0 },
    echoByKind: { createAgent: 0, resume: 0 },
    piByKind: { createAgent: 0, resume: 0 },
    forcedEngine: null,
    forcedRoute: null,
    // —— 独立引擎选择器（Engine ⊥ Preset）的可观测面 ——
    /** 选择器当前值（config.engine 现读归一化后的引擎 id）。 */
    engineSelector: null,
    /** 选择器原始值（非字符串时记 String()，仅供诊断，不参与判定）。 */
    engineSelectorRaw: null,
    /** 最后一次现读发生在哪个阶段（'apply' | 'command'）。 */
    engineSelectorPhase: null,
    /** 本插件在 profile 里的 entry id（= settings 命名空间名）。 */
    engineEntryId: null,
    /**
     * 上面那个 id 是怎么来的：
     * 'fiber-options' = loader 声明 id（真机常态）| 'fiber-entry' = 树内限定 id |
     * 'config' = config.entryId | 'default' = 内置缺省。
     */
    engineEntryIdSource: null,
    /** 最近一次 create/resume 的引擎结论 `{engine, source}`。 */
    engineIntent: null,
    /** 每种判定来源各决定过多少次（含 default）。 */
    engineSourceCounts: {
      forceEngine: 0,
      requestMarker: 0,
      sessionBinding: 0,
      agentPreset: 0,
      config: 0,
      default: 0,
    },
    /** 会话→引擎 绑定表规模与快照（快照上限 50 条，防止证据无限膨胀）。 */
    engineBindingCount: 0,
    engineBindings: {},
    // —— `/engine` 命令（选择器在输入区域的入口）——
    commandName: null,
    commandRegistered: false,
    commandError: null,
    commandRuns: 0,
    commandLastOutcome: null,
    commandLastEngine: null,
    commandLastError: null,
    commandLastBindingCleared: null,
    piText: '',
    piTextLength: 0,
    piTextDeltas: 0,
    piAttemptId: null,
    piEngineError: null,
    piRpcClientSource: null,
    piChildPid: null,
    runtimeId: null,
    provider: null,
    effectiveModel: null,
    takeoverPhase: 'not-installed',
    failReason: null,
    writes: 0,
    lastWriteError: null,
    updatedAt: null,
  }
  const bump = (bucket, kind) => {
    if (kind !== 'createAgent' && kind !== 'resume') return
    bucket[kind] = (bucket[kind] ?? 0) + 1
  }
  const write = (phase) => {
    evidence.writes += 1
    evidence.updatedAt = new Date().toISOString()
    if (typeof phase === 'string') evidence.takeoverPhase = phase
    if (file === null) return evidence
    try {
      mkdirSync(dirname(file), { recursive: true })
      const staging = `${file}.tmp-${process.pid}`
      writeFileSync(staging, `${JSON.stringify(evidence, null, 2)}\n`)
      renameSync(staging, file)
    } catch (error) {
      evidence.lastWriteError = String(error)
    }
    return evidence
  }
  return {
    file,
    evidence,
    write,
    countNative(kind) {
      evidence.delegationsToNative += 1
      bump(evidence.nativeByKind, kind)
      write('delegation-native')
    },
    countEcho(kind) {
      evidence.spawnedEchoEngineCalls += 1
      bump(evidence.echoByKind, kind)
      write('echo-engine')
    },
    countPi(kind) {
      evidence.delegationsToPi += 1
      bump(evidence.piByKind, kind)
      write('pi-engine')
    },
    /**
     * 记一次引擎结论（来源 + 引擎）与当前会话绑定表。
     * @param {'native'|'pi'|'echo'} engine 引擎结论
     * @param {string} source 结论来源（见 ENGINE_SOURCES）
     * @param {object} [bindings] 会话绑定表（提供时顺便快照）
     * @returns {object} 证据对象
     */
    recordEngineIntent(engine, source, bindings) {
      evidence.engineIntent = { engine: engine ?? null, source: source ?? null }
      if (typeof source === 'string' && Object.hasOwn(evidence.engineSourceCounts, source)) {
        evidence.engineSourceCounts[source] += 1
      }
      if (bindings !== undefined && bindings !== null) {
        evidence.engineBindingCount = bindings.size()
        const entries = Object.entries(bindings.snapshot())
        evidence.engineBindings = Object.fromEntries(entries.slice(-BINDING_SNAPSHOT_LIMIT))
      }
      write('engine-intent')
      return evidence
    },
    /**
     * 记选择器的当前值（每次现读都写一次，便于观察 settings 写入是否真的换值）。
     * @param {unknown} normalized 归一化后的引擎 id（或 null）
     * @param {unknown} raw 原始值
     * @returns {object} 证据对象
     */
    recordEngineSelector(normalized, raw, phase) {
      evidence.engineSelector = normalized ?? null
      evidence.engineSelectorRaw = typeof raw === 'string' ? raw : raw === undefined ? null : String(raw)
      evidence.engineSelectorPhase = phase ?? null
      write('engine-selector')
      return evidence
    },
    /**
     * 记 entry id 的解析结果。
     * @param {string} entryId settings 命名空间名
     * @param {'fiber-options'|'fiber-entry'|'config'|'default'} source 来源
     * @returns {object} 证据对象
     */
    recordEntryId(entryId, source) {
      evidence.engineEntryId = entryId
      evidence.engineEntryIdSource = source
      write('engine-entry-id')
      return evidence
    },
    /**
     * 记 `/engine` 命令的注册结果。
     * @param {{name?:string, registered:boolean, error?:unknown}} outcome 注册结果
     * @returns {object} 证据对象
     */
    recordCommandRegistration(outcome) {
      evidence.commandName = outcome.name ?? evidence.commandName
      evidence.commandRegistered = outcome.registered === true
      evidence.commandError =
        outcome.error === undefined || outcome.error === null ? null : String(outcome.error)
      write('engine-command')
      return evidence
    },
    /**
     * 记一次 `/engine` 命令执行。（只记结果面，不记用户原文。）
     * @param {{outcome:string, engine?:string, bindingCleared?:boolean, error?:unknown}} run 执行结果
     * @returns {object} 证据对象
     */
    recordCommandRun(run) {
      evidence.commandRuns += 1
      evidence.commandLastOutcome = run.outcome ?? null
      evidence.commandLastEngine = run.engine ?? null
      evidence.commandLastBindingCleared =
        run.bindingCleared === undefined ? null : run.bindingCleared
      evidence.commandLastError =
        run.error === undefined || run.error === null ? null : String(run.error)
      write('engine-command-run')
      return evidence
    },
    /**
     * 记录 pi 引擎一次 attempt 的**真实**产出（PI_TEXT_IN_REAL_DSH 的唯一依据）。
     * 文本取自 pi 子进程 text_delta 拼接（pi-engine.mjs 的 mapper.text），非本地伪造；
     * 失败路径同样落盘 piEngineError，禁止把失败伪装成空文本通过。
     * @param {'createAgent'|'resume'} kind 调用种类
     * @param {object|null} result pi 引擎 attempt 结果
     * @param {unknown} [error] 调用抛出的错误（若有）
     * @returns {object} 证据对象
     */
    recordPiResult(kind, result, error) {
      if (result !== null && typeof result === 'object') {
        const text = typeof result.piText === 'string' ? result.piText : result.text
        if (typeof text === 'string') {
          evidence.piText = text
          evidence.piTextLength = text.length
        }
        if (Number.isFinite(result.textDeltas)) evidence.piTextDeltas = result.textDeltas
        if (typeof result.attemptId === 'string') evidence.piAttemptId = result.attemptId
        if (typeof result.rpcClientSource === 'string') {
          evidence.piRpcClientSource = result.rpcClientSource
        }
        if (Number.isSafeInteger(result.childPid)) evidence.piChildPid = result.childPid
        if (typeof result.error === 'string' && result.error !== '') {
          evidence.piEngineError = result.error
        }
        if (typeof result.runtimeId === 'string') evidence.runtimeId = result.runtimeId
        if (typeof result.provider === 'string') evidence.provider = result.provider
        if (typeof result.effectiveModel === 'string') evidence.effectiveModel = result.effectiveModel
      }
      if (error !== null && error !== undefined) {
        evidence.piEngineError = error instanceof Error ? error.message : String(error)
      }
      write('pi-text')
      return evidence
    },
  }
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{timeoutMs?: number, evidencePath?: string}} [config]
 */
/**
 * 解析本插件在 profile 里的 entry id（= settings 命名空间名）。
 *
 * 优先级：loader 声明的 entry id（`fiber.entry.options.id`）> 树内限定 id
 * （`fiber.entry.id`）> config.entryId > 内置缺省。
 *
 * **为什么先看 `options.id` 而不是 `entry.id`**（真机启动实测，不是推测）：
 * bundle patch 的 `insert` 行被 loader 挂进 `include:` 树后，`ctx.fiber.entry.id`
 * 会变成**树内限定 id**（实测拿到的是 `include:engine-switch`），而 settings 的命名空间
 * 是按**声明 id**（`entry.options.id` = `engine-switch`）登记的（`dsh-settings` 的
 * `describe()` 里逐字是 `ns: entry.options.id`）。拿限定 id 去写 settings 会报
 * `namespace-unavailable` —— 这一条只有在真机启动里才能看到，所以抽成纯函数直接测。
 *
 * @param {object|null|undefined} entryRef loader 条目（`ctx.fiber.entry`）
 * @param {{entryId?:unknown}} [config] 插件配置
 * @returns {{entryId:string, source:'fiber-options'|'fiber-entry'|'config'|'default'}}
 */
export function resolveEngineEntryId(entryRef, config = {}) {
  const declared = entryRef?.options?.id
  if (typeof declared === 'string' && declared.length > 0) {
    return { entryId: declared, source: 'fiber-options' }
  }
  const qualified = entryRef?.id
  if (typeof qualified === 'string' && qualified.length > 0) {
    return { entryId: qualified, source: 'fiber-entry' }
  }
  if (typeof config.entryId === 'string' && config.entryId.length > 0) {
    return { entryId: config.entryId, source: 'config' }
  }
  return { entryId: DEFAULT_ENTRY_ID, source: 'default' }
}

/**
 * 把引擎选择器写进本插件自己的 volatile 配置字段。
 *
 * 为什么不造一个自定 remote：第三方插件要暴露 remote 得自带一套 Typert 生成物
 * （reflection + 严格 codec + lookup provider + 客户端 $mount），代价与失败面都远大于
 * 收益；而 DSH 已经给了**通用**的 settings 写入口（`ctx.remote.settings.*`），它的
 * 命名空间就是「插件的 profile entry id」，可写字段就是「该插件声明的 volatile 字段」。
 * 所以引擎选择器就直接落在本插件自己的配置字段 `engine` 上：桌面端的设置页能改它，
 * `/engine` 命令也能改它，两边改的是同一个权威值。
 *
 * 不抛异常：失败以 `{ok:false, error}` 返回，由命令层翻成人话文案（不静默吞）。
 *
 * @param {object} ctx 插件上下文
 * @param {string} entryId settings 命名空间名（= 本插件的 profile entry id）
 * @param {unknown} engine 目标引擎
 * @returns {Promise<{ok:true}|{ok:false, error:string, token?:string, detail?:string}>} 写入结果
 */
export async function writeEngineSelector(ctx, entryId, engine) {
  const normalized = normalizeEngineId(engine)
  if (normalized === null) return { ok: false, error: 'unknown-engine', token: String(engine) }
  const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
  if (settings === undefined || settings === null) return { ok: false, error: 'settings-unavailable' }
  if (typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
    return { ok: false, error: 'write-failed', detail: 'settings service lacks describe()/update()' }
  }
  let rows
  try {
    rows = settings.describe()
  } catch (error) {
    return { ok: false, error: 'write-failed', detail: String(error?.message ?? error) }
  }
  const row = Array.isArray(rows) ? rows.find((item) => item?.ns === entryId) : undefined
  if (row === undefined) {
    return { ok: false, error: 'namespace-unavailable', detail: entryId }
  }
  try {
    // 带 revision 写：配置在我们读取之后被别人改过时会被拒，而不是把别人的改动覆盖掉。
    await settings.update(entryId, { engine: normalized }, row.revision)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: 'write-failed', detail: String(error?.message ?? error) }
  }
}

/**
 * 注册 `/engine` 斜杠命令 —— 独立引擎选择器在**输入区域**的入口。
 *
 * 命令面是 DSH 的一等公民（`dsh-commands` + `dsh-client-ui-commands`）：插件在 host 侧
 * 注册，Web/桌面端的 `/` 菜单自动出现，与 preset 下拉框毫无关系（正交）。
 *
 * 可选依赖（不在 inject 里硬要）：`commands` 缺失时本函数静默不注册，把事实写进证据，
 * 插件的路由能力不受任何影响。
 *
 * @param {object} ctx 插件上下文
 * @param {object} config 插件配置
 * @param {object} store 证据落盘器
 * @param {object} bindings 会话→引擎绑定表
 * @param {string} entryId settings 命名空间名
 * @param {(phase:string)=>(string|null)} readSelector 选择器现读函数
 * @returns {{name:string, fiber:object|null, error:string|null}} 注册结果
 */
export function registerEngineCommand(ctx, config, store, bindings, entryId, readSelector) {
  const name =
    typeof config.commandName === 'string' && config.commandName.length > 0
      ? config.commandName
      : ENGINE_COMMAND_NAME
  if (config.commandsEnabled === false) {
    store.recordCommandRegistration({ name, registered: false, error: 'disabled-by-config' })
    return { name, fiber: null, error: 'disabled-by-config' }
  }
  if (typeof ctx?.inject !== 'function') {
    store.recordCommandRegistration({ name, registered: false, error: 'no-inject' })
    return { name, fiber: null, error: 'no-inject' }
  }
  let fiber = null
  try {
    fiber = ctx.inject(['commands'], (commandCtx) => {
      try {
        commandCtx.commands.register({
          name,
          description: ENGINE_COMMAND_DESCRIPTION,
          // 不把命令原文写进会话史：这次选择的权威记录是本插件的 settings 文档
          // （profile Cordis patch），会话史里再记一份只增噪声、没有读者。
          recordInput: false,
          input: { hint: ENGINE_COMMAND_HINT },
          handler: async ({ agent, rawInput }) => {
            const parsed = parseEngineCommand(rawInput)
            const sessionId =
              typeof agent?.session?.id === 'string'
                ? agent.session.id
                : typeof agent?.id === 'string'
                  ? agent.id
                  : null
            if (parsed.kind === 'show') {
              store.recordCommandRun({ outcome: 'show' })
              return {
                kind: 'success',
                text: showResultText({
                  selectorEngine: readSelector('command'),
                  sessionEngine: bindings.get(sessionId),
                  sessionId,
                }),
              }
            }
            if (parsed.kind !== 'select') {
              store.recordCommandRun({
                outcome: parsed.kind,
                error: parsed.kind === 'unknown' ? parsed.token : parsed.reason,
              })
              return {
                kind: 'error',
                text:
                  parsed.kind === 'unknown'
                    ? errorResultText({ error: 'unknown-engine', token: parsed.token })
                    : errorResultText({ error: 'bad-input' }),
              }
            }
            const write = await writeEngineSelector(ctx, entryId, parsed.engine)
            if (write.ok !== true) {
              store.recordCommandRun({ outcome: 'error', engine: parsed.engine, error: write.error })
              return { kind: 'error', text: errorResultText(write) }
            }
            // 用户在本会话里显式改选 ⇒ 解除本会话的历史绑定，让这次选择对当前会话也生效
            // （在它下次被 DSH 重新载入时；活体换装在第三方插件里没有口子，见 selectResultText）。
            const bindingCleared = bindings.clear(sessionId)
            store.recordCommandRun({
              outcome: 'select',
              engine: parsed.engine,
              bindingCleared,
            })
            return {
              kind: 'success',
              text: selectResultText({ engine: parsed.engine, bindingCleared }),
            }
          },
        })
        store.recordCommandRegistration({ name, registered: true, error: null })
      } catch (error) {
        store.recordCommandRegistration({ name, registered: false, error })
        if (typeof commandCtx.logger?.warn === 'function') {
          commandCtx.logger.warn('dsh-engine-switch: failed to register /%s: %o', name, error)
        }
      }
    })
  } catch (error) {
    store.recordCommandRegistration({ name, registered: false, error })
    return { name, fiber: null, error: String(error?.message ?? error) }
  }
  return { name, fiber: fiber ?? null, error: null }
}

export function apply(ctx, config = {}) {
  // L0 安全模式：环境变量 DSH_ENGINE_SWITCH_DISABLE=1 时，插件等于不存在
  if (process.env.DSH_ENGINE_SWITCH_DISABLE === '1') {
    const store = createEvidenceStore(config)
    store.evidence.safeMode = true
    store.evidence.routerInstalled = false
    store.evidence.agentsFactorySlotIsRouter = false
    store.evidence.takeoverPhase = 'safe-mode-disabled'
    store.write('safe-mode')
    return
  }

  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 10000
  /** pi 引擎配置（config.pi.*）；agentDir 缺省回落到 PI_CODING_AGENT_DIR 环境变量。 */
  const piConfig =
    config.pi !== null && typeof config.pi === 'object' ? config.pi : {}
  if (piConfig.agentDir === undefined) {
    piConfig.agentDir = process.env.PI_CODING_AGENT_DIR
  }
  /** forceEngine 配置：默认 null（保持既有 marker 分流，零行为变更）；'pi' 时所有 create/resume 一律交给 pi 引擎。 */
  const forceEngine = normalizeForceEngine(config.forceEngine)
  if (forceEngine !== null) process.env.DSH_ENGINE_SWITCH_FORCE_ENGINE = forceEngine
  /** agentPreset 兼容配置：options.meta.agentPreset 命中该名时一律交给 pi 引擎；缺省 'pi'。 */
  const piPreset = normalizePiPreset(config.piPreset)
  const store = createEvidenceStore(config)

  /**
   * 选择器的**现读**唯一定义处。
   * volatile 字段会随 settings 写入自动换值（loader 的 _commitVolatile），因此每次
   * 判定都现读，绝不在 apply 时快照 —— 否则用户在设置页/命令里改了不生效。
   * @returns {{normalized:'native'|'pi'|'echo'|null, raw:unknown}}
   */
  const readEngineSelectorNow = () => {
    const raw = readVolatile(config.engine)
    return { normalized: normalizeEngineId(raw), raw }
  }

  /**
   * 现读 + 落证据（apply / `/engine` 命令这两个低频入口用）。
   * 路由热路径**不**走这里：那会变成每次 create/resume 都写一次证据文件，
   * 而热路径的结论已经由 engineIntent 记录下来。
   * @param {'apply'|'command'} phase 现读阶段
   * @returns {'native'|'pi'|'echo'|null} 归一化后的选择器值
   */
  const readEngineSelector = (phase) => {
    const { normalized, raw } = readEngineSelectorNow()
    store.recordEngineSelector(normalized, raw, phase)
    return normalized
  }

  const entry = resolveEngineEntryId(ctx?.fiber?.entry, config)
  store.recordEntryId(entry.entryId, entry.source)
  /** apply 时先现读一次选择器：证据里就能看到「本进程开始时选择器是什么」。 */
  readEngineSelector('apply')
  /** 会话 → 引擎 绑定表（进程内）：同一会话只认一个底座。 */
  const bindings = createEngineBindings()
  const registerCommand = registerEngineCommand(ctx, config, store, bindings, entry.entryId, readEngineSelector)
  const state = {
    installed: null,
    disposed: false,
    installPromise: null,
    get nativeTarget() {
      return state.installed?.nativeTarget
    },
    get router() {
      return state.installed?.router
    },
    get echoEngine() {
      return state.installed?.echoEngine
    },
    get piEngine() {
      return state.installed?.piEngine
    },
  }

  /**
   * 真实接管（幂等）：暂存原生 target → 写入路由器 → 回读槽位 → 落证据。
   * @param {object} agents 真实 AgentRegistry（ctx.agents）
   * @param {object} agentsCtx 提供 agents 的真实 cordis 上下文
   * @returns {object|null} 接管结果，或 null（factory 尚未注册）
   */
  const install = (agents, agentsCtx) => {
    if (state.installed) return state.installed
    const nativeTarget = agents?.factory?.target
    if (nativeTarget === undefined) return null
    const ctxAgentLoopService =
      typeof agentsCtx.get === 'function' ? agentsCtx.get('agentLoop') : undefined
    const ctxAgentLoop = ctxAgentLoopService?.[CORDIS_ORIGINAL] ?? ctxAgentLoopService
    const echoEngine = createEchoEngine(config)
    // 真引擎：pi 引擎只在被 marker 命中时才 spawn 子进程（懒启动，见 pi-engine.mjs）。
    const piEngine = createOarEngine({
      agentDir: piConfig.agentDir,
      timeoutMs: Number.isFinite(piConfig.timeoutMs) ? piConfig.timeoutMs : 45000,
      prompt: piConfig.prompt,
      args: piConfig.args,
      provider: piConfig.provider,
      model: piConfig.model,
      cliPath: piConfig.cliPath,
      cwd: piConfig.cwd,
      piModulePath: piConfig.piModulePath,
    })
    const router = createRouter(nativeTarget, echoEngine, piEngine, {
      forceEngine,
      piPreset,
      readConfigEngine: () => readEngineSelectorNow().normalized,
      bindings,
      onNative: (kind) => store.countNative(kind),
      onEcho: (kind) => store.countEcho(kind),
      onPi: (kind) => store.countPi(kind),
      onResolved: (kind, resolution) => {
        store.recordEngineIntent(resolution.engine, resolution.source, bindings)
      },
      onPiResult: async (kind, result, error, engineCtx, options) => {
        // createAgent 阶段：只建会话，不跑 pi（把 pi 留给 followup）
        if (kind === 'createAgent') {
          const sessionId = options?.sessionId
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            // prepare + enter + announce（只做一次），保留 Session
            const sessions = ctx.get('sessions')
            let session = null
            if (sessions !== undefined) {
              session = sessions.prepare(sessionId, {})
              sessions.enter(session)
              sessions.announce(session)
            }
            
            // 把真实 Session 注入到 result.subject，作为 agent.session 暴露
            if (session !== null && result && result.subject) {
              result.subject.session = session
              
              // 实现真实的 followup/whenIdle/status 契约
              let inFlight = Promise.resolve()
              let status = 'idle'
              
              result.subject.followup = (message) => {
                status = 'running'
                inFlight = (async () => {
                  try {
                    // 从 message 提取真实用户文本（headless 传的是 createUserMessage）
                    let userText = ''
                    if (message && Array.isArray(message.content)) {
                      for (const block of message.content) {
                        if (block && block.type === 'text' && typeof block.text === 'string') {
                          userText += block.text
                        }
                      }
                    }
                    
                    // 跑一次 pi，传入真实用户文本
                    const piResult = await piEngine.runAttempt(engineCtx, {
                      ...options,
                      prompt: userText,
                    }, 'resume')
                    
                    const piText = typeof piResult.piText === 'string' ? piResult.piText : piResult.text ?? ''
                    
                    // 写入 piText/piTextLength 供断言读取
                    store.recordPiResult('resume', piResult, null)
                    
                    // followup 阶段：直接向保留的 Session 追加三段事件并 flush
                    const turn = 1
                    const step = 1
                    session.append('turn/start', { turn })
                    
                    const assistantMessage = createAssistantMessage({ 
                      content: [{ type: 'text', text: piText }], 
                      source: { provider: 'pi', model: 'pi' } 
                    })
                    session.append('assistant/message', { turn, step, message: assistantMessage }, { surfaceOp: 'append' })
                    
                    session.append('turn/end', { turn, reason: { kind: 'completed' } })
                    
                    // flush（让事件持久化）
                    await sessions.flush(session)
                    
                    store.evidence.sessionId = sessionId
                    store.evidence.assistantMessageAppended = true
                    store.evidence.committedText = piText
                    store.evidence.commitError = null
                  } catch (e) {
                    store.evidence.sessionId = sessionId ?? null
                    store.evidence.assistantMessageAppended = false
                    store.evidence.committedText = null
                    store.evidence.commitError = String(e && e.message ? e.message : e)
                  } finally {
                    status = 'idle'
                  }
                })()
                return inFlight
              }
              
              result.subject.whenIdle = () => inFlight
              
              Object.defineProperty(result.subject, 'status', {
                get: () => status,
                enumerable: true,
              })
            }
            
            // 包装成 headless 期望的 {agent} 结构
            if (result && result.subject) {
              result.agent = result.subject
            }
          }
        } else {
          // resume 阶段：记录 pi 结果（但 resume 现在不会被调用，因为 pi 在 followup 里）
          store.recordPiResult(kind, result, error)
        }
        store.write('pi-commit')
      },
    })
    router[STATE] = state
    router[STATE] = state
    state.installed = { nativeTarget, router, echoEngine, piEngine }
    // 字段接管：把路由器写回真实 factory 槽位。
    agents.factory = { target: router }
    const slotAfter = agents.factory?.target
    const nativeCtor = nativeTarget?.constructor?.name ?? null
    Object.assign(store.evidence, {
      forcedEngine: forceEngine,
      forcedRoute: router.forcedRoute,
      piPreset: router.piPreset,
      nativeTargetIsAgentLoop: nativeCtor === 'AgentLoop',
      nativeTargetCtorName: nativeCtor,
      nativeTargetEqualsCtxAgentLoop: ctxAgentLoop !== undefined && ctxAgentLoop === nativeTarget,
      ctxAgentLoopCtorName: ctxAgentLoop?.constructor?.name ?? null,
      ctxAgentLoopUnwrapped: ctxAgentLoopService !== undefined && ctxAgentLoop !== ctxAgentLoopService,
      routerInstalled: slotAfter === router,
      agentsFactorySlotIsRouter: slotAfter === router,
      takeoverPhase: 'apply',
    })
    store.write('apply')
    return state.installed
  }

  // 进程退出时（headless 走 AppExit → process.exit）再落一次终态证据。
  process.on('exit', () => store.write('process-exit'))

  ctx.inject(['agents'], (agentsCtx) => {
    const agents = agentsCtx.agents

    // 同步快路径：原生 AgentLoop 已 setFactory 时，apply 阶段即完成接管，
    // 不给 headless runner 的 agents.create() 留下竞态窗口。
    if (agents?.factory?.target !== undefined) {
      install(agents, agentsCtx)
    } else {
      state.installPromise = waitForFactory(agents, timeoutMs).then(
        () => (state.disposed ? state.installed : install(agents, agentsCtx)),
        (error) => {
          store.evidence.failReason = `waitForFactory: ${String(error)}`
          store.write('factory-timeout')
          return null
        },
      )
    }

    // 同步登记卸载还原效果：仅在当前槽位仍是本插件路由器时还原。
    agentsCtx.effect(
      () => () => {
        state.disposed = true
        const installed = state.installed
        if (!installed) return
        if (
          agents.factory !== undefined &&
          agents.factory.target === installed.router
        ) {
          agents.factory = { target: installed.nativeTarget }
        }
        state.installed = null
      },
      `${PLUGIN_NAME}:restore`,
    )
  })
}
