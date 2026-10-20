import test from 'node:test'
import assert from 'node:assert/strict'
import { defaults, blocked, provider, isBlocked, applyPolicy, configureProviders } from './policy.js'
for (const [model, reasoningEffort] of Object.entries(defaults)) {
  test(`${model} 默认 ${reasoningEffort}`, () => {
    const original = Object.freeze({ provider, model, maxTokens: 100 })
    assert.deepEqual(applyPolicy(original), { provider, model, maxTokens: 100, reasoningEffort })
    assert.equal(original.reasoningEffort, undefined)
    const explicit = { provider, model, reasoningEffort: 'high' }
    assert.equal(applyPolicy(explicit), explicit)
  })
}
for (const model of blocked) test(`${model} 被禁止且不影响其他提供商`, () => {
  assert.throws(() => applyPolicy({ provider, model }), /禁止/)
  assert.ok(isBlocked(model + '-2026-10-01'))
  const other = { provider: 'deepseek-account', model }
  assert.equal(applyPolicy(other), other)
})
test('配置保留其他提供商、端点和已有模型覆盖，删除禁用型号', () => {
  const config = { providers: { 'deepseek-account': { keep: 1 }, [provider]: { baseURL: 'https://example.test', reasoning: 'minimal', modelOverrides: { keep: { name: 'custom' } } } } }
  const result = configureProviders(config, [{ id: 'keep' }, { id: 'gpt-5.5' }])
  assert.equal(result.providers['deepseek-account'], config.providers['deepseek-account'])
  assert.equal(result.providers[provider].baseURL, 'https://example.test')
  assert.equal(result.providers[provider].reasoning, undefined)
  assert.equal(result.providers[provider].modelOverrides, undefined)
  assert.equal(result.providers[provider].models.find(m => m.id === 'keep').name, 'custom')
  assert.equal(result.providers[provider].models.length, 5)
  assert.ok(!result.providers[provider].models.some(m => isBlocked(m.id)))
  assert.equal(config.providers[provider].reasoning, 'minimal')
  assert.deepEqual(configureProviders(result, []), result)
})
test('拒绝动态表达式或不存在的路由，避免覆盖未知配置', () => {
  assert.throws(() => configureProviders({ providers: { __jsExpr: 'x' } }, []), /动态/)
  assert.throws(() => configureProviders({ providers: {} }, []), /未找到/)
})
