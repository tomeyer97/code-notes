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
    out.push({ start: i, end, kind: /^(export\s+)?(const|let|var)\s/.test(l) && !/=>|function/.test(l) ? 'var' : 'fn' })
    i = end
  }
  return out
}

/** The block a line belongs to: the smallest one around it (a method before its class). */
export function blockAt(line: number, blocks: Block[]): Block | undefined {
  return blocks.filter((b) => b.start <= line && line <= b.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
}

/** One lens per group: steps whose lines start in (or lead into) the same function; the rest by nearby lines. */
export function groupSteps<T extends { line: number; end?: number }>(hits: T[], blocks: Block[], near = 10): { line: number; steps: T[] }[] {
  const groups = new Map<string, { line: number; steps: T[] }>()
  /** Steps outside every function, and the line each is grouped by. */
  const loose: { at: number; step: T }[] = []
  for (const h of hits) {
    // In a function; or starting just above one (its comment, the line before it) and running into it.
    const b = blockAt(h.line, blocks) ?? blocks.find((x) => x.kind === 'fn' && x.start > h.line && x.start <= (h.end ?? h.line) + 2)
    // A top-level const (one line or several) is one of the file's top lines: grouped by its first line, with its
    // neighbours below.
    if (!b || b.kind === 'var') { loose.push({ at: b ? b.start : h.line, step: h }); continue }
    const k = `${b.start}`
    const g = groups.get(k) ?? { line: b.start, steps: [] }
    g.steps.push(h)
    groups.set(k, g)
  }
  // Outside every function (a file's top-level consts): one lens for steps a few lines apart in the same gap.
  const gapOf = (line: number) => blocks.filter((b) => b.kind !== 'var' && b.end < line).length
  let cur: { line: number; steps: T[]; last: number; gap: number } | undefined
  for (const { at, step } of [...loose].sort((a, b) => a.at - b.at)) {
    if (cur && cur.gap === gapOf(at) && at - cur.last <= near) { cur.steps.push(step); cur.last = Math.max(at, step.line); continue }
    cur = { line: at, steps: [step], last: step.line, gap: gapOf(at) }
    groups.set(`l${at}`, cur)
  }
  return [...groups.values()].map((g) => ({ line: g.line, steps: g.steps })).sort((a, b) => a.line - b.line)
}
