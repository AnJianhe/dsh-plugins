/**
 * UI fixes: the session-delete backend.
 *
 * The Host has no delete-session API — `sessions` is an in-memory store and the
 * UI only offers archive. This removes the on-disk session directory and its
 * projection cache, after refusing anything that is still live.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = '/ui-fixes/v1/'
const SESSION_ID = /^session-[0-9a-zA-Z-]+$/

export const inject = ['webServer']

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Every on-disk location that belongs to one session. */
function sessionPaths(id) {
  const home = dshHome()
  const paths = []

  const sessionsRoot = join(home, 'sessions')
  if (existsSync(sessionsRoot)) {
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(sessionsRoot, entry.name, id)
      if (existsSync(candidate)) paths.push(candidate)
    }
  }

  const projection = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  if (existsSync(projection)) paths.push(projection)

  return paths
}

function isInside(path, root) {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const base = root.replace(/\\/g, '/').toLowerCase()
  return normalized.startsWith(base.endsWith('/') ? base : `${base}/`)
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

async function deleteSession(ctx, rawId) {
  const id = String(rawId ?? '').trim()
  if (!SESSION_ID.test(id)) throw new Error('会话 id 格式不对，已拒绝。')

  const live = ctx.get('sessions')
  if (live && live.get(id)) {
    throw new Error('这个会话还在运行，先停掉它再删除。')
  }

  const paths = sessionPaths(id)
  if (paths.length === 0) {
    throw new Error('没有找到这个会话的磁盘数据，可能已经被删掉了。')
  }

  const home = dshHome()
  for (const path of paths) {
    if (!isInside(path, home)) throw new Error(`拒绝删除 ${home} 之外的路径：${path}`)
  }

  for (const path of paths) rmSync(path, { recursive: true, force: true })
  return { sessionId: id, deleted: paths }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return () => {}

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === `${BASE}session/delete`) {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          return sendJson(res, 405, { error: '只接受 POST' })
        }
        const body = await readBody(req)
        return sendJson(res, 200, await deleteSession(ctx, body.sessionId))
      }
      if (path === `${BASE}session/paths`) {
        const id = String(url.searchParams.get('sessionId') ?? '')
        if (!SESSION_ID.test(id)) return sendJson(res, 400, { error: '会话 id 格式不对' })
        return sendJson(res, 200, { sessionId: id, paths: sessionPaths(id), home: dshHome() })
      }
      if (path === `${BASE}model`) {
        const selection = ctx.get('agentDefaultModel')
        if (!selection) return sendJson(res, 503, { error: '模型服务不可用' })
        const current = selection.currentSelection()
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          return sendJson(res, 200, { selection: current, keys: Object.keys(current ?? {}) })
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          return sendJson(res, 405, { error: '只接受 GET 或 POST' })
        }
        const body = await readBody(req)
        const effort = body.reasoningEffort
        if (typeof effort !== 'string' || effort.trim() === '') {
          return sendJson(res, 400, { error: 'reasoningEffort 必须是非空字符串' })
        }
        const next = { ...current, reasoningEffort: effort.trim() }
        await selection.saveSelection(next)
        return sendJson(res, 200, { selection: next })
      }
      return sendJson(res, 404, { error: `未知接口：${path}` })
    } catch (error) {
      return sendJson(res, 500, { error: messageOf(error) })
    }
  }

  const disposeDelete = webServer.register({ kind: 'exact', path: `${BASE}session/delete`, handler })
  const disposePaths = webServer.register({ kind: 'exact', path: `${BASE}session/paths`, handler })
  return () => {
    disposeDelete()
    disposePaths()
  }
}

export function apply(ctx) {
  ctx.effect(() => registerRoutes(ctx))
}
