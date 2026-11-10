/**
 * oar-engine.mjs — @local/dsh-engine-switch 的 OAR 适配器：用 OAR 驱动 pi runtime
 *
 * 本轮范围：
 *   把手工 pi 子进程管线（pi-engine.mjs 的 RpcClient → spawn）换成 OAR 调用：
 *   defaultRuntimes.require('pi') → installation() → piSession → promptAndWait。
 *
 * 照已跑通的参考脚本（oar-drive-pi.mjs）写，逐字照抄调用形状：
 *   - `defaultRuntimes.require('pi')` 拿 runtime
 *   - `installation()` 检查可用性
 *   - `piSession(installation, {cwd})` 创建 session
 *   - `session.model()` 读回实际 model id
 *   - `promptAndWait(session, text)` 发提示拿文本
 *   - `session.dispose()` 清理
 *
 * 显式钉死 provider/model（L8 起改为「会话现读选区优先」）：
 *   - 会话当前选区（`agentOptions` / UI `selectModel` 写进的 `agent.model`）
 *     → 交给 `config.resolveAttemptModel` 解析成 pi 全限定选择子（也回一份 `effort`）；
 *   - 解析不到/没有选区 → 回落 config 的 `provider` / `model`（默认 magpie / auto/deepseek-v4.1-flash）
 *   - 回落的**原因**如实写进记录（`modelSource` / `modelFallbackReason`），不假装用了选区。
 *
 * 读回实际 model（`session.model()`）并与请求值一并落记录：OAR 自己也做这道校验
 * （`oar/dist/runtimes/pi/open.js`：读回不等于请求就抛），本模块再留一份证据。
 *
 * 事实依据：
 *   - OAR 已装：@botiverse/oar@0.95.0
 *   - 参考脚本：oar-drive-pi.mjs（已跑通 7/7）
 *   - pi 配置目录：必须用工作区内 dsh-engine-switch/.pi-agent/（PI_CODING_AGENT_DIR）
 *
 * 保留 DSH 侧契约：
 *   - 返回结构照抄 pi-engine.mjs：`{engine, handledBy, text, piText, subject, attemptId, frames, ...}`
 *   - 事件映射与 pi-engine.mjs 同款（start → chunk* → end）
 *   - subject 是替身对象（kind:'pi-subject'/standIn:true）
 *   - end 帧 outcome 如实为 `abandoned`（没有 durable DSH attempt）
 */

