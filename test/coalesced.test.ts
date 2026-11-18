import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Coalesced } from '../src/coalesced'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('coalesced: one run at a time; calls meanwhile share one more run, forced if any asked', async () => {
  const runs: boolean[] = []
  let release!: () => void
  const c = new Coalesced(async (force) => { runs.push(force); if (runs.length === 1) await new Promise<void>((r) => { release = r }) })
  const first = c.run(false)
  await sleep(5)
  const more = Array.from({ length: 10 }, (_, i) => c.run(i === 5))
  assert.equal(runs.length, 1, 'the others wait')
  release()
  await Promise.all([first, ...more])
  assert.deepEqual(runs, [false, true], 'one more run, forced')
  await c.run(false)
  assert.deepEqual(runs, [false, true, false], 'idle again: a call runs at once')
  // A run that fails doesn't stop the next one.
  const d = new Coalesced(async (f) => { if (f) throw new Error('x') })
  const p1 = d.run(true), p2 = d.run(false)
  await assert.rejects(p1)
  await p2
})

test('coalesced: busy while a run is going, idle after', async () => {
  let release!: () => void
  const c = new Coalesced(() => new Promise<void>((r) => { release = r }))
  assert.equal(c.busy, false)
  const p = c.run(false)
  await sleep(1)
  assert.equal(c.busy, true)
  release()
  await p
  assert.equal(c.busy, false)
})
