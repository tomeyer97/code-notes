// Comment syntax by file type, and whether a line is code (not blank, not a whole-line comment).
import path from 'node:path'

// Comment syntax by file extension (pragmatic: whole-line comments only; a block comment is followed within a hunk).
const C_LIKE = { line: ['//'], block: [['/*', '*/']], star: true }
const HASH = { line: ['#'] }
const DASH = { line: ['--'] }
const MARKUP = { block: [['<!--', '-->']] }
const STYLES = {
  js: C_LIKE, mjs: C_LIKE, cjs: C_LIKE, jsx: C_LIKE, ts: C_LIKE, mts: C_LIKE, cts: C_LIKE, tsx: C_LIKE, java: C_LIKE, kt: C_LIKE, kts: C_LIKE,
  scala: C_LIKE, groovy: C_LIKE, gradle: C_LIKE, c: C_LIKE, h: C_LIKE, cc: C_LIKE, cpp: C_LIKE, cxx: C_LIKE, hpp: C_LIKE, m: C_LIKE, mm: C_LIKE,
  cs: C_LIKE, go: C_LIKE, rs: C_LIKE, swift: C_LIKE, dart: C_LIKE, proto: C_LIKE, zig: C_LIKE, sol: C_LIKE, jsonc: C_LIKE, json5: C_LIKE,
  css: { block: [['/*', '*/']], star: true }, scss: C_LIKE, less: C_LIKE,
  php: { line: ['//', '#'], block: [['/*', '*/']], star: true },
  py: HASH, pyi: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, fish: HASH, ps1: HASH, pl: HASH, pm: HASH, r: HASH, ex: HASH, exs: HASH,
  yml: HASH, yaml: HASH, toml: HASH, cfg: HASH, conf: HASH, ini: { line: ['#', ';'] }, properties: HASH, env: HASH, mk: HASH, cmake: HASH,
  tf: { line: ['#', '//'], block: [['/*', '*/']] }, hcl: { line: ['#', '//'], block: [['/*', '*/']] }, nix: HASH, jl: HASH, nim: HASH,
  sql: { line: ['--'], block: [['/*', '*/']] }, lua: DASH, hs: DASH, elm: DASH, ada: DASH,
  html: MARKUP, htm: MARKUP, xml: MARKUP, svg: MARKUP, xhtml: MARKUP, md: MARKUP, markdown: MARKUP,
  vue: { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']], star: true }, svelte: { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']], star: true },
  erb: MARKUP, ejs: MARKUP, hbs: MARKUP, jsp: MARKUP,
}
const BY_NAME = { dockerfile: HASH, makefile: HASH, gemfile: HASH, rakefile: HASH, procfile: HASH, '.gitignore': HASH, '.dockerignore': HASH, '.gitattributes': HASH }
/** How a file writes comments (undefined: no comments known; only blank lines don't count). */
export function commentStyle(file) {
  const name = path.posix.basename(String(file)).toLowerCase()
  if (BY_NAME[name] || name.startsWith('dockerfile')) return BY_NAME[name] ?? HASH
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1]
  return ext ? STYLES[ext] : undefined
}

/**
 * Whether a line is code: not blank, not a whole-line comment. `state.block`: the close marker of a block comment the
 * previous line left open (pass the same object for consecutive lines; it is updated).
 */
export function isCode(line, file, state = {}) {
  const t = String(line).trim()
  if (!t) return false
  const st = commentStyle(file)
  if (!st) return true
  if (state.block) {
    const at = t.indexOf(state.block)
    if (at < 0) return false
    const rest = t.slice(at + state.block.length).trim()
    state.block = undefined
    return !!rest && isCode(rest, file, state)
  }
  if (st.line?.some((p) => t.startsWith(p))) return false
  for (const [open, close] of st.block ?? []) {
    if (!t.startsWith(open)) continue
    const end = t.indexOf(close, open.length)
    if (end < 0) { state.block = close; return false }
    const rest = t.slice(end + close.length).trim()
    return !!rest && isCode(rest, file, state)
  }
  // The middle and end lines of a /** … */ block written one "*" per line.
  if (st.star && /^\*(\/|\s|$)/.test(t)) return false
  return true
}
