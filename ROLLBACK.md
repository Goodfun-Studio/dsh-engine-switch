# 回滚机制四级阶梯

本文档描述 dsh-engine-switch 插件的四级回滚机制，从最轻量的环境变量禁用到完整的文件还原。

---

## L0：环境变量安全模式（已实测）

**机制**：插件 `apply()` 函数开头检测 `DSH_ENGINE_SWITCH_DISABLE=1`，若设置则立即返回，不触碰 `ctx.agents`，不注册任何 effect。

**适用场景**：界面崩溃、配置损坏、插件导致 DSH 启动失败时的快速禁用。

**使用方法**：
```bash
# macOS / Linux
export DSH_ENGINE_SWITCH_DISABLE=1
dsh <your-profile>

# 一次性禁用（不修改环境）
DSH_ENGINE_SWITCH_DISABLE=1 dsh <your-profile>
```

**验证状态**：已实测 ✅
- 设置环境变量后，证据 JSON 中 `safeMode: true`、`routerInstalled: false`、`agentsFactorySlotIsRouter: false`
- pi 引擎零调用，插件等于不存在

**回退时间**：< 1 秒（即时生效）

---

## L1：plugin_manager 禁用（已实测）

**机制**：通过 DSH CLI 的 `plugin remove` 命令从 profile 的 `dsh.profile.bundles` 数组移除插件，下次启动时不加载。

**适用场景**：确认插件导致问题，需要彻底移除（但保留 profile 其他配置）。

**使用方法**：
```bash
# 移除插件
dsh plugin --profile <profile-name> remove @local/dsh-engine-switch

# 验证移除结果
jq '.dsh.profile.bundles' ~/.dsh/profiles/<profile-name>/package.json
# 应该不包含 "@local/dsh-engine-switch"
```

**验证状态**：已实测 ✅
- 彩排中已验证 `plugin remove` 能完全移除插件
- 移除后 package.json 不再包含插件引用
- 下次启动时插件不加载

**回退时间**：< 5 秒（需重启 DSH）

---

## L2：rollback.sh 快照还原（已实测）

**机制**：在装入插件前对 profile 的 `package.json` 与 `pnpm-lock.yaml` 取快照，失效后逐字节还原并清理 `node_modules` 下的符号链接。

**适用场景**：需要回到装入插件前的**精确状态**，包括依赖锁定版本。

### 使用方法

**步骤 1：装入前快照**
```bash
# 在装入插件前执行
cd /Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch
./rollback.sh snapshot --profile <profile-name>

# 可选：指定非默认 DSH_HOME
./rollback.sh snapshot --profile <profile-name> --home /path/to/dsh-home
```

**步骤 2：装入插件**
```bash
dsh plugin --profile <profile-name> add /Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch
```

**步骤 3：失效后还原**
```bash
cd /Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch
./rollback.sh restore --profile <profile-name>

# 验证还原结果（sha256 应与快照前一致）
shasum -a 256 ~/.dsh/profiles/<profile-name>/package.json
shasum -a 256 ~/.dsh/profiles/<profile-name>/pnpm-lock.yaml
```

**验证状态**：已实测 ✅
- 彩排中已验证快照 → 装入 → 还原流程
- 还原后 package.json / pnpm-lock.yaml 的 sha256 与快照前逐字节一致
- node_modules 下的插件符号链接已清理

**回退时间**：< 3 秒（文件操作 + 符号链接清理）

---

## L3：一次性 profile 彩排（已实测）

**机制**：在临时 DSH_HOME 下创建测试 profile，完整走一遍「装入 → 生效 → 回滚 → 验证」流程，确认回滚机制可靠后再操作真实 profile。

**适用场景**：首次装入插件到生产 profile（如 desktop）前的预演，确保回滚路径打通。

### 使用方法

```bash
cd /Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch

# 运行彩排脚本
./rehearse-rollback.sh
```

**彩排内容**：
1. 验证真实 desktop profile 的 package.json / pnpm-lock.yaml / cordis.patch.yml 基线 sha256
2. 在临时 DSH_HOME 下创建测试 profile
3. 装入插件，验证 package.json / bundles 数组变化
4. 移除插件，对干净状态快照
5. 重新装入插件，验证文件变化
6. 执行 `rollback.sh restore`，验证逐字节还原
7. 验证真实 desktop profile 完全未受影响（DESKTOP_UNTOUCHED）

**验证状态**：已实测 ✅
```
=== 汇总 ===
HITS: 16
MISSES: 0
```

