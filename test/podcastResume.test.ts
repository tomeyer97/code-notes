import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIME_SLACK_S } from '../src/core/format/podcast/guards'
import { resolveEpisode } from '../src/core/format/podcast/resolve'
import { validatePodcast } from '../src/core/format/podcast/validate'
import { afterStep, remapTime, resumeTime } from '../src/podcast/resume'

// Where a podcast goes on from (src/podcast/resume.ts): after a step it skips, when played again, after its file was
// rewritten.

const journey = { steps: [{ id: 'a', beats: 3 }, { id: 'b', beats: 0 }, { id: 'c', beats: 2 }, { id: 'd', beats: 0 }] }
const seg = (id: string, at: unknown, start: number, end: number) => ({ id, at, start, end, text: id, speaker: 'host' })
const episode = (segments: object[]) => {
  const v = validatePodcast(JSON.stringify({ version: 1, title: 'T', journey: { id: 'j' }, audio: 'j.mp3', duration: 100, segments }))
  assert.ok(v.podcast, v.problems.map((p) => p.message).join('\n'))
  return resolveEpisode(v.podcast, journey)
}
// Steps 1 and 3 are covered; 2 and 4 are not.
const sample = () => episode([
  seg('intro', null, 0, 9),
  seg('a1', { step: 'a', beat: 1 }, 10, 19),
  seg('a3', { step: 'a', beat: 3 }, 20, 29),
  seg('map', null, 30, 39),
  seg('c', { step: 'c' }, 40, 49),
  seg('outro', null, 60, 70),
])

test('a step the podcast skips: ▶ goes on with the next covered step, else what follows the last covered one', () => {
  const ep = sample()
  assert.equal(afterStep(ep, 2), 40, 'step 2 skipped: step 3, not back to step 1 nor the map between')
  assert.equal(afterStep(ep, 4), 60, 'step 4 (nothing covered after it): the outro after step 3')
  const noOutro = episode([seg('a1', { step: 'a' }, 0, 9), seg('c', { step: 'c' }, 10, 19)])
  assert.equal(afterStep(noOutro, 4), undefined, 'nothing after it: ▶ plays from where it is')
})

test('played again: where it was left, unless the walk is on another step', () => {
  const ep = sample()
  assert.equal(resumeTime(ep, 24, 0), 24, 'no walk: where it was')
  assert.equal(resumeTime(ep, 24, 1), 24, 'the walk on the step that time is about: where it was')
  assert.equal(resumeTime(ep, 24, 3), 40, 'the walk on step 3: its first part')
  assert.equal(resumeTime(ep, 24, 2), 40, 'the walk on a skipped step: the part after it')
  assert.equal(resumeTime(ep, 500, 0), 100, 'kept inside the episode')
})

test('the file rewritten: the same moment, by segment id when the times moved', () => {
  const was = sample()
  assert.equal(remapTime(was, sample(), 23.5), 23.5, 'same times: same time')
  const moved = episode([
    seg('intro', null, 0, 4),
    seg('a1', { step: 'a', beat: 1 }, 5, 14),
    seg('a3', { step: 'a', beat: 3 }, 15, 24),
    seg('map', null, 25, 39),
    seg('c', { step: 'c' }, 40, 49),
    seg('outro', null, 60, 70),
  ])
  assert.equal(remapTime(was, moved, 23.5), 18.5, 'a3 starts 5 s earlier: 3.5 s into a3 again')
  assert.equal(remapTime(was, moved, 42), 42, 'c did not move')
  const shorter = episode([seg('intro', null, 0, 4), seg('a3', { step: 'a', beat: 3 }, 5, 7)])
  assert.ok(remapTime(was, shorter, 28) < 7, 'kept inside its segment when it got shorter')
  assert.equal(remapTime(was, shorter, 28), 7 - TIME_SLACK_S, 'just before its end: still that segment')
  const gone = episode([seg('intro', null, 0, 4), seg('x', { step: 'c' }, 5, 50)])
  assert.equal(remapTime(was, gone, 23.5), 23.5, 'its segment gone: the same time')
})
