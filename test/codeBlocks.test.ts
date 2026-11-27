import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Sym, blockAt, blocksFromSymbols, blocksFromText, groupSteps } from '../src/core/codeBlocks'

// A worker like the one in the example shop: consts at the top, functions with destructuring and callbacks inside.
const worker = [
  "import pg from 'pg'",                               // 0
  "import net from 'node:net'",                        // 1
  '',                                                  // 2
  '// The database and the mail server.',             // 3
  'const pool = new pg.Pool({',                        // 4
  '  connectionString: process.env.DATABASE_URL,',     // 5
  '})',                                                // 6
  'const SMTP_HOST = process.env.SMTP_HOST',           // 7
  'const SMTP_PORT = Number(process.env.SMTP_PORT)',   // 8
  '',                                                  // 9
  '// Sends one mail.',                                // 10
  'async function sendMail(to, text) {',               // 11
  '  const { rows: [cfg] } = await pool.query(1)',     // 12
  '  return new Promise((ok) => {',                    // 13
  '    net.connect(SMTP_PORT, SMTP_HOST, ok)',         // 14
  '  })',                                              // 15
  '}',                                                 // 16
  '',                                                  // 17
  'async function cartOf(sid) {',                      // 18
  '  const { rows: [cart] } = await pool.query(sid)',  // 19
  '  return cart',                                     // 20
  '}',                                                 // 21
]
const syms: Sym[] = [
  { kind: 'var', start: 4, end: 6, children: [{ kind: 'other', start: 5, end: 5, children: [] }] },
  { kind: 'var', start: 7, end: 7, children: [] }, { kind: 'var', start: 8, end: 8, children: [] },
  { kind: 'fn', start: 11, end: 16, children: [{ kind: 'var', start: 12, end: 12, children: [{ kind: 'var', start: 12, end: 12, children: [] }] }, { kind: 'fn', start: 13, end: 15, children: [] }] },
  { kind: 'fn', start: 18, end: 21, children: [{ kind: 'var', start: 19, end: 19, children: [{ kind: 'var', start: 19, end: 19, children: [] }] }] },
]

test('blocks from symbols: functions (not what is nested in them), multi-line top-level consts', () => {
  assert.deepEqual(blocksFromSymbols(syms).map((b) => [b.start, b.end, b.kind]), [[4, 6, 'var'], [11, 16, 'fn'], [18, 21, 'fn']])
})

test('blocks from text match the symbols for a plain file', () => {
  assert.deepEqual(blocksFromText(worker).map((b) => [b.start, b.end, b.kind]), [[4, 6, 'var'], [11, 16, 'fn'], [18, 21, 'fn']])
  assert.deepEqual(blocksFromText(['def a():', '    return 1', '', 'x = 2', 'class B:', '    def c(self):', '        pass']).map((b) => [b.start, b.end]), [[0, 1], [4, 6]])
})

test('one lens per function: steps inside it, a destructuring or a callback, and a step on its comment; the top consts share one', () => {
  for (const blocks of [blocksFromSymbols(syms), blocksFromText(worker)]) {
    const hits = [5, 7, 8, 10, 12, 14, 18, 19].map((line) => ({ line, end: line === 10 ? 12 : line }))
    const g = groupSteps(hits, blocks)
    assert.deepEqual(g.map((x) => [x.line, x.steps.map((s) => s.line)]), [[4, [5, 7, 8]], [11, [10, 12, 14]], [18, [18, 19]]])
  }
})

test('the function around the cursor: the same for every line of it', () => {
  const b = blocksFromSymbols(syms)
  assert.deepEqual([11, 13, 14, 16].map((l) => blockAt(l, b)?.start), [11, 11, 11, 11])
  assert.equal(blockAt(9, b), undefined)
})
