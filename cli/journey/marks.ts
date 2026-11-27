// A mark against its file: what is wrong with its shape, with where it is in the code, and what it lights. The
// extension's own rules (src/core/format/marks.ts).
import { codeMarkOf, findMark, markCodeProblem, markShapeProblem, OnMissing } from '../../src/core/format/marks'
import { isObj } from './py'

export interface MarkCheck {
  /** What is wrong with its fields; null: usable. */
  shape: string | null
  /** What is wrong against the code (`moved`: found that many lines off); null: in place, or not looked at. */
  code: { what: string; moved: number | null } | null
  /** [line, col, endLine, endCol] it lights (0-based, the end exclusive); null: nothing. */
  spot: [number, number, number, number] | null
}

/** Mark `m` of `file`, whose lines are `doc` (null: the file isn't there). */
export function checkMark(m: unknown, file: string, doc: string[] | null, onMissing: OnMissing): MarkCheck {
  if (!isObj(m)) return { shape: 'not an object { lines, match? }', code: null, spot: null }
  const bad = markShapeProblem(m)
  if (bad) return { shape: bad.what, code: null, spot: null }
  const mark = codeMarkOf(m)
  const p = markCodeProblem({ doc, file, mark, onMissing })
  const found = doc && findMark(doc, mark)
  const lit = found && (found.found || mark.match === undefined)
  return {
    shape: null,
    code: p ? { what: p.what, moved: p.moved ?? null } : null,
    spot: lit ? [found.spot.line, found.spot.col, found.spot.endLine, found.spot.endCol] : null,
  }
}
