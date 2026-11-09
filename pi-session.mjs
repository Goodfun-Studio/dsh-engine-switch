/**
 * pi-session.mjs —— pi 引擎的「会话 / Agent 生命周期宿主」（L7）
 *
 * ## 为什么需要它（L7 现场：桌面端重启后「新建会话」报错）
 *
 * 改造前的 pi 路由只把 pi 的**替身 subject** 塞回给调用方，替身 id 还带着
 * `engine-switch:oar-pi:` 前缀。这在 headless 里够用（headless 直接拿返回对象
 * 调 followup/whenIdle），但在桌面端（HTTP/Web RPC 面）会连锁炸：
 *
 *   · `sessionController.create()` 逐字取 `created.agent.id` 当会话身份
 *     ⇒ RPC 返回一个不存在的 sessionId（前端导航过去必然 session/not-found）；
 *   · `workspace.attachSession()` 拿这个 id 去持久化里校验
 *     ⇒ `session/workspace-attach-failed: session persistence holds no such session`（老板看到的报错）；
 *   · 会话没有 cwd 元数据 ⇒ `readState` / attach 校验必挂；
 *   · Agent 从未注册进 `ctx.agents` ⇒ `session/prompt` 准入、`session/control` 解析不到；
 *   · 流式帧按 `agent.session.id` 路由 ⇒ 帧挂在前缀 id 下，前端订阅真实会话 id 永远收不到。
 *
 * 本模块把「pi 会话在 DSH 里的生命周期」收敛成一件事，照抄上游 AgentLoop 的
 * 创建事务（`sessionPersistence.create` → `sessions.prepare/enter/announce` →
 * `agents.enter/announce`），只是驱动方换成 pi：
 *
 *   attach()   建/复用 Session（带 meta.cwd/agentPreset）→ 落盘 → enter/announce → 绑到替身身份
 *   publish()  把替身注册进 `ctx.agents`（enter + announce），并装上 Agent 的表面契约
 *              （followup / steer / whenIdle / status / inbox / model / cancel）
 *   turn        followup 触发一次 pi attempt，成败都写成 durable turn 事件（turn/start …
 *              user/message … assistant/message … step/end … turn/end），并 flush
 *
 * ## 诚实边界（不做的事，明确写在这里）
 *
 *   · 替身**不是**真实 AgentLoop 驱动：没有 DSH 的工具循环、审批、上下文组装；
 *     `kind: 'pi-subject'` / `standIn: true` 如实标注身份，不冒充。
 *   · `setup`（preset 挂载 / 模型选择安装）**不执行**：preset 是内容面，pi 引擎按自己的
 *     系统提示词跑；会话 header 仍如实记录 `agentPreset`（身份与引擎正交）。
 *   · 一次 attempt 中途不可打断：`cancel()` 只保证「未提交的 attempt 不再写入会话」。
 *   · `resume`（冷开一个已存在会话）不在本轮范围：`attach` 只服务 create。
 *
 * ## 依赖注入
 *
 * 全部 DSH 服务都通过 `config.get(name)` 现取（`ctx.get`），绝不 import 服务单例：
 * 拿不到就**如实跳过并记证据**，不让插件 pending、也不炸宿主。
 */

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'

/** pi 替身 Agent 的 kind（与 oar-engine.mjs / pi-engine.mjs 的词汇一致）。 */
export const PI_AGENT_KIND = 'pi-subject'

/** pi 引擎写进 assistant/message 的 source（如实标注产出方是 pi，不是某个 DSH 模型）。 */
export const PI_ASSISTANT_SOURCE = Object.freeze({ provider: 'pi', model: 'pi' })

/** 允许从 `options.meta` 透传进 SessionHeader 的字段（白名单：别的字段不进 header）。 */
export const SESSION_META_FIELDS = Object.freeze([
  'cwd',
  'agentPreset',
  'createdAt',
  'parentSession',
  'isSeeded',
  'origin',
  'delegationDepth',
])

