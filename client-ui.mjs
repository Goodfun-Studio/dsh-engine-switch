/**
 * client-ui.mjs —— 「引擎 Chip」客户端 bundle 的确定性测试（不调模型、不开浏览器）
 *
 * 为什么不是「文本匹配 client.js」：boot 关键路径上真正会炸的是**执行**——
 * factory 抛异常 ⇒ 条目 import failed；inject 了不存在的服务 ⇒ 条目 pending。
 * 两者都会让整页停在 "Failed to load plugins"。所以本套件**真的把 client.js 跑起来**：
 *
 *   1. 装一个 `window.__ModuleLoader__` 桩，import client.js 捕获它注册的 factory；
 *   2. 用只给平台种子（react / react/jsx-runtime）的 require 调 factory，
 *      真的执行模块体，拿到 `{apply, inject, …}`；
 *   3. 用**最小 React 运行时**（hook 数组 + 微任务调度 + 元素树）真渲染
 *      `EngineChip` / `EnginePickerOverlay`，真的点、真的等异步读、真的断言界面文字；
 *   4. 用**替身 settings Remote** 断言写盘参数（ns / patch / revision）与拒绝路径。
 *
 * 覆盖四类断言：
 *   A 声明面：package.json 的 `dsh.client` + `exports["./client"]` 能被 host 的
 *     `resolveMeta()` 认出来（bundle 能不能被 serve 的前提）
 *   B 装载面：模块形状 / 只用平台种子 / 不 inject 可选服务 / 不碰 document / 两个插槽注册
 *   C 判定面：取值纪律与命名空间定位（负向防误杀：近似取值不落盘、邻居命名空间不误认）
 *   D 交互面：Chip 文案 → 点开浮层 → 选中 → 写盘参数 → 成功关闭 / 失败不关 / 读不到不崩
 *
 * 退出码：全部 HIT → 0；任一 MISS → 1。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(p).href)
const WS = __dirname

let pass = 0
let fail = 0
const check = (tag, name, cond) => {
  const ok = !!cond
  console.log(`[${ok ? 'HIT' : 'MISS'}] ${tag} :: ${name}`)
  ok ? pass++ : fail++
  return ok
}
const settle = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms))

// ===========================================================================
// 最小 React 运行时 —— 只实现 client.js 用到的那几个 hook，语义与真 React 对齐
// ===========================================================================
function createReact() {
  const runtime = { current: null, pending: [] }
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const hookAt = (kind, initial) => {
    const instance = runtime.current
    const index = instance.cursor++
    let hook = instance.hooks[index]
    if (hook === undefined) {
      hook = { kind, value: initial, deps: undefined, prevDeps: undefined, ran: false, cleanup: undefined }
      instance.hooks[index] = hook
    }
    if (hook.kind !== kind) throw new Error(`hook order changed at ${index}: ${hook.kind} → ${kind}`)
    return hook
  }

  const schedule = (root) => {
    if (root.scheduled === true) return
    root.scheduled = true
    queueMicrotask(() => {
      root.scheduled = false
      renderRoot(root)
    })
  }

  const react = {
    useState(initial) {
      const owner = runtime.current
      const hook = hookAt('state', typeof initial === 'function' ? initial() : initial)
      if (typeof hook.setter !== 'function') {
        hook.setter = (next) => {
          hook.value = typeof next === 'function' ? next(hook.value) : next
          // 调度到 hook 所属的那个 root：两个 root（chip / overlay）各自重渲染，互不顶替
          schedule(owner.root)
        }
      }
      return [hook.value, hook.setter]
    },
    useEffect(callback, deps) {
      const hook = hookAt('effect', undefined)
      hook.callback = callback
      const changed = deps === undefined ? true : hook.ran !== true || !sameDeps(hook.prevDeps ?? [], deps)
      hook.prevDeps = deps
      if (changed) runtime.pending.push(hook)
    },
    useCallback(callback, deps) {
      const hook = hookAt('callback', callback)
      if (hook.ran !== true || !sameDeps(hook.prevDeps ?? [], deps)) {
        hook.value = callback
        hook.prevDeps = deps
        hook.ran = true
      }
      return hook.value
    },
    useMemo(factory, deps) {
      const hook = hookAt('memo', undefined)
      if (hook.ran !== true || !sameDeps(hook.prevDeps ?? [], deps)) {
        hook.value = factory()
        hook.prevDeps = deps
        hook.ran = true
      }
      return hook.value
    },
    useRef(initial) {
      const hook = hookAt('ref', undefined)
      if (hook.ran !== true) {
        hook.value = { current: initial }
        hook.ran = true
      }
      return hook.value
    },
  }

  const sanitize = (props) => {
    const out = {}
    for (const [key, value] of Object.entries(props ?? {})) if (key !== 'children') out[key] = value
    return out
  }

  const childList = (children) => {
    if (Array.isArray(children)) return children.flat(Infinity).filter((item) => item !== null && item !== undefined && typeof item !== 'boolean')
    if (children === null || children === undefined || typeof children === 'boolean') return []
    return [children]
  }

  function materialize(element, root, parentInstance, path, lookup) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return { kind: 'text', text: String(element), props: {}, children: [], path }
    const props = element.props ?? {}
    if (typeof element.type === 'function') {
      let instance = parentInstance === null ? undefined : lookup.previous.get(path)
      if (instance === undefined || instance.type !== element.type) {
        instance = { type: element.type, props, key: element.key, hooks: [], cursor: 0, parent: parentInstance, children: new Map(), root }
      }
      instance.props = props
      if (parentInstance !== null) lookup.next.set(path, instance)
      return renderInstance(instance, root)
    }
    const host = { kind: 'host', type: element.type, props: sanitize(props), children: [], path }
    childList(props.children).forEach((child, index) => {
      const rendered = materialize(child, root, parentInstance, `${path}.${String(index)}`, lookup)
      if (rendered !== null) {
        rendered.parentHost = host
        host.children.push(rendered)
      }
    })
    return host
  }

  function renderInstance(instance, root) {
    const lookup = { previous: instance.children, next: new Map() }
    const outer = runtime.current
    runtime.current = instance
    instance.cursor = 0
    let output
    try {
      output = instance.type(instance.props)
    } finally {
      runtime.current = outer
    }
    const host = materialize(output, root, instance, '0', lookup)
    instance.children = lookup.next
    instance.hostNode = host
    return host
  }

  function flushEffects() {
    const pending = runtime.pending
    runtime.pending = []
    for (const hook of pending) {
      if (typeof hook.cleanup === 'function') {
        try {
          hook.cleanup()
        } catch {
          // 清理失败不影响后续断言
        }
        hook.cleanup = undefined
      }
      const result = hook.callback()
      hook.cleanup = typeof result === 'function' ? result : undefined
      hook.ran = true
    }
  }

  function renderRoot(root) {
    runtime.pending = []
    runtime.currentRoot = root
    root.hostNode = renderInstance(root.instance, root)
    flushEffects()
    return root.hostNode
  }

  const createRoot = (Component, props) => {
    const root = { scheduled: false, instance: null, hostNode: null, props }
    root.instance = { type: Component, props, key: 'root', hooks: [], cursor: 0, parent: null, children: new Map(), root }
    renderRoot(root)
    return root
  }

  const update = (root, props) => {
    root.instance.props = { ...root.props, ...props }
    root.props = root.instance.props
    return renderRoot(root)
  }

  const findAll = (node, predicate, acc = []) => {
    if (node === null || node === undefined) return acc
    if (predicate(node)) acc.push(node)
    for (const child of node.children ?? []) findAll(child, predicate, acc)
    return acc
  }
  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    let out = node.kind === 'text' ? node.text : ''
    for (const child of node.children ?? []) out += textOf(child)
    return out
  }
  const byAttr = (root, attr) => findAll(root.hostNode, (node) => node.kind === 'host' && node.props?.[attr] !== undefined)
  const click = (node, options = {}) => {
    const handler = node?.props?.onClick
    if (typeof handler !== 'function') throw new Error('node has no onClick handler')
    return handler(options.self === true ? { target: node, currentTarget: node } : { target: { inner: true }, currentTarget: node })
  }

  return { react, jsxRuntime: { jsx: (type, props, key) => ({ type, props: props ?? {}, key }), jsxs: (type, props, key) => ({ type, props: props ?? {}, key }) }, createRoot, update, findAll, byAttr, textOf, click }
}

// ===========================================================================
// 装载 client.js（装 window 桩 → 捕获注册 → factory(require) 真的跑起来）
// ===========================================================================
const registrations = []
const windowListeners = []
globalThis.window = {
  __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  addEventListener: (name, handler) => {
    windowListeners.push({ name, handler })
  },
  removeEventListener: () => {},
}

await imp(join(WS, 'client.js'))
const registration = registrations[0]
const pkg = JSON.parse(readFileSync(join(WS, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(WS, 'client.js'), 'utf8')
const hostPlugin = await imp(join(WS, 'index.js'))
const hostIntent = await imp(join(WS, 'engine-intent.mjs'))

const PLATFORM_SEEDS = new Set(['react', 'react/jsx-runtime'])
/**
 * 平台种子表只有一份 react —— 与真宿主一致：模块图里所有 bundle 共享同一个 React 实例。
 * 测试也必须这样：hook 运行时是单例，否则组件体的 hook 调用找不到当前渲染实例。
 */
