// scripts/check-layers.mjs (npm run lint) on a tiny tree written to a temporary folder: the layer rule, the exception
// lists, the cycle ceiling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'

type Result = { problems: string[]; violations: string[]; largest: number; ceiling: number }
type CheckLayers = { check(root: string): Result; cycles(graph: Map<string, string[]>): string[][] }

// The real import(): module commonjs would compile a written-out import() into require().
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<CheckLayers>
const script = () => dynamicImport(pathToFileURL(path.join(__dirname, '../../scripts/check-layers.mjs')).href)

const RULES = {
  src: 'src',
  layers: [
    { name: 'core', members: ['core'], forbid: ['vscode'] },
    { name: 'features', members: ['notes', 'tour'] },
    { name: 'composition', members: ['*.ts'] },
  ],
  shared: ['protocol'],
  maxScc: 2,
}

/** A repository with `files` (path -> text) and the rules above; returns its root. */
function tree(files: Record<string, string>, rules: object = RULES): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-'))
  const all = { 'scripts/layers.json': JSON.stringify(rules), ...files }
  for (const [f, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), text)
  }
  return root
}

const clean = {
  'src/core/text.ts': 'export const a = 1\n',
  'src/protocol/map.ts': 'export type M = 1\n',
  'src/notes/store.ts': "import { a } from '../core/text'\nimport type { M } from '../protocol/map'\nexport const b = a\n",
  'src/extension.ts': "import { b } from './notes/store'\nimport * as vscode from 'vscode'\nexport const c = b\n",
}

test('imports down the layers, into protocol/ and of allowed modules pass', async () => {
  const r = (await script()).check(tree(clean))
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.violations, [])
})

test('an import up the layers fails, unless its folder lists it', async () => {
  const { check } = await script()
  const up = { ...clean, 'src/core/text.ts': "import { b } from '../notes/store'\nexport const a = 1\n" }
  assert.deepEqual(check(tree(up)).problems, ['src/core/text.ts -> src/notes/store.ts: imports a higher layer (scripts/layers.json)'])
  const listed = { ...up, 'scripts/layer-exceptions/core.txt': '# known\nsrc/core/text.ts -> src/notes/store.ts\n' }
  assert.deepEqual(check(tree(listed)).problems, [])
})

test('a forbidden module (vscode in core/) and dynamic imports and requires count', async () => {
  const { check } = await script()
  const files = {
    ...clean,
    'src/core/text.ts': "import * as vscode from 'vscode'\nexport const a = 1\n",
    'src/core/late.ts': "export const l = () => import('../tour/walk')\nconst r = require('../notes/store')\n",
    'src/tour/walk.ts': 'export const w = 1\n',
  }
  assert.deepEqual(check(tree(files)).violations, [
    'src/core/late.ts -> src/notes/store.ts',
    'src/core/late.ts -> src/tour/walk.ts',
    'src/core/text.ts -> vscode',
  ])
})

test('protocol/ may import core/ but not a feature', async () => {
  const { check } = await script()
  const files = { ...clean, 'src/protocol/map.ts': "import type { a } from '../core/text'\nimport type { b } from '../notes/store'\nexport type M = 1\n" }
  assert.deepEqual(check(tree(files)).violations, ['src/protocol/map.ts -> src/notes/store.ts'])
})

test('a listed violation that is gone fails (the line has to go)', async () => {
  const r = (await script()).check(tree({ ...clean, 'scripts/layer-exceptions/core.txt': 'src/core/text.ts -> src/notes/store.ts\n' }))
  assert.deepEqual(r.problems, ['scripts/layer-exceptions/core.txt: "src/core/text.ts -> src/notes/store.ts" is fixed: remove the line'])
})

test('a file in a folder no layer names fails', async () => {
  const r = (await script()).check(tree({ ...clean, 'src/stray/x.ts': 'export const x = 1\n' }))
  assert.deepEqual(r.problems, ['src/stray/x.ts: in no layer (add its folder to scripts/layers.json)'])
})

test('the largest import cycle may not grow past the ceiling; a max-scc header lowers it', async () => {
  const { check } = await script()
  const two = {
    ...clean,
    'src/notes/a.ts': "import { t } from '../tour/t'\nexport const a = 1\n",
    'src/tour/t.ts': "import { a } from '../notes/a'\nexport const t = 1\n",
  }
  const r = check(tree(two))
  assert.equal(r.largest, 2)
  assert.deepEqual(r.problems, [])
  const lowered = check(tree({ ...two, 'scripts/layer-exceptions/tour.txt': '# max-scc: 1\n' }))
  assert.equal(lowered.ceiling, 1)
  assert.match(lowered.problems[0], /^the largest import cycle has 2 files, more than the ceiling 1: src\/notes\/a\.ts, src\/tour\/t\.ts$/)
  const three = { ...two, 'src/notes/a.ts': "import { u } from './u'\nexport const a = 1\n", 'src/notes/u.ts': "import { t } from '../tour/t'\nexport const u = 1\n" }
  assert.match(check(tree(three)).problems[0], /^the largest import cycle has 3 files/)
})

test('a cycle inside one folder has its own ceiling (maxSccIn)', async () => {
  const files = {
    ...clean,
    'src/notes/a.ts': "import { u } from './u'\nexport const a = 1\n",
    'src/notes/u.ts': "import { a } from './a'\nexport const u = 1\n",
  }
  const r = (await script()).check(tree(files, { ...RULES, maxSccIn: { notes: 1 } }))
  assert.deepEqual(r.problems, ['the largest import cycle inside src/notes has 2 files, more than the ceiling 1'])
})

test('cycles: Tarjan components, largest first, self-imports included, single files without one left out', async () => {
  const { cycles } = await script()
  const g = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['d']], ['e', ['a']]])
  assert.deepEqual(cycles(g), [['a', 'b', 'c'], ['d']])
})
