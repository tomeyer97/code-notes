// The podcast tests' journeys and podcast files. Every podcast file goes through `writePodcast` (the format in one
// place: version 1, the journey's id, the audio next to it, the segments); every audio is the 40 s tone or made from
// it (audio.ts). Each writer writes only what is missing, so a test can call it to set up its own journey whether or
// not a test before it did.
import * as fs from 'fs'
import * as path from 'path'
import { journey, step, writeJourney, writeLines } from '../../fixtures'
import { journeysDir, wsPath } from '../context'
import { repeatMp3, silentWav } from './audio'

/** A file under test/fixtures/ (from the compiled test, out/test/integration/main/podcast/). */
export const fixturePath = (rel: string) => path.join(__dirname, '../../../../../test/fixtures', rel)
/** 40 s of a tone (MP3): every podcast's audio here. */
export const tonePath = () => fixturePath('podcast/tone.mp3')

/** A podcast segment: part `id` at `at` (a step and beat, or null: the map), from `start` to `end` (s). */
export const seg = (id: string, at: { step: string; beat?: number } | null, start: number, end: number, more: object = {}) =>
  ({ id, at, speaker: 'host', text: `Part ${id}.`, start, end, ...more })

/** <journeys>/<id>.podcast.json */
export const podcastFile = (id: string) => path.join(journeysDir(), `${id}.podcast.json`)

/**
 * Journey `id`'s podcast file: `segments` (speaker "host" unless given), `duration` s, its audio `<id>.<ext>` a copy
 * of `audio` (the tone by default; kept when there already), or written from `audio` when it is a Buffer.
 */
export function writePodcast(id: string, title: string, segments: object[], { duration = 40, audio = tonePath() as string | Buffer, ext = 'mp3' } = {}): void {
  const file = path.join(journeysDir(), `${id}.${ext}`)
  if (!fs.existsSync(file)) {
    if (typeof audio === 'string') fs.copyFileSync(audio, file)
    else fs.writeFileSync(file, audio)
  }
  fs.writeFileSync(podcastFile(id), JSON.stringify({
    version: 1, title, journey: { id }, audio: `${id}.${ext}`, duration,
    segments: segments.map((x) => ({ speaker: 'host', ...x })),
  }))
}

/** One actor for a step's animation, and a beat of it on `line` of `file` (`text`: that line's text). */
const actors = (fn: string) => [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn, checks: ['a'] }]
const beat = (caption: string, file: string, line: number, text: string) => ({ focus: 'svc', caption, code: { file, line, text } })
/** `n` lines `export const <name><i> = <i>` (1-based), from line `from`. */
export const numbered = (name: string, n: number, from = 1) => Array.from({ length: n }, (_, i) => `export const ${name}${from + i} = ${from + i}`)

/** Writes the journey and its podcast unless its podcast file is there already. */
function once(id: string, write: () => void): void {
  if (!fs.existsSync(podcastFile(id))) write()
}

// ---------- playback ----------

/** "podauto": one step, a podcast that never leaves the map (all its parts on no step). */
export const writeAutoJourney = () => once('podauto', () => {
  writeLines(wsPath('src', 'auto.ts'), ['export const auto = 1'])
  writeJourney(journeysDir(), journey('podauto', [step('src/auto.ts', 1, 1, { id: 'u1', title: 'auto' })], { title: 'Pod auto' }))
  writePodcast('podauto', 'Pod auto', [{ ...seg('a', null, 0, 39), text: 'All on the map.' }])
})

/** src/pod.ts: one() on lines 1-3, two() on 4-6; src/pod2.ts: one line. Written once: several journeys walk them. */
const writePodSources = () => {
  if (fs.existsSync(wsPath('src', 'pod.ts'))) return
  writeLines(wsPath('src', 'pod.ts'), ['export function one() {', '  return 1', '}', 'export function two() {', '  return 2', '}'])
  writeLines(wsPath('src', 'pod2.ts'), ['export const three = 3'])
}

/** "pod": step 1 and 2 with animations, step 3 without; its podcast names beat 4 of step 3, which has none (the
 *  file's one warning). */
