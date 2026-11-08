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

## 如何选引擎

两条路都已可用：

1. **按 agentPreset 自动路由**：create/resume 带 `options.meta.agentPreset`，且其值等于
   `config.piPreset`（默认 `'pi'`）时，本次调用交给 pi 引擎；缺失、非字符串、空串或为别的值
   （如 `'standard'`）一律走原生 target（负向防误杀，可复跑见 `preset-routing.mjs` / `preset-routing.sh`）。
2. **强制全局引擎**：`cordis.patch.yml` 的 `config.forceEngine` 字段（如 `pi`）。

优先级：`forceEngine` > `agentPreset` > pi marker > echo marker > 原生 target。

**尚未实现的功能**：
- **按会话选引擎**：根据会话创建时的其他参数（非 agentPreset）动态选择引擎

这些特性计划在后续版本中实现。

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

本项目包含三个测试套件：

### 1. smoke.sh（冒烟测试，27 条）

验证接管基础能力与安全模式：

```bash
bash smoke.sh
```

期望输出：`SMOKE_SH: OK`，27 HIT / 0 MISS。

### 2. test-safe-mode.sh（安全模式测试，3 条）

验证 `DSH_ENGINE_SWITCH_DISABLE=1` 时零影响：

```bash
bash test-safe-mode.sh
```

期望输出：`RESULT: PASS`，3 HIT / 0 MISS。

### 3. endo-pi.sh（端到端 Pi 引擎测试，11 条）

真实驱动 Pi 引擎的完整流程测试：

```bash
bash endo-pi.sh
```

期望输出：`SUMMARY: 11 HIT / 0 MISS`、`RESULT: PASS`、退出码 0。

**⚠️ 注意**：该测试会调用**真实模型**（≤2 次），需要：
- 已配置的 `.pi-agent/` 凭据目录
- 本机 DSH 源码抽取树（`.recon/dsh-src`），用于获取真实契约定义
- Pi 客户端可正常访问

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

---

## License

MIT License - 详见 [LICENSE](LICENSE) 文件
