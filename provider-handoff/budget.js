/**
 * Pure budget arithmetic for provider handoff.
 *
 * Kept free of Cordis and session objects so the decision that costs money —
 * "how much history must go" — can be unit tested without a live Harness.
 */

/**
 * Compute the token budget a request may use on its target route.
 *
 * @param {object} input
 * @param {number | undefined} input.contextWindow target model's window.
 * @param {number} [input.outputReservation] tokens reserved for the reply.
 * @param {number} [input.headroomTokens] extra safety margin.
 * @returns {number | undefined} a usable budget, or undefined when unknown/impossible.
 */
export function resolveBudget({ contextWindow, outputReservation = 0, headroomTokens = 0 }) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  const output = Number.isFinite(outputReservation) && outputReservation > 0 ? outputReservation : 0
  const headroom = Number.isFinite(headroomTokens) && headroomTokens > 0 ? headroomTokens : 0
  const budget = contextWindow - output - headroom
  return budget > 0 ? Math.floor(budget) : undefined
}

/**
 * Walk a surface and report, for every node position, whether cutting *before*
 * that node splits an assistant tool call from its result.
 *
 * A cut after node `i` is safe exactly when `balanced[i + 1]` is true.
 *
 * @param {readonly unknown[]} nodes surface sequences in order.
 * @param {(seq: unknown) => ({ type: string, data?: any } | undefined)} eventAt log lookup.
 * @returns {boolean[]} one entry per node plus a trailing "after the last node" entry.
 */
export function balancedCuts(nodes, eventAt) {
  const balanced = []
  let open = 0
  for (const seq of nodes) {
    balanced.push(open === 0)
    const event = eventAt(seq)
    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) if (block?.type === 'tool-call') open += 1
      }
    } else if (event?.type === 'tool/result') {
      open -= 1
      if (open < 0) {
        // A result without its call means our view of the surface is wrong;
        // treat every later cut as unsafe rather than guessing.
        return balanced.concat(new Array(nodes.length - balanced.length + 1).fill(false))
      }
    }
  }
  balanced.push(open === 0)
  return balanced
}

/**
 * Choose the span of surface nodes to replace with one summary.
 *
 * The span always starts after the system prompt, ends before the most recent
 * `retainNodes` nodes, and is moved right until both edges are tool-pairing
 * balanced. Nodes are dropped from the oldest end, which is what preserves
 * "necessary context": the newest conversation stays verbatim.
 *
 * @param {object} input
 * @param {readonly { seq: unknown, tokens: number }[]} input.nodes priced surface.
 * @param {readonly boolean[]} input.balanced output of {@link balancedCuts}.
 * @param {number} input.totalTokens tokens the whole request would cost.
 * @param {number} input.budget tokens the target route allows.
 * @param {number} [input.retainNodes] newest nodes never compressed.
 * @param {number} [input.minOverCompressRatio] extra fraction of the excess to free.
 * @returns {{ start: unknown, end: unknown, freed: number } | undefined}
 */
export function selectSpan({ nodes, balanced, totalTokens, budget, retainNodes = 4, minOverCompressRatio = 0.2 }) {
  const excess = totalTokens - budget
  if (!Number.isFinite(excess) || excess <= 0) return undefined
  if (nodes.length < 2) return undefined

  // Node 0 is the system prompt and must never be shadowed; the retained tail
  // must keep at least one node even if the caller asked for fewer.
  const startIndex = 1
  const limit = Math.max(startIndex + 1, nodes.length - Math.max(1, retainNodes))

  // A summary itself costs tokens, so free more than the bare excess.
  const wanted = Math.ceil(excess * (1 + Math.max(0, minOverCompressRatio))) + 256

  let endIndex = -1
  let freed = 0
  for (let i = startIndex; i < limit; i += 1) {
    freed += Math.max(0, Math.trunc(nodes[i]?.tokens ?? 0))
    endIndex = i
    if (freed >= wanted) break
  }
  if (endIndex < startIndex) return undefined

  // Keep the newest nodes verbatim: if the span reached the limit without
  // freeing enough, this attempt cannot satisfy the budget.
  if (freed < excess) return undefined

  const start = snapStart(nodes, balanced, startIndex, limit)
  if (start === undefined) return undefined
  const end = snapEnd(nodes, balanced, endIndex, start, limit)
  if (end === undefined) return undefined
  if (end < start) return undefined

  let actualFreed = 0
  for (let i = start; i <= end; i += 1) actualFreed += Math.max(0, Math.trunc(nodes[i]?.tokens ?? 0))
  if (actualFreed <= 0) return undefined

  return { start: nodes[start].seq, end: nodes[end].seq, freed: actualFreed }
}

function snapStart(nodes, balanced, candidate, limit) {
  for (let i = candidate; i < limit; i += 1) {
    if (i > 0 && balanced[i] === true) return i
  }
  return undefined
}

function snapEnd(nodes, balanced, candidate, start, limit) {
  for (let i = Math.max(candidate, start); i < limit; i += 1) {
    if (balanced[i + 1] === true) return i
  }
  return undefined
}
