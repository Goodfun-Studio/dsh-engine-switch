# DSH 引擎切换插件

这是一个 DeepSeek Harness (DSH) 插件，用于在 DSH agent 契约之上挂载不同的 LLM 引擎实现。当前通过 **OAR (Orchestrator-Adapter-Runtime)** 架构驱动引擎层，实现对 Pi 的完整接管与驱动。

## 架构示意

```
DSH 原生 agent 契约
        ↓
   本插件接管
        ↓
  OAR session API
   ↙        ↘
Pi 引擎    （预留其他引擎）
```

- **Orchestrator**：管理会话生命周期、路由决策、状态跟踪
- **Adapter**：负责 DSH ↔ OAR 的双向转换（输入/输出/错误/abort/steer 等）
- **Runtime**：引擎实际执行层（当前仅实现 Pi）

模块划分：

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：接管 `ctx.agents.factory`、路由器接线、事件桥、证据落盘 |
| `engine-intent.mjs` | 引擎意图判定（forceEngine / marker / 会话绑定 / preset 兼容 / 选择器 / 默认） |
| `engine-command.mjs` | `/engine` 命令的语法与文案 |
| `oar-engine.mjs` | OAR 适配器：真起 pi 子进程、把文本映射成 DSH 流式帧（模型/思考等级由选区解析后透传） |
| `pi-models.mjs` | **模型面**：Pi 模型目录（OAR/`models.json`）→ DSH `ctx.llm` provider；DSH 选区 → pi 选择子 |
| `pi-session.mjs` | **pi 会话/Agent 生命周期宿主**：建会话（落盘）→ 注册 Agent → 首轮 durable turn（见下节） |
| `client.js` | 桌面端「⚡ 引擎」Chip 的客户端半边 |

### pi 会话/Agent 在 DSH 里长什么样（L7）

光把 pi 的文本"塞回去"不够：桌面端（HTTP/Web RPC 面）的会话身份、持久化、Agent 注册、
流式帧路由都是**上游硬契约**，任何一条不满足都会在建会话时炸。`pi-session.mjs` 就是
把「pi 会话在 DSH 里的一等公民化」收敛成一处，顺序逐字照抄上游 `AgentLoop` 的创建事务：

```
create:                       resume（桌面端重启后打开旧会话）:
  sessions.prepare(meta.cwd/agentPreset)   sessionPersistence.open(id,'write') → read(0)
  sessionPersistence.create(header)        sessions.prepare(seed=磁盘事件, meta=存量 header)
  sessions.enter + announce                （补写 fromRestore 追加的 session/end-seed，
  agents.enter + announce（替身身份=会话 id）  对齐持久化游标）
  首轮：turn/start → user/message →         sessions.enter + announce
        step/start → assistant/message       agents.enter + announce
        （含 settlement 字段 turn/step/stream）
        → step/end → turn/end → flush
```

关键不变量（改这两处前先读 `session-lifecycle.mjs` 的断言）：

1. **`agent.id` 必须等于真实会话 id**（`session-<uuid>`）——
   上游 `sessionController.create()` 逐字取 `agent.id` 当会话身份，
   `AgentRegistry.enter()` 也硬校验 `agent.id === agent.session.id`；
2. **会话必须有 cwd 元数据且真的落盘** —— `workspace.attachSession()` /
   `readState` 校验的就是 header 里的 cwd，冷读走持久化；
3. **Agent 必须注册进 `ctx.agents`** —— `session/prompt` 的准入检查是
   `ctx.agents.get(agent.id) !== agent → session/not-found`；
4. **流式帧挂在 `agent.session.id` 下** —— 前端 assistant stream 按会话 id 订阅；
5. **durable `assistant/message` 必须带 settlement 字段**（`turn` / `step` / `stream`）——
   缺了存盘日志会在冷读时被判 `corrupt: invalid settlement fields`，重启后打不开。

历史现场（L7 修的就是它）：改造前替身 id 是 `engine-switch:oar-pi:<sessionId>`，
于是桌面端点「新建会话」直接报
`session/workspace-attach-failed: session persistence holds no such session`。

