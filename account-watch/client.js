// Browser half of @local/dsh-account-watch.
//   sidebar.panellist  the "余额" icon (its id addresses main:account)
//   main (key "account") the balance panel, with an editable warning threshold

window.__ModuleLoader__.load({
  id: '@local/dsh-account-watch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/account-watch/v1'
    // Reset cards are redeemed on ChatGPT's own usage page; the plugin only navigates.
    const GPT_USAGE_URL = 'https://chatgpt.com/codex/settings/usage'

    function openGptUsage() {
      try {
        window.open(GPT_USAGE_URL, '_blank', 'noopener,noreferrer')
      } catch {}
    }

    // One shared snapshot. The panel and the sidebar strip both read it, so the
    // two can never disagree about the balance while one of them is stale.
    const STATE_EVENT = 'account-watch:state'
    const state = { summary: null, codex: null, at: 0 }
    let inflight = null

    async function refreshState(force = false) {
      if (inflight) return inflight
      if (!force && Date.now() - state.at < 10000) return
      inflight = (async () => {
        try {
          const [summary, codex] = await Promise.all([
            fetch(`${API}/summary`, { headers: { accept: 'application/json' }, cache: 'no-store' })
              .then((response) => (response.ok ? response.json() : null))
              .catch(() => null),
            fetch(`${API}/codex`, { headers: { accept: 'application/json' }, cache: 'no-store' })
              .then((response) => (response.ok ? response.json() : null))
              .catch(() => null),
          ])
          if (summary) state.summary = summary
          if (codex) state.codex = codex
          state.at = Date.now()
          window.dispatchEvent(new CustomEvent(STATE_EVENT))
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    function useAccountState() {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick((value) => value + 1)
        window.addEventListener(STATE_EVENT, listener)
        return () => window.removeEventListener(STATE_EVENT, listener)
      }, [])
      return state
    }

    // One toast per live condition; the value in its title tracks each refresh.
    // The user closing it suppresses it until the value recovers.

    /* ---------------------------------------------------------- in-app toast */

    const TOAST_EVENT = 'account-watch:toast'
    let toasts = []
    // Keys the user closed by hand stay closed until the value recovers.
    const dismissed = new Set()

    function emitToasts() {
      window.dispatchEvent(new CustomEvent(TOAST_EVENT))
    }

    /** Create or update one persistent toast; it never expires on its own. */
    function upsertToast(key, options) {
      if (dismissed.has(key)) return
      const existing = toasts.find((toast) => toast.key === key)
      if (existing) {
        toasts = toasts.map((toast) => (toast.key === key ? { ...toast, ...options } : toast))
      } else {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
        toasts = [...toasts, { id, key, ...options }]
      }
      emitToasts()
    }

    function removeToast(key) {
      if (!toasts.some((toast) => toast.key === key)) return
      toasts = toasts.filter((toast) => toast.key !== key)
      emitToasts()
    }

    function dismissToast(id) {
      const hit = toasts.find((toast) => toast.id === id)
      if (hit && hit.key) dismissed.add(hit.key)
      toasts = toasts.filter((toast) => toast.id !== id)
      emitToasts()
    }

    /** The value came back above the threshold, so a later dip may warn again. */
    function resetDismissed(key) {
      dismissed.delete(key)
    }

    function useToasts() {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick((value) => value + 1)
        window.addEventListener(TOAST_EVENT, listener)
        return () => window.removeEventListener(TOAST_EVENT, listener)
      }, [])
      return toasts
    }

    function ToastHost() {
      const list = useToasts()
      if (list.length === 0) return null

      return h('div', {
        style: {
          position: 'fixed',
          left: 14,
          // Sits above the sidebar's balance block so it never covers it.
          bottom: 214,
          display: 'grid',
          gap: 10,
          width: 288,
          zIndex: 60,
          pointerEvents: 'none',
        },
      },
      list.map((toast) => h('div', {
        key: toast.id,
        style: {
          pointerEvents: 'auto',
          // Plain translucent card: title only.
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 35%, transparent)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          color: 'var(--dsw-alias-label-primary)',
          border: 'none',
          borderRadius: 16,
          padding: '15px 16px',
          boxShadow: '0 14px 36px rgba(0,0,0,0.32)',
          display: 'grid',
          font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h('span', {
          style: {
            width: 8,
            height: 8,
            borderRadius: 999,
            flex: 'none',
            background: 'var(--dsw-alias-label-secondary)',
          },
        }),
        h('span', {
          style: {
            fontSize: 17,
            fontWeight: 650,
            letterSpacing: '-0.02em',
            flex: '1 1 auto',
            lineHeight: 1.3,
          },
        }, toast.title),
        h('button', {
          type: 'button',
          onClick: () => dismissToast(toast.id),
          style: {
            border: 0,
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: '18px',
            padding: 0,
            marginTop: -1,
            fontFamily: 'inherit',
          },
          title: '关闭',
        }, '×')))))
    }

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    }

    const styles = {
      page: {
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '22px 26px 40px',
        font: '13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        color: C.text,
      },
      inner: { maxWidth: 720, margin: '0 auto', display: 'grid', gap: 14 },
      titleRow: { display: 'flex', alignItems: 'center', gap: 10 },
      title: { fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' },
      spacer: { flex: '1 1 auto' },
      action: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.muted,
        borderRadius: 6,
        padding: '2px 10px',
        cursor: 'pointer',
        fontSize: 12,
      },
      hero: {
        border: `1px solid ${C.border}`,
        background: C.layer,
        borderRadius: 12,
        padding: '20px 22px',
        display: 'grid',
        gap: 6,
      },
      heroLabel: { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.muted },
      heroValue: { fontSize: 38, fontWeight: 680, letterSpacing: '-0.02em', lineHeight: 1.1 },
      heroUnit: { fontSize: 15, fontWeight: 500, color: C.muted, marginLeft: 6 },
      state: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted },
      dot: (color) => ({ width: 7, height: 7, borderRadius: 999, background: color }),
      row: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      metric: {
        border: `1px solid ${C.border}`,
        background: C.layer2,
        borderRadius: 10,
        padding: '10px 14px',
        minWidth: 120,
        display: 'grid',
        gap: 4,
      },
      metricLabel: { fontSize: 11, color: C.muted },
      metricValue: { fontSize: 18, fontWeight: 640 },
      editRow: { display: 'flex', alignItems: 'center', gap: 6 },
      input: {
        width: 76,
        boxSizing: 'border-box',
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 6,
        padding: '2px 7px',
        fontSize: 14,
        fontFamily: 'inherit',
      },
      save: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 6,
        padding: '2px 9px',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      saved: { fontSize: 11, color: C.ok },
      banner: {
        border: `1px solid ${C.border}`,
        background: C.layer2,
        borderRadius: 10,
        padding: '10px 12px',
        color: C.muted,
        fontSize: 12,
      },
      card: {
        border: `1px solid ${C.border}`,
        background: C.layer,
        borderRadius: 10,
        padding: '12px 14px',
        display: 'grid',
        gap: 6,
      },
    }

    function money(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number.toFixed(2) : '0.00'
    }

    function AccountIcon({ size = 16, active }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', color: active ? C.brand : 'currentColor' },
      },
      h('rect', {
        x: 3,
        y: 6,
        width: 18,
        height: 13,
        rx: 3.2,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
      }),
      h('path', { d: 'M3 10h18', stroke: 'currentColor', strokeWidth: 1.7 }),
      h('circle', { cx: 16.5, cy: 14.5, r: 1.9, fill: 'currentColor' }))
    }

    /** The window object for one slot; undefined when the account has no data. */
    function measuredWindow(codex, short) {
      const windows = codex && codex.available && Array.isArray(codex.windows) ? codex.windows : []
      return windows.find((window) => {
        const isShort =
          window.windowMinutes !== null && window.windowMinutes !== undefined && window.windowMinutes <= 360
        return short === '5h' ? isShort : !isShort
      })
    }

    /** Remaining percent for one window; null when the account has no data. */
    function measuredRemaining(codex, short) {
      const hit = measuredWindow(codex, short)
      if (!hit || hit.usedPercent === null || hit.usedPercent === undefined) return null
      return Math.round(100 - hit.usedPercent)
    }

    /** "22:50 恢复" today, "10/24 22:50 恢复" on later days; null without a reset time. */
    function formatReset(at) {
      if (!at) return null
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return null
      const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      if (date.toDateString() === new Date().toDateString()) return `${time} 恢复`
      return `${date.getMonth() + 1}/${date.getDate()} ${time} 恢复`
    }

    function formatExpiry(value) {
      if (!value) return '不过期'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '到期时间未知'
      return date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    /** Upstream titles are English; keep the meaning and render Chinese. */
    function translateResetTitle(title) {
      const text = String(title ?? '').trim()
      if (!text) return '额度重置卡'
      const lower = text.toLowerCase()
      if (lower.includes('full reset')) {
        const weekly = lower.includes('weekly')
        const fiveHour = /5\s*-?\s*hr|5\s*hour/.test(lower)
        if (weekly && fiveHour) return '完整重置（周额度 + 5 小时）'
        if (weekly) return '完整重置（周额度）'
        if (fiveHour) return '完整重置（5 小时窗口）'
        return '完整重置'
      }
      if (lower.includes('reset')) return '额度重置'
      return text
    }

    /** Hours until a card expires; null when it carries no expiry. */
    function hoursUntil(value) {
      if (!value) return null
      const ms = Date.parse(value)
      if (!Number.isFinite(ms)) return null
      return (ms - Date.now()) / 3600000
    }

    const resetButtonStyle = {
      flex: 'none',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 7,
      padding: '4px 11px',
      fontSize: 11.5,
      lineHeight: '16px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    function ResetCard({ credit }) {
      const remaining = hoursUntil(credit.expiresAt)
      const expired = remaining !== null && remaining <= 0
      const urgent = remaining !== null && remaining > 0 && remaining <= 72
      return h('div', {
        style: {
          border: `1px solid ${urgent ? 'rgba(248,81,73,0.45)' : C.border}`,
          background: 'transparent',
          borderRadius: 9,
          padding: '9px 11px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minWidth: 0,
        },
      },
      h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'grid', gap: 2 } },
        h('div', {
          style: {
            fontSize: 12.5,
            fontWeight: 620,
            color: C.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, translateResetTitle(credit.title)),
        h('div', {
          style: {
            fontSize: 12.5,
            fontWeight: 620,
            color: C.text,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        `${formatExpiry(credit.expiresAt)} 到期`,
        urgent || expired
          ? h('span', { style: { color: expired ? C.muted : C.bad } },
              expired ? ' · 已过期' : ' · 即将过期')
          : null)),
      h('button', {
        type: 'button',
        title: '打开 ChatGPT 用量页面自行兑换',
        style: resetButtonStyle,
        onClick: (event) => {
          event.stopPropagation()
          openGptUsage()
        },
      }, '重置'))
    }

    function LimitBar({ label, remaining, resetAt }) {
      const ratio = remaining === null ? 100 : Math.max(0, Math.min(100, remaining))
      const color = remaining !== null && remaining <= 10 ? C.bad : '#3fb950'
      const resetText = formatReset(resetAt)
      return h('div', { style: { display: 'grid', gap: 1, minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', {
            style: {
              fontSize: 12,
              width: 18,
              flex: 'none',
              color: C.muted,
              fontVariantNumeric: 'tabular-nums',
            },
          }, label),
          h('div', {
            style: {
              flex: '1 1 auto',
              height: 8,
              borderRadius: 4,
              background: 'rgba(255,255,255,0.09)',
              overflow: 'hidden',
              minWidth: 40,
            },
          },
          h('div', {
            style: {
              width: `${ratio}%`,
              height: '100%',
              borderRadius: 4,
              background: color,
              opacity: 1,
              transition: 'width 700ms cubic-bezier(0.22, 1, 0.36, 1), background-color 300ms ease',
            },
          })),
          h('span', {
            style: {
              fontSize: 12,
              width: 40,
              flex: 'none',
              textAlign: 'right',
              color: C.muted,
              fontVariantNumeric: 'tabular-nums',
            },
          }, remaining === null ? '100%' : `${remaining}%`)),
        resetText
          ? h('div', {
              style: {
                fontSize: 10,
                lineHeight: '13px',
                color: C.muted,
                opacity: 0.72,
                paddingLeft: 26,
                fontVariantNumeric: 'tabular-nums',
              },
            }, resetText)
          : null)
    }

    function AccountPanel() {
      const snapshot = useAccountState()
      const data = snapshot.summary
      const codex = snapshot.codex
      const resetCards = codex && codex.resetCards ? codex.resetCards : null
      const resetCount = resetCards?.availableCount ?? (codex ? codex.resetCredits : null)
      const usableResetCards = Array.isArray(resetCards?.credits)
        ? resetCards.credits.filter((credit) => credit.usable)
        : []
      const [error, setError] = useState(null)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [advice, setAdvice] = useState(null)
      const [adviceBusy, setAdviceBusy] = useState(false)
      const [adviceError, setAdviceError] = useState('')

      useEffect(() => {
        refreshState(true)
        const id = window.setInterval(() => refreshState(true), 60000)
        return () => window.clearInterval(id)
      }, [])

      useEffect(() => {
        if (data && data.threshold !== undefined) setDraft(money(data.threshold))
      }, [data && data.threshold])

      const save = useCallback(async () => {
        const value = Number(draft)
        if (!Number.isFinite(value) || value < 0) {
          setNotice('请输入不小于 0 的数字')
          return
        }
        setSaving(true)
        setNotice('')
        try {
          const response = await fetch(`${API}/threshold`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ threshold: value }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          setNotice(`已保存：${money(payload.threshold)}，下次检查起生效`)
          await refreshState(true)
        } catch (cause) {
          setNotice(`保存失败：${(cause && cause.message) || cause}`)
        } finally {
          setSaving(false)
        }
      }, [draft])

      const askAdvice = useCallback(async () => {
        setAdviceBusy(true)
        setAdviceError('')
        try {
          const response = await fetch(`${API}/reset-advice`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          setAdvice(payload)
        } catch (cause) {
          setAdvice(null)
          setAdviceError(`判断失败：${(cause && cause.message) || cause}`)
        } finally {
          setAdviceBusy(false)
        }
      }, [])

      const ok = data && data.available
      const low = ok && data.low

      return h('div', { style: styles.page },
        h('div', { style: styles.inner },
          h('div', { style: styles.titleRow },
            h('span', { style: styles.title }, '账户余额'),
            h('span', { style: styles.spacer }),
            h('button', { type: 'button', style: styles.action, onClick: () => refreshState(true) }, '刷新')),

          error ? h('div', { style: styles.banner }, `读取失败：${error}`) : null,

          ok
            ? h('div', { style: styles.hero },
                h('div', { style: styles.heroLabel }, '可用总额（充值 + 赠送）'),
                h('div', { style: styles.heroValue },
                  money(data.total),
                  h('span', { style: styles.heroUnit }, data.currency)),
                h('div', { style: styles.state },
                  h('span', { style: styles.dot(low ? C.bad : C.ok) }),
                  low ? '额度偏低' : '额度充足'))
            : h('div', { style: styles.banner }, (data && data.reason) || '读取中…'),

          ok
            ? h('div', { style: styles.row },
                h('div', { style: styles.metric },
                  h('span', { style: styles.metricLabel }, '充值余额'),
                  h('span', { style: styles.metricValue }, `${money(data.recharge)} ${data.currency}`)),
                h('div', { style: styles.metric },
                  h('span', { style: styles.metricLabel }, '赠送额度'),
                  h('span', { style: styles.metricValue }, `${money(data.bonus)} ${data.currency}`)),
                h('div', { style: { ...styles.metric, flex: '1 1 190px', minWidth: 190 } },
                  h('span', { style: styles.metricLabel }, '提醒阈值'),
                  h('div', { style: styles.editRow },
                    h('input', {
                      type: 'number',
                      min: '0',
                      step: '0.5',
                      value: draft,
                      onChange: (event) => setDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') save()
                      },
                      style: styles.input,
                      'aria-label': '提醒阈值',
                    }),
                    h('button', {
                      type: 'button',
                      style: styles.save,
                      disabled: saving,
                      onClick: save,
                    }, saving ? '…' : '保存'))))
            : null,

          h('div', { style: styles.card },
            h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              },
            },
            h('span', { style: styles.metricLabel }, 'ChatGPT 额度')),
            h('div', { style: { display: 'grid', gap: 6, marginTop: 2 } },
              h(LimitBar, {
                label: '5h',
                remaining: measuredRemaining(codex, '5h'),
                resetAt: measuredWindow(codex, '5h')?.resetAt ?? null,
              }),
              h(LimitBar, {
                label: '7d',
                remaining: measuredRemaining(codex, '7d'),
                resetAt: measuredWindow(codex, '7d')?.resetAt ?? null,
              })),
            codex && codex.available
              ? (() => {
                  return h('div', { style: { display: 'grid', gap: 6, marginTop: 6 } },
                    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                      h('span', { style: styles.metricLabel }, '可用重置卡'),
                      h('span', {
                        style: {
                          fontSize: 14,
                          fontWeight: 620,
                          color: C.text,
                          fontVariantNumeric: 'tabular-nums',
                        },
                      }, resetCount === null ? '暂不可查' : `${resetCount} 张`)),
                    h('div', { style: { display: 'grid', gap: 6 } },
                      usableResetCards.map((credit, index) => h(ResetCard, {
                        key: credit.id || `reset-credit-${index}`,
                        credit,
                      }))),
                    resetCards?.detailsComplete === false
                      ? h('div', { style: { fontSize: 10, lineHeight: '14px', color: C.muted } },
                          '卡片明细不完整；上方数量以服务端计数为准。')
                      : null,
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
                      h('button', {
                        type: 'button',
                        style: {
                          border: `1px solid ${C.border}`,
                          background: 'transparent',
                          color: C.text,
                          borderRadius: 7,
                          padding: '5px 12px',
                          fontSize: 12,
                          lineHeight: '17px',
                          fontFamily: 'inherit',
                          cursor: adviceBusy ? 'default' : 'pointer',
                          opacity: adviceBusy ? 0.6 : 1,
                        },
                        disabled: adviceBusy,
                        onClick: askAdvice,
                      }, adviceBusy ? 'AI 判断中…' : '通过 AI 自动判断是否需要重置'),
                      h('span', { style: { fontSize: 10, lineHeight: '14px', color: C.muted } },
                        '基于当前剩余额度与自然重置时间')),
                    adviceError
                      ? h('div', { style: { fontSize: 11, lineHeight: '15px', color: C.bad } }, adviceError)
                      : null,
                    advice
                      ? h('div', {
                          style: {
                            border: '1px solid var(--dsw-alias-border-l1)',
                            borderRadius: 9,
                            padding: '9px 11px',
                            display: 'grid',
                            gap: 3,
                          },
                        },
                        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
                          h('span', {
                            style: {
                              fontSize: 12,
                              fontWeight: 620,
                              color: advice.recommendation === 'use' ? C.bad : C.ok,
                            },
                          }, advice.recommendation === 'use' ? '建议现在使用' : '建议先不使用'),
                          h('span', { style: { flex: '1 1 auto' } }),
                          h('button', {
                            type: 'button',
                            style: { ...resetButtonStyle, padding: '3px 9px', fontSize: 11 },
                            onClick: openGptUsage,
                          }, '去重置')),
                        h('div', { style: { fontSize: 11.5, lineHeight: '16px', color: C.text } },
                          advice.headline),
                        advice.reason
                          ? h('div', { style: { fontSize: 10.5, lineHeight: '15px', color: C.muted } },
                              advice.reason)
                          : null)
                      : null)
                })()
              : null,
            !codex || !codex.available
              ? h('div', { style: styles.banner }, (codex && codex.reason) || '未接入')
              : null),

          notice ? h('div', { style: styles.saved }, notice) : null,

          ok && data.checkedAt
            ? h('div', { style: styles.banner },
                `最后检查：${new Date(data.checkedAt).toLocaleTimeString('zh-CN')} · 每 5 分钟自动刷新`)
            : null))
    }

    function BalanceFooter(props) {
      const { wide, ctx } = props
      const snapshot = useAccountState()
      const data = snapshot.summary
      const codex = snapshot.codex

      useEffect(() => {
        refreshState()
        const id = window.setInterval(() => refreshState(), 60000)
        return () => window.clearInterval(id)
      }, [])

      const ok = data && data.available
      const low = ok && data.low
      const text = ok ? `¥${money(data.total)}` : '¥—'

      const windows = codex && codex.available && Array.isArray(codex.windows) ? codex.windows : []
      const measured = windows.filter(
        (window) => window.usedPercent !== null && window.usedPercent !== undefined,
      )

      // ChatGPT always has two windows; keep both slots visible even before login
      // so the strip never changes shape when the account is connected.
      const slot = (short) =>
        measured.find((window) =>
          short === '5h'
            ? window.windowMinutes !== null && window.windowMinutes <= 360
            : !(window.windowMinutes !== null && window.windowMinutes <= 360),
        )
      const remainingOf = (window) =>
        window && window.usedPercent !== null && window.usedPercent !== undefined
          ? Math.round(100 - window.usedPercent)
          : null

      const fiveHourLeft = remainingOf(slot('5h'))
      const weeklyLeft = remainingOf(slot('7d'))
      const fiveHourReset = slot('5h')?.resetAt ?? null
      const weeklyReset = slot('7d')?.resetAt ?? null

      // Soonest expiring usable card, so the strip always shows the one that matters most.
      const soonestCard = (codex && codex.available && Array.isArray(codex.resetCards?.credits)
        ? codex.resetCards.credits.filter((credit) => credit.usable)
        : []
      )
        .map((credit) => ({
          credit,
          ms: credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN,
        }))
        .filter((entry) => Number.isFinite(entry.ms))
        .sort((a, b) => a.ms - b.ms)[0]?.credit ?? null

      const clock = (value) => {
        if (!value) return null
        try {
          return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        } catch {
          return null
        }
      }

      const openPanel = () => {
        try {
          ctx.get('layout')?.selectPanel?.('account')
        } catch {}
      }

      const codexText = `5h ${fiveHourLeft === null ? '100%' : `${fiveHourLeft}%`} · 7d ${
        weeklyLeft === null ? '100%' : `${weeklyLeft}%`
      }`

      const title = [
        ok ? `DeepSeek ¥${money(data.total)} ${data.currency}${low ? '（低于阈值）' : ''}` : 'DeepSeek 余额未知',
        codex && codex.available ? `ChatGPT ${codexText || '已连接'}` : null,
        '点击进入面板',
      ]
        .filter(Boolean)
        .join(' · ')

      useEffect(() => {
        if (ok && low) {
          const ratio = Number(data.threshold) > 0
            ? Math.min(100, (Number(data.total) / Number(data.threshold)) * 100)
            : 0
          // upsert every refresh: the title tracks the live value.
          upsertToast('deepseek', {
            title: `DeepSeek 余额 ¥${money(data.total)}`,
            percent: ratio,
          })
        } else if (ok) {
          resetDismissed('deepseek')
          removeToast('deepseek')
        }

        if (fiveHourLeft !== null && fiveHourLeft <= 10) {
          upsertToast('chatgpt-5h', {
            title: `5 小时额度剩余 ${fiveHourLeft}%`,
            percent: fiveHourLeft,
          })
        } else if (fiveHourLeft !== null) {
          resetDismissed('chatgpt-5h')
          removeToast('chatgpt-5h')
        }

        if (weeklyLeft !== null && weeklyLeft <= 10) {
          upsertToast('chatgpt-7d', {
            title: `每周额度剩余 ${weeklyLeft}%`,
            percent: weeklyLeft,
          })
        } else if (weeklyLeft !== null) {
          resetDismissed('chatgpt-7d')
          removeToast('chatgpt-7d')
        }
      }, [ok, low, fiveHourLeft, weeklyLeft, data])

      return h('button', {
        type: 'button',
        title,
        onClick: () => {
          try {
            ctx.get('layout')?.selectPanel?.('account')
          } catch {}
        },
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 2,
          width: '100%',
          border: 0,
          borderTop: `1px solid ${C.border}`,
          background: 'transparent',
          fontFamily: 'inherit',
          padding: wide ? '11px 12px 10px' : '10px 0',
          borderRadius: 0,
          cursor: 'pointer',
          textAlign: 'left',
          overflow: 'hidden',
        },
        onMouseEnter: (event) => {
          event.currentTarget.style.background = 'rgba(255,255,255,0.04)'
        },
        onMouseLeave: (event) => {
          event.currentTarget.style.background = 'transparent'
        },
      },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          width: '100%',
          justifyContent: wide ? 'flex-start' : 'center',
        },
      },
      h('span', {
        style: {
          fontSize: 18,
          fontWeight: 640,
          letterSpacing: '-0.015em',
          fontVariantNumeric: 'tabular-nums',
          color: low ? C.bad : C.text,
        },
      }, wide ? text : '¥'),
      wide
        ? h('span', {
            style: { fontSize: 11, color: C.muted, letterSpacing: '0.02em' },
          }, 'DeepSeek')
        : null),
      wide
        ? h('div', { style: { height: 1, width: '100%', background: C.border, margin: '5px 0 5px' } })
        : null,
      wide
        ? h('div', { style: { width: '100%' } },
            h('div', {
              style: {
                fontSize: 11,
                color: C.muted,
                letterSpacing: '0.02em',
                marginBottom: 4,
              },
            }, 'ChatGPT'))
        : null,
      wide
        ? h('div', { style: { display: 'grid', gap: 5, width: '100%', marginTop: 1 } },
            [['5h', fiveHourLeft, fiveHourReset], ['7d', weeklyLeft, weeklyReset]].map(
              ([label, left, resetAt]) => {
                // Burn-down: the track shows what is LEFT, 100 → 0.
                const ratio = left === null ? 100 : Math.max(0, Math.min(100, left))
                const color = left !== null && left <= 10 ? C.bad : '#3fb950'
                const resetText = formatReset(resetAt)
                return h('div', {
                  key: label,
                  style: { display: 'grid', gap: 1, minWidth: 0 },
                },
                h('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
                },
                h('span', {
                  style: {
                    fontSize: 12,
                    width: 17,
                    flex: 'none',
                    color: C.muted,
                    fontVariantNumeric: 'tabular-nums',
                  },
                }, label),
                h('div', {
                  style: {
                    flex: '1 1 auto',
                    height: 10,
                    borderRadius: 5,
                    background: 'rgba(255,255,255,0.09)',
                    overflow: 'hidden',
                    minWidth: 28,
                  },
                },
                h('div', {
                  style: {
                    width: `${ratio}%`,
                    height: '100%',
                    borderRadius: 5,
                    background: color,
                    opacity: 1,
                    transition: 'width 700ms cubic-bezier(0.22, 1, 0.36, 1), background-color 300ms ease',
                  },
                })),
                h('span', {
                  style: {
                    fontSize: 12,
                    width: 38,
                    flex: 'none',
                    textAlign: 'right',
                    color: C.muted,
                    opacity: 1,
                    fontVariantNumeric: 'tabular-nums',
                  },
                }, left === null ? '100%' : `${left}%`)),
                resetText
                  ? h('div', {
                      style: {
                        paddingLeft: 24,
                        fontSize: 9,
                        lineHeight: '12px',
                        color: C.muted,
                        fontVariantNumeric: 'tabular-nums',
                      },
                    }, resetText)
                  : null)
              },
            ))
        : null,
      wide && soonestCard
        ? h('div', {
            style: {
              width: '100%',
              marginTop: 6,
              paddingTop: 6,
              borderTop: `1px solid ${C.border}`,
              display: 'grid',
              gap: 4,
            },
          },
          h('div', { style: { fontSize: 10, lineHeight: '14px', color: C.muted } }, '最近到期重置卡'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('span', {
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: 11,
                lineHeight: '15px',
                color: C.text,
                fontVariantNumeric: 'tabular-nums',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, formatExpiry(soonestCard.expiresAt)),
            h('span', {
              role: 'button',
              title: '打开 ChatGPT 用量页面自行兑换',
              style: {
                flex: 'none',
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                padding: '2px 9px',
                fontSize: 10.5,
                lineHeight: '15px',
                color: C.text,
                cursor: 'pointer',
              },
              onClick: (event) => {
                event.stopPropagation()
                openGptUsage()
              },
            }, '重置')))
        : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'account',
          order: 30,
          label: '余额',
        }, AccountIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'account',
        }, AccountPanel))

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'account-watch/balance',
          order: 20,
          label: '余额',
        }, (props) => BalanceFooter({ ...props, ctx })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'account-watch/toast',
          order: 200,
        }, ToastHost))
      },
    }
  },
})