const RT = createReact()
/** 造一个模块实例：每次调用 factory 都是一份新的闭包（store 也是新的）。 */
const makeModule = () => {
  const rt = RT
  const requireFn = (specifier) => {
    if (specifier === 'react') return rt.react
    if (specifier === 'react/jsx-runtime') return rt.jsxRuntime
    throw new Error(`client bundle requested a non-platform module: ${specifier}`)
  }
  return { module: registration.factory(requireFn), rt }
}

// ===========================================================================
// 替身宿主：settings Remote / slots / locale / effect
// ===========================================================================
function makeHost(options = {}) {
  const slots = { injected: [], registered: [] }
  const handlers = []
  const dictionaries = new Map()
  const effects = []
  const calls = { describe: 0, update: [] }
  const language = { current: options.lang ?? 'zh' }
  const settingsState = options.settings ?? null

  const settings = settingsState === null ? undefined : {
    describe: async () => {
      calls.describe += 1
      if (typeof settingsState.describe === 'function') return settingsState.describe()
      return settingsState.describe
    },
    update: async (ns, patch, revision) => {
      calls.update.push({ ns, patch, revision })
      if (typeof settingsState.update === 'function') return settingsState.update(ns, patch, revision)
      return settingsState.update
    },
  }

  const ctx = {
    slots: {
      inject: (target, callback) => {
        slots.injected.push(target)
        const disposer = callback()
        return () => {
          try {
            disposer?.()
          } catch {
            // 脏清理不该影响断言
          }
        }
      },
      register: (slotOptions, component) => {
        slots.registered.push({ target: slotOptions.name, options: slotOptions, component })
        return () => {}
      },
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts)
        return () => {}
      },
      bind: (ns) => (key) => {
        const table = (dictionaries.get(ns) ?? {})[language.current] ?? {}
        return key in table ? table[key] : key
      },
    },
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => {}
    },
    on: (name, handler) => {
      handlers.push({ name, handler })
      return () => {}
    },
    get: (name) => {
      if (name === 'remote.settings') return settings
      if (name === 'remote') return options.remote
      return undefined
    },
  }
  return { ctx, slots, calls, effects, handlers, language, settings }
}

