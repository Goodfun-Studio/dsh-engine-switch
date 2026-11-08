// force-engine.test.mjs 头部参数化（只改路径定义部分）
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKSPACE || join(__dirname, '..')
const NM = join(ROOT, '.recon/dsh-src/dsh/node_modules/@deepseek-ai')
const WS = join(ROOT, 'dsh-engine-switch')
const AGENT_ENTRY = `${NM}/dsh-agent/lib/index.js`

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@deepseek-ai/dsh-agent') {
      return { url: pathToFileURL(AGENT_ENTRY).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

const plug = await import(pathToFileURL(`${WS}/index.js`).href)

let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}

// ---------------------------------------------------------------------------
// 最小替身：原生 target / 回声引擎 / pi 引擎（只记调用，不做任何真实副作用）
// ---------------------------------------------------------------------------
const mkTargets = () => {
  const calls = { native: { createAgent: 0, resume: 0 }, echo: 0, pi: { createAgent: 0, resume: 0 } }
  const nativeTarget = {
    createAgent: async (_c, o) => {
      calls.native.createAgent++
      return { handledBy: 'native', kind: 'createAgent', options: o }
    },
    resume: async (_c, o) => {
      calls.native.resume++
      return { handledBy: 'native', kind: 'resume', options: o }
    },
  }
  const echoEngine = {
    createAgent: async (_c, o) => {
      calls.echo++
      return { handledBy: 'echo', kind: 'createAgent', options: o }
    },
    resume: async (_c, o) => {
      calls.echo++
      return { handledBy: 'echo', kind: 'resume', options: o }
    },
  }
  const piEngine = {
    createAgent: async (_c, o) => {
      calls.pi.createAgent++
      return { handledBy: 'pi', kind: 'createAgent', piText: 'PI_OK', options: o }
    },
    resume: async (_c, o) => {
      calls.pi.resume++
      return { handledBy: 'pi', kind: 'resume', piText: 'PI_OK', options: o }
    },
  }
  return { calls, nativeTarget, echoEngine, piEngine }
}

const route = async (forceEngine, piPresence, marker, kind = 'createAgent') => {
  const t = mkTargets()
  const router = plug.createRouter(t.nativeTarget, t.echoEngine, piPresence ? t.piEngine : undefined, {
    forceEngine,
  })
  const res = await router[kind]({}, marker === null ? {} : { meta: { engine: marker } })
  return { res, calls: t.calls, router }
}

// ---------------------------------------------------------------------------
// ① 正向：forceEngine='pi' 把未打 marker 的调用强制交给 pi
// ---------------------------------------------------------------------------
const fwd = await route('pi', true, null, 'createAgent')
check(
  'FORCE_PI_POSITIVE',
  "forceEngine='pi' 时未打 marker 的 create 被强制路由到 pi（handledBy==='pi'）",
  fwd.res?.handledBy === 'pi' && fwd.calls.pi.createAgent === 1,
)
check(
  'FORCE_PI_POSITIVE',
  "forceEngine='pi' 时未打 marker 的 create 不再落到原生 target（native 计数 0）",
  fwd.calls.native.createAgent === 0,
)
const fwdResume = await route('pi', true, null, 'resume')
check(
  'FORCE_PI_POSITIVE',
  "forceEngine='pi' 时未打 marker 的 resume 同样被强制路由到 pi",
  fwdResume.res?.handledBy === 'pi' && fwdResume.calls.pi.resume === 1,
)
check(
  'FORCE_PI_POSITIVE',
  "router.forcedRoute==='pi' 且 router.forceEngine==='pi'（证据可观测）",
  fwd.router.forcedRoute === 'pi' && fwd.router.forceEngine === 'pi',
)

// ---------------------------------------------------------------------------
// ② 负向（零回归）：forceEngine=null/缺省 → 与改造前逐字一致
// ---------------------------------------------------------------------------
const def = await route(null, true, null)
check(
  'NEG_DEFAULT_UNCHANGED',
  'forceEngine=null 时未打 marker 的 create 仍走原生 target（零行为变更）',
  def.res?.handledBy === 'native' && def.calls.native.createAgent === 1 && def.calls.pi.createAgent === 0,
)
check(
  'NEG_DEFAULT_UNCHANGED',
  'forceEngine=null 时 router.forcedRoute 为 null（未强制）',
  def.router.forcedRoute === null,
)
const defUndef = await route(undefined, true, null)
check(
  'NEG_DEFAULT_UNCHANGED',
  'forceEngine 完全缺省（undefined）时同样走原生 target，且不得抛错',
  defUndef.res?.handledBy === 'native' && defUndef.calls.pi.createAgent === 0,
)
// 默认值下 marker 分流不得被破坏：pi marker 仍走 pi、echo marker 仍走 echo
const defPiMarked = await route(null, true, 'pi')
check(
  'NEG_DEFAULT_UNCHANGED',
  "forceEngine=null 时 pi marker 仍精确走 pi（marker 分流未被新配置干扰）",
  defPiMarked.res?.handledBy === 'pi' && defPiMarked.calls.native.createAgent === 0,
)
const defEchoMarked = await route(null, true, 'echo')
check(
  'NEG_DEFAULT_UNCHANGED',
  "forceEngine=null 时 echo marker 仍精确走 echo",
  defEchoMarked.res?.handledBy === 'echo',
)

