// Marks: highlights of a part of the code, whole lines or only a few characters within them. One shape, read and
// checked here for everything that has them: a journey's steps and beats (docs/journey-format.md, "Marks") and a
// podcast's segments (docs/podcast-format.md, "Marks"; a segment's marks add `phrase` and `at`). How they are drawn
// is marks/lights.ts. Pure (no imports); skills/code-journey/scripts/journey.py has the same rules.

/** `lines` of `file` (default: the step's, the beat's or the segment's file), or only `match` within them (its `nth`). */
export interface CodeMark {
  file?: string
  /** 1-based, inclusive. */
  lines: [number, number]
  match?: string
  /** 1-based; default 1. */
  nth?: number
}

/** What is wrong with a list of marks, or with its mark `k` (0-based); `sub`: the field, as a JSON path from the
 *  list's owner; `drop`: the mark is left out. */
export interface MarkProblem { k?: number; what: string; sub: (string | number)[]; drop: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** What is wrong with a mark's code fields (lines, file, match, nth), the first thing found; undefined: usable. */
export function markShapeProblem(m: Record<string, unknown>): { what: string; sub: string[] } | undefined {
  const l = m.lines
  if (!Array.isArray(l) || l.length !== 2 || !l.every((x) => Number.isInteger(x) && x >= 1) || l[1] < l[0]) return { what: `lines must be [first, last] (1-based, first <= last), got ${JSON.stringify(l)}`, sub: l === undefined ? [] : ['lines'] }
  if (m.file !== undefined && (typeof m.file !== 'string' || !m.file.trim())) return { what: 'file is not a path', sub: ['file'] }
  if (m.match !== undefined && (typeof m.match !== 'string' || !m.match)) return { what: 'match is not a text', sub: ['match'] }
  if (m.nth !== undefined && !(Number.isInteger(m.nth) && (m.nth as number) >= 1)) return { what: `nth must be 1 or more, got ${JSON.stringify(m.nth)}`, sub: ['nth'] }
  return undefined
}

/** A mark's code fields, from one markShapeProblem passed. */
export function codeMarkOf(m: Record<string, unknown>): CodeMark {
  const l = m.lines as number[]
  return {
    lines: [l[0], l[1]],
    ...(typeof m.file === 'string' ? { file: m.file } : {}), ...(typeof m.match === 'string' ? { match: m.match } : {}), ...(typeof m.nth === 'number' ? { nth: m.nth } : {}),
  }
}

/** A step's or a beat's `marks` as written: the usable ones, in order, and what is wrong with the rest. */
export function readMarks(v: unknown): { marks: CodeMark[]; problems: MarkProblem[] } {
  if (v === undefined) return { marks: [], problems: [] }
  if (!Array.isArray(v)) return { marks: [], problems: [{ what: 'marks is not a list of { lines, match? }; ignored', sub: ['marks'], drop: true }] }
  const marks: CodeMark[] = []
  const problems: MarkProblem[] = []
  v.forEach((m, k) => {
    const bad = isObj(m) ? markShapeProblem(m) : { what: 'not an object { lines, match? }', sub: [] }
    if (bad) problems.push({ k, what: `mark ${k + 1}: ${bad.what}; ignored`, sub: ['marks', k, ...bad.sub], drop: true })
    else marks.push(codeMarkOf(m as Record<string, unknown>))
  })
  return { marks, problems }
}

/** A step's (or beat's) usable marks: none, or not a list, is none. */
export const marksIn = (v: unknown): CodeMark[] => readMarks(v).marks

// ---------- finding a mark in the code ----------

/** A mark's `match` is looked for this many lines up and down from its `lines` when the code moved. */
export const MARK_REFIND_LINES = 20

/** A place in a document (0-based lines and characters, the end exclusive). */
export interface MarkSpot { line: number; col: number; endLine: number; endCol: number }

/** The `nth` occurrence of `match` in lines a..b (0-based, inclusive, clipped to the document). */
function occurrence(doc: string[], a: number, b: number, match: string, nth: number): MarkSpot | undefined {
  a = Math.max(0, a)
  b = Math.min(doc.length - 1, b)
  if (a > b) return undefined
  const text = doc.slice(a, b + 1).join('\n')
  let i = -match.length
  for (let n = 0; n < nth; n++) {
    i = text.indexOf(match, i + match.length)
    if (i < 0) return undefined
  }
  const pos = (off: number) => {
    let line = a
    while (off > doc[line].length) { off -= doc[line].length + 1; line++ }
    return { line, col: off }
  }
  const s = pos(i), e = pos(i + match.length)
  return { line: s.line, col: s.col, endLine: e.line, endCol: e.col }
}

/**
 * Where mark `m` is in a document (its lines): its `match` within `lines` (moved 0); else the same lines shifted up to
 * MARK_REFIND_LINES up or down, the nearest first, up before down (`moved`: the shift); else the whole `lines` (from
 * the first line's text to the last line's end; `found` false). No `match`: the whole lines. Undefined: the lines are
 * past the end of the document.
 */
export function findMark(doc: string[], m: Pick<CodeMark, 'lines' | 'match' | 'nth'>): { spot: MarkSpot; moved: number; found: boolean } | undefined {
  const a = m.lines[0] - 1, b = Math.min(m.lines[1] - 1, doc.length - 1)
  if (a >= doc.length || a < 0) return undefined
  if (m.match) {
    for (let d = 0; d <= MARK_REFIND_LINES; d++) {
      for (const s of d ? [-d, d] : [0]) {
        const spot = occurrence(doc, a + s, b + s, m.match, m.nth ?? 1)
        if (spot) return { spot, moved: s, found: true }
      }
    }
  }
  const indent = doc[a].length - doc[a].trimStart().length
  return { spot: { line: a, col: doc[a].trim() ? indent : 0, endLine: b, endCol: doc[b].length }, moved: 0, found: !m.match }
}

/**
 * What is wrong with mark `m` against its file's text (`doc`: its lines; null: the file isn't there), for a check:
 * lines past the end, or `match` not on its lines (moved: found nearby; else not found). `missing`: what a reader
 * then sees: the whole lines (a podcast) or nothing (a journey). `sub`: the field to point at. Undefined: in place.
 */
export function markCodeProblem(doc: string[] | null, file: string, m: CodeMark, missing: 'lines' | 'drop'): { what: string; sub: string; moved?: number } | undefined {
  if (doc === null) return { what: `${file} isn't in the repository; nothing is lit`, sub: m.file !== undefined ? 'file' : 'lines' }
  const [a, b] = m.lines
  const where = `${a === b ? `line ${a}` : `lines ${a}–${b}`} of ${file}`
  if (b > doc.length) {
    const past = a > doc.length
    return { what: `${where} ${past ? (a === b ? 'is' : 'are') : 'go'} past its end (${doc.length} lines)${past ? '; nothing is lit' : ''}`, sub: 'lines' }
  }
  if (m.match === undefined) return undefined
  const f = findMark(doc, m)
  if (!f || f.moved === 0 && f.found) return undefined
  const what = `${JSON.stringify(m.match)}${m.nth !== undefined && m.nth > 1 ? ` (occurrence ${m.nth})` : ''} isn't in ${where}`
  if (f.found) return { what: `${what}; found ${Math.abs(f.moved)} ${Math.abs(f.moved) === 1 ? 'line' : 'lines'} ${f.moved < 0 ? 'up' : 'down'}, lit there`, sub: 'match', moved: f.moved }
  return { what: `${what}, nor within ${MARK_REFIND_LINES} lines: ${missing === 'lines' ? 'the whole lines light' : 'nothing is lit'}`, sub: 'match' }
}

// ---------- a journey step's marks while it is walked ----------

/**
 * What step marks light at beat `beat` (0-based; undefined: no beat lit): the step's own, then each beat's up to
 * `beat`, in order. The newest group with marks is the focus, the ones before it dim (the same language as a podcast:
 * the latest said is the colour, what came before stays lighter). `group`: -1 the step's own, else the beat.
 */
export function walkMarks<T>(step: T[], beats: T[][], beat: number | undefined): { mark: T; group: number; focus: boolean }[] {
  const groups: { group: number; marks: T[] }[] = [{ group: -1, marks: step }]
  if (beat !== undefined) for (let i = 0; i <= beat && i < beats.length; i++) groups.push({ group: i, marks: beats[i] ?? [] })
  const lit = groups.filter((g) => g.marks.length)
  const newest = lit[lit.length - 1]?.group
  return lit.flatMap((g) => g.marks.map((mark) => ({ mark, group: g.group, focus: g.group === newest })))
}
