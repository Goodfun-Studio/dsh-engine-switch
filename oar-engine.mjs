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
 * 显式钉死 provider/model：
 *   - 从 config 传入（`config.provider` / `config.model`）
 *   - 默认 magpie / auto/deepseek-v4.1-flash
 *   - 通过 OAR session options 的 `model` 字段传入（需验证 OAR 的 session API）
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

/** 默认 provider / model（显式钉死，防止 OAR 自行挑模型）。 */
export const OAR_DEFAULT_PROVIDER = 'magpie'
export const OAR_DEFAULT_MODEL = 'auto/deepseek-v4.1-flash'

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
 * @param {object} [config.sessionHost] 会话/Agent 生命周期宿主（pi-session.mjs）：
 *   ① 每次 attempt 开头问它要身份（`subjectFor`）——有会话时必须是**同一个** Agent 对象，
 *      否则流式帧与注册表里的身份会一分为二；
 *   ② create 路径在跑 pi **之前**把会话建好并绑到身份上（`attach`），
 *      这样帧的 `agent.session.id` 从一开始就是真实会话 id（前端按会话 id 订阅）。
 */
export function createOarEngine(config = {}) {
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
      } catch (attachError) {
        record.attachError = String(attachError?.message ?? attachError)
      }
    }

    const started0 = Date.now()

    // 设置 PI_CODING_AGENT_DIR 环境变量（OAR 内部读取）
    if (o.agentDir) {
      process.env.PI_CODING_AGENT_DIR = o.agentDir
    }

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

      // 第 3 步：piSession(installation, {cwd, model})
      // 显式钉死 model：构造完整 model id（provider/model 形式）
      const fullModelId = `${o.provider}/${o.model}`
      session = await piSession(installation, {
        cwd: o.cwd,
        model: fullModelId,
      })

      // 读回实际使用的 model id（验证钉死是否生效）
      const modelInfo = session.model()
      record.effectiveModel = modelInfo.value
      stats.effectiveModel = modelInfo.value

      // 第 4 步：promptAndWait(session, text)
      const result = await promptAndWait(session, o.prompt)

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