// ---------------------------------------------------------------------------
// ③ 负向（防误伤）：近似/非法取值一律不得触发强制
// ---------------------------------------------------------------------------
const badValues = ['PI', 'pi ', ' pi', 'pi-lite', 'PI_OK', '', '   ', 0, 1, true, {}, [], null, undefined]
const badResults = []
for (const v of badValues) badResults.push(await route(v, true, null))
check(
  'NEG_BAD_VALUE_NO_FORCE',
  `非法/近似取值（${badValues.length} 个：'PI'/'pi '/'pi-lite'/''/0/{}/null/undefined …）一律不强制，未打 marker 全部走原生 target`,
  badResults.every((r) => r.res?.handledBy === 'native' && r.calls.pi.createAgent === 0),
)
check(
  'NEG_BAD_VALUE_NO_FORCE',
  '非法取值下 router.forcedRoute 恒为 null（不产生"看起来强制了"的假象）',
  badResults.every((r) => r.router.forcedRoute === null),
)
check(
  'NEG_BAD_VALUE_NO_FORCE',
  "归一化只认精确字符串：normalizeForceEngine('pi')==='pi'，'pi ' / 'PI' 归一化后仍不命中强制",
  plug.normalizeForceEngine('pi') === 'pi' &&
    plug.resolveForcedRoute(plug.normalizeForceEngine('pi '), { piEngine: {} }) === null &&
    plug.resolveForcedRoute(plug.normalizeForceEngine('PI'), { piEngine: {} }) === null,
)

// ---------------------------------------------------------------------------
// ④ 负向（防误伤）：forceEngine='pi' 但 pi 引擎缺位 → 不强制、不抛错
// ---------------------------------------------------------------------------
const noEngine = await route('pi', false, null)
check(
  'NEG_NO_ENGINE_NO_FORCE',
  "forceEngine='pi' 但 piEngine 缺位时不强制（回落 marker 分流，走原生 target），且不抛错",
  noEngine.res?.handledBy === 'native' && noEngine.calls.native.createAgent === 1,
)
check(
  'NEG_NO_ENGINE_NO_FORCE',
  'piEngine 缺位时 forcedRoute 为 null（不伪报强制生效）',
  noEngine.router.forcedRoute === null,
)

// ---------------------------------------------------------------------------
// ⑤ 负向（防误伤）：强制路由不得吞错、不得改写结果
// ---------------------------------------------------------------------------
{
  const t = mkTargets()
  const boom = new Error('pi-boom')
  const failingPi = {
    createAgent: async () => {
      throw boom
    },
    resume: async () => {
      throw boom
    },
  }
  const router = plug.createRouter(t.nativeTarget, t.echoEngine, failingPi, {
    forceEngine: 'pi',
    onPiResult: (kind, res, err) => {
      globalThis.__piResultSeen = { kind, res, err }
    },
  })
  let thrown = null
  try {
    await router.createAgent({}, {})
  } catch (e) {
    thrown = e
  }
  check(
    'NEG_ERROR_NOT_SWALLOWED',
    "forceEngine='pi' 时 pi 引擎抛错必须原样上抛（不得吞错后假装成功）",
    thrown === boom && t.calls.native.createAgent === 0,
  )
  const seen = globalThis.__piResultSeen
  check(
    'NEG_ERROR_NOT_SWALLOWED',
    'onPiResult 失败回调如实收到错误对象（证据侧可判别失败，禁止把失败写成空文本通过）',
    seen?.err === boom && seen?.res === null,
  )
  delete globalThis.__piResultSeen
}
{
  const t = mkTargets()
  const router = plug.createRouter(t.nativeTarget, t.echoEngine, t.piEngine, { forceEngine: 'pi' })
  const out = await router.createAgent({}, {})
  check(
    'NEG_RESULT_PASSTHROUGH',
    '强制路由不得改写 pi 引擎的返回结果（对象引用与字段原样透传）',
    out?.handledBy === 'pi' && out?.piText === 'PI_OK',
  )
}

