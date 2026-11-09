/**
 * pi-engine.mjs — @local/dsh-engine-switch 的「真引擎」适配器：官方 RpcClient → `pi --mode rpc` 子进程
 *
 * 本轮范围（最小可用链路）：
 *   起 pi RPC 子进程 → 发一个极短提示 → 把 pi 的流式文本事件映射成 DSH 的
 *   `agent/assistant-stream` 三类帧（start / ≥1 分片 / end）。
 *
 * 事实依据（均可复核，未重新探索）：
 *   - pi 包：~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent（v1.4.0）
 *     main = ./dist/index.js，导出面含 RpcClient（官方 subprocess 客户端）；
 *     ./dist/cli.js 是 RpcClient 示例里指向的 CLI 入口（examples/rpc-client.ts）。
 *   - docs/rpc.md：严格 JSONL 框架、prompt 响应的 disposition、`agent_settled` 才是运行边界、
 *     关闭方式为关 stdin / SIGTERM、子进程启动失败要自行处理。
 *   - docs/json.md：`message_update.assistantMessageEvent` 的 `text_delta` 是增量文本；
 *     `agent_start` / `agent_end` / `agent_settled` 是运行边界。
 *   - docs/environment-variables.md：`PI_CODING_AGENT_DIR` 覆盖配置目录（默认 ~/.pi/agent）。
 *     沙箱下 pi 需要往该目录写 settings.json.lock / auth.json.lock，故必须指到可写目录。
 *
 * 事件映射（pi → DSH）：
 *   pi `agent_start`                                → 触发 DSH start 帧（懒发，首个文本/边界事件时补发）
 *   pi `message_update`(text_delta)                 → DSH chunk 帧（chunk.type === 'text-delta'，index 从 0 稠密递增）
 *   pi `agent_settled`（或流自然结束/出错）          → DSH end 帧（end.index === 已发布分片数，outcome 如实 abandoned）
 *
 * 诚实边界（详见 SMOKE-EVIDENCE.md）：
 *   - 本适配器**不**做工具事件映射、**不**做会话续接（resume/--session-id）、**不**接完整 DSH base。
 *   - DSH 侧的 subject 仍是替身对象（kind:'pi-subject'/standIn:true），它不是真实 DSH Agent；
 *     但承载它的 dispatch 与 scope carrier 全部是上游 `@deepseek-ai/dsh-agent` 的真实实现。
 *   - end 帧 outcome 如实为 `abandoned`：pi 的这轮回答没有提交任何 durable 的
 *     DSH `assistant/message`；start.turn / start.step 为占位 0（无 durable turn）。
 */

import { pathToFileURL } from 'node:url'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEvents, emitAgentEvent } from '@deepseek-ai/dsh-agent'

/** 引擎标识：本轮新接入的 marker 值（options.meta.engine === 'pi' || options.engine === 'pi'）。 */
export const PI_ENGINE_ID = 'pi'

/** DSH 流式帧事件名（真实词汇，来自 dsh-agent 的 agent/* 契约）。 */
export const PI_STREAM_EVENT = 'agent/assistant-stream'

/** pi 替身 subject 的默认 id（非真实 DSH Agent，仅作 scope carrier 的 key）。 */
export const PI_SUBJECT_ID = 'engine-switch:pi'

/** 固定探针提示：要求模型只回 PI_OK，配合 maxTokens 上限把一次调用压到最短。 */
export const PI_PROMPT = 'Reply with exactly this token and nothing else: PI_OK'

/** 探针成功标记（PI_TEXT / PI_BRIDGE 断言用）。 */
export const PI_OK_MARKER = 'PI_OK'

/** pi 包目录（绝对路径；worker cwd 不是工作区，全程绝对路径）。 */
const DEFAULT_PI_PKG_DIR = join(
  homedir(),
  '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent',
)
export const PI_PKG_DIR = process.env.PI_PKG_DIR || DEFAULT_PI_PKG_DIR

/** pi 包主入口（RpcClient 从这里官方导出）。 */
export const PI_MODULE_PATH = `${PI_PKG_DIR}/dist/index.js`

