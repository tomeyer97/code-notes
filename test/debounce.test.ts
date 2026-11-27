import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Debouncer } from '../src/platform/debounce'
import { useWindow } from '../src/platform/run'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('debouncer: the last call per key wins; keys are independent', async () => {
  const ran: string[] = []
  const d = new Debouncer('test')
  d.later('a', 20, () => ran.push('a1'))
  d.later('b', 20, () => ran.push('b1'))
  d.later('a', 20, () => ran.push('a2'))
  assert.equal(d.waiting('a'), true)
  await sleep(40)
  assert.deepEqual(ran.sort(), ['a2', 'b1'])
  assert.equal(d.waiting('a'), false)
})

test('debouncer: cancel and dispose drop waiting calls', async () => {
  const ran: string[] = []
  const d = new Debouncer<number>('test')
  d.later(1, 10, () => ran.push('one'))
  d.later(2, 10, () => ran.push('two'))
  d.cancel(1)
  d.dispose()
  await sleep(25)
  assert.deepEqual(ran, [])
})

test('debouncer: a call that fails is logged with what it was for', async () => {
  const lines: string[] = []
  useWindow({ log: { error: (m: string) => { lines.push(m) }, warn: () => undefined, debug: () => undefined }, showErrorMessage: async () => undefined })
  const d = new Debouncer('notes: re-anchor')
  d.later('x', 1, async () => { throw new Error('gone') })
  await sleep(15)
  assert.deepEqual(lines, ['notes: re-anchor: gone'])
})
