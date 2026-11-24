// Unified diffs: one walker (walkDiff) and what is read from it: the change's code lines and size, the lines
// added or changed, where code was removed, and the line numbers a merge request's diff pairs.
import { git, hasCommit } from './git'
import { counted, isDoc, own } from './changeFiles'
import { isCode } from './comments'
import type { Check, CodeStat, NumstatFile } from './types'

/** A code line of a change (codeLines): `line` its new-side line, for an added one. */
type CodeLine = { file: string; sign: '+' | '-'; text: string; line?: number }
/** A line of a unified diff, as walkDiff reads it. */
type DiffLine =
  | { kind: 'section'; line: string }
  | { kind: 'old'; line: string; path: string }
  | { kind: 'new'; line: string; path: string }
  | { kind: 'hunk'; line: string; start: number; count: number }
  | { kind: '+' | '-' | ' ' | 'other'; line: string; text: string; n: number; o: number; shift: number }
/** An open block comment's close marker (isCode). */
type CommentState = { block?: string }

/** The paths to diff for these files: a renamed file's old name too, so git pairs them (a pure move changes no line). */
const pathsOf = (files: NumstatFile[]): string[] => files.flatMap((f) => (f.from ? [f.from, f.file] : [f.file]))

/** A hunk header: "@@ -a,b +c,d @@" (a, b: the old side's first line and count; c, d: the new side's). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Each line of a unified diff, as what it is (`kind`) and where it is. `line`: the line as it is.
 *   section    "diff --git …": a file's part starts
 *   old, new   "--- a/x", "+++ b/x": `path`, without its a/ or b/ ("/dev/null": the file is added or deleted)
 *   hunk       "@@ -o,… +n,c @@": `start` and `count` on the new side (`count` 1 when not given)
 *   +, -, ' '  a line added, removed, unchanged: `text` without its sign; `n` and `o`: the line it is on the new and the
 *              old side (a removed line: the new side's line it comes before; an added one: the old side's)
 *   other      anything else ("index …", "\\ No newline at end of file", "new file mode …")
 * The counters go on from line to line and start again at each hunk; `shift`: old minus new after the line.
 * "--- " and "+++ " are file names only outside a hunk: inside one (lines left by its counts) they are a removed
 * "-- …" or an added "++ …" (a SQL, Lua or Haskell comment, say).
 */
