// Golden tests (test/README.md): the podcast file as read today, byte for byte: the full check of every case in
// test/fixtures/podcast/cases.json (problems, messages, where they are, the episode), the sample podcast against its
// journey (the episode the panel is sent), and the player's pure timing (chapters, views, marks, resume).
import { test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { expectGolden } from './golden'
import { Journey } from '../src/core/format/journeyModel'
import { journeyOf } from './formats'
import { calmViews, chapterJump, chaptersOf, clock, clockMs, Episode, isPodcastFile, JourneyShape, markTimes, marksAt, marksOf, marksProblems, parsePodcast, planMarks, podcastFileOf, resolveEpisode, segmentAt, timeOf, viewAt } from '../src/core/format/podcast/model'
import { audioPathProblem, brokenLinks, jsonSyntaxError, lineCol, locate, markFileNames, playNotice, validatePodcast } from '../src/core/format/podcast/validate'
import { afterStep, remapTime, resumeTime } from '../src/podcast/resume'

const AREA = 'podcast'

/** parsePodcast's result as the goldens hold it: the podcast, or the reason it was refused. */
const parsedOrWhy = (raw: string) => {
  const r = parsePodcast(raw)
  return r.ok ? r.value : r.why
}
const root = path.join(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

interface Case { name: string; raw: string; journey: JourneyShape & { id: string }; audio?: { exists: boolean; size?: number }; audioDuration?: number; changed?: number[]; files?: Record<string, string | null> }
const cases: Case[] = JSON.parse(read('test/fixtures/podcast/cases.json'))
const ctxOf = (c: Case) => ({ journey: c.journey, audio: c.audio, audioDuration: c.audioDuration, changed: c.changed, ...(c.files ? { files: (f: string) => (f in c.files! ? c.files![f] : undefined) } : {}) })

test('golden: every podcast case checked in full (problems, messages, paths, the episode)', () => {
  expectGolden(AREA, 'validate.cases', cases.map((c) => {
    const v = validatePodcast(c.raw, ctxOf(c))
    return {
      name: c.name, ...v,
      notice: playNotice(v.problems), broken: brokenLinks(v.problems),
      // Where each problem is in the file (what the Problems view underlines).
      spans: v.problems.map((p) => locate(c.raw, p.path)),
      syntax: jsonSyntaxError(c.raw),
      parsed: parsedOrWhy(c.raw),
    }
  }))
})

/** The sample journey's shape, as load.ts gives it to the player. */
const sample = journeyOf(read('test/journey-scene/sample.json'), 'sample')
const shape: JourneyShape & { id: string } = {
  id: sample.id,
  steps: sample.steps.map((s) => ({ id: s.id, beats: s.scene?.beats?.length ?? 0, file: s.file, beatFiles: (s.scene?.beats ?? []).map((b) => (typeof b.code?.file === 'string' ? b.code.file : null)) })),
}
const raw = read('test/fixtures/podcast/sample.podcast.json')

test('golden: the sample podcast against its journey: the episode the panel is sent', () => {
  const v = validatePodcast(raw, { journey: shape, audio: { exists: true, size: 1000 }, audioDuration: 40.2 })
  expectGolden(AREA, 'sample.validation', { shape, ...v, markFiles: v.podcast ? markFileNames(v.podcast, shape) : [] })
  expectGolden(AREA, 'sample.resolved', resolveEpisode(parsedOrWhy(raw) as never, shape))
})

test('golden: the sample episode\'s timing: views, chapters, jumps, calm views, resume', () => {
  const ep = validatePodcast(raw, { journey: shape }).episode as Episode
  const times = [-1, 0, 2.9, 3, 5.85, 10, 17.5, 25, 39.99, 40, 99]
  const reordered: Episode = { ...ep, segments: [...ep.segments].reverse().map((s, i) => ({ ...s, start: i * 5, end: i * 5 + 4 })) }
  expectGolden(AREA, 'sample.timing', {
    at: times.map((t) => ({ t, seg: segmentAt(ep.segments, t), view: viewAt(ep, t), next: chapterJump(ep, t, 1), prev: chapterJump(ep, t, -1) })),
    timeOf: shape.steps.flatMap((s, i) => [undefined, 1, 2, 9].map((beat) => ({ step: i + 1, beat, t: timeOf(ep, i + 1, beat) }))),
    chapters: chaptersOf(ep.segments, ep.duration),
    calm: calmViews(ep, (v) => shape.steps[v.step - 1]?.file ?? ''),
    calmShortHold: calmViews(ep, (v) => (v.step % 2 ? 'a.ts' : 'b.ts'), 2),
    afterStep: [0, 1, 2, 4, 7, 8].map((s) => [s, afterStep(ep, s)]),
    resume: [[0, 0], [12, 0], [12, 3], [12, 99], [-5, 1], [500, 2]].map(([saved, step]) => [saved, step, resumeTime(ep, saved, step)]),
    remap: [0, 4, 12.5, 39].map((t) => [t, remapTime(ep, reordered, t)]),
  })
})

test('golden: segment marks: read, timed, lit, planned', () => {
  const text = 'The cart is saved, then the order is placed and the order is queued.'
  const marks = [
    { lines: [1, 2], phrase: 'cart', at: 0.5 },
    { lines: [3, 4], phrase: 'order is placed', at: 2.5, file: 'api/orders.ts' },
    { lines: [3, 4], phrase: 'order is placed', at: 2.5, match: 'place' },
    { lines: [5, 5], phrase: 'the order', at: 4 },
    { lines: [7, 7], phrase: 'not said here', at: 5, file: 'api/queue.ts' },
    { lines: [6, 6], phrase: 'queued', at: 3.2 },
    { lines: [2, 1], phrase: 'bad lines', at: 1 },
    { lines: [8, 8], phrase: 'late', at: 99 },
    { lines: [8, 8], phrase: '', at: 1 },
    { lines: [8, 8], phrase: 'x', at: '1' },
    { lines: [8, 8], phrase: 'x' },
    'not an object',
  ]
  const read = marksOf(marks, text, 5, 12, false) ?? []
  const times = markTimes({ start: 5, marks: read })
  expectGolden(AREA, 'marks', {
    problems: marksProblems(marks, text, 5, 12, false), problemsOnMap: marksProblems(marks, text, 5, 12, true),
    read, onMap: marksOf(marks, text, 5, 12, true), none: [marksOf(undefined, text, 0, 1, true), marksOf('x', text, 0, 1, true)],
    times,
    lit: [4, 5, 5.5, 7, 8.9, 12, 13].map((t) => [t, marksAt(times, t)]),
    planned: planMarks(read, times, 'web/cart.ts', 'web/cart.ts', 0),
    plannedOtherFile: planMarks(read, times, 'web/cart.ts', 'api/orders.ts', 4),
  })
})

test('golden: file names, audio paths, clocks, JSON places', () => {
  const bad = ['{\n  "a": 1,\n  "b": }', '', '[1, 2', '{"a": "x\n"}', '{"a": 1} x', '{"a": tru}']
  expectGolden(AREA, 'helpers', {
    files: ['journeys/a.json', 'a.JSON', 'a.podcast.json', 'a.json.bak'].map((f) => [f, podcastFileOf(f), isPodcastFile(f)]),
    audio: ['a.mp3', 'sub/a.mp3', './a.mp3', '../a.mp3', 'sub/../../a.mp3', '/abs/a.mp3', 'C:\\x\\a.mp3', 'c:/x.mp3', 'https://x/a.mp3', 'file:a.mp3', 'sub\\..\\a.mp3'].map((a) => [a, audioPathProblem(a) ?? null]),
    clock: [0, 0.4, 59.9, 60, 61.5, 3599, 3600, 7322.25, -3].map((t) => [t, clock(t), clockMs(t)]),
    syntax: bad.map((r) => [r, jsonSyntaxError(r) ?? null]),
    lineCol: [0, 3, 5, 12, 100].map((o) => [o, lineCol(bad[0], o)]),
    locate: [[], ['a'], ['b'], ['zz', 3]].map((p) => [p, locate('{\n  "a": [1, {"x": 2}],\n  "b": "s"\n}', p)]),
  })
})
