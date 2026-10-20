/**
 * Hand a long conversation from a wide-context provider to a narrow one.
 *
 * The conversation is condensed *before* the first request ever reaches the
 * smaller model, so that model never receives history it cannot hold. The
 * summary is written by the deployment's compaction backend, which is expected
 * to point at the wide-context model (see README); this plugin only decides
 * when that has to happen and how much must go.
 */

import { balancedCuts, resolveBudget, selectSpan } from './budget.js'

export const inject = ['agents', 'llm', 'sessions']

const DEFAULTS = {
  enabled: true,
  headroomTokens: 8192,
  retainNodes: 6,
  maxCompactionsPerRequest: 2,
  blockOnFailure: true,
}

/**
 * Merge the row's config over the defaults.
 *
 * Values are clamped rather than rejected: a bad number in a patch layer must
 * not stop the plugin from protecting the next request.
 */
function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULTS }
  if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled
  if (typeof raw.blockOnFailure === 'boolean') settings.blockOnFailure = raw.blockOnFailure
  settings.headroomTokens = clampInteger(raw.headroomTokens, DEFAULTS.headroomTokens, 0, 1_000_000)
  settings.retainNodes = clampInteger(raw.retainNodes, DEFAULTS.retainNodes, 1, 1_000)
  settings.maxCompactionsPerRequest = clampInteger(raw.maxCompactionsPerRequest, DEFAULTS.maxCompactionsPerRequest, 1, 5)
  return settings
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function headerRoute(session) {
  try {
    const config = session.requestHeader()?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model, maxTokens: config.maxTokens }
    }
  } catch {}
  return undefined
}

function describeResult(result) {
  if (!result || typeof result !== 'object') return '已完成'
  const parts = []
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') parts.push(`${key}=${value}`)
  }
  return parts.length > 0 ? parts.join(' ') : '已完成'
}

export function apply(ctx, config) {
  const settings = resolveSettings(config)
  /** @type {Map<string, { provider: string, model: string, maxTokens?: number }>} */
  const routed = new Map()
  /** @type {Set<string>} */
  const busy = new Set()

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (resolved && typeof resolved.provider === 'string' && typeof resolved.model === 'string') {
      routed.set(payload.agent.id, {
        provider: resolved.provider,
        model: resolved.model,
        maxTokens: resolved.maxTokens,
      })
    }
    return resolved
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!settings.enabled || decision.kind !== 'enter') return decision

    const { agent, signal } = payload
    try {
      await ensureTargetBudget(ctx, agent, signal, settings, routed, busy)
    } catch (error) {
      const message = messageOf(error)
      console.warn(`[provider-handoff] ${message}`)
      if (settings.blockOnFailure) {
        throw new Error(`切换到该模型前必须先把对话压缩进上下文上限，但压缩没有完成：${message}`)
      }
    }
    return decision
  })
}

async function ensureTargetBudget(ctx, agent, signal, settings, routed, busy) {
  if (busy.has(agent.id)) return

  const session = ctx.sessions.get(agent.id)
  if (!session) return

  let target
  try {
    target = session.requestContext()
  } catch {}
  if (typeof target?.provider !== 'string' || typeof target?.model !== 'string') return

  const last = routed.get(agent.id) ?? headerRoute(session)

  const targetWindow = await windowOf(ctx, target.provider, target.model, signal)
  if (!targetWindow) return

  // Only a move to a strictly smaller window can overflow history that already
  // fit; same-route steps and widening moves are somebody else's problem.
  if (!last) return
  const lastWindow = await windowOf(ctx, last.provider, last.model, signal)
  if (!Number.isFinite(lastWindow) || targetWindow >= lastWindow) return

  const resolvedTarget = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const outputReservation = firstPositive(target.maxTokens, last.maxTokens, resolvedTarget?.defaultMaxTokens)
  const budget = resolveBudget({
    contextWindow: targetWindow,
    outputReservation,
    headroomTokens: settings.headroomTokens,
  })
  if (!budget) {
    throw new Error(`目标模型 ${target.provider}/${target.model} 的窗口太小，留不出请求预算`)
  }

  const compaction = ctx.get('compaction')
  const meter = ctx.get('tokenMeter')
  if (!compaction || typeof compaction.compactRegion !== 'function') {
    throw new Error('压缩服务不可用（ctx.compaction 未加载）')
  }
  if (!meter || typeof meter.measure !== 'function') {
    throw new Error('计量服务不可用（ctx.tokenMeter 未加载）')
  }

  const header = {
    config: {
      provider: target.provider,
      model: target.model,
      ...(outputReservation > 0 ? { maxTokens: outputReservation } : {}),
    },
  }

  busy.add(agent.id)
  try {
    for (let attempt = 0; attempt < settings.maxCompactionsPerRequest; attempt += 1) {
      const measurement = meter.measure(session, header)
      const total = Number(measurement?.totalTokens ?? 0)
      if (!(total > budget)) {
        if (attempt > 0) console.log(`[provider-handoff] 已进入目标预算：约 ${total} / ${budget} tokens`)
        return
      }

      const nodes = Array.isArray(measurement?.nodes)
        ? measurement.nodes.map((node) => ({ seq: node.seq, tokens: Number(node.tokens ?? 0) }))
        : []
      const balanced = balancedCuts(session.surface.nodes, (seq) => session.eventAt(seq))
      const span = selectSpan({
        nodes,
        balanced,
        totalTokens: total,
        budget,
        retainNodes: settings.retainNodes,
      })
      if (!span) {
        throw new Error(
          `约 ${total} tokens 超出目标窗口预算 ${budget}，但找不到可安全压缩的区间（最近 ${settings.retainNodes} 条需原样保留）`,
        )
      }

      const result = await compaction.compactRegion(span.start, span.end, agent, signal)
      console.log(
        `[provider-handoff] 切到 ${target.provider}/${target.model} 前已压缩：${describeResult(result)}（原约 ${total} tokens，预算 ${budget}）`,
      )
    }
    throw new Error('连续压缩后仍超出目标上下文预算')
  } finally {
    busy.delete(agent.id)
  }
}

async function windowOf(ctx, provider, model, signal) {
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, signal)
    const window = info?.context?.contextWindow
    return Number.isFinite(window) && window > 0 ? window : undefined
  } catch {
    return undefined
  }
}

function firstPositive(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}