/** Durable turn 事件的完整形状（顺序即写入顺序；用于断言与证据）。 */
export const TURN_EVENT_TYPES = Object.freeze([
  'turn/start',
  'user/message',
  'step/start',
  'assistant/message',
  'step/end',
  'turn/end',
])

/**
 * 从 create 请求的参数里取会话身份（`options.sessionId` 优先，其次 `resumeSessionId`）。
 * @param {unknown} options create/resume 参数
 * @returns {string|null} 会话 id 或 null
 */
export function sessionIdOfOptions(options) {
  if (options === null || typeof options !== 'object') return null
  const raw = options.sessionId ?? options.resumeSessionId
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * 白名单拷贝 `options.meta` 里的会话创建元数据。
 * @param {unknown} meta 请求自带的 meta
 * @returns {Record<string, unknown>} 只含白名单字段的浅拷贝（可能为空对象）
 */
export function pickSessionMeta(meta) {
  if (meta === null || typeof meta !== 'object') return {}
  const picked = {}
  for (const field of SESSION_META_FIELDS) {
    if (Object.hasOwn(meta, field) && meta[field] !== undefined) picked[field] = meta[field]
  }
  return picked
}

/**
 * 造一个 pi 替身身份：id 就是**真实会话 id**（上游 `AgentRegistry.enter` 硬校验
 * `agent.id === agent.session.id`，且 sessionController 逐字把 `agent.id` 当会话身份）。
 * @param {string} sessionId 真实会话 id
 * @returns {object} 替身 subject
 */
export function createStandInSubject(sessionId) {
  return {
    id: sessionId,
    session: { id: sessionId },
    kind: PI_AGENT_KIND,
    engine: 'pi',
    standIn: true,
  }
}

/**
 * 判定「持久化里没有这个会话」类错误（read/open 找不到日志）。
 * 用错误名判定：持久化后端是可选依赖，不能 import 它的错误类。
 * @param {unknown} error 候选错误
 * @returns {boolean} 是否属于「不存在」
 */
export function isSessionNotFoundError(error) {
  const name = error?.name
  return (
    name === 'SessionPersistenceNotFoundError' ||
    name === 'SessionQueryError' ||
    error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
  )
}

/**
 * 判定「持久化里已经有这个会话」类错误（create 撞已有日志）。
 * @param {unknown} error 候选错误
 * @returns {boolean} 是否属于「已存在」
 */
export function isSessionAlreadyExistsError(error) {
  return error?.name === 'SessionAlreadyExistsError'
}

/**
 * 从一个 user message 里抽纯文本（pi 的 prompt 只吃文本）。
 * @param {unknown} message createUserMessage 的产物
 * @returns {string} 拼接后的文本
 */
export function textOfUserMessage(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * 构造一段**可落盘的** assistant 流（settlement 字段）。
 *
 * 为什么不能省：会话日志的冷读（`sessionPersistence` 回读 + `Session.fromRestore`）会对
 * 存盘的 `assistant/message` 做 settlement 校验（`assertAssistantSettlementShape`）——
 * 缺 `turn`/`step`/`stream` 中的任何一个，整条会话会被判定为
 * `stored session "…" is corrupt: seed assistant/message at index N has invalid settlement fields`，
 * 于是**重启后旧会话打不开**。词汇照抄真机日志：
 *   {type:'chunk', time, chunk:{type:'block-start', index:0, blockType:'text'}}
 *   {type:'chunk', time, chunk:{type:'text-delta', index:0, text}}
 *   {type:'chunk', time, chunk:{type:'block-end', index:0, block:{type:'text', text}}}
 *
 * @param {string} text 本轮 assistant 的完整文本
 * @param {number} [time] 统一时间戳（默认 now）
 * @returns {Array<object>} durable 流分片
 */
export function buildDurableAssistantStream(text, time = Date.now()) {
  const body = typeof text === 'string' ? text : ''
  return [
    { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    ...body === ''
      ? []
      : [{ type: 'chunk', time, chunk: { type: 'text-delta', index: 0, text: body } }],
    { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: body } } },
  ]
}

/**
 * 造 pi 会话/Agent 生命周期宿主。
 *
 * @param {object} [config]
 * @param {(name:string)=>unknown} [config.get] DSH 服务现取（通常是 `ctx.get`）
 * @param {(event:string, detail:object)=>void} [config.onEvent] 证据回调（可选）
 * @returns {{subjectFor:Function, attach:Function, publish:Function, entryOf:Function,
 *            sessionOf:Function, snapshot:Function, dispose:Function}}
 */
export function createPiSessionHost(config = {}) {  const get = typeof config.get === 'function' ? config.get : () => undefined
  const onEvent = typeof config.onEvent === 'function' ? config.onEvent : () => {}

  /** sessionId → 条目。条目是「这个会话在 DSH 里的生命周期」的唯一记录处。 */
  const entries = new Map()
  const counters = { attached: 0, attachSkipped: 0, published: 0, turns: 0 }
  let lastError = null
  let disposed = false

  const record = (event, detail = {}) => {
    try {
      onEvent(event, detail)
    } catch {
      // 证据写入失败绝不影响主流程（证据是旁路）
    }
  }

  /**
   * 造/复用替身身份。引擎在**每次 attempt 开头**都来问一次：
   *   · 已建会话（followup / 二次 attempt）→ 复用同一个 Agent 对象 ——
   *     流式帧按 `agent.session.id` 路由，身份必须一片，否则前端收不到帧；
   *   · 新建会话（kind=createAgent）→ 先造身份，attach 时再绑会话；
   *   · 其余（冷 resume / 无会话 id）→ 返回 null，让引擎自己造一个游离替身。
   * @param {unknown} options create/resume 参数
   * @param {'createAgent'|'resume'} kind 调用种类
   * @returns {object|null} 替身 subject 或 null
   */
  const subjectFor = (options, kind) => {
    const sessionId = sessionIdOfOptions(options)
    if (sessionId !== null) {
      const entry = entries.get(sessionId)
      if (entry !== undefined) return entry.subject
    }
    if (kind !== 'createAgent' || sessionId === null) return null
    return createStandInSubject(sessionId)
  }

  /**
   * 建/复用 pi 会话并把它绑到替身身份上（create 路径）。
   *
   * 顺序照抄上游 AgentLoop 的创建事务：
   *   prepare（含 meta：cwd / agentPreset）→ 持久化句柄 → enter → announce → 绑身份。
   * 已经存过盘的会话（桌面端「复用空白会话」）走冷读 + seed 复原，不丢历史事件。
   *
   * @param {object} engineCtx 引擎调用方上下文（事件分发用）
   * @param {unknown} options create/resume 参数（meta 在这里）
   * @param {object} subject 由 {@link subjectFor} 造出的替身身份
   * @param {'createAgent'|'resume'} [kind] 调用种类（resume 需要先从磁盘把会话读回来）
   * @returns {Promise<object|null>} 绑好的 DSH Session，或 null（服务缺失 / 没有可续的历史）
   */
  const attach = async (engineCtx, options, subject, kind = 'createAgent') => {
    const sessionId = sessionIdOfOptions(options)
    if (sessionId === null || subject === null || typeof subject !== 'object') return null
    const existing = entries.get(sessionId)
    if (existing !== undefined) {
      subject.session = existing.session
      subject.id = existing.session.id
      return existing.session
    }

    const sessions = get('sessions')
    if (sessions === undefined || sessions === null) {
      counters.attachSkipped += 1
      record('pi-session/skip', { reason: 'no-sessions-service', sessionId })
      return null
    }
    const persistence = get('sessionPersistence')
    const meta = pickSessionMeta(options?.meta)
    // 复用已经被别人（或是我们自己上一次）enter 过的会话，不重复 prepare（会抛 already exists）
    const liveAlready = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (liveAlready !== undefined
      && (kind === 'resume' || liveAlready.header?.cwd !== undefined)) {
      subject.session = liveAlready
      subject.id = liveAlready.id
      entries.set(sessionId, {
        sessionId,
        engineCtx,
        options,
        session: liveAlready,
        handle: null,
        subject,
        sessionDetach: null,
        agentDetach: null,
        scope: null,
        published: false,
        status: 'idle',
        inflight: Promise.resolve(),
        cancelled: false,
        turns: 0,
        lastTurn: null,
        lastError: null,
      })
      counters.attached += 1
      record('pi-session/attached', { sessionId, durable: false, reused: true })
      return liveAlready
    }

    /** @type {object} */
    let session
    /** @type {object|undefined} */
    let handle
    /** 冷读回来的事件条数（= 持久化句柄当时已物化的游标）。 */
    let materializedCount = 0
    try {
      // ① 已存盘？冷读复原（复用空白会话 / 桌面端重启后重新打开既有会话）
      if (persistence !== undefined && persistence !== null && typeof persistence.open === 'function') {
        try {
          handle = await persistence.open(sessionId, 'write')
          const cold = await handle.read(0)
          materializedCount = Array.isArray(cold?.events) ? cold.events.length : 0
          session = sessions.prepare(sessionId, {
            seed: cold?.events ?? [],
            meta: { ...structuredClone(cold?.header ?? handle.header ?? {}), ...meta },
            inheritedEventCount: handle.inheritedEventCount,
            ...cold?.eventState === undefined ? {} : { eventState: cold.eventState },
          })
          // 上游 AgentLoop 的 `appendUnstoredSuffix`：`Session.fromRestore` 在带 seed
          // 复原时会**补一个** `session/end-seed`（seed 边界标记），它只进了内存日志；
          // 不同步写回磁盘的话，持久化游标就落后一个事件 —— 下一轮 append 会直接
          // 抛 `append seq mismatch … expected N at index 0, got N+1`（真机踩过）。
          const seeded = session.snapshotEvents()
          if (seeded.length > materializedCount) {
            await handle.append(seeded.slice(materializedCount))
          }
        } catch (error) {
          if (!isSessionNotFoundError(error)) throw error
          handle = undefined
          materializedCount = 0
        }
      }
      // ② resume 却没有任何可续的历史：不伪造会话，如实跳过（交回调用方决定）
      if (session === undefined && kind === 'resume') {
        counters.attachSkipped += 1
        record('pi-session/skip', { reason: 'resume-without-stored-session', sessionId })
        return null
      }
      // ③ 新会话：prepare（header 记 cwd / agentPreset）
      if (session === undefined) {
        session = sessions.prepare(sessionId, { meta })
        // 落盘：拿到写句柄后，会话事件由持久化后端 live 路由进磁盘
        if (persistence !== undefined && persistence !== null && typeof persistence.create === 'function') {
          try {
            handle = await persistence.create(session.header, {
              inheritedEventCount: session.inheritedEventCount,
            })
          } catch (error) {
            if (!isSessionAlreadyExistsError(error)) throw error
            handle = undefined
          }
        }
      }
    } catch (error) {
      lastError = String(error?.message ?? error)
      record('pi-session/error', { phase: 'prepare', sessionId, error: lastError })
      throw error
    }

    const entry = {
      sessionId,
      engineCtx,
      options,
      session,
      handle: handle ?? null,
      subject,
      sessionDetach: null,
      agentDetach: null,
      scope: null,
      published: false,
      status: 'idle',
      inflight: Promise.resolve(),
      cancelled: false,
      turns: 0,
      lastTurn: null,
      lastError: null,
    }
    try {
      entry.sessionDetach = sessions.enter(session)
      sessions.announce(session)
    } catch (error) {
      lastError = String(error?.message ?? error)
      record('pi-session/error', { phase: 'enter', sessionId, error: lastError })
      await closeHandle(handle)
      throw error
    }

    // 身份绑定：真实会话对象 + 真实会话 id（AgentRegistry.enter 的硬校验）
    subject.session = session
    subject.id = session.id
    entries.set(sessionId, entry)
    counters.attached += 1
    record('pi-session/attached', {
      sessionId,
      durable: entry.handle !== null,
      cwd: session.header?.cwd ?? null,
      agentPreset: session.header?.agentPreset ?? null,
    })
    return session
  }

  /**
   * 把替身注册进 `ctx.agents` 并装上 Agent 的表面契约。
   *
   * 注册是**必须**的：`session/prompt` 的准入检查是
   * `ctx.agents.get(agent.id) !== agent → session/not-found`；
   * `session/control` / `readState` 也优先走 live agent。
   *
   * @param {object} subject 已经 attach 过会话的替身
   * @param {(message:object)=>Promise<{text?:string, error?:unknown}>} turnRunner
   *        跑一次 pi attempt 的回调（由 index.js 提供；本模块只管生命周期与落盘）
   * @returns {Promise<object|null>} 注册好的 Agent（就是 subject 本身），或 null（跳过）
   */
  const publish = async (subject, turnRunner) => {
    if (subject === null || typeof subject !== 'object') return null
    const entry = entries.get(sessionIdOfOptions(subject) ?? subject.id)
    if (entry === undefined) return null
    if (entry.published) {
      installAgentSurface(entry, turnRunner)
      return subject
    }
    const agents = get('agents')
    if (agents === undefined || agents === null) {
      counters.attachSkipped += 1
      record('pi-session/skip', { reason: 'no-agents-service', sessionId: entry.sessionId })
      return null
    }
    installAgentSurface(entry, turnRunner)
    // 给替身一个**真的 agent 作用域上下文**：DSH 的 agent/created 监听器链
    // （例：dsh-file-reference-local 的 installPrompt 用 `agent.ctx.inject([...])`）
    // 会直接读 `agent.ctx`，缺了它整个 announce 会抛 "Cannot read properties of undefined (reading 'inject')"
    // —— Agent 就永远注不进注册表，桌面端 session/prompt 直接 fail。
    // 用上游同一个原语 createScope（ReactLoopAgent 也是这么造的：scope.ctx）。
    if (entry.scope === null) {
      try {
        entry.scope = createScope(entry.engineCtx, subject)
        subject.ctx = entry.scope.ctx
      } catch (error) {
        entry.lastError = String(error?.message ?? error)
        record('pi-session/error', { phase: 'scope', sessionId: entry.sessionId, error: entry.lastError })
        entry.scope = null
      }
    }
    let detach
    try {
      // 上游硬校验：agent.id 必须等于 agent.session.id（attach 已把两者都对到真实会话 id）
      detach = agents.enter(subject, undefined)
      await agents.announce(subject, 'startup')
    } catch (error) {
      lastError = String(error?.message ?? error)
      record('pi-session/error', {
        phase: 'publish',
        sessionId: entry.sessionId,
        error: lastError,
        stack: typeof error?.stack === 'string' ? error.stack : null,
      })
      // 半注册（enter 成功、announce 失败）必须回退，不能留一个「在注册表里但没 announce」的残骸
      try {
        detach?.()
      } catch {
        // 忽略：回退失败不改变判定（published 仍为 false）
      }
      return null
    }
    entry.agentDetach = detach
    entry.published = true
    counters.published += 1
    record('pi-session/published', { sessionId: entry.sessionId })
    return subject
  }

  /**
   * 给替身装上 Agent 表面契约（幂等：重复 publish 只换 turnRunner）。
   * 只实现桌面端会话 RPC 真正会碰的那几个面：status / inbox / model /
   * followup / steer / cancel / whenIdle。
   * @param {object} entry 宿主条目
   * @param {Function} turnRunner pi attempt 回调
   */
  function installAgentSurface(entry, turnRunner) {
    const subject = entry.subject
    const options = entry.options
    let selection = {
      provider: options?.agentOptions?.provider,
      model: options?.agentOptions?.model,
      reasoningEffort: options?.agentOptions?.reasoningEffort,
    }
    const hasSelection = (value) =>
      typeof value?.provider === 'string' && typeof value?.model === 'string'

    subject.kind = PI_AGENT_KIND
    subject.engine = 'pi'
    subject.standIn = true

    /**
     * 队列面：pi 引擎不排队（followup 立即跑一次 attempt），如实给空队列。
     * `hasPromptRequest` 读 `nextTurn/nextStep`；`session/updateQueue` 想改队列会得到
     * 「找不到该条目」的诚实失败，而不是假装改成功了。
     */
    subject.inbox = subject.inbox ?? {
      nextTurn: [],
      nextStep: [],
      replace: () => false,
      remove: () => false,
    }

    /** 模型面：AgentModel 的最小诚实实现（current/select）。 */
    subject.model = {
      current: () => (hasSelection(selection) ? { ...selection } : undefined),
      select: (next) => {
        if (!hasSelection(next)) return
        const changed =
          selection.provider !== next.provider ||
          selection.model !== next.model ||
          (next.reasoningEffort ?? undefined) !== (selection.reasoningEffort ?? undefined)
        selection = {
          provider: next.provider,
          model: next.model,
          ...next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort },
        }
        if (changed) entry.session.append('model/selection', { ...selection })
      },
    }

    Object.defineProperty(subject, 'status', {
      get: () => entry.status,
      enumerable: true,
      configurable: true,
    })

    /**
     * 跑一次 turn：会话事件按真实 DSH 词汇顺序写入，成败都收尾（不留开着 トラック的 turn）。
     * @param {object} message createUserMessage 产物
     * @returns {Promise<void>} turn 结束（含失败）后 resolve
     */
    subject.followup = (message) => {
      const run = (async () => {
        entry.cancelled = false
        const turn = nextTurnOf(entry)
        entry.lastTurn = turn
        beginTurn(entry, turn)
        if (message !== undefined && message !== null) {
          entry.session.append('user/message', message, { surfaceOp: 'append' })
        }
        entry.session.append('step/start', { turn, step: 1 })
        let outcome = null
        try {
          outcome = await turnRunner(message, textOfUserMessage(message))
        } catch (error) {
          entry.lastError = String(error?.message ?? error)
          record('pi-session/error', { phase: 'turn', sessionId: entry.sessionId, error: entry.lastError })
          entry.session.append('turn/end', {
            turn,
            reason: { kind: 'error', error: { code: 'pi-engine-error', message: entry.lastError } },
          })
          emitStatus(entry, 'idle')
          await flushSession(entry)
          throw error
        }
        if (entry.cancelled) {
          entry.session.append('turn/end', { turn, reason: { kind: 'canceled' } })
          emitStatus(entry, 'idle')
          await flushSession(entry)
          return
        }
        const text = typeof outcome?.text === 'string' ? outcome.text : ''
        const provider =
          typeof outcome?.provider === 'string' && outcome.provider !== '' ? outcome.provider : 'pi'
        const model =
          typeof outcome?.model === 'string' && outcome.model !== '' ? outcome.model : 'pi'
        // source.kind='model' 由 createAssistantMessage 补上；provider/model 如实写 pi 的钉死值
        const assistantMessage = createAssistantMessage({
          content: [{ type: 'text', text }],
          source: { provider, model },
        })
        entry.session.append(
          'assistant/message',
          {
            turn,
            step: 1,
            message: assistantMessage,
            // settlement 字段（缺了就会让会话在冷读时被判 corrupt）
            stream: buildDurableAssistantStream(text),
          },
          { surfaceOp: 'append' },
        )
        entry.session.append('step/end', { turn, step: 1 })
        entry.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        emitStatus(entry, 'idle')
        await flushSession(entry)
        entry.turns += 1
        counters.turns += 1
        record('pi-session/turn', { sessionId: entry.sessionId, turn, textLength: text.length })
      })()
      entry.inflight = run
      return run
    }

    // steer 在 pi 引擎里没有「打断当前 step 再插话」的能力：如实当成新一轮 turn。
    subject.steer = (message) => subject.followup(message)
    subject.cancel = () => {
      entry.cancelled = true
      emitStatus(entry, 'idle')
      return true
    }
    subject.whenIdle = () => entry.inflight
  }

  /** 一轮 turn 开始：状态 running（前端「运行中」指示与 session/wait 都读它）。 */
  function beginTurn(entry, turn) {
    entry.session.append('turn/start', { turn })
    emitStatus(entry, 'running')
  }

  /** 状态广播走真实 agent/* 事件设施（agentEvents 会注入 payload.agent）。 */
  function emitStatus(entry, status) {
    entry.status = status
    try {
      agentEvents(entry.engineCtx, entry.subject).emit('agent/status', { status })
    } catch (error) {
      entry.lastError = String(error?.message ?? error)
    }
  }

  /** 落盘检查点：交给持久化后端（它是 `session/flush` 的监听方）。 */
  async function flushSession(entry) {
    const sessions = get('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.flush !== 'function') return false
    try {
      return await sessions.flush(entry.session)
    } catch (error) {
      entry.lastError = String(error?.message ?? error)
      record('pi-session/error', { phase: 'flush', sessionId: entry.sessionId, error: entry.lastError })
      return false
    }
  }

  /** 下一个 turn 号：优先问真实 turn 边界投影，拿不到就扫描会话事件（不依赖可选服务）。 */
  function nextTurnOf(entry) {
    const agents = get('agents')
    if (agents !== undefined && agents !== null && typeof agents.turnBoundaryOf === 'function') {
      try {
        const boundary = agents.turnBoundaryOf(entry.session)
        if (boundary !== undefined && Number.isFinite(boundary?.lastTurn)) return boundary.lastTurn + 1
      } catch {
        // 投影不可用（替身/极简组装）→ 退化为扫描事件
      }
    }
    let last = 0
    for (const event of entry.session.snapshotEvents()) {
      if (event?.type === 'turn/start' && Number.isFinite(event.data?.turn)) {
        last = Math.max(last, event.data.turn)
      }
    }
    return last + 1
  }

  /** 关掉持久化句柄（失败不抛：卸载路径不该因为清理失败而炸）。 */
  async function closeHandle(handle) {
    if (handle === null || handle === undefined || typeof handle.close !== 'function') return
    try {
      await handle.close()
    } catch {
      // 忽略：句柄关闭失败不影响宿主（进程退出会兜底）
    }
  }

  return {
    subjectFor,
    attach,
    publish,
    /** @param {string} sessionId @returns {object|undefined} 宿主条目（测试/证据用） */
    entryOf: (sessionId) => entries.get(sessionId),
    /** @param {string} sessionId @returns {object|undefined} 已绑定的 DSH Session */
    sessionOf: (sessionId) => entries.get(sessionId)?.session,
    /** @returns {boolean} 本进程里有没有 sessions 服务（决定「连不上会话」算不算硬错误） */
    hasSessionsService: () => {
      const sessions = get('sessions')
      return sessions !== undefined && sessions !== null
    },
    /** @returns {object} 可落进证据 JSON 的快照 */
    snapshot: () => ({
      version: 1,
      counters: { ...counters },
      lastError,
      sessions: [...entries.values()].map((entry) => ({
        sessionId: entry.sessionId,
        published: entry.published,
        durable: entry.handle !== null,
        status: entry.status,
        turns: entry.turns,
        lastTurn: entry.lastTurn,
        lastError: entry.lastError,
        cwd: entry.session.header?.cwd ?? null,
        agentPreset: entry.session.header?.agentPreset ?? null,
      })),
    }),
    /**
     * 卸载：把注册过的 Agent / 会话从各自 store 里摘掉（顺序按注册逆序），
     * 再关持久化句柄。宿主退出不等于**删数据**：磁盘上的会话日志保持不动。
     */
    async dispose() {
      if (disposed) return
      disposed = true
      const list = [...entries.values()].reverse()
      for (const entry of list) {
        // 顺序照抄上游 AgentLoop 的 teardown：先拆 agent 作用域，再关持久化句柄，
        // 最后才把 Agent / 会话从各自 store 里摘掉（拆卸期间它们仍然可被查到）。
        try {
          await entry.scope?.dispose?.()
        } catch {
          // 忽略：卸载清理失败不阻塞其他条目
        }
        await closeHandle(entry.handle)
        try {
          entry.agentDetach?.()
        } catch {
          // 同上
        }
        try {
          entry.sessionDetach?.()
        } catch {
          // 同上
        }
      }
      entries.clear()
    },
  }
}

export default { createPiSessionHost, createStandInSubject, pickSessionMeta, textOfUserMessage }