/** RpcClient 示例（examples/rpc-client.ts）指向的 CLI 入口；RpcClient 以 `node <cliPath> --mode rpc` 拉起它。 */
export const PI_CLI_PATH = `${PI_PKG_DIR}/dist/cli.js`

/** 用户实际敲的 pi 可执行文件（symlink → dist/bundle/cli.js），仅作证据核对。 */
const DEFAULT_PI_BIN_PATH = join(homedir(), '.npm-global/bin/pi')
export const PI_BIN_PATH = process.env.PI_BIN_PATH || DEFAULT_PI_BIN_PATH

/** 传给 pi 子进程的 --name（唯一 tag，供 smoke 用 pgrep 断言「无残留子进程」）。 */
export const PI_CHILD_TAG = 'engine-switch-pi-smoke'

/** start 帧的 turn 占位值：pi 这轮没有 durable DSH turn，如实用 0。 */
export const PI_PLACEHOLDER_TURN = 0

/** start 帧的 step 占位值：同理如实用 0。 */
export const PI_PLACEHOLDER_STEP = 0

/** pi 子进程默认启动参数（最小面：无会话、无工具、无 MCP、不思考、不加载扩展/技能/上下文文件）。 */
export const PI_DEFAULT_ARGS = Object.freeze([
  '--no-session',
  '--thinking',
  'off',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
])

/** 默认 provider / model（pi 宿主默认即 magpie；这里显式写出，便于证据核对）。 */
export const PI_DEFAULT_PROVIDER = 'magpie'
export const PI_DEFAULT_MODEL = 'auto/deepseek-v4.1-flash'

/**
 * 判定一次 create/resume 调用是否携带 pi marker。
 * 兼容 options.meta.engine 与 options.engine 两种写法（与 echo 同款约定）。
 * @param {unknown} options create/resume 的调用参数
 * @returns {boolean} true 表示应交给 pi 引擎
 */
export function isPiMarked(options) {
  if (options === null || typeof options !== 'object') return false
  const meta = options.meta
  const fromMeta =
    meta !== null && typeof meta === 'object' ? meta.engine : undefined
  return fromMeta === PI_ENGINE_ID || options.engine === PI_ENGINE_ID
}

/**
 * 造一个 pi subject 替身：给真实 `agentEvents` 当 scope carrier 的 key、给监听器当 `agent` 身份。
 * 它不是真实 DSH Agent（没有 driver / 没有 DSH session 持久化）。
 * @param {object|null|undefined} options 调用参数（用于派生可辨识 id）
 */