// ===========================================================================
// A. 声明面：host 的 resolveMeta() 认不认这个 client bundle
// ===========================================================================
check('A_DECLARE', 'exports["./client"] 指向真实存在的 client.js（dsh-client-modules 的 resolveMeta 前提）', pkg.exports?.['./client'] === './client.js' && clientSource.length > 0)
check('A_DECLARE', 'dsh.client.platform === "web"', pkg.dsh?.client?.platform === 'web')
check(
  'A_DECLARE',
  'dsh.client.inject 只点名宿主真实存在且常驻的 client 包（renderer / conversation / locale）',
  Array.isArray(pkg.dsh?.client?.inject) &&
    pkg.dsh.client.inject.every((name) => [
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-locale',
    ].includes(name)),
)
check('A_DECLARE', 'dsh.client.external 缺席或为空（只用平台种子，不请求额外模块）', pkg.dsh?.client?.external === undefined || pkg.dsh.client.external.length === 0)
check('A_DECLARE', 'files 里带上 client.js（安装时会随包拷过去）', Array.isArray(pkg.files) && pkg.files.includes('client.js'))
check('A_DECLARE', 'bundle.patch 仍在（host 半边照旧是 loader 的一行）', pkg.dsh?.bundle?.patch === './cordis.patch.yml')

// ===========================================================================
// B. 装载面：模块形状 / 依赖纪律 / 插槽注册
// ===========================================================================
check('B_LOAD', 'client.js 只注册一个 factory，且 id 与本包名一致（模块图按包名认身份）', registrations.length === 1 && registration.id === pkg.name)
check('B_LOAD', 'factory 能直接执行并导出 {apply, inject}（不抛 = 不会 "import failed"）', typeof makeModule().module.apply === 'function' && Array.isArray(makeModule().module.inject))

