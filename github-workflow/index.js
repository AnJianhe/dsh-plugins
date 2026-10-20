/**
 * GitHub workflow tools for DeepSeek Harness.
 *
 * `github` talks to the GitHub REST API with a personal access token, so branches,
 * commits, pull requests, issues and reviews work even without a local clone.
 * `git` wraps the local repository for the parts that must happen on disk.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const API_ORIGIN = 'https://api.github.com'
const USER_AGENT = 'dsh-github-workflow/0.1.0'
const MAX_TEXT = 20000
const TOKEN_ENV_NAMES = ['GITHUB_TOKEN', 'GH_TOKEN']

const NO_TOKEN_HINT = [
  '没有找到 GitHub token。',
  '创建一个有 repo 权限的 Personal Access Token（https://github.com/settings/tokens），',
  '然后在 PowerShell 里执行 setx GITHUB_TOKEN "ghp_xxx" 并重开 Harness；',
  '或者把 GITHUB_TOKEN 写进 DSH 的凭据设置。',
].join('')

export const inject = ['tools', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(githubTool(ctx)))
  ctx.effect(() => ctx.tools.register(gitTool(ctx)))
  ctx.effect(() => registerDashboardRoute(ctx))
}

/* ------------------------------------------------------------------ helpers */

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function truncate(text, limit = MAX_TEXT) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字符）`
}

function renderResult(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: truncate(text) }]
}

async function sessionCwd(ctx, agent) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory && agent) {
    try {
      const dir = await workingDirectory.ensure(agent)
      if (dir) return dir
    } catch {}
  }
  return process.cwd()
}

async function runProcess(ctx, argv, cwd, signal) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) throw new Error('这个会话没有可用的子进程服务，无法运行本地命令。')
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 6 * 1024 * 1024 },
      stderr: { maxBytes: 512 * 1024 },
    },
    graceMs: 5000,
    signal,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : undefined
  const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : undefined
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout ? stdout.text : '',
    stderr: stderr ? stderr.text : '',
  }
}

function gitCandidates() {
  const list = []
  const push = (base, ...rest) => {
    if (base) list.push(`${base}\\${rest.join('\\')}`)
  }
  push(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe')
  push(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe')
  push(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')
  push(process.env.LOCALAPPDATA, 'Programs', 'PortableGit', 'cmd', 'git.exe')
  push(process.env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe')
  return list
}

/**
 * `git` on PATH when the machine has a normal install, otherwise the usual
 * per-user locations, so a portable or freshly unpacked Git works without
 * restarting the Host just to refresh its PATH.
 */
async function locateGit(ctx, cwd, signal) {
  const probe = await runProcess(ctx, ['git', '--version'], cwd, signal).catch(() => undefined)
  if (probe && probe.exitCode === 0) return 'git'
  for (const candidate of gitCandidates()) {
    if (!existsSync(candidate)) continue
    const check = await runProcess(ctx, [candidate, '--version'], cwd, signal).catch(() => undefined)
    if (check && check.exitCode === 0) return candidate
  }
  return undefined
}

async function runGitRaw(ctx, cwd, args, signal) {
  const executable = await locateGit(ctx, cwd, signal)
  if (!executable) {
    return {
      exitCode: -1,
      signal: null,
      stdout: '',
      stderr: '未找到 git。安装 Git for Windows 后重试，或把 git.exe 所在目录加入 PATH。',
    }
  }
  try {
    return await runProcess(ctx, [executable, ...args], cwd, signal)
  } catch (error) {
    return { exitCode: -1, signal: null, stdout: '', stderr: messageOf(error) }
  }
}

async function runGit(ctx, cwd, args, signal) {
  const result = await runGitRaw(ctx, cwd, args, signal)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`git ${args.join(' ')} 失败（exit ${result.exitCode}）：\n${truncate(detail, 4000)}`)
  }
  return result.stdout.trim()
}

function normalizeRepo(input) {
  const value = String(input ?? '').trim()
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value)
  if (!match) throw new Error(`repo 必须是 "owner/repo" 形式，收到：${value || '(空)'}`)
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') }
}

async function detectRemoteRepo(ctx, cwd, signal) {
  const result = await runGitRaw(ctx, cwd, ['remote', 'get-url', 'origin'], signal)
  if (result.exitCode !== 0) return undefined
  const url = result.stdout.trim()
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url)
  if (!match) return undefined
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`
}

