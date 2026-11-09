# DSH 引擎切换插件 - 架构设计与工程维护白皮书

本文档面向 **核心研发者、后续接手维护的工程师与协同 Agent**，系统记录 DSH 引擎切换插件（`@local/dsh-engine-switch`）的底层架构设计、逆向工程契约、生命周期状态机、模型同步机制与全套自动化测试验收规范。

用户层安装与日常操作指南请参阅 [README.md](README.md)。

---

## 1. 架构总览与模块矩阵

### 1.1 架构示意

```
DSH 原生 agent 契约
        ↓
   本插件接管
        ↓
  OAR session API
   ↙        ↘
Pi 引擎    （预留其他引擎）
```

- **Orchestrator**：管理会话生命周期、路由决策、状态跟踪。
- **Adapter**：负责 DSH ↔ OAR 的双向转换（输入、输出、错误、abort、steer 等）。
- **Runtime**：引擎实际执行层（当前通过子进程真机驱动 Pi）。

### 1.2 模块划分与职责矩阵

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：接管 `ctx.agents.factory`、路由器接线、事件桥、证据落盘 |
| `engine-intent.mjs` | 引擎意图判定纯函数（forceEngine / marker / 会话绑定 / preset 兼容 / 选择器 / 默认） |
| `engine-command.mjs` | `/engine` 斜杠命令的语法解析与回显文案 |
| `oar-engine.mjs` | OAR 适配器：真起 pi 子进程、把文本映射成 DSH 流式帧（模型/思考等级由选区解析后透传） |
| `pi-models.mjs` | **模型面**：Pi 模型目录（OAR/`models.json`）→ DSH `ctx.llm` provider；DSH 选区 → pi 选择子 |
| `pi-session.mjs` | **pi 会话/Agent 生命周期宿主**：建会话（落盘）→ 注册 Agent → 首轮 durable turn（见 §2） |
| `client.js` | 桌面端「⚡ 引擎」Chip 客户端 bundle（插槽注册、状态管理、settings 读写、浮层） |

---

## 2. 会话与 Agent 生命周期一等公民化（L7 核心机制）

光把 pi 的文本输出“塞回”会话不够：桌面端（HTTP/Web RPC 面）的会话身份、持久化、Agent 注册、流式帧路由都是**上游硬契约**。任何一条不满足都会在桌面端建会话或重启时崩溃。`pi-session.mjs` 把「pi 会话在 DSH 里的一等公民化」收敛成一处，顺序逐字照抄上游 `AgentLoop` 的创建事务：

```
create（新建会话）:               resume（桌面端重启后打开旧会话）:
  sessions.prepare(meta.cwd/agentPreset)   sessionPersistence.open(id,'write') → read(0)
  sessionPersistence.create(header)        sessions.prepare(seed=磁盘事件, meta=存量 header)
  sessions.enter + announce                （补写 fromRestore 追加的 session/end-seed，
  agents.enter + announce（替身身份=会话 id）  对齐持久化游标）
  首轮：turn/start → user/message →         sessions.enter + announce
        step/start → assistant/message       agents.enter + announce
        （含 settlement 字段 turn/step/stream）
        → step/end → turn/end → flush
```

### 2.1 五大核心不变量

改动会话生命周期前必须严格对照 `session-lifecycle.mjs` 的断言：

1. **`agent.id` 必须等于真实会话 id**（`session-<uuid>`）：
   上游 `sessionController.create()` 逐字取 `created.agent.id` 当会话身份，`AgentRegistry.enter()` 也硬校验 `agent.id === agent.session.id`。
2. **会话必须有 cwd 元数据且必须落盘**：
   `workspace.attachSession()` 与 `readState` 校验的就是 header 里的 cwd，冷读完全依赖 `sessionPersistence`。
3. **Agent 必须注册进 `ctx.agents`**：
   `session/prompt` 的准入检查是 `ctx.agents.get(agent.id) !== agent → session/not-found`。
4. **流式帧必须挂在 `agent.session.id` 下**：
   前端 assistant stream 严格按会话 id 订阅。
5. **durable `assistant/message` 必须带 settlement 字段**（`turn` / `step` / `stream`）：
   缺失结算字段的存盘日志在冷读时会被上游判为 `corrupt: invalid settlement fields`，导致重启后该会话永远打不开。

### 2.2 历史现场与 RCA（L7）

修复前的实现中，替身 id 带了 `engine-switch:oar-pi:<sessionId>` 前缀，且未调用 `sessionPersistence.create`。桌面端点「新建会话」时立即抛出：
```
session/workspace-attach-failed: session "engine-switch:oar-pi:..." was created but could not attach:
session persistence holds no such session
```
将替身对象完整对齐 DSH 原生 AgentLoop 事务并落地 `pi-session.mjs` 后彻底解决。

---

## 3. 引擎切换意图判定与正交设计（L5 核心机制）

### 3.1 判定优先级链（高 → 低）