const requireSpecs = [...clientSource.matchAll(/require\((["'])([^"']+)\1\)/g)].map((m) => m[2])
check(
  'B_LOAD',
  `模块只 require 平台种子（实测：${JSON.stringify([...new Set(requireSpecs)])}）`,
  requireSpecs.length > 0 && requireSpecs.every((spec) => PLATFORM_SEEDS.has(spec)),
)
check('B_LOAD', '不 require 任何 @deepseek-ai/* 客户端包（那会随宿主改版而炸）', requireSpecs.every((spec) => !spec.startsWith('@deepseek-ai/')))
check(
  'B_LOAD',
  'inject 恰为 ["slots","locale"]：不硬 inject remote.settings（缺席时本条目 pending 会拖垮整页 boot）',
  JSON.stringify(makeModule().module.inject) === JSON.stringify(['slots', 'locale']),
)
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const clientCode = stripComments(clientSource)
check(
  'B_LOAD',
  '不往宿主 DOM 里塞东西（代码里没有 document.body / appendChild / document.createElement）',
  !/document\.body/.test(clientCode) && !/\.appendChild\(/.test(clientCode) && !/document\.createElement/.test(clientCode),
)

const hostA = makeHost()
const moduleA = makeModule()
let applyThrew = null
try {
  moduleA.module.apply(hostA.ctx)
} catch (error) {
  applyThrew = error
}
check('B_LOAD', 'apply(fakeCtx) 不抛（异常会被渲染层兜住，但 boot 期抛会拖垮整页）', applyThrew === null)
check(
  'B_LOAD',
  '注册了两个插槽：hero.options / shell.overlay',
  JSON.stringify(hostA.slots.registered.map((row) => row.target)) ===
    JSON.stringify(['conversation.hero.options', 'shell.overlay']),
)
check(
  'B_LOAD',
  '不再往 conversation.input.dock 注入（否则新任务页会同时出现两枚「引擎」Chip —— 老板截图里的重复项）',
  !hostA.slots.injected.includes('conversation.input.dock') &&
    JSON.stringify(hostA.slots.injected) === JSON.stringify(['conversation.hero.options', 'shell.overlay']),
)
const heroReg = hostA.slots.registered[0]
const overlayReg = hostA.slots.registered[1]
check(
  'B_LOAD',
  'hero chip：order 30（紧挨 Agent 预设）、id 自带、locale 指向本插件字典',
  heroReg.options.order === 30 && heroReg.options.id === 'engine-hero' && heroReg.options.locale === moduleA.module.NS && heroReg.component === moduleA.module.EngineChip,
)
check(
  'B_LOAD',
  '浮层挂在 shell.overlay 上，且不是 Chip 组件',
  overlayReg.options.id === 'engine-picker' && overlayReg.component === moduleA.module.EnginePickerOverlay && overlayReg.options.order === 50,
)
check(
  'B_LOAD',
  'hero chip 的 inject() 真的给出 t（文案走 client locale，不硬编码在组件里），且只此一项（dock 变体已随重复 Chip 一起移除）',
  typeof heroReg.options.inject().t === 'function' && heroReg.options.inject().t('chipPrefix') === '引擎' &&
    JSON.stringify(Object.keys(heroReg.options.inject())) === JSON.stringify(['t']),
)
check(
  'B_LOAD',
  'apply 登记了 dictionary 与 selector bridge 两类 effect（有清理函数）',
  hostA.effects.length >= 2 && hostA.effects.every((row) => typeof row.disposer === 'function' || row.disposer === undefined),
)

{
  // 词典卫生：UI 文案是纯文本节点，markdown 星号与硬编码分隔符都会原样显示给用户。
  const dictionaryOf = (lang) => {
    const mod = makeModule().module
    const host = makeHost({ lang })
    mod.apply(host.ctx)
    return host.slots.registered[0].options.inject().t
  }
  const keys = ['chipPrefix', 'chipSeparator', 'chipTitle', 'chipLoading', 'chipUnavailable', 'pickerTitle', 'pickerHint', 'pickerEffective', 'pickerOrthogonal', 'pickerUnavailableHint', 'pickerFailed', 'engineNative', 'engineNativeHint', 'enginePi', 'enginePiHint', 'engineEcho', 'engineEchoHint']
  const zhDictionary = dictionaryOf('zh')
  const enDictionary = dictionaryOf('en')
  const values = keys.map((key) => [key, zhDictionary(key), enDictionary(key)])
  check(
    'C_VOCAB',
    `两种语言的词典都没有 markdown 星号（** 会原样显示给用户）且每条都真的翻译过（不是回落成 key）: ${values.length * 2} 条`,
    values.every(([, zhValue, enValue]) => typeof zhValue === 'string' && zhValue.length > 0 && !zhValue.includes('**') && zhValue !== undefined
      && typeof enValue === 'string' && enValue.length > 0 && !enValue.includes('**')),
  )
  check('C_VOCAB', '两种语言各有一条真文案（抽查）', zhDictionary('enginePi') === 'Pi 引擎' && enDictionary('enginePi') === 'Pi engine')
  check('C_VOCAB', '分隔符走字典（zh 全角冒号 / en ": "），组件里不硬编码语言相关标点', zhDictionary('chipSeparator') === '：' && enDictionary('chipSeparator') === ': ')
}

// ===========================================================================
// C. 判定面：取值纪律 + 命名空间定位（负向防误杀）
// ===========================================================================
const C = makeModule().module
check('C_VOCAB', '客户端 ENGINE_IDS 与 host 侧 engine-intent 逐字同源', JSON.stringify(C.ENGINE_IDS) === JSON.stringify(hostIntent.ENGINE_IDS))
check('C_VOCAB', 'SETTINGS_NS 与 host 的 DEFAULT_ENTRY_ID 同值（两边写的是同一个值）', C.SETTINGS_NS === hostPlugin.DEFAULT_ENTRY_ID)
check('C_VOCAB', 'NATIVE_ENGINE_ID 与 host 同值', C.NATIVE_ENGINE_ID === hostIntent.NATIVE_ENGINE_ID)
check('C_VOCAB', '精确取值全部通过', ['native', 'pi', 'echo'].every((id) => C.normalizeEngineId(id) === id))
const approx = ['PI', 'Pi', 'pi ', ' pi', 'pi-lite', 'native2', 'echo2', 'auto', '', ' ', null, undefined, 0, 1, true, false, {}, [], Symbol.for('pi')]
check('C_VOCAB', `近似/非字符串取值一律 null（${approx.length} 例）`, approx.every((value) => C.normalizeEngineId(value) === null))

const nsRow = (engine, revision = 7, ns = C.SETTINGS_NS) => ({ ns, revision, value: { engine }, writable: true })
check('C_LOCATE', '按名字命中（常态路径，source=id）', (() => { const hit = C.locateSettingsNamespace({ namespaces: [nsRow('pi')] }); return hit?.source === 'id' && hit.row.ns === C.SETTINGS_NS })())
check(
  'C_LOCATE',
  '邻居命名空间排在前也不被带偏（选中自己的那一个，不是第一个）',
  (() => {
    const hit = C.locateSettingsNamespace({ namespaces: [{ ns: 'ui-chat', revision: 1, value: { transcriptView: 'standard' } }, nsRow('echo', 3)] })
    return hit?.row.ns === C.SETTINGS_NS && C.normalizeEngineId(hit.row.value.engine) === 'echo'
  })(),
)
check(
  'C_LOCATE',
  '按形状兜底：entry id 被 fork 改名（命名空间名变了）时仍按「engine ∈ 三个精确取值」认出',
  (() => {
    const hit = C.locateSettingsNamespace({ namespaces: [{ ns: 'some-fork-name', revision: 2, value: { engine: 'pi' } }] })
    return hit?.source === 'shape' && hit.row.ns === 'some-fork-name'
  })(),
)
check(
  'C_LOCATE',
  '负向：邻居里恰好叫 engine 但取值不是三个精确之一（{engine:"v8"}）不被误认',
  C.locateSettingsNamespace({ namespaces: [{ ns: 'other-plugin', revision: 1, value: { engine: 'v8' } }] }) === null,
)
check('C_LOCATE', '没有本命名空间 ⇒ null（交给上层报 namespace-unavailable）', C.locateSettingsNamespace({ namespaces: [{ ns: 'ui-chat', revision: 1, value: {} }] }) === null)
check('C_LOCATE', 'descriptor 形状不对（缺 namespaces）也不抛', C.locateSettingsNamespace({}) === null && C.locateSettingsNamespace(undefined) === null)

const hostNoSettings = makeHost({ settings: null })
const noSettings = await C.readEngineSelector(hostNoSettings.ctx)
check('C_READ', 'settings 服务缺席 ⇒ settings-unavailable（不抛、不猜）', noSettings.ok === false && noSettings.error === 'settings-unavailable')

const hostThrowing = makeHost({
  settings: {
    describe: () => {
      throw new Error('boom')
    },
    update: () => ({ ok: true, value: nsRow('pi') }),
  },
})
const readThrow = await C.readEngineSelector(hostThrowing.ctx)
check('C_READ', 'describe() 抛错 ⇒ read-failed 且带上原因', readThrow.ok === false && readThrow.error === 'read-failed' && String(readThrow.detail).includes('boom'))

const hostOk = makeHost({ settings: { describe: { ok: true, value: { writable: true, hasDocument: true, namespaces: [nsRow('pi', 7)] } }, update: { ok: true, value: nsRow('pi', 8) } } })
const readOk = await C.readEngineSelector(hostOk.ctx)
check(
  'C_READ',
  '正常读取：engine / ns / revision / writable 逐项带出（revision 供乐观锁）',
  readOk.ok === true && readOk.value.engine === 'pi' && readOk.value.ns === C.SETTINGS_NS && readOk.value.revision === 7 && readOk.value.writable === true && readOk.value.source === 'id',
)

const hostBadValue = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('v8wrong')] } }, update: { ok: true, value: nsRow('v8wrong') } } })
const readBad = await C.readEngineSelector(hostBadValue.ctx)
check('C_READ', '命名空间在、但 engine 取值不合法 ⇒ engine=null（不猜一个值冒充当前选择）', readBad.ok === true && readBad.value.engine === null)

