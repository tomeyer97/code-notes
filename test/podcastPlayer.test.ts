// The podcast player's parts that need no VS Code: the report clock and queue, the camera's rules and settings, and
// the session's stale reports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { MAX_LATE_MS, MIN_LATE_MS, ReportClock, ReportQueue, SKEW_WINDOW_MS, TimeReport } from '../src/podcast/reportClock'
import { afterWait, audioKeptPlaying, LISTEN_DEFAULTS, listenSettingsFrom } from '../src/podcast/cameraRules'
import { Session } from '../src/podcast/session'

const playing = (t: number, sent: number, more: Partial<TimeReport> = {}): TimeReport => ({ t, playing: true, rate: 1, sent, ...more })

test('ReportClock: the quickest report is on time; one that came later is moved on by how late it is', () => {
  const c = new ReportClock()
  // The clocks differ by 5 s: the first report sets what "on time" is.
  assert.equal(c.correct(playing(10, 0), 5000).t, 10)
  // 300 ms later than the quickest: 0.3 s of audio further on (at twice the rate, 0.6 s).
  assert.equal(c.correct(playing(11, 1000), 6300).t, 11.3)
  assert.equal(c.correct(playing(12, 2000, { rate: 2 }), 7300).t, 12.6)
  // A few ms is the channel's jitter: as it is.
  assert.equal(c.correct(playing(13, 3000), 8000 + MIN_LATE_MS).t, 13)
  // A stall is not a delay: never more than MAX_LATE_MS.
  assert.equal(c.correct(playing(14, 4000), 9000 + 60000).t, 14 + MAX_LATE_MS / 1000)
})

test('ReportClock: a seek, a paused report, one without a send time are taken as they are', () => {
  const c = new ReportClock()
  c.correct(playing(1, 0), 0)
  assert.equal(c.correct(playing(2, 0, { seek: true }), 900).t, 2)
  assert.equal(c.correct({ t: 3, playing: false, sent: 0 }, 900).t, 3)
  assert.equal(c.correct({ t: 4, playing: true }, 900).t, 4)
})

test('ReportClock: a clock that jumped is followed within two windows', () => {
  const c = new ReportClock()
  const t0 = 100000
  assert.equal(c.correct(playing(1, t0), t0).t, 1)
  // The sender's clock goes 2 s back: its reports look 2 s late…
  assert.equal(c.correct(playing(2, t0 + 1000 - 2000), t0 + 1000).t, 4)
  // …in the next window too (the one before still saw the old clock)…
  const w1 = t0 + SKEW_WINDOW_MS + 1000
  assert.equal(c.correct(playing(3, w1 - 2000), w1).t, 5)
  // …and on time once both windows saw the new one.
  const w2 = w1 + SKEW_WINDOW_MS + 1000
  assert.equal(c.correct(playing(4, w2 - 2000), w2).t, 4)
})

test('ReportQueue: a run of plain reports applies its newest only; a seek or a change of playing comes as it is', () => {
  const applied: string[] = []
  const later: (() => void)[] = []
  const q = new ReportQueue<string>((shown, m) => applied.push(`${shown}:${m.t}${m.seek ? 's' : ''}${m.playing ? '' : 'p'}`), (f) => later.push(f))
  q.push('a', { t: 1, playing: true }, 0)
  q.push('a', { t: 2, playing: true }, 0)
  q.push('a', { t: 3, playing: true }, 0)
  assert.deepEqual(applied, [], 'held until the turn ends')
  later.shift()!()
  assert.deepEqual(applied, ['a:3'])
  q.push('a', { t: 4, playing: true }, 0)
  q.push('a', { t: 9, playing: true, seek: true }, 0)
  assert.deepEqual(applied, ['a:3', 'a:4', 'a:9s'], 'the run before a seek first, then the seek')
  q.push('a', { t: 9.2, playing: true }, 0)
  q.push('a', { t: 9.3, playing: false }, 0)
  assert.deepEqual(applied, ['a:3', 'a:4', 'a:9s', 'a:9.2'], 'a pause ends the run before it')
  later.forEach((f) => f())
  assert.deepEqual(applied, ['a:3', 'a:4', 'a:9s', 'a:9.2', 'a:9.3p'])
})

test('afterWait: what each way a wait ends leads to', () => {
  assert.deepEqual(afterWait('time'), { resume: true, ownResume: true, resync: false, backOff: false })
  assert.deepEqual(afterWait('release'), { resume: true, ownResume: true, resync: true, backOff: false })
  assert.deepEqual(afterWait('skip'), { resume: true, ownResume: false, resync: true, backOff: false })
  assert.deepEqual(afterWait('abandon'), { resume: true, ownResume: false, resync: true, backOff: true })
  assert.deepEqual(afterWait('cancel'), { resume: false, ownResume: false, resync: false, backOff: false })
})

test('audioKeptPlaying: still playing and moved on since the hold was asked', () => {
  assert.equal(audioKeptPlaying(10, { t: 10.05, playing: true }), false, 'a report in flight')
  assert.equal(audioKeptPlaying(10, { t: 10.3, playing: true }), true)
  assert.equal(audioKeptPlaying(10, { t: 10.3, playing: false }), false)
})

test('listen settings: a number of 0 or more, else the default; the defaults are the ones package.json declares', () => {
  assert.deepEqual(listenSettingsFrom(() => undefined), LISTEN_DEFAULTS)
  assert.deepEqual(listenSettingsFrom((k) => (k === 'readBeforeMove' ? 0 : -1)), { readBeforeMove: 0, settleAfterMove: LISTEN_DEFAULTS.settleAfterMove })
  assert.deepEqual(listenSettingsFrom(() => 'soon'), LISTEN_DEFAULTS)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
  const props: Record<string, { default?: unknown }> = pkg.contributes.configuration.properties
  for (const [key, def] of Object.entries(LISTEN_DEFAULTS)) assert.equal(props[`codeNotes.listen.${key}`]?.default, def, `codeNotes.listen.${key}`)
})

test('Session: after a seek is asked, the reports from before it are stale until one answers', () => {
  const s = new Session()
  s.key = 'j'
  s.asking('seek')
  assert.equal(s.stale('j', { t: 5, playing: true }), true, 'a report from before the seek')
  assert.equal(s.stale('other', { t: 5, playing: true }), false, 'another journey\'s report')
  assert.equal(s.stale('j', { t: 30, playing: true, seek: true }), false, 'the seek answered')
  assert.equal(s.stale('j', { t: 5, playing: true }), false, 'nothing asked any more')
  s.asking('pause')
  assert.equal(s.stale('j', { t: 31, playing: true }), true)
  assert.equal(s.stale('j', { t: 31, playing: false }), false, 'the pause answered')
})

test('Session: where the audio is now, from its last report', () => {
  const s = new Session()
  assert.equal(s.audioNow(7), 7, 'no report: the fallback')
  s.key = 'j'
  s.reported('j', { t: 10, playing: false, rate: 1 }, Date.now())
  assert.equal(s.audioNow(7), 10)
  s.reported('j', { t: 10, playing: true, rate: 2 }, Date.now() - 1000)
  assert.ok(Math.abs(s.audioNow(7) - 12) < 0.1, 'playing at twice the rate for a second')
  s.key = 'other'
  assert.equal(s.audioNow(7), 7, 'another journey\'s report')
})
