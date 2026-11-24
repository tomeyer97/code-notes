import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleAll, PanelController } from '../src/journeys/panel/controller'
import { staleSince } from '../src/journeys/panel/staleSteps'
import type { FromMap } from '../src/protocol/map'
import type { LoadedJourney } from '../src/journeys/steps'

const lj = { key: 'k' } as LoadedJourney

test('each message goes to the feature that registered it', () => {
  const got: string[] = []
  const c = new PanelController([
    { name: 'walk', handlers: { step: (_lj, m) => got.push(`step ${m.n}`), end: () => got.push('end') } },
    { name: 'list', handlers: { walk: (j, m) => got.push(`walk ${m.key} from ${j.key}`) } },
  ])
  c.onMessage(lj, { type: 'step', n: 3 })
  c.onMessage(lj, { type: 'walk', key: 'other' })
  c.onMessage(lj, { type: 'end' })
  // Nobody's: nothing happens.
  c.onMessage(lj, { type: 'hereAll' })
  assert.deepEqual(got, ['step 3', 'walk other from k', 'end'])
})

test('a message handled by two features is a wiring mistake', () => {
  const c = new PanelController([{ name: 'walk', handlers: { step: () => undefined } }])
  assert.throws(() => c.register({ name: 'check', handlers: { step: () => undefined } }), /'step' is handled by walk and check/)
})

test('a family of messages goes to one function', () => {
  const got: FromMap['type'][] = []
  const c = new PanelController([{ name: 'podcast', handlers: handleAll(['podcastWhy', 'podcastMeta'] as const, (_lj, m) => got.push(m.type)) }])
  c.onMessage(lj, { type: 'podcastMeta', duration: 3 })
  c.onMessage(lj, { type: 'podcastWhy' })
  assert.deepEqual(got, ['podcastMeta', 'podcastWhy'])
})

test('what the panel shows: every feature\'s part, in registration order', () => {
  const c = new PanelController([
    { name: 'walk', slice: (j) => ({ current: j.key === 'k' ? 2 : 0, marks: {} }) },
    { name: 'view', slice: () => ({ legendHidden: true, tutorial: false }) },
    { name: 'check', slice: () => ({}) },
    { name: 'later', slice: () => ({ current: 5 }) },
  ])
  assert.deepEqual(c.state(lj), { current: 5, marks: {}, legendHidden: true, tutorial: false })
})

test('stale steps: each file asked once, all at once, in step order', async () => {
  const asked: string[] = []
  let running = 0, most = 0
  const lastChange = async (f: string) => {
    asked.push(f)
    most = Math.max(most, ++running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return f === 'a.ts' ? 'uncommitted' : `abc · ${f}`
  }
  const out = await staleSince([{ n: 1, file: 'a.ts' }, { n: 3, file: 'b.ts' }, { n: 4, file: 'a.ts' }], lastChange)
  assert.deepEqual(out, [{ n: 1, when: 'uncommitted' }, { n: 3, when: 'abc · b.ts' }, { n: 4, when: 'uncommitted' }])
  assert.deepEqual(asked, ['a.ts', 'b.ts'])
  assert.equal(most, 2)
  assert.deepEqual(await staleSince([], lastChange), [])
})