## 安装

使用 DSH 插件管理器安装：

```bash
plugin_manager install_bundle
```

在安装路径输入时，提供本插件的**绝对目录路径**（如 `/path/to/dsh-engine-switch`）。

## 依赖约定（决定能不能在别的机器上装）

| 包 | 声明 | 谁来提供 |
| --- | --- | --- |
| `@deepseek-ai/*`（schemastery、cordis、dsh-agent、dsh-llm、dsh-session、dsh-agent-loop、dsh-scope） | `peerDependencies` | 宿主 DSH profile（profile 的 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，不随插件安装） |
| `@botiverse/oar` | `dependencies`（`^0.95.0`） | 插件自身，正常安装 |

`@deepseek-ai/*` 的版本区间统一是：

```
>=0.2.0-0 || >=0.2.1-0 || >=0.2.2-0
```

- **绝不**把 `@deepseek-ai/*` 写回 `file:<本机绝对路径>`：那会把插件绑死在作者本机的 DSH 源码抽取树上，
  别的机器 `install_bundle` 必然失败（本仓库首个 commit 的「已知问题」讲的就是这件事）。
- 区间里的 `||` 链是 semver 的 prerelease 写法，不是啰嗦：单个 `>=0.2.0-0` 按 npm semver 规则
  **不匹配** 0.2.2-rc.1（prerelease 版本只有 major.minor.patch 完全相同的 comparator 才放行），
  换成 `*` 则会去 registry 取 `latest`（= 0.1.0-rc.6 旧版宿主）。`||` 链与官方 `dsh-context` 同款：
  放行 0.2.0/0.2.1/0.2.2 的 prerelease 与之后全部稳定版，不放过 0.1.x。
- 本仓库 `node_modules/@deepseek-ai/*` 是指向 `.recon/dsh-src` 的开发期软链（本地态，不入库）。
  在仓库根跑 `npm install` 会把这几条本机软链写进 `package-lock.json`，把机器相关路径又带回来；
  `package-lock.json` 只应在**干净环境**（无本地软链）用 `npm install --package-lock-only` 重算，
  或直接 `npm ci` 按 lock 从 registry 装（该 lock 已与宿主同版本：0.2.2-rc.1 / cordis 4.1.0 / schemastery 3.19.0）。

## 如何选引擎（Engine ⊥ Preset）

**先分清两个正交维度**（混在一起就是上一轮的坑）：

| 维度 | 决定什么 | 在哪选 |
| --- | --- | --- |
| **Agent Preset**（业务预设） | 系统提示词模板 / 角色 / 工具插件集 | 新建任务页的预设 chip（原生四种：标准 / PTC / 极简 / 创造） |
| **Engine**（底座引擎） | 底座由谁驱动：DSH 原生 AgentLoop / OAR 驱动的 pi / 回声 | 新会话起始页上的「⚡ 引擎」下拉 Chip、`/engine` 命令、插件设置字段 `engine`、或请求 marker |

所以「Pi 引擎」**不在**预设下拉框里（`cordis.patch.yml` 里不再声明任何 preset）。
引擎走自己的入口，四个都可用：

1. **新会话起始页上的「⚡ 引擎」下拉 Chip**（L6 新增，L9 收敛为单枚，推荐）：
   - 位置：**新会话起始页**那一行右侧，与「工作目录」chip / 预设 chip 同排（`conversation.hero.options`）；
   - 早先它还在**输入框卡片上方**的通栏区（`conversation.input.dock`）挂过第二枚，真机上同一张新任务页会同时
     出现两枚「引擎：Pi 引擎」（与预设同排的那枚 + 输入框正上方孤立浮动的那枚），L9 已按老板截图把那条注册移除 ——
     现在 Chip **只此一处**；
   - 点开是屏幕正中的选择面板（挂在 `shell.overlay`），三个选项带一句话说明，当前值带「当前」徽标；
   - 它写的就是下面第 3 条的 `engine` 字段（走 DSH 通用的 `ctx.remote.settings.update`，带 revision 乐观锁），
     所以与 `/engine pi` / 设置页改的是**同一个值**；写成功后 Chip 立刻显示新值，
     外面（设置页 / `/engine`）改值时 Chip 也跟着刷新。