const hostWrite = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 7)] } }, update: { ok: true, value: nsRow('pi', 8) } } })
const wrote = await C.writeEngineSelector(hostWrite.ctx, 'pi', { ns: C.SETTINGS_NS, revision: 7 })
check(
  'C_WRITE',
  '写盘参数：ns + patch {engine} + 读到的 revision（乐观锁）逐项正确',
  wrote.ok === true && hostWrite.calls.update.length === 1 && hostWrite.calls.update[0].ns === C.SETTINGS_NS && hostWrite.calls.update[0].patch.engine === 'pi' && hostWrite.calls.update[0].revision === 7,
)
check('C_WRITE', '写成功时用 host 返回的视图回填 engine/revision', wrote.value.engine === 'pi' && wrote.value.revision === 8)

const hostApprox = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 7)] } }, update: { ok: true, value: nsRow('pi', 8) } } })
const wroteApprox = await C.writeEngineSelector(hostApprox.ctx, 'PI', { ns: C.SETTINGS_NS, revision: 7 })
check('C_WRITE', '近似取值在客户端就挡下（unknown-engine）且**没有**落到 host（负向防误杀）', wroteApprox.ok === false && wroteApprox.error === 'unknown-engine' && hostApprox.calls.update.length === 0)

const hostConflict = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 7)] } }, update: { ok: false, error: { code: 'settings/conflict', message: 'stale revision' } } } })
const wroteConflict = await C.writeEngineSelector(hostConflict.ctx, 'native', { ns: C.SETTINGS_NS, revision: 6 })
check('C_WRITE', 'host 拒绝（revision 陈旧）⇒ settings/conflict 原样带出，不静默吞', wroteConflict.ok === false && wroteConflict.error === 'settings/conflict' && String(wroteConflict.detail).includes('stale'))

const hostFork = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [{ ns: 'some-fork-name', revision: 3, value: { engine: 'native' } }] } }, update: { ok: true, value: { ns: 'some-fork-name', revision: 4, value: { engine: 'echo' } } } } })
const forkRead = await C.readEngineSelector(hostFork.ctx)
const forkWrite = await C.writeEngineSelector(hostFork.ctx, 'echo', { ns: forkRead.value.ns, revision: forkRead.value.revision })
check('C_WRITE', '被 fork 改名的命名空间：读到的 ns 原样用于写（不写回硬编码的 engine-switch）', forkWrite.ok === true && hostFork.calls.update[0].ns === 'some-fork-name')

