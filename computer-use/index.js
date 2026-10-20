/**
 * Computer Use — 让智能体看到并操控整台 Windows 电脑。
 *
 * 屏幕截取、鼠标、键盘、启动应用都由一个常驻的 PowerShell 辅助进程完成；
 * 每次操作时屏幕四周会亮起渐变光晕，提示用户「电脑正被接管」。
 */
import { spawn } from 'node:child_process'
import { validateArgs } from './lib/validation.js'
import { mkdtempSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_SCRIPT = fileURLToPath(new URL('./lib/helper.ps1', import.meta.url))
const GLOW_SCRIPT = fileURLToPath(new URL('./lib/glow.ps1', import.meta.url))

/** 工具注册表是唯一硬依赖；截图用的 attachments 在调用时按需解析。 */
export const inject = ['tools']

const DEFAULTS = {
  /** 光晕停留时间：一次操作后边缘保持高亮的毫秒数。 */
  glowDurationMs: 4200,
  /** 光晕内侧淡出厚度（像素）。 */
  glowThickness: 44,
  /** 光晕渐变起始色。 */
  glowColorA: '#4FD1FF',
  /** 光晕渐变结束色。 */
  glowColorB: '#B07BFF',
  /** 光晕亮度 0~1。 */
  glowIntensity: 0.92,
  /** 为 false 时完全不显示光晕。 */
  showGlow: true,
  /** 截图上叠加坐标网格，让模型无论看到多大的图都能读出屏幕坐标。 */
  screenshotGrid: true,
  // 旧 abortCooldownMs 配置被忽略：ESC 持续暂停至本地重启。
  /** 单次截图等待上限（毫秒）。 */
  screenshotTimeoutMs: 25000,
  /** 单次操作的等待上限（毫秒）。 */
  actionTimeoutMs: 15000,
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/** 常驻的 PowerShell 输入辅助进程；按顺序串行处理请求，崩溃后下次调用自动重启。 */
export class HelperProcess {
  constructor(workDir, spawnProcess = spawn) {
    this.workDir = workDir
    this.spawnProcess = spawnProcess
    this.proc = null
    this.buffer = ''
    this.stderr = ''
    this.pending = new Map()
    this.seq = 0
    this.disposed = false
  }

  _spawn() {
    this.buffer = ''
    this.stderr = ''
    const proc = this.spawnProcess('powershell.exe', [...POWERSHELL_ARGS, HELPER_SCRIPT, '-AbortFile', join(this.workDir, 'abort.json'), '-CancelFile', join(this.workDir, 'cancel')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    proc.stdin.on?.('error', (error) => {
      if (this.proc !== proc) return
      this.disposed = true
      this._failAll(new Error(`电脑操作通信中断：${error.message}`))
      try { proc.kill() } catch {}
    })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this._onData(chunk) })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      if (this.proc === proc) this.stderr = (this.stderr + chunk).slice(-4000)
    })
    proc.on('error', (error) => { if (this.proc === proc) { this.proc = null; this._failAll(new Error(`电脑操作辅助进程无法启动：${error.message}`)) } })
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      this._failAll(new Error(`computer helper exited (code ${String(code)})${this.stderr ? `: ${this.stderr.slice(-400)}` : ''}`))
    })
    this.proc = proc
    return proc
  }

  _failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  _onData(chunk) {
    this.buffer += chunk
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let frame
      try {
        frame = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
      } catch {
        continue
      }
      const entry = this.pending.get(frame.id)
      if (!entry) continue
      this.pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame.data)
      else entry.reject(new Error(frame.error || 'computer helper failed'))
    }
  }

  async call(cmd, args = {}, timeoutMs = 15000) {
    if (this.stopping) await this.stopping
    if (this.disposed) return Promise.reject(new Error('computer helper has been disposed'))
    if (!this.proc) this._spawn()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const proc = this.proc
        this.proc = null
        let cancelFailed = false
        try { writeFileSync(join(this.workDir, 'cancel'), '1') } catch {
          this.disposed = true
          cancelFailed = true
        }
        this.stopping = new Promise((resolve) => {
          let settled = false
          const done = () => { if (!settled) { settled = true; clearTimeout(watchdog); resolve() } }
          const watchdog = setTimeout(() => { this.disposed = true; done() }, 2000)
          if (!proc) { done(); return }
          proc.once('exit', done)
          setTimeout(() => { try { proc.kill() } catch { this.disposed = true; done() } }, cancelFailed ? 0 : 150)
        })
        this._failAll(new Error(`电脑操作 ${cmd} 超时（${timeoutMs} 毫秒），已取消并终止辅助进程。`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const payload = Buffer.from(JSON.stringify({ id, cmd, ...args }), 'utf8').toString('base64')
      try {
        this.proc.stdin.write(`${payload}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  dispose() {
    this.disposed = true
    try { writeFileSync(join(this.workDir, 'cancel'), '1') } catch { try { this.proc?.kill() } catch {} }
    this._failAll(new Error('电脑操作辅助进程已关闭。'))
    if (!this.proc) return
    const proc = this.proc
    this.proc = null
    try {
      proc.stdin.end()
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }, 400).unref?.()
  }
}

/** 屏幕边缘光晕：一个独立的常驻 PowerShell 进程，通过状态文件驱动。 */
export class GlowController {
  constructor(options, workDir) {
    this.options = options
    this.statePath = join(workDir, 'glow-state.json')
    this.abortPath = join(workDir, 'abort.json')
    this.proc = null
    this.until = 0
    this.suppressed = false
    this.disposed = false
    this._write()
  }

  /** 用户是否刚按下 ESC 中止了操作。中止窗口内的调用一律拒绝。 */
  abortedRecently() {
    try {
      readFileSync(this.abortPath, 'utf8')
      return true
    } catch {
      return false
    }
  }

  _write(patch = {}) {
    if (this.disposed && patch.quit !== true) return
    const state = {
      until: this.until,
      suppressed: this.suppressed,
      quit: false,
      intensity: this.options.showGlow ? this.options.glowIntensity : 0,
      ...patch,
    }
    try {
      const temp = `${this.statePath}.tmp`
      writeFileSync(temp, JSON.stringify(state), 'utf8')
      renameSync(temp, this.statePath)
    } catch {
      /* 状态文件写入失败不应影响操作本身 */
    }
  }

  _ensure() {
    if (this.proc) return
    rmSync(`${this.statePath}.ready`, { force: true })
    rmSync(`${this.statePath}.hidden`, { force: true })
    try {
      this.proc = spawn(
        'powershell.exe',
        [...POWERSHELL_ARGS, GLOW_SCRIPT,
          '-StateFile', this.statePath,
          '-ColorA', this.options.glowColorA,
          '-ColorB', this.options.glowColorB,
          '-Thickness', String(this.options.glowThickness),
          '-ParentPid', String(process.pid),
          '-AbortFile', this.abortPath],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      )
      this.proc.stderr.setEncoding('utf8')
      this.proc.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr || '') + chunk
      })
      this.proc.on('error', () => {
        this.proc = null
      })
      this.proc.on('exit', () => {
        this.proc = null
      })
    } catch {
      this.proc = null
    }
  }

  /** 标记「正在操作」，光晕亮起到指定时刻。 */
  pulse() {
    this._ensure()
    this.until = Date.now() + 60000
    this._write()
  }

  async ready() {
    const deadline = Date.now() + 15000
    while (true) {
      try { if (readFileSync(`${this.statePath}.ready`, 'utf8') === '1') return } catch {}
      if (!this.proc || Date.now() >= deadline) throw new Error(`无法启用电脑操作急停监听。${this.stderr || ''}`)
      await delay(20)
    }
  }

  /** 光晕当前是否处于可见状态。 */
  isActive() {
    return this.until > Date.now()
  }

  /** 截屏前临时隐藏光晕，避免把边框一起拍进去。 */
  async withSuppressed(ms, fn) {
    if (!this.isActive()) return fn()
    rmSync(`${this.statePath}.hidden`, { force: true })
    this.suppressed = true
    this._write()
    try {
    const deadline = Date.now() + 5000
    while (true) {
      try { if (readFileSync(`${this.statePath}.hidden`, 'utf8') === '1') break } catch {}
      if (Date.now() >= deadline) throw new Error('截图前无法确认光晕已隐藏，已取消截图。')
      await delay(20)
    }
      return await fn()
    } finally {
      this.suppressed = false
      this._write()
    }
  }

  stop() { this.until = 0; this._write() }

  dispose() {
    this.disposed = true
    this._write({ quit: true })
    const proc = this.proc
    this.proc = null
    if (!proc) return
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }, 500).unref?.()
  }
}

export function buildParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['screenshot', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'launch', 'wait'],
        description: [
          'screenshot：截取屏幕并返回图片，这是观察界面的唯一方式；',
          'move：把鼠标移到 (x, y)；',
          'click：在 (x, y) 点击，button 选 left/right/middle，count 为 2 表示双击；',
          'drag：从 (x, y) 拖到 (to_x, to_y)；',
          'scroll：在 (x, y) 处滚动，amount 为正向上、为负向下；',
          'type：向当前焦点输入一段文本（支持中文）；',
          'key：按一个键或组合键，如 "enter"、"ctrl+c"、"alt+tab"；',
          'launch：启动程序或打开文件/网址；',
          'wait：等待 ms 毫秒，用于等界面加载。',
        ].join(' '),
      },
      x: { type: 'integer', description: '物理像素横坐标，多屏可为负数；以截图为准，与 y 同时提供。' },
      y: { type: 'integer', description: '物理像素纵坐标，多屏可为负数。' },
      to_x: { type: 'integer', description: 'drag 必填，终点横坐标。' },
      to_y: { type: 'integer', description: 'drag 必填，终点纵坐标。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '点击键，默认 left。' },
      count: { type: 'integer', description: '点击次数，2 表示双击。' },
      text: { type: 'string', description: '要输入的文本。' },
      keys: { type: 'string', description: '键名或组合键，如 "enter"、"ctrl+shift+s"、"alt+f4"。' },
      amount: { type: 'integer', description: '滚轮格数，正数向上、负数向下。' },
      command: { type: 'string', description: '要启动的程序、文件路径或网址。' },
      args: { type: 'string', description: '启动命令的附加参数。' },
      ms: { type: 'integer', description: '等待毫秒数，上限 10000。' },
      region: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', description: '区域左上角横坐标。' },
          y: { type: 'number', description: '区域左上角纵坐标。' },
          width: { type: 'number', description: '区域宽度。' },
          height: { type: 'number', description: '区域高度。' },
        },
        required: ['x', 'y', 'width', 'height'],
        description: '只截取屏幕的一部分（常用于放大读细节）。',
      },
      observe: {
        type: 'boolean',
        description: '操作完成后自动再截一张图返回，省一次往返。默认 false。',
      },
      grid: {
        type: 'boolean',
        description: '截图是否叠加坐标网格（每 200 像素一条线并标注屏幕坐标）。默认开启，读界面细节时可传 false 关掉。',
      },
    },
    required: ['action'],
  }
}

function buildOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: '是否执行成功。' },
      action: { type: 'string', description: '执行的动作。' },
      message: { type: 'string', description: '人类可读的结果说明。' },
      image: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        description: '截图附件，仅在 action=screenshot 或 observe=true 时出现。',
      },
    },
    required: ['ok', 'action', 'message'],
  }
}

export function apply(ctx, config, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new Error('computer-use 目前只支持 Windows。')
  }

  const options = { ...DEFAULTS, ...(config ?? {}) }
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-computer-use-'))
  const helper = dependencies.helper ?? new HelperProcess(workDir)
  const glow = dependencies.glow ?? new GlowController(options, workDir)

  ctx.effect(() => () => {
    glow.dispose()
    helper.dispose()
    setTimeout(() => {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }, 1200).unref?.()
  })

  const capture = async (region, grid) => {
    const attachments = ctx.get('attachments')
    if (!attachments) {
      throw new Error('computer-use 需要 attachments 服务来保存截图。')
    }
    const pngPath = join(workDir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const data = await glow.withSuppressed(130, async () => {
      const shot = await helper.call(
        'screenshot',
        {
          path: pngPath,
          x: region?.x,
          y: region?.y,
          w: region?.width,
          h: region?.height,
          grid: grid === undefined ? options.screenshotGrid : Boolean(grid),
        },
        options.screenshotTimeoutMs,
      )
      const bytes = readFileSync(pngPath)
      rmSync(pngPath, { force: true })
      const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'screenshot.png' })
      return { shot, ref }
    })

    const { shot, ref } = data
    const scale = ref.originalDimensions ? ref.originalDimensions.width / ref.width : 1
    const scaleNote = scale > 1.001
      ? ` 图片实际存为 ${ref.width}x${ref.height}（屏幕的 ${(1 / scale).toFixed(2)} 倍）。`
      : ''
    const gridNote = shot.grid
      ? ' 图上每 200 像素有网格线与坐标标注，那些数字就是真实屏幕坐标，即使图片被显示端缩放也以标注为准。'
      : ''
    const message = `截图 ${shot.width}x${shot.height}，屏幕原点 (${shot.originX}, ${shot.originY})。坐标即屏幕像素：x 向右、y 向下。${scaleNote}${gridNote}`
    return {
      ok: true,
      action: 'screenshot',
      message: message.trim(),
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
      },
    }
  }

  const tool = {
    name: 'computer',
    description: '操作 Windows 桌面：截图、鼠标、键盘、启动程序。先截图再定位，使用物理像素与网格坐标，不按预览尺寸猜测 DPI。ESC 取消当前操作并持续暂停，只能由本地用户重启插件恢复。',
    parameters: buildParameters(),
    output: {
      schema: buildOutputSchema(),
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: String(value?.message ?? '') }]
        if (value?.image?.attachmentId) {
          blocks.push({ type: 'image', attachment: value.image })
        }
        return blocks
      },
    },
    presentCall(args) {
      return { card: 'generic', title: `Computer · ${String(args?.action ?? '')}`, kind: 'execute' }
    },
    async execute(args, exec = {}) {
      validateArgs(args)
      if (exec.signal?.aborted) throw new Error('电脑操作已取消。')
      const action = String(args?.action ?? '')
      if (glow.abortedRecently()) {
        throw new Error('用户按下 ESC，电脑操作已持续暂停。仅本地用户重启插件或应用可恢复；不得通过模型调用绕过。')
      }
      if (helper.stopping) await helper.stopping
      if (exec.signal?.aborted || glow.abortedRecently()) throw new Error('电脑操作已取消或由 ESC 持续暂停。')
      rmSync(join(workDir, 'cancel'), { force: true })
      glow.pulse()
      const heartbeat = setInterval(() => glow.pulse(), 1000)
      const cancel = () => {
        try { writeFileSync(join(workDir, 'cancel'), '1') } catch { helper.dispose() }
      }
      exec.signal?.addEventListener('abort', cancel, { once: true })
      try {
      await glow.ready()
      if (exec.signal?.aborted || glow.abortedRecently()) throw new Error('电脑操作已取消或由 ESC 持续暂停。')

      const finish = async (message) => {
        if (args?.observe && action !== 'screenshot') {
          const shot = await capture(args.region, args.grid)
          return { ok: true, action, message: `${message} ${shot.message}`, image: shot.image }
        }
        return { ok: true, action, message }
      }

      switch (action) {
        case 'screenshot': {
          return await capture(args?.region, args?.grid)
        }
        case 'move': {
          const result = await helper.call('move', { x: Number(args.x), y: Number(args.y) }, options.actionTimeoutMs)
          return await finish(`鼠标移到 (${result.x}, ${result.y})。`)
        }
        case 'click': {
          const result = await helper.call(
            'click',
            {
              x: args.x === undefined ? undefined : Number(args.x),
              y: args.y === undefined ? undefined : Number(args.y),
              button: args.button ?? 'left',
              count: args.count ?? 1,
            },
            options.actionTimeoutMs,
          )
          const label = result.count > 1 ? `${result.count} 连击` : '单击'
          return await finish(`在 (${result.x}, ${result.y}) ${result.button} 键${label}。`)
        }
        case 'drag': {
          const result = await helper.call(
            'drag',
            { x: Number(args.x), y: Number(args.y), to_x: Number(args.to_x), to_y: Number(args.to_y) },
            options.actionTimeoutMs,
          )
          return await finish(`从 (${result.from.x}, ${result.from.y}) 拖到 (${result.to.x}, ${result.to.y})。`)
        }
        case 'scroll': {
          const result = await helper.call(
            'scroll',
            {
              x: args.x === undefined ? undefined : Number(args.x),
              y: args.y === undefined ? undefined : Number(args.y),
              amount: Number(args.amount ?? 0),
              horizontal: Number(args.horizontal ?? 0),
            },
            options.actionTimeoutMs,
          )
          return await finish(`在 (${result.x}, ${result.y}) 滚动 ${result.amount} 格。`)
        }
        case 'type': {
          const text = String(args?.text ?? '')
          if (!text) throw new Error('type 需要非空的 text。')
          const result = await helper.call('type', { text }, options.actionTimeoutMs)
          return await finish(`已输入 ${result.chars} 个字符。`)
        }
        case 'key': {
          const keys = String(args?.keys ?? '').trim()
          if (!keys) throw new Error('key 需要非空的 keys。')
          await helper.call('key', { keys }, options.actionTimeoutMs)
          return await finish(`已按键 ${keys}。`)
        }
        case 'launch': {
          const command = String(args?.command ?? '').trim()
          if (!command) throw new Error('launch 需要非空的 command。')
          await helper.call('launch', { command, args: args?.args }, options.actionTimeoutMs)
          return await finish(`已启动 ${command}。`)
        }
        case 'wait': {
          const ms = Math.min(Math.max(Number(args?.ms ?? 500), 0), 10000)
          await helper.call('wait', { ms }, options.actionTimeoutMs)
          return await finish(`等待 ${ms} 毫秒。`)
        }
        default:
          throw new Error(`未知的 action: ${action}`)
      }
      } finally { clearInterval(heartbeat); glow.stop(); exec.signal?.removeEventListener('abort', cancel) }
    },
  }

  // 整个工具调用串行化：排队任务不得触碰当前任务的取消文件或光晕。
  const execute = tool.execute
  let queue = Promise.resolve()
  tool.execute = (args, exec = {}) => {
    const result = queue.then(() => execute(args, exec))
    queue = result.catch(() => {})
    return result
  }

  ctx.effect(() => ctx.tools.register(tool))
}
