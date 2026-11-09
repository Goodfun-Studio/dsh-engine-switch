# DSH 引擎切换插件

这是一个 DeepSeek Harness (DSH) 插件，用于在 DSH agent 契约之上无缝挂载不同的 LLM 底座引擎。当前已实现通过 **OAR (Orchestrator-Adapter-Runtime)** 架构完整驱动 Pi 引擎，实现对 Pi 的深度接管、模型选择器联动与桌面端可视化切换。

> 🛠️ **面向研发与维护者**：关于插件的底层架构设计、逆向工程契约、L7 会话生命周期落盘事务、L8 模型同步内部机制及 9 大全量自动化回归套件，请参阅专门的 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 核心特性

- **底座与预设正交解耦（Engine ⊥ Preset）**：引擎（原生 AgentLoop / Pi 引擎 / 回声引擎）与业务预设（标准 / PTC / 极简 / 创造模式）互不干扰，自由组合。
- **界面一等公民体验**：在桌面端新会话起始页提供独立的「⚡ 引擎」下拉 Chip，与工作目录、业务预设并排展示，支持弹窗可视化切换。
- **模型选择器动态联动**：切到 Pi 引擎后，DSH 底部模型下拉框自动注入并呈现「Pi」模型组（含 111+ 个可用模型），选中即可直接透传给 Pi 子进程出话；切回 Native 自动清理。
- **全链路生命周期支持**：Pi 会话与 Agent 在 DSH 内部一等公民化，支持真实落盘、状态恢复、进程冷重启后同会话续聊。
- **安全直通与零入侵回滚**：支持环境变量一键进入安全直通模式，提供完整的快照备份与回滚机制。

---

## 安装方法

使用 DSH 插件管理器安装：

```bash
plugin_manager install_bundle
```

在提示输入安装路径时，提供本插件的**绝对目录路径**（如 `/path/to/dsh-engine-switch`）。

宿主依赖要求：宿主需为 DSH `>=0.2.0-0` 运行时（已声明为 `peerDependencies`，详细依赖规范见 [ARCHITECTURE.md](ARCHITECTURE.md#5-依赖约定与包分发规范)）。

---

## 如何切换引擎（Engine ⊥ Preset）

在开始使用前，请先明确两个正交的业务概念：

| 维度 | 决定什么 | 在哪选 |
| --- | --- | --- |
| **Agent Preset**（业务预设） | 系统提示词模板 / 角色设定 / 工具插件集 | 新建任务页的预设 Chip（原生四种：标准 / PTC / 极简 / 创造） |
| **Engine**（底座引擎） | 底座由谁驱动：DSH 原生 AgentLoop / OAR 驱动的 Pi / 回声替身 | 新会话起始页「⚡ 引擎」Chip、`/engine` 命令、插件设置字段 |

本插件提供四种无缝切换引擎的入口：

### 1. 新会话起始页「⚡ 引擎」下拉 Chip（推荐）
- **位置**：新会话起始页那一行右侧，与「工作目录」Chip、预设 Chip 同排并列展示。
- **交互**：点击 Chip 弹出正中选择面板，可点选「原生引擎」、「Pi 引擎」或「回声引擎」。
- **生效**：底层走通用的 `ctx.remote.settings.update` 乐观锁写盘，写入成功后 Chip 实时更新。

### 2. 输入框斜杠命令
在输入框输入以下命令即可查看或切换：
```bash
/engine            # 查看当前引擎选择器值、本会话绑定引擎及可选列表
/engine pi         # 切换为 Pi 引擎
/engine native     # 切换回原生引擎
/engine echo       # 切换为回声替身（仅回显固定文本，用于快速联调）
```

### 3. 插件设置面板
在 DSH 的「设置 → 插件 → dsh-engine-switch」中，`engine` 为 volatile 字段，可直接在可视化表单中编辑，修改后即时生效并写回 profile patch。

### 4. 请求级 Marker
在 headless、ACP 或脚本自动化场景下，可通过单次请求参数显式锁定：`options.meta.engine` 或 `options.engine`（可选值为 `native` / `pi` / `echo`）。

### 切换生效边界
由于 DSH 在「新建任务」那一刻就已经完成了底层 Agent 实例的创建，因此引擎选择器的语义是**「决定之后新建的任务使用什么引擎」**。正在运行中的当前会话会保持初始创建时的引擎，在桌面端重新载入该会话时跟随新配置。

---

## 模型联动使用说明

切到 Pi 引擎后，不仅底座驱动切换为 Pi，模型选择器也会自动联动：

- **模型列表展示**：在 DSH 界面下方的模型选择器中，会自动出现「Pi」分组，并展示当前环境下 Pi 可用的全部模型选择子（如 `magpie/auto/deepseek-v4.1-flash`、`claude-opus-5` 等）。
- **选区真实透传**：在界面选中指定模型后发起对话，选中的模型将实时透传至 Pi 运行子进程；若所选模型不在 Pi 支持范围内，将安全回落至默认配置并如实记录审计日志。
- **切回原生自动恢复**：当选择器切换回 `native` 时，Pi 模型组将自动注销，模型列表严格恢复为原生 DeepSeek 模型组，杜绝任何外部污染。

---

## 回滚机制与安全模式

### 1. 安全模式直通（应急推荐）
如需临时完全关闭插件的拦截与接管，设置环境变量启动即可：
```bash
export DSH_ENGINE_SWITCH_DISABLE=1
```
在此模式下，插件照常加载但内部所有钩子立即直通原生，DSH 行为与未安装插件时完全一致。

### 2. 快照一键还原
通过预置脚本从快照备份中一键恢复到最近的干净状态：
```bash
bash rollback.sh
```

---

## 使用须知与能力边界

1. **新建任务定引擎**：引擎选择器是「新任务默认引擎」，不支持对已在运行中的会话进行活体换装。
2. **上下文单轮交互**：Pi 会话的完整历史均由 DSH 在底层正常持久化并支持重启续聊，但当前每轮向 Pi 子进程发送的 Prompt 仅含当前轮用户文本，不喂入前文历史。
3. **工具卡支持状态**：DSH 的原生工具调用（tool calls）目前尚未通过 OAR 传递给 Pi。
4. **会话绑定仅限进程内**：会话与引擎的初次绑定关系记录在内存中，桌面端完全退出重启后，存量会话依选择器当前值或历史 header 决定引擎。

---

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

## 快速开发与测试概览

本项目具备覆盖单元、集成与端到端真机的 9 套自动化回归套件：

```bash
bash client-ui.sh          # 客户端 bundle、UI Chip 与设置写盘测试 (81 条)
bash engine-selector.sh    # 独立引擎选择器与正交判定测试 (81 条)
bash smoke.sh              # 插件基础接管与冒烟测试 (27 条)
bash preset-routing.sh     # 预设兼容分流与直通负向测试 (12 条)
bash session-lifecycle.sh  # 会话一等公民化、落盘与生命周期测试 (46 条)
bash pi-models-sync.sh     # Pi 模型目录与选区透传联动测试 (82 条)
```

详细测试规格、真机测试（`endo-session.sh` / `endo-pi.sh`）以及回滚彩排说明，请参阅 [ARCHITECTURE.md](ARCHITECTURE.md#6-全量自动化测试套件)。

---

## License

MIT License - 详见 [LICENSE](LICENSE) 文件
