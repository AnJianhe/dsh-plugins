export const defaults = Object.freeze({
  'gpt-6-astra': 'low',
  'gpt-6.1-sol': 'medium',
  'gpt-6-sol': 'low',
  'gpt-6-luna': 'max',
})
export const blocked = Object.freeze(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
export const provider = 'openai-codex'
export function isBlocked(model) {
  return blocked.some(id => model === id || model.startsWith(`${id}-`))
}
export function applyPolicy(config) {
  if (config.provider !== provider) return config
  if (isBlocked(config.model)) throw Object.assign(new Error(`用户策略已禁止使用 Codex 模型 ${config.model}；请选择 GPT-6 系列。`), { code: 'MODEL_BLOCKED_BY_USER' })
  const effort = defaults[config.model]
  // 只提供默认值，不覆盖用户显式选择的合法思考档位。
  return effort && config.reasoningEffort == null ? { ...config, reasoningEffort: effort } : config
}
export function configureProviders(current, catalog) {
  const providers = current.providers ?? {}
  if (!providers || typeof providers !== 'object' || providers.__jsExpr) throw new Error('providers 为动态表达式，无法安全自动修改。')
  const profile = providers[provider]
  if (!profile || profile.__jsExpr) throw new Error('未找到普通配置的 openai-codex 路由。')
  const existing = profile.models?.length ? profile.models : catalog.map(m => ({ id: m.id }))
  if (!Array.isArray(existing)) throw new Error('模型列表不是静态数组。')
  const models = existing.filter(m => !isBlocked(m.id)).map(m => ({ ...m, ...(profile.modelOverrides?.[m.id] ?? {}) }))
  for (const id of Object.keys(defaults)) {
    let model = models.find(m => m.id === id)
    if (!model) { model = { id }; models.push(model) }
    // 本机 pi-ai 的选项没有 Ultra；不能将多代理 Ultra 冒充普通 API effort。
    model.reasoningEfforts = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
  }
  const next = { ...profile, models }
  delete next.modelOverrides
  delete next.reasoning // 避免路由统一默认值压过按型号设置的默认值。
  return { ...current, providers: { ...providers, [provider]: next } }
}
