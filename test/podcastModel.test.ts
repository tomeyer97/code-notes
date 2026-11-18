import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chapterJump, clock, isPodcastFile, LatestWins, parsePodcast, podcastFileOf, resolveEpisode, sameView, segmentAt, timeOf, viewAt } from '../src/podcast/model'

// The podcast's pure parts (src/podcast/model.ts): reading the file, where the journey is at a time, seeking.

const journey = { steps: [{ id: 'a', beats: 3 }, { id: 'b', beats: 0 }, { id: 'c', beats: 2 }] }
const seg = (id: string, at: unknown, start: number, end: number, extra: object = {}) => ({ id, at, start, end, text: id, speaker: 'host', ...extra })
const file = (segments: object[], more: object = {}) => JSON.stringify({ version: 1, title: 'T', journey: { id: 'j' }, audio: 'j.mp3', duration: 100, segments, ...more })
const episode = (segments: object[]) => {
  const p = parsePodcast(file(segments))
  assert.ok(typeof p !== 'string', String(p))
  return resolveEpisode(p, journey)
}
const sample = () => episode([
  seg('intro', null, 0, 9),
  seg('a1', { step: 'a', beat: 1 }, 10, 19),
  seg('a3', { step: 'a', beat: 3 }, 20, 29),
  seg('a3b', { step: 'a', beat: 3 }, 30, 39),
  seg('b', { step: 'b' }, 40, 49),
  seg('c2', { step: 'c', beat: 2 }, 50, 59),
  seg('outro', null, 60, 70),
])

test('podcast file: shape checked, the reason said', () => {
  assert.match(String(parsePodcast('{')), /not JSON/)
  assert.match(String(parsePodcast(JSON.stringify({ version: 2, audio: 'a', segments: [{}] }))), /version 2/)
  assert.match(String(parsePodcast(JSON.stringify({ version: 1, segments: [{}] }))), /audio/)
  assert.match(String(parsePodcast(JSON.stringify({ version: 1, audio: 'a.mp3', segments: [] }))), /segments/)
  const p = parsePodcast(file([seg('s', null, 0, 1)]))
  assert.ok(typeof p !== 'string')
  assert.equal(p.audio, 'j.mp3')
  assert.equal(p.journey.id, 'j')
})

test('podcast file: found next to its journey, never read as a journey', () => {
  assert.equal(podcastFileOf('/r/journeys/scripted-tests.json'), '/r/journeys/scripted-tests.podcast.json')
  assert.ok(isPodcastFile('scripted-tests.podcast.json'))
  assert.ok(!isPodcastFile('scripted-tests.json'))
})

test('segments: each one\'s view; chapters are runs on one step, the first from 0', () => {
  const ep = sample()
  assert.deepEqual(ep.warnings, [])
  assert.deepEqual(ep.segments.map((s) => [s.step, s.beat]), [[0, undefined], [1, 0], [1, 2], [1, 2], [2, undefined], [3, 1], [0, undefined]])
  assert.deepEqual(ep.chapters, [
    { start: 0, end: 10, step: 0 }, { start: 10, end: 40, step: 1 }, { start: 40, end: 50, step: 2 }, { start: 50, end: 60, step: 3 }, { start: 60, end: 100, step: 0 },
  ])
  assert.equal(ep.duration, 100)
})

test('segment at a time: the last started; before the first, the first; in a gap, the one before', () => {
  const s = [{ start: 1 }, { start: 5 }, { start: 9 }]
  assert.equal(segmentAt(s, 0), 0)
  assert.equal(segmentAt(s, 1), 0)
  assert.equal(segmentAt(s, 4.99), 0)
  assert.equal(segmentAt(s, 5), 1)
  assert.equal(segmentAt(s, 8), 1)
  assert.equal(segmentAt(s, 9), 2)
  assert.equal(segmentAt(s, 1e9), 2)
  assert.equal(segmentAt([], 3), -1)
})