export const writePodJourney = () => once('pod', () => {
  writePodSources()
  const svc = [{ ...actors('one()')[0], checks: ['a', 'b', 'c'] }]
  const b = (caption: string, line: number, text: string) => ({ focus: 'svc', caption, code: { file: 'src/pod.ts', line, text } })
  writeJourney(journeysDir(), journey('pod', [
    step('src/pod.ts', 1, 3, { id: 'p1', title: 'one returns 1', scene: { actors: svc, wires: [], beats: [b('Opens.', 1, 'export function one() {'), b('Returns.', 2, 'return 1'), b('Closes.', 3, '}')] } }),
    step('src/pod.ts', 4, 6, { id: 'p2', title: 'two returns 2', scene: { actors: svc, wires: [], beats: [b('Opens.', 4, 'export function two() {'), b('Returns.', 5, 'return 2')] } }),
    step('src/pod2.ts', 1, 1, { id: 'p3', title: 'three' }),
  ], { title: 'Pod' }))
  writePodcast('pod', 'Pod', [
    seg('intro', null, 0, 2.8),
    seg('a1', { step: 'p1', beat: 1 }, 3, 5.8),
    seg('a3', { step: 'p1', beat: 3 }, 6, 8.8),
    seg('b', { step: 'p2' }, 9, 11.8),
    seg('b2', { step: 'p2', beat: 2 }, 12, 14.8),
    seg('c', { step: 'p3' }, 15, 17.8),
    seg('c4', { step: 'p3', beat: 4 }, 18, 20.8), // p3 has no animation: the step only
    seg('outro', null, 21, 39),
  ])
})

/** "podwav": ten minutes of silence (a WAV), two steps of five minutes each. */
export const WAV_S = 600
export const writeWavJourney = () => once('podwav', () => {
  writePodSources()
  writeJourney(journeysDir(), journey('podwav', [step('src/pod.ts', 1, 3, { id: 'l1' }), step('src/pod2.ts', 1, 1, { id: 'l2' })], { title: 'Pod wav' }))
  writePodcast('podwav', 'Long', [{ id: 'a', at: { step: 'l1' }, text: 'a', start: 0, end: 300 }, { id: 'b', at: { step: 'l2' }, text: 'b', start: 300, end: 600 }],
    { duration: WAV_S, audio: silentWav(WAV_S), ext: 'wav' })
})

/** "podgap": three steps, the podcast says nothing about step 2; step 3's part starts at `g3start` s. */
export const writeGapPodcast = (g3start: number) => writePodcast('podgap', 'Pod gap',
  [seg('intro', null, 0, 2.8), seg('g1', { step: 'g1' }, 3, g3start - 0.2), seg('g3', { step: 'g3' }, g3start, 20), seg('outro', null, 21, 39)])
export const writeGapJourney = () => once('podgap', () => {
  writePodSources()
  writeJourney(journeysDir(), journey('podgap', [
    step('src/pod.ts', 1, 3, { id: 'g1', title: 'one' }),
    step('src/pod.ts', 4, 6, { id: 'g2', title: 'two, not in the podcast' }),
    step('src/pod2.ts', 1, 1, { id: 'g3', title: 'three' }),
  ], { title: 'Pod gap' }))
  writeGapPodcast(9)
})

/** "podbeat": one step in pod.ts whose second beat is in pod2.ts. */
export const writeBeatJourney = () => once('podbeat', () => {
  writePodSources()
  writeJourney(journeysDir(), journey('podbeat', [
    step('src/pod.ts', 1, 3, { id: 'b1', title: 'one', scene: { actors: actors('one()'), wires: [], beats: [
      beat('Here.', 'src/pod.ts', 2, 'return 1'),
      beat('There.', 'src/pod2.ts', 1, 'export const three = 3'),
    ] } }),
  ], { title: 'Pod beat' }))
  const s = (id: string, at: { step: string; beat?: number } | null, start: number, end: number) => seg(id, at, start, end, { text: id })
  writePodcast('podbeat', 'Pod beat', [s('intro', null, 0, 2.8), s('here', { step: 'b1', beat: 1 }, 3, 5.8), s('there', { step: 'b1', beat: 2 }, 6, 20), s('outro', null, 21, 39)])
})

// ---------- listening ----------

const LISTEN_PAD = ` // ${'x'.repeat(30)}`
/** src/listen.ts: 220 lines `export const l<i> = <i> // xxx…`. */
const listenLine = (i: number) => `export const l${i} = ${i}${LISTEN_PAD}`

