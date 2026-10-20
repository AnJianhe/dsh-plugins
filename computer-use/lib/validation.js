const actions = ['screenshot', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'launch', 'wait']
export function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象。')
  if (!actions.includes(args.action)) throw new Error('action 无效，请选择支持的电脑操作。')
  const allowed = new Set(['action','x','y','to_x','to_y','button','count','text','keys','amount','command','args','ms','region','observe','grid'])
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`不支持参数 ${key}。`)
  const int = (key, value, min = -2147483648, max = 2147483647) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min} 至 ${max} 的整数。`)
  }
  for (const key of ['x','y','to_x','to_y']) if (key in args) int(key, args[key])
  if (['move','drag'].includes(args.action) && (!('x' in args) || !('y' in args))) throw new Error(`${args.action} 需要完整的 x、y 坐标。`)
  if (args.action === 'drag' && (!('to_x' in args) || !('to_y' in args))) throw new Error('drag 需要 to_x、to_y。')
  if (('x' in args) !== ('y' in args)) throw new Error('x 与 y 必须同时提供。')
  if ('button' in args && !['left','right','middle'].includes(args.button)) throw new Error('button 仅支持 left、right、middle。')
  if ('count' in args) int('count', args.count, 1, 2)
  if ('amount' in args) int('amount', args.amount, -100, 100)
  if (args.action === 'scroll' && !('amount' in args)) throw new Error('scroll 需要 amount。')
  if ('ms' in args) int('ms', args.ms, 0, 10000)
  for (const key of ['text','keys','command','args']) if (key in args && typeof args[key] !== 'string') throw new Error(`${key} 必须是字符串。`)
  for (const [action,key] of [['type','text'],['key','keys'],['launch','command']]) {
    if (args.action === action && (typeof args[key] !== 'string' || !args[key].length || (key !== 'text' && !args[key].trim()))) throw new Error(`${action} 需要非空的 ${key}。`)
  }
  for (const key of ['observe','grid']) if (key in args && typeof args[key] !== 'boolean') throw new Error(`${key} 必须是布尔值。`)
  if ('region' in args) {
    const r = args.region
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['x','y','width','height'].includes(k))) throw new Error('region 需要 x、y、width、height。')
    for (const key of ['x','y']) int(`region.${key}`, r[key])
    for (const key of ['width','height']) int(`region.${key}`, r[key], 1, 32768)
  }
}