// ---------------------------------------------------------------------------
// ⑥ ~/.dsh 隔离断言归因逻辑（HOMEDIR_UNTOUCHED 判据）双向守卫
// ---------------------------------------------------------------------------
/** 解析指纹 -> Map<path, sha>（与 endo-pi.sh 的 fp_dir 输出同形）。 */
const parseFp = (text) =>
  new Map(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{64}\s{2}/.test(l))
      .map((l) => {
        const i = l.indexOf('  ')
        return [l.slice(i + 2), l.slice(0, 64)]
      }),
  )
/** 与 endo-pi.sh 同一判据：changed = 前后指纹不一致或新增/删除的路径集合。 */
const attrChanged = (before, after) => {
  const b = parseFp(before)
  const a = parseFp(after)
  const paths = new Set([...b.keys(), ...a.keys()])
  const changed = new Set()
  for (const p of paths) if (b.get(p) !== a.get(p)) changed.add(p)
  return changed
}
/** 与 endo-pi.sh 同一判据：本次运行引入的、环境漂移之外的新路径。 */
const newPaths = (runChanged, ambientChanged) =>
  [...runChanged].filter((p) => !ambientChanged.has(p)).sort()

// 生成 64 位十六进制摘要（任意字符入参都产出合法 sha256 形态，供指纹解析器识别）
const sha = (c) => c.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)
const fpOf = (pairs) => pairs.map(([p, c]) => `${sha(c)}  ${p}`).join('\n')

// 正例：本次运行改变的路径全部落在环境自身漂移集合内 → UNTOUCHED
{
  const before = fpOf([['./a', 'a'], ['./b', 'b'], ['./c', 'c']])
  const after = fpOf([['./a', 'a'], ['./b', 'B'], ['./c', 'c']]) // 本次运行观察期结束时
  const ambient = after // 对照采样（不跑插件的那段时间）同样只看到 ./b 变化 —— 环境自身在写
  const ambientChanged = attrChanged(before, ambient)
  const runChanged = attrChanged(before, after)
  check(
    'FINGERPRINT_ATTRIBUTION',
    '正例：本次运行期间唯一变化路径 ./b 也属环境漂移（ambientChanged）→ 判为 UNTOUCHED（真实场景：桌面端持续重写 session_projcache）',
    runChanged.size === 1 && newPaths(runChanged, ambientChanged).length === 0,
  )
}
// 反例 1：本次运行新增了一个环境从不漂移的路径 → 必须判为 CHANGED（防漏杀）
{
  const before = fpOf([['./a', 'a'], ['./c', 'c']])
  const ambient = fpOf([['./a', 'a'], ['./b', 'B'], ['./c', 'c']])
  const after = fpOf([['./a', 'a'], ['./b', 'B'], ['./c', 'c'], ['./leak', 'x']])
  const ambientChanged = attrChanged(before, ambient)
  const runChanged = attrChanged(before, after)
  const np = newPaths(runChanged, ambientChanged)
  check(
    'FINGERPRINT_ATTRIBUTION',
    "反例：本次运行引入了新路径 ./leak（环境漂移里没有）→ 必须判为 CHANGED，不得被 ambient 白名单吞掉",
    np.length === 1 && np[0] === './leak',
  )
}
// 反例 2：环境完全静止，本次运行改了内容 → 必须判为 CHANGED
{
  const before = fpOf([['./a', 'a'], ['./c', 'c']])
  const ambient = fpOf([['./a', 'a'], ['./c', 'c']])
  const after = fpOf([['./a', 'A'], ['./c', 'c']])
  const ambientChanged = attrChanged(before, ambient)
  const runChanged = attrChanged(before, after)
  check(
    'FINGERPRINT_ATTRIBUTION',
    '反例：环境静止而本次运行改写了 ./a → 必须判为 CHANGED',
    runChanged.size === 1 && newPaths(runChanged, ambientChanged).length === 1,
  )
}

console.log()
console.log(`SUMMARY: ${pass} HIT / ${fail} MISS (total ${pass + fail})`)
console.log(
  'ASSERTION_CLASSES: FORCE_PI_POSITIVE, NEG_DEFAULT_UNCHANGED, NEG_BAD_VALUE_NO_FORCE, ' +
    'NEG_NO_ENGINE_NO_FORCE, NEG_ERROR_NOT_SWALLOWED, NEG_RESULT_PASSTHROUGH, FINGERPRINT_ATTRIBUTION',
)
console.log(`FORCE_ENGINE_TEST_RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