// ===========================================================================
// D. store 状态机：Chip 与浮层共用一份真话（同一份 selector store）
// ===========================================================================
const storeHost = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 7)] } }, update: { ok: true, value: nsRow('pi', 8) } } })
const storeMod = makeModule()
const store = storeMod.module.createSelectorStore()
store.attachBridge({
  read: () => storeMod.module.readEngineSelector(storeHost.ctx),
  write: (engine, target) => storeMod.module.writeEngineSelector(storeHost.ctx, engine, target),
})
const seen = []
store.subscribe((snapshot) => seen.push(snapshot.engine))
await store.ensure()
await store.ensure()
check('D_STORE', 'ensure() 首次读一次、再次 ensure 不重复读（同一份 store 不会各打一次 describe）', storeHost.calls.describe === 1)
check('D_STORE', '读成功后快照是 ready + 当前值', store.get().status === 'ready' && store.get().engine === 'native' && store.get().revision === 7)
const selectOk = await store.select('pi')
check(
  'D_STORE',
  'select() 走写盘：patch.engine=pi、revision=读到的 7，成功后快照换值并广播',
  selectOk.ok === true && storeHost.calls.update[0].patch.engine === 'pi' && storeHost.calls.update[0].revision === 7 && store.get().engine === 'pi' && seen.includes('pi'),
)
const selectApprox = await store.select('PI')
check('D_STORE', 'select(近似值) 当场拒掉、不写盘', selectApprox.ok === false && selectApprox.error === 'unknown-engine' && storeHost.calls.update.length === 1)

const busyHost = makeHost({
  settings: {
    describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 3)] } },
    update: async () => {
      await settle(6)
      return { ok: true, value: nsRow('pi', 4) }
    },
  },
})
const busyStore = makeModule().module.createSelectorStore()
busyStore.attachBridge({ read: () => makeModule().module.readEngineSelector(busyHost.ctx), write: (engine, target) => C.writeEngineSelector(busyHost.ctx, engine, target) })
await busyStore.load()
const first = busyStore.select('pi')
const second = busyStore.select('echo')
const [firstResult, secondResult] = await Promise.all([first, second])
check(
  'D_STORE',
  '写盘进行中重复点击被忽略（busy）⇒ 只落一次盘（双击不会写两次、也不会把后一次覆盖前一次）',
  firstResult.ok === true && secondResult.ok === false && secondResult.error === 'busy' && busyHost.calls.update.length === 1,
)

const failHost = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 5)] } }, update: { ok: false, error: { code: 'settings/rejected', message: 'composition refuses' } } } })
const failStore = makeModule().module.createSelectorStore()
failStore.attachBridge({ read: () => C.readEngineSelector(failHost.ctx), write: (engine, target) => C.writeEngineSelector(failHost.ctx, engine, target) })
await failStore.load()
const failed = await failStore.select('pi')
check(
  'D_STORE',
  '写失败：busy 复位、engine 保持原值（不假装成功）、错误可读',
  failed.ok === false && failStore.get().busy === false && failStore.get().engine === 'native' && failStore.get().error === 'settings/rejected' && String(failStore.get().detail).includes('composition refuses'),
)

const driftHost = makeHost({ settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [nsRow(driftHost.calls.describe === 1 ? 'native' : 'echo', 9)] } }), update: { ok: true, value: nsRow('echo', 10) } } })
const driftStore = makeModule().module.createSelectorStore()
driftStore.attachBridge({ read: () => C.readEngineSelector(driftHost.ctx), write: (engine, target) => C.writeEngineSelector(driftHost.ctx, engine, target) })
await driftStore.load()
check('D_STORE', '首次读到 native', driftStore.get().engine === 'native')
await driftStore.load()
check('D_STORE', '外部改值（设置页 / `/engine`）后重读 ⇒ 快照跟着变（不会挂着两份真话）', driftStore.get().engine === 'echo' && driftStore.get().revision === 9)

const unavailableStore = makeModule().module.createSelectorStore()
unavailableStore.attachBridge({ read: () => Promise.resolve({ ok: false, error: 'settings-unavailable' }), write: () => Promise.resolve({ ok: false, error: 'settings-unavailable' }) })
await unavailableStore.ensure()
check('D_STORE', '读不到 settings ⇒ status=unavailable + 可读的 error（界面据此显示「不可用」）', unavailableStore.get().status === 'unavailable' && unavailableStore.get().error === 'settings-unavailable')

// ===========================================================================
// E. 交互面：真的渲染、真的点、真的断言界面文字
// ===========================================================================
const jsxRuntime = RT

async function renderChipAndOverlay(options = {}) {
  const mod = makeModule().module
  const host = makeHost({ settings: options.settings ?? null, remote: options.remote, lang: options.lang })
  mod.apply(host.ctx)
  const chipEntry = host.slots.registered.find((row) => row.options?.id === 'engine-hero')
  const overlayEntry = host.slots.registered.find((row) => row.options?.id === 'engine-picker')
  const props = { ...chipEntry.options.inject(), sessionId: 'session-under-test' }
  const rt = RT
  const chipRoot = rt.createRoot(chipEntry.component, props)
  const firstFrame = rt.textOf(chipRoot.hostNode)
  await settle()
  const overlayRoot = rt.createRoot(overlayEntry.component, { ...overlayEntry.options.inject() })
  await settle()
  const rerenderOverlay = async () => {
    rt.update(overlayRoot, {})
    await settle()
  }
  return { mod, host, rt, chipRoot, overlayRoot, props, firstFrame, rerenderOverlay }
}

