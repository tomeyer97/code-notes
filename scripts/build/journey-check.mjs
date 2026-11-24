// journey.py's checks: skills/code-journey/scripts/journey-check.mjs, one ES module bundled by esbuild from
// cli/journey/*.ts (entry index.ts) and the extension's format core, after a type check (cli/journey/tsconfig.json).
// Committed beside journey.py: the skill runs from a copy of its folder, with no build step.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const BUILT = path.join(root, 'skills/code-journey/scripts/journey-check.mjs')

const HEADER = `#!/usr/bin/env node
// The code-journey skill's checks (journey.py check, scene, mark, marks, podcast) on the Code Notes extension's own
// rules for journeys, scenes, marks, podcasts and anchors. journey.py runs it when node is on PATH; without node it
// uses its own copy of the rules. One file, Node >= 18, no dependencies.
//
// Generated from cli/journey/*.ts by scripts/build/journey-check.mjs (npm run build): edit those, not this file.`

/** The built file's text. */
export async function buildJourneyCheck() {
  const r = await esbuild.build({
    entryPoints: [path.join(root, 'cli/journey/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    banner: { js: HEADER },
    charset: 'utf8',
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  })
  return r.outputFiles[0].text
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const t = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'cli/journey/tsconfig.json')], { cwd: root, stdio: 'inherit' })
  if (t.status !== 0) process.exit(t.status ?? 1)
  fs.writeFileSync(BUILT, await buildJourneyCheck())
  console.log(`${path.relative(process.cwd(), BUILT)}: built`)
}
