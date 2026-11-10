/**
 * pi-context.mjs —— Pi 原生会话 id 的持久绑定与 DSH 历史 Bootstrap
 *
 * 这一层只处理两件事：
 *   1. 记住「一个 DSH 会话对应哪个 Pi 原生 session id」；
 *   2. 当原生 id 不可用（旧会话、resume 失败、cwd 变了）时，把 DSH 已落盘的
 *      user/assistant 历史整理成一次性的文本 Bootstrap。
 *
 * 不记录消息正文，不把 DSH 历史复制到新的持久化存储：磁盘文件里只有 session id、
 * cwd、模型等定位信息。历史正文每次从 DSH Session 现读。
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const PI_NATIVE_SESSION_SCHEMA_VERSION = 1
export const DSH_HISTORY_OPEN = '<dsh_conversation_history>'
export const DSH_HISTORY_CLOSE = '</dsh_conversation_history>'
export const DSH_CURRENT_OPEN = '<current_user_message>'
export const DSH_CURRENT_CLOSE = '</current_user_message>'

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text') continue
    if (typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * 从 DSH Message 里抽纯文本。只接受 user/assistant；tool/developer/system 不进入
 * Bootstrap，避免把工具协议、系统提示词或隐藏上下文伪装成普通对话。
 *
 * @param {unknown} message DSH Session.deriveMessages() 的一条消息
 * @returns {{role:'user'|'assistant', text:string}|null}
 */
export function piHistoryEntryOf(message) {
  if (message === null || typeof message !== 'object') return null
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const content = message.content
  const text = textOfContent(content)
  return text === '' ? null : { role: message.role, text }
}

/**
 * 把 DSH deriveMessages() 的结果整理成可注入 Pi 的历史条目。
 *
 * @param {unknown} messages DSH 消息数组
 * @param {{excludeIds?:Iterable<string>}} [options] 需要排除的消息 id
 * @returns {Array<{role:'user'|'assistant', text:string}>}
 */
export function conversationHistory(messages, options = {}) {
  if (!Array.isArray(messages)) return []
  const excluded = new Set(options.excludeIds ?? [])
  const history = []
  for (const message of messages) {
    if (typeof message?.id === 'string' && excluded.has(message.id)) continue
    const entry = piHistoryEntryOf(message)
    if (entry !== null) history.push(entry)
  }
  return history
}

/**
 * 构造旧会话的 Bootstrap prompt。
 *
 * 历史为空时原样返回当前 prompt，保证单轮会话和 native 路径没有多余包装。
 * 历史非空时把历史和新问题分段，避免模型把历史里的旧 user 文本误当成本轮指令。
 *
 * @param {Array<{role:'user'|'assistant', text:string}>} history 历史条目
 * @param {string} prompt 当前用户消息
 * @returns {{prompt:string, injected:boolean, messageCount:number, chars:number}}
 */
export function formatPiBootstrapPrompt(history, prompt) {
  const current = typeof prompt === 'string' ? prompt : ''
  const entries = Array.isArray(history) ? history : []
  if (entries.length === 0) {
    return { prompt: current, injected: false, messageCount: 0, chars: 0 }
  }
  const body = entries
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}:\n${entry.text}`)
    .join('\n\n')
  const combined = [
    DSH_HISTORY_OPEN,
    body,
    DSH_HISTORY_CLOSE,
    '',
    'Continue the above conversation. The current user message follows.',
    DSH_CURRENT_OPEN,
    current,
    DSH_CURRENT_CLOSE,
  ].join('\n')
  const historyChars = body.length
  return {
    prompt: combined,
    injected: true,
    messageCount: entries.length,
    chars: historyChars,
  }
}

/** 文件名使用 URL 编码，避免 session id 里的字符成为路径分隔符。 */
export function nativeSessionFileName(sessionId) {
  return `${encodeURIComponent(String(sessionId)).replaceAll('%', '_')}.json`
}

/**
 * 构造「DSH session id → Pi native session id」持久存储。
 *
 * 每个 DSH 会话一个 JSON 文件，避免全局 map 的并发覆盖；原子 rename 保证读取方不会
 * 观察到半截 JSON。目录由调用方显式传入（默认是 Pi agentDir 下的插件子目录）。
 *
 * @param {{dir?:string}} [config]
 */
export function createPiNativeSessionStore(config = {}) {
  const dir =
    typeof config.dir === 'string' && config.dir.trim() !== '' ? config.dir : null
  const stats = { read: 0, write: 0, clear: 0 }

  const fileFor = (sessionId) =>
    dir === null || typeof sessionId !== 'string' || sessionId === ''
      ? null
      : join(dir, nativeSessionFileName(sessionId))

  /**
   * 读一个绑定。损坏/缺失都返回 ok:false，由上层回退到历史 Bootstrap。
   * @param {string} sessionId
   */
  const read = (sessionId) => {
    stats.read += 1
    const file = fileFor(sessionId)
    if (file === null) return { ok: false, entry: null, file: null, error: 'store-disabled' }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (
        parsed?.version !== PI_NATIVE_SESSION_SCHEMA_VERSION ||
        parsed?.dshSessionId !== sessionId ||
        typeof parsed?.piSessionId !== 'string' ||
        parsed.piSessionId === ''
      ) {
        return { ok: false, entry: null, file, error: 'invalid-record' }
      }
      return { ok: true, entry: parsed, file, error: null }
    } catch (error) {
      const code = error?.code
      return {
        ok: false,
        entry: null,
        file,
        error: code === 'ENOENT' ? 'not-found' : String(error?.message ?? error),
      }
    }
  }

  /**
   * 原子写入一个绑定。
   * @param {string} sessionId DSH session id
   * @param {{piSessionId:string,cwd?:string|null,model?:string|null,effort?:string|null}} entry
   */
  const write = (sessionId, entry) => {
    stats.write += 1
    const file = fileFor(sessionId)
    if (file === null) return { ok: false, file: null, error: 'store-disabled' }
    if (typeof entry?.piSessionId !== 'string' || entry.piSessionId === '') {
      return { ok: false, file, error: 'missing-pi-session-id' }
    }
    try {
      mkdirSync(dir, { recursive: true })
      const staging = `${file}.tmp-${process.pid}-${Date.now()}`
      const record = {
        version: PI_NATIVE_SESSION_SCHEMA_VERSION,
        dshSessionId: sessionId,
        piSessionId: entry.piSessionId,
        cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
        model: typeof entry.model === 'string' ? entry.model : null,
        effort: typeof entry.effort === 'string' ? entry.effort : null,
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`)
      renameSync(staging, file)
      return { ok: true, file, entry: record, error: null }
    } catch (error) {
      return { ok: false, file, error: String(error?.message ?? error) }
    }
  }

  /**
   * 删除一个失效绑定。只删本函数算出的单文件，不递归、不碰目录。
   * @param {string} sessionId
   */
  const clear = (sessionId) => {
    stats.clear += 1
    const file = fileFor(sessionId)
    if (file === null) return { ok: false, removed: false, file: null, error: 'store-disabled' }
    try {
      unlinkSync(file)
      return { ok: true, removed: true, file, error: null }
    } catch (error) {
      return {
        ok: error?.code === 'ENOENT',
        removed: false,
        file,
        error: error?.code === 'ENOENT' ? null : String(error?.message ?? error),
      }
    }
  }

  return { dir, fileFor, read, write, clear, stats }
}
