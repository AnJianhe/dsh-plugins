import test from 'node:test'
import assert from 'node:assert/strict'
import { entryIds, inspect, resolveProfileDir } from '../index.js'

const healthy = `# patch layer
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
- id: agent-loop
  name: "@deepseek-ai/dsh-agent-loop"
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
`

test('能提取全部条目 id', () => {
  assert.equal(entryIds(healthy).length, 7)
  assert.ok(entryIds(healthy).includes('llm-pi-ai'))
})

test('完整配置判定为健康', () => {
  assert.equal(inspect(healthy).healthy, true)
})

test('空配置与空数组被判定为异常', () => {
  assert.equal(inspect('').healthy, false)
  assert.equal(inspect('# 注释\n[]\n').healthy, false)
})

test('只剩少量 UI 条目时判定为异常', () => {
  const partial = `- id: ui-settings-account\n- id: ui-chat\n- id: ui-settings\n- id: ui-conversation\n`
  const result = inspect(partial)
  assert.equal(result.healthy, false)
  assert.match(result.reason, /条目过少/)
})

test('条目数量够但关键条目成批缺失时判定为异常', () => {
  const broken = ['ui-a', 'ui-b', 'ui-c', 'ui-d', 'ui-e', 'ui-f', 'ui-g']
    .map(id => `- id: ${id}`).join('\n')
  const result = inspect(broken)
  assert.equal(result.healthy, false)
  assert.match(result.reason, /关键条目缺失/)
})

test('只缺一两个关键条目时不误判', () => {
  const text = healthy.replace('- id: subagent\n  name: "@deepseek-ai/dsh-subagent"\n', '')
  assert.equal(inspect(text).healthy, true)
})

test('优先使用 DSH_PROFILE_DIR', () => {
  assert.equal(resolveProfileDir({ DSH_PROFILE_DIR: 'C:/x/profile' }, 'file:///whatever/index.js'), 'C:/x/profile')
})

test('没有环境变量时从安装路径反推 profile 目录', () => {
  const here = 'file:///C:/Users/a/.dsh/profiles/desktop/node_modules/%40local/dsh-profile-guard/index.js'
  const result = resolveProfileDir({}, here)
  assert.ok(/[\\/]profiles[\\/]desktop$/.test(result), result)
  assert.ok(!result.includes('node_modules'), result)
})
