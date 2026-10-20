window.__ModuleLoader__.load({
  id: 'dsh-think-autoexpand',
  factory: function () {
    'use strict'
    var name = 'dsh-think-autoexpand'
    var inject = []
    var styleId = 'dsh-think-autoexpand/rules'

    function ensureStyle() {
      if (document.getElementById(styleId)) return
      var style = document.createElement('style')
      style.id = styleId
      style.textContent = [
        // Keep native Think rows visible even when dsh-auto-collapse writes
        // inline display:none. Tool cards keep their collapsed behavior.
        '[data-variant="think"] { display: block !important; }',
        // Hide auto-collapse's own merged-think duplicate rows so the
        // reasoning text is shown once, in its original native position.
        '.dshcf-merged-think, .dshcf-merged-body { display: none !important; }'
      ].join('\n')
      document.head.appendChild(style)
    }

    function expandThinkRow(root) {
      if (!root || root.nodeType !== 1) return
      if (root.getAttribute('data-state') !== 'running') return
      var row = root.querySelector('[data-disclosure-row="true"]')
      if (!row) return
      if (row.getAttribute('aria-expanded') === 'true') return
      try {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      } catch (error) {
        // Never let expansion issues break the page.
      }
    }

    function scan(root) {
      var rows = root && root.querySelectorAll ? root.querySelectorAll('[data-variant="think"][data-state="running"]') : []
      for (var i = 0; i < rows.length; i += 1) expandThinkRow(rows[i])
    }

    var observer = null
    var scheduled = false
    function scheduleScan() {
      if (scheduled) return
      scheduled = true
      window.setTimeout(function () {
        scheduled = false
        scan(document)
      }, 40)
    }

    function apply(ctx) {
      ensureStyle()
      observer = new MutationObserver(scheduleScan)
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state', 'data-open', 'aria-expanded']
      })
      scheduleScan()
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            if (observer) observer.disconnect()
            observer = null
            var style = document.getElementById(styleId)
            if (style) style.remove()
          }
        }, 'dsh-think-autoexpand: reveal and auto-expand running Think rows')
      }
    }

    return { name: name, inject: inject, apply: apply }
  }
})
