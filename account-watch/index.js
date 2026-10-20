/**
 * DeepSeek account balance for the Harness Web UI.
 *
 * Two jobs: serve the wallet snapshot to the panel, and while the total sits
 * below the threshold, contribute one prompt context so a running task sees it.
 * The threshold is editable from the panel and persisted beside the Harness home.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const BASE = '/account-watch/v1/'
const FALLBACK_THRESHOLD = 3.5

export const inject = ['webServer', 'llm']

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function round2(value) {
  return Number(Number(value).toFixed(2))
}

function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'account-watch.json')
}

function sanitiseThreshold(value, fallback = FALLBACK_THRESHOLD) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) return fallback
  return round2(number)
}

/** Live threshold, seeded from the environment and overridden by the saved file. */
let threshold = sanitiseThreshold(process.env.DSH_BALANCE_THRESHOLD)

function loadThreshold() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    threshold = sanitiseThreshold(parsed?.threshold, threshold)
  } catch {}
}

function persistThreshold() {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ threshold }, null, 2), 'utf8')
  return path
}

function clientMetadata() {
  return {
    version: '0.2.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

async function readAccount(ctx) {
  const account = ctx.get('deepseekAccount')
  if (!account) return { available: false, reason: '账号服务不可用', threshold }
  try {
    const balance = await account.getBalance(clientMetadata())
    if (!balance) return { available: false, reason: '未登录', threshold }
    if (balance.status !== 'ready') return { available: false, reason: '余额查询失败', threshold }

    const wallets = [
      ...balance.value.map((wallet) => ({
        currency: wallet.currency,
        balance: Number(wallet.balance),
        kind: 'recharge',
      })),
      ...balance.bonusWallets.map((wallet) => ({
        currency: wallet.currency,
        balance: Number(wallet.balance),
        kind: 'bonus',
      })),
    ]

    const currency = wallets[0]?.currency ?? 'CNY'
    const sum = (kind) =>
      wallets.filter((wallet) => wallet.kind === kind).reduce((total, wallet) => total + wallet.balance, 0)

    const recharge = sum('recharge')
    const bonus = sum('bonus')
    // The gift balance is spendable, so the warning threshold applies to the total.
    const total = recharge + bonus

    return {
      available: true,
      currency,
      total: round2(total),
      recharge: round2(recharge),
      bonus: round2(bonus),
      low: total < threshold,
      threshold,
      checkedAt: Date.now(),
    }
  } catch (error) {
    return { available: false, reason: messageOf(error), threshold }
  }
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

/**
 * One `rate_limit.{primary,secondary}_window` object → one display window.
 * Window identity comes from `limit_window_seconds`, not from the slot name, so
 * an upstream window-length change cannot silently relabel the gauge.
 */
function mapCodexWindow(window, id) {
  if (!window || typeof window !== 'object') return null

  const used = Number(window.used_percent)
  // Upstream may send a numeric string; anything outside 0-100 is schema drift,
  // so surface "unknown" instead of clamping it into fake data.
  const usedPercent = Number.isFinite(used) && used >= 0 && used <= 100 ? Number(used.toFixed(1)) : null

  const seconds = Number(window.limit_window_seconds)
  const windowMinutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null
  // Length decides the label; fall back to the slot name when it is missing.
  const weekly = windowMinutes === null ? id === 'secondary' : windowMinutes > 360

  const resetSeconds = Number(window.reset_at)
  const resetAfter = Number(window.reset_after_seconds)
  // `reset_at` is authoritative; fall back to "now + reset_after_seconds" when absent.
  const resetAt =
    Number.isFinite(resetSeconds) && resetSeconds > 0
      ? resetSeconds * 1000
      : Number.isFinite(resetAfter) && resetAfter > 0
        ? Date.now() + resetAfter * 1000
        : null

  return {
    id,
    label: weekly ? '每周额度' : '5 小时窗口',
    usedPercent,
    remainingPercent: usedPercent === null ? null : Number((100 - used).toFixed(1)),
    resetAt,
    windowMinutes,
  }
}

/** Normalise a `GET /wham/usage` body into the shape the panel renders. */
export function parseCodexUsage(payload) {
  if (!payload || typeof payload !== 'object') return null

  const rateLimit = payload.rate_limit && typeof payload.rate_limit === 'object' ? payload.rate_limit : {}
  const windows = []
  const primary = mapCodexWindow(rateLimit.primary_window, 'primary')
  const secondary = mapCodexWindow(rateLimit.secondary_window, 'secondary')
  if (primary) windows.push(primary)
  if (secondary) windows.push(secondary)

  if (windows.length === 0) return null

  const rawCredits = payload.credits
  let credits = null
  if (rawCredits && typeof rawCredits === 'object') {
    const hasCredits = rawCredits.has_credits === true
    const rawBalance = rawCredits.balance
    // A "0" balance on a no-credits plan is noise, so only surface real credits.
    const hasBalance = hasCredits && rawBalance !== null && rawBalance !== undefined
      && String(rawBalance).trim() !== ''
    credits = {
      hasCredits,
      unlimited: rawCredits.unlimited === true,
      balance: hasBalance ? String(rawBalance) : null,
    }
  }

  const resetCreditsRaw = Number(payload.rate_limit_reset_credits?.available_count)
  const resetCredits = Number.isFinite(resetCreditsRaw) ? resetCreditsRaw : null

  return {
    plan: typeof payload.plan_type === 'string' ? payload.plan_type : null,
    windows,
    credits,
    limitReached: rateLimit.limit_reached === true || Boolean(payload.rate_limit_reached_type),
    resetCredits,
    spendControlReached: payload.spend_control?.reached === true,
  }
}

/** Read-only reset-card projection. Expired and non-available cards are not presented as usable. */
export function parseCodexResetCards(payload, fallbackCount = null) {
  const rawCredits = Array.isArray(payload?.credits) ? payload.credits : []
  const now = Date.now()
  const credits = rawCredits
    .filter((credit) => credit && typeof credit === 'object')
    .map((credit) => {
      const expiresAt = typeof credit.expires_at === 'string' && credit.expires_at.trim()
        ? credit.expires_at
        : null
      const expiresMs = expiresAt ? Date.parse(expiresAt) : null
      return {
        id: typeof credit.id === 'string' ? credit.id : null,
        title: typeof credit.title === 'string' && credit.title.trim() ? credit.title.trim() : '额度重置卡',
        resetType: typeof credit.reset_type === 'string' ? credit.reset_type : 'unknown',
        status: typeof credit.status === 'string' ? credit.status : 'unknown',
        grantedAt: typeof credit.granted_at === 'string' ? credit.granted_at : null,
        expiresAt,
        description: typeof credit.description === 'string' ? credit.description : null,
        usable: credit.status === 'available' && (expiresMs === null || (Number.isFinite(expiresMs) && expiresMs > now)),
      }
    })
  const availableRaw = payload?.available_count === null || payload?.available_count === undefined
    ? Number.NaN
    : Number(payload.available_count)
  const usableCount = credits.filter((credit) => credit.usable).length
  return {
    availableCount: Number.isFinite(availableRaw) ? availableRaw : fallbackCount,
    credits,
    usableCount,
    detailsAvailable: true,
    // Count/list mismatches mean the server truncated or raced; display only, never consume.
    detailsComplete: Number.isFinite(availableRaw) ? availableRaw === usableCount : null,
  }
}

function codexAuthPath() {
  return join(homedir(), '.codex', 'auth.json')
}

/** Codex CLI 把 ChatGPT 的 OAuth 凭据存在这里；没有它就无法查订阅额度。 */
function readCodexToken() {
  try {
    const parsed = JSON.parse(readFileSync(codexAuthPath(), 'utf8'))
    const token = parsed?.tokens?.access_token ?? parsed?.access_token ?? null
    const accountId = parsed?.tokens?.account_id ?? parsed?.account_id ?? null
    return { token: token ? String(token) : null, accountId: accountId ? String(accountId) : null }
  } catch {
    return { token: null, accountId: null }
  }
}

/**
 * Codex subscription quota. Every branch returns the same keys because the
 * panel reads them directly; `reason` only appears on failure.
 */
async function readCodex() {
  const { token, accountId } = readCodexToken()
  const result = {
    available: false,
    configured: Boolean(token),
    source: CODEX_USAGE_URL,
    plan: null,
    windows: [],
    credits: null,
    limitReached: null,
    resetCredits: null,
    resetCards: {
      availableCount: null,
      usableCount: null,
      credits: [],
      detailsAvailable: false,
      detailsComplete: null,
    },
    spendControlReached: null,
    checkedAt: Date.now(),
  }

  if (!token) {
    result.reason = '未检测到 Codex 登录（~/.codex/auth.json），先在 Codex CLI 里登录即可接入。'
    return result
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'codex_exec/0.1.0',
      originator: 'codex_exec',
    }
    if (accountId) headers['chatgpt-account-id'] = accountId
    const response = await fetch(CODEX_USAGE_URL, { headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      result.reason = `查询失败（HTTP ${response.status}）`
      return result
    }

    let usagePayload
    try {
      usagePayload = text ? JSON.parse(text) : null
    } catch {
      result.reason = '用量接口未返回 JSON（可能是网络挑战页）'
      return result
    }

    const parsed = parseCodexUsage(usagePayload)
    if (!parsed || parsed.windows.length === 0) {
      result.reason = '响应里没有可识别的额度窗口'
      return result
    }

    result.plan = parsed.plan
    result.windows = parsed.windows
    result.credits = parsed.credits
    result.limitReached = parsed.limitReached
    result.resetCredits = parsed.resetCredits
    result.resetCards = {
      availableCount: parsed.resetCredits,
      usableCount: null,
      credits: [],
      detailsAvailable: false,
      detailsComplete: null,
    }
    try {
      const resetResponse = await fetch(CODEX_RESET_CREDITS_URL, { headers, signal: controller.signal })
      const resetText = await resetResponse.text()
      let resetPayload = null
      try {
        resetPayload = resetText ? JSON.parse(resetText) : null
      } catch {}

      if (resetResponse.ok && resetPayload && typeof resetPayload === 'object') {
        result.resetCards = parseCodexResetCards(resetPayload, parsed.resetCredits)
      } else {
        result.resetCards.reason = `重置卡明细暂不可用（HTTP ${resetResponse.status}）`
      }
    } catch (error) {
      // Usage remains useful even when the separate card-details endpoint is unavailable.
      result.resetCards.reason = messageOf(error)
    }
    result.spendControlReached = parsed.spendControlReached
    result.available = true
    return result
  } catch (error) {
    result.reason = messageOf(error)
    return result
  } finally {
    clearTimeout(timer)
  }
}

function startBalanceWatch(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt) return () => {}

  let snapshot
  let timer
  const refresh = async () => {
    try {
      snapshot = await readAccount(ctx)
    } catch {}
  }
  refresh()
  timer = setInterval(refresh, 5 * 60 * 1000)
  if (timer && typeof timer.unref === 'function') timer.unref()

  const disposeContext = systemPrompt.context({
    name: 'account-watch:balance',
    order: 950,
    text: () => {
      if (!snapshot || !snapshot.available || !snapshot.low) return ''
      return `用户的 DeepSeek 账户可用额度为 ${snapshot.total.toFixed(2)} ${snapshot.currency}（充值 ${snapshot.recharge.toFixed(2)} + 赠送 ${snapshot.bonus.toFixed(2)}），低于提醒阈值 ${snapshot.threshold.toFixed(2)}。请照常完成当前任务，同时提醒用户及时充值。`
    },
  })

  return () => {
    clearInterval(timer)
    disposeContext()
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${messageOf(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const RESET_ADVICE_PROMPT = `你是 ChatGPT Codex 额度顾问。用户持有若干“完整重置卡”：使用后会立刻把 5 小时窗口和每周窗口都恢复到 100%，并且从使用那一刻起重新计算下一次自然重置时间。

给出建议时遵守这两条事实：
1. 如果某个窗口本来就快自然重置了（比如半小时内），此时用卡等于浪费——不消费它也会满。
2. 用卡会把该窗口的下次自然重置点整体往后推（从使用时刻重新计满一个窗口长度），所以窗口剩余时间越长、当前额度越低，用卡的收益越大。
3. 卡有到期时间，过期作废；临近过期时即使收益一般也应考虑使用。

只根据给出的数字判断，不要臆测。返回一个 JSON 对象，不要 Markdown 代码围栏：
{"recommendation":"use","headline":"一句话结论","reason":"2 到 3 句说明，指出关键窗口和剩余时间"}
recommendation 只能是 "use"（建议现在用）或 "hold"（先别用）。`

function formatClock(ms) {
  if (!Number.isFinite(ms)) return '未知'
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '未知'
  if (minutes <= 0) return '已到重置点'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

function currentModelSelection(ctx) {
  try {
    const selected = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selected && typeof selected.provider === 'string' && selected.model) {
      return selected
    }
  } catch {}
  return null
}

function extractJsonObject(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('模型没有返回可解析的判断结果')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/** Ask the selected model whether spending a reset card now is worthwhile. */
async function readResetAdvice(ctx) {
  const codex = await readCodex()
  if (!codex.available) throw new Error(codex.reason || 'ChatGPT 额度暂不可用')

  const model = currentModelSelection(ctx)
  if (!model) throw new Error('当前没有可用的模型，无法自动判断')

  const now = Date.now()
  const windowLines = codex.windows.map((window) => {
    const short = window.windowMinutes !== null && window.windowMinutes <= 360
    const name = short ? '5 小时窗口' : '每周窗口'
    const left = typeof window.remainingPercent === 'number' ? Math.round(window.remainingPercent) : null
    const minutes = window.resetAt ? Math.round((window.resetAt - now) / 60000) : null
    return `- ${name}：剩余 ${left === null ? '未知' : `${left}%`}，已用 ${
      window.usedPercent === null ? '未知' : `${Math.round(window.usedPercent)}%`
    }，自然重置时间 ${formatClock(window.resetAt)}（还有 ${formatDuration(minutes)}）`
  })

  const usableCards = Array.isArray(codex.resetCards?.credits)
    ? codex.resetCards.credits.filter((credit) => credit.usable)
    : []
  const soonestExpiry = usableCards
    .map((credit) => ({ credit, ms: credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms)[0]

  const facts = [
    `当前时间：${formatClock(now)}`,
    ...windowLines,
    `可用重置卡：${codex.resetCards?.availableCount ?? usableCards.length} 张${
      soonestExpiry ? `，最近一张 ${formatClock(soonestExpiry.ms)} 到期（还有 ${formatDuration(
        Math.round((soonestExpiry.ms - now) / 60000),
      )}）` : ''
    }`,
  ].join('\n')

  let reply = ''
  let finishReason
  for await (const chunk of ctx.llm.stream({
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: facts }] }],
    system: RESET_ADVICE_PROMPT,
    maxTokens: 700,
  })) {
    if (chunk.type === 'text-delta') reply += chunk.text
    if (chunk.type === 'finish') finishReason = chunk.reason
  }

  if (finishReason?.kind === 'error' || finishReason?.kind === 'aborted') {
    throw new Error(finishReason.failure?.message ?? '模型调用未完成')
  }

  const parsed = extractJsonObject(reply)
  const recommendation = parsed.recommendation === 'use' ? 'use' : 'hold'
  if (typeof parsed.headline !== 'string' || !parsed.headline.trim()) {
    throw new Error('模型没有给出结论')
  }
  return {
    recommendation,
    headline: parsed.headline.trim(),
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
    facts,
    provider: model.provider,
    model: model.model,
    checkedAt: Date.now(),
  }
}

function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return () => {}

  const summary = async (req, res) => {
    try {
      return sendJson(res, 200, await readAccount(ctx))
    } catch (error) {
      return sendJson(res, 500, { error: messageOf(error) })
    }
  }

  const saveThreshold = async (req, res) => {
    try {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        return sendJson(res, 405, { error: '只接受 POST' })
      }
      const body = await readBody(req)
      const next = Number(body.threshold)
      if (!Number.isFinite(next) || next < 0 || next > 1_000_000) {
        return sendJson(res, 400, { error: '阈值必须是 0 到 1000000 之间的数字' })
      }
      threshold = round2(next)
      const path = persistThreshold()
      return sendJson(res, 200, { threshold, path })
    } catch (error) {
      return sendJson(res, 500, { error: messageOf(error) })
    }
  }

  const codexUsage = async (_req, res) => {
    try {
      return sendJson(res, 200, await readCodex())
    } catch (error) {
      return sendJson(res, 500, { error: messageOf(error) })
    }
  }

  const env = async (_req, res) => {
    let electronApi
    try {
      const mod = await import('electron')
      electronApi = {
        keys: Object.keys(mod).slice(0, 24),
        hasApp: Boolean(mod.app),
        hasTray: Boolean(mod.Tray),
        defaultType: typeof mod.default,
      }
    } catch (error) {
      electronApi = { error: messageOf(error) }
    }
    return sendJson(res, 200, {
      electron: process.versions.electron ?? null,
      electronProcessType: process.type ?? null,
      node: process.versions.node,
      platform: process.platform,
      resourcesPath: process.resourcesPath ?? null,
      electronApi,
    })
  }

  const resetAdvice = async (_req, res) => {
    try {
      return sendJson(res, 200, await readResetAdvice(ctx))
    } catch (error) {
      return sendJson(res, 500, { error: messageOf(error) })
    }
  }

  const disposers = [
    webServer.register({ kind: 'exact', path: `${BASE}summary`, handler: summary }),
    webServer.register({ kind: 'exact', path: `${BASE}threshold`, handler: saveThreshold }),
    webServer.register({ kind: 'exact', path: `${BASE}codex`, handler: codexUsage }),
    webServer.register({ kind: 'exact', path: `${BASE}reset-advice`, handler: resetAdvice }),
    webServer.register({ kind: 'exact', path: `${BASE}env`, handler: env }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export function apply(ctx) {
  loadThreshold()
  ctx.effect(() => registerRoutes(ctx))
  ctx.effect(() => startBalanceWatch(ctx))
}
