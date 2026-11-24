// npm run lint's second half: the import rule between the layers of src/ (scripts/layers.json) and the size of the
// largest import cycle. Known violations are listed per src/ folder in scripts/layer-exceptions/<folder>.txt; a new
// violation, a listed one that is gone, or a larger cycle fails. Run: node scripts/check-layers.mjs [--write]
// (--write rewrites the exception files from today's violations, keeping their max-scc headers).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ts = createRequire(import.meta.url)('typescript')

/** The module specifiers a source file imports: import/export ... from, import(), require(), import x = require(). */
export function importsOf(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const out = []
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text)
    else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push(n.arguments[0].text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const posix = (p) => p.split(path.sep).join('/')

/** The import graph of `src`: file (relative to root, posix) -> files it imports, plus the bare modules it imports. */
export function importGraph(root, src = 'src') {
  const files = walk(path.join(root, src)).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  const known = new Set(files.map((f) => posix(path.relative(root, f))))
  const graph = new Map()
  const bare = new Map()
  for (const f of files) {
    const rel = posix(path.relative(root, f))
    const deps = new Set()
    const mods = new Set()
    for (const spec of importsOf(f, fs.readFileSync(f, 'utf8'))) {
      if (!spec.startsWith('.')) { mods.add(spec); continue }
      const base = posix(path.relative(root, path.resolve(path.dirname(f), spec))).replace(/\.js$/, '')
      const hit = [`${base}.ts`, `${base}/index.ts`].find((c) => known.has(c))
      if (hit) deps.add(hit)
    }
    graph.set(rel, [...deps].sort())
    bare.set(rel, [...mods].sort())
  }
  return { graph, bare }
}

/** Strongly connected components (Tarjan), each a sorted list of files; only cycles (size > 1 or a self-import). */
export function cycles(graph) {
  let index = 0
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = []
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++
    stack.push(v); on.add(v)
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
    }
    if (low.get(v) === idx.get(v)) {
      const scc = []
      let w
      do { w = stack.pop(); on.delete(w); scc.push(w) } while (w !== v)
      if (scc.length > 1 || (graph.get(v) ?? []).includes(v)) out.push(scc.sort())
    }
  }
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v)
  return out.sort((a, b) => b.length - a.length)
}

/** The src/ folder a file is in (its first segment under src/), or '' for the files at the root of src/. */
export const folderOf = (file, src = 'src') => {
  const parts = file.slice(src.length + 1).split('/')
  return parts.length > 1 ? parts[0] : ''
}

/** The layer of a file by the rules: its folder's layer, or the root file's layer; undefined when unassigned. */
export function layerOf(file, rules) {
  const src = rules.src ?? 'src'
  const folder = folderOf(file, src)
  const key = folder || file.slice(src.length + 1)
  return rules.layers.findIndex((l) => l.members.includes(key) || (!folder && l.members.includes('*.ts')))
}

/** Every import that breaks the rules, as `<from> -> <to>` (or `<from> -> <module>` for a forbidden module). */
export function violations(graph, bare, rules) {
  const out = []
  const shared = new Set(rules.shared ?? [])
  const src = rules.src ?? 'src'
  for (const [from, deps] of graph) {
    const lf = layerOf(from, rules)
    for (const to of deps) {
      if (shared.has(folderOf(to, src))) continue
      const lt = layerOf(to, rules)
      if (lt > lf) out.push(`${from} -> ${to}`)
    }
    const forbidden = rules.layers[lf]?.forbid ?? []
    for (const m of bare.get(from) ?? []) if (forbidden.includes(m)) out.push(`${from} -> ${m}`)
  }
  return out.sort()
}

/** The exception files: folder -> { lines, maxScc (the `# max-scc: N` header, if any) }. */
export function readExceptions(dir) {
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    const head = /^#\s*max-scc:\s*(\d+)\s*$/m.exec(text)
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    out.set(name.replace(/\.txt$/, ''), { lines, maxScc: head ? Number(head[1]) : undefined })
  }
  return out
}

