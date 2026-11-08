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

## 安装

使用 DSH 插件管理器安装：

```bash
plugin_manager install_bundle
```

在安装路径输入时，提供本插件的**绝对目录路径**（如 `/path/to/dsh-engine-switch`）。

## 依赖约定（决定能不能在别的机器上装）

| 包 | 声明 | 谁来提供 |
| --- | --- | --- |
| `@deepseek-ai/*`（schemastery、cordis、dsh-agent、dsh-llm、dsh-session、dsh-agent-loop） | `peerDependencies` | 宿主 DSH profile（profile 的 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，不随插件安装） |
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
| **Engine**（底座引擎） | 底座由谁驱动：DSH 原生 AgentLoop / OAR 驱动的 pi / 回声 | 主会话框上的「⚡ 引擎」下拉 Chip、`/engine` 命令、插件设置字段 `engine`、或请求 marker |

所以「Pi 引擎」**不在**预设下拉框里（`cordis.patch.yml` 里不再声明任何 preset）。
引擎走自己的入口，四个都可用：

1. **主会话框上的「⚡ 引擎」下拉 Chip**（L6 新增，推荐）：
   - 位置一：**新会话起始页**那一行右侧，与「工作目录」chip / 预设 chip 同排（`conversation.hero.options`）；
   - 位置二：**输入框卡片上方**的通栏区右侧，与宿主自己的 Queue / Todo / Goal 同一排（`conversation.input.dock`）；
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

本项目包含六个可复跑的测试套件（全部不调模型，除 `endo-pi.sh`）：

### 1. client-ui.sh（「⚡ 引擎」客户端 bundle，83 条）

验证 L6 的浏览器半边：`package.json` 的 `dsh.client` 声明与 `exports["./client"]` 能被宿主
`resolveMeta()` 认出来、模块只依赖平台种子、三个插槽注册正确、取值纪律（近似值不落盘）、
命名空间定位（含 fork 改名与邻居不误认的负向断言）、写盘参数与 host 拒绝路径，
并用一个**最小 React 运行时**真的把 `EngineChip` / `EnginePickerOverlay` 渲染出来、真的点：

```bash
bash client-ui.sh
```

期望输出：`SYNTAX_OK`、`SUMMARY: 83 HIT / 0 MISS`、`RESULT: PASS`、`CLIENT_UI_DRIVER: OK`、退出码 0。

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
4. **模型必须显式钉死**：在 `real-pi-patch.yml` 中必须指定 `model` 字段（如 `pi-mini-prod`），否则 OAR 会根据自身逻辑自动选择模型，可能与预期不符
5. **引擎选择器是「新任务默认」而不是「当前任务开关」**：引擎只在建 Agent 时能定，见上文的语义边界一节
6. **会话→引擎绑定只在进程内**：桌面端重启后，存量会话重新按选择器决定引擎（不跨重启记忆会话身份）
7. **pi 路由目前不把 DSH 历史交给 pi**：换引擎后继续同一会话，pi 只看到本次输入；跨引擎续跑同一会话会丢上下文
8. **引擎 Chip 改的是全局选择器**：点完不会让当前这条会话当场换引擎（语义边界同上），
   也不能在 UI 上「按会话」点选 —— 后者需要一等公民的活体换装口，第三方插件没有
9. **引擎 Chip 只在 Web / 桌面端界面有**：headless / ACP 场景依旧只能靠 `/engine` 或请求 marker
10. **`endo-pi.sh` 有一条天然会抖的断言**：它要求真模型逐字复述 20 字符随机 token，
    模型偶发少输出末尾一个字符就会 FAIL（本轮四次运行中失败一次，重跑即绿）。
    失败时证据 JSON 里的 `piTextLength` / `piTextDeltas` 可用于区分「模型少说」还是「适配器丢分片」

---

## License

MIT License - 详见 [LICENSE](LICENSE) 文件