2. **斜杠命令**（输入区域）：
   ```
   /engine            # 看当前选择器值 / 本会话引擎 / 可选值
   /engine pi         # 切到 Pi 引擎
   /engine native     # 切回原生
   /engine echo       # 回声替身（只回显固定文本，不起模型；联调用）
   ```
3. **插件设置字段**：`engine` 是 volatile 字段，设置面（设置页 / 插件页）里可以改，改完**即时生效**并写回 profile patch。
4. **请求级 marker**（headless / ACP / 脚本按次钉死）：`options.meta.engine` 或 `options.engine`，取值 `native` / `pi` / `echo`。

**判定优先级**（高 → 低，逐条可测，见 `engine-selector.mjs`）：

```
forceEngine > 请求 marker > 会话已绑定引擎 > agentPreset 兼容命中 > config.engine > 原生 target
```

- `forceEngine`：运维/测试硬开关（`cordis.patch.yml` 的 `config.forceEngine`），命中已知引擎时忽略其余判据。
- **请求 marker**：一次 create/resume 自带的意图，压过一切非强制来源。
- **会话已绑定引擎**：某会话第一次落在哪个引擎就记住它（进程内），之后同一会话的 resume 跟随它 ——
  会话身份 ≥ 全局缺省，和 DSH 自己的「会话记下的模型压过默认模型」同款。
- **agentPreset 兼容命中**：`options.meta.agentPreset === config.piPreset`（缺省 `'pi'`）→ pi 引擎。
  这是**给存量会话留的兼容判据**（改造前已建、header 里记着 `agentPreset: pi` 的会话），不是引擎的定义，也不再向 UI 暴露任何 pi preset。
- **`config.engine`**：独立选择器的值（`/engine` 与设置页改的就是它）。
- 全部不命中 → 原样委托原生 target。

**负向防误杀**：任何来源里引擎取值不作数时（`'PI'` / `'pi '` / `'pi-lite'` / `'auto'` / 空串 / null /
非字符串）该来源直接跳过；`agentPreset` 缺失或为别的值（如 `'standard'`）时兼容命中为 false。

**语义边界（如实说明）**：DSH 在「新建任务」那一刻就把 Agent 建好了（preset 之所以能改，是因为它有一等公民的
`agentPresets/select` remote 做活体换装，第三方插件没有这个口子），所以引擎选择器的语义是
**「接下来的任务用哪个引擎」**，不是「当前任务换个引擎」。当前会话在它下次被 DSH 重新载入时跟随新选择。
上面四种入口写的是**同一个权威值**，因此这条边界对四者一视同仁（不能期待点完 Chip 当前会话当场换引擎）。

**还没到「按会话点选」**（诚实边界）：现在能点的是**全局选择器**（= 下一个任务用什么引擎），
不是「这一条会话换引擎」；后者做不到的原因同上（建 Agent 时才能定引擎，且
`SessionCreateRequest` 没有给第三方留扩展位）。

## 模型面（L8：模型选择器跟着引擎走）

引擎决定「底座谁在驱动」，模型决定「底座用哪个模型出话」——两者都要落到真处。L8 之前模型面是断的：
`oar-engine.mjs` 里 provider/model **写死**成 `magpie/auto/deepseek-v4.1-flash`，UI 里选什么都没用；
DSH 的模型目录又只读宿主 `ctx.llm` 的注册表，插件没往里注册过任何东西，于是「切到 Pi 之后模型列表看不出 Pi」。

现在这两件事由 `pi-models.mjs` 一处收敛：

```
engine = native              engine = pi
┌───────────────────┐        ┌───────────────────────┐
│ 原生模型组         │        │ Pi 模型组（来自 OAR）  │
│（宿主 llm 自己的） │        │ + 宿主自己的模型组      │
│  ✗ 没有 pi 组      │        │                       │
└───────────────────┘        └───────────────────────┘
        ▲                              ▲
        └── 注销 pi provider            └── 注册 pi provider
            （负向防误杀）                    （目录 ⟷ 执行同源）
```

