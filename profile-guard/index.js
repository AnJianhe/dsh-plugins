import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// profile 根目录里由 Loader 组合的配置层。bundle 列表在 package.json，条目覆盖在 patch。
const PATCH_NAME = 'cordis.patch.yml'
// 这些条目一旦成批消失，基本可以判定配置被清空或重建，而不是用户主动精简。
const KEY_ENTRIES = ['agent-default-model', 'permission', 'llm-deepseek', 'agent-loop', 'subagent', 'llm-pi-ai']
const MIN_ENTRIES = 6
const SNAPSHOT_LIMIT = 20
const CHECK_INTERVAL_MS = 60_000
const SETTLE_MS = 8_000

export function entryIds(text) {
  return [...text.matchAll(/^-\s+id:\s*(\S+)\s*$/gm)].map(match => match[1])
}

export function inspect(text) {
  const ids = entryIds(text)
  if (!text.trim() || /^#.*\n\s*\[\]\s*$/s.test(text) || ids.length === 0) {
    return { healthy: false, reason: '配置为空或没有任何条目', ids }
  }
  if (ids.length < MIN_ENTRIES) {
    return { healthy: false, reason: `条目过少（${ids.length} 个）`, ids }
  }
  const missing = KEY_ENTRIES.filter(id => !ids.includes(id))
  if (missing.length >= 3) {
    return { healthy: false, reason: `关键条目缺失：${missing.join(', ')}`, ids }
  }
  return { healthy: true, ids }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// 取 profile 根目录：优先环境变量；否则从本插件安装位置反推
// （<profile>/node_modules/@local/dsh-profile-guard/index.js）。
export function resolveProfileDir(env = process.env, here = import.meta.url) {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR
  try {
    const file = fileURLToPath(here)
    const index = file.lastIndexOf('node_modules')
    if (index > 0) return file.slice(0, index).replace(/[\\/]+$/, '')
  } catch {}
  return null
}

export function apply(ctx) {
  const profileDir = resolveProfileDir()
  if (!profileDir) return
  const patchPath = join(profileDir, PATCH_NAME)
  const guardDir = join(profileDir, '.profile-guard')
  const snapshotDir = join(guardDir, 'snapshots')
  const logPath = join(guardDir, 'guard.log')
  let disposed = false
  let lastGood = null

  const log = (message) => {
    try {
      mkdirSync(guardDir, { recursive: true })
      writeFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { flag: 'a' })
    } catch {}
  }

  const listSnapshots = () => {
    try {
      return readdirSync(snapshotDir).filter(name => name.endsWith('.yml')).sort()
    } catch {
      return []
    }
  }

  const saveSnapshot = (text) => {
    if (lastGood === text) return
    const names = listSnapshots()
    if (names.length) {
      try {
        if (readFileSync(join(snapshotDir, names[names.length - 1]), 'utf8') === text) {
          lastGood = text
          return
        }
      } catch {}
    }
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, `patch-${stamp()}.yml`), text)
    lastGood = text
    for (const name of listSnapshots().slice(0, Math.max(0, listSnapshots().length - SNAPSHOT_LIMIT))) {
      try { unlinkSync(join(snapshotDir, name)) } catch {}
    }
  }

  const restoreLatest = () => {
    const names = listSnapshots()
    for (let index = names.length - 1; index >= 0; index -= 1) {
      const path = join(snapshotDir, names[index])
      let text
      try { text = readFileSync(path, 'utf8') } catch { continue }
      const check = inspect(text)
      if (!check.healthy) continue
      return { name: names[index], text }
    }
    return null
  }

  const check = () => {
    if (disposed) return
    let text
    try { text = readFileSync(patchPath, 'utf8') } catch { return }
    const result = inspect(text)
    if (result.healthy) {
      saveSnapshot(text)
      return
    }
    const restored = restoreLatest()
    if (!restored) {
      log(`检测到异常但无可用快照：${result.reason}`)
      return
    }
    try {
      const brokenPath = join(guardDir, `broken-${stamp()}-${PATCH_NAME}`)
      writeFileSync(brokenPath, text)
      writeFileSync(patchPath, restored.text)
      lastGood = restored.text
      log(`检测到配置异常（${result.reason}），已从快照 ${restored.name} 恢复；原文件另存为 ${brokenPath}。重启 DSH 后生效。`)
    } catch (error) {
      log(`恢复失败：${error.message}`)
    }
  }

  ctx.effect(() => {
    const settle = setTimeout(check, SETTLE_MS)
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    return () => {
      disposed = true
      clearTimeout(settle)
      clearInterval(timer)
    }
  })
}
