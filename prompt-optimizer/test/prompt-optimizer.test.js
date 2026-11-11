import test from 'node:test'
import assert from 'node:assert/strict'
import { callOptimizer, extractJson, plannedMaxTokens, validateDecision } from '../index.js'

function makeCtx(responses) {
  const calls = []
  return {
    calls,
    llm: {
      async *stream(options) {
        calls.push(options)
        const reply = responses[calls.length - 1] ?? responses.at(-1)
        for (const chunk of reply.chunks ?? []) yield chunk
        yield { type: 'finish', reason: reply.reason ?? { kind: 'stop' } }
      },
    },
  }
}

const model = { provider: 'deepseek-account', model: 'DeepSeek-V4.1-Flash' }
const chunkText = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
]

test('长草稿会拿到更大的输出预算', () => {
  assert.ok(plannedMaxTokens(10) >= 4096)
  assert.ok(plannedMaxTokens(6000) > plannedMaxTokens(200))
  assert.ok(plannedMaxTokens(12000) <= 16000)
})

test('能从围栏、前后说明和多余尾随内容中提取 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"decision":"ready","optimizedPrompt":"a"}\n```'), {
    decision: 'ready',
    optimizedPrompt: 'a',
  })
  assert.deepEqual(extractJson('好的，结果如下：{"decision":"ready","optimizedPrompt":"b"} 希望有帮助'), {
    decision: 'ready',
    optimizedPrompt: 'b',
  })
})

test('被截断的输出会给出明确的截断提示', () => {
  assert.throws(() => extractJson('{"decision":"ready","optimizedPrompt":"半截', { truncated: true }), /截断/)
  assert.throws(() => extractJson('', { truncated: true }), /截断/)
})

test('只有推理内容时也能取到 JSON', async () => {
  const ctx = makeCtx([
    {
      chunks: [{ type: 'reasoning-delta', index: 0, text: '{"decision":"ready","optimizedPrompt":"来自推理"}' }],
    },
  ])
  const result = await callOptimizer(ctx, model, 'session-test-0001', '写一份周报', '', undefined)
  assert.equal(result.decision, 'ready')
  assert.equal(result.optimizedPrompt, '来自推理')
})

test('首次被 max-tokens 截断时自动加大预算重试', async () => {
  const ctx = makeCtx([
    { chunks: chunkText('{"decision":"ready","optimizedPrompt":"还没写完'), reason: { kind: 'max-tokens' } },
    { chunks: chunkText('{"decision":"ready","optimizedPrompt":"完整结果"}') },
  ])
  const result = await callOptimizer(ctx, model, 'session-test-0002', '很长的草稿'.repeat(200), '', undefined)
  assert.equal(result.optimizedPrompt, '完整结果')
  assert.equal(ctx.calls.length, 2)
  assert.ok(ctx.calls[1].maxTokens > ctx.calls[0].maxTokens)
})

test('两次都被截断时抛出可读的失败原因', async () => {
  const ctx = makeCtx([
    { chunks: chunkText('{"decision":"ready","optimizedPrompt":"半截'), reason: { kind: 'max-tokens' } },
    { chunks: chunkText('{"decision":"ready","optimizedPrompt":"仍然半截'), reason: { kind: 'max-tokens' } },
  ])
  await assert.rejects(
    () => callOptimizer(ctx, model, 'session-test-0003', '草稿', '', undefined),
    /截断/,
  )
})

test('decision 校验仍保持原有约束', () => {
  assert.throws(() => validateDecision({ decision: 'ready' }), /没有返回优化后的提示词/)
  assert.throws(() => validateDecision({ decision: 'clarify' }), /没有给出澄清问题/)
  assert.deepEqual(validateDecision({ decision: 'ready', optimizedPrompt: '  x  ' }), {
    decision: 'ready',
    optimizedPrompt: 'x',
  })
})