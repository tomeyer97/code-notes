// How big a check is (cli/understanding/size.ts): questions and tour steps by the change's kind and size.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cliModule } from './helpers/source.mjs'
import { repo } from './helpers/repos.mjs'

const { changeKind, checkKind, evidenceText, questionsFor, questionsForChange, removedNames, tourSize } = await cliModule('size')
const { loadConfig } = await cliModule('checkFile')

test('questions: by code lines, bounded by the config', () => {
  assert.deepEqual([1, 10, 19, 20, 59, 60, 149, 150, 299, 300, 2000].map((n) => questionsFor(n)), [1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
  assert.equal(questionsFor(5, { questions: { min: 3, max: 5 } }), 3)
  assert.equal(questionsFor(500, { questions: { min: 1, max: 3 } }), 3)
})

test('questions: "questions": 2 in the config is exactly 2', () => {
  const d = repo()
  fs.mkdirSync(path.join(d, 'understanding'), { recursive: true })
  fs.writeFileSync(path.join(d, 'understanding/config.json'), '{ "questions": 2, "exempt": ["docs/**"] }')
  const cfg = loadConfig(d)
  assert.deepEqual([cfg.questions, cfg.exempt, cfg.minChangedLines], [{ min: 2, max: 2 }, ['docs/**'], undefined])
  assert.equal(questionsFor(1000, cfg), 2)
})

test('questions: 1 for docs and a removal whatever their size; else by code lines', () => {
  const changes = [{ docsOnly: true, added: 300, removed: 0 }, { added: 0, removed: 500 }, { added: 3, removed: 2 }, { added: 30, removed: 0 }, { added: 200, removed: 10 }]
  assert.deepEqual(changes.map((st) => questionsForChange(st)), [1, 1, 1, 2, 4])
  assert.deepEqual([{ docsOnly: true, added: 1, removed: 1 }, { added: 0, removed: 4 }, { added: 4, removed: 0 }, { added: 0, removed: 0 }].map(changeKind), ['docs', 'removal', 'code', 'code'])
})

test('tours: 2-3 steps for docs, a removal or under 10 code lines; then 2-4, 4-7, 6-10', () => {
  const sizes = [['docs', 400], ['removal', 400], ['code', 9], ['code', 10], ['code', 19], ['code', 20], ['code', 59], ['code', 60]]
  assert.deepEqual(sizes.map(([k, n]) => tourSize(k, n)), [[2, 3], [2, 3], [2, 3], [2, 4], [2, 4], [4, 7], [4, 7], [6, 10]])
  assert.equal(checkKind({ questions: [{ docs: true }], diffStat: { added: 40, removed: 0 } }), 'docs')
  assert.equal(checkKind({ questions: [{ evidence: true }], diffStat: { added: 0, removed: 40 } }), 'removal')
})

test('a removal: the names a search starts from (definitions, keys; never keywords), and its hits', () => {
  assert.deepEqual(removedNames([
    { sign: '-', text: 'export async function refundReport(orderId) {' }, { sign: '-', text: 'if (x) {' }, { sign: '+', text: 'const kept = 1' },
    { sign: '-', text: 'SAVE15: 15,' }, { sign: '-', text: 'def total(rows):' }, { sign: '-', text: 'class Ledger {' }, { sign: '-', text: 'case X:' },
  ]), ['refundReport', 'SAVE15', 'total', 'Ledger'])
  assert.equal(evidenceText({ name: 'a', hits: [] }), 'a: 0 hits')
  assert.equal(evidenceText({ name: 'b', hits: [1, 2, 3, 4].map((line) => ({ file: 'x.js', line })) }), 'b: 4 hits (x.js:1, x.js:2, x.js:3, +1 more)')
})
