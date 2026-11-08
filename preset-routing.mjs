/**
 * preset-routing.mjs — agentPreset 路由确定性测试（不调模型）
 *
 * 组合：
 *   - 真实 @deepseek-ai/cordis 的 Context
 *   - 真实 @deepseek-ai/dsh-agent 的 AgentRegistry（经 ctx.plugin 装载）
 *   - 真实公开 API ctx.agents.setFactory() 注册「原生 target 替身」
 *   - 真实加载被测插件 index.js
 *
 * 验证目标：
 *   - options.meta.agentPreset === 'pi' → OAR 引擎被调用、原生 createAgent 0 次
 *   - options.meta.agentPreset === 'standard' → 原生 createAgent ≥1 次、OAR 零调用
 *   - meta 缺失 → 原生 createAgent ≥1 次、OAR 零调用
 *   - resume 路径同样两向各一条
 *
 * 退出码：全部 HIT → 0；任一 MISS → 1。
 */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const NM =
  '/Users/ivywu/Documents/deepseek-harness/default-workspace/.recon/dsh-src/dsh/node_modules/@deepseek-ai'
const WS = '/Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch'
const imp = (p) => import(pathToFileURL(p).href)

// 插件内部以裸标识符 import '@deepseek-ai/dsh-agent'（上游包的真实依赖关系）。
// 工作区无 node_modules，故用 Node 官方同步解析钩子把它指到 .recon 里的真实包；
// 这保证「插件 import 到的 agentEvents」与「冒烟脚本 import 到的」是同一个模块实例。
const AGENT_ENTRY = `${NM}/dsh-agent/lib/index.js`
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@deepseek-ai/dsh-agent') {
      return { url: pathToFileURL(AGENT_ENTRY).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

const { Context } = await imp(`${NM}/cordis/lib/index.js`)
const upstreamAgent = await imp(AGENT_ENTRY)
const { AgentRegistry } = upstreamAgent
const plug = await imp(`${WS}/index.js`)

let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ---- 组装最小真实组合 -------------------------------------------------------
const ctx = new Context()
ctx.provide('sessionProjections', { register: async () => ({ dispose() {} }) })
ctx.plugin(AgentRegistry)
await tick(50)

// 原生 target 替身（记录调用，便于断言「未打 preset → 原样委托」）
const nativeCalls = { createAgent: 0, resume: 0 }
const nativeTarget = {
  createAgent: async (_c, options) => {
    nativeCalls.createAgent++
    return { handledBy: 'native', options }
  },
  resume: async (_c, options) => {
    nativeCalls.resume++
    return { handledBy: 'native', options }
  },
}
ctx.agents.setFactory(nativeTarget) // 真实公开 API

// 加载被测插件（真实施加字段接管）
const fiber = ctx.plugin({ name: plug.PLUGIN_NAME, apply: plug.apply })
await tick(80)

const router = ctx.agents.factory?.target
const state = router?.[plug.STATE]

// ---- 1. PI_PRESET_CREATE：meta.agentPreset='pi' → OAR 引擎 -------------------
const beforePiCreate = { ...nativeCalls, piCreate: state?.piEngine?.stats?.createAgent ?? 0 }
const piPresetCreate = await ctx.agents.create({ meta: { agentPreset: 'pi' }, sessionId: 'preset-pi-create' })
const afterPiCreate = { ...nativeCalls, piCreate: state?.piEngine?.stats?.createAgent ?? 0 }

check(
  'PI_PRESET_CREATE',
  'meta.agentPreset="pi" 路由到 OAR 引擎（pi engine createAgent +1）',
  afterPiCreate.piCreate === beforePiCreate.piCreate + 1
)
check(
  'PI_PRESET_CREATE',
  'meta.agentPreset="pi" 不走原生 target（native createAgent 不变）',
  afterPiCreate.createAgent === beforePiCreate.createAgent
)

// ---- 2. PI_PRESET_RESUME：meta.agentPreset='pi' → OAR 引擎 -------------------
const beforePiResume = { ...nativeCalls, piResume: state?.piEngine?.stats?.resume ?? 0 }
const piPresetResume = await ctx.agents.resume({ meta: { agentPreset: 'pi' }, sessionId: 'preset-pi-resume' })
const afterPiResume = { ...nativeCalls, piResume: state?.piEngine?.stats?.resume ?? 0 }

check(
  'PI_PRESET_RESUME',
  'meta.agentPreset="pi" 路由到 OAR 引擎（pi engine resume +1）',
  afterPiResume.piResume === beforePiResume.piResume + 1
)
check(
  'PI_PRESET_RESUME',
  'meta.agentPreset="pi" 不走原生 target（native resume 不变）',
  afterPiResume.resume === beforePiResume.resume
)

// ---- 3. STANDARD_PRESET_CREATE：meta.agentPreset='standard' → 原生 target ----
const beforeStdCreate = { ...nativeCalls, piCreate: state?.piEngine?.stats?.createAgent ?? 0 }
const stdPresetCreate = await ctx.agents.create({ meta: { agentPreset: 'standard' }, sessionId: 'preset-std-create' })
const afterStdCreate = { ...nativeCalls, piCreate: state?.piEngine?.stats?.createAgent ?? 0 }

check(
  'STANDARD_PRESET_CREATE',
  'meta.agentPreset="standard" 走原生 target（native createAgent +1）',
  afterStdCreate.createAgent === beforeStdCreate.createAgent + 1 && stdPresetCreate?.handledBy === 'native'
)
check(
  'STANDARD_PRESET_CREATE',
  'meta.agentPreset="standard" 不走 OAR 引擎（pi engine createAgent 不变）',
  afterStdCreate.piCreate === beforeStdCreate.piCreate
)

// ---- 4. STANDARD_PRESET_RESUME：meta.agentPreset='standard' → 原生 target ----
const beforeStdResume = { ...nativeCalls, piResume: state?.piEngine?.stats?.resume ?? 0 }
const stdPresetResume = await ctx.agents.resume({ meta: { agentPreset: 'standard' }, sessionId: 'preset-std-resume' })
const afterStdResume = { ...nativeCalls, piResume: state?.piEngine?.stats?.resume ?? 0 }

check(
  'STANDARD_PRESET_RESUME',
  'meta.agentPreset="standard" 走原生 target（native resume +1）',
  afterStdResume.resume === beforeStdResume.resume + 1 && stdPresetResume?.handledBy === 'native'
)
check(
  'STANDARD_PRESET_RESUME',
  'meta.agentPreset="standard" 不走 OAR 引擎（pi engine resume 不变）',
  afterStdResume.piResume === beforeStdResume.piResume
)

// ---- 5. MISSING_META_CREATE：meta 缺失 → 原生 target（保底断言）--------------
const beforeMissingCreate = { ...nativeCalls, piCreate: state?.piEngine?.stats?.createAgent ?? 0 }
const missingMetaCreate = await ctx.agents.create({ sessionId: 'no-meta-create' })
const afterMissingCreate = { ...nativeCalls, piCreate: state?.piEngine?.stats?.createAgent ?? 0 }

check(
  'MISSING_META_CREATE',
  'meta 缺失时走原生 target（native createAgent +1）',
  afterMissingCreate.createAgent === beforeMissingCreate.createAgent + 1 && missingMetaCreate?.handledBy === 'native'
)
check(
  'MISSING_META_CREATE',
  'meta 缺失时不走 OAR 引擎（pi engine createAgent 不变）',
  afterMissingCreate.piCreate === beforeMissingCreate.piCreate
)

// ---- 6. MISSING_META_RESUME：meta 缺失 → 原生 target（保底断言）--------------
const beforeMissingResume = { ...nativeCalls, piResume: state?.piEngine?.stats?.resume ?? 0 }
const missingMetaResume = await ctx.agents.resume({ sessionId: 'no-meta-resume' })
const afterMissingResume = { ...nativeCalls, piResume: state?.piEngine?.stats?.resume ?? 0 }

check(
  'MISSING_META_RESUME',
  'meta 缺失时走原生 target（native resume +1）',
  afterMissingResume.resume === beforeMissingResume.resume + 1 && missingMetaResume?.handledBy === 'native'
)
check(
  'MISSING_META_RESUME',
  'meta 缺失时不走 OAR 引擎（pi engine resume 不变）',
  afterMissingResume.piResume === beforeMissingResume.piResume
)

// ---- 汇总 -------------------------------------------------------------------
console.log(`\nSUMMARY: ${pass} HIT / ${fail} MISS`)
console.log(fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(fail === 0 ? 0 : 1)