三条事实依据（不是口味，改动前先读它们）：

1. **目录与执行同源**。Pi 的 `SessionOptions.model` 由 pi 自己的 ModelRuntime 解析
   （`oar/dist/runtimes/pi/resolve.js` 的 `piResolveModel`）：未知模型直接抛
   `RuntimeFailureError(model_unavailable)`、**不回落**。所以目录首选 OAR 的
   `runtime.listModels(installation, {cwd})` —— 与 `pi --list-models`、与真实会话同一条
   `createAgentSessionServices` 路径（含扩展注册的 provider 与认证可用性过滤）；
   OAR 列不出来时才退到 `~/.pi/agent/models.json`，并把来源如实标成 `models.json`。
2. **provider id 用 `pi`，model id 直接用 pi 的全限定选择子**（如 `magpie/auto/deepseek-v4.1-flash`）。
   原因有二：真机宿主已经注册了 `magpie` / `magpie-responses` / `magpie-anthropic`
   （`~/.dsh/settings.yaml` 的 `llm-pi-ai`），复用原生 provider 名会 `DUPLICATE_ADAPTER` 直接抛；
   而把 model id 定义成 pi 的全限定 id 之后，选区 `(pi, magpie/auto/…)` 与原生选区
   `(magpie, auto/…)` 落到**同一个** pi 选择子，中间不需要任何翻译函数。
3. **注册/注销跟着引擎选择器走**，且只在 `engine === 'pi'` 时注册。注册/注销都经
   `ctx.llm.registerAdapter`，它提交时会 emit `llm/adapters-updated`，浏览器半边
   （`@deepseek-ai/dsh-client-ui-model-selection`）订阅该事件刷新目录 ⇒
   「切到 Pi，模型下拉框跟着出现 Pi 组」**不需要任何自定客户端逻辑**。

**执行透传**：引擎每次 attempt 都**现读会话当前选区**（`agent.model.current()` 写的那一份，
由 `pi-session.mjs` 暴露为 `selectionFor`），交给 `pi-models.mjs` 的 `resolvePiAttempt` 解析：

```
选区命中 pi 目录          → 逐字用（source: selection），思考等级只在该模型真的提供时才透传
选区不在 pi 目录里        → 回落 config 的钉死值（source: fallback + 原因）
没有选区                  → pending 钉死值（source: default）
目录拿不到（OAR 不可用）   → 钉死值（source: config，= L8 之前的既有行为）
```

思考等级（pi 的 thinking level）**只有 `source: selection` 那条路才带**：等级是选区的一部分，
选区没被采纳时它也不该跟着走。模型不提供该档位时**丢掉档位并如实记 `effortOmitted`**，
而不是把模型不认的档位硬塞给 pi（OAR 的 `piEffortRefusal` 会让这次开会话直接失败）。

所有回落都写进证据 JSON 的 `modelAttempt`：
`{kind, selection, requested, piModel, modelSource, modelFallbackReason, effort, effortOmitted, effectiveModel, provider, mismatch, error}`——
「用户选了什么 / 换算成什么 / 实际生效什么 / 有没有回落」四件事都能单独审计，
durable 会话日志里的 `assistant/message.source` 也从**有效模型**拆（历史不会说谎）。

**配置面**：`pi.provider` / `pi.model` 从「唯一权威」降级为**回落用之钉死值**（缺省仍是
`magpie` / `auto/deepseek-v4.1-flash`），语义见上表。

## 回滚机制

### 方式 1：安全模式（推荐）

设置环境变量禁用插件接管：

```bash
export DSH_ENGINE_SWITCH_DISABLE=1
```

此时插件加载但不进行任何拦截，DSH 保持原生行为。

### 方式 2：快照还原

使用 `rollback.sh` 脚本从 `.rollback-snapshots/` 还原到最近的已知良好状态：

```bash
bash rollback.sh
```

