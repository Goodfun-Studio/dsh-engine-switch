/**
 * 最小校验脚本：验证 Config 导出是否符合 schemastery 契约。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pluginPath = resolve(__dirname, 'index.js')

console.log('=== Config Schema Validation ===')
console.log('pluginPath:', pluginPath)

let Config
try {
  const mod = await import(pluginPath)
  Config = mod.Config
  console.log('✓ Config 导出成功')
} catch (error) {
  console.error('✗ 导入失败:', error.message)
  process.exit(1)
}

if (Config === undefined || Config === null) {
  console.error('✗ Config 未定义')
  process.exit(1)
}

// 检查 schemastery 结构
const meta = Config.dict?.forceEngine?.meta
console.log('\nforceEngine 枚举:', JSON.stringify(meta ?? Config))

// 默认值测试
try {
  const defaultResult = Config({})
  console.log('\nConfig({}) →', JSON.stringify(defaultResult))
  if (defaultResult.forceEngine !== 'native') {
    console.error('✗ 默认值应为 native，实际:', defaultResult.forceEngine)
    process.exit(1)
  }
  console.log('✓ 默认值 native 正确')
} catch (error) {
  console.error('✗ Config({}) 失败:', error.message)
  process.exit(1)
}

// 合法值测试
try {
  const piResult = Config({ forceEngine: 'pi' })
  console.log("\nConfig({forceEngine:'pi'}) →", JSON.stringify(piResult))
  if (piResult.forceEngine !== 'pi') {
    console.error('✗ pi 值未保留')
    process.exit(1)
  }
  console.log('✓ pi 值通过')
} catch (error) {
  console.error('✗ pi 值被拒绝:', error.message)
  process.exit(1)
}

// 非法值测试
try {
  Config({ forceEngine: 'NOPE' })
  console.error('\n✗ NOPE 未被拒绝 ← 失败')
  process.exit(1)
} catch (error) {
  console.log('\n✓ NOPE 被拒绝:', error.message)
}

// schemastery 解析路径
try {
  const schemastryPath = await import.meta.resolve('@deepseek-ai/schemastery')
  console.log('\nschemastery 解析路径:', schemastryPath)
} catch (error) {
  console.error('\n✗ schemastery 解析失败:', error.message)
  process.exit(1)
}

console.log('\n=== 所有校验通过 ===')