export function createPiSubject(options) {
  const raw =
    options !== null && typeof options === 'object'
      ? options.sessionId ?? options.id ?? options.seed
      : undefined
  const id =
    typeof raw === 'string' && raw.length > 0
      ? `${PI_SUBJECT_ID}:${raw}`
      : PI_SUBJECT_ID
  return {
    id,
    session: { id },
    kind: 'pi-subject',
    engine: PI_ENGINE_ID,
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
 * 帧映射状态机：把 pi 的 RPC 事件流实时映射为 DSH 三类帧并发布。
 *
 * 发布设施与回声引擎同款（复用同一套发射设施）：首个帧走 `emitAgentEvent`（一次性冷路径），
 * 其余帧复用 `agentEvents(ctx, subject)` 的 retained dispatcher（热路径，与真实 AgentLoop 同形）。
 *
 * @param {object} ctx 真实 cordis Context（AgentRegistry 传入的 owner ctx）
 * @param {object} subject pi 替身 subject
 * @param {{attemptSeq?:number, now?:number, onPiEvent?:Function}} [opts]
 */
export function createPiFrameMapper(ctx, subject, opts = {}) {
  const attemptSeq = Number.isFinite(opts.attemptSeq) ? opts.attemptSeq : 1
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const attemptId = `${subject?.id ?? PI_SUBJECT_ID}#attempt-${attemptSeq}`
  /** @type {object[]} 已发布的帧（按序） */
  const frames = []
  let revision = 0
  let started = false
  let ended = false
  let text = ''
  let textDeltas = 0
  let dispatcher = null

  /** 发布一帧：首帧用 emitAgentEvent，其余用 retained dispatcher。 */
  function publish(frame) {
    frames.push(frame)
    if (frames.length === 1) {
      emitAgentEvent(ctx, subject, PI_STREAM_EVENT, { frame })
      dispatcher = agentEvents(ctx, subject)
    } else {
      if (dispatcher === null) dispatcher = agentEvents(ctx, subject)
      dispatcher.emit(PI_STREAM_EVENT, { frame })
    }
  }

  /** 懒发 start 帧（pi 可能先给 message_update，也可能先给 agent_start）。 */
  function ensureStart() {
    if (started) return
    started = true
    publish(
      startFrame(
        attemptId,
        (revision += 1),
        PI_PLACEHOLDER_TURN,
        PI_PLACEHOLDER_STEP,
      ),
    )
  }

  /**
   * 处理一条 pi RPC 事件（`response` 记录由 RpcClient 内部消化，不会到这里）。
   * @param {object} event pi 的 JsonAgentSessionEvent
   */
  function onPiEvent(event) {
    if (opts.onPiEvent) opts.onPiEvent(event)
    if (event === null || typeof event !== 'object') return
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      ensureStart()
      return
    }
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent
      if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
        ensureStart()
        textDeltas += 1
        text += delta.delta
        publish(
          chunkFrame(
            attemptId,
            (revision += 1),
            frames.filter((f) => f.type === 'chunk').length,
            now + textDeltas,
            delta.delta,
          ),
        )
      }
      return
    }
    if (event.type === 'agent_settled') finish()
  }

  /**
   * 收尾：确保 end 帧已发（幂等）。index === 已发布分片数。
   * @param {object} [extra] 附加到 outcome 的诊断信息（例如 error / aborted）
   */
  function finish(extra = {}) {
    if (ended) return
    ended = true
    ensureStart()
    publish(
      endFrame(
        attemptId,
        (revision += 1),
        frames.filter((f) => f.type === 'chunk').length,
        extra,
      ),
    )
  }

  return {
    attemptId,
    frames,
    onPiEvent,
    finish,
    get text() {
      return text
    },
    get textDeltas() {
      return textDeltas
    },
    get finished() {
      return ended
    },
  }
}

/** 从 ~/.pi/agent 播种时优先 symlink 的条目（避免复制密钥进工作区）。 */
export const PI_SEED_SYMLINK_ENTRIES = Object.freeze([
  'settings.json',
  'auth.json',
  'trust.json',
  'keybindings.json',
  'mcp.json',
  'models-store.json',
])

/** 从 ~/.pi/agent 播种时按目录 symlink 的条目（扩展/技能等，保持只读引用）。 */
export const PI_SEED_SYMLINK_DIRS = Object.freeze([
  'extensions',
  'skills',
  'prompts',
  'themes',
])

/**
 * 从宿主 ~/.pi/agent 播种一个**可写**的 PI_CODING_AGENT_DIR。
 *
 * 规则（验收标准 #3）：
 *   - 优先 symlink（settings/auth/trust/keybindings/mcp/models-store + extensions/skills/prompts/themes）；
 *     symlink 让配置与密钥留在 ~/.pi/agent，工作区内**不出现密钥副本**。
 *   - 唯一派生文件是 models.json：把 magpie 的 apiKey 就地换成 `$DSH_PI_SMOKE_MAGPIE_KEY` 环境插值
 *     （pi 官方支持的 `"$NAME"` 形式），并对探针模型加 `modelOverrides.maxTokens` 上限，
 *     把本次真实调用压到最短。派生文件里**不含任何字面密钥**。
 *   - 不打印该目录内容；只返回文件名清单与替换事实供证据引用。
 *
 * @param {{source?:string, target?:string, modelId?:string, maxTokens?:number, keyEnvVar?:string, force?:boolean}} [opts]
 * @returns {{target:string, symlinkedNames:string[], derivedNames:string[], apiKeyRefStyle:string, maxTokensApplied:number|null, bytesWritten:number, reused:boolean}}
 */