/* --------------------------------------------------------------- credentials */

async function resolveToken(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials) {
    for (const name of TOKEN_ENV_NAMES) {
      try {
        const hit = await credentials.resolve(name)
        if (hit && hit.value) return { token: hit.value, source: hit.source || name }
      } catch {}
    }
  }
  for (const name of TOKEN_ENV_NAMES) {
    const value = process.env[name]
    if (value) return { token: value, source: `environment:${name}` }
  }
  return undefined
}

/* ------------------------------------------------------------------- REST */

async function requestRaw(token, method, endpoint, body, signal) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_ORIGIN}${endpoint}`
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`,
  }
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(url, { method, headers, body: payload, signal })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, ok: response.ok, data, headers: response.headers }
}

async function request(token, method, endpoint, body, signal) {
  const result = await requestRaw(token, method, endpoint, body, signal)
  if (result.ok) return result
  const detail = result.data && typeof result.data === 'object'
    ? String(result.data.message ?? '')
    : String(result.data ?? '')
  const extra = result.data && Array.isArray(result.data.errors)
    ? ` ${result.data.errors.map((item) => item?.message ?? JSON.stringify(item)).join('; ')}`
    : ''
  const path = endpoint.startsWith('http') ? new URL(endpoint).pathname : endpoint
  throw new Error(`GitHub ${method} ${path} 失败（${result.status}）：${detail}${extra}`.slice(0, 1500))
}

/* ------------------------------------------------------- GitHub tool actions */

async function githubStatus(ctx, token, cwd, signal) {
  const result = { action: 'status', authenticated: false }
  if (!token) {
    result.hint = NO_TOKEN_HINT
  } else {
    try {
      const { data, headers } = await request(token.token, 'GET', '/user', undefined, signal)
      result.authenticated = true
      result.login = data.login
      result.name = data.name
      result.tokenSource = token.source
      result.scopes = headers.get('x-oauth-scopes') || '(未报告)'
    } catch (error) {
      result.error = messageOf(error)
    }
  }

  const version = await runGitRaw(ctx, cwd, ['--version'], signal)
  result.git = version.exitCode === 0 ? version.stdout.trim() : '未安装或不可用'
  if (version.exitCode === 0) {
    const remote = await detectRemoteRepo(ctx, cwd, signal)
    result.cwd = cwd
    result.detectedRepo = remote ?? '(当前目录没有 GitHub origin 远端)'
  }
  return result
}

