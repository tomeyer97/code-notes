// A TODO comment about a concern, added from the check: its lines (wrapped, the whole concern), where it goes, and the
// comment marks of the file's language. No vscode API here (unit-tested in test/checkTodoComment.test.ts).
import * as path from 'path'

/** `text`'s words in lines of at most `width` characters (a longer word gets a line of its own); nothing cut. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!word) continue
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * A TODO comment with the whole concern (never cut): lines of at most `max` characters after `indent`, wrapped at
 * words; the first says "TODO:", the others line up under its text.
 */
export function todoLines(mark: [string, string], text: string, max = 100): string[] {
  const [open, close] = mark
  const head = `${open} TODO: `
  const room = Math.max(20, max - head.length - close.length)
  const lines = wrapWords(text, room)
  // A block comment: one opening mark before its first line and one closing mark after its last.
  const lead = close ? ' '.repeat(head.length) : `${open}${' '.repeat(head.length - open.length)}`
  const last = lines.length - 1
  return lines.map((l, i) => `${i === 0 ? head : lead}${l}${i === last ? close : ''}`)
}

/** A line that closes a block and opens the next ("} catch (err) {", "} else {", "]):"): brace languages only. */
export const opensNextBlock = (trimmed: string): boolean => /^[}\])]/.test(trimmed) && /[{:]\s*$/.test(trimmed)

/**
 * Where a TODO about a line goes: above it, at its indentation; a line that closes a block and opens the next is about
 * the block it opens, so the TODO goes inside, at the next line's indentation.
 */
export function todoPlace(lines: string[], at: number): { line: number; indent: string } {
  const indentOf = (l: string | undefined) => (l ?? '').match(/^\s*/)![0]
  const t = (lines[at] ?? '').trim()
  if (opensNextBlock(t) && at + 1 < lines.length) {
    return { line: at + 1, indent: indentOf(lines[at + 1]) || `${indentOf(lines[at])}  ` }
  }
  return { line: at, indent: indentOf(lines[at]) }
}

type Mark = [string, string]
const SLASHES: Mark = ['//', '']
const HASH: Mark = ['#', '']
const DASHES: Mark = ['--', '']
const SEMI: Mark = [';', '']
const HTML: Mark = ['<!--', ' -->']
const BLOCK: Mark = ['/*', ' */']

/**
 * A comment's [open, close] by VS Code's language id: the languages whose line comment is not `//`. A language VS Code
 * knows only through an extension (TOML, Terraform, …) may come as plain text: the file's extension says then.
 */
const MARKS_BY_LANGUAGE: Record<string, Mark> = {
  python: HASH, ruby: HASH, shellscript: HASH, yaml: HASH, toml: HASH, r: HASH, perl: HASH, elixir: HASH,
  terraform: HASH, dockerfile: HASH, makefile: HASH, powershell: HASH, coffeescript: HASH, julia: HASH,
  sql: DASHES, lua: DASHES, haskell: DASHES,
  ini: SEMI, clojure: SEMI,
  html: HTML, xml: HTML, vue: HTML, svelte: HTML, markdown: HTML,
  css: BLOCK, scss: BLOCK, less: BLOCK,
}
/** A comment's [open, close] by file extension, for a file whose language VS Code doesn't say. */
const MARKS_BY_EXTENSION: Record<string, Mark> = {
  '.py': HASH, '.rb': HASH, '.sh': HASH, '.bash': HASH, '.yaml': HASH, '.yml': HASH, '.toml': HASH, '.r': HASH,
  '.pl': HASH, '.ex': HASH, '.exs': HASH, '.tf': HASH,
  '.sql': DASHES, '.lua': DASHES, '.hs': DASHES,
  '.html': HTML, '.xml': HTML, '.vue': HTML, '.svelte': HTML, '.md': HTML,
  '.css': BLOCK, '.scss': BLOCK,
}
/** Files known by name, not extension. */
const HASH_FILES = /(^|\/)(Dockerfile|Makefile)$/

/** A comment for a file's language, by its name: [open, close] (a line comment closes with ''); any other file: `//`. */
export function commentMark(file: string): Mark {
  if (HASH_FILES.test(file)) return HASH
  const ext = path.extname(file).toLowerCase()
  return Object.hasOwn(MARKS_BY_EXTENSION, ext) ? MARKS_BY_EXTENSION[ext] : SLASHES
}

/** A comment for an open document: by its language (`languageId`), else by its file name (commentMark). */
export function commentMarkFor(languageId: string, file: string): Mark {
  return Object.hasOwn(MARKS_BY_LANGUAGE, languageId) ? MARKS_BY_LANGUAGE[languageId] : commentMark(file)
}
