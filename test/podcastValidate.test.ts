import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { audioPathProblem, brokenLinks, playNotice, PodcastContext, readPodcastText, validatePodcast, validateRead } from '../src/core/format/podcast/validate'
import { lineCol, locate } from '../src/core/json/spans'

// The podcast file's full check (src/core/format/podcast/validate.ts). The cases in test/fixtures/podcast/cases.json
// are run here and through the code-journey skill's `journey.py podcast` (test/cli/podcast.test.mjs): with node it
// runs this validator, without it its own fallback copy of the rules, which must give the same problems. The cases
// are asserted by code and place; the wording is one test below (and every message is in the golden,
// test/goldens/podcast/validate.cases.json).

interface Case {
  name: string
  /** The podcast file's text: needed as text for the cases that aren't JSON; else `podcast`, written out here. */
  raw?: string
  podcast?: unknown
  journey: NonNullable<PodcastContext['journey']>
  audio?: { exists: boolean; size?: number }
  audioDuration?: number
  changed?: number[]
  files?: Record<string, string | null>
  expect: string[]
}
const cases: Case[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/podcast/cases.json'), 'utf8'))

/** A case's podcast file as text. */
const rawOf = (c: Case) => c.raw ?? JSON.stringify(c.podcast, null, 2)

/** A case's context: its journey and audio, and its repository files (for the marks) from `files` (a file not
 *  listed: not read). */
function contextFor(c: Case): PodcastContext {
  const files = c.files
  return {
    journey: c.journey,
    audio: c.audio,
    audioDuration: c.audioDuration,
    changed: c.changed,
    ...(files ? { files: (f: string) => (f in files ? files[f] : undefined) } : {}),
  }
}

const check = (c: Case) => validatePodcast(rawOf(c), contextFor(c))
const caseNamed = (name: string) => cases.find((x) => x.name === name)!
const problemsOf = (name: string) => check(caseNamed(name)).problems
/** A problem by what the tests compare: level, code, segment, path. */
const said = (p: { level: string; code: string; segment?: string; path: (string | number)[] }) => [p.level, p.code, p.segment ?? null, p.path.join('.')]
const codes = (c: Case) => check(c).problems.map((p) => `${p.level}:${p.code}${p.segment ? `@${p.segment}` : ''}`)

for (const c of cases) {
  test(`podcast check: ${c.name}`, () => {
    assert.deepEqual([...codes(c)].sort(), [...c.expect].sort())
    const v = check(c)
    assert.equal(v.playable, !c.expect.some((e) => e.startsWith('error:')), 'playable = no error')
    assert.equal(!!v.episode, v.playable)
  })
}

test('podcast check: errors come first, each on the field at fault', () => {
  const first = (name: string) => said(problemsOf(name)[0])
  assert.deepEqual(first('version 2'), ['error', 'version', null, 'version'])
  assert.deepEqual(first('segments empty'), ['error', 'segments', null, 'segments'])
  assert.deepEqual(first('segments missing'), ['error', 'segments', null, ''])
  assert.deepEqual(first('segments not a list'), ['error', 'segments', null, 'segments'])
  assert.deepEqual(first('audio outside the journeys folder'), ['error', 'audio-outside', null, 'audio'])
  assert.deepEqual(first('audio file missing'), ['error', 'audio-missing', null, 'audio'])
  assert.deepEqual(first('cut-off audio: one plain warning'), ['warning', 'audio-short', null, 'audio'])
  assert.deepEqual(first('written for another journey'), ['warning', 'journey', null, 'journey.id'])
  assert.deepEqual(first('end past the declared duration'), ['warning', 'past-duration', 's2', 'segments.1.end'])
  assert.deepEqual(problemsOf('overlap, out of order, end before start').map(said), [
    ['warning', 'overlap', 's2', 'segments.1.start'],
    ['warning', 'narration-order', 's4', 'segments.2.at.step'],
    ['warning', 'end-before-start', 's3', 'segments.3.end'],
    ['warning', 'order', 's3', 'segments.3.start'],
  ])
  assert.deepEqual(first('sentences: out of order'), ['warning', 'sentences', 's1', 'segments.0.sentences.2.start'])
  assert.deepEqual(first('sentences: a start outside the segment'), ['warning', 'sentences', 's1', 'segments.0.sentences.1.start'])
  assert.deepEqual(first('sentences: not a list'), ['warning', 'sentences', 's1', 'segments.0.sentences'])
})

test('podcast check: the messages say what is wrong in plain words', () => {
  const message = (name: string, code?: string) => problemsOf(name).find((p) => !code || p.code === code)!.message
  assert.equal(message('version 2'), 'version 2: this player reads version 1')
  assert.equal(message('segments not a list'), '"segments" is not a list (it is an object)')
  assert.equal(message('audio outside the journeys folder'), 'audio must be in the journeys folder (got ../x.mp3)')
  assert.equal(message('cut-off audio: one plain warning'), 'The audio is 0:13 long but the episode is 1:40: the file looks cut off (3 parts start after its end)')
  assert.equal(message('overlap, out of order, end before start', 'overlap'), 'segment s2: starts at 0:08, before segment s1 ends (0:10): the later one wins from its start')
  assert.equal(message('overlap, out of order, end before start', 'order'), 'segment s3: starts at 0:30, before segment s4 above it (0:40): segments play in time order, not in file order')
  assert.equal(message('sentences: a start outside the segment'), 'segment s1: sentences: item 2 starts at 0:06.5, outside the segment (0:03–0:05.8); the caption is estimated from the text instead')
  assert.equal(message("a step the journey doesn't have, in three segments: said once, with its segments and times"), 'step "gone" isn\'t in the journey (segments x1–x3, 0:10–0:39): they keep the view before them')
  assert.equal(message('a beat written as a string'), 'Step 1: beat must be a number, got the string "2"; showing the whole step')
  assert.equal(message('a duplicate id and an unknown cue', 'id'), 'segment s1: the id "s1" is used twice (0:00 and 0:10)')
  assert.match(message("narrated in another order than the journey's (steps reordered since)"), /^segment a: narrates step 1 \("a"\) after step 3 \("c"\): the journey's steps were reordered since it was recorded/)
  assert.equal(message('recorded for an older commit, steps changed since: a quiet note'), 'Code changed since recording: steps 1, 3')
})

test('podcast check: audio paths', () => {
  for (const ok of ['a.mp3', './a.mp3', 'sub/a.mp3', 'sub/../a.mp3']) assert.equal(audioPathProblem(ok), undefined, ok)
  for (const bad of ['../a.mp3', 'sub/../../a.mp3', '/abs/a.mp3', 'C:\\a.mp3', '..\\a.mp3', 'file:///a.mp3', 'http://x/a.mp3']) assert.ok(audioPathProblem(bad), bad)
})

test('podcast check: each problem is located in the text (the field, else the segment)', () => {
  const raw = '{\n  "version": 1,\n  "audio": "a.mp3",\n  "segments": [\n    { "id": "s1", "at": null, "start": 0, "end": 5 },\n    { "id": "s2", "at": { "step": "zz" }, "start": 5, "end": 9 }\n  ]\n}'
  const v = validatePodcast(raw, { journey: { id: 'j', steps: [{ id: 'a', beats: 0 }] } })
  const p = v.problems.find((x) => x.code === 'step')!
  assert.deepEqual(p.path, ['segments', 1, 'at', 'step'])
  const span = locate(raw, p.path)
  assert.equal(raw.slice(span.start, span.end), '"step": "zz"')
  assert.deepEqual(lineCol(raw, span.start), { line: 5, col: 26 })
  // A path partly there: the deepest part that is.
  assert.equal(raw.slice(locate(raw, ['segments', 0, 'cue']).start, locate(raw, ['segments', 0, 'cue']).end), '{ "id": "s1", "at": null, "start": 0, "end": 5 }')
  // Invalid JSON: where the parser stopped.
  const broken = '{\n  "version": 1,\n  "audio": \n}'
  const at = locate(broken, [])
  assert.ok(at.start > 10, `the error's place: ${at.start}`)
})

test('podcast check: what the player says, in one short line: as many problems as the Problems view lists', () => {
  const v = problemsOf
  const links = v('broken links: a beat out of range, an unknown step, a bad at')
  assert.equal(brokenLinks(links), 3)
  assert.equal(playNotice(links), '3 problems')
  assert.equal(playNotice(v('written for another journey')), '1 problem')
  assert.equal(playNotice(v('cut-off audio: one plain warning')), '1 problem')
  assert.equal(playNotice(v('a duplicate id and an unknown cue')), '2 problems')
  assert.equal(playNotice([]), undefined)
})

test('podcast check: a missing step once, a beat as a string, duplicate ids, narration order, recorded for', () => {
  const missing = problemsOf("a step the journey doesn't have, in three segments: said once, with its segments and times")
  assert.deepEqual(missing.map(said), [['warning', 'step', 'x1', 'segments.1.at.step']])
  assert.deepEqual(missing[0].segments, ['x1', 'x2', 'x3'])
  assert.equal(brokenLinks(missing), 3, 'each segment counts as a part that can\'t be shown')
  assert.deepEqual(problemsOf('a beat written as a string').map(said), [['warning', 'beat', 'a2', 'segments.1.at.beat']])
  assert.deepEqual(problemsOf('a duplicate id and an unknown cue').map(said), [['warning', 'id', 's1', 'segments.1.id'], ['warning', 'cue', 's1', 'segments.1.cue']])
  assert.deepEqual(problemsOf("narrated in another order than the journey's (steps reordered since)").map(said), [['warning', 'narration-order', 'a', 'segments.2.at.step']])
  // The beat is said once; of its marks, only the one with its own file is checked against the code.
  const knock = problemsOf("a beat the step doesn't have: said once, its marks on the beat's code not checked against the step's file (a mark with its own file still is)")
  assert.deepEqual(knock.map(said), [['warning', 'mark', 's1', 'segments.1.marks.1.match'], ['warning', 'beat', 's1', 'segments.1.at.beat']])
  assert.equal(knock[0].message.includes('src/b.go'), true, 'the mark with its own file: checked against it')
  const rec = problemsOf('recorded for an older commit, steps changed since: a quiet note')
  assert.deepEqual(rec.map(said), [['info', 'recorded-for', null, 'journey.commit']])
  assert.equal(playNotice(rec), rec[0].message, 'nothing wrong with the file: the quiet line itself')
  assert.equal(playNotice(problemsOf("narrated in another order than the journey's (steps reordered since)")), '1 problem')
})

test('podcast check: one reading of the file for both the shape and the rules', () => {
  // readPodcastText + validateRead is validatePodcast in two steps (load.ts gathers the context between them).
  for (const c of cases) assert.deepEqual(validateRead(readPodcastText(rawOf(c)), contextFor(c)), check(c), c.name)
  // A podcast of another version is not read, but the journey it names is (the stray-file line says it).
  const other = readPodcastText(JSON.stringify({ version: 2, journey: { id: 'j' } }))
  assert.equal(other.podcast, undefined)
  assert.equal(other.journey?.id, 'j')
})
