// Browser half of @local/dsh-prompt-optimizer.
// The user explicitly clicks; the Host optimizes this unsent draft, and the
// editor is replaced only if it has not changed during the model call.

window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-optimizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/prompt-optimizer/v1/optimize'
    const NS = 'prompt-optimizer'
    const ZH = {
      optimize: '优化提示词',
      working: '正在优化…',
      apply: '应用优化',
      empty: '先在输入框写下提示词',
      noSession: '当前没有可优化的会话',
      changed: '草稿在优化期间发生了变化，原文未覆盖。',
      applied: '已优化并替换草稿',
      applyDone: '已应用优化结果',
      failed: '优化失败',
      label: '优化当前草稿',
    }
    const EN = {
      optimize: 'Polish prompt',
      working: 'Optimizing…',
      apply: 'Apply rewrite',
      empty: 'Write a prompt first',
      noSession: 'No active session to optimize',
      changed: 'The draft changed while optimizing; your newer text was kept.',
      applied: 'Prompt optimized and replaced',
      applyDone: 'Optimized prompt applied',
      failed: 'Optimization failed',
      label: 'Polish the current draft',
    }

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    }

    const styles = {
      wrap: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 7,
        padding: '4px 9px',
        fontSize: 12,
        lineHeight: '18px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      status: {
        maxWidth: 230,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: C.muted,
        fontSize: 11,
      },
      statusError: { color: C.danger, fontSize: 11, maxWidth: 230 },
      icon: { width: 14, height: 14, display: 'block', flex: 'none', color: C.brand },
    }

    function Sparkle() {
      return h('svg', {
        viewBox: '0 0 20 20',
        width: 14,
        height: 14,
        'aria-hidden': true,
        style: styles.icon,
      },
      h('path', {
        d: 'M10 1.8 12.1 7.9 18.2 10 12.1 12.1 10 18.2 7.9 12.1 1.8 10 7.9 7.9 10 1.8Z',
        fill: 'currentColor',
      }))
    }

    function PromptOptimizeButton(props) {
      const t = props.t
      const input = props.useInput((state) => state)
      const draft = input?.draft ?? ''
      const draftRev = input?.draftRev
      const liveDraft = React.useRef({ draft, draftRev })
      liveDraft.current = { draft, draftRev }

      const [busy, setBusy] = useState(false)
      const [pendingText, setPendingText] = useState(null)
      const [status, setStatus] = useState('')
      const [isError, setIsError] = useState(false)
      const requestRef = React.useRef(null)

      useEffect(() => () => requestRef.current?.abort(), [])

      const applyDraft = useCallback((text, successText) => {
        const actions = props.inputActions
        if (!actions || typeof actions.setDraft !== 'function') {
          setStatus('当前输入框不支持写回草稿')
          setIsError(true)
          return
        }
        actions.setDraft(text)
        if (typeof actions.persistDraft === 'function') actions.persistDraft()
        setPendingText(null)
        setStatus(successText)
        setIsError(false)
      }, [props.inputActions, t])

      const optimize = useCallback(async () => {
        const originalDraft = draft
        const originalRev = draftRev
        if (!originalDraft.trim()) {
          setStatus(t('empty'))
          setIsError(false)
          return
        }
        if (!props.sessionId) {
          setStatus(t('noSession'))
          setIsError(true)
          return
        }

        requestRef.current?.abort()
        const controller = new AbortController()
        requestRef.current = controller
        setBusy(true)
        setPendingText(null)
        setStatus('')
        setIsError(false)
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId: props.sessionId, draft: originalDraft }),
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          if (typeof payload.optimizedPrompt !== 'string' || payload.optimizedPrompt.trim() === '') {
            throw new Error('模型没有返回优化后的提示词。')
          }

          const current = liveDraft.current
          if (current.draft === originalDraft && current.draftRev === originalRev) {
            applyDraft(payload.optimizedPrompt, t('applied'))
          } else {
            setPendingText(payload.optimizedPrompt)
            setStatus(t('changed'))
            setIsError(false)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          setStatus(`${t('failed')}：${(error && error.message) || error}`)
          setIsError(true)
        } finally {
          if (requestRef.current === controller) requestRef.current = null
          setBusy(false)
        }
      }, [applyDraft, draft, draftRev, props.sessionId, t])

      const canUse = input?.phase === 'plain' && !busy
      return h('div', { style: styles.wrap },
        h('button', {
          type: 'button',
          title: t('label'),
          disabled: !canUse,
          onClick: pendingText
            ? () => applyDraft(pendingText, t('applyDone'))
            : optimize,
          style: canUse ? styles.button : { ...styles.button, ...styles.buttonDisabled },
        },
        busy ? null : h(Sparkle),
        busy ? t('working') : pendingText ? t('apply') : t('optimize')),
        status
          ? h('span', { style: isError ? styles.statusError : styles.status, title: status }, status)
          : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const disposeLocale = ctx.locale.register(NS, { zh: ZH, en: EN })
        const t = ctx.locale.bind(NS)
        ctx.effect(() => disposeLocale)

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'prompt-optimizer/button',
          order: 50,
          label: '优化提示词',
        }, (props) => h(PromptOptimizeButton, { ...props, t })))
      },
    }
  },
})
