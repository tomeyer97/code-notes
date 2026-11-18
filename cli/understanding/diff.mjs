// Unified diffs: the change's code lines and size, the lines added or changed, where code was removed, and the line
// numbers a merge request's diff pairs.
import { git, hasCommit } from './git.mjs'
import { counted, isDoc, own } from './changeFiles.mjs'
import { isCode } from './comments.mjs'

/**
 * The code lines of a change between two commits (or a commit and the working tree when `to` is undefined): counted
 * files only, blank and comment-only lines left out. `[{ file, sign: '+' | '-', text (trimmed), line (new side, for +) }]`.
 */
/** The paths to diff for these files: a renamed file's old name too, so git pairs them (a pure move changes no line). */
const pathsOf = (files) => files.flatMap((f) => (f.from ? [f.from, f.file] : [f.file]))

export function codeLines(repo, from, to, exempt = [], all = numstat(repo, from, to)) {
  const list = pathsOf(all.filter((f) => counted(f.file, exempt) && !f.binary))
  if (!list.length) return []
  const out = []
  let file, n = 0, plus = {}, minus = {}
  for (const l of git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', from, ...(to ? [to] : []), '--', ...list]).split('\n')) {
    if (l.startsWith('diff --git')) { file = undefined; continue }
    if (l.startsWith('+++ ')) { const f = l.slice(4).replace(/^b\//, ''); if (f !== '/dev/null') file = f; continue }
    if (l.startsWith('--- ')) { const f = l.slice(4).replace(/^a\//, ''); if (f !== '/dev/null') file = f; continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { n = Number(h[1]); plus = {}; minus = {}; continue }
    if (!file) continue
    if (l[0] === '+') { if (isCode(l.slice(1), file, plus)) out.push({ file, sign: '+', text: l.slice(1).trim(), line: n }); n++ }
    else if (l[0] === '-' && isCode(l.slice(1), file, minus)) out.push({ file, sign: '-', text: l.slice(1).trim() })
  }
  return out
}

/**
 * What changed in CODE lines between two commits (or a commit and the working tree when `to` is undefined): counted
 * files only, blank and comment-only lines left out. `{ files, added, removed, exempt: [exempt files that changed],
 * exemptOnly }`.
 */
export function codeStat(repo, from, to, exempt = []) {
  const all = numstat(repo, from, to)
  const out = { files: 0, added: 0, removed: 0, exempt: all.filter((f) => !own(f.file) && !counted(f.file, exempt)).map((f) => f.file) }
  const lines = codeLines(repo, from, to, exempt, all)
  for (const x of lines) { if (x.sign === '+') out.added++; else out.removed++ }
  out.files = new Set(lines.map((x) => x.file)).size
  out.exemptOnly = !all.some((f) => counted(f.file, exempt)) && out.exempt.length > 0
  // Only documentation changed (README, docs/): one question about what a reader now sees differently.
  out.docsOnly = out.files > 0 && lines.every((x) => isDoc(x.file))
  // Moved or renamed files (detected by git, -M): a move is a change even when no line changed.
  out.renamed = all.filter((f) => f.from && counted(f.file, exempt)).map((f) => ({ from: f.from, to: f.file }))
  return out
}

/** Lines of `now` that `was` doesn't have (same file, sign and trimmed text; each line of `was` used once). */
export function newCodeLines(was, now) {
  const bag = new Map()
  const key = (x) => `${x.file}\0${x.sign}${x.text}`
  for (const x of was) bag.set(key(x), (bag.get(key(x)) ?? 0) + 1)
  return now.filter((x) => { const k = key(x), c = bag.get(k) ?? 0; if (c) { bag.set(k, c - 1); return false } return true })
}

/**
 * The code lines the branch's OWN change has now and didn't have when the questions were written: the change against
 * today's merge base (`base`) compared with the change the questions were written for (`check.base` → `check.head`).
 * Merging or rebasing onto the target branch adds nothing; a conflict resolved differently does. Undefined when the
 * check's commits are not in this clone.
 */
export function freshLines(repo, check, base, to, exempt = []) {
  if (!base || !hasCommit(repo, check.base) || !hasCommit(repo, check.head)) return undefined
  return newCodeLines(codeLines(repo, check.base, check.head, exempt), codeLines(repo, base, to, exempt))
}

/** `[{ file, sign, line }]` → file -> new-side ranges [[start, end], …] of the added lines. */
export function rangesOf(lines) {
  const map = new Map()
  for (const x of [...lines].filter((y) => y.sign === '+').sort((p, q) => p.file.localeCompare(q.file) || p.line - q.line)) {
    const rs = map.get(x.file) ?? map.set(x.file, []).get(x.file)
    const last = rs[rs.length - 1]
    if (last && x.line <= last[1] + 1) last[1] = Math.max(last[1], x.line); else rs.push([x.line, x.line])
  }
  return map
}

/** `git diff --numstat` between two commits (or a commit and the working tree when `to` is undefined). */
export function numstat(repo, from, to) {
  const out = git(repo, ['diff', '--numstat', '-z', '-M', from, ...(to ? [to] : []), '--'])
  const parts = out.split('\0')
  const files = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p)
    if (!m) continue
    let file = m[3], from
    if (!file) { from = parts[i + 1]; i += 2; file = parts[i] } // a rename: "a\tr\t\0old\0new"
    files.push({ file, ...(from ? { from } : {}), added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' })
  }
  return files
}
export function stat(files, exempt = []) {
  const c = files.filter((f) => counted(f.file, exempt))
  return { files: c.length, added: c.reduce((s, f) => s + f.added, 0), removed: c.reduce((s, f) => s + f.removed, 0) }
}
export const linesOf = (s) => s.added + s.removed

/** The unified diff of the counted files. */
export function diffText(repo, from, to, files, exempt = []) {
  const list = pathsOf((files ?? numstat(repo, from, to)).filter((f) => counted(f.file, exempt) && !f.binary))
  if (!list.length) return ''
  return git(repo, ['diff', '--no-color', '-U3', '-M', from, ...(to ? [to] : []), '--', ...list])
}

/** A diff with the new file's line numbers in front: what a question's lines refer to. */
export function numberDiff(diff) {
  const out = []
  let n = 0
  for (const l of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { n = Number(h[1]); out.push(l); continue }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) { if (l.startsWith('diff --git')) out.push(''); out.push(l); continue }
    if (l.startsWith('+')) out.push(`${String(n++).padStart(5)} ${l}`)
    else if (l.startsWith('-')) out.push(`      ${l}`)
    else if (l.startsWith(' ')) out.push(`${String(n++).padStart(5)} ${l}`)
    else if (l) out.push(l)
  }
  return out.join('\n').trim()
}

/** file -> new-side line ranges that were added or changed: [[start, end], …]. `codeOnly`: blank and comment lines left out. */
export function changedRanges(diff, { codeOnly = false } = {}) {
  const map = new Map()
  let file, n = 0, run, cs = {}
  const close = () => { if (run && file) { if (!map.has(file)) map.set(file, []); map.get(file).push(run) } run = undefined }
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { close(); file = l.slice(4).replace(/^b\//, ''); if (file === '/dev/null') file = undefined; continue }
    if (l.startsWith('--- ') || l.startsWith('diff --git')) { close(); continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { close(); n = Number(h[1]); cs = {}; continue }
    if (l.startsWith('+')) {
      if (codeOnly && !isCode(l.slice(1), file, cs)) { close(); n++; continue }
      if (run && run[1] === n - 1) run[1] = n; else { close(); run = [n, n] }
      n++
    }
    else if (l.startsWith('-')) { if (!run && !codeOnly) run = [n, n] } // a deletion marks the line after it
    else if (l.startsWith(' ')) { close(); n++ }
  }
  close()
  return map
}

/**
 * Where code lines were removed, on the new side (`Map<file, [line, line][]>`: the line after the removal, in files
 * that still exist): a question about a removal sits there.
 */
export function removalPoints(diff) {
  const map = new Map()
  let file, old, n = 0, cs = {}
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) { old = l.slice(4).replace(/^a\//, ''); continue }
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); if (file === '/dev/null') file = undefined; continue }
    if (l.startsWith('diff --git')) { file = undefined; continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { n = Number(h[1]); cs = {}; continue }
    if (l.startsWith('-')) { if (file && isCode(l.slice(1), old ?? file, cs)) { const at = Math.max(1, n); const rs = map.get(file) ?? []; if (!rs.some(([a, b]) => at >= a && at <= b + 1)) rs.push([at, at]); map.set(file, rs) } }
    else if (l.startsWith('+') || l.startsWith(' ')) n++
  }
  return map
}

/**
 * The old-side line GitLab pairs with new-side line `n` of `file` in a unified diff (its diff line codes are
 * `sha1(path)_old_new`; an added line carries the old counter where it was added). Undefined when the file is not in it.
 */
export function oldLineOf(diff, file, n) {
  let inFile = false, seen = false, o = 0, w = 0, offset = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) { if (inFile) return n + offset; inFile = false; continue }
    if (l.startsWith('+++ ')) { inFile = l.slice(4).replace(/^b\//, '') === file; seen ||= inFile; continue }
    if (!inFile || l.startsWith('--- ')) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { o = Number(h[1]); w = Number(h[2]); if (n < w) return n + offset; continue }
    if (l.startsWith('+')) { if (w === n) return o; w++ }
    else if (l.startsWith('-')) o++
    else if (l.startsWith(' ')) { if (w === n) return o; w++; o++ }
    offset = o - w
  }
  return seen ? n + offset : undefined
}

/**
 * The new-side line of `file` to put a thread on: `line` itself when the diff changed it, else the nearest changed line
 * of its hunk, else the nearest changed line of the file within 20 lines (a thread can only go on a line of the diff).
 * Undefined when there is none.
 */
export function nearestChanged(diff, file, line) {
  const added = [], hunks = []
  let inFile = false, n = 0
  for (const l of String(diff ?? '').split('\n')) {
    if (l.startsWith('diff --git')) { inFile = false; continue }
    if (l.startsWith('+++ ')) { inFile = l.slice(4).replace(/^b\//, '') === file; continue }
    if (!inFile || l.startsWith('--- ')) continue
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (h) { n = Number(h[1]); hunks.push([n, n + Number(h[2] ?? 1) - 1]); continue }
    if (l.startsWith('+')) added.push(n++)
    else if (l.startsWith(' ')) n++
  }
  if (added.includes(line)) return line
  const near = (xs) => xs.reduce((a, b) => (a === undefined || Math.abs(b - line) < Math.abs(a - line) ? b : a), undefined)
  const hunk = hunks.find(([x, y]) => line >= x && line <= y)
  return near(hunk ? added.filter((x) => x >= hunk[0] && x <= hunk[1]) : []) ?? near(added.filter((x) => Math.abs(x - line) <= 20))
}