{
  const okSettings = { describe: { ok: true, value: { writable: true, namespaces: [nsRow('pi', 7)] } }, update: { ok: true, value: nsRow('native', 8) } }
  const scene = await renderChipAndOverlay({ settings: okSettings })

  check('E_UI', `Chip 首帧先如实显示读取中（实测："${scene.firstFrame}"）`, scene.firstFrame.includes('读取中'))
  const chipText = jsxRuntime.textOf(scene.chipRoot.hostNode)
  check('E_UI', `异步读完后 Chip 是「⚡ 引擎：Pi 引擎 ▾」（实测："${chipText}"）`, chipText.includes('⚡') && chipText.includes('引擎') && chipText.includes('Pi 引擎') && chipText.includes('▾'))
  const chipNode = jsxRuntime.byAttr(scene.chipRoot, 'data-dsh-engine')[0]
  check('E_UI', 'Chip 带 data-dsh-engine="pi" / data-dsh-engine-state="ready"（机器可断言的选择器）', chipNode?.props?.['data-dsh-engine'] === 'pi' && chipNode?.props?.['data-dsh-engine-state'] === 'ready')
  const chipWrapper = scene.chipRoot.hostNode
  check(
    'E_UI',
    'Chip 外壳是 inline（宽度由内容决定），且没有 width:100%（否则会把预设 chip 挤开）',
    chipWrapper?.props?.style?.width === undefined && chipWrapper?.props?.style?.display === 'inline-flex',
  )
  check('E_UI', '浮层未点开时不渲染任何东西（不占屏、不抢焦点）', scene.overlayRoot.hostNode === null)
  const describesBeforeOpen = scene.host.calls.describe
  jsxRuntime.click(chipNode)
  await settle()
  check(
    'E_UI',
    '点开面板会现读一次（describe +1）：瞬时读失败不会被钉死在「不可用」，也保证「当前」徽标是最新的',
    scene.host.calls.describe === describesBeforeOpen + 1,
  )

  jsxRuntime.click(chipNode)
  await scene.rerenderOverlay()
  const overlayNode = jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-picker')[0]
  const dialogNodes = jsxRuntime.findAll(scene.overlayRoot.hostNode, (node) => node.kind === 'host' && node.props?.role === 'dialog')
  check(
    'E_UI',
    '点 Chip ⇒ 浮层打开（shell.overlay 里的背景层 + role=dialog 面板）',
    overlayNode !== undefined && overlayNode.props['data-dsh-engine-picker'] === 'open' && dialogNodes.length === 1,
  )
  const optionNodes = jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-option')
  check('E_UI', `浮层列出三个引擎选项（实测：${optionNodes.length} 个）`, optionNodes.length === 3 && optionNodes.map((node) => node.props['data-dsh-engine-option']).join(',') === 'native,pi,echo')
  const overlayText = jsxRuntime.textOf(scene.overlayRoot.hostNode)
  check('E_UI', '当前值在浮层里被标出来（「当前」徽标挂在 pi 那一条）', jsxRuntime.textOf(optionNodes[1]).includes('当前') && !jsxRuntime.textOf(optionNodes[0]).includes('当前'))
  check(
    'E_UI',
    '语义边界如实写在面板上：对之后新建的任务生效 / 预设不受影响',
    overlayText.includes('之后新建的任务') && overlayText.includes('预设') && overlayText.includes('/engine'),
  )

  const nativeOption = optionNodes[0]
  jsxRuntime.click(nativeOption)
  await settle()
  await scene.rerenderOverlay()
  check(
    'E_UI',
    '点「原生引擎」⇒ 写盘 update(ns, {engine:"native"}, revision=7)',
    scene.host.calls.update.length === 1 && scene.host.calls.update[0].ns === 'engine-switch' && scene.host.calls.update[0].patch.engine === 'native' && scene.host.calls.update[0].revision === 7,
  )
  check('E_UI', '写成功后浮层自动关闭', scene.overlayRoot.hostNode === null)
  check('E_UI', `写成功后 Chip 立刻显示新值（实测："${jsxRuntime.textOf(scene.chipRoot.hostNode)}"）`, jsxRuntime.textOf(scene.chipRoot.hostNode).includes('原生引擎'))
}

{
  // 写失败：面板不关，宿主拒绝原因留在眼前
  const conflictSettings = { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 6)] } }, update: { ok: false, error: { code: 'settings/conflict', message: 'stale revision' } } }
  const scene = await renderChipAndOverlay({ settings: conflictSettings })
  jsxRuntime.click(jsxRuntime.byAttr(scene.chipRoot, 'data-dsh-engine')[0])
  await scene.rerenderOverlay()
  const optionNodes = jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-option')
  jsxRuntime.click(optionNodes[1])
  await settle()
  await scene.rerenderOverlay()
  const overlayText = jsxRuntime.textOf(scene.overlayRoot.hostNode)
  check('E_UI', '写失败（settings/conflict）⇒ 浮层不关、把原因显示出来', scene.overlayRoot.hostNode !== null && overlayText.includes('写入失败') && overlayText.includes('settings/conflict'))
  check('E_UI', '写失败后 Chip 仍显示真实值 native（不乐观改成 pi）', jsxRuntime.textOf(scene.chipRoot.hostNode).includes('原生引擎'))
  check('E_UI', '写失败只落了一次请求（失败不回滚重试、不偷偷改写 revision 再试）', scene.host.calls.update.length === 1)
}