快照由 `rehearse-rollback.sh` 在测试前自动创建。

## 开发与测试

本项目包含九个可复跑的测试套件（全部不调模型，除 `endo-pi.sh` 与 `endo-session.sh`）：

### 1. client-ui.sh（「⚡ 引擎」客户端 bundle，81 条）

验证 L6 的浏览器半边：`package.json` 的 `dsh.client` 声明与 `exports["./client"]` 能被宿主
`resolveMeta()` 认出来、模块只依赖平台种子、两个插槽注册正确（Chip 只挂
`conversation.hero.options`，输入框上方那枚重复挂载已按 L9 移除）、取值纪律（近似值不落盘）、
命名空间定位（含 fork 改名与邻居不误认的负向断言）、写盘参数与 host 拒绝路径，
并用一个**最小 React 运行时**真的把 `EngineChip` / `EnginePickerOverlay` 渲染出来、真的点：

```bash
bash client-ui.sh
```

期望输出：`SYNTAX_OK`、`SUMMARY: 81 HIT / 0 MISS`、`RESULT: PASS`、`CLIENT_UI_DRIVER: OK`、退出码 0。

> 为什么不是「grep client.js」：客户端 bundle 在 **boot 关键路径**上，语法错或 require 到
> 非平台模块会让整页停在 "Failed to load plugins"；所以这一套真的执行 factory、真的渲染。

### 2. engine-selector.sh（独立引擎选择器，81 条）

验证 Engine ⊥ Preset 的正交组合、判定优先级、会话绑定、`/engine` 命令语法与写盘路径：

```bash
bash engine-selector.sh
```

期望输出：`SUMMARY: 81 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

### 3. smoke.sh（冒烟测试，27 条）

验证接管基础能力与安全模式：

```bash
bash smoke.sh
```

期望输出：`SMOKE_SH: OK`，27 HIT / 0 MISS。

### 4. preset-routing.sh（agentPreset 兼容路由，12 条）

验证 `meta.agentPreset` 两向分流（含 `standard` / 缺失 meta 的负向断言）：

```bash
bash preset-routing.sh
```

期望输出：`SUMMARY: 12 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

### 5. test-safe-mode.sh（安全模式测试，3 条）

验证 `DSH_ENGINE_SWITCH_DISABLE=1` 时零影响：

```bash
bash test-safe-mode.sh
```

期望输出：`RESULT: PASS`，3 HIT / 0 MISS。

### 6. endo-pi.sh（端到端 Pi 引擎测试，11 条）

真实驱动 Pi 引擎的完整流程测试：

```bash
bash endo-pi.sh
```

期望输出：`SUMMARY: 11 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

**⚠️ 注意**：该测试会调用**真实模型**（≤2 次），需要：
- 已配置的 `.pi-agent/` 凭据目录
- 本机 DSH 源码抽取树（`.recon/dsh-src`），用于获取真实契约定义
- Pi 客户端可正常访问

### 7. session-lifecycle.sh（pi 会话/Agent 生命周期，46 条）

不调模型、不联网的确定性套件：真实 cordis Context + 真实 AgentRegistry + 真实 SessionStore
+ 真实 jsonl 持久化（临时根），把 `@botiverse/oar` 与原生 target 换成替身。
覆盖 L7 的全部关键不变量 + **Native 负向防误杀** + 冷重启 resume：

```bash
bash session-lifecycle.sh
```

期望输出：`SUMMARY: 46 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

断言分组：`PI_IDENTITY`（身份无前缀泄漏）、`PI_SESSION`（live store + cwd/preset 元数据）、
`PI_PERSIST`（落盘 + 冷读复原彩排 + settlement 字段）、`PI_REGISTRY`（注册进 ctx.agents）、
`PI_STREAM`（帧挂真实会话 id）、`PI_TURN`（首轮 durable turn + 续号）、
`NEG_NATIVE`（engine=native 严格直通、零 pi 污染）、`RESUME`（新进程冷开旧会话并接着聊）、
`UNLOAD`（卸载不留无主条目）。

