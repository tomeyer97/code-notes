import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calmViews, findMark, MARK_LEAD_S, markTimes, marksAt, planMarks, chapterJump, clock, isPodcastFile, LatestWins, parsePodcast, podcastFileOf, resolveEpisode, sameView, segmentAt, timeOf, VIEW_HOLD_S, viewAt } from '../src/podcast/model'

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

test('sentences: kept when usable, else left out (the player estimates them from the text)', () => {
  const good = [{ start: 10, text: 'One.' }, { start: 12.5, text: 'Two.', extra: 1 }]
  const ep = episode([
    seg('ok', null, 10, 19, { sentences: good }),
    seg('late', null, 20, 29, { sentences: [{ start: 20, text: 'One.' }, { start: 31, text: 'Two.' }] }),
    seg('order', null, 30, 39, { sentences: [{ start: 33, text: 'One.' }, { start: 31, text: 'Two.' }] }),
    seg('shape', null, 40, 49, { sentences: [{ start: 40 }] }),
    seg('none', null, 50, 59),
    // No end: the episode's duration (100) is its end.
    { id: 'last', at: null, start: 60, text: 'x', sentences: [{ start: 60, text: 'One.' }, { start: 200, text: 'Two.' }] },
  ])
  assert.deepEqual(ep.segments[0].sentences, [{ start: 10, text: 'One.' }, { start: 12.5, text: 'Two.' }])
  for (const k of [1, 2, 3, 4, 5]) assert.equal(ep.segments[k].sentences, undefined, ep.segments[k].id)
  assert.deepEqual(ep.warnings, [])
  // No end, no next segment, no duration: no limit after its start.
  const p = parsePodcast(file([{ id: 'only', at: null, start: 0, text: 'x', sentences: [{ start: 0, text: 'One.' }, { start: 200, text: 'Two.' }] }], { duration: undefined }))
  assert.ok(typeof p !== 'string')
  assert.equal(resolveEpisode(p, journey).segments[0].sentences?.length, 2)
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
  assert.equal(ep.warnings[0], 'Step 1: no beat 9 (it has 3); showing the whole step')
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

test('previous / next part: by chapter; previous is always the part before (as the step card\'s ‹ Previous)', () => {
  const ep = sample()
  assert.equal(chapterJump(ep, 15, 1), 40)
  assert.equal(chapterJump(ep, 45, -1), 10, 'always the part before, however far into this one (F73)')
  assert.equal(chapterJump(ep, 35, -1), 0)
  assert.equal(chapterJump(ep, 11, -1), 0, 'the chapter before')
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

test('a calmer editor: a view is held at least VIEW_HOLD_S while playing; a short part in another file only stays in the view before', () => {
  assert.equal(VIEW_HOLD_S, 8, 'the hold (s): the episode generator merges brief beats by the same rule')
  // Step a's beats 1 and 3 are in a.ts, beat 2 in other.ts; step b in b.ts; step c in c.ts.
  const files: Record<string, string> = { '1:0': 'a.ts', '1:1': 'other.ts', '1:2': 'a.ts', '1:': 'a.ts', '2:': 'b.ts', '3:': 'c.ts', '3:1': 'c.ts' }
  const fileOf = (v: { step: number; beat?: number }) => (v.step ? files[`${v.step}:${v.beat ?? ''}`] ?? '' : '')
  const ep = episode([
    seg('intro', null, 0, 9),
    seg('a1', { step: 'a', beat: 1 }, 10, 19),
    seg('a2', { step: 'a', beat: 2 }, 20, 23), // 3 s in other.ts: held in a.ts
    seg('a3', { step: 'a', beat: 3 }, 23, 26), // a.ts again, beat 3 moves the highlight
    seg('b', { step: 'b' }, 26, 30), // 4 s in b.ts, then c.ts: held (step a stays)
    seg('c2', { step: 'c', beat: 2 }, 30, 31), // c.ts 1 s ...
    seg('c', { step: 'c' }, 31, 45), // ... and on in c.ts: the run lasts 15 s, shown
    seg('outro', null, 45, 100),
  ])
  const v = calmViews(ep, fileOf)
  assert.deepEqual(v, [{ step: 0 }, { step: 1, beat: 0 }, { step: 1, beat: 0 }, { step: 1, beat: 2 }, { step: 1, beat: 2 }, { step: 3, beat: 1 }, { step: 3 }, { step: 0 }])
  // A seek still lands exactly: viewAt is not held.
  assert.deepEqual(viewAt(ep, 21), { seg: 2, step: 1, beat: 1 })
  // Every segment long enough: every view as written.
  const long = calmViews(sample(), () => 'f', 0)
  assert.deepEqual(long.map((x) => x.step), sample().segments.map((s) => s.step))
})

// ---------- marks (docs/podcast-format.md, "Marks") ----------

const markEp = (marks: unknown, at: unknown = { step: 'a', beat: 1 }) => resolveEpisode({
  version: 1, title: 'T', journey: { id: 'j' }, audio: 'a.mp3', duration: 40,
  segments: [{ id: 's1', at, text: 'If it requires a model and strict is set, it is rejected right there.', start: 10, end: 20, marks }, { id: 's2', at: null, text: 'x', start: 20, end: 40 }],
}, { steps: [{ id: 'a', beats: 2 }] })

test('marks: parsed in the order they light; bad ones left out; the next segment has none', () => {
  const ep = markEp([
    { phrase: 'right there', at: 5, lines: [5, 6] },
    { phrase: 'requires a model', at: 1.5, lines: [3, 3], match: 'NeedsModel(steps)' },
    { phrase: 'strict', at: 3, lines: [3, 3], match: 'g == nil', nth: 2, file: 'b.go' },
    { phrase: 'nope', at: 30, lines: [1, 1] },
    { phrase: 'bad lines', at: 1, lines: [4, 2] },
    { at: 1, lines: [1, 1] },
  ])
  const ms = ep.segments[0].marks!
  assert.deepEqual(ms.map((m) => m.phrase), ['requires a model', 'strict', 'right there'])
  assert.deepEqual(ms[1], { phrase: 'strict', at: 3, lines: [3, 3], file: 'b.go', match: 'g == nil', nth: 2 })
  assert.equal(ep.segments[1].marks, undefined)
  assert.equal(markEp('x').segments[0].marks, undefined, 'not a list: none')
  // On the map (at: null) a mark needs its own file.
  assert.deepEqual(markEp([{ phrase: 'model', at: 1, lines: [1, 1] }, { phrase: 'strict', at: 2, lines: [1, 1], file: 'a.go' }], null).segments[0].marks!.map((m) => m.phrase), ['strict'])
})

test('marks: each lights 0.12 s before its time, never before the segment; the same phrase twice lights together', () => {
  assert.equal(MARK_LEAD_S, 0.12)
  const seg = { start: 10, marks: [
    { phrase: 'a', at: 0.05, lines: [1, 1] as [number, number] },
    { phrase: 'requires a model', at: 2, lines: [1, 1] as [number, number] },
    { phrase: 'right there', at: 4, lines: [1, 1] as [number, number] },
    { phrase: 'right there', at: 4.6, lines: [2, 2] as [number, number] },
  ] }
  const times = markTimes(seg)
  assert.deepEqual(times.map((t) => Math.round(t * 1000) / 1000), [10, 11.88, 13.88, 13.88])
  assert.deepEqual(marksAt(times, 9.9), { lit: 0, focusFrom: 0 })
  assert.deepEqual(marksAt(times, 10), { lit: 1, focusFrom: 0 })
  assert.deepEqual(marksAt(times, 11.87), { lit: 1, focusFrom: 0 })
  assert.deepEqual(marksAt(times, 11.88), { lit: 2, focusFrom: 1 }, 'the newest is the focus, the one before dims')
  assert.deepEqual(marksAt(times, 14), { lit: 4, focusFrom: 2 }, 'two places at once: both the focus')
  assert.deepEqual(marksAt(times, 12), { lit: 2, focusFrom: 1 }, 'back again: exactly the ones lit by then')
})

test('marks: a mark in another file opens it only after the view hold, else it is skipped', () => {
  const m = (file?: string) => ({ phrase: 'x', at: 0, lines: [1, 1] as [number, number], ...(file ? { file } : {}) })
  // On screen since 0: a mark in b.go at 3 s is too soon; at 9 s it opens b.go; back to a.go at 12 s is too soon.
  assert.deepEqual(planMarks([m(), m('b.go'), m('b.go'), m('b.go'), m('a.go')], [1, 3, 9, 10, 12], 'a.go', 'a.go', 0, 8), [
    { file: 'a.go', skip: false, opens: false },
    { file: 'b.go', skip: true, opens: false },
    { file: 'b.go', skip: false, opens: true },
    { file: 'b.go', skip: false, opens: false },
    { file: 'a.go', skip: true, opens: false },
  ])
  assert.equal(VIEW_HOLD_S, 8)
})

test('marks: found by match within the lines (its nth), re-found within 20 lines when the code moved, else the whole lines', () => {
  const doc = ['package a', '', '\tif n := NeedsModel(steps); g == nil && n > 0 {', '\t\treturn reject(400)', '\t}', '\treturn reject(400)']
  assert.deepEqual(findMark(doc, { lines: [3, 3], match: 'NeedsModel(steps)' }), { spot: { line: 2, col: 9, endLine: 2, endCol: 26 }, moved: 0, found: true })
  // nth counts within the lines; a match may span them.
  assert.deepEqual(findMark(doc, { lines: [4, 6], match: 'reject(400)', nth: 2 })!.spot, { line: 5, col: 8, endLine: 5, endCol: 19 })
  assert.deepEqual(findMark(doc, { lines: [4, 5], match: '400)\n\t}' })!.spot, { line: 3, col: 16, endLine: 4, endCol: 2 })
  // The code moved down 3 lines: the nearest shift that has it.
  const moved = ['//', '//', '//', ...doc]
  assert.deepEqual(findMark(moved, { lines: [3, 3], match: 'g == nil' }), { spot: { line: 5, col: 28, endLine: 5, endCol: 36 }, moved: 3, found: true })
  // Up before down at the same distance; nearer first.
  const both = ['x', 'hit', 'y', 'hit']
  assert.equal(findMark(both, { lines: [3, 3], match: 'hit' })!.moved, -1)
  assert.equal(findMark(Array.from({ length: 30 }, (_, i) => (i === 25 ? 'far' : '-')), { lines: [1, 1], match: 'far' })!.found, false, 'more than 20 lines away: not found')
  // Not there: the whole lines, from the first line's text; no match: the same, found.
  assert.deepEqual(findMark(doc, { lines: [3, 4], match: 'nothing' }), { spot: { line: 2, col: 1, endLine: 3, endCol: 20 }, moved: 0, found: false })
  assert.deepEqual(findMark(doc, { lines: [4, 4] }), { spot: { line: 3, col: 2, endLine: 3, endCol: 20 }, moved: 0, found: true })
  assert.equal(findMark(doc, { lines: [7, 8] }), undefined, 'past the end: nothing')
  assert.deepEqual(findMark(doc, { lines: [6, 9] })!.spot, { line: 5, col: 1, endLine: 5, endCol: 19 }, 'partly past the end: what is there')
})