{
  // 读不到 settings：Chip 显示不可用、面板给诊断、绝不写盘
  const scene = await renderChipAndOverlay({ settings: null })
  const chipText = jsxRuntime.textOf(scene.chipRoot.hostNode)
  check('E_UI', `读不到 settings ⇒ Chip 显示「不可用」并保留定位信息（实测："${chipText}"）`, chipText.includes('引擎') && chipText.includes('不可用'))
  const chipNode = jsxRuntime.byAttr(scene.chipRoot, 'data-dsh-engine')[0]
  check('E_UI', '不可用态带 data-dsh-engine-state="unavailable"', chipNode?.props?.['data-dsh-engine-state'] === 'unavailable')
  jsxRuntime.click(chipNode)
  await scene.rerenderOverlay()
  const diagnostic = jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-diagnostic')[0]
  check('E_UI', '点开面板有诊断块（data-dsh-engine-diagnostic=settings-unavailable）与设置页指引', diagnostic !== undefined && diagnostic.props['data-dsh-engine-diagnostic'] === 'settings-unavailable' && jsxRuntime.textOf(scene.overlayRoot.hostNode).includes('设置'))
  const optionNodes = jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-option')
  check('E_UI', '不可用态下三个选项都是 disabled（点不动，不会发出注定失败的写）', optionNodes.length === 3 && optionNodes.every((node) => node.props.disabled === true))
  check('E_UI', '全程零写请求', scene.host.calls.update.length === 0)
}

{
  // 关panel：点背景关、Esc 关
  const scene = await renderChipAndOverlay({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('pi', 7)] } }, update: { ok: true, value: nsRow('native', 8) } } })
  jsxRuntime.click(jsxRuntime.byAttr(scene.chipRoot, 'data-dsh-engine')[0])
  await scene.rerenderOverlay()
  const backdrop = jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-picker')[0]
  jsxRuntime.click(backdrop, { self: true })
  await scene.rerenderOverlay()
  check('E_UI', '点浮层背景空白处关闭（点面板内部不关）', scene.overlayRoot.hostNode === null)

  jsxRuntime.click(jsxRuntime.byAttr(scene.chipRoot, 'data-dsh-engine')[0])
  await scene.rerenderOverlay()
  check('E_UI', '重新打开面板后没有陈旧错误残留', jsxRuntime.byAttr(scene.overlayRoot, 'data-dsh-engine-error').length === 0)
  const keydown = windowListeners.filter((row) => row.name === 'keydown').pop()
  check('E_UI', '面板打开时挂上 Esc 监听（起点是 window，不是 document.body）', keydown !== undefined)
  keydown?.handler({ key: 'Escape' })
  await scene.rerenderOverlay()
  check('E_UI', 'Esc 关闭浮层', scene.overlayRoot.hostNode === null)
}

{
  // 英文界面：文案来自 client locale 字典，不是硬编码中文
  const scene = await renderChipAndOverlay({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('echo', 2)] } }, update: { ok: true, value: nsRow('native', 3) } }, lang: 'en' })
  const chipText = jsxRuntime.textOf(scene.chipRoot.hostNode)
  check(
    'E_UI',
    `切 en 后 Chip 文案跟着走（实测："${chipText}"），且分隔符是 ": " 不是全角冒号`,
    chipText.includes('Engine: ') && chipText.includes('Echo engine') && !chipText.includes('：'),
  )
}

{
  // 外部改值 → chip 跟着刷新（不靠重载页面）
  const host = makeHost({
    settings: {
      describe: async () => ({ ok: true, value: { writable: true, namespaces: [nsRow(host.calls.describe === 1 ? 'native' : 'pi', 4)] } }),
      update: { ok: true, value: nsRow('pi', 5) },
    },
  })
  const mod = makeModule().module
  mod.apply(host.ctx)
  const rt = RT
  const chipEntry = host.slots.registered.find((row) => row.options?.id === 'engine-hero')
  const root = rt.createRoot(chipEntry.component, { ...chipEntry.options.inject() })
  await settle()
  check('E_UI', '首帧读到 native', jsxRuntime.textOf(root.hostNode).includes('原生引擎'))
  await mod.selectorStore.load()
  rt.update(root, {})
  await settle()
  check('E_UI', '外部（设置页 / `/engine`）改值后重读 ⇒ Chip 变 Pi 引擎', jsxRuntime.textOf(root.hostNode).includes('Pi 引擎'))
  const refreshHandler = host.handlers.find((row) => row.name === 'connection/reset')
  check('E_UI', 'apply 订阅了 connection/reset（连接重建后不留下陈旧快照）', refreshHandler !== undefined)
}

{
  // 一枚 Chip 就够：注册表里不存在第二处挂载点（真机上两枚「引擎」的直接原因）
  const mod = makeModule().module
  const host = makeHost({ settings: { describe: { ok: true, value: { writable: true, namespaces: [nsRow('native', 1)] } }, update: { ok: true, value: nsRow('native', 2) } } })
  mod.apply(host.ctx)
  const chipEntries = host.slots.registered.filter((row) => row.component === mod.EngineChip)
  check(
    'E_UI',
    '整页只注册一枚引擎 Chip（hero 那一处），注册表里没有 engine-dock 第二处挂载点',
    chipEntries.length === 1 && chipEntries[0].options.id === 'engine-hero' && host.slots.registered.every((row) => row.options?.id !== 'engine-dock'),
  )
}

console.log(`\nSUMMARY: ${pass} HIT / ${fail} MISS`)
console.log('ASSERTION_CLASSES: A_DECLARE, B_LOAD, C_VOCAB, C_LOCATE, C_READ, C_WRITE, D_STORE, E_UI')
console.log(fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(fail === 0 ? 0 : 1)