export function seedAgentDir(opts = {}) {
  const defaultSource = process.env.PI_AGENT_DIR || join(homedir(), '.pi/agent')
  const source = opts.source ?? defaultSource
  const target = opts.target
  if (!target) throw new Error('seedAgentDir: target 必填（必须是工作区内可写目录）')
  const modelId = opts.modelId ?? PI_DEFAULT_MODEL
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 16
  const keyEnvVar = opts.keyEnvVar ?? 'DSH_PI_SMOKE_MAGPIE_KEY'

  if (!existsSync(source)) {
    throw new Error(`seedAgentDir: 源配置目录不存在：${source}`)
  }
  const symlinkedNames = []
  const derivedNames = []
  let apiKeyRefStyle = 'none'
  let maxTokensApplied = null

  if (opts.force !== false && existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }
  mkdirSync(target, { recursive: true, mode: 0o700 })

  // 1) symlink 播种
  for (const name of PI_SEED_SYMLINK_ENTRIES) {
    const from = join(source, name)
    const to = join(target, name)
    if (!existsSync(from)) continue
    if (existsSync(to)) continue
    symlinkSync(from, to)
    symlinkedNames.push(name)
  }
  for (const name of PI_SEED_SYMLINK_DIRS) {
    const from = join(source, name)
    const to = join(target, name)
    if (!existsSync(from)) continue
    if (!lstatSync(from).isDirectory()) continue
    if (existsSync(to)) continue
    symlinkSync(from, to)
    symlinkedNames.push(`${name}/`)
  }

  // 2) 派生 models.json（密钥改环境插值 + maxTokens 上限）
  const src = join(source, 'models.json')
  if (existsSync(src)) {
    const parsed = JSON.parse(readFileSync(src, 'utf8'))
    const providerId = providerIdOf(parsed, modelId)
    const provider = parsed.providers?.[providerId]
    if (provider && typeof provider.apiKey === 'string' && provider.apiKey.length > 0) {
      provider.apiKey = `$${keyEnvVar}`
      apiKeyRefStyle = `env-interpolation "$${keyEnvVar}"`
    } else {
      apiKeyRefStyle = 'provider has no apiKey (untouched)'
    }
    if (provider) {
      provider.modelOverrides = provider.modelOverrides ?? {}
      provider.modelOverrides[modelId] = {
        ...(provider.modelOverrides[modelId] ?? {}),
        maxTokens,
      }
      maxTokensApplied = maxTokens
    }
    const out = join(target, 'models.json')
    writeFileSync(out, JSON.stringify(parsed, null, 2), { mode: 0o600 })
    derivedNames.push('models.json')
  }

  const bytesWritten = derivedNames.reduce((sum, name) => {
    const p = join(target, name)
    return sum + (existsSync(p) ? statSync(p).size : 0)
  }, 0)

  return {
    target,
    symlinkedNames,
    derivedNames,
    apiKeyRefStyle,
    maxTokensApplied,
    bytesWritten,
    reused: false,
  }
}

/**
 * 解析 modelId 所属的 provider id（"provider/model" 形式优先取前缀，否则按 models 列表匹配）。
 * @param {object} modelsJson models.json 解析结果
 * @param {string} modelId 目标模型 id
 * @returns {string} provider id（找不到时回落到 defaultProvider 或 'magpie'）
 */
function providerIdOf(modelsJson, modelId) {
  const providers = modelsJson?.providers ?? {}
  const slash = modelId.indexOf('/')
  if (slash > 0) {
    const prefix = modelId.slice(0, slash)
    for (const key of Object.keys(providers)) {
      if (key === prefix) return key
    }
  }
  for (const [key, value] of Object.entries(providers)) {
    const hit = Array.isArray(value?.models)
      ? value.models.some((m) => m?.id === modelId)
      : false
    if (hit) return key
  }
  return modelsJson?.defaultProvider ?? 'magpie'
}

/**
 * 探测某个 PI_CODING_AGENT_DIR 是否可写（pi 启动时要写 settings.json.lock / auth.json.lock）。
 * @param {string} dir 待探测目录
 * @returns {boolean} true 表示可写
 */