import { defaultRuntimes, piSession, promptAndWait } from '@botiverse/oar'
import { agentEvents, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import {
  piModelIdOfSelection,
  pickModelSelection,
  splitPiModelId,
  PI_DEFAULT_MODEL,
  PI_DEFAULT_PROVIDER,
} from './pi-models.mjs'
import {
  createPiNativeSessionStore,
  formatPiBootstrapPrompt,
} from './pi-context.mjs'

/** 引擎标识（与 pi-engine.mjs 保持一致）。 */
export const PI_ENGINE_ID = 'pi'
export const OAR_ENGINE_ID = PI_ENGINE_ID

/** 默认提示（供 index.js 导入用于正向断言）。 */
export const PI_PROMPT = 'Reply with exactly: PI_OK'
export const PI_OK_MARKER = 'PI_OK'

/** DSH 流式帧事件名（真实词汇，来自 dsh-agent 的 agent/* 契约）。 */
export const OAR_STREAM_EVENT = 'agent/assistant-stream'

/** pi 替身 subject 的默认 id（非真实 DSH Agent，仅作 scope carrier 的 key）。 */
export const OAR_SUBJECT_ID = 'engine-switch:oar-pi'

/**
 * 默认 provider / model（回落用的钉死值，防止 OAR 自行挑模型）。
 *
 * 值的唯一定义处在 `pi-models.mjs`（模型面同时要用它做「选区不可用时的回落」）——
 * 这里只做改名再导出，避免同一个默认值在仓库里出现两份会漂的副本。
 * L8 之前这两个常量在本文件里各自字面量定义，值与现在逐字相同。
 */
export const OAR_DEFAULT_PROVIDER = PI_DEFAULT_PROVIDER
export const OAR_DEFAULT_MODEL = PI_DEFAULT_MODEL

/** 替身身份的 id 前缀：**只**在没有真实会话 id 时的回退（游离替身，不是会话身份）。 */
export const OAR_STANDIN_PREFIX = OAR_SUBJECT_ID

/** start 帧的 turn 占位值：pi 这轮没有 durable DSH turn，如实用 0。 */
export const OAR_PLACEHOLDER_TURN = 0

/** start 帧的 step 占位值：同理如实用 0。 */
export const OAR_PLACEHOLDER_STEP = 0

/**
 * 判定一次 create/resume 调用是否携带 pi marker（复用 pi-engine.mjs 的约定）。
 * @param {unknown} options create/resume 的调用参数
 * @returns {boolean} true 表示应交给 pi 引擎
 */
export function isPiMarked(options) {
  if (options === null || typeof options !== 'object') return false
  const meta = options.meta
  const fromMeta =
    meta !== null && typeof meta === 'object' ? meta.engine : undefined
  return fromMeta === OAR_ENGINE_ID || options.engine === OAR_ENGINE_ID
}

/** 从一次 attempt 的 options/subject 里取真实 DSH 会话 id。 */
function attemptSessionId(options, subject) {
  const raw = options?.sessionId ?? options?.resumeSessionId ?? subject?.id
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * 造一个 pi subject 替身（与 pi-engine.mjs 同款）。
 *
 * **L7 修正：有真实会话 id 时，id 就是那个 id，不再加 `engine-switch:oar-pi:` 前缀。**
 * 理由有三条，全部来自上游契约（不是口味问题）：
 *   1. `sessionController.create()` 逐字取 `agent.id` 当会话身份 ⇒ 前缀会变成不存在的 sessionId；
 *   2. `AgentRegistry.enter()` 硬校验 `agent.id === agent.session.id`；
 *   3. 流式帧按 `agent.session.id` 路由到前端订阅 ⇒ 身份必须与真实会话一致。
 * 无会话 id（游离 attempt）时才回退到不带 id 的常量身份。
 *
 * @param {object|null|undefined} options 调用参数（用于派生可辨识 id）
 */
export function createPiSubject(options) {
  const raw =
    options !== null && typeof options === 'object'
      ? options.sessionId ?? options.id ?? options.seed
      : undefined
  const hasSessionId = typeof raw === 'string' && raw.length > 0
  const id = hasSessionId ? raw : OAR_STANDIN_PREFIX
  return {
    id,
    session: { id },
    kind: 'pi-subject',
    engine: OAR_ENGINE_ID,
    standIn: true,
  }
}

/** 构造 start 帧（词汇对齐 dsh-agent-loop 的 AssistantStreamAttempt.start）。 */
function startFrame(attemptId, revision, turn, step) {
  return { type: 'start', attemptId, revision, turn, step }
}

/** 构造瞬态 chunk 帧（分片用 text-delta，chunk.index 恒为 0 = 单个文本块）。 */
function chunkFrame(attemptId, revision, index, time, text) {
  return {
    type: 'chunk',
    attemptId,
    revision,
    index,
    time,
    chunk: { type: 'text-delta', index: 0, text },
  }
}

/** 构造 end 帧：index = 下一个分片位置；outcome 如实 abandoned（pi 侧没有提交 DSH durable attempt）。 */
function endFrame(attemptId, revision, index, extra = {}) {
  return {
    type: 'end',
    attemptId,
    revision,
    index,
    outcome: { kind: 'abandoned', ...extra },
  }
}

/**
 * 帧映射状态机：把 OAR 返回的文本映射为 DSH 三类帧并发布。
 *
 * 发布设施与 pi-engine.mjs 同款：首个帧走 `emitAgentEvent`（一次性冷路径），
 * 其余帧复用 `agentEvents(ctx, subject)` 的 retained dispatcher（热路径，与真实 AgentLoop 同形）。
 *
 * @param {object} ctx 真实 cordis Context（AgentRegistry 传入的 owner ctx）
 * @param {object} subject pi 替身 subject
 * @param {string} text OAR 返回的完整文本
 * @param {{attemptSeq?:number, now?:number}} [opts]
 */
export function createOarFrameMapper(ctx, subject, text, opts = {}) {
  const attemptSeq = Number.isFinite(opts.attemptSeq) ? opts.attemptSeq : 1
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const attemptId = `${subject?.id ?? OAR_SUBJECT_ID}#attempt-${attemptSeq}`
  const frames = []
  let revision = 0

  /** 发布一帧：首帧用 emitAgentEvent，其余用 retained dispatcher。 */
  function publish(frame) {
    frames.push(frame)
    if (frames.length === 1) {
      emitAgentEvent(ctx, subject, OAR_STREAM_EVENT, { frame })
    } else {
      if (!dispatcher) dispatcher = agentEvents(ctx, subject)
      dispatcher.emit(OAR_STREAM_EVENT, { frame })
    }
  }

  let dispatcher = null

  // 发布 start 帧
  publish(
    startFrame(
      attemptId,
      (revision += 1),
      OAR_PLACEHOLDER_TURN,
      OAR_PLACEHOLDER_STEP,
    ),
  )

  // 把文本切成 3 段模拟流式分片（与 pi-engine.mjs 的实时流不同，OAR 返回的是完整文本）
  const chunkSize = Math.max(1, Math.ceil(text.length / 3))
  let index = 0
  for (let i = 0; i < text.length; i += chunkSize) {
    const fragment = text.slice(i, i + chunkSize)
    publish(
      chunkFrame(
        attemptId,
        (revision += 1),
        index,
        now + index,
        fragment,
      ),
    )
    index += 1
  }

  // 发布 end 帧
  publish(
    endFrame(
      attemptId,
      (revision += 1),
      index,
    ),
  )

  return {
    attemptId,
    frames,
    text,
    textDeltas: index,
  }
}

/**
 * 构造 OAR 引擎：每次调用用 OAR 起一个 pi session、发一次提示、拿回文本。
 *
 * @param {object} [config]
 * @param {string} [config.agentDir] PI_CODING_AGENT_DIR（必须指向可写目录）
 * @param {string} [config.prompt] 默认提示（可由调用方覆盖）
 * @param {number} [config.timeoutMs] 超时上限
 * @param {string} [config.provider] 显式指定 provider（默认 magpie）
 * @param {string} [config.model] 显式指定 model（默认 auto/deepseek-v4.1-flash）
 * @param {string} [config.cwd] 工作目录
 * @param {object} [config.nativeSessionStore] DSH session → Pi native session 的持久绑定
 * @param {string} [config.nativeSessionDir] 未传 store 时的绑定文件目录
 * @param {object} [config.sessionHost] 会话/Agent 生命周期宿主（pi-session.mjs）：
 *   ① 每次 attempt 开头问它要身份（`subjectFor`）——有会话时必须是**同一个** Agent 对象，
 *      否则流式帧与注册表里的身份会一分为二；
 *   ② create 路径在跑 pi **之前**把会话建好并绑到身份上（`attach`），
 *      这样帧的 `agent.session.id` 从一开始就是真实会话 id（前端按会话 id 订阅）。
 */
export function createOarEngine(config = {}) {
  const nativeSessions =
    config.nativeSessionStore ??
    createPiNativeSessionStore({
      dir: config.nativeSessionDir,
    })
  const stats = {
    createAgent: 0,
    resume: 0,
    attempts: 0,
    framesEmitted: 0,
    textDeltas: 0,
    oarErrors: 0,
    runtimeId: null,
    effectiveProvider: null,
    effectiveModel: null,
    nativeSessionsBound: 0,
    nativeSessionsResumed: 0,
    nativeSessionFallbacks: 0,
  }

  /** 每次 attempt 的结构化留档（供 smoke 断言/证据引用）。 */
  const attempts = []

  function baseOptions(options) {
    return {
      prompt: options?.prompt ?? config.prompt ?? PI_PROMPT,
      timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 45000,
      agentDir: config.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
      provider: config.provider ?? OAR_DEFAULT_PROVIDER,
      model: config.model ?? OAR_DEFAULT_MODEL,
      cwd: options?.meta?.cwd ?? options?.cwd ?? config.cwd ?? process.cwd(),
    }
  }

  /** config 里的钉死值（回落用；缺省与 L8 之前逐字同值）。 */
  const configuredModel = {
    provider: config.provider ?? OAR_DEFAULT_PROVIDER,
    model: config.model ?? OAR_DEFAULT_MODEL,
  }

  /**
   * 解析本次 attempt 的模型与思考等级。
   *
   * 两种来源，形状一致（都回 `{model, effort, source, reason, requested}`）：
   *   · `config.resolveAttemptModel`（由 index.js 接线到 pi-models.mjs 的目录解析）：
   *     实现「UI 选什么跑什么」；
   *   · 没有接线（单测 / 独立使用 oar-engine）→ 用 config 的钉死值（既有行为）。
   *
   * 解析本身抛错「不该」发生（失败已在目录源里被吞成 `{model: 钉死值}`），但真抛了也不藏：
   * 回落到钉死值并把原因写进记录。
   *
   * @param {unknown} options create/resume 参数
   * @param {object|null} subject 已绑定的替身身份
   * @param {object} o baseOptions 结果
   * @returns {Promise<object>} 解析结果
   */
  async function resolveAttemptModel(options, subject, o) {
    const sessionHost = config.sessionHost ?? null
    // 选区来源：会话宿主现读（L8 的唯一权威）＞ 本次请求的 agentOptions。
    const selection =
      (typeof sessionHost?.selectionFor === 'function'
        ? sessionHost.selectionFor(options, subject)
        : null) ?? pickModelSelection(options?.agentOptions)
    const fallback = {
      model: `${configuredModel.provider}/${configuredModel.model}`,
      effort: null,
      source: 'config',
      reason: 'no-model-plane',
      requested: null,
      selection,
    }
    // `requested` 一律是「选区在 pi 拼法下的样子」（与解析成功时的形状一致），
    // `selection` 才是 DSH 原文 —— 两者分开，证据里才好区分「要什么」与「怎么拼」。
    const requested = piModelIdOfSelection(selection)
    if (typeof config.resolveAttemptModel !== 'function') return { ...fallback, requested }
    try {
      const resolved = await config.resolveAttemptModel(selection, { cwd: o.cwd, options, subject })
      if (resolved === null || typeof resolved !== 'object' || typeof resolved.model !== 'string') {
        return { ...fallback, requested }
      }
      return resolved
    } catch (error) {
      return { ...fallback, requested, reason: `resolve-failed: ${String(error?.message ?? error)}` }
    }
  }

  /**
   * 跑一次 OAR attempt。
   * @param {object} engineCtx 真实调用方上下文
   * @param {object|null} options create/resume 参数
   * @param {'createAgent'|'resume'} kind
   */
  async function runAttempt(engineCtx, options, kind) {
    stats[kind] += 1
    stats.attempts += 1

    const o = baseOptions(options)
    const sessionHost = config.sessionHost ?? null
    // 身份来源：宿主优先（已建会话必须复用同一个 Agent 对象），否则引擎自造替身。
    const subject =
      (typeof sessionHost?.subjectFor === 'function'
        ? sessionHost.subjectFor(options, kind)
        : null) ?? createPiSubject(options)

    const record = {
      kind,
      engine: OAR_ENGINE_ID,
      subject,
      attemptId: `${subject.id}#attempt-${stats.attempts}`,
      prompt: o.prompt,
      agentDir: o.agentDir,
      provider: o.provider,
      model: o.model,
      cwd: o.cwd,
      runtimeId: null,
      effectiveModel: null,
      // L8 模型面：选区 → pi 选择子的解析结果（回落也照实记）。
      selection: null,
      piModel: null,
      modelSource: null,
      modelFallbackReason: null,
      modelEffort: null,
      modelEffortOmitted: null,
      modelRequested: null,
      // L10 上下文续接：Pi 原生 id、resume 结果与旧会话 Bootstrap。
      nativePiSessionId: null,
      nativeSessionRequested: null,
      nativeSessionResumed: false,
      nativeSessionFallback: null,
      nativeSessionFallbackError: null,
      nativeSessionStorePath: null,
      nativeSessionPersisted: false,
      nativeSessionStoreError: null,
      historyMessages: 0,
      bootstrapInjected: false,
      bootstrapMessageCount: 0,
      bootstrapChars: 0,
      piPrompt: o.prompt,
      text: '',
      textDeltas: 0,
      frames: [],
      framesEmitted: 0,
      error: null,
      attachError: null,
      durationMs: 0,
    }
    attempts.push(record)

    // create / resume 路径：先把 DSH 会话建好（或从持久化读回来）再跑 pi。
    // 放在这里而不是 onPiResult：帧在 runAttempt 里就发出去了，绑定必须更早；
    // resume 时也只有先把历史读回来，后面的 turn 才会接在正确的 seq 上。
    if (typeof sessionHost?.attach === 'function') {
      try {
        await sessionHost.attach(engineCtx, options, subject, kind)
        const boundCwd =
          typeof sessionHost.cwdFor === 'function'
            ? sessionHost.cwdFor(options, subject)
            : null
        if (typeof boundCwd === 'string' && boundCwd !== '') o.cwd = boundCwd
        record.cwd = o.cwd
      } catch (attachError) {
        record.attachError = String(attachError?.message ?? attachError)
      }
    }

    const started0 = Date.now()

    // 设置 PI_CODING_AGENT_DIR 环境变量（OAR 内部读取）
    if (o.agentDir) {
      process.env.PI_CODING_AGENT_DIR = o.agentDir
    }

    // 模型面（L8）：选区 → pi 全限定选择子 + 思考等级。读的是**会话当前选区**，
    // 不是 install 时的快照（用户中途换模型，下一次输入就得用新模型）。
    const resolvedModel = await resolveAttemptModel(options, subject, o)
    record.selection = resolvedModel.selection ?? null
    record.piModel = resolvedModel.model
    record.modelSource = resolvedModel.source ?? null
    record.modelFallbackReason = resolvedModel.reason ?? null
    record.modelEffort = resolvedModel.effort ?? null
    record.modelEffortOmitted = resolvedModel.effortOmitted ?? null
    // 选区在 pi 拼法下的样子（`(pi, magpie/auto/x)` 与 `(magpie, auto/x)` 都归到 `magpie/auto/x`）：
    // 与 `record.piModel`（最终采用的选择子）分开记，「选区要什么」与「实际用什么」才能分别断言。
    record.modelRequested = resolvedModel.requested ?? null

    const dshSessionId = attemptSessionId(options, subject)
    const suppliedHistory = Array.isArray(options?.piHistory)
      ? options.piHistory
      : null
    const history =
      suppliedHistory ??
      (typeof sessionHost?.historyFor === 'function'
        ? sessionHost.historyFor(options, subject)
        : [])
    record.historyMessages = Array.isArray(history) ? history.length : 0

    // 持久绑定按 DSH session id 读。旧记录里保存了 cwd；cwd 变了就不能拿它去
    // Pi 的另一个 workspace 里找会话，直接清零并走历史 Bootstrap。
    const storedBinding =
      dshSessionId === null
        ? { ok: false, entry: null, file: null, error: 'missing-dsh-session-id' }
        : nativeSessions.read(dshSessionId)
    let nativeSessionId = storedBinding.ok ? storedBinding.entry.piSessionId : null
    if (
      nativeSessionId !== null &&
      typeof storedBinding.entry.cwd === 'string' &&
      storedBinding.entry.cwd !== o.cwd
    ) {
      record.nativeSessionFallback = 'cwd-changed'
      record.nativeSessionFallbackError = `stored cwd ${storedBinding.entry.cwd} != current cwd ${o.cwd}`
      stats.nativeSessionFallbacks += 1
      nativeSessions.clear(dshSessionId)
      nativeSessionId = null
    }
    if (nativeSessionId === null && Array.isArray(history) && history.length > 0) {
      if (storedBinding.error === 'not-found') {
        record.nativeSessionFallback = 'binding-missing'
        stats.nativeSessionFallbacks += 1
      } else if (storedBinding.error === 'invalid-record') {
        record.nativeSessionFallback = 'binding-invalid'
        record.nativeSessionFallbackError = 'stored native binding is invalid'
        stats.nativeSessionFallbacks += 1
      } else if (
        storedBinding.error !== null &&
        storedBinding.error !== 'store-disabled'
      ) {
        record.nativeSessionFallback = 'binding-read-failed'
        record.nativeSessionFallbackError = storedBinding.error
        stats.nativeSessionFallbacks += 1
      }
    }
    record.nativeSessionRequested = nativeSessionId

    let session = null
    try {
      // 第 1 步：require('pi') 拿 runtime
      const piRuntime = defaultRuntimes.require('pi')
      record.runtimeId = piRuntime.id
      stats.runtimeId = piRuntime.id

      // 第 2 步：installation()
      const installation = await piRuntime.installation()
      if (installation.kind !== 'available') {
        record.error = `pi runtime not available: ${installation.kind}`
        stats.oarErrors += 1
        record.durationMs = Date.now() - started0
        return { 
          ...record, 
          engine: OAR_ENGINE_ID, 
          handledBy: 'oar-engine',
          runtimeId: record.runtimeId,
          provider: record.provider,
          effectiveModel: record.effectiveModel,
        }
      }

      // 第 3 步：piSession(installation, {cwd, model, effort?, resume?})
      // model 是**解析出来的** pi 全限定选择子（`provider/modelId`，model id 自己可以带 `/`）；
      // effort 是 pi 的 thinking level，只在该模型真的提供时才透传（见 pi-models.mjs 的说明）。
      const sessionOptions = {
        cwd: o.cwd,
        ...record.piModel === null || record.piModel === undefined ? {} : { model: record.piModel },
        ...record.modelEffort === null || record.modelEffort === undefined ? {} : { effort: record.modelEffort },
      }
      const bootstrap = formatPiBootstrapPrompt(history, o.prompt)

      if (nativeSessionId !== null) {
        try {
          session = await piSession(installation, {
            ...sessionOptions,
            resume: nativeSessionId,
          })
          record.nativeSessionResumed = true
          stats.nativeSessionsResumed += 1
          record.piPrompt = o.prompt
        } catch (resumeError) {
          // Pi 原生会话可能因文件被清、cwd 迁移、工具图不兼容等原因无法续接。
          // 失败不能静默失忆：清掉坏绑定，用 DSH 历史开新会话，并把原因落证据。
          record.nativeSessionFallback = 'resume-failed'
          record.nativeSessionFallbackError = String(resumeError?.message ?? resumeError)
          stats.nativeSessionFallbacks += 1
          nativeSessions.clear(dshSessionId)
          session = await piSession(installation, sessionOptions)
        }
      } else {
        session = await piSession(installation, sessionOptions)
      }

      // 只有在没有成功 resume 时才注入 DSH 历史；成功 resume 的原生会话已经持有上下文，
      // 再注入一次会造成重复和 token 膨胀。
      if (!record.nativeSessionResumed) {
        record.bootstrapInjected = bootstrap.injected
        record.bootstrapMessageCount = bootstrap.messageCount
        record.bootstrapChars = bootstrap.chars
        record.piPrompt = bootstrap.prompt
      }

      // 记录本次真正打开的 Pi 原生 id。绑定按 DSH session id 持久化，重启后仍能 resume。
      record.nativePiSessionId = typeof session.id === 'string' && session.id !== '' ? session.id : null
      if (dshSessionId !== null && record.nativePiSessionId !== null) {
        const saved = nativeSessions.write(dshSessionId, {
          piSessionId: record.nativePiSessionId,
          cwd: o.cwd,
          model: record.piModel,
          effort: record.modelEffort,
        })
        record.nativeSessionStorePath = saved.file
        record.nativeSessionPersisted = saved.ok
        record.nativeSessionStoreError = saved.error
        if (saved.ok) stats.nativeSessionsBound += 1
      }

      // 读回实际使用的 model id：OAR 已做了「不相等就抛」的硬校验，这里再留一份可断言的证据。
      const modelInfo = session.model()
      record.effectiveModel = modelInfo.value
      stats.effectiveModel = modelInfo.value
      if (record.piModel !== null && record.piModel !== undefined && modelInfo.value !== record.piModel) {
        record.modelMismatch = { requested: record.piModel, effective: modelInfo.value }
      }
      // `provider` 的语义是「谁真的服务了这次 attempt」：L8 起有效模型可能来自别的 pi provider
      // （选区换了 provider），所以从有效模型现拆，不再用 config 里那个钉死值冒充。
      const effectiveSplit = splitPiModelId(modelInfo.value)
      if (effectiveSplit !== null) record.provider = effectiveSplit.providerId

      // 第 4 步：promptAndWait(session, effective prompt)
      const result = await promptAndWait(session, record.piPrompt)

      // 检查返回结果
      if (result.outcome.kind !== 'completed') {
        record.error = `OAR outcome not completed: ${result.outcome.kind}`
        stats.oarErrors += 1
      }

      const text = result.text ?? ''
      record.text = text

      // 把文本映射成 DSH 帧
      const mapper = createOarFrameMapper(engineCtx, subject, text, {
        attemptSeq: stats.attempts,
      })

      record.frames = mapper.frames
      record.framesEmitted = mapper.frames.length
      record.textDeltas = mapper.textDeltas
      stats.framesEmitted += mapper.frames.length
      stats.textDeltas += mapper.textDeltas

    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err)
      stats.oarErrors += 1
    } finally {
      // 第 5 步：session.dispose()
      if (session) {
        try {
          await session.dispose()
        } catch (disposeErr) {
          record.disposeError =
            disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
        }
      }
    }

    record.durationMs = Date.now() - started0

    return {
      ...record,
      engine: OAR_ENGINE_ID,
      handledBy: 'oar-engine',
      streamEvent: OAR_STREAM_EVENT,
      subject,
      frames: record.frames,
      piText: record.text,
      runtimeId: record.runtimeId,
      provider: record.provider,
      effectiveModel: record.effectiveModel,
    }
  }

  return {
    stats,
    attempts,
    runAttempt,
    createAgent: (engineCtx, options) =>
      runAttempt(engineCtx, options, 'createAgent'),
    resume: (engineCtx, options) => runAttempt(engineCtx, options, 'resume'),
  }
}

export default { createOarEngine, isPiMarked, createPiSubject, createOarFrameMapper }