**彩排输出示例**（部分）：
```
[HIT] desktop/package.json 基线一致: cdd3d4d51d79c3666332b935253a22c27525ddc5aa0c533fe658c8f2a8403e86
[HIT] 插件已装入 package.json
[HIT] bundles 数组包含 @local/dsh-engine-switch
[HIT] package.json 逐字节还原: c84dd0278d0fac922b0d3f419be2fefc199427eeec5802af9ef70add965e5274
[HIT] pnpm-lock.yaml 逐字节还原: 878a7b60746fb21ffe11029327f29ea50cfc840bfeb9e0b3cbb46a77f828b7e7
[HIT] DESKTOP_UNTOUCHED
```

**回退时间**：< 30 秒（完整彩排流程）

---

## 实测覆盖范围

| 级别 | 机制 | 实测状态 | 验证依据 |
|------|------|----------|----------|
| L0 | 环境变量安全模式 | ✅ 已实测 | index.js 第 1 行早退逻辑 + 证据 safeMode: true |
| L1 | plugin_manager 禁用 | ✅ 已实测 | rehearse-rollback.sh 中 plugin remove 验证 |
| L2 | rollback.sh 快照还原 | ✅ 已实测 | rehearse-rollback.sh 断言 F：sha256 逐字节一致 |
| L3 | 一次性 profile 彩排 | ✅ 已实测 | rehearse-rollback.sh 退出码 0，16 HIT / 0 MISS |

---

## 未实测项（需真实环境验证）

以下场景因需要真实 desktop profile 或 GUI 交互，本轮未实测：

1. **真实 desktop profile 的装入与回滚**
   - 需手动在 `~/.dsh/profiles/desktop` 执行完整流程
   - 彩排已证明机制可靠，但真实环境可能有特殊依赖冲突

2. **GUI 界面的失效与恢复**
   - L0 安全模式下 GUI 是否正常启动
   - 回滚后 GUI 配置面板是否恢复原状

3. **多 profile 并存场景**
   - 不同 profile 同时装入/移除插件的隔离性

---

## 推荐流程（首次装入真实 desktop）

1. **彩排验证**（已完成 ✅）
   ```bash
   cd /Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch
   ./rehearse-rollback.sh
   # 确认退出码 0，全 HIT
   ```

2. **真实 desktop 快照**
   ```bash
   ./rollback.sh snapshot --profile desktop
   ```

3. **装入插件**
   ```bash
   dsh plugin --profile desktop add /Users/ivywu/Documents/deepseek-harness/default-workspace/dsh-engine-switch
   ```

4. **测试验证**
   - 启动 DSH desktop profile
   - 验证插件加载（查看证据 JSON）
   - 测试 pi 引擎是否正常工作

5. **失效时回滚**
   ```bash
   # 方法 1：环境变量禁用（最快）
   DSH_ENGINE_SWITCH_DISABLE=1 dsh desktop
   
   # 方法 2：完全移除
   dsh plugin --profile desktop remove @local/dsh-engine-switch
   
   # 方法 3：还原快照
   ./rollback.sh restore --profile desktop
   ```

---

## 技术细节

### rollback.sh 实现要点

- **快照内容**：package.json、pnpm-lock.yaml、bundles.txt（记录已装 bundles 列表）
- **还原操作**：
  1. 逐字节覆盖 package.json 与 pnpm-lock.yaml
  2. 根据 bundles.txt 清理 node_modules 下的符号链接
  3. 不触碰 cordis.patch.yml（DSH 插件机制不修改该文件）

### 安全模式实现（index.js）

```javascript
export function apply(ctx, config = {}) {
  // L0 安全模式：环境变量 DSH_ENGINE_SWITCH_DISABLE=1 时，插件等于不存在
  if (process.env.DSH_ENGINE_SWITCH_DISABLE === '1') {
    const store = createEvidenceStore(config)
    store.evidence.safeMode = true
    store.evidence.routerInstalled = false
    store.evidence.agentsFactorySlotIsRouter = false
    store.evidence.takeoverPhase = 'safe-mode-disabled'
    store.write('safe-mode')
    return  // 不触碰 ctx.agents，不注册任何 effect
  }
  // ... 正常加载逻辑
}
```

---

## 产物清单

| 文件 | 用途 | 状态 |
|------|------|------|
| `rollback.sh` | 快照/还原脚本 | ✅ 已交付 |
| `rehearse-rollback.sh` | 彩排脚本 | ✅ 已交付 |
| `ROLLBACK.md`（本文档） | 四级阶梯说明 | ✅ 已交付 |
| `index.js` | L0 安全模式实现 | ✅ 已修改 |