判定逻辑严格封装于 `engine-intent.mjs` 纯函数中：

```
forceEngine > 请求 marker > 会话已绑定引擎 > agentPreset 兼容命中 > config.engine > 原生 target
```

- **`forceEngine`**：运维与测试硬开关（`cordis.patch.yml` 的 `config.forceEngine`），命中已知引擎时强制锁定。
- **请求 marker**：单次 RPC（`options.meta.engine` 或 `options.engine`）自带的显式意图，压过所有非强制来源。
- **会话已绑定引擎**：某会话首次落地在哪便在内存中记录，resume 时跟随绑定（会话身份 ≥ 全局缺省）。显式切换命令会解除绑定。
- **`agentPreset` 兼容命中**：`options.meta.agentPreset === config.piPreset`（缺省 `'pi'`）时路由至 Pi。专门兼容历史遗留会话，不作为当前架构的标准选择方式。
- **`config.engine`**：独立选择器当前值（Chip、`/engine` 与设置页改写的值）。
- **原生 target**：以上均未命中时直通原生。

### 3.2 负向防误杀原则

任何来源中引擎名称不属于精确白名单（`native` / `pi` / `echo`）时一律跳过（如 `PI`、`pi `、`pi-lite`、`auto`、空串、`null` 等均不生效）；`agentPreset` 为其他原生预设（如 `standard`）时绝对不触发兼容分流。

### 3.3 架构硬约束：为什么没有「会话级活体换装」

DSH 在用户点击「新建会话」瞬间即完成 Agent 创建（`ui-workspace.startSession → sessions.create → api-session-controller.createAgent`）。Preset 之所以能改是因为宿主提供了一等公民的 `agentPresets/select` 远程调用；而第三方插件没有活体换装切口，`AgentRegistry` 亦无公开 dispose/remove 接口。
因此，**引擎选择器的语义是「决定之后新建的任务使用什么引擎」，而非「将正在运行的会话当场换装」**。

---

## 4. 模型面联动机制（L8 核心机制）

L8 之前，适配器写死了模型 `magpie/auto/deepseek-v4.1-flash`，且宿主模型选择器只读 `ctx.llm` 注册表。`pi-models.mjs` 彻底打通了模型目录与执行透传：

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

### 4.1 核心事实依据

1. **目录与执行同源**：
   Pi 运行时解析未知模型时会抛出 `RuntimeFailureError(model_unavailable)` 且**不回落**。因此目录首选 OAR 的 `runtime.listModels(installation, {cwd})`，确保列出的模型必定可执行；OAR 不可用时才降级读取 `~/.pi/agent/models.json`。
2. **Provider ID 与选择子规范**：
   Provider ID 注册为 `pi`，模型 ID 直接采用 Pi 的全限定选择子（如 `magpie/auto/deepseek-v4.1-flash`）。避开了宿主已存在的 `magpie` provider 冲突，且选区能无缝映射。
3. **零自定客户端代码联动**：
   `ctx.llm.registerAdapter` 在注册/注销时自动触发 `llm/adapters-updated`，宿主内置的 `dsh-client-ui-model-selection` 监听到事件后自动执行 `catalog.refresh()`。

### 4.2 执行透传状态机

引擎每次 attempt 现读当前选区（`selectionFor(sessionId)`），经 `resolvePiAttempt` 决策：
- **选区命中 Pi 目录**：完整透传使用（`source: selection`）；
- **选区不在 Pi 目录**：回落至配置钉死值（`source: fallback` + 原因记入审计）；
- **无选区 / 目录不可用**：采用配置钉死值（`source: default` / `source: config`）。

思考等级（thinking level）仅在模型明确支持时透传；若模型不支持则主动丢弃并记入 `effortOmitted`，防止触发 OAR 的 `piEffortRefusal` 阻断启动。每次执行证据均结构化记录于 `modelAttempt` 字段中。

---

## 5. 依赖约定与包分发规范

| 包 | 声明 | 谁来提供 | 规则 |
| --- | --- | --- | --- |
| `@deepseek-ai/*` | `peerDependencies` | 宿主 DSH profile | 包含 `schemastery`、`cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-agent-loop`、`dsh-scope` |
| `@botiverse/oar` | `dependencies` (`^0.95.0`) | 插件自身 | 正常随插件构建安装 |

- **版本匹配区间**：统一使用 `>=0.2.0-0 || >=0.2.1-0 || >=0.2.2-0`。采用 prerelease comparator 链确保放行宿主当前 `0.2.2-rc.1` 及其后续版本，杜绝匹配回 0.1.x。
- **严禁本机绝对路径**：绝不在 `package.json` 中写入 `file:<本机路径>`。开发调试期在本地创建的 `.recon/dsh-src` 软链仅限开发环境，不应带入 `package-lock.json`。

---

## 6. 全量自动化测试套件

项目包含 9 套自动化回归测试驱动，覆盖确定性单元断言、真机宿主 RPC 及端到端模型调用：

