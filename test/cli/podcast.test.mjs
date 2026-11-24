// The code-journey skill's `journey.py podcast` (and `check`, which runs it): the same rules as the extension's
// validator (src/core/format/podcast/validate.ts). Every case of test/fixtures/podcast/cases.json, which test/podcastValidate.test.ts
// runs through the extension's, gives the same problems here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JPY } from './helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/podcast/cases.json'), 'utf8'))

test('journey.py podcast: every validator case gives the same problems as the extension', () => {
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('journey', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = []
for c in json.load(sys.stdin):
    ps = m.podcast_problems(c['raw'], c['journey'], c.get('audio'), c.get('audioDuration'), c.get('changed'), c.get('files'))
    out.append(sorted(f"{p['level']}:{p['code']}" + (f"@{p['segment']}" if p['segment'] else '') for p in ps))
print(json.dumps(out))
`
  // No __pycache__ beside the skill's script (it ships as is).
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  const got = JSON.parse(execFileSync('python3', ['-c', py, JPY], { input: JSON.stringify(cases), encoding: 'utf8', env }))
  cases.forEach((c, i) => assert.deepEqual(got[i], [...c.expect].sort(), c.name))
})

test('journey.py podcast: the same words as the extension for a missing step, a string beat, a reused id, the order, the commit', () => {
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('journey', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = {}
for c in json.load(sys.stdin):
    out[c['name']] = [p['message'] for p in m.podcast_problems(c['raw'], c['journey'], c.get('audio'), c.get('audioDuration'), c.get('changed'), c.get('files'))]
print(json.dumps(out))
`
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  const got = JSON.parse(execFileSync('python3', ['-c', py, JPY], { input: JSON.stringify(cases), encoding: 'utf8', env }))
  assert.deepEqual(got["a step the journey doesn't have, in three segments: said once, with its segments and times"], ['step "gone" isn\'t in the journey (segments x1–x3, 0:10–0:39): they keep the view before them'])
  assert.deepEqual(got['a beat written as a string'], ['Step 1: beat must be a number, got the string "2"; showing the whole step'])
  assert.ok(got['a duplicate id and an unknown cue'].includes('segment s1: the id "s1" is used twice (0:00 and 0:10)'))
  assert.match(got["narrated in another order than the journey's (steps reordered since)"][0], /^segment a: narrates step 1 \("a"\) after step 3 \("c"\): the journey's steps were reordered since it was recorded/)
  assert.deepEqual(got['recorded for an older commit, steps changed since: a quiet note'], ['Code changed since recording: steps 1, 3'])
})

test('journey.py podcast: marks are said in the same words as the extension', async () => {
  const { validatePodcast } = await import(path.join(root, 'out/src/core/format/podcast/validate.js'))
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('journey', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = {}
for c in json.load(sys.stdin):
    out[c['name']] = sorted(p['message'] for p in m.podcast_problems(c['raw'], c['journey'], c.get('audio'), c.get('audioDuration'), c.get('changed'), c.get('files')))
print(json.dumps(out))
`
  const marks = cases.filter((c) => c.name.startsWith('marks:'))
  assert.ok(marks.length >= 3)
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  const got = JSON.parse(execFileSync('python3', ['-c', py, JPY], { input: JSON.stringify(marks), encoding: 'utf8', env }))
  for (const c of marks) {
    const files = c.files ? (f) => (f in c.files ? c.files[f] : undefined) : undefined
    const ts = validatePodcast(c.raw, { journey: c.journey, audio: c.audio, audioDuration: c.audioDuration, changed: c.changed, files }).problems.map((p) => p.message).sort()
    assert.deepEqual(got[c.name], ts, c.name)
  }
})

/** The example shop (its place-order journey) in a temp folder, with a podcast file and a 30 s WAV beside it. */
function shop(podcast) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-podcast-'))
  fs.cpSync(path.join(root, 'examples/shop'), d, { recursive: true })
  const secs = 30, rate = 8000
  const wav = Buffer.alloc(44 + secs * rate, 128)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + secs * rate, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28)
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(secs * rate, 40)
  fs.writeFileSync(path.join(d, 'journeys/place-order.wav'), wav)
  fs.writeFileSync(path.join(d, 'journeys/place-order.podcast.json'), typeof podcast === 'string' ? podcast : JSON.stringify(podcast, null, 2))
  return d
}
const run = (d, ...args) => { const r = spawnSync('python3', [JPY, ...args], { cwd: d, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr } }
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