function* walkDiff(diff: string): Generator<DiffLine> {
  // The next line on each side; the lines of the current hunk not read yet, on each side.
  let n = 0, o = 0, nLeft = 0, oLeft = 0
  for (const line of diff.split('\n')) {
    const inHunk = nLeft > 0 || oLeft > 0
    if (line.startsWith('diff --git')) { nLeft = oLeft = 0; yield { kind: 'section', line }; continue }
    if (!inHunk && line.startsWith('--- ')) { yield { kind: 'old', line, path: line.slice(4).replace(/^a\//, '') }; continue }
    if (!inHunk && line.startsWith('+++ ')) { yield { kind: 'new', line, path: line.slice(4).replace(/^b\//, '') }; continue }
    const h = HUNK_HEADER.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[3])
      oLeft = Number(h[2] ?? 1)
      nLeft = Number(h[4] ?? 1)
      yield { kind: 'hunk', line, start: n, count: nLeft }
      continue
    }
    const kind = ('+- '.includes(line[0] ?? 'x') ? line[0] : 'other') as '+' | '-' | ' ' | 'other'
    const at = { kind, line, text: line.slice(1), n, o }
    if (kind === '+' || kind === ' ') { n++; nLeft-- }
    if (kind === '-' || kind === ' ') { o++; oLeft-- }
    yield { ...at, shift: o - n }
  }
}

/** The new side's lines of each hunk of a unified diff (a deletion: the line it happened at). */
export function hunksOf(diff: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const d of walkDiff(diff)) {
    if (d.kind === 'hunk') out.push({ start: d.start, end: d.start + Math.max(0, d.count - 1) })
  }
  return out
}

/**
 * The code lines of a change between two commits (or a commit and the working tree when `to` is undefined): counted
 * files only, blank and comment-only lines left out. `[{ file, sign: '+' | '-', text (trimmed), line (new side, for +) }]`.
 */
export function codeLines(repo: string, from: string, to?: string, exempt: string[] = [], all: NumstatFile[] = numstat(repo, from, to)): CodeLine[] {
  const list = pathsOf(all.filter((f) => counted(f.file, exempt) && !f.binary))
  if (!list.length) return []
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', from, ...(to ? [to] : []), '--', ...list])
  const out: CodeLine[] = []
  // The file: the last path named that isn't /dev/null (a deleted file's lines are its old name's).
  let file: string | undefined
  // An open block comment, on each side (isCode).
  let plus: CommentState = {}, minus: CommentState = {}
  for (const d of walkDiff(diff)) {
    if (d.kind === 'section') file = undefined
    else if (d.kind === 'old' || d.kind === 'new') file = d.path === '/dev/null' ? file : d.path
    else if (d.kind === 'hunk') { plus = {}; minus = {} }
    else if (file && d.kind === '+' && isCode(d.text, file, plus)) out.push({ file, sign: '+', text: d.text.trim(), line: d.n })
    else if (file && d.kind === '-' && isCode(d.text, file, minus)) out.push({ file, sign: '-', text: d.text.trim() })
  }
  return out
}

/**
 * What changed in CODE lines between two commits (or a commit and the working tree when `to` is undefined): counted
 * files only, blank and comment-only lines left out. `{ files, added, removed, exempt: [exempt files that changed],
 * exemptOnly }`.
 */
export function codeStat(repo: string, from: string, to?: string, exempt: string[] = []): CodeStat {
  const all = numstat(repo, from, to)
  const out = { files: 0, added: 0, removed: 0, exempt: all.filter((f) => !own(f.file) && !counted(f.file, exempt)).map((f) => f.file) } as CodeStat
  const lines = codeLines(repo, from, to, exempt, all)
  for (const x of lines) { if (x.sign === '+') out.added++; else out.removed++ }
  out.files = new Set(lines.map((x) => x.file)).size
  out.exemptOnly = !all.some((f) => counted(f.file, exempt)) && out.exempt.length > 0
  // Only documentation changed (README, docs/): one question about what a reader now sees differently.
  out.docsOnly = out.files > 0 && lines.every((x) => isDoc(x.file))
  // Moved or renamed files (detected by git, -M): a move is a change even when no line changed.
  out.renamed = all.filter((f) => f.from && counted(f.file, exempt)).map((f) => ({ from: f.from!, to: f.file }))
  return out
}

/** Lines of `now` that `was` doesn't have (same file, sign and trimmed text; each line of `was` used once). */
export function newCodeLines(was: CodeLine[], now: CodeLine[]): CodeLine[] {
  const bag = new Map<string, number>()
  const key = (x: CodeLine) => `${x.file}\0${x.sign}${x.text}`
  for (const x of was) bag.set(key(x), (bag.get(key(x)) ?? 0) + 1)
  return now.filter((x) => { const k = key(x), c = bag.get(k) ?? 0; if (c) { bag.set(k, c - 1); return false } return true })
}

/**
 * The code lines the branch's OWN change has now and didn't have when the questions were written: the change against
 * today's merge base (`base`) compared with the change the questions were written for (`check.base` → `check.head`).
 * Merging or rebasing onto the target branch adds nothing; a conflict resolved differently does. Undefined when the
 * check's commits are not in this clone.
 */
export function freshLines(repo: string, check: Check, base: string | undefined, to?: string, exempt: string[] = []): CodeLine[] | undefined {
  if (!base || !hasCommit(repo, check.base) || !hasCommit(repo, check.head)) return undefined
  return newCodeLines(codeLines(repo, check.base!, check.head, exempt), codeLines(repo, base, to, exempt))
}

/** `[{ file, sign, line }]` → file -> new-side ranges [[start, end], …] of the added lines. */
export function rangesOf(lines: CodeLine[]): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>()
  for (const x of [...lines].filter((y) => y.sign === '+').sort((p, q) => p.file.localeCompare(q.file) || p.line! - q.line!)) {
    const rs = map.get(x.file) ?? map.set(x.file, []).get(x.file)!
    const last = rs[rs.length - 1]
    if (last && x.line! <= last[1] + 1) last[1] = Math.max(last[1], x.line!); else rs.push([x.line!, x.line!])
  }
  return map
}

/** `git diff --numstat` between two commits (or a commit and the working tree when `to` is undefined). */
export function numstat(repo: string, from: string, to?: string): NumstatFile[] {
  const out = git(repo, ['diff', '--numstat', '-z', '-M', from, ...(to ? [to] : []), '--'])
  const parts = out.split('\0')
  const files: NumstatFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p)
    if (!m) continue
    let file = m[3], from: string | undefined
    if (!file) { from = parts[i + 1]; i += 2; file = parts[i] } // a rename: "a\tr\t\0old\0new"
    files.push({ file, ...(from ? { from } : {}), added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' })
  }
  return files
}
export function stat(files: NumstatFile[], exempt: string[] = []): { files: number; added: number; removed: number } {
  const c = files.filter((f) => counted(f.file, exempt))
  return { files: c.length, added: c.reduce((s, f) => s + f.added, 0), removed: c.reduce((s, f) => s + f.removed, 0) }
}
export const linesOf = (s: { added: number; removed: number }): number => s.added + s.removed

/** The unified diff of the counted files. */
export function diffText(repo: string, from: string, to?: string, files?: NumstatFile[], exempt: string[] = []): string {
  const list = pathsOf((files ?? numstat(repo, from, to)).filter((f) => counted(f.file, exempt) && !f.binary))
  if (!list.length) return ''
  return git(repo, ['diff', '--no-color', '-U3', '-M', from, ...(to ? [to] : []), '--', ...list])
}

/**
 * diffText, or '' when git can't give it (a commit missing from a shallow clone, an unreadable repository): the
 * grader then reads the files, and links point at the file instead of the diff. One place decides that no diff is fine.
 */
export function diffOrEmpty(repo: string, from: string, to?: string, exempt: string[] = []): string {
  try {
    return diffText(repo, from, to, undefined, exempt)
  } catch {
    return ''
  }
}

/** A diff with the new file's line numbers in front: what a question's lines refer to. */
export function numberDiff(diff: string): string {
  const out: string[] = []
  for (const d of walkDiff(diff)) {
    if (d.kind === 'section') out.push('')
    if (d.kind === '+' || d.kind === ' ') out.push(`${String(d.n).padStart(5)} ${d.line}`)
    else if (d.kind === '-') out.push(`      ${d.line}`)
    else if (d.line) out.push(d.line)
  }
  return out.join('\n').trim()
}

/** file -> new-side line ranges that were added or changed: [[start, end], …]. `codeOnly`: blank and comment lines left out. */
export function changedRanges(diff: string, { codeOnly = false }: { codeOnly?: boolean } = {}): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>()
  // The file (the new side's; none for a deleted one), the run of changed lines, an open block comment (isCode).
  let file: string | undefined, run: [number, number] | undefined, cs: CommentState = {}
  const close = () => {
    if (run && file) map.set(file, [...(map.get(file) ?? []), run])
    run = undefined
  }
  for (const d of walkDiff(diff)) {
    if (d.kind === 'section' || d.kind === 'old' || d.kind === ' ') close()
    else if (d.kind === 'new') { close(); file = d.path === '/dev/null' ? undefined : d.path }
    else if (d.kind === 'hunk') { close(); cs = {} }
    else if (d.kind === '+' && codeOnly && !isCode(d.text, file!, cs)) close()
    else if (d.kind === '+' && run && run[1] === d.n - 1) run[1] = d.n
    else if (d.kind === '+') { close(); run = [d.n, d.n] }
    // A deletion marks the line after it.
    else if (d.kind === '-' && !run && !codeOnly) run = [d.n, d.n]
  }
  close()
  return map
}

/**
 * Where code lines were removed, on the new side (`Map<file, [line, line][]>`: the line after the removal, in files
 * that still exist): a question about a removal sits there.
 */
export function removalPoints(diff: string): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>()
  // The file on the new side (none for a deleted one); its old name (whose language says what a comment is).
  let file: string | undefined, old: string | undefined, cs: CommentState = {}
  for (const d of walkDiff(diff)) {
    if (d.kind === 'old') old = d.path
    else if (d.kind === 'new') file = d.path === '/dev/null' ? undefined : d.path
    else if (d.kind === 'section') file = undefined
    else if (d.kind === 'hunk') cs = {}
    else if (d.kind === '-' && file && isCode(d.text, old ?? file, cs)) {
      const at = Math.max(1, d.n)
      const rs = map.get(file) ?? []
      // Next to a removal already marked: the same place.
      if (!rs.some(([a, b]) => at >= a && at <= b + 1)) rs.push([at, at])
      map.set(file, rs)
    }
  }
  return map
}