### 8. endo-session.sh（真机 Web Host 新建会话 + 首轮 + 重启续聊 + 模型面真机正负向，28 条）

在**隔离 DSH_HOME** 下起一个真实 `dsh web` 宿主（与桌面端同一套 session controller），
用与桌面端逐字相同的 RPC 信封打 `session/create` → `session/state` → `session/prompt`，
再**重启宿主**用同一个会话续聊：

```bash
bash endo-session.sh
```

期望输出：`SUMMARY: 28 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

L8 新增的 10 条断言（真机面）：`MODEL_CATALOG_PI_GROUP`（真机 `session/modelCatalog` 里有 Pi 组，
本机 111 个模型）、`MODEL_CATALOG_PI_IDS`（模型 id 是 pi 全限定选择子）、`MODEL_SELECT_ACCEPTED`
（`session/selectModel` 双闸都过）、`MODEL_CATALOG_SOURCE`（目录来自 OAR）、`MODEL_SYNC_REGISTERED`、
`MODEL_SELECTION_PASSTHROUGH`（**选一个与 config 钉死值不同的模型**，证明是真透传不是回落）、
`MODEL_SOURCE_DURABLE`（durable 日志里的 assistant source = 所选模型），以及负向三条
`NEG_NATIVE_CATALOG_CLEAN` / `NEG_NATIVE_PROVIDER_ABSENT` / `NEG_NATIVE_NO_PI_PROCESS`
（以 `engine: native` 第二次注入启动：目录无 pi 组、`registered=false`、宿主日志零 pi 会话）。

> 为什么负向要**再起一次宿主**：本 harness 用 `--patch`（命令行 overlay）注入插件，
> host 会拒绝对该 entry 的 settings 写入
> （`settings/rejected: Configuration for "…" is overridden by a home patch or command-line overlay`），
> 所以「真机上把引擎切回 native」只能靠一次以 `engine: native` 注入的启动来复现。
> 「同一进程内切引擎 → 目录消失 → 再切回来」的**可逆性**由确定性套件 `pi-models-sync.sh` 覆盖。

**⚠️ 注意**：会调用**真实模型**（≤2 次）、需要 `.pi-agent/` 凭据与 `.recon/dsh-src` 抽取树；
真实 `~/.dsh` 全程只读指纹（断言 `REAL_HOMEDIR_UNTOUCHED`）。

### 9. pi-models-sync.sh（Pi 引擎 ⇄ DSH 模型选择器联动，82 条）

不调模型、不联网的确定性套件：真实 cordis Context + **真实 `@deepseek-ai/dsh-llm` 的 LlmRuntime**
（宿主目录读的就是它）+ 真实 AgentRegistry + 真实 SessionStore + 真实加载 `index.js`。
替身只有两处且明确标注：`@botiverse/oar` 模块替身（不 spawn、不打模型）、原生 target 替身。

```bash
bash pi-models-sync.sh
```

期望输出：`SUMMARY: 82 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

断言分组：`PI_SOURCE`（目录来源：OAR 优先 / `models.json` 兜底 / disabled 剔除 / id 不改写 / TTL + invalidate）、
`PI_ADAPTER`（DTO 投影过宿主的 `INVALID_CATALOG` / `UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` /
`PI_CATALOG_ONLY` 明确拒绝）、`PI_CATALOG`（engine=pi 时目录出现在宿主投影里）、
`PI_SELECTION`（`selectModel` 的两道闸）、`PI_EXEC`（**透传**：含中途换模型、档位不透传、
    选区原文与实际生效值的证据、durable source）、`PI_LATE`（llm 后到 / 缺席都不拖累接管）、
`NEG_NATIVE`（注销 + 零列目录 + 原生直通 + 零替身污染）、`PI_ENGINE_DIRECT`（没接模型面的
独立 oar-engine 保持既有行为）、`UNLOAD`（provider 归还宿主）。

### 另外三条零成本回归

