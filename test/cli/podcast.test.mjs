// The code-journey skill's `journey.py podcast` (and `check`, which runs it). With node it runs the extension's own
// validator (src/core/format/podcast/validate.ts, through journey-check.mjs); without, journey.py's copy of its rules.
// Every case of test/fixtures/podcast/cases.json, which test/podcastValidate.test.ts runs through the extension, gives
// the same problems both ways.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JPY } from './helpers.mjs'
import { both } from './journeyRules.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/podcast/cases.json'), 'utf8'))
const byName = (answers) => Object.fromEntries(cases.map((c, i) => [c.name, answers[i]]))
const { node, python } = both(cases.map((c) => ({ op: 'podcast', ...c })))
const codes = (ps) => ps.map((p) => `${p.level}:${p.code}` + (p.segment ? `@${p.segment}` : '')).sort()
const messages = (ps) => ps.map((p) => p.message).sort()

test('journey.py podcast: every validator case gives its problems, with node and without', () => {
  cases.forEach((c, i) => {
    assert.deepEqual(codes(node[i]), [...c.expect].sort(), `node: ${c.name}`)
    assert.deepEqual(codes(python[i]), [...c.expect].sort(), `python: ${c.name}`)
  })
})

test('journey.py podcast: the same words with node and without (but for a JSON syntax error, which node says more precisely)', () => {
  cases.forEach((c, i) => {
    if (c.name !== 'invalid JSON') assert.deepEqual(messages(python[i]), messages(node[i]), c.name)
  })
  assert.ok(cases.filter((c) => c.name.startsWith('marks:')).length >= 3, 'the marks are among them')
  const said = byName(node.map((ps) => ps.map((p) => p.message)))
  assert.deepEqual(said["a step the journey doesn't have, in three segments: said once, with its segments and times"], ['step "gone" isn\'t in the journey (segments x1–x3, 0:10–0:39): they keep the view before them'])
  assert.deepEqual(said['a beat written as a string'], ['Step 1: beat must be a number, got the string "2"; showing the whole step'])
  assert.ok(said['a duplicate id and an unknown cue'].includes('segment s1: the id "s1" is used twice (0:00 and 0:10)'))
  assert.match(said["narrated in another order than the journey's (steps reordered since)"][0], /^segment a: narrates step 1 \("a"\) after step 3 \("c"\): the journey's steps were reordered since it was recorded/)
  assert.deepEqual(said['recorded for an older commit, steps changed since: a quiet note'], ['Code changed since recording: steps 1, 3'])
})

/** A WAV file of `secs` seconds of silence: 8-bit mono PCM. */
function silentWav(secs, rate = 8000) {
  const data = secs * rate
  const header = Buffer.alloc(44)
  let at = 0
  const text = (s) => { header.write(s, at); at += s.length }
  const u32 = (n) => { header.writeUInt32LE(n, at); at += 4 }
  const u16 = (n) => { header.writeUInt16LE(n, at); at += 2 }
  text('RIFF'); u32(36 + data); text('WAVE')
  text('fmt '); u32(16); u16(1 /* PCM */); u16(1 /* channels */); u32(rate); u32(rate /* bytes a second */); u16(1 /* block */); u16(8 /* bits */)
  text('data'); u32(data)
  return Buffer.concat([header, Buffer.alloc(data, 128)])
}

/** The example shop's place-order journey and the files its steps are on, in a temp folder, with a podcast file
 *  and a 30 s WAV beside it. */
function shop(podcast) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-podcast-'))
  const src = path.join(root, 'examples/shop')
  const journey = JSON.parse(fs.readFileSync(path.join(src, 'journeys/place-order.json'), 'utf8'))
  const files = new Set(['journeys/place-order.json', ...journey.steps.map((s) => s.file), ...journey.nodes.filter((n) => n.at).map((n) => n.at.file)])
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true })
    fs.copyFileSync(path.join(src, f), path.join(d, f))
  }
  fs.writeFileSync(path.join(d, 'journeys/place-order.wav'), silentWav(30))
  fs.writeFileSync(path.join(d, 'journeys/place-order.podcast.json'), typeof podcast === 'string' ? podcast : JSON.stringify(podcast, null, 2))
  return d
}
const run = (d, ...args) => {
  const r = spawnSync('python3', [JPY, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  return { code: r.status, out: r.stdout + r.stderr }
}
const episode = (more = {}) => ({
  version: 1, title: 'Placing an order', journey: { id: 'place-order' }, audio: 'place-order.wav', duration: 30,
  segments: [
    { id: 's1', at: null, cue: 'map', speaker: 'host', text: 'Welcome.', say: 'Welcome!', start: 0, end: 9 },
    { id: 's2', at: { step: 's2xple', beat: 1 }, cue: 'open', speaker: 'host', text: 'First.', start: 9, end: 20 },
    { id: 's3', at: { step: 'ahutu9', beat: 3 }, cue: 'beat', speaker: 'host', text: 'Then.', start: 20, end: 30 },
  ],
  ...more,
})

test('journey.py podcast: a good podcast is ok; the audio length comes from the WAV', () => {
  const r = run(shop(episode()), 'podcast', '.', 'place-order')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ok: podcast of place-order, 0 problems, 0 warnings$/m)
})

test('journey.py podcast: marks are checked against the repository (run from its folder)', () => {
  const d = shop(episode())
  const line3 = fs.readFileSync(path.join(d, 'api/validate.js'), 'utf8').split('\n')[2]
  const ep = episode()
  ep.segments[2].marks = [
    { phrase: 'Then', at: 1, lines: [3, 3], match: line3.trim().slice(0, 8) },
    { phrase: 'Then', at: 1, file: 'api/nope.js', lines: [1, 1] },
  ]
  fs.writeFileSync(path.join(d, 'journeys/place-order.podcast.json'), JSON.stringify(ep, null, 2))
  const r = run(d, 'podcast', '.', 'place-order')
  assert.match(r.out, /segment s3: mark 2: api\/nope\.js isn't in the repository; nothing is lit/)
  assert.match(r.out, /0 problems, 1 warnings?$/m, r.out)
})

test('journey.py podcast: problems and warnings, each on its segment; exit 1 on a problem', () => {
  const p = episode()
  p.segments[1].at = { step: 's2xple', beat: 9 }
  p.segments[2].start = 15
  p.segments.push({ id: 's4', at: { step: 'nope' }, text: '', start: 40, end: 60 })
  let r = run(shop(p), 'podcast', '.', 'place-order')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /WARNING: podcast: Step 1: no beat 9 \(it has 3\); showing the whole step/)
  assert.match(r.out, /WARNING: podcast: segment s3: starts at 0:15, before segment s2 ends \(0:20\)/)
  assert.match(r.out, /WARNING: podcast: step "nope" isn't in the journey \(segment s4, 0:40–1:00\): it keeps the view before it/)
  assert.match(r.out, /WARNING: podcast: segment s4: ends at 1:00, after the episode's "duration" \(0:30\)/)
  assert.match(r.out, /WARNING: podcast: The audio is 0:30 long but the episode is 1:00: the file looks cut off/)
  // `check` runs it too.
  assert.match(run(shop(p), 'check', '.', 'place-order', 'quiet').out, /WARNING: podcast: step "nope" isn't in the journey/)
  r = run(shop(episode({ audio: '../x.wav' })), 'podcast', '.', 'place-order')
  assert.equal(r.code, 1)
  assert.match(r.out, /PROBLEM: podcast: audio must be in the journeys folder \(got \.\.\/x\.wav\)/)
  r = run(shop('{"version": 1, "segments": ['), 'podcast', '.', 'place-order')
  assert.equal(r.code, 1)
  assert.match(r.out, /PROBLEM: podcast: not valid JSON: line 1, column 29/)
  assert.match(run(shop(episode({ segments: [] })), 'podcast', '.', 'place-order').out, /PROBLEM: podcast: "segments" is empty/)
  // The audio's length given by hand.
  assert.match(run(shop(episode()), 'podcast', '.', 'place-order', '25').out, /WARNING: podcast: "duration" says 0:30 but the audio is 0:25 long/)
})
