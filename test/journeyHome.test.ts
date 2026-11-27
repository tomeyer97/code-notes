import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'
import { SORTS as LIST_SORTS } from '../src/core/list/journeyList'

interface HomeText {
  SORTS: [string, string][]
  staleTip(r: { stale: number; staleSteps?: number[] }): string
  walkLabel(r: { walking?: boolean; resume: number }): string
  podcastBadge(p: { duration: number; playing: boolean; at?: number }): { text: string; tip: string }
  escapeRegExp(s: string): string
}

// What the Journeys home says (media/home/text.js), bundled as the page bundles it.
const H = pageModule<HomeText>('media/home/text.js')

test('the sort menu offers the extension\'s sorts (same ids and labels) and best match first', () => {
  assert.deepEqual(H.SORTS, [['best', 'Best match'], ...LIST_SORTS.map((s) => [s.id, s.label])])
})

test('a stale row says which steps changed', () => {
  assert.equal(H.staleTip({ stale: 1, staleSteps: [4] }), 'Step 4 changed since it was written')
  assert.equal(H.staleTip({ stale: 2, staleSteps: [2, 5] }), 'Steps 2, 5 changed since it was written')
  assert.equal(H.staleTip({ stale: 3 }), '3 steps changed since it was written')
  assert.equal(H.staleTip({ stale: 1 }), '1 step changed since it was written')
})

test('the preview\'s Walk button says where the walk goes', () => {
  assert.equal(H.walkLabel({ walking: true, resume: 3 }), 'Back to step 3')
  assert.equal(H.walkLabel({ resume: 4 }), 'Resume at 4')
  assert.equal(H.walkLabel({ resume: 1 }), 'Walk')
})

test('a row\'s podcast mark: its length, listening, or paused where', () => {
  assert.deepEqual(H.podcastBadge({ duration: 125, playing: true }), { text: '♪ Listening', tip: 'Listening to its podcast' })
  assert.deepEqual(H.podcastBadge({ duration: 125, playing: false, at: 61.7 }), { text: '♪ 1:01', tip: 'Podcast paused at 1:01 of 2:05' })
  assert.deepEqual(H.podcastBadge({ duration: 65, playing: false }), { text: '♪ 1:05', tip: 'Podcast, 1:05: ▶ Listen on its row in the Journeys view' })
})

test('a search word with RegExp characters matches itself', () => {
  const words = ['a.b', 'c++', '(x)', '[y]', 'z\\w', '$1^?|*{}']
  for (const w of words) assert.ok(new RegExp(H.escapeRegExp(w)).test(`--${w}--`), w)
  assert.ok(!new RegExp(H.escapeRegExp('a.b')).test('axb'))
})
