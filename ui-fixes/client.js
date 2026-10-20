// Browser half of @local/dsh-ui-fixes.
//
//   sidebar.workspaces.session.menu.item  a "删除对话" row (with an in-app confirm)
//   plugins.detail.actions                a "返回列表" control
//   shell.overlay                         the confirm dialog host

window.__ModuleLoader__.load({
  id: '@local/dsh-ui-fixes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const API = '/ui-fixes/v1'

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      bad: 'var(--dsw-alias-state-error-primary)',
    }

    /* ------------------------------------------------- in-app confirm */

    const CONFIRM_EVENT = 'ui-fixes:confirm'
    let pending = null
    let resolver = null

    function askConfirm({ title, message, confirmLabel = '确定', tone = 'danger' }) {
      return new Promise((resolve) => {
        pending = { title, message, confirmLabel, tone }
        resolver = resolve
        window.dispatchEvent(new CustomEvent(CONFIRM_EVENT))
      })
    }

    function settle(value) {
      const resolve = resolver
      resolver = null
      pending = null
      window.dispatchEvent(new CustomEvent(CONFIRM_EVENT))
      if (resolve) resolve(value)
    }

    function ConfirmHost() {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick((value) => value + 1)
        window.addEventListener(CONFIRM_EVENT, listener)
        return () => window.removeEventListener(CONFIRM_EVENT, listener)
      }, [])

      if (!pending) return null

      return h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.32)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 80,
        },
        onClick: (event) => {
          if (event.target === event.currentTarget) settle(false)
        },
      },
      h('div', {
        style: {
          width: 352,
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 35%, transparent)',
          backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
          border: 'none',
          borderRadius: 18,
          padding: '20px 20px 16px',
          boxShadow: '0 20px 52px rgba(0,0,0,0.4)',
          display: 'grid',
          gap: 11,
          font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', { style: { fontSize: 15.5, fontWeight: 660, letterSpacing: '-0.015em' } }, pending.title),
      h('div', {
        style: {
          fontSize: 12.5,
          color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.65,
        },
      }, pending.message),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 3 } },
        h('button', {
          type: 'button',
          onClick: () => settle(false),
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            borderRadius: 999,
            padding: '7px 18px',
            fontSize: 12.5,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        }, '取消'),
        h('button', {
          type: 'button',
          onClick: () => settle(true),
          style: {
            border: 0,
            background: 'var(--dsw-alias-label-primary)',
            color: 'var(--dsw-alias-bg-base)',
            borderRadius: 999,
            padding: '7px 18px',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        }, pending.confirmLabel))))
    }

    /* ------------------------------------------------------ menu entries */

    const styles = {
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        border: 0,
        background: 'transparent',
        color: C.bad,
        textAlign: 'left',
        padding: '7px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
        borderRadius: 6,
      },
      back: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.muted,
        borderRadius: 7,
        padding: '2px 10px',
        fontSize: 12,
        lineHeight: '20px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
    }

    function dismissMenu(props) {
      try {
        const handle = props.useMenuOpenState ? props.useMenuOpenState() : undefined
        if (handle && typeof handle.close === 'function') handle.close()
        else if (handle && typeof handle.dismiss === 'function') handle.dismiss()
        else if (handle && typeof handle.setOpen === 'function') handle.setOpen(false)
        else if (typeof handle === 'function') handle(false)
      } catch {}
    }

    function DeleteSessionItem(props) {
      const { sessionId, displayTitle, ctx } = props
      const [busy, setBusy] = useState(false)

      const run = async () => {
        const label = displayTitle && displayTitle.trim() ? displayTitle.trim() : sessionId
        dismissMenu(props)
        const confirmed = await askConfirm({
          title: '删除这个对话？',
          message: `「${label}」\n\n会话记录会从磁盘移除，无法恢复。`,
          confirmLabel: '删除',
          tone: 'danger',
        })
        if (!confirmed) return

        setBusy(true)
        try {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace && typeof uiWorkspace.archiveSession === 'function') {
            try {
              await uiWorkspace.archiveSession(sessionId)
            } catch {}
          }
          const response = await fetch(`${API}/session/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        } catch (error) {
          await askConfirm({
            title: '删除失败',
            message: String((error && error.message) || error),
            confirmLabel: '知道了',
            tone: 'normal',
          })
        } finally {
          setBusy(false)
        }
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        disabled: busy,
        onClick: run,
        style: styles.menuItem,
        onMouseEnter: (event) => {
          event.currentTarget.style.background = 'rgba(255,255,255,0.06)'
        },
        onMouseLeave: (event) => {
          event.currentTarget.style.background = 'transparent'
        },
      }, busy ? '删除中…' : '删除对话')
    }

    function BackToPlugins(props) {
      const ctx = props.ctx
      return h('button', {
        type: 'button',
        style: styles.back,
        title: '返回插件列表',
        onClick: () => {
          const layout = ctx.get('layout')
          if (!layout || typeof layout.selectPanel !== 'function') return
          try {
            layout.selectPanel('conversation')
            window.setTimeout(() => {
              try {
                layout.selectPanel('plugins')
              } catch {}
            }, 80)
          } catch {}
        },
      }, '← 返回列表')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'ui-fixes/delete-session',
          order: 500,
          label: '删除对话',
        }, (props) => DeleteSessionItem({ ...props, ctx })))

        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'ui-fixes/back',
          order: 10,
          label: '返回列表',
        }, (props) => BackToPlugins({ ...props, ctx })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'ui-fixes/confirm',
          order: 210,
        }, ConfirmHost))
      },
    }
  },
})