### 6.1 核心回归套件

| 套件命令 | 断言数 | 性质 | 验证重点 |
| --- | --- | --- | --- |
| `bash client-ui.sh` | 81 HIT | 确定性 (最小 React) | 客户端 bundle、单 Chip 插槽 (hero)、浮层交互、settings 乐观锁写盘、负向零写盘 |
| `bash engine-selector.sh` | 81 HIT | 确定性 | Engine ⊥ Preset 正交判定、优先级覆盖、会话绑定、/engine 解析 |
| `bash smoke.sh` | 27 HIT | 确定性 | 插件接管基础能力、安全模式开关、基础路由 |
| `bash preset-routing.sh` | 12 HIT | 确定性 | 兼容历史 preset-pi 分流，及 standard/缺失 meta 的负向直通原生断言 |
| `bash test-safe-mode.sh` | 3 HIT | 确定性 | `DSH_ENGINE_SWITCH_DISABLE=1` 时宿主完全直通原生 |
| `bash session-lifecycle.sh` | 46 HIT | 确定性 (替身 OAR) | 会话真实落盘、Agent 注册、流式帧会话 ID、durable 结算字段、冷开恢复 |
| `bash pi-models-sync.sh` | 82 HIT | 确定性 (真 LlmRuntime) | Pi 模型目录注入与注销、选区解析透传、思考等级过滤、负向无污染 |
| `bash endo-session.sh` | 28 HIT | 真机 RPC (隔离 Home) | 真机新建会话、prompt 发送、durable 落盘、宿主重启同会话续聊、模型真机正负向 |
| `bash endo-pi.sh` | 11 HIT | 真机端到端 (真模型) | 真实驱动子进程出话、token 转发完整性、会话闭环 |

### 6.2 辅助套件与基线规则

- `node config-check.mjs`：校验 Config Schema 及合法枚举。
- `node --no-warnings force-engine.test.mjs`：20 项 forceEngine 强制锁定优先级与负向探针。
- `bash rehearse-rollback.sh`：20 项回滚彩排。
  - **形状哈希机制**：由于桌面端会根据用户在 UI 上的操作自动刷新 `cordis.patch.yml` 中的 `engine:` 字段，该脚本对 patch 文件采用「形状哈希」断言（将 volatile 字段规范化），同时辅以严格的字段取值合法性校验与合成样本变异测试，防止字面量哈希环境漂移造成假报警。

### 6.3 环境变量覆盖

- `DSH_WORKSPACE`：覆盖工作区根目录（默认自动推导）。
- `DSH_SRC`：覆盖 DSH 源码路径（默认 `$HOME/.recon/dsh-src`）。

---

## 7. 系统级已知边界

1. **单引擎实现**：当前仅完整适配 Pi 引擎，其他引擎（如 Claude/DeepSeek 等）预留接口未实现。
2. **工具卡桥接未实现**：DSH 工具调用（tool calls）尚未通过 OAR 传递给 Pi。
3. **用户引导与打断**：`steer` 会作为全新一轮 turn 处理；`cancel` 仅阻止未提交的 attempt 写入日志。
4. **上下文单轮限制**：会话历史完整保存在 DSH 磁盘日志中且支持冷重启续聊，但当前发送给 Pi 子进程的 Prompt 仅含本轮用户文本，不喂入全量前文。
5. **模型选择优先级**：`pi.provider` / `pi.model` 仅作为回落钉死值，优先采纳会话实时选区。
6. **引擎绑定生命周期**：会话与引擎的绑定表驻留于进程内存中，重启后存量会话依据当前全局选择器或存量 header 判定。
7. **客户端单一枚挂载**：L9 彻底收敛移除了 `conversation.input.dock` 插槽，新会话页仅在预设旁保留一枚 Chip。
8. **模型目录作用域**：OAR 模型目录基于进程 cwd 抽取一次，工作区专属扩展注册的模型不支持在全局目录中动态列出。
9. **上下文长度元数据**：OAR 路径返回的模型条目不包含 `contextWindow` / `inputModalities`（仅 `models.json` 备选路径存在）。
10. **Provider 纯目录限制**：`pi` provider 仅用于向 UI 提供目录展示与校验，不支持直接由原生 AgentLoop 发起调用（违规调用明确抛出 `PI_CATALOG_ONLY`）。
11. **目录 TTL 缓存**：模型目录设置 30s 缓存，并在引擎切换时主动失效。
12. **只读设置项**：`pi` provider 会在「设置 → 模型」中呈现为只读条目（`settingsNs: ''`）。
13. **模型复述抖动**：`endo-pi.sh` 测试包含随机 token 逐字复述断言，受外部模型概率影响偶发丢字，非代码缺陷。

---

## 8. 安全规范

🔴 **严禁将 `.pi-agent/` 目录提交至版本控制**。
该目录包含真实运行凭据、授权 Token 及活跃会话 ID，已被 `.gitignore` 排除。任何时候均不得推送到公开仓库。

