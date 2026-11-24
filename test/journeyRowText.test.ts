import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildList } from '../src/core/list/journeyList'
import { journeyDescription, journeyLabel, JourneyRowState, journeyTooltip, nestsQuestions, podcastContext } from '../src/sidebar/journeyRowText'
import { NAMED, NOW, STORE, items } from './fixtures/journeyList'

// A journey's row in the Journeys view: its texts made from one state (src/sidebar/journeyRowText.ts).

const model = buildList(items(), { activeFile: STORE, now: NOW })
const plain: JourneyRowState = {
  active: false, left: 0, steps: 5, newReplies: 0, refreshing: false, stale: false, unreadable: false, isNew: false,
  row: model.rows[NAMED.newest],
}
const tip = { question: 'How do orders work?', summary: 'The path.', provenance: '', staleLine: '' }

test('a plain row: its area and age; under its area only the age', () => {
  assert.equal(journeyDescription(plain, 'all'), 'api · 3 d')
  assert.equal(journeyDescription(plain, 'area:api'), '3 d')
  assert.equal(journeyLabel('How orders work', plain), 'How orders work')
  assert.equal(journeyTooltip(plain, tip), 'How do orders work?\nThe path.')
})

test('walking and left: the description and the label say the same step, each in its own words', () => {
  const walking = { ...plain, active: true, left: 3 }
  assert.equal(journeyDescription(walking, 'continue'), 'step 3/5')
  assert.equal(journeyLabel('T', walking), 'T, walking, step 3 of 5')
  const left = { ...plain, left: 2 }
  assert.equal(journeyDescription(left, 'all'), 'step 2/5')
  assert.equal(journeyLabel('T', left), 'T, left at step 2 of 5')
})

test('refreshing before stale; replies, unreadable and new after', () => {
  const s = { ...plain, refreshing: true, stale: true, newReplies: 2, unreadable: true, isNew: true }
  assert.equal(journeyDescription(s, 'all'), 'api · 3 d · Refreshing… · 2 replies · ⚠ unreadable · new')
  assert.equal(journeyDescription({ ...s, refreshing: false }, 'all'), 'api · 3 d · ⚠ Stale · 2 replies · ⚠ unreadable · new')
  assert.equal(journeyLabel('T', s), 'T, 2 unread replies, new')
  assert.equal(journeyTooltip({ ...plain, newReplies: 1 }, tip), 'How do orders work?\nThe path.\n1 unread reply from Claude')
})

test('in "In this file": how much of it is here', () => {
  const here = { ...plain, row: model.rows[NAMED.twoInStore[0]] }
  assert.equal(journeyDescription(here, 'here'), '2 of 7 steps here')
})

test('a podcast: its length on the row and in the label; one that cannot play says why, and offers no ▶', () => {
  const ok = { ...plain, pod: { state: 'ok' as const, duration: 125 } }
  assert.match(journeyDescription(ok, 'all')!, /^♪ 2:05 · api · 3 d$/)
  assert.equal(journeyLabel('T', ok), 'T, podcast 2:05')
  assert.equal(journeyDescription({ ...ok, left: 2, pod: { ...ok.pod, session: true } }, 'all'), '♪ 2:05', 'listened to: no step')
  assert.equal(podcastContext(ok.pod), ';podcast')
  assert.equal(podcastContext({ ...ok.pod, playing: true }), ';podcastPlaying')
  const broken = { ...plain, pod: { state: 'broken' as const, text: 'no audio' } }
  assert.equal(podcastContext(broken.pod), ';podcastBroken')
  assert.equal(journeyTooltip(broken, tip), 'How do orders work?\nThe path.\nPodcast unavailable: no audio')
  assert.equal(podcastContext(undefined), '')
})

test('questions nest under All, its areas and a row of no group only', () => {
  assert.deepEqual([undefined, 'all', 'area:api', 'here', 'continue'].map(nestsQuestions), [true, true, true, false, false])
})