/** "podlisten": step L1 (listen.ts, an animation of 4 beats: line 12, line 150, listen2.ts line 1, line 14 never
 *  narrated), L2 (listen.ts 100–110), L3 (listen2.ts); `order`: the steps' order in the journey file (ids). The
 *  journey is written every time (the tests reorder it); the podcast only when missing. */
export function writeListenJourney(order = ['L1', 'L2', 'L3']): void {
  writeLines(wsPath('src', 'listen.ts'), Array.from({ length: 220 }, (_, i) => listenLine(i + 1)))
  writeLines(wsPath('src', 'listen2.ts'), ['export const other = 1', 'export const two = 2'])
  const steps: Record<string, ReturnType<typeof step>> = {
    L1: step('src/listen.ts', 10, 20, { id: 'L1', title: 'listen one', scene: { actors: actors('one()'), wires: [], beats: [
      beat('Here.', 'src/listen.ts', 12, listenLine(12)),
      beat('Far down.', 'src/listen.ts', 150, listenLine(150)),
      beat('Elsewhere.', 'src/listen2.ts', 1, 'export const other = 1'),
      beat('Not told.', 'src/listen.ts', 14, listenLine(14)),
    ] } }),
    L2: step('src/listen.ts', 100, 110, { id: 'L2', title: 'listen two' }),
    L3: step('src/listen2.ts', 1, 2, { id: 'L3', title: 'listen three' }),
  }
  writeJourney(journeysDir(), journey('podlisten', order.map((id) => steps[id]), { title: 'Pod listen' }))
  once('podlisten', () => writePodcast('podlisten', 'Pod listen', [
    seg('intro', null, 0, 3.8),
    seg('b1', { step: 'L1', beat: 1 }, 4, 11.8),
    seg('b2', { step: 'L1', beat: 2 }, 12, 19.8),
    seg('b3', { step: 'L1', beat: 3 }, 20, 22.8),
    seg('l2', { step: 'L2' }, 23, 30.8),
    seg('outro', null, 31, 40),
  ]))
}

// ---------- marks ----------

/** src/marks.ts (1-based lines): 3 the check, 4 the return that rejects, 5-6 the block's end, END_LINE far down. */
export const END_LINE = 180
export const MARK_LINES = [
  'export const m1 = 1',
  'export const m2 = 2',
  '  if (needsModel(steps) && mode === strict && strict) {',
  '    return reject(400)',
  '  }',
  '  return ok()',
  ...numbered('m', END_LINE - 7, 7),
  'export const end = done() // the end',
  ...numbered('m', 200 - END_LINE, END_LINE + 1),
]

/** "podmarks": one step (src/marks.ts, a beat on line 3) whose part (10-20 s) has five marks: "requires a model"
 *  (needsModel(steps)), "strict is set" (the second "strict"), "right there" twice (the return, re-found a line up
 *  from where it says; lines 5-6, whole), "at the end" (END_LINE). */
export const writeMarksJourney = () => once('podmarks', () => {
  writeLines(wsPath('src', 'marks.ts'), MARK_LINES)
  writeJourney(journeysDir(), journey('podmarks', [step('src/marks.ts', 1, 10, { id: 'M1', title: 'marks one', scene: { actors: actors('check()'), wires: [], beats: [
    beat('The check.', 'src/marks.ts', 3, MARK_LINES[2]),
  ] } })], { title: 'Pod marks' }))
  writePodcast('podmarks', 'Pod marks', [
    { ...seg('intro', null, 0, 3.8), text: 'Hello.' },
    { ...seg('m0', { step: 'M1', beat: 1 }, 4, 9.8), text: 'Here.' },
    { ...seg('m1', { step: 'M1', beat: 1 }, 10, 19.8), text: 'If it requires a model and strict is set, it is rejected right there, at the end.', marks: [
      { phrase: 'requires a model', at: 1, lines: [3, 3], match: 'needsModel(steps)' },
      { phrase: 'strict is set', at: 2.5, lines: [3, 3], match: 'strict', nth: 2 },
      { phrase: 'right there', at: 4, lines: [5, 5], match: 'reject(400)' },
      { phrase: 'right there', at: 4, lines: [5, 6] },
      { phrase: 'at the end', at: 6, lines: [END_LINE, END_LINE], match: 'done()' },
    ] },
    { ...seg('outro', null, 20, 40), text: 'Bye.' },
  ])
})

