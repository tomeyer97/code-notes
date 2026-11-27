// The composition root's own parts that need no VS Code: a feature's ports (read before its activate: an error that
// says which), the D / A ladder the features register into, and the tour's position moves and test probe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChordSteppers } from '../src/chords'
import { portsSlot } from '../src/platform/ports'
import { TourProbe, TourState } from '../src/tour/state'
import { isUpdateRequest, questionBesidesTitle, UPDATE_ASK } from '../src/tour/texts'
import type { LoadedJourney } from '../src/journeys/steps'
import type { Note } from '../src/notes/store'

test('portsSlot: read before its activate, it throws and names the feature; then the value', () => {
  const slot = portsSlot<{ n: number }>('the tour')
  assert.equal(slot.ready, false)
  assert.throws(() => slot.get(), /the tour used before it was activated/)
  slot.set({ n: 1 })
  assert.equal(slot.ready, true)
  assert.deepEqual(slot.get(), { n: 1 })
})

test('ChordSteppers: D / A go to the first stepper that takes them, by priority, whatever the order registered', async () => {
  const prefixes: unknown[] = []
  const keys = new ChordSteppers((a) => prefixes.push(a))
  const took: string[] = []
  const walking = { on: false }
  keys.register(40, { step: (d) => { took.push(`unread ${d}`); return Promise.resolve('unread') } })
  keys.register(20, { step: (d) => walking.on && (took.push(`walk ${d}`), true) })
  const podcast = keys.register(10, { step: () => false })
  assert.equal(await keys.step(1, { prefix: '<' }), 'unread', 'its step is returned: the command waits for it')
  walking.on = true
  keys.step(-1)
  assert.deepEqual(took, ['unread 1', 'walk -1'])
  assert.deepEqual(prefixes, [{ prefix: '<' }, undefined], 'every press says which prefix it came with')
  podcast.dispose()
  keys.register(10, { step: () => true })
  keys.step(1)
  assert.deepEqual(took, ['unread 1', 'walk -1'], 'a stepper registered first in priority takes the key')
})

test('TourState: browsing a map or stopping the walk leaves no step (nor its id) behind; isAt', () => {
  const s = new TourState()
  s.key = 'a'
  s.step = 3
  s.stepId = 's3'
  assert.equal(s.isAt({ key: 'a' }, 3), true)
  s.browse('b')
  assert.deepEqual([s.key, s.step, s.stepId], ['b', 0, undefined])
  s.step = 2
  s.stepId = 's2'
  s.doc = { uri: {} as never, column: 2 }
  s.stop()
  assert.deepEqual([s.key, s.step, s.stepId, s.doc], ['b', 0, undefined, undefined], 'the journey stays, its map may')
  assert.deepEqual(s.snapshot(), { step: 0, cp: undefined, fileGone: false, ref: undefined, codeColumn: undefined })
})

test('TourProbe: what only the tests read is not on the tour state', () => {
  const probe = new TourProbe()
  assert.deepEqual([probe.lastPeek, probe.lastLeft, probe.marked], [undefined, undefined, []])
  const state = new TourState() as unknown as Record<string, unknown>
  for (const k of ['lastPeek', 'lastLeft', 'marked']) assert.equal(k in state, false, k)
})

test('tour texts: an update request starts with the update ask; a question the title already says is not repeated', () => {
  const note = (body: string) => ({ data: { messages: [{ body }] } }) as unknown as Note
  assert.equal(isUpdateRequest(note(`${UPDATE_ASK} It moved to b.ts.`)), true)
  assert.equal(isUpdateRequest(note('How does this work?')), false)
  const lj = (title: string, question: string) => ({ j: { title, question } }) as unknown as LoadedJourney
  assert.equal(questionBesidesTitle(lj('Place an order', 'How do we place an order?')), '')
  assert.equal(questionBesidesTitle(lj('Orders', 'What happens on checkout?')), 'What happens on checkout?')
})
