// dsh-think-autoexpand — host half.
// Browser half keeps Think rows visible and auto-expanded.
// Host half injects a per-turn rule through the official "agent/pre-step"
// waterfall, forcing Chinese thinking (Think / reasoning) and replies.
// The rule is written in Chinese itself so it can never be self-defeating.

import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-think-autoexpand'
export const inject = []

// Session format v4 refuses the retired wrapper `{ kind: 'plugin', plugin }`
// and requires every durable message to carry a producer-owned source kind.
// This plugin owns `dsh-think-autoexpand` as its producer identity.
const KIND = 'dsh-think-autoexpand'

const RULE = '重要语言规则：请始终使用中文进行思考（Think / reasoning 内容）和回复。即使用户或上下文使用其他语言，也必须输出中文。'

export function apply(ctx) {
  ctx.on('agent/pre-step', async (event, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || event.step !== 1) return decision
    if (decision.messages.length === 0) return decision
    if (decision.messages.some((message) => message.source?.kind === KIND)) return decision

    const message = createUserMessage({
      content: [{ type: 'text', text: RULE }],
      source: { kind: KIND },
    })

    const lastClaimedIndex = decision.messages.findLastIndex((message) => event.messages.includes(message))
    return {
      kind: 'enter',
      messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message),
    }
  })
}