/**
 * The old-side line GitLab pairs with new-side line `n` of `file` in a unified diff (its diff line codes are
 * `sha1(path)_old_new`; an added line carries the old counter where it was added). Undefined when the file is not in it.
 */
export function oldLineOf(diff: string, file: string, n: number): number | undefined {
  // In the file's part of the diff; seen it; old minus new as of the last line read (lines outside hunks keep it).
  let inFile = false, seen = false, shift = 0
  for (const d of walkDiff(diff)) {
    if (d.kind === 'section' && inFile) return n + shift
    if (d.kind === 'section') continue
    if (d.kind === 'new') { inFile = d.path === file; seen ||= inFile; continue }
    if (!inFile || d.kind === 'old') continue
    if (d.kind === 'hunk') {
      if (n < d.start) return n + shift
      continue
    }
    if ((d.kind === '+' || d.kind === ' ') && d.n === n) return d.o
    shift = d.shift
  }
  return seen ? n + shift : undefined
}

/**
 * The new-side line of `file` to put a thread on: `line` itself when the diff changed it, else the nearest changed line
 * of its hunk, else the nearest changed line of the file within 20 lines (a thread can only go on a line of the diff).
 * Undefined when there is none.
 */
export function nearestChanged(diff: string | undefined, file: string, line: number): number | undefined {
  const added: number[] = [], hunks: [number, number][] = []
  let inFile = false
  for (const d of walkDiff(String(diff ?? ''))) {
    if (d.kind === 'section') inFile = false
    else if (d.kind === 'new') inFile = d.path === file
    else if (inFile && d.kind === 'hunk') hunks.push([d.start, d.start + d.count - 1])
    else if (inFile && d.kind === '+') added.push(d.n)
  }
  if (added.includes(line)) return line
  const near = (xs: number[]) => xs.reduce<number | undefined>((a, b) => (a === undefined || Math.abs(b - line) < Math.abs(a - line) ? b : a), undefined)
  const hunk = hunks.find(([x, y]) => line >= x && line <= y)
  const inHunk = hunk ? added.filter((x) => x >= hunk[0] && x <= hunk[1]) : []
  return near(inHunk) ?? near(added.filter((x) => Math.abs(x - line) <= 20))
}
