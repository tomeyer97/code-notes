// A TODO comment about a concern, added from the check: its lines (wrapped, the whole concern), where it goes, and the
// comment marks of the file's language. No vscode API here (unit-tested in test/checkModel.test.ts).
import * as path from 'path'

/**
 * A TODO comment with the whole concern (never cut): lines of at most `max` characters after `indent`, wrapped at
 * words; the first says "TODO:", the others line up under its text.
 */
export function todoLines(mark: [string, string], text: string, max = 100): string[] {
  const head = `${mark[0]} TODO: `, more = `${mark[0]}${' '.repeat(head.length - mark[0].length)}`, room = Math.max(20, max - head.length - mark[1].length)
  const out: string[] = []
  let cur = ''
  for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (cur && cur.length + 1 + w.length > room) { out.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) out.push(cur)
  // A block comment: one opening and one closing mark around all its lines.
  if (mark[1]) return out.map((l, i) => `${i ? ' '.repeat(head.length) : head}${l}${i === out.length - 1 ? mark[1] : ''}`)
  return out.map((l, i) => `${i ? more : head}${l}`)
}

/**
 * Where a TODO about a line goes: above it, at its indentation; a line that closes a block and opens the next ("} catch
 * (err) {", "} else {") is about the block it opens, so the TODO goes inside, at the next line's indentation.
 */
export function todoPlace(lines: string[], at: number): { line: number; indent: string } {
  const ind = (l: string | undefined) => (l ?? '').match(/^\s*/)![0]
  const t = (lines[at] ?? '').trim()
  if (/^[}\])]/.test(t) && /[{:]\s*$/.test(t) && at + 1 < lines.length) return { line: at + 1, indent: ind(lines[at + 1]) || `${ind(lines[at])}  ` }
  return { line: at, indent: ind(lines[at]) }
}

const HASH: [string, string] = ['#', '']
const DASHES: [string, string] = ['--', '']
const HTML: [string, string] = ['<!--', ' -->']
const BLOCK: [string, string] = ['/*', ' */']
/** A comment's [open, close] by file extension (todoLines); any other file: `//`. */
const COMMENT_MARKS: Record<string, [string, string]> = {
  '.py': HASH, '.rb': HASH, '.sh': HASH, '.bash': HASH, '.yaml': HASH, '.yml': HASH, '.toml': HASH, '.r': HASH,
  '.pl': HASH, '.ex': HASH, '.exs': HASH, '.tf': HASH,
  '.sql': DASHES, '.lua': DASHES, '.hs': DASHES,
  '.html': HTML, '.xml': HTML, '.vue': HTML, '.svelte': HTML, '.md': HTML,
  '.css': BLOCK, '.scss': BLOCK,
}
/** Files known by name, not extension. */
const HASH_FILES = /(^|\/)(Dockerfile|Makefile)$/

/** A comment for a file's language: [open, close] (a line comment closes with ''). */
export function commentMark(file: string): [string, string] {
  if (HASH_FILES.test(file)) return HASH
  const ext = path.extname(file).toLowerCase()
  return Object.hasOwn(COMMENT_MARKS, ext) ? COMMENT_MARKS[ext] : ['//', '']
}
