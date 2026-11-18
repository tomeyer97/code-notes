import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { audioPathProblem, brokenLinks, lineCol, locate, playNotice, validatePodcast } from '../src/podcast/validate'

// The podcast file's full check (src/podcast/validate.ts). The cases in test/fixtures/podcast/cases.json are run here
// and through the code-journey skill's `journey.py podcast` (test/cli/podcast.test.mjs): the same rules in both.

interface Case { name: string; raw: string; journey: { id: string; steps: { id: string; beats: number }[] }; audio?: { exists: boolean; size?: number }; audioDuration?: number; changed?: number[]; files?: Record<string, string | null>; expect: string[] }
const cases: Case[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/podcast/cases.json'), 'utf8'))
/** The case's context: its repository files (for the marks) read from `files` (a file not listed: not read). */
const ctxOf = (c: Case) => ({ journey: c.journey, audio: c.audio, audioDuration: c.audioDuration, changed: c.changed, ...(c.files ? { files: (f: string) => (f in c.files! ? c.files![f] : undefined) } : {}) })
const codes = (c: Case) => validatePodcast(c.raw, ctxOf(c)).problems.map((p) => `${p.level}:${p.code}${p.segment ? `@${p.segment}` : ''}`)

for (const c of cases) {
  test(`podcast check: ${c.name}`, () => {
    assert.deepEqual([...codes(c)].sort(), [...c.expect].sort())
    const v = validatePodcast(c.raw, ctxOf(c))
    assert.equal(v.playable, !c.expect.some((e) => e.startsWith('error:')), 'playable = no error')
    assert.equal(!!v.episode, v.playable)
  })
}

test('podcast check: errors come first, the messages say what is wrong in plain words', () => {
  const get = (name: string) => { const c = cases.find((x) => x.name === name)!; return validatePodcast(c.raw, ctxOf(c)).problems }
  assert.match(get('version 2')[0].message, /version 2: this player reads version 1/)
  assert.match(get('segments empty')[0].message, /"segments" is empty/)
  assert.match(get('segments missing')[0].message, /no "segments"/)
  assert.match(get('segments not a list')[0].message, /"segments" is not a list \(it is an object\)/)
  assert.equal(get('audio outside the journeys folder')[0].message, 'audio must be in the journeys folder (got ../x.mp3)')
  assert.match(get('audio file missing')[0].message, /the audio file j\.mp3 isn't there/)
  assert.equal(get('cut-off audio: one plain warning')[0].message, 'The audio is 0:13 long but the episode is 1:40: the file looks cut off (3 parts start after its end)')
  const timing = get('overlap, out of order, end before start').map((p) => p.message)
  assert.ok(timing.includes('segment s2: starts at 0:08, before segment s1 ends (0:10): the later one wins from its start'), timing.join('\n'))
  assert.ok(timing.includes('segment s3: ends at 0:25, before it starts (0:30)'), timing.join('\n'))
  assert.ok(timing.includes('segment s3: starts at 0:30, before segment s4 above it (0:40): segments play in time order, not in file order'), timing.join('\n'))
  assert.match(get('written for another journey')[0].message, /written for journey "other", but it is next to "j"/)
  assert.match(get('end past the declared duration')[0].message, /segment s2: ends at 2:30, after the episode's "duration" \(1:40\)/)
  assert.equal(get('sentences: out of order')[0].message, 'segment s1: sentences: item 3 starts at 0:04, before item 2 (0:04.4); the caption is estimated from the text instead')
  assert.equal(get('sentences: a start outside the segment')[0].message, 'segment s1: sentences: item 2 starts at 0:06.5, outside the segment (0:03–0:05.8); the caption is estimated from the text instead')
  assert.deepEqual(get('sentences: a start outside the segment')[0].path, ['segments', 0, 'sentences', 1, 'start'])
  assert.equal(get('sentences: not a list')[0].message, 'segment s1: sentences is not a list of { start, text }; the caption is estimated from the text instead')
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

test('podcast check: what the player says, in one short line', () => {
  const v = (name: string) => { const c = cases.find((x) => x.name === name)!; return validatePodcast(c.raw, ctxOf(c)).problems }
  const links = v('broken links: a beat out of range, an unknown step, a bad at')
  assert.equal(brokenLinks(links), 3)
  assert.equal(playNotice(links), "3 parts can't be shown")
  assert.equal(playNotice(v('written for another journey'), 'Test run'), 'Written for “Test run”')
  assert.equal(playNotice(v('written for another journey')), 'Written for “other”')
  assert.equal(playNotice(v('cut-off audio: one plain warning')), 'The audio is 0:13 long but the episode is 1:40: the file looks cut off')
  assert.equal(playNotice(v('a duplicate id and an unknown cue')), '2 problems in the podcast file')
  assert.equal(playNotice([]), undefined)
})

test('podcast check: a missing step once, a beat as a string, duplicate ids with times, narration order, recorded for', () => {
  const get = (name: string) => { const c = cases.find((x) => x.name === name)!; return validatePodcast(c.raw, ctxOf(c)).problems }
  const missing = get("a step the journey doesn't have, in three segments: said once, with its segments and times")
  assert.equal(missing.length, 1)
  assert.equal(missing[0].message, 'step "gone" isn\'t in the journey (segments x1–x3, 0:10–0:39): they keep the view before them')
  assert.deepEqual(missing[0].segments, ['x1', 'x2', 'x3'])
  assert.equal(brokenLinks(missing), 3, 'each segment counts as a part that can\'t be shown')
  assert.equal(get('a beat written as a string')[0].message, 'segment a2: beat must be a number, got the string "2"; the step only')
  assert.equal(get('a duplicate id and an unknown cue').find((p) => p.code === 'id')!.message.replace(/^segment \S+: /, ''), 'the id "s1" is used twice (0:00 and 0:10)')
  assert.match(get("narrated in another order than the journey's (steps reordered since)")[0].message, /^segment a: narrates step 1 \("a"\) after step 3 \("c"\): the journey's steps were reordered since it was recorded/)
  const rec = get('recorded for an older commit, steps changed since: a quiet note')
  assert.equal(rec[0].level, 'info')
  assert.equal(rec[0].message, 'recorded for 609d0bb; 2 steps changed since (steps 1, 3)')
  assert.equal(playNotice(rec), 'Recorded for 609d0bb; 2 steps changed since')
  assert.equal(playNotice(get("narrated in another order than the journey's (steps reordered since)")), "Narrated in another order than the journey's")
})