```bash
node config-check.mjs                      # Config schema 校验（含 engine 字段）
node --no-warnings force-engine.test.mjs   # forceEngine 优先级与负向断言（20 条）
bash rehearse-rollback.sh                  # 回滚彩排（20 条，含 DESKTOP_UNTOUCHED + 基线形状哈希边界自证）
```

> `rehearse-rollback.sh` 里 desktop `cordis.patch.yml` 的基线是**形状哈希**（只把本插件的
> `engine:` 一行规范化成 `<volatile>`）：引擎选择器按设计会被老板在 UI 上改，一改就重写 profile patch，
> 拿字面量当基线会「一用就红」。脚本里另带三条合成样本自证放宽边界（多一行插件必红 /
> 非法 engine 取值由取值合法性断言接住 / 合法值互换不变）。见 `ENGINE-UI-EVIDENCE.md` §4。

### 环境变量覆盖

测试脚本支持环境变量覆盖路径：

- `DSH_WORKSPACE`：覆盖工作区根目录（默认自动推导）
- `DSH_SRC`：覆盖 DSH 源码路径（默认 `$HOME/.recon/dsh-src`）

## 安全提示

**🔴 绝对不要提交 `.pi-agent/` 目录**

该目录包含真实凭据（token、session ID 等），已在 `.gitignore` 中排除。在任何情况下都不应将其纳入版本控制或公开分享。

## 已知边界

1. **仅验证过 Pi 引擎**：其他引擎（如 DeepSeek / Claude）未实现
2. **工具桥接未实现**：DSH 的工具调用（tool calls）尚未通过 OAR 传递给引擎
3. **Steer / Abort 未实现**：用户中断（abort）和引导（steer）操作未处理
4. **模型不再是「必须显式钉死」，而是「默认钉死 + 选区优先」**：`pi.provider` / `pi.model`
   现在是**回落用**的钉死值（缺省 `magpie` / `auto/deepseek-v4.1-flash`）。
   正常情况下用会话里选中的模型（UI / `selectModel` / `agentOptions`）；选区不在 pi 能跑的目录里时
   才回落到这个钉死值，并在证据里如实记 `modelSource: fallback` + 原因。
5. **引擎选择器是「新任务默认」而不是「当前任务开关」**：引擎只在建 Agent 时能定，见上文的语义边界一节
6. **会话→引擎绑定只在进程内**：桌面端重启后，存量会话重新按选择器（或会话 header 里的 `agentPreset`）决定引擎
7. **pi 只吃本轮用户文本**：L7 之后 pi 会话的历史存在 DSH 会话里、重启也能冷开接着聊，但送给 pi 的 prompt 仍然**只有本轮用户文本**（不把 DSH 历史喂给 pi）；跨引擎续跑同一会话时，pi 侧不掌握前文
8. **引擎 Chip 改的是全局选择器**：点完不会让当前这条会话当场换引擎（语义边界同上），
   也不能在 UI 上「按会话」点选 —— 后者需要一等公民的活体换装口，第三方插件没有
9. **引擎 Chip 只在 Web / 桌面端界面有**：headless / ACP 场景依旧只能靠 `/engine` 或请求 marker
10. **pi 会话的冷开只服务「本插件建过、且已落盘」的会话**：L7 之前的旧 pi 会话在持久化里
    没有日志，冷开时插件会**明确报错**（`pi engine: 无法重新载入会话 "…"`）而不是伪造一个空会话
11. **`steer` 语义仍是「当新一轮」**：pi 引擎一轮 attempt 跑起来就无法中途插话，
    `steer` 会当成新一轮 turn；`cancel` 只保证「未提交的 attempt 不再写入会话」
12. **Pi 模型目录是 host 全局的、一次只列一个 cwd**：OAR 按 cwd 列模型（某个工作区的
    `.pi/extensions` 可以注册 provider），而 DSH 的模型目录是 host 级的 —— 本插件只能用
    `config.pi.cwd`（缺省进程 cwd）列一次。工作区专属的 pi provider 不在目录里；
    选这类模型会走 `modelSource: fallback` 回落（如实记），不会被静默替换。
