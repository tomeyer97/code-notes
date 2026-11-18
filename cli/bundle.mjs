// Builds cli/understanding.mjs, the one file people run and copy (CI fetches it with curl; `init` copies it into a
// repository; the extension loads it), from the modules in cli/understanding/. Run `npm run cli` after editing them
// (`npm run build` runs it too); test/cli/bundle.test.mjs fails while the built file is out of date.
//
// The modules are joined in ORDER, as one scope: imports between them are dropped (the names are all in that scope),
// the node: imports are merged at the top. In a module, `export function` / `export const` is the CLI's API (exported
// by the built file too); `export { … }` at a module's end shares names with the other modules only and is dropped.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SOURCES = path.join(here, 'understanding')
export const BUILT = path.join(here, 'understanding.mjs')

/**
 * The modules in the order they are joined: a module's top-level values (tables, constants) may only use the ones
 * before it, and main.mjs, which runs the command line when the file is run, comes last.
 */
export const ORDER = [
  'constants', 'git', 'changeFiles', 'comments', 'diff', 'size', 'checkFile', 'validate', 'state', 'anchors', 'grading',
  'graderBackends', 'push', 'platform', 'mrComment', 'ci', 'threads', 'init', 'main',
]

const HEADER = `#!/usr/bin/env node
// Understanding check: a few questions about your own change, answered next to the code (docs/understanding-check.md).
// One file, Node >= 18, no dependencies. Run it as a CLI (\`node understanding.mjs help\`) or import it (the VS Code
// extension and the understanding-check skill's script use its functions, so the rules live in one place).
//
// Grading happens only locally (\`grade\`, or the extension). \`ci\` never calls a model: it checks that the check was
// done for this change and that its recorded verdicts meet the threshold.
//
// Built from cli/understanding/*.mjs by cli/bundle.mjs (npm run cli): edit those, not this file.`

/** An import statement at the start of a line (it may span lines): the names part and the module it names. */
const IMPORT = /^import ([\s\S]*?) from '([^']+)'\n/gm
/** `export { … }`: names shared between the modules only. */
const SHARED = /^export \{[^}]*\}\n/gm

/** The built file's text. */
export function bundle(dir = SOURCES) {
  /** node: module → its default import, and its named imports. */
  const node = new Map()
  const parts = ORDER.map((name) => {
    const text = fs.readFileSync(path.join(dir, `${name}.mjs`), 'utf8')
    const body = text.replace(IMPORT, (_m, what, from) => {
      if (from.startsWith('./')) return ''
      const n = node.get(from) ?? node.set(from, { def: undefined, names: new Set() }).get(from)
      const named = /\{([^}]*)\}/.exec(what)
      if (named) for (const x of named[1].split(',')) { if (x.trim()) n.names.add(x.trim()) }
      else n.def = what.trim()
      return ''
    }).replace(SHARED, '')
    return `// ---------- ${name}.mjs ----------\n\n${body.trim()}\n`
  })
  const imports = [...node].map(([from, n]) => (n.def ? `import ${n.def} from '${from}'` : `import { ${[...n.names].join(', ')} } from '${from}'`))
  return `${HEADER}\n${imports.join('\n')}\n\n${parts.join('\n')}`
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(BUILT, bundle())
  console.log(`${path.relative(process.cwd(), BUILT)}: built from ${ORDER.length} modules`)
}
