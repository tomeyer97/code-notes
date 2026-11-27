// Finding the line a step names (a code link, a value hint, a beat) in its file as it is now. Pure: no vscode.
import { findLine } from '../core/anchors/lineFollow'
import type { StepLink, ValueHint } from '../core/format/journeyModel'

/**
 * Where a step's line (1-based `line`, its `text`) is now in `lines`, 0-based; -1: gone. Found by its text near where
 * it was written; with no text to go by, `noText` says: the line as written (`asWritten`), or gone.
 */
export function locateStepLine(lines: readonly string[], at: { line: number; text: string }, noText: 'asWritten' | 'gone' = 'asWritten'): number {
  if (at.text.trim()) return findLine(lines as string[], at.line - 1, at.text)
  return noText === 'asWritten' ? Math.min(at.line, lines.length) - 1 : -1
}

/** The log line for a step's line that is gone: "<what>: <where> changed; <outcome>". */
export const lineChanged = (what: string, where: string, outcome: string) => `${what}: ${where} changed; ${outcome}`

/** Same items, field by field and in the same order (a step drawn again keeps what it lit). */
function sameItems<T>(a: readonly T[], b: readonly T[], fields: readonly (keyof T)[]): boolean {
  return a.length === b.length && a.every((x, k) => fields.every((f) => x[f] === b[k][f]))
}

/** The same code links: every field of each, in order. */
export const sameLinks = (a: readonly StepLink[], b: readonly StepLink[]) => sameItems(a, b, ['phrase', 'file', 'start', 'end', 'text'])

/** The same value hints: every field of each, in order. */
export const sameValues = (a: readonly ValueHint[], b: readonly ValueHint[]) => sameItems(a, b, ['name', 'value', 'note', 'file', 'line', 'text'])
