/**
 * session-commit.mjs — 把 pi 文本持久提交进真实 DSH 会话
 *
 * 五步配方（逐字照抄 dsh-agent-loop 的实现）：
 *   1. sessions.prepare(sessionId, {})
 *   2. sessions.enter(session) + sessions.announce(session)
 *   3. session.append('turn/start', {turn})
 *   4. session.append('assistant/message', {turn, step, message}, {surfaceOp:'append'})
 *   5. session.append('turn/end', {turn, reason:{kind:'completed'}})
 *   6. sessions.flush(session)
 *
 * 出处：@deepseek-ai/dsh-agent-loop 的 createStoredSession / appendUnstoredSuffix / ReactLoopAgent 第 731/819/949 行附近
 */

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'

/**
 * 提交 assistant message 进真实 DSH 会话（followup 期间提交三段事件）。
 * @param {object} ctx 真实 cordis Context
 * @param {string} sessionId 会话 id
 * @param {string} text 助手回复文本
 * @param {object} evidence 证据对象（写入四字段）
 * @returns {Promise<object|null>} 返回真实 Session 对象（供暴露为 agent.session）
 */
export async function commitAssistantMessage(ctx, sessionId, text, evidence) {
  try {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('sessions service unavailable')
    const session = sessions.prepare(sessionId, {})
    sessions.enter(session)
    sessions.announce(session)
    
    // 提交三段事件（按 dsh-agent-loop 的顺序）
    const turn = 1
    const step = 1
    session.append('turn/start', { turn })
    
    const message = createAssistantMessage({ 
      content: [{ type: 'text', text }], 
      source: { provider: 'pi', model: 'pi' } 
    })
    session.append('assistant/message', { turn, step, message }, { surfaceOp: 'append' })
    
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    
    // flush（让事件持久化）
    await sessions.flush(session)
    
    evidence.sessionId = sessionId
    evidence.assistantMessageAppended = true
    evidence.committedText = text
    evidence.commitError = null
    
    return session
  } catch (e) {
    evidence.sessionId = sessionId ?? null
    evidence.assistantMessageAppended = false
    evidence.committedText = null
    evidence.commitError = String(e && e.message ? e.message : e)
    return null
  }
}
