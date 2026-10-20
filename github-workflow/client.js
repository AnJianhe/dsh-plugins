// Browser half of @local/dsh-github-workflow.
//
// Three contributions:
//   conversation.input.dock  a compact status strip above the composer
//   sidebar.panellist        the global "GitHub" icon (its id addresses main:github)
//   main (key "github")      the full dashboard panel

window.__ModuleLoader__.load({
  id: '@local/dsh-github-workflow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/github-workflow/v5'

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    }

    const dot = (color) => ({ width: 7, height: 7, borderRadius: 999, background: color, flex: 'none' })

    const styles = {
      wrap: {
        width: '100%',
        padding: '2px 12px 4px',
        font: '12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        color: C.text,
        boxSizing: 'border-box',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, flexWrap: 'wrap' },
      repo: { fontWeight: 600, whiteSpace: 'nowrap' },
      muted: { color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 7px',
        borderRadius: 999,
        border: `1px solid ${C.border}`,
        color: C.muted,
        fontSize: 11,
        lineHeight: '18px',
      },
      spacer: { flex: '1 1 auto' },
      action: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.muted,
        borderRadius: 6,
        padding: '1px 8px',
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '18px',
      },
      panel: {
        marginTop: 4,
        paddingTop: 6,
        borderTop: `1px solid ${C.border}`,
        display: 'grid',
        gap: 3,
      },
      item: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 },
      link: { color: C.brand, textDecoration: 'none', whiteSpace: 'nowrap' },
      code: {
        color: C.muted,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 11,
        whiteSpace: 'nowrap',
      },
      heading: { color: C.muted, fontSize: 11, marginTop: 2 },

      page: {
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '22px 26px 40px',
        font: '13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        color: C.text,
      },
      pageInner: { maxWidth: 880, margin: '0 auto', display: 'grid', gap: 14 },
      titleRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' },
      subtitle: { color: C.muted, fontSize: 12 },
      card: {
        border: `1px solid ${C.border}`,
        background: C.layer,
        borderRadius: 10,
        padding: '12px 14px',
        display: 'grid',
        gap: 6,
      },
      cardTitle: {
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: C.muted,
      },
      metricRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
      metric: {
        border: `1px solid ${C.border}`,
        background: C.layer2,
        borderRadius: 8,
        padding: '5px 10px',
        minWidth: 84,
        display: 'grid',
        gap: 0,
      },
      metricLabel: { fontSize: 10, color: C.muted, letterSpacing: '0.04em' },
      metricValue: { fontSize: 15, fontWeight: 650 },
      empty: { color: C.muted, fontSize: 12 },
      banner: {
        border: `1px solid ${C.border}`,
        background: C.layer2,
        borderRadius: 8,
        padding: '8px 10px',
        color: C.muted,
        fontSize: 12,
      },
    }

    function summarize(data) {
      if (!data) return '读取中…'
      const local = data.local || {}
      if (local.error) return '当前目录不是 git 仓库'
      const parts = [local.branch || '(detached)']
      parts.push(local.files && local.files.length > 0 ? `${local.files.length} 处改动` : '工作区干净')
      if (local.ahead) parts.push(`领先 ${local.ahead}`)
      if (local.behind) parts.push(`落后 ${local.behind}`)
      return parts.join(' · ')
    }

    function ciState(data) {
      const runs = data && data.runs
      if (!runs || runs.length === 0) return null
      const latest = runs[0]
      if (latest.status && latest.status !== 'completed') return { color: C.warn, label: 'CI 运行中' }
      if (latest.conclusion === 'success') return { color: C.ok, label: 'CI 通过' }
      if (latest.conclusion === 'failure') return { color: C.bad, label: 'CI 失败' }
      return { color: C.idle, label: latest.conclusion || 'CI 空闲' }
    }

    function ciChip(data) {
      const state = ciState(data)
      if (!state) return null
      return h('span', { style: styles.chip }, h('span', { style: dot(state.color) }), state.label)
    }

    async function getJson(path) {
      const response = await fetch(`${API}/${path}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function useDashboard() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        try {
          setData(await getJson('summary'))
          setError(null)
        } catch (cause) {
          setError((cause && cause.message) || String(cause))
        }
      }, [])

      useEffect(() => { load() }, [load])
      return { data, error, load }
    }

    /* ------------------------------------------------------ composer strip */

    function renderDetails(data, error) {
      const rows = []
      if (error) rows.push(h('div', { style: styles.item }, h('span', { style: styles.muted }, `读取失败：${error}`)))
      if (!data) {
        rows.push(h('div', { style: styles.item }, h('span', { style: styles.muted }, '读取中…')))
        return h('div', { style: styles.panel }, rows)
      }

      if (!data.authenticated) {
        rows.push(h('div', { style: styles.item }, h('span', { style: styles.muted },
          '本地 git 状态可用；PR 与 CI 需要 GITHUB_TOKEN（setx GITHUB_TOKEN "ghp_..." 后重开 DSH）。')))
      } else if (data.user) {
        rows.push(h('div', { style: styles.item }, h('span', { style: styles.muted }, `已登录 ${data.user.login}`)))
      }

      if (data.repositories && data.repositories.length > 0) {
        rows.push(h('div', { style: styles.heading }, '工作区内的仓库'))
        for (const repository of data.repositories) {
          rows.push(h('div', { style: styles.item },
            h('span', { style: styles.code }, repository.name),
            h('span', { style: styles.muted }, repository.path)))
        }
      }

      const commits = (data.local && data.local.recentCommits) || []
      if (commits.length > 0) {
        rows.push(h('div', { style: styles.heading }, '最近提交'))
        for (const commit of commits) {
          rows.push(h('div', { style: styles.item },
            h('span', { style: styles.code }, commit.sha),
            h('span', { style: styles.muted }, commit.subject)))
        }
      }

      if (data.local && data.local.files && data.local.files.length > 0) {
        rows.push(h('div', { style: styles.heading }, '改动文件'))
        for (const file of data.local.files.slice(0, 8)) {
          rows.push(h('div', { style: styles.item },
            h('span', { style: styles.code }, file.status),
            h('span', { style: styles.muted }, file.path)))
        }
      }

      if (data.pullRequests && data.pullRequests.length > 0) {
        rows.push(h('div', { style: styles.heading }, '打开的 PR'))
        for (const pr of data.pullRequests) {
          rows.push(h('div', { style: styles.item },
            h('a', { href: pr.url, target: '_blank', rel: 'noreferrer', style: styles.link }, `#${pr.number}`),
            h('span', { style: styles.muted }, `${pr.title}${pr.draft ? '（草稿）' : ''}`)))
        }
      }

      if (data.runs && data.runs.length > 0) {
        rows.push(h('div', { style: styles.heading }, '最近运行'))
        for (const run of data.runs) {
          rows.push(h('div', { style: styles.item },
            h('a', { href: run.url, target: '_blank', rel: 'noreferrer', style: styles.link }, run.name),
            h('span', { style: styles.muted }, `${run.conclusion || run.status}${run.branch ? ` · ${run.branch}` : ''}`)))
        }
      }

      return h('div', { style: styles.panel }, rows)
    }

    function GithubStrip() {
      const { data, error, load } = useDashboard()
      const [open, setOpen] = useState(false)
      const local = (data && data.local) || {}
      const repo = local.remote || (local.error ? '本地目录' : '未配置远端')
      const healthy = !local.error

      return h('div', { style: styles.wrap },
        h('div', { style: styles.row },
          h('span', { style: dot(healthy ? C.ok : C.idle) }),
          h('span', { style: styles.repo }, repo),
          h('span', { style: styles.muted }, summarize(data)),
          h('span', { style: styles.spacer }),
          error ? h('span', { style: styles.chip }, '读取失败') : null,
          data && data.authenticated && Array.isArray(data.pullRequests)
            ? h('span', { style: styles.chip }, `${data.pullRequests.length} 个 PR`)
            : null,
          ciChip(data),
          h('button', { type: 'button', style: styles.action, onClick: load }, '刷新'),
          h('button', { type: 'button', style: styles.action, onClick: () => setOpen(!open) }, open ? '收起' : '详情')),
        open ? renderDetails(data, error) : null)
    }

    /* ------------------------------------------------------ sidebar icon */

    function GithubPanelIcon({ size = 16, active }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', color: active ? C.brand : 'currentColor' },
      },
      h('circle', { cx: 6, cy: 6, r: 2.3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
      h('circle', { cx: 6, cy: 18, r: 2.3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
      h('circle', { cx: 18, cy: 12, r: 2.3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
      h('path', {
        d: 'M6 8.4v7.2M8.4 6h3.6a6 6 0 0 1 0 12H8.4',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
      }))
    }

    /* ------------------------------------------------------ main panel */

    function metric(label, value, borderColor) {
      return h('div', { style: borderColor ? { ...styles.metric, borderColor } : styles.metric },
        h('span', { style: styles.metricLabel }, label),
        h('span', { style: styles.metricValue }, value))
    }

    function card(title, children) {
      return h('section', { style: styles.card },
        h('div', { style: styles.cardTitle }, title),
        children)
    }

    function GithubPanel() {
      const { data, error, load } = useDashboard()

      const local = (data && data.local) || {}
      const files = local.files || []
      const repositories = (data && data.repositories) || []
      const pullRequests = (data && data.pullRequests) || []
      const runs = (data && data.runs) || []
      const commits = local.recentCommits || []
      const ci = ciState(data)

      return h('div', { style: styles.page },
        h('div', { style: styles.pageInner },
          h('div', { style: styles.titleRow },
            h('span', { style: styles.title }, 'GitHub'),
            h('span', { style: styles.subtitle }, local.remote || local.path || (data && data.root) || ''),
            h('span', { style: styles.spacer }),
            h('button', { type: 'button', style: styles.action, onClick: load }, '刷新')),

          error ? h('div', { style: styles.banner }, `读取失败：${error}`) : null,
          !data && !error ? h('div', { style: styles.banner }, '读取中…') : null,

          data
            ? h('div', { style: styles.metricRow },
                metric('分支', local.branch || '—'),
                metric('改动', local.error ? '—' : String(files.length)),
                metric('领先 / 落后', `${local.ahead ?? 0} / ${local.behind ?? 0}`),
                metric('打开的 PR', data.authenticated ? String(pullRequests.length) : '未登录'),
                metric('CI', ci ? ci.label : '—'))
            : null,

          data && !data.authenticated
            ? h('div', { style: styles.banner },
                '未配置 GITHUB_TOKEN：本地 git 信息可用；PR、CI 与远端数据需要 token。')
            : null,

          repositories.length > 0
            ? card('工作区内的仓库', h('div', { style: styles.metricRow },
                repositories.map((repository) => h('div', { style: styles.metric, key: repository.path },
                  h('span', { style: styles.metricLabel }, repository.path),
                  h('span', { style: styles.metricValue }, repository.name)))))
            : null,

          card('本地仓库',
            local.error
              ? h('div', { style: styles.empty }, local.error)
              : files.length === 0
                ? h('div', { style: styles.empty }, '工作区干净，没有未提交改动。')
                : files.slice(0, 12).map((file) => h('div', { style: styles.item, key: file.path },
                    h('span', { style: styles.code }, file.status),
                    h('span', { style: styles.muted }, file.path)))),

          commits.length > 0
            ? card('最近提交', commits.map((commit) => h('div', { style: styles.item, key: commit.sha },
                h('span', { style: styles.code }, commit.sha),
                h('span', { style: styles.muted }, commit.subject))))
            : null,

          card('打开的 PR',
            !data || !data.authenticated
              ? h('div', { style: styles.empty }, '配置 token 后显示。')
              : pullRequests.length === 0
                ? h('div', { style: styles.empty }, '没有打开的 PR。')
                : pullRequests.map((pr) => h('div', { style: styles.item, key: pr.number },
                    h('a', { href: pr.url, target: '_blank', rel: 'noreferrer', style: styles.link }, `#${pr.number}`),
                    h('span', { style: styles.muted },
                      `${pr.title}${pr.draft ? '（草稿）' : ''} · ${pr.head} → ${pr.base}`)))),

          runs.length > 0
            ? card('最近运行', runs.map((run) => h('div', { style: styles.item, key: run.id },
                h('a', { href: run.url, target: '_blank', rel: 'noreferrer', style: styles.link }, run.name),
                h('span', { style: styles.muted },
                  `${run.conclusion || run.status}${run.branch ? ` · ${run.branch}` : ''}`))))
            : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'github-workflow',
          order: 5,
        }, GithubStrip))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'github',
          order: 20,
          label: 'GitHub',
        }, GithubPanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'github',
        }, GithubPanel))
      },
    }
  },
})
