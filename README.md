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

## 如何选引擎

**当前只支持强制全局引擎选择**：通过 `cordis.patch.yml` 中的 `config.forceEngine` 字段指定引擎（如 `pi`）。

**尚未实现的功能**：
- **按会话选引擎**：根据用户在会话创建时的参数动态选择引擎
- **按 preset 选引擎**：根据 agent preset ID 自动路由到对应引擎

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
