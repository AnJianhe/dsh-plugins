import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { defaults, blocked, provider, isBlocked, applyPolicy, configureProviders } from './policy.js'
export const inject = ['llm', 'configEditor', 'agentDefaultModel']
const reportPath = fileURLToPath(new URL('./applied-status.json', import.meta.url))

// 本插件的 apply 可能运行在 HMR 事务（hmr.runExclusive）内。事务标记是
// hmr 服务内部 AsyncLocalStorage 的 store，会随 setTimeout、promise 续期
// 一路传播；而 configEditor.edit 内部又是 hmr.runExclusive，在事务里再调
// 就会以 "HMR transactions cannot be nested" 被拒绝。
//
// 实测：单纯延后（setTimeout）没用；在事务内创建的 AsyncResource 也没用，
// 它仍会继承事务标记（只有事务外创建的才干净，而插件模块本身可能就在事务
// 内被加载）。可靠的做法是借用 HMR 自己的 exit()：它在不携带 store 的上下文
// 里执行回调，之后的 await 与 timer 都不再看见事务标记。DSH 内部注册
// 配置 watcher 用的正是这个方法。拿不到 hmr 服务时直接执行。
function runOutsideHmr(ctx, work) {
  const executing = ctx.get?.('hmr')?.executing
  if (executing && typeof executing.exit === 'function') return executing.exit(work)
  return work()
}

export function apply(ctx) {
  let disposed = false
  let finish
  const ready = new Promise(resolve => { finish = resolve })
  let failure
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    if (config.provider !== provider) return config
    await ready
    if (failure) throw failure
    return applyPolicy(config)
  })
  ctx.on('llm/stream', function(options, next) {
    if (options.provider !== provider) return next()
    if (isBlocked(options.model)) return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_BLOCKED_BY_USER', message: `用户策略已禁止使用 Codex 模型 ${options.model}。` } } }
    })()
    const selected = applyPolicy(options)
    // 不修改冻结的请求；缺省的辅助调用按正规服务入口重新解析一次。
    return selected === options ? next() : this.stream(selected)
  })
  ctx.effect(() => {
    const timer = setTimeout(() => runOutsideHmr(ctx, async () => {
      try {
        const catalog = await ctx.llm.listModels(provider)
        const entry = ctx.configEditor.entries().find(e => e.options.name === '@deepseek-ai/dsh-llm-pi-ai')
        if (!entry) throw new Error('找不到 llm-pi-ai 配置项。')
        const before = entry.options.config ?? {}
        const expected = configureProviders(before, catalog)
        if (!isDeepStrictEqual(before, expected)) {
          await ctx.configEditor.edit(entry, current => configureProviders(current, catalog))
        }
        const current = ctx.agentDefaultModel.currentSelection()
        if (current.provider === provider) {
          const model = isBlocked(current.model) ? 'gpt-6.1-sol' : current.model
          if (defaults[model]) await ctx.agentDefaultModel.saveSelection({ ...current, model, reasoningEffort: defaults[model] })
        }
        const verified = []
        for (const [model, reasoningEffort] of Object.entries(defaults)) {
          const resolved = await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort })
          verified.push({ model, reasoningEffort: resolved.reasoningEffort })
        }
        const available = (await ctx.llm.listModels(provider)).map(m => m.id)
        if (available.some(isBlocked)) throw new Error('禁用型号仍出现在模型目录。')
        if (!disposed) writeFileSync(reportPath, JSON.stringify({ status: 'applied', checkedAt: new Date().toISOString(), provider, defaults, blocked, verified, available, defaultSelection: ctx.agentDefaultModel.currentSelection(), note: '只解析本地配置与能力，未调用付费模型。显式思考档位优先于默认值。' }, null, 2))
      } catch (error) {
        failure = error
        if (!disposed) writeFileSync(reportPath, JSON.stringify({ status: 'failed', message: error.message }, null, 2))
      } finally { finish() }
    }), 0)
    return () => { disposed = true; clearTimeout(timer); finish() }
  })
}
