import assert from 'node:assert/strict'
import test from 'node:test'

import { balancedCuts, resolveBudget, selectSpan } from './budget.js'

const node = (seq, tokens) => ({ seq, tokens })

test('resolveBudget subtracts the reply reservation and the safety margin', () => {
  assert.equal(resolveBudget({ contextWindow: 200_000, outputReservation: 8192, headroomTokens: 8192 }), 183_616)
  assert.equal(resolveBudget({ contextWindow: 200_000 }), 200_000)
})

test('resolveBudget refuses windows that leave no room', () => {
  assert.equal(resolveBudget({ contextWindow: 0 }), undefined)
  assert.equal(resolveBudget({ contextWindow: undefined }), undefined)
  assert.equal(resolveBudget({ contextWindow: 10_000, outputReservation: 10_000 }), undefined)
  assert.equal(resolveBudget({ contextWindow: 10_000, outputReservation: 9_000, headroomTokens: 1_000 }), undefined)
})

test('balancedCuts reports one flag per node plus the trailing cut', () => {
  const nodes = [1, 2, 3]
  const cuts = balancedCuts(nodes, () => undefined)
  assert.equal(cuts.length, nodes.length + 1)
  assert.deepEqual(cuts, [true, true, true, true])
})

test('balancedCuts marks the cut between a tool call and its result unsafe', () => {
  const events = new Map([
    [2, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } }],
    [3, { type: 'tool/result', data: {} }],
  ])
  const cuts = balancedCuts([1, 2, 3, 4], (seq) => events.get(seq))
  // Cutting *before* the unresolved result (node 3) would split the pair.
  assert.deepEqual(cuts, [true, true, false, true, true])
})

test('balancedCuts gives up rather than guessing when a result has no call', () => {
  const events = new Map([[2, { type: 'tool/result', data: {} }]])
  const cuts = balancedCuts([1, 2, 3], (seq) => events.get(seq))
  assert.equal(cuts.length, 4)
  assert.equal(cuts[3], false)
})

test('selectSpan leaves the system prompt and the newest nodes alone', () => {
  const nodes = [node(1, 100), node(2, 200), node(3, 300), node(4, 50), node(5, 400)]
  const balanced = [true, true, true, true, true, true]
  const span = selectSpan({ nodes, balanced, totalTokens: 1050, budget: 800, retainNodes: 2 })
  assert.deepEqual(span, { start: 2, end: 3, freed: 500 })
})

test('selectSpan refuses when even the whole eligible history cannot reach the budget', () => {
  const nodes = [node(1, 100), node(2, 200), node(3, 300), node(4, 50), node(5, 400)]
  const balanced = new Array(nodes.length + 1).fill(true)
  const span = selectSpan({ nodes, balanced, totalTokens: 2000, budget: 800, retainNodes: 1 })
  assert.equal(span, undefined)
})

test('selectSpan moves the end past a cut that would split a tool call', () => {
  const nodes = [node(1, 10), node(2, 500), node(3, 500), node(4, 500), node(5, 500)]
  // The cut before node seq 4 splits an open tool call.
  const balanced = [true, true, true, false, true, true]
  const span = selectSpan({ nodes, balanced, totalTokens: 2010, budget: 1500, retainNodes: 1 })
  assert.deepEqual(span, { start: 2, end: 4, freed: 1500 })
})

test('selectSpan does nothing when the request already fits', () => {
  const nodes = [node(1, 100), node(2, 200)]
  const balanced = [true, true, true]
  assert.equal(selectSpan({ nodes, balanced, totalTokens: 300, budget: 300, retainNodes: 1 }), undefined)
})

test('selectSpan does nothing when there is nothing left to compress', () => {
  const nodes = [node(1, 100)]
  const balanced = [true, true]
  assert.equal(selectSpan({ nodes, balanced, totalTokens: 5000, budget: 100, retainNodes: 1 }), undefined)
})
