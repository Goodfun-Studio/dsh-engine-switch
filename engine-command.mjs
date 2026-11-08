/**
 * engine-command.mjs —— 引擎切换的**人机界面**（host 侧，无 cordis 依赖、无 IO）。
 *
 * 这是「独立引擎选择器」的入口语法与文案：解析 `/engine [native|pi|echo]`，
 * 并把「选择结果」翻译成用户能看懂的一段文本。真正的注册与写盘在 index.js，
 * 本模块只负责语法与措辞，因此可以脱离任何运行时逐条断言。
 *
 * 为什么是斜杠命令而不是又一根下拉框：见 ENGINE-SELECTOR-EVIDENCE.md 的选型一节 ——
 * 引擎是**建 Agent 时**才定的（DSH 在「新建任务」瞬间就建好了 Agent，preset 之所以
 * 能改是因为它有一等公民的 remote 做活体换装，第三方插件没有这个口子），所以引擎
 * 选择器的语义只能是「接下来的任务用哪个引擎」，而不是「当前任务换个引擎」。
 * 斜杠命令输入区本来就有一等公民的菜单（dsh-client-ui-commands），既在输入区域、
 * 又完全独立于 preset 下拉框，且不需要往客户端塞一个自造 bundle。
 */

import {
  ECHO_ENGINE_ID,
  ENGINE_IDS,
  NATIVE_ENGINE_ID,
  PI_ENGINE_ID,
  normalizeEngineId,
} from './engine-intent.mjs'

/** 斜杠命令名。 */
export const ENGINE_COMMAND_NAME = 'engine'

/** 命令入参提示（照 DSH 既有命令的写法）。 */
export const ENGINE_COMMAND_HINT = '[native|pi|echo]'

/** 命令描述（命令菜单里显示的文案，与上游既有命令一致用英文）。 */
export const ENGINE_COMMAND_DESCRIPTION =
  'Select the engine that drives this Session (orthogonal to the Agent preset)'

/** 引擎的展示名（人话）。 */
export const ENGINE_LABELS = Object.freeze({
  [NATIVE_ENGINE_ID]: '原生引擎',
  [PI_ENGINE_ID]: 'Pi 引擎',
  [ECHO_ENGINE_ID]: '回声引擎',
})

/**
 * 引擎展示名。
 * @param {unknown} engine 引擎取值
 * @returns {string} 展示名；取值不作数时如实回显原文，不猜
 */
export function engineLabel(engine) {
  const normalized = normalizeEngineId(engine)
  if (normalized === null) return String(engine)
  return ENGINE_LABELS[normalized]
}

/** 可选值一行文案。 */
export function engineOptionsLine() {
  return ENGINE_IDS.join(' | ')
}

/**
 * 解析 `/engine` 的入参。
 *
 * 语法纪律（与引擎取值归一化同款）：只承认精确的三个 id，大小写/空白/近似值
 * 一律判为未知，并在文案里如实回显用户敲的原文。
 *
 * @param {unknown} rawInput 命令名之后的原文（含分隔空白）
 * @returns {{kind:'show'} |
 *           {kind:'select', engine:'native'|'pi'|'echo'} |
 *           {kind:'unknown', token:string} |
 *           {kind:'invalid', reason:string}} 解析结果
 */
export function parseEngineCommand(rawInput) {
  if (rawInput === undefined || rawInput === null) return { kind: 'show' }
  if (typeof rawInput !== 'string') return { kind: 'invalid', reason: 'input-not-text' }
  const trimmed = rawInput.trim()
  if (trimmed === '') return { kind: 'show' }
  const parts = trimmed.split(/\s+/)
  if (parts.length > 1) return { kind: 'unknown', token: trimmed }
  const engine = normalizeEngineId(parts[0])
  if (engine === null) return { kind: 'unknown', token: parts[0] }
  return { kind: 'select', engine }
}

/**
 * `/engine`（无入参）的结果文案：当前选择器值 + 本会话已绑定的引擎。
 * @param {{selectorEngine?:unknown, selectorError?:unknown, sessionEngine?:unknown, sessionId?:unknown}} state
 * @returns {string} 展示文本
 */
export function showResultText(state = {}) {
  const lines = []
  const selector = normalizeEngineId(state.selectorEngine)
  if (selector === null) {
    lines.push(
      state.selectorError === undefined || state.selectorError === null
        ? `引擎选择器：未设置（缺省 ${NATIVE_ENGINE_ID}）`
        : `引擎选择器：不可读（${String(state.selectorError)}）`,
    )
  } else {
    lines.push(`引擎选择器：${engineLabel(selector)}（${selector}）`)
  }
  const session = normalizeEngineId(state.sessionEngine)
  if (session !== null) {
    lines.push(`本会话：${engineLabel(session)}（${session}）`)
  } else {
    lines.push(
      typeof state.sessionId === 'string' && state.sessionId.length > 0
        ? '本会话：尚未落下（下一个新建任务由选择器决定）'
        : '本会话：无会话身份',
    )
  }
  lines.push(`可选：${engineOptionsLine()} —— 用法：/${ENGINE_COMMAND_NAME} pi`)
  return lines.join('\n')
}

/**
 * 切换成功的结果文案。
 *
 * 诚实边界：DSH 在「新建任务」时就把 Agent 建好了，第三方插件没有活体换装的口子，
 * 所以这次选择**不会**改写当前会话已经在跑的那个 Agent —— 文案必须把这一点说清楚，
 * 不能让用户以为「当前任务已经切过去了」。
 *
 * @param {{engine:'native'|'pi'|'echo', bindingCleared?:boolean}} outcome
 * @returns {string} 展示文本
 */
export function selectResultText(outcome) {
  const engine = normalizeEngineId(outcome?.engine)
  const lines = [
    `引擎选择器已切到 ${engineLabel(engine)}（${engine}）。`,
    '之后新建的任务、以及之后重新载入的任务由它驱动。',
  ]
  if (outcome?.bindingCleared === true) {
    lines.push('本会话此前的引擎绑定已解除，它下次重新载入时跟随本次选择。')
  } else {
    lines.push('当前会话的 Agent 已经建好，本轮不受影响。')
  }
  return lines.join('\n')
}

/**
 * 失败/未知的结果文案。
 * @param {{error:string, token?:string, detail?:unknown}} outcome
 * @returns {string} 展示文本
 */
export function errorResultText(outcome) {
  const hints = {
    'unknown-engine': `未知引擎「${outcome.token ?? ''}」。可选：${engineOptionsLine()}`,
    'settings-unavailable': '引擎选择器不可写：该部署没有挂载 settings 服务。',
    'namespace-unavailable': `引擎选择器不可写：settings 里没有 "${outcome.detail ?? ''}" 这个命名空间（插件配置未启用为可编辑）。`,
    'write-failed': `引擎选择器写入失败：${outcome.detail ?? 'unknown'}`,
    'register-failed': `命令注册失败：${outcome.detail ?? 'unknown'}`,
    'bad-input': '参数不是一段文本。',
  }
  return hints[outcome.error] ?? `引擎命令失败：${outcome.error}`
}
