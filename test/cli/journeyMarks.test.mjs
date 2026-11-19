// The code-journey skill's marks (`journey.py mark`, `marks`, `check`): the same rules as the extension's
// src/marks/model.ts (the same messages for the same marks), and the commands on a small repository made here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JPY } from './helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const M = createRequire(import.meta.url)(path.join(root, 'out/src/marks/model.js'))
// No __pycache__ beside the skill's script (it ships as is).
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }

const DOC = ['// Placing an order', 'export async function place(cart, user) {', '  const total = sum(cart.items)',
  "  if (total <= 0) throw new Error('empty cart')", '  const stock = await reserve(cart, { hold: 30 })', '  return save(cart, stock, user.id)', '}']

test('journey.py marks: the same shape and code problems, word for word, as the extension', () => {
  const shapes = [{ lines: [3, 3] }, { lines: [5, 4] }, { lines: [0, 1] }, {}, { lines: [1, 1], file: ' ' }, { lines: [1, 1], match: '' }, { lines: [1, 1], nth: 0 }, { lines: [1, 1], nth: 1.5 }]
  const codes = [
    [{ lines: [4, 4], match: 'total <= 0' }, 'drop'], [{ lines: [4, 4], match: 'reserve(' }, 'drop'], [{ lines: [4, 5], match: 'total', nth: 3 }, 'drop'],
    [{ lines: [4, 5], match: 'total', nth: 3 }, 'lines'], [{ lines: [6, 9] }, 'drop'], [{ lines: [9, 9] }, 'drop'], [{ lines: [9, 10] }, 'drop'], [{ lines: [2, 3] }, 'drop'],
  ]
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('journey', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
c = json.load(sys.stdin)
shape = [(lambda p: p and p[0])(m.mark_shape_problem(x)) for x in c['shapes']]
code = [(lambda p: p and p[0])(m.mark_code_problem(c['doc'], 'o.js', x, how)) for x, how in c['codes']]
code.append(m.mark_code_problem(None, 'x.js', {'lines': [1, 1]}, 'drop')[0])
print(json.dumps({'shape': shape, 'code': code}))
`
  const got = JSON.parse(execFileSync('python3', ['-c', py, JPY], { input: JSON.stringify({ shapes, codes, doc: DOC }), encoding: 'utf8', env }))
  assert.deepEqual(got.shape, shapes.map((x) => M.markShapeProblem(x)?.what ?? null))
  assert.deepEqual(got.code, [...codes.map(([x, how]) => M.markCodeProblem(DOC, 'o.js', x, how)?.what ?? null), M.markCodeProblem(null, 'x.js', { lines: [1, 1] }, 'drop').what])
})

test('journey.py mark / marks / rmmark: written only where the match is, previewed under the characters, checked and fixed by check', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jmarks-'))
  fs.mkdirSync(path.join(d, 'src'))
  fs.writeFileSync(path.join(d, 'src/o.js'), DOC.join('\n') + '\n')
  const j = (...a) => spawnSync('python3', [JPY, ...a], { cwd: d, encoding: 'utf8', env, input: a[0] === 'step' ? 'If the total is not above zero it throws before reserving the stock.\n' : a[0] === 'new' ? 'How orders are placed.\n' : a[0] === 'node' ? 'f\n' : '' })
  const out = (r) => r.stdout + r.stderr
  j('new', d, 'orders', 'How is an order placed?', 'Placing an order')
  j('node', d, 'orders', 'f', 'function', 'place')
  j('step', d, 'orders', 'f', 'src/o.js', '3', '6', 'An empty cart is refused first')
  let r = j('mark', d, 'orders', '1', 'src/o.js', '4', 'total <= 0')
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /step 1 mark 1: src\/o\.js:4 "total <= 0"[\s\S]*L4: if \(total <= 0\)[^\n]*\n {10}\^{10}\n/)
  r = j('mark', d, 'orders', '1', 'src/o.js', '4', 'reserve(')
  assert.equal(r.status, 1)
  assert.match(out(r), /"reserve\(" isn't on src\/o\.js:4-4 \(it is 1 line down\): give the lines it is on/)
  assert.match(out(r = j('mark', d, 'orders', '1', 'src/o.js', '6', 'user.id')), /WARNING: step 1: mark 2: "user\.id": the step's text names none of it/)
  assert.match(out(j('mark', d, 'orders', '1.1', 'src/o.js', '5', 'hold')), /step 1 has 0 beats; there is no beat 1/)
  const file = path.join(d, 'journeys/orders.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).steps[0].marks, [{ lines: [4, 4], match: 'total <= 0' }, { lines: [6, 6], match: 'user.id' }])
  // Code inserted above: check warns, check fix moves the lines; a match gone is a problem.
  fs.writeFileSync(path.join(d, 'src/o.js'), ['// one', '// two', ...DOC].join('\n') + '\n')
  assert.match(out(j('check', d, 'orders', 'quiet', '--steps', '1-2')), /WARNING: step 1: mark 1: "total <= 0" isn't in line 4 of src\/o\.js; found 2 lines down, lit there \(run check fix\)/)
  assert.match(out(j('check', d, 'orders', 'fix', '--steps', '1-2')), /FIXED: step 1: mark 1: lines moved \+2 to 6-6/)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).steps[0].marks[0].lines, [6, 6])
  fs.writeFileSync(path.join(d, 'src/o.js'), ['// one', '// two', ...DOC].join('\n').replace('total <= 0', 'total < 1') + '\n')
  r = j('marks', d, 'orders')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /PROBLEM: step 1: mark 1: "total <= 0" isn't in line 6 of src\/o\.js, nor within 20 lines: nothing is lit/)
  assert.match(out(j('rmmark', d, 'orders', '1', 'all')), /removed 2 marks of step 1/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).steps[0].marks, undefined)
})