async function pushFiles(token, owner, repo, { branch, message, files = [], deletions = [] }, signal) {
  if (!message) throw new Error('commit 需要 message。')
  const changes = [
    ...files.map((file) => ({ path: file.path, content: file.content })),
    ...deletions.map((path) => ({ path, content: null })),
  ]
  if (changes.length === 0) throw new Error('commit 至少需要一个 files 或 deletions 项。')

  const base = `/repos/${owner}/${repo}`
  const { data: info } = await request(token, 'GET', base, undefined, signal)
  const targetBranch = branch || info.default_branch

  let headSha
  const refResult = await requestRaw(token, 'GET', `${base}/git/ref/heads/${targetBranch}`, undefined, signal)
  if (refResult.ok) {
    headSha = refResult.data.object.sha
  } else if (refResult.status === 404) {
    const { data: defaultRef } = await request(token, 'GET', `${base}/git/ref/heads/${info.default_branch}`, undefined, signal)
    headSha = defaultRef.object.sha
    await request(token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${targetBranch}`, sha: headSha }, signal)
  } else {
    throw new Error(`读取分支 ${targetBranch} 失败（${refResult.status}）：${JSON.stringify(refResult.data).slice(0, 400)}`)
  }

  const { data: parent } = await request(token, 'GET', `${base}/git/commits/${headSha}`, undefined, signal)

  const entries = []
  for (const change of changes) {
    if (change.content === null) {
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const { data: blob } = await request(token, 'POST', `${base}/git/blobs`, {
      content: change.content,
      encoding: 'utf-8',
    }, signal)
    entries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const { data: tree } = await request(token, 'POST', `${base}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: entries,
  }, signal)
  const { data: commit } = await request(token, 'POST', `${base}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [headSha],
  }, signal)
  await request(token, 'PATCH', `${base}/git/refs/heads/${targetBranch}`, { sha: commit.sha, force: false }, signal)

  return {
    action: 'commit',
    branch: targetBranch,
    commit: commit.sha,
    url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    files: changes.map((change) => change.path),
    deletions: deletions.length,
  }
}

function githubTool(ctx) {
  return {
    name: 'github',
    description:
      '通过 GitHub REST API 操作仓库：查看认证状态与仓库信息、读取文件、把文件直接提交到分支、管理分支、'
      + '创建/查看/评论/审阅/合并 PR，以及创建和评论 issue。认证读取 GITHUB_TOKEN 或 GH_TOKEN。'
      + '省略 repo 时从当前工作目录的 origin 远端推断。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'repo', 'branches', 'file', 'commit',
            'prs', 'pr', 'pr_create', 'pr_merge', 'pr_comment', 'pr_review',
            'issues', 'issue_create', 'issue_comment', 'api',
          ],
          description: '要执行的操作。',
        },
        repo: { type: 'string', description: '"owner/repo"。省略时从当前工作目录的 git origin 远端推断。' },
        number: { type: 'integer', description: 'PR 或 issue 编号：用于 pr、pr_merge、pr_comment、pr_review、issue_comment。' },
        title: { type: 'string', description: 'pr_create 或 issue_create 的标题。' },
        body: { type: 'string', description: 'PR/issue 正文、评论内容或审阅说明，Markdown。' },
        head: { type: 'string', description: 'pr_create 的源分支，例如 "feature-x" 或 "someone:feature-x"。' },
        base: { type: 'string', description: 'pr_create 的目标分支，默认仓库默认分支。' },
        draft: { type: 'boolean', description: 'pr_create 是否创建为草稿 PR。' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'prs / issues 列表的状态过滤，默认 open。' },
        mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'pr_merge 的合并方式，默认 merge。' },
        event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'pr_review 的审阅结论。' },
        path: { type: 'string', description: 'file 的仓库内路径。' },
        ref: { type: 'string', description: 'file 读取的分支名或 commit SHA，默认默认分支。' },
        branch: { type: 'string', description: 'commit 的目标分支；分支不存在时从默认分支创建。' },
        message: { type: 'string', description: 'commit 的提交信息。' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string', description: '文件的完整 UTF-8 内容。' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
          description: 'commit 要写入或覆盖的文件。',
        },
        deletions: {
          type: 'array',
          items: { type: 'string' },
          description: 'commit 要删除的文件路径。',
        },
        labels: { type: 'array', items: { type: 'string' }, description: 'issue_create 的标签名。' },
        limit: { type: 'integer', description: '列表返回条数，默认 20，最大 100。' },
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'api 的 HTTP 方法，默认 GET。' },
        endpoint: { type: 'string', description: 'api 的 REST 路径，例如 "/repos/o/r/actions/runs"，也可给完整 URL。' },
        payload: { type: 'object', description: 'api 的原始 JSON 请求体。' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object' }, render: renderResult },
    async execute(args, exec) {
      const input = args ?? {}
      const action = String(input.action ?? '')
      const signal = exec.signal
      const cwd = await sessionCwd(ctx, exec.agent)
      const token = await resolveToken(ctx)

      if (action === 'status') return githubStatus(ctx, token, cwd, signal)
      if (!token) throw new Error(NO_TOKEN_HINT)

      let repoValue = input.repo
      if (!repoValue) repoValue = await detectRemoteRepo(ctx, cwd, signal)
      if (!repoValue) {
        throw new Error('缺少 repo，且当前目录推断不出 GitHub 远端。请显式传 repo="owner/repo"。')
      }
      const { owner, repo } = normalizeRepo(repoValue)
      const R = `/repos/${owner}/${repo}`
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)

      if (action === 'repo') {
        const { data } = await request(token.token, 'GET', R, undefined, signal)
        return {
          action,
          repo: data.full_name,
          defaultBranch: data.default_branch,
          private: data.private,
          url: data.html_url,
          stars: data.stargazers_count,
          openIssues: data.open_issues_count,
          permissions: data.permissions,
        }
      }

      if (action === 'branches') {
        const { data } = await request(token.token, 'GET', `${R}/branches?per_page=${limit}`, undefined, signal)
        return {
          action,
          branches: data.map((item) => ({ name: item.name, sha: item.commit?.sha?.slice(0, 7) })),
        }
      }

      if (action === 'file') {
        if (!input.path) throw new Error('file 需要 path。')
        const encoded = String(input.path).split('/').map(encodeURIComponent).join('/')
        const suffix = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ''
        const { data } = await request(token.token, 'GET', `${R}/contents/${encoded}${suffix}`, undefined, signal)
        if (Array.isArray(data)) {
          return {
            action,
            kind: 'directory',
            path: input.path,
            entries: data.map((entry) => ({ path: entry.path, type: entry.type, size: entry.size })),
          }
        }
        const content = data.content ? Buffer.from(data.content, data.encoding ?? 'base64').toString('utf8') : ''
        return {
          action,
          path: data.path,
          sha: data.sha,
          size: data.size,
          url: data.html_url,
          content: truncate(content, 16000),
        }
      }

      if (action === 'commit') {
        return pushFiles(token.token, owner, repo, {
          branch: input.branch,
          message: input.message,
          files: Array.isArray(input.files) ? input.files : [],
          deletions: Array.isArray(input.deletions) ? input.deletions : [],
        }, signal)
      }

      if (action === 'prs') {
        const state = input.state ?? 'open'
        const { data } = await request(
          token.token,
          'GET',
          `${R}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
          undefined,
          signal,
        )
        return {
          action,
          repo: `${owner}/${repo}`,
          state,
          pullRequests: data.map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            draft: item.draft,
            user: item.user?.login,
            head: item.head?.ref,
            base: item.base?.ref,
            updatedAt: item.updated_at,
            url: item.html_url,
          })),
        }
      }

      if (action === 'pr') {
        if (!input.number) throw new Error('pr 需要 number。')
        const [{ data: pr }, { data: files }] = await Promise.all([
          request(token.token, 'GET', `${R}/pulls/${input.number}`, undefined, signal),
          request(token.token, 'GET', `${R}/pulls/${input.number}/files?per_page=100`, undefined, signal),
        ])
        return {
          action,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          merged: pr.merged,
          mergeable: pr.mergeable,
          user: pr.user?.login,
          head: `${pr.head?.label}`,
          base: `${pr.base?.label}`,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
          url: pr.html_url,
          body: truncate(pr.body ?? '', 4000),
          files: files.slice(0, 50).map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch ? truncate(file.patch, 1500) : undefined,
          })),
        }
      }

      if (action === 'pr_create') {
        let base = input.base
        if (!base) {
          const { data } = await request(token.token, 'GET', R, undefined, signal)
          base = data.default_branch
        }
        if (!input.title) throw new Error('pr_create 需要 title。')
        if (!input.head) throw new Error('pr_create 需要 head（源分支）。')
        const { data } = await request(token.token, 'POST', `${R}/pulls`, {
          title: input.title,
          head: input.head,
          base,
          body: input.body ?? '',
          draft: Boolean(input.draft),
        }, signal)
        return {
          action,
          number: data.number,
          title: data.title,
          head: data.head?.ref,
          base: data.base?.ref,
          url: data.html_url,
        }
      }

      if (action === 'pr_merge') {
        if (!input.number) throw new Error('pr_merge 需要 number。')
        const { data } = await request(token.token, 'PUT', `${R}/pulls/${input.number}/merge`, {
          merge_method: input.mergeMethod ?? 'merge',
        }, signal)
        return { action, number: input.number, merged: data.merged, message: data.message, sha: data.sha }
      }

      if (action === 'pr_comment') {
        if (!input.number) throw new Error('pr_comment 需要 number。')
        if (!input.body) throw new Error('pr_comment 需要 body。')
        const { data } = await request(token.token, 'POST', `${R}/issues/${input.number}/comments`, {
          body: input.body,
        }, signal)
        return { action, id: data.id, url: data.html_url }
      }

      if (action === 'pr_review') {
        if (!input.number) throw new Error('pr_review 需要 number。')
        const { data } = await request(token.token, 'POST', `${R}/pulls/${input.number}/reviews`, {
          event: input.event ?? 'COMMENT',
          body: input.body ?? '',
        }, signal)
        return { action, state: data.state, id: data.id, url: data.html_url }
      }

      if (action === 'issues') {
        const state = input.state ?? 'open'
        const { data } = await request(
          token.token,
          'GET',
          `${R}/issues?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
          undefined,
          signal,
        )
        return {
          action,
          repo: `${owner}/${repo}`,
          state,
          issues: data
            .filter((item) => !item.pull_request)
            .map((item) => ({
              number: item.number,
              title: item.title,
              state: item.state,
              user: item.user?.login,
              labels: (item.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
              updatedAt: item.updated_at,
              url: item.html_url,
            })),
        }
      }

      if (action === 'issue_create') {
        if (!input.title) throw new Error('issue_create 需要 title。')
        const { data } = await request(token.token, 'POST', `${R}/issues`, {
          title: input.title,
          body: input.body ?? '',
          labels: Array.isArray(input.labels) ? input.labels : undefined,
        }, signal)
        return { action, number: data.number, title: data.title, url: data.html_url }
      }

      if (action === 'issue_comment') {
        if (!input.number) throw new Error('issue_comment 需要 number。')
        if (!input.body) throw new Error('issue_comment 需要 body。')
        const { data } = await request(token.token, 'POST', `${R}/issues/${input.number}/comments`, {
          body: input.body,
        }, signal)
        return { action, id: data.id, url: data.html_url }
      }

      if (action === 'api') {
        if (!input.endpoint) throw new Error('api 需要 endpoint。')
        const method = String(input.method ?? 'GET').toUpperCase()
        const result = await requestRaw(token.token, method, input.endpoint, input.payload, signal)
        return {
          action,
          status: result.status,
          ok: result.ok,
          data: typeof result.data === 'string' ? truncate(result.data, 8000) : result.data,
        }
      }

      throw new Error(`未知的 github action：${action}`)
    },
  }
}

/* ------------------------------------------------------------ git tool */

function parseStatusOutput(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
  let branch
  let upstream
  let ahead = 0
  let behind = 0

  if (lines[0]?.startsWith('## ')) {
    let head = lines.shift().slice(3).trim()
    const bracket = /\[([^\]]*)\]/.exec(head)
    if (bracket) {
      const aheadMatch = /ahead (\d+)/.exec(bracket[1])
      const behindMatch = /behind (\d+)/.exec(bracket[1])
      if (aheadMatch) ahead = Number(aheadMatch[1])
      if (behindMatch) behind = Number(behindMatch[1])
      head = head.replace(/\s*\[[^\]]*\]/, '').trim()
    }
    const [namePart, upstreamPart] = head.split('...')
    branch = namePart.trim()
    if (upstreamPart) upstream = upstreamPart.trim()
  }

  const files = lines.map((line) => ({
    status: line.slice(0, 2).trim() || '??',
    path: line.slice(3).trim(),
  }))

  return { branch, upstream, ahead, behind, clean: files.length === 0, files }
}

function gitTool(ctx) {
  return {
    name: 'git',
    description:
      '在本地仓库执行常用 git 操作：查看状态与改动、提交、推送、拉取、切换和创建分支。'
      + '仓库目录默认是当前会话工作目录。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'diff', 'log', 'branches', 'remotes', 'add', 'commit', 'push', 'pull', 'fetch', 'switch'],
          description: '要执行的操作。',
        },
        cwd: { type: 'string', description: '仓库目录，默认当前会话工作目录。' },
        paths: { type: 'array', items: { type: 'string' }, description: 'add 的文件路径；省略时添加工作区全部改动。' },
        message: { type: 'string', description: 'commit 的提交信息。' },
        all: { type: 'boolean', description: 'commit 前先暂存全部改动。' },
        staged: { type: 'boolean', description: 'diff 只显示已暂存的改动。' },
        branch: { type: 'string', description: 'switch 的目标分支；push/pull 省略时用当前分支。' },
        remote: { type: 'string', description: '远端名，默认 origin。' },
        create: { type: 'boolean', description: 'switch 时创建分支。' },
        force: { type: 'boolean', description: 'push 时强制推送；使用 --force-with-lease，会覆盖远端该分支历史。' },
        setUpstream: { type: 'boolean', description: 'push 时设置上游分支，默认 true。' },
        limit: { type: 'integer', description: 'log 的提交条数，默认 15。' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object' }, render: renderResult },
    async execute(args, exec) {
      const input = args ?? {}
      const action = String(input.action ?? '')
      const signal = exec.signal
      const cwd = input.cwd ? String(input.cwd) : await sessionCwd(ctx, exec.agent)

      const version = await runGitRaw(ctx, cwd, ['--version'], signal)
      if (version.exitCode !== 0) {
        throw new Error(`无法运行 git，请先安装 Git for Windows。详情：${(version.stderr || version.stdout).trim()}`)
      }

      if (action === 'status') {
        const text = await runGit(ctx, cwd, ['status', '--porcelain=v1', '--branch'], signal)
        return { action, cwd, ...parseStatusOutput(text) }
      }

      if (action === 'diff') {
        const argv = ['diff']
        if (input.staged) argv.push('--staged')
        if (Array.isArray(input.paths) && input.paths.length > 0) argv.push('--', ...input.paths)
        const diff = await runGit(ctx, cwd, argv, signal)
        return { action, staged: Boolean(input.staged), diff: diff ? truncate(diff) : '(无改动)' }
      }

      if (action === 'log') {
        const count = Math.min(Math.max(Number(input.limit) || 15, 1), 100)
        const result = await runGitRaw(ctx, cwd, [
          'log', '-n', String(count), '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short',
        ], signal)
        if (result.exitCode !== 0) return { action, commits: [], note: '当前仓库还没有提交。' }
        const commits = result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [sha, author, date, ...rest] = line.split('\t')
            return { sha, author, date, subject: rest.join('\t') }
          })
        return { action, commits }
      }

      if (action === 'branches') {
        const text = await runGit(ctx, cwd, ['branch', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)'], signal)
        const branches = text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [name, marker, upstream] = line.split('\t')
            return { name, current: marker === '*', upstream: upstream || undefined }
          })
        return { action, branches }
      }

      if (action === 'remotes') {
        const text = await runGit(ctx, cwd, ['remote', '-v'], signal)
        return { action, remotes: text.split(/\r?\n/).filter(Boolean) }
      }

      if (action === 'add') {
        const argv = ['add']
        if (Array.isArray(input.paths) && input.paths.length > 0) argv.push('--', ...input.paths)
        else argv.push('--all')
        await runGit(ctx, cwd, argv, signal)
        const statusText = await runGit(ctx, cwd, ['status', '--porcelain=v1'], signal)
        return {
          action,
          added: Array.isArray(input.paths) && input.paths.length > 0 ? input.paths : '(全部改动)',
          staged: parseStatusOutput(statusText).files,
        }
      }

      if (action === 'commit') {
        if (!input.message) throw new Error('commit 需要 message。')
        if (input.all) await runGit(ctx, cwd, ['add', '--all'], signal)
        const staged = await runGitRaw(ctx, cwd, ['diff', '--cached', '--name-only'], signal)
        if (!staged.stdout.trim()) {
          throw new Error('没有已暂存的改动。先执行 add，或在 commit 时传 all=true。')
        }
        const output = await runGit(ctx, cwd, ['commit', '-m', String(input.message)], signal)
        const sha = (await runGitRaw(ctx, cwd, ['rev-parse', '--short', 'HEAD'], signal)).stdout.trim()
        return { action, sha, output: truncate(output, 4000) }
      }

      if (action === 'push') {
        const remote = input.remote ? String(input.remote) : 'origin'
        const branch = input.branch
          ? String(input.branch)
          : await runGit(ctx, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
        const argv = ['push']
        if (input.setUpstream !== false) argv.push('-u')
        if (input.force) argv.push('--force-with-lease')
        argv.push(remote, branch)
        const output = await runGit(ctx, cwd, argv, signal)
        return { action, remote, branch, output: truncate(output, 6000) }
      }

      if (action === 'pull') {
        const remote = input.remote ? String(input.remote) : 'origin'
        const argv = ['pull', '--ff-only', remote]
        if (input.branch) argv.push(String(input.branch))
        const output = await runGit(ctx, cwd, argv, signal)
        return { action, remote, output: truncate(output, 6000) }
      }

      if (action === 'fetch') {
        const remote = input.remote ? String(input.remote) : 'origin'
        const output = await runGit(ctx, cwd, ['fetch', remote, '--prune'], signal)
        return { action, remote, output: truncate(output || '(已是最新)', 3000) }
      }

      if (action === 'switch') {
        if (!input.branch) throw new Error('switch 需要 branch。')
        const argv = ['switch']
        if (input.create) argv.push('-c')
        argv.push(String(input.branch))
        const output = await runGit(ctx, cwd, argv, signal)
        return { action, branch: input.branch, output: truncate(output, 3000) }
      }

      throw new Error(`未知的 git action：${action}`)
    },
  }
}

/* ------------------------------------------------------------- dashboard */

async function dashboardCwd(ctx, requested) {
  if (requested) return requested
  const workingDirectory = ctx.get('workingDirectory')
  const agents = ctx.get('agents')
  if (workingDirectory && agents) {
    try {
      for (const agent of agents.list()) {
        try {
          const dir = await workingDirectory.ensure(agent)
          if (dir) return dir
        } catch {}
      }
    } catch {}
  }
  if (workingDirectory) {
    try {
      const dir = workingDirectory.defaultDirectory
      if (dir) return dir
    } catch {}
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry) {
    try {
      const workspaces = (await registry.list()) ?? []
      for (const workspace of workspaces) {
        if (workspace?.path) return workspace.path
      }
    } catch {}
  }
  return process.cwd()
}

function summarisePullRequest(item) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    draft: Boolean(item.draft),
    user: item.user?.login,
    head: item.head?.ref,
    base: item.base?.ref,
    updatedAt: item.updated_at,
    url: item.html_url,
  }
}

function discoverRepositories(root) {
  const found = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, '.git'))) continue
    let touched = 0
    try {
      touched = statSync(join(dir, '.git')).mtimeMs
    } catch {}
    found.push({ name: entry.name, path: dir, touched })
  }
  found.sort((left, right) => right.touched - left.touched)
  return found.slice(0, 8)
}

async function readGitState(ctx, dir) {
  const status = await runGitRaw(ctx, dir, ['status', '--porcelain=v1', '--branch'], undefined)
  if (status.exitCode !== 0) return undefined
  const parsed = parseStatusOutput(status.stdout)
  const remote = (await detectRemoteRepo(ctx, dir, undefined)) ?? null
  const log = await runGitRaw(ctx, dir, ['log', '-n', '3', '--pretty=format:%h%x09%s'], undefined)
  const recentCommits = log.exitCode === 0
    ? log.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split('\t')
          return { sha, subject: rest.join('\t') }
        })
    : []
  return { ...parsed, remote, recentCommits }
}

/** Everything the Web panel shows: local repository state first, GitHub only when a token exists. */
async function buildDashboard(ctx, requested) {
  const root = await dashboardCwd(ctx, requested)
  const payload = { generatedAt: Date.now(), root }

  let local = await readGitState(ctx, root)
  let repoDir = root
  if (!local) {
    const repositories = discoverRepositories(root)
    payload.repositories = repositories.map((entry) => ({ name: entry.name, path: entry.path }))
    if (repositories.length > 0) {
      repoDir = repositories[0].path
      local = await readGitState(ctx, repoDir)
    }
  }
  if (local) {
    local.path = repoDir
  } else {
    local = { error: '当前目录不是 git 仓库', path: root }
  }
  payload.local = local

  const token = await resolveToken(ctx)
  if (!token) {
    payload.authenticated = false
    return payload
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const user = await request(token.token, 'GET', '/user', undefined, controller.signal)
    payload.authenticated = true
    payload.user = { login: user.data.login, name: user.data.name, avatar: user.data.avatar_url }

    const repo = payload.local?.remote
    if (repo) {
      const base = `/repos/${repo}`
      const [prs, runs] = await Promise.all([
        request(
          token.token,
          'GET',
          `${base}/pulls?state=open&per_page=5&sort=updated&direction=desc`,
          undefined,
          controller.signal,
        ),
        request(token.token, 'GET', `${base}/actions/runs?per_page=3`, undefined, controller.signal),
      ])
      payload.pullRequests = prs.data.map(summarisePullRequest)
      payload.runs = runs.data.workflow_runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        branch: run.head_branch,
        url: run.html_url,
      }))
    }
  } catch (error) {
    payload.error = messageOf(error)
  } finally {
    clearTimeout(timer)
  }
  return payload
}


function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function registerDashboardRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return () => {}

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === '/github-workflow/v5/summary') {
        return sendJson(res, 200, await buildDashboard(ctx, url.searchParams.get('cwd') || undefined))
      }
      return sendJson(res, 404, { error: `未知接口：${path}` })
    } catch (error) {
      return sendJson(res, 500, { error: messageOf(error) })
    }
  }

  const disposeSummary = webServer.register({
    kind: 'exact',
    path: '/github-workflow/v5/summary',
    handler,
  })
  return () => {
    disposeSummary()
  }
}