export function isAgentDirWritable(dir) {
  if (!dir || !existsSync(dir)) return false
  const probe = join(dir, '.write-probe-line-pi')
  try {
    writeFileSync(probe, 'ok', { mode: 0o600 })
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 解析官方 RpcClient：优先 config.piModulePath，其次包默认入口。
 * 若都不可用则返回 `{ RpcClient: null, error }`（调用方必须如实上报，禁止手写 stdio 冒充官方客户端）。
 * @param {{piModulePath?:string}} [config]
 * @returns {Promise<{RpcClient:Function|null, modulePath:string|null, error:Error|null}>}
 */
export async function resolveRpcClient(config = {}) {
  const candidates = [config.piModulePath, PI_MODULE_PATH].filter(Boolean)
  let error = null
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.RpcClient === 'function') {
        return { RpcClient: mod.RpcClient, modulePath: candidate, error: null }
      }
      error = new Error(`${candidate} 未导出 RpcClient`)
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause))
    }
  }
  return { RpcClient: null, modulePath: null, error }
}

/**
 * 构造 pi 引擎：每次调用起一个 `pi --mode rpc` 子进程、发一次极短提示、
 * 把 pi 事件映射成 DSH 帧、等 agent_settled、然后回收子进程。
 *
 * @param {object} [config]
 * @param {string} [config.agentDir] PI_CODING_AGENT_DIR（必须指向可写目录，否则 pi 起不来）
 * @param {string} [config.prompt] 探针提示
 * @param {number} [config.timeoutMs] 等 agent_settled 的上限
 * @param {string[]} [config.args] 覆盖默认 pi 启动参数
 * @param {string} [config.provider] 覆盖 provider
 * @param {string} [config.model] 覆盖 model
 * @param {string} [config.cliPath] 覆盖 RpcClient 的 cliPath
 */