/** The whole check. Returns the problems (empty when it passes) and what it measured. */
export function check(root, { rulesFile = 'scripts/layers.json', exceptionsDir = 'scripts/layer-exceptions' } = {}) {
  const rules = JSON.parse(fs.readFileSync(path.join(root, rulesFile), 'utf8'))
  const src = rules.src ?? 'src'
  const { graph, bare } = importGraph(root, src)
  const problems = []
  for (const f of graph.keys()) if (layerOf(f, rules) < 0 && !(rules.shared ?? []).includes(folderOf(f, src))) problems.push(`${f}: in no layer (add its folder to ${rulesFile})`)
  const found = violations(graph, bare, rules)
  const exceptions = readExceptions(path.join(root, exceptionsDir))
  const listed = new Set([...exceptions.values()].flatMap((e) => e.lines))
  for (const v of found) if (!listed.has(v)) problems.push(`${v}: imports a higher layer (scripts/layers.json)`)
  const foundSet = new Set(found)
  for (const [folder, e] of exceptions) for (const l of e.lines) if (!foundSet.has(l)) problems.push(`${exceptionsDir}/${folder}.txt: "${l}" is fixed: remove the line`)
  const sccs = cycles(graph)
  const largest = sccs[0]?.length ?? 0
  const ceilings = [rules.maxScc, ...[...exceptions.values()].map((e) => e.maxScc)].filter((n) => n !== undefined)
  const ceiling = ceilings.length ? Math.min(...ceilings) : Infinity
  if (largest > ceiling) problems.push(`the largest import cycle has ${largest} files, more than the ceiling ${ceiling}: ${sccs[0].join(', ')}`)
  for (const [folder, max] of Object.entries(rules.maxSccIn ?? {})) {
    const inside = new Map([...graph].filter(([f]) => folderOf(f, src) === folder).map(([f, d]) => [f, d.filter((t) => folderOf(t, src) === folder)]))
    const n = cycles(inside)[0]?.length ?? 0
    if (n > max) problems.push(`the largest import cycle inside ${src}/${folder} has ${n} files, more than the ceiling ${max}`)
  }
  return { problems, violations: found, largest, ceiling, rules }
}

/** Rewrites the exception files from today's violations, one file per folder, keeping each file's header comments. */
export function writeExceptions(root, found, { exceptionsDir = 'scripts/layer-exceptions', src = 'src' } = {}) {
  const dir = path.join(root, exceptionsDir)
  fs.mkdirSync(dir, { recursive: true })
  const byFolder = new Map()
  for (const v of found) {
    const folder = folderOf(v.split(' -> ')[0], src) || 'root'
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), v])
  }
  const names = new Set([...fs.readdirSync(dir).filter((n) => n.endsWith('.txt')).map((n) => n.slice(0, -4)), ...byFolder.keys()])
  for (const folder of names) {
    const file = path.join(dir, `${folder}.txt`)
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const head = old.split('\n').filter((l) => l.startsWith('#'))
    const lines = byFolder.get(folder) ?? []
    if (!lines.length && !head.some((l) => /max-scc/.test(l))) { if (old) fs.rmSync(file); continue }
    const header = head.length ? head : [`# Imports from ${src}/${folder}/ that break the layer rule today; remove a line when you fix it.`]
    fs.writeFileSync(file, [...header, ...lines, ''].join('\n'))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = check(root)
  if (process.argv.includes('--write')) {
    writeExceptions(root, result.violations, { src: result.rules.src ?? 'src' })
    console.log(`wrote ${result.violations.length} known violations; largest cycle ${result.largest}`)
  } else if (result.problems.length) {
    for (const p of result.problems) console.error(p)
    process.exit(1)
  } else {
    console.log(`layers: ${result.violations.length} known violations; largest import cycle ${result.largest} files (ceiling ${result.ceiling})`)
  }
}
