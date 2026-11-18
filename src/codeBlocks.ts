// The "functions" of a file for the journey lenses and "In this file": at most one lens per function, and the
// function around the cursor. From the language's document symbols when it has them, else from the text
// (indentation and braces). Pure (no vscode): unit-tested in test/codeBlocks.test.ts.

/** A range of lines (0-based, inclusive). "class": for lines outside its methods; "var": a top-level const over several
 *  lines (the function around the cursor, but for the lenses one of the file's top-level lines). */
export interface Block { start: number; end: number; kind: 'fn' | 'class' | 'var' }

/** The parts of a document symbol this needs (vscode.DocumentSymbol fits). */
export interface Sym { kind: 'fn' | 'class' | 'var' | 'other'; start: number; end: number; children: Sym[] }

/**
 * Blocks from symbols: functions, methods and constructors (never what is nested in them: a callback or a
 * destructuring inside a function is that function), classes, and top-level variables that span several lines
 * (`const handlers = { … }`, `const f = () => { … }`). A one-line const is not a block.
 */
export function blocksFromSymbols(syms: Sym[]): Block[] {
  const out: Block[] = []
  const walk = (list: Sym[], inClass: boolean) => {
    for (const s of list) {
      if (s.kind === 'fn') { out.push({ start: s.start, end: s.end, kind: 'fn' }); continue }
      if (s.kind === 'var' && !inClass && s.end > s.start) { out.push({ start: s.start, end: s.end, kind: 'var' }); continue }
      if (s.kind === 'class') { out.push({ start: s.start, end: s.end, kind: 'class' }); walk(s.children, true); continue }
      if (s.kind === 'other') walk(s.children, inClass) // a namespace, a module
    }
  }
  walk(syms, false)
  return out.sort((a, b) => a.start - b.start)
}

const blank = (s: string) => !s.trim()
const indent = (s: string) => s.length - s.trimStart().length
/** A comment line (or a decorator) that belongs to what follows it. */
const lead = (s: string) => /^\s*(\/\/|#|\/\*|\*|--|@)/.test(s)
/** Lines that close a block rather than start a new one. */
const closer = (s: string) => /^\s*[)\]}]/.test(s) || /^\s*(end|fi|done|esac)\b/.test(s)

/** A top-level `const`/`let`/`var` that is not a function (`const f = () => …`): a "var" block. */
const TOP_LEVEL_VAR = /^(export\s+)?(const|let|var)\s/
const HOLDS_FUNCTION = /=>|function/

/**
 * Blocks from the text, for files without symbols: a top-level line (not indented, not a comment) whose next
 * non-blank line is indented runs until the next top-level line that is not a closer (`}`, `)`, `end`).
 */
export function blocksFromText(lines: string[]): Block[] {
  const out: Block[] = []
  const next = (i: number) => { let k = i + 1; while (k < lines.length && blank(lines[k])) k++; return k }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (blank(l) || indent(l) > 0 || lead(l) || closer(l)) continue
    const k = next(i)
    if (k >= lines.length || indent(lines[k]) === 0) continue
    let end = k
    for (let j = k; j < lines.length; j++) {
      if (blank(lines[j])) continue
      if (indent(lines[j]) > 0) { end = j; continue }
      if (closer(lines[j])) { end = j; continue }
      break
    }
    const kind = TOP_LEVEL_VAR.test(l) && !HOLDS_FUNCTION.test(l) ? 'var' : 'fn'
    out.push({ start: i, end, kind })
    i = end
  }
  return out
}

/** The block a line belongs to: the smallest one around it (a method before its class). */
export function blockAt(line: number, blocks: Block[]): Block | undefined {
  return blocks.filter((b) => b.start <= line && line <= b.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
}

/** Steps in a lens group, and the line the lens is on. */
type StepGroup<T> = { line: number; steps: T[] }

/** One lens per group: steps whose lines start in (or lead into) the same function; the rest by nearby lines. */
export function groupSteps<T extends { line: number; end?: number }>(hits: T[], blocks: Block[], nearLines = 10): StepGroup<T>[] {
  const { byFunction, loose } = groupByFunction(hits, blocks)
  const groups = [...byFunction, ...groupLoose(loose, blocks, nearLines)]
  return groups.map((g) => ({ line: g.line, steps: g.steps })).sort((a, b) => a.line - b.line)
}

/**
 * Steps in a function (or starting just above one: its comment, the line before it, and running into it), one group
 * per function; the rest are `loose`, each with the line it is grouped by.
 */
function groupByFunction<T extends { line: number; end?: number }>(hits: T[], blocks: Block[]): { byFunction: StepGroup<T>[]; loose: { at: number; step: T }[] } {
  const groups = new Map<number, StepGroup<T>>()
  const loose: { at: number; step: T }[] = []
  for (const h of hits) {
    const runsInto = (x: Block) => x.kind === 'fn' && x.start > h.line && x.start <= (h.end ?? h.line) + 2
    const b = blockAt(h.line, blocks) ?? blocks.find(runsInto)
    // A top-level const (one line or several) is one of the file's top lines: grouped by its first line, with its
    // neighbours below.
    if (!b || b.kind === 'var') {
      loose.push({ at: b ? b.start : h.line, step: h })
      continue
    }
    const g = groups.get(b.start) ?? { line: b.start, steps: [] }
    g.steps.push(h)
    groups.set(b.start, g)
  }
  return { byFunction: [...groups.values()], loose }
}

/**
 * Steps outside every function (a file's top-level consts): one lens for steps at most `nearLines` apart in the same
 * gap between functions.
 */
function groupLoose<T extends { line: number }>(loose: { at: number; step: T }[], blocks: Block[], nearLines: number): StepGroup<T>[] {
  /** Which gap between functions (and classes) a line is in: how many end above it. */
  const gapOf = (line: number) => blocks.filter((b) => b.kind !== 'var' && b.end < line).length
  const out: StepGroup<T>[] = []
  let cur: { line: number; steps: T[]; last: number; gap: number } | undefined
  for (const { at, step } of [...loose].sort((a, b) => a.at - b.at)) {
    if (cur && cur.gap === gapOf(at) && at - cur.last <= nearLines) {
      cur.steps.push(step)
      cur.last = Math.max(at, step.line)
      continue
    }
    cur = { line: at, steps: [step], last: step.line, gap: gapOf(at) }
    out.push(cur)
  }
  return out
}