export function createPiEngine(config = {}) {
  const stats = {
    createAgent: 0,
    resume: 0,
    attempts: 0,
    spawns: 0,
    stops: 0,
    piEvents: 0,
    childPids: [],
    textDeltas: 0,
    framesEmitted: 0,
    dispatchErrors: 0,
    spawnErrors: 0,
    rpcErrors: 0,
    rpcClientSource: null,
  }
  /** 每次 attempt 的结构化留档（供 smoke 断言/证据引用）。 */
  const attempts = []

  function baseOptions(options) {
    return {
      prompt: options?.prompt ?? config.prompt ?? PI_PROMPT,
      timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 45000,
      agentDir: config.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
      cliPath: config.cliPath ?? PI_CLI_PATH,
      provider: config.provider ?? PI_DEFAULT_PROVIDER,
      model: config.model ?? PI_DEFAULT_MODEL,
      args: config.args ?? [...PI_DEFAULT_ARGS],
      cwd: options?.meta?.cwd ?? options?.cwd ?? config.cwd,
    }
  }

  /**
   * 跑一次 pi attempt（官方 RpcClient）。
   * @param {object} engineCtx 真实调用方上下文
   * @param {object|null} options create/resume 参数
   * @param {'createAgent'|'resume'} kind
   */
  async function runAttempt(engineCtx, options, kind) {
    stats[kind] += 1
    stats.attempts += 1
    const o = baseOptions(options)
    const subject = createPiSubject(options)
    const mapper = createPiFrameMapper(engineCtx, subject, {
      attemptSeq: stats.attempts,
      onPiEvent: () => {
        stats.piEvents += 1
      },
    })
    const record = {
      kind,
      engine: PI_ENGINE_ID,
      subject,
      attemptId: mapper.attemptId,
      prompt: o.prompt,
      agentDir: o.agentDir,
      cliPath: o.cliPath,
      provider: o.provider,
      model: o.model,
      args: o.args,
      rpcClientSource: null,
      disposition: null,
      rpcReady: false,
      rpcReadyError: null,
      rpcStateKeys: [],
      piEventTypes: [],
      piEventCount: 0,
      text: '',
      textDeltas: 0,
      frames: mapper.frames,
      framesEmitted: 0,
      spawned: false,
      childPid: null,
      spawnedAt: null,
      stopped: false,
      error: null,
      events: [],
      durationMs: 0,
    }
    attempts.push(record)

    const started0 = Date.now()
    if (!o.agentDir) {
      record.error =
        'PI_CODING_AGENT_DIR 未设置：pi 在受限沙箱下需要可写配置目录，拒绝盲起子进程'
      stats.spawnErrors += 1
      mapper.finish({ engineError: record.error })
      record.framesEmitted = mapper.frames.length
      stats.framesEmitted += mapper.frames.length
      record.durationMs = Date.now() - started0
      return { ...record, engine: PI_ENGINE_ID, handledBy: 'pi-engine' }
    }

    const { RpcClient, modulePath, error } = await resolveRpcClient(config)
    record.rpcClientSource = modulePath
    stats.rpcClientSource = modulePath
    if (!RpcClient) {
      record.error = `官方 RpcClient 不可用：${error?.message ?? 'unknown'}`
      stats.spawnErrors += 1
      mapper.finish({ engineError: record.error })
      record.framesEmitted = mapper.frames.length
      stats.framesEmitted += mapper.frames.length
      record.durationMs = Date.now() - started0
      return { ...record, engine: PI_ENGINE_ID, handledBy: 'pi-engine' }
    }

    /** @type {any} */
    let client = null
    let unsubscribe = null
    try {
      client = new RpcClient({
        cliPath: o.cliPath,
        cwd: o.cwd,
        provider: o.provider,
        model: o.model,
        args: [...o.args, '--name', PI_CHILD_TAG],
        env: {
          PI_CODING_AGENT_DIR: o.agentDir,
          PI_CODING_AGENT_SESSION_DIR: `${o.agentDir}/../.pi-sessions`,
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
        },
      })
      stats.spawns += 1
      record.spawned = true
      record.spawnedAt = Date.now()
      await client.start()
      record.childPid = client.process?.pid ?? null
      if (record.childPid !== null) stats.childPids.push(record.childPid)
      // 先订阅再 prompt（rpc.md：订阅必须早于 prompt，否则可能错过极快的完成）。
      unsubscribe = client.onEvent((event) => {
        record.piEventTypes.push(event?.type ?? '(none)')
        mapper.onPiEvent(event)
      })
      // RPC 就绪探测：get_state 成功返回即证明协议通道双向可用（先于 prompt，不影响会话语义）。
      try {
        const state = await client.getState()
        record.rpcReady = true
        record.rpcStateKeys = state && typeof state === 'object' ? Object.keys(state).sort() : []
        record.rpcSessionIdKind = typeof state?.sessionId
      } catch (readyErr) {
        record.rpcReady = false
        record.rpcReadyError =
          readyErr instanceof Error ? readyErr.message : String(readyErr)
      }
      const events = await client.promptAndWait(o.prompt, undefined, o.timeoutMs)
      record.events = events
      record.piEventCount = events.length
      record.piEventTypes = events.map((e) => e?.type ?? '(none)')
      record.disposition = 'settled'
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err)
      stats.rpcErrors += 1
      mapper.finish({ engineError: record.error })
    } finally {
      try {
        if (typeof unsubscribe === 'function') unsubscribe()
        if (client) {
          if (typeof client.getStderr === 'function') {
            record.piStderrBytes = String(client.getStderr() ?? '').length
          }
          await client.stop()
          stats.stops += 1
          record.stopped = true
        }
      } catch (stopErr) {
        record.stopError =
          stopErr instanceof Error ? stopErr.message : String(stopErr)
      }
    }

    mapper.finish()
    record.text = mapper.text
    record.textDeltas = mapper.textDeltas
    record.frames = mapper.frames
    record.framesEmitted = mapper.frames.length
    stats.textDeltas += mapper.textDeltas
    stats.framesEmitted += mapper.frames.length
    record.durationMs = Date.now() - started0

    return {
      ...record,
      engine: PI_ENGINE_ID,
      handledBy: 'pi-engine',
      streamEvent: PI_STREAM_EVENT,
      subject,
      frames: mapper.frames,
      piText: mapper.text,
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

export default { createPiEngine, isPiMarked, createPiSubject, createPiFrameMapper }