13. **OAR 的模型条目不带 contextWindow / inputModalities**：走 OAR 路径时 DSH 侧这两个字段是缺的
    （不猜、不编）；只有 `models.json` 兜底路径有 `contextWindow` 才带上。
14. **`pi` provider 只做目录，不做真实调用**：若有人让原生 AgentLoop 拿 `pi` 组的模型去发请求，
    会拿到明确的 `PI_CATALOG_ONLY` 错误（而不是静默出一个假模型的答案）。pi 出话走 OAR 子进程。
15. **目录有 30s TTL 缓存**：OAR 说这份列表是 usable-now（理应每次现查），但 DSH 的目录刷新
    由多个事件触发；本插件采取「TTL 内复用 + 引擎切换时强制失效」，即一次引擎激活 = 一次真实列表。
16. **`pi` 组也会出现在「设置 → 模型」页**：那份页面把 `llm.listProviders()` 的**每个** provider
    都列出来（官方行为），而 `pi` 不是「可配置 provider」（没有 apiKey/baseURL 那一套），
    所以它在那页是一行**只读**条目（`settingsNs: ''`、显示未配置）。目录与执行不受影响。
17. **`endo-pi.sh` 有一条天然会抖的断言**：它要求真模型逐字复述 20 字符随机 token，
    模型偶发少输出末尾一个字符就会 FAIL（本轮四次运行中失败一次，重跑即绿）。
    失败时证据 JSON 里的 `piTextLength` / `piTextDeltas` 可用于区分「模型少说」还是「适配器丢分片」

## 常见问题与排查（FAQ）

### 1. DSH 桌面端重启失败 / `desktop welcome: Web authentication failed`

- **现象**：高频调试、频繁重启 DSH 桌面端后，启动时卡在欢迎页或提示 `desktop welcome: Web authentication failed`，主进程退回 welcome 流程。
- **根因**：DSH 每次在随机本地端口启动时，均会向 `127.0.0.1` 写入 30 天有效期的 `dsh-auth-...` Cookie。高频重启导致 Chromium Cookie 数据库（`~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`）累积大量旧 Cookie（例如 70+ 条、总长超过 16KB）。Electron 主进程在握手本地 Host 时带上全部 Cookie，导致请求头尺寸击穿 Node.js 默认的 16KB 上限（HTTP 431 `Request Header Fields Too Large`），连接被拒。
- **排查与恢复**：
  1. 彻底退出桌面端（`Cmd+Q`，或 `pkill -9 -f "DeepSeek Harness"`）；
  2. 备份并清理 Cookie 数据库与残留单例锁：
     ```bash
     mv "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies" "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies.bak"
     rm -f "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/SingletonLock" "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/SingletonSocket"
     ```
  3. 重新打开桌面端（`open -a "DeepSeek Harness"`）即可正常进入。

### 2. 写入引擎选择器报错 `namespace-unavailable (engine-switch)`

- **现象**：在桌面端 UI 点击「⚡ 引擎」Chip 切换或输入框执行 `/engine <val>` 时，面板提示 `写入失败：namespace-unavailable (engine-switch)`。
- **根因**：插件的 settings 命名空间未就绪。通常发生在刚修改了 patch 配置但未重启桌面端，或 profile 的 `cordis.patch.yml` 中未正确加载 `engine-switch`。
- **解决**：确认 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `insert:` 节点下包含 `engine-switch`，退出并重新启动桌面端加载最新 bundle 即可。

### 3. 主会话出现两个「⚡ 引擎」Chip

- **现象**：在新会话页面中，既在顶部预设旁看到 Chip，又在输入框卡片正上方看到孤立浮动的 Chip。
- **根因与状态**：旧版曾同时向 `conversation.hero.options` 与 `conversation.input.dock` 两处插槽挂载。L9 已彻底移除 `conversation.input.dock` 注册，单页仅保留一枚。
- **解决**：若界面仍显示两枚，说明桌面端加载的是旧版客户端 bundle 缓存，重启桌面端或在窗口中执行刷新即可更新为单枚 Chip。

---

## License

MIT License - 详见 [LICENSE](LICENSE) 文件