/** A mark as the snapshot has it (0-based lines): the `nth` `text` on `line` (1-based, in MARK_LINES). */
export function markAt(line: number, text: string, nth: number, style: 'focus' | 'dim') {
  const l = MARK_LINES[line - 1]
  let col = -text.length
  for (let k = 0; k < nth; k++) col = l.indexOf(text, col + text.length)
  return { line: line - 1, col, endLine: line - 1, endCol: col + text.length, text, style }
}

// ---------- camera ----------

/** The far mark of "podcam" (1-based). */
export const CAM_FAR_LINE = 200
/** "podcam": one step (src/cam.ts, its beat on line 3) whose part (4-30 s) has marks on line 3 (4.88 s), line 5
 *  (5.88 s, in view), CAM_FAR_LINE (6.88 s, far below) and line 3 again (7.88 s, far above by then). */
export const writeCamJourney = () => once('podcam', () => {
  const lines = numbered('c', 220)
  writeLines(wsPath('src', 'cam.ts'), lines)
  writeJourney(journeysDir(), journey('podcam', [step('src/cam.ts', 1, 10, { id: 'C1', title: 'camera one', scene: { actors: actors('cam()'), wires: [], beats: [
    beat('Here.', 'src/cam.ts', 3, lines[2]),
  ] } })], { title: 'Pod cam' }))
  writePodcast('podcam', 'Pod cam', [
    { ...seg('intro', null, 0, 3.8), text: 'Hello.' },
    { ...seg('c1', { step: 'C1', beat: 1 }, 4, 30), text: 'Three, five, far down, and back up.', marks: [
      { phrase: 'Three', at: 1, lines: [3, 3] },
      { phrase: 'five', at: 2, lines: [5, 5] },
      { phrase: 'far down', at: 3, lines: [CAM_FAR_LINE, CAM_FAR_LINE] },
      { phrase: 'back up', at: 4, lines: [3, 3] },
    ] },
    { ...seg('outro', null, 30, 40), text: 'Bye.' },
  ])
})

/**
 * When marks light, written out: [second, the focus marks' lines (1-based)] from that second on. A mark lights
 * 0.12 s before its word (`start + at - 0.12`); a segment's end puts its marks out. Written here, not computed by the
 * extension's own model (src/core/format/podcast/marks.ts, which its unit tests cover).
 */
export type Cue = [number, number[]]
/** The focus lines lit at second `t`, by `cues`. */
export function focusAt(cues: Cue[], t: number): number[] {
  let lit: number[] = []
  for (const [at, lines] of cues) if (lines.length ? at <= t + 1e-6 : at <= t) lit = lines
  return lit
}
/** Second `t` is this close to a mark lighting (s): what is lit then may be either side of it. */
export const nearCue = (cues: Cue[], t: number, by = 0.2) => cues.some(([at, lines]) => lines.length > 0 && Math.abs(at - t) < by)

/** "podwalk": one step (src/walk.ts, its beat on line 3) whose part (4-38 s) lights marks far apart: line 5 (in
 *  view), then 300, 20, 350, 40, 380 (each out of view of the one before). */
export const WALK_FROM = 4.3
export const WALK_CUES: Cue[] = [[4.88, [5]], [7.88, [300]], [11.88, [20]], [15.88, [350]], [19.88, [40]], [23.88, [380]], [38, []]]
export const writeWalkJourney = () => once('podwalk', () => {
  writeLines(wsPath('src', 'walk.ts'), numbered('walk', 420))
  writeJourney(journeysDir(), journey('podwalk', [step('src/walk.ts', 1, 10, { id: 'W1', title: 'walk one', scene: { actors: actors('walk()'), wires: [], beats: [
    beat('Here.', 'src/walk.ts', 3, 'export const walk3 = 3'),
  ] } })], { title: 'Pod walk' }))
  writePodcast('podwalk', 'Pod walk', [
    { ...seg('intro', null, 0, 3.8), text: 'Hello.' },
    { ...seg('w1', { step: 'W1', beat: 1 }, 4, 38), text: 'Alpha here, beta far down, gamma up, delta down, epsilon up, zeta down.', marks: [
      { phrase: 'Alpha', at: 1, lines: [5, 5] }, { phrase: 'beta', at: 4, lines: [300, 300] }, { phrase: 'gamma', at: 8, lines: [20, 20] },
      { phrase: 'delta', at: 12, lines: [350, 350] }, { phrase: 'epsilon', at: 16, lines: [40, 40] }, { phrase: 'zeta', at: 20, lines: [380, 380] },
    ] },
    { ...seg('outro', null, 38.2, 40), text: 'Bye.' },
  ])
})

