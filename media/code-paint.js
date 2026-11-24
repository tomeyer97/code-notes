// A few lines of code, coloured: the beat's code under a step's animation (journey-scene.js). Colours that read as
// code in any theme (the panel can't have the editor's own): comments, strings, numbers, keywords and called names, a
// line at a time (a block comment's inner lines stay plain). The keywords and whether # starts a comment come from the
// file's language (by its extension); a file of another language gets every language's keywords, so a word that is a
// keyword in one of them may be coloured where it is a name.
// Exports tokens(text, lang) (the pure part, unit-tested), langOf(file), paintCode(into, text, lang) and
// showCode(codeEl, c).
import { el, baseName } from './common.js'

const JS_KEYWORDS = ['function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue',
  'var', 'const', 'let', 'import', 'export', 'from', 'class', 'extends', 'new', 'async', 'await', 'try', 'catch',
  'finally', 'throw', 'in', 'of', 'typeof', 'instanceof', 'yield', 'true', 'false', 'null', 'undefined', 'this']

/** Each language's keywords, and whether # starts a comment there; `exts`: its files' extensions. */
const LANGS = {
  go: {
    exts: ['go'],
    keywords: ['func', 'return', 'if', 'else', 'for', 'switch', 'case', 'default', 'break', 'continue', 'go', 'defer',
      'var', 'const', 'type', 'struct', 'interface', 'import', 'package', 'range', 'map', 'chan', 'select', 'true',
      'false', 'nil'],
  },
  js: { exts: ['js', 'mjs', 'cjs', 'jsx'], keywords: JS_KEYWORDS },
  ts: { exts: ['ts', 'mts', 'cts', 'tsx'], keywords: [...JS_KEYWORDS, 'type', 'interface', 'enum', 'implements', 'readonly'] },
  py: {
    exts: ['py'],
    hash: true,
    keywords: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from', 'class',
      'async', 'await', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'pass', 'in', 'not', 'and', 'or', 'is',
      'None', 'True', 'False', 'self'],
  },
  rb: {
    exts: ['rb'],
    hash: true,
    keywords: ['def', 'end', 'do', 'return', 'if', 'elsif', 'else', 'unless', 'for', 'while', 'case', 'break', 'class',
      'module', 'new', 'begin', 'rescue', 'ensure', 'yield', 'in', 'not', 'and', 'or', 'true', 'false', 'nil', 'self'],
  },
  /** Shell and config files: # comments, and their literals. */
  conf: { exts: ['sh', 'yml', 'yaml', 'toml'], hash: true, keywords: ['true', 'false', 'null'] },
}
/** @typedef {{ keywords: Set<string>, hash: boolean }} Lang */

/** A file of no language above: every language's keywords; # starts a comment in a Dockerfile or a Makefile. */
const ALL_KEYWORDS = new Set(Object.values(LANGS).flatMap((l) => l.keywords))
/** Each extension's language. */
const BY_EXT = new Map(Object.values(LANGS).flatMap((l) => l.exts.map((x) => /** @type {[string, Lang]} */ ([x, { keywords: new Set(l.keywords), hash: !!l.hash }]))))

/**
 * The language of `file` (its path): its keywords and whether # starts a comment.
 * @param {string} file
 * @returns {Lang}
 */
export function langOf(file) {
  const name = baseName(file)
  const ext = /\.([\w]+)$/.exec(name)
  return (ext && BY_EXT.get(ext[1].toLowerCase())) || { keywords: ALL_KEYWORDS, hash: /^(Dockerfile|Makefile)/.test(name) }
}

/** One token per match, by the group it fills. */
const TOKEN = [
  /(\/\/.*$|\/\*.*?(?:\*\/|$))/.source, // 1: a // or /* comment
  /(#.*$)/.source, // 2: a # comment (where # starts one)
  /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`[^`]*`?)/.source, // 3: a string
  /(\b\d[\w.]*)/.source, // 4: a number
  /([A-Za-z_$][\w$]*)/.source, // 5: a name
].join('|')
/** The indentation the lines share is cut, up to this many characters. */
const MAX_CUT = 99

/**
 * The token class (scn-tk-<class>) of match `m`, `next` the character after it: c (comment), s, n, k (keyword), f (a
 * called name), or '' (left plain).
 * @param {RegExpExecArray} m
 * @param {string | undefined} next
 * @param {Lang} lang
 */
function tokenClass(m, next, lang) {
  if (m[1]) return 'c'
  if (m[2]) return lang.hash ? 'c' : ''
  if (m[3]) return 's'
  if (m[4]) return 'n'
  if (lang.keywords.has(m[5])) return 'k'
  return next === '(' ? 'f' : ''
}

/**
 * `text` (one line) as pieces, each plain (`cls` '') or of a token class.
 * @param {string} text
 * @param {Lang} lang
 * @returns {{ text: string, cls: string }[]}
 */
export function tokens(text, lang) {
  const out = []
  // Its own regex each call: where it is in the line is this call's.
  const re = new RegExp(TOKEN, 'g')
  let at = 0, m
  while ((m = re.exec(text))) {
    // A # that is no comment here: only the sign is skipped, the rest is read on.
    if (m[2] && !lang.hash) { re.lastIndex = m.index + 1; continue }
    const end = m.index + m[0].length
    const cls = tokenClass(m, text[end], lang)
    if (!cls) continue
    if (m.index > at) out.push({ text: text.slice(at, m.index), cls: '' })
    out.push({ text: m[0], cls })
    at = end
  }
  if (at < text.length) out.push({ text: text.slice(at), cls: '' })
  return out
}

/**
 * `text` (one line) into `into`, coloured as `lang` (langOf).
 * @param {HTMLElement} into
 * @param {string} text
 * @param {Lang} lang
 */
export function paintCode(into, text, lang) {
  for (const t of tokens(text, lang)) into.append(t.cls ? el('span', `scn-tk-${t.cls}`, t.text) : t.text)
}

/**
 * The beat's line and a few around it (`c`: { file, line, from, lines }) into `codeEl`; none: hidden.
 * @param {HTMLElement} codeEl
 * @param {{ file: string, line: number, from: number, lines: string[] } | undefined} c
 */
export function showCode(codeEl, c) {
  codeEl.textContent = ''
  codeEl.hidden = !c || !c.lines || !c.lines.length
  if (!c || codeEl.hidden) return
  const head = el('div', 'scn-code-file', `${baseName(c.file)}:${c.line}`)
  head.title = c.file
  codeEl.append(head)
  // Without the indentation they share: the part that matters stays in view.
  const lang = langOf(String(c.file))
  const ls = c.lines.map((t) => String(t).replace(/\t/g, '  '))
  const indents = ls.filter((t) => t.trim()).map((t) => t.length - t.trimStart().length)
  const cut = Math.min(...indents, MAX_CUT)
  ls.forEach((t, k) => {
    const row = el('div', `scn-code-line${c.from + k === c.line ? ' on' : ''}`)
    const tx = el('span', 'scn-code-t')
    paintCode(tx, t.trim() ? t.slice(cut) : '', lang)
    row.append(el('span', 'scn-code-n', String(c.from + k)), tx)
    codeEl.append(row)
  })
}
