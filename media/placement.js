// Placing a box where it covers least: one search for the pages' "put it where it hides the least" problems (the
// tutorial's card; the map's arrow labels and legend may use it too). Pure: tested in test/journeyMapPage.test.ts.
import { overlapArea } from './common.js'

/** @typedef {import('./common.js').Edges} Edges */

/**
 * Of `candidates` (tried in order), the one with the lowest cost: `cost(c)` plus, for each of `obstacles`, the area
 * of it the candidate covers times its `weight` (1 when it has none). Ties go to the earlier candidate; with
 * `stopWhenClear`, a candidate that covers no obstacle ends the search. Undefined when there are no candidates.
 * @template {Edges} C
 * @param {C[]} candidates
 * @param {(Edges & { weight?: number })[]} obstacles
 * @param {{ cost?: (c: C) => number, stopWhenClear?: boolean }} [o]
 * @returns {C | undefined}
 */
export function placeLeastCovering(candidates, obstacles, { cost = () => 0, stopWhenClear = false } = {}) {
  let best, bestCost = Infinity
  for (const c of candidates) {
    const own = cost(c)
    const total = own + obstacles.reduce((sum, q) => sum + overlapArea(c, q) * (q.weight ?? 1), 0)
    if (total < bestCost) { best = c; bestCost = total }
    if (stopWhenClear && total <= own) break
  }
  return best
}