/** The text in the line of src/wide.ts whose first mark is far right (past column 260). */
export const FAR_MARKER = 'FARMARK'
/** src/wide.ts line `i` (1-based): its tag "/* wide<i> *\/", then 307 characters; line 300 has FAR_MARKER. */
const wideLine = (i: number) => `/* wide${i} */ export const w${i} = '${'x'.repeat(240)}${i === 300 ? FAR_MARKER : 'yyyyyyy'}${'z'.repeat(60)}'`
/** "podwide": src/wide.ts of long lines; marks on line 150 (a short match at column 15) and line 300 (FAR_MARKER). */
export const writeWideJourney = () => once('podwide', () => {
  writeLines(wsPath('src', 'wide.ts'), Array.from({ length: 320 }, (_, i) => wideLine(i + 1)))
  writeJourney(journeysDir(), journey('podwide', [step('src/wide.ts', 1, 5, { id: 'X1', title: 'wide one', scene: { actors: actors('wide()'), wires: [], beats: [
    beat('Here.', 'src/wide.ts', 2, wideLine(2)),
  ] } })], { title: 'Pod wide' }))
  writePodcast('podwide', 'Pod wide', [
    { ...seg('intro', null, 0, 3.8), text: 'Hello.' },
    { ...seg('x1', { step: 'X1', beat: 1 }, 4, 38), text: 'This constant, and that far mark.', marks: [
      { phrase: 'This constant', at: 3.5, lines: [150, 150], match: 'export const w150' },
      { phrase: 'that far mark', at: 6.5, lines: [300, 300], match: FAR_MARKER },
    ] },
    { ...seg('outro', null, 38.2, 40), text: 'Bye.' },
  ])
})

/** "podlong": ten minutes (the tone fifteen times), one step (src/long.ts), a part every 20 s from 4 s whose two
 *  marks, 2 s and 10 s in, are far apart (lines 10 and 300, then 350 and 30, …). */
export const LONG_S = 601
interface LongPart { start: number; end: number; text: string; lines: [number, number] }
export const LONG_PARTS: LongPart[] = []
for (let k = 0, t = 4; t + 20 <= 585; k++, t += 20) {
  LONG_PARTS.push({ start: t, end: t + 19.8, text: `Part ${k + 1}. Here is one thing, and then another thing far away, said slowly.`, lines: k % 2 ? [350, 30] : [10, 300] })
}
/** Its captions' segments: the intro, the parts, the outro. */
export const LONG_SEGS = [{ start: 0, end: 3.8, text: 'Hello.' }, ...LONG_PARTS, { start: 585, end: LONG_S - 0.5, text: 'That was all.' }]
/** Its marks lighting: each part's first 1.88 s in, its second 9.88 s in, none from its end. */
export const LONG_CUES: Cue[] = LONG_PARTS.flatMap((p): Cue[] => [[p.start + 1.88, [p.lines[0]]], [p.start + 9.88, [p.lines[1]]], [p.end, []]])
export const writeLongJourney = () => once('podlong', () => {
  writeLines(wsPath('src', 'long.ts'), numbered('long', 420))
  writeJourney(journeysDir(), journey('podlong', [step('src/long.ts', 1, 10, { id: 'G1', title: 'long one', scene: { actors: actors('long()'), wires: [], beats: [
    beat('Here.', 'src/long.ts', 3, 'export const long3 = 3'),
  ] } })], { title: 'Pod long' }))
  writePodcast('podlong', 'Pod long', [
    { ...seg('intro', null, 0, 3.8), text: 'Hello.' },
    ...LONG_PARTS.map((p, k) => ({ ...seg(`p${k}`, { step: 'G1', beat: 1 }, p.start, p.end), text: p.text, marks: [
      { phrase: 'one thing', at: 2, lines: [p.lines[0], p.lines[0]] }, { phrase: 'another thing', at: 10, lines: [p.lines[1], p.lines[1]] },
    ] })),
    { ...seg('outro', null, 585, LONG_S - 0.5), text: 'That was all.' },
  ], { duration: LONG_S, audio: repeatMp3(tonePath(), 15) })
})
