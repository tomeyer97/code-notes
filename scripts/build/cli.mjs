// The understanding CLI: cli/understanding.mjs, one ES module bundled by esbuild from cli/understanding/*.ts (entry
// index.ts), after a type check (cli/tsconfig.json). Committed: CI recipes download it by URL, `init` copies it into a
// repository; test/cli/bundle.test.mjs checks it is the build of the sources.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const BUILT = path.join(root, 'cli/understanding.mjs')

const HEADER = `#!/usr/bin/env node
// Understanding check: a few questions about your own change, answered next to the code (docs/understanding-check.md).
// One file, Node >= 18, no dependencies. Run it as a CLI (\`node understanding.mjs help\`) or import it (the
// understanding-check skill's script uses its functions, and the VS Code extension compiles the same modules, so the
// rules live in one place).
//
// Grading happens only locally (\`grade\`, or the extension). \`ci\` never calls a model: it checks that the check was
// done for this change and that its recorded verdicts meet the threshold.
//
// Generated from cli/understanding/*.ts by scripts/build/cli.mjs (npm run build): edit those, not this file.`

/** The built file's text, and the source files it was built from (relative to the repository). */
export async function buildCli() {
  const r = await esbuild.build({
    entryPoints: [path.join(root, 'cli/understanding/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    banner: { js: HEADER },
    charset: 'utf8',
    legalComments: 'none',
    write: false,
    metafile: true,
    logLevel: 'warning',
  })
  return { text: r.outputFiles[0].text, inputs: Object.keys(r.metafile.inputs).map((f) => path.relative(root, path.resolve(f))) }
}

/** Type-checks the sources (cli/tsconfig.json); exits on an error. */
export function typeCheck() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'cli/tsconfig.json')], { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  typeCheck()
  const { text, inputs } = await buildCli()
  fs.writeFileSync(BUILT, text)
  console.log(`${path.relative(process.cwd(), BUILT)}: built from ${inputs.length} modules`)
}
