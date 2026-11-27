// The code-journey skill's marks (`journey.py mark`, `marks`, `check`): with node, the extension's own rules
// (src/core/format/marks.ts, through journey-check.mjs); without, journey.py's copy of them, word for word the same.
// Then the commands on a small repository made here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { JPY } from './helpers.mjs'
import { both } from './journeyRules.mjs'

// No __pycache__ beside the skill's script (it ships as is).
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }

const DOC = ['// Placing an order', 'export async function place(cart, user) {', '  const total = sum(cart.items)',
  "  if (total <= 0) throw new Error('empty cart')", '  const stock = await reserve(cart, { hold: 30 })', '  return save(cart, stock, user.id)', '}']

/** Marks with something wrong in their fields: nothing else is looked at. */
const SHAPES = [
  { lines: [5, 4] }, { lines: [0, 1] }, {}, { lines: [1, 1], file: ' ' }, { lines: [1, 1], match: '' },
  { lines: [1, 1], nth: 0 }, { lines: [1, 1], nth: 1.5 }, 'mark',
]
/** Marks against DOC (o.js), and what a match not found lights: in place, moved, not found, past the end. */
const IN_CODE = [
  [{ lines: [3, 3] }, 'drop'],
  [{ lines: [4, 4], match: 'total <= 0' }, 'drop'],
  [{ lines: [4, 4], match: 'reserve(' }, 'drop'],
  [{ lines: [4, 5], match: 'total', nth: 3 }, 'drop'],
  [{ lines: [4, 5], match: 'total', nth: 3 }, 'lines'],
  [{ lines: [6, 9] }, 'drop'],
  [{ lines: [9, 9] }, 'drop'],
  [{ lines: [9, 10] }, 'drop'],
  [{ lines: [2, 3] }, 'drop'],
  [{ lines: [3, 4], match: 'sum(cart.items)\n  if' }, 'drop'],
]

test('journey.py marks: the same shape and code problems, and the same characters lit, with node and without', () => {
  const requests = [
    ...SHAPES.map((mark) => ({ op: 'mark', mark, file: 'o.js', doc: DOC })),
    ...IN_CODE.map(([mark, onMissing]) => ({ op: 'mark', mark, file: 'o.js', doc: DOC, onMissing })),
    { op: 'mark', mark: { lines: [1, 1] }, file: 'x.js', doc: null },
  ]
  const { node, python } = both(requests)
  assert.deepEqual(python, node)
  assert.deepEqual(node.slice(0, SHAPES.length).map((m) => m.shape), [
    'lines must be [first, last] (1-based, first <= last), got [5,4]', 'lines must be [first, last] (1-based, first <= last), got [0,1]',
    'lines must be [first, last] (1-based, first <= last), got undefined', 'file is not a path', 'match is not a text',
    'nth must be 1 or more, got 0', 'nth must be 1 or more, got 1.5', 'not an object { lines, match? }',
  ])
  assert.deepEqual(node.slice(SHAPES.length).map((m) => m.code), [
    null, null,
    ['"reserve(" isn\'t in line 4 of o.js; found 1 line down, lit there', 1],
    ['"total" (occurrence 3) isn\'t in lines 4–5 of o.js, nor within 20 lines: nothing is lit', null],
    ['"total" (occurrence 3) isn\'t in lines 4–5 of o.js, nor within 20 lines: the whole lines light', null],
    ['lines 6–9 of o.js go past its end (7 lines)', null],
    ['line 9 of o.js is past its end (7 lines); nothing is lit', null],
    ['lines 9–10 of o.js are past its end (7 lines); nothing is lit', null],
    null, null,
    ["x.js isn't in the repository; nothing is lit", null],
  ])
  assert.deepEqual(node.slice(SHAPES.length, SHAPES.length + 3).map((m) => m.spot), [[2, 2, 2, 31], [3, 6, 3, 16], [4, 22, 4, 30]])
  assert.deepEqual(node.at(-2).spot, [2, 16, 3, 4], 'a match across two lines')
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
