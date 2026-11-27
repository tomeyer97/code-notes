// Golden files (test/README.md, "Golden tests"): what a pure function returns today, written out byte for byte in
// test/goldens/<area>/<name>.json (or .txt for a string), and compared on every run. A refactor that changes any
// byte of any output fails with a diff. `UPDATE_GOLDENS=1` writes them instead (review the diff before committing).
// Used by the TypeScript tests (out/test/golden-*.test.js) and the CLI's (test/cli/golden-*.test.mjs) alike.
import * as fs from 'fs'
import * as path from 'path'

/** test/goldens/ in the source tree (this file runs from out/test/). */
export const GOLDENS = path.join(__dirname, '..', '..', 'test', 'goldens')
const UPDATE = process.env.UPDATE_GOLDENS === '1'

/**
 * A value as its golden file holds it: a string as it is (a .txt file), anything else as JSON with two spaces, in its
 * real key order (the order is part of what is pinned), with what JSON can't say spelled out: `undefined` (a key that
 * is there with no value), Maps and Sets (with their entries in order), NaN and the infinities, functions.
 */
export function serialise(v: unknown): string {
  if (typeof v === 'string') return v.endsWith('\n') ? v : `${v}\n`
  const text = JSON.stringify(v, function (this: unknown, _k: string, x: unknown) {
    if (x === undefined) return '[undefined]'
    if (x instanceof Map) return { '[Map]': [...x.entries()] }
    if (x instanceof Set) return { '[Set]': [...x] }
    if (typeof x === 'number' && !Number.isFinite(x)) return `[${x}]`
    if (typeof x === 'function') return `[function ${x.name || 'anonymous'}]`
    if (typeof x === 'bigint') return `[bigint ${x}]`
    return x
  }, 2)
  return `${text}\n`
}

/** Golden names used in this process: one name, one value (a second use would silently overwrite the first). */
const used = new Set<string>()

/** The file `name` in `area` (`.txt` for a string, else `.json`). */
export function goldenPath(area: string, name: string, v: unknown): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !/^[a-z0-9-]+$/.test(area)) throw new Error(`golden name "${area}/${name}": letters, digits, . _ - only`)
  return path.join(GOLDENS, area, `${name}.${typeof v === 'string' ? 'txt' : 'json'}`)
}

/** The first lines where `want` and `got` differ, with a few lines around them, as a unified-looking excerpt. */
export function diffText(want: string, got: string, context = 3, max = 40): string {
  const a = want.split('\n'), b = got.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  // The common tail, so a changed line in the middle shows as - and + only.
  let ea = a.length - 1, eb = b.length - 1
  while (ea >= i && eb >= i && a[ea] === b[eb]) { ea--; eb-- }
  const out: string[] = [`@@ line ${i + 1} @@`]
  for (let k = Math.max(0, i - context); k < i; k++) out.push(`  ${a[k]}`)
  const cut = (lines: string[], sign: string) => {
    const shown = lines.slice(0, max)
    for (const l of shown) out.push(`${sign} ${l}`)
    if (lines.length > max) out.push(`${sign} … ${lines.length - max} more lines`)
  }
  cut(a.slice(i, ea + 1), '-')
  cut(b.slice(i, eb + 1), '+')
  for (let k = ea + 1; k < Math.min(a.length, ea + 1 + context); k++) out.push(`  ${a[k]}`)
  return out.join('\n')
}

/**
 * `value` must serialise to test/goldens/<area>/<name>.(json|txt) byte for byte. Missing or different: throws with
 * the diff (`-` the golden, `+` now). With UPDATE_GOLDENS=1: writes the file (and never throws for a difference).
 */
export function expectGolden(area: string, name: string, value: unknown): void {
  const file = goldenPath(area, name, value)
  const key = path.relative(GOLDENS, file)
  if (used.has(key)) throw new Error(`golden ${key} is used twice in one run`)
  used.add(key)
  const got = serialise(value)
  const want = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
  if (want === got) return
  if (UPDATE) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, got)
    return
  }
  const rel = path.relative(path.join(GOLDENS, '..', '..'), file)
  if (want === undefined) throw new Error(`golden ${rel} doesn't exist. Run UPDATE_GOLDENS=1 npm run test:goldens to write it, then review it.`)
  throw new Error(`golden ${rel} differs (- golden, + now). If the change is intended: UPDATE_GOLDENS=1 npm run test:goldens, and review the diff.\n${diffText(want, got)}`)
}

/**
 * `text` with what changes from run to run replaced by stable names: each `paths` entry (a temporary folder) by its
 * name, ISO times by `<time>`, and each distinct 40-hex commit id (and its 7+ character prefixes) by `<sha1>`,
 * `<sha2>`, … in order of first appearance.
 */
export function normalise(text: string, paths: Record<string, string> = {}): string {
  let t = text
  // The longest first: a path inside another is replaced whole.
  for (const [p, name] of Object.entries(paths).sort((x, y) => y[0].length - x[0].length)) t = t.split(p).join(name)
  t = t.replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<time>')
  const shas: string[] = []
  for (const m of t.matchAll(/\b[0-9a-f]{40}\b/g)) if (!shas.includes(m[0])) shas.push(m[0])
  shas.forEach((s, i) => { t = t.split(s).join(`<sha${i + 1}>`) })
  // Short ids of those commits (git's abbreviations), not any 7 hex characters.
  t = t.replace(/\b[0-9a-f]{7,39}\b/g, (m) => { const k = shas.findIndex((s) => s.startsWith(m)); return k < 0 ? m : `<sha${k + 1}:${m.length}>` })
  return t
}