test('view at a time: exactly the segment\'s, in either direction, from anywhere (no intermediate cues)', () => {
  const ep = sample()
  // Forwards and backwards across steps give the same answers: it depends on the time only.
  const at = (t: number) => { const v = viewAt(ep, t); return [v.step, v.beat] }
  for (const order of [[0, 15, 35, 45, 55, 65], [65, 55, 45, 35, 15, 0]]) {
    const want: Record<number, unknown[]> = { 0: [0, undefined], 15: [1, 0], 35: [1, 2], 45: [2, undefined], 55: [3, 1], 65: [0, undefined] }
    for (const t of order) assert.deepEqual(at(t), want[t], `t=${t}`)
  }
  assert.deepEqual(at(9.5), [0, undefined], 'the gap after the intro is still the intro')
  assert.deepEqual(at(-5), [0, undefined])
  assert.deepEqual(at(999), [0, undefined])
  assert.ok(sameView(viewAt(ep, 21), viewAt(ep, 31)), 'two segments on one beat: the same view')
  assert.ok(!sameView(viewAt(ep, 15), viewAt(ep, 21)))
})

test('a bad link degrades: missing beat → the step only; unknown step or bad "at" → the view before; cue map → no beat', () => {
  const ep = episode([
    seg('a9', { step: 'a', beat: 9 }, 0, 1),
    seg('b1', { step: 'b', beat: 1 }, 2, 3), // b has no animation
    seg('x', { step: 'nope', beat: 1 }, 4, 5),
    seg('c1', { step: 'c', beat: 1 }, 6, 7),
    seg('bad', 'step c', 8, 9),
    seg('none', undefined, 10, 11),
    seg('map', { step: 'c', beat: 2 }, 12, 13, { cue: 'map' }),
    seg('half', { step: 'a', beat: 1.5 }, 14, 15),
  ])
  assert.deepEqual(ep.segments.map((s) => [s.id, s.step, s.beat]), [
    ['a9', 1, undefined], ['b1', 2, undefined], ['x', 2, undefined], ['c1', 3, 0], ['bad', 3, 0], ['none', 3, 0], ['map', 3, undefined], ['half', 1, undefined],
  ])
  assert.equal(ep.warnings.length, 6, ep.warnings.join('\n'))
  assert.match(ep.warnings[0], /no beat 9 \(it has 3\); the step only/)
  assert.match(ep.warnings[2], /no step "nope"/)
})

test('segments out of order are sorted; one without a start is dropped; a missing end is the next start', () => {
  const ep = episode([seg('two', null, 10, 12), { id: 'nostart', at: null, text: '' }, { id: 'one', at: { step: 'a' }, start: 2, text: '' }])
  assert.deepEqual(ep.segments.map((s) => [s.id, s.start, s.end]), [['one', 2, 10], ['two', 10, 12]])
  assert.equal(ep.warnings.length, 1)
  assert.equal(ep.chapters[0].start, 0)
})

test('journey → audio: the first segment of a step or of a beat; nothing when the podcast skips it', () => {
  const ep = sample()
  assert.equal(timeOf(ep, 1), 10)
  assert.equal(timeOf(ep, 1, 2), 20)
  assert.equal(timeOf(ep, 1, 1), undefined, 'beat 2 of step a is never named')
  assert.equal(timeOf(ep, 2), 40)
  assert.equal(timeOf(ep, 9), undefined)
})

test('previous / next part: by chapter; previous restarts the chapter unless just past its start', () => {
  const ep = sample()
  assert.equal(chapterJump(ep, 15, 1), 40)
  assert.equal(chapterJump(ep, 35, -1), 10)
  assert.equal(chapterJump(ep, 11, -1), 0, 'within 3 s of the start: the chapter before')
  assert.equal(chapterJump(ep, 2, -1), 0)
  assert.equal(chapterJump(ep, 65, 1), 100, 'past the last: the end')
})

test('seeks coalesce: one move at a time, and only the newest one waiting runs next', async () => {
  const ran: number[] = []
  const stopped: number[] = []
  let release!: () => void
  const lw = new LatestWins<number>(async (v, current) => {
    ran.push(v)
    if (v === 1) await new Promise<void>((r) => { release = r })
    if (!current()) stopped.push(v)
  })
  lw.push(1)
  lw.push(2)
  lw.push(3)
  lw.push(4)
  assert.ok(lw.busy)
  release()
  await lw.idle()
  assert.deepEqual(ran, [1, 4], 'the drag\'s last position only')
  assert.deepEqual(stopped, [1], 'the first job learns it was superseded')
  lw.push(5)
  await lw.idle()
  assert.deepEqual(ran, [1, 4, 5])
})

test('clock', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(767.88), '12:47')
  assert.equal(clock(3725), '1:02:05')
})
