// Ctrl+' D / A through the check's open questions: which one comes next. No vscode here: unit-tested
// (test/checkNavigation.test.ts).

/**
 * The next (`dir` 1) or previous (-1) open question after the one shown, wrapping around; every question is looked
 * at once and the one shown is skipped. Nothing shown: from the start (D) or the end (A). None found: the first open
 * one. Undefined when none is open.
 */
export function nextOpen<Q>(qs: readonly Q[], isOpen: (q: Q) => boolean, isShown: (q: Q) => boolean, dir: 1 | -1): Q | undefined {
  const open = qs.filter(isOpen)
  if (!open.length) return undefined
  const n = qs.length, at = qs.findIndex(isShown)
  // D starts after the one shown (or at 0); A starts before it (or at the end).
  const from = dir === 1 ? at : Math.max(0, at)
  for (let k = 1; k <= n; k++) {
    const q = qs[(((from + dir * k) % n) + n) % n]
    if (isOpen(q) && !isShown(q)) return q
  }
  return open[0]
}
