// Broken podcast files: half-written, unplayable, without their audio, or playable with problems; what the player,
// the Journeys row and the Problems view say. Source: src/core/format/podcast/validate.ts, src/podcast/load.ts,
// diagnostics.ts. Each test watches the workbench console: no error from the extension's pages.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { windowShot } from '../../helpers'
import { ui } from '../../devtools'
import { ctx, journeysDir } from '../context'
import { podcastFile, writePodJourney } from './fixtures'
import { diagnostics, lineOf, noChangeFor, pause, podTest, shots, startPlaying, toggle } from './player'
import { LOAD_MS, MOVE_MS, pod, podUntil, QUICK_MS } from './state'
import { frameOf, panelText, panelVisible } from './webview'

const podFile = () => podcastFile('pod')
const problems = () => diagnostics('pod')

export const brokenFileTests = [
  // A half-written podcast file mid-play keeps the last good version playing, and says so; written in full again,
  // it is read again.
  podTest('broken file › half-written while playing', async () => {
    writePodJourney()
    await startPlaying('pod')
    const good = fs.readFileSync(podFile(), 'utf8')
    // An agent or editor caught mid-write: the file cut off.
    fs.writeFileSync(podFile(), good.slice(0, 120))
    await podUntil('the panel says the file has errors', () => /last good version/.test(pod().notices.pod ?? ''), MOVE_MS)
    const t0 = pod().t
    await podUntil(`still playing (from ${t0})`, () => pod().playing && pod().t > t0 + 0.6, QUICK_MS)
    assert.match(await panelText('.pod-note'), /last good version/)
    const errs = problems()
    assert.equal(errs[0]?.severity, vscode.DiagnosticSeverity.Error, 'an error in the Problems view')
    assert.match(errs[0].message, /not valid JSON: line \d+, column \d+/)
    fs.writeFileSync(podFile(), good)
    await podUntil('the file is good again (the fixture\'s one warning: beat 4 of a step without an animation)', () => pod().notices.pod === '1 problem' && problems().length === 1, MOVE_MS)
    assert.ok(pod().playing, 'it played on throughout')
    await pause()
  }, { consoleClean: true }),

  // A podcast file that can't be played leaves a trace: a greyed ▶ with the reason, "Podcast unavailable" in the
  // panel, Show why; each kind of break its own reason.
  podTest('broken file › unplayable says why', async () => {
    writePodJourney()
    const good = fs.readFileSync(podFile(), 'utf8')
    await startPlaying('pod')
    // Paused (playing, a broken file keeps the last good version).
    await pause()
    fs.writeFileSync(podFile(), good.replace('"version":1', '"version":2'))
    await podUntil('unavailable: version 2', () => /version 2/.test(pod().broken.pod ?? ''), MOVE_MS)
    await podUntil('the status item went with it', () => !pod().itemShown, QUICK_MS)
    const row = ctx.api.journeyRow('pod')!
    assert.match(row.contextValue!, /;podcastBroken/)
    assert.doesNotMatch(row.contextValue!, /;podcast(;|$)/, 'not the ▶ that plays')
    assert.equal(String(row.tooltip).split('\n').filter((l) => /podcast/i.test(l)).join('\n'), 'Podcast unavailable: version 2: this player reads version 1', 'one tooltip line: the reason')
    await podUntil('the panel: one line, "Podcast unavailable", and Show why', async () => /Podcast unavailable/.test(await panelText('.pod-note')) && !(await panelVisible('.pod-tl')), QUICK_MS)
    // The row offers no ▶ (hovered, in the Journeys view): the tooltip and the panel say why.
    await vscode.commands.executeCommand('codeNotes.journeys.focus')
    const page = await ui()
    const rowSel = '.monaco-list-row[aria-label^="Pod,"], .monaco-list-row[aria-label^="Pod "], .monaco-list-row[aria-label="Pod"]'
    await podUntil('the row in the Journeys view', async () => (await page.locator(rowSel).count()) > 0, QUICK_MS)
    await page.locator(rowSel).first().hover()
    await noChangeFor(500, 'a ▶ showing on the hovered row')
    assert.equal(await page.locator(rowSel).first().locator('.actions .codicon-play').count(), 0, 'no ▶ on the row')
    await windowShot('podcast-unavailable', { wait: 300 })
    const before = pod().why
    await (await frameOf('journey')).click('.pod-why')
    await podUntil('Show why: the Problems view', () => pod().why === before + 1, QUICK_MS)
    assert.equal(problems()[0]?.range.start.character, good.indexOf('"version"'), 'the error on the version')
    // Play and Space say why, never nothing.
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await toggle()
    assert.ok(!pod().playing)
    // Invalid JSON, 0 segments: each its own reason.
    fs.writeFileSync(podFile(), good.slice(0, 50))
    await podUntil('unavailable: not JSON', () => /not valid JSON/.test(pod().broken.pod ?? ''), MOVE_MS)
    fs.writeFileSync(podFile(), JSON.stringify({ ...JSON.parse(good), segments: [] }))
    await podUntil('unavailable: segments empty', () => /"segments" is empty/.test(pod().broken.pod ?? ''), MOVE_MS)
    fs.writeFileSync(podFile(), good)
    await podUntil('playable again: the ▶, the player', async () => pod().journeys.includes('pod') && !pod().broken.pod && await panelVisible('.pod-tl'), MOVE_MS)
    assert.match(ctx.api.journeyRow('pod')!.contextValue!, /;podcast$/)
  }, { consoleClean: true }),

  // The audio removed, then put back: the podcast goes and comes back without touching its file.
  podTest('broken file › its audio gone and back', async () => {
    writePodJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('pod'), LOAD_MS)
    const mp3 = path.join(journeysDir(), 'pod.mp3')
    fs.renameSync(mp3, `${mp3}.away`)
    await podUntil('unavailable: the audio isn\'t there', () => /pod\.mp3 isn't there/.test(pod().broken.pod ?? ''), MOVE_MS)
    assert.equal(problems()[0]?.range.start.character, fs.readFileSync(podFile(), 'utf8').indexOf('"audio"'), 'the error on "audio"')
    fs.renameSync(`${mp3}.away`, mp3)
    await podUntil('back: the podcast plays again', () => pod().journeys.includes('pod') && !pod().broken.pod, MOVE_MS)
  }, { consoleClean: true }),

  // What is wrong with a podcast that plays is said in the player, the row and the Problems view: another
  // journey's id, a link to a step that isn't there, an episode longer than its audio.
  podTest('broken file › problems of one that plays', async () => {
    writePodJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('pod'), LOAD_MS)
    const good = fs.readFileSync(podFile(), 'utf8')
    const p = JSON.parse(good)
    p.journey.id = 'podlong'
    p.segments[2].at = { step: 'nope' }
    p.segments.push({ id: 'late', at: null, text: 'late', start: 300, end: 600 })
    p.duration = 600
    fs.writeFileSync(podFile(), JSON.stringify(p, null, 2))
    // The panel loads the 40 s audio and reports its length: the file says 10 minutes.
    // The Problems view says it in plain words; the player's one line counts what it lists.
    await podUntil('the cut-off audio in the Problems view', () => problems().some((d) => /The audio is 0:40 long but the episode is 10:00/.test(d.message)), LOAD_MS)
    await podUntil('the player\'s line: as many problems as the Problems view lists', () => pod().notices.pod === `${problems().length} problems`, QUICK_MS)
    assert.equal(pod().links.pod, 2, 'two steps can\'t be shown as written (the fixture\'s beat 4 of a step without one, and "nope")')
    const beat4 = problems().find((d) => d.code === 'beat')!
    assert.equal(beat4.message, 'Step 3: no beat 4 (it has none); showing the whole step')
    await startPlaying('pod')
    await podUntil('the note in the panel', async () => /^\d+ problems$/.test(await panelText('.pod-note-t')), QUICK_MS)
    await shots('podcast-notice')
    p.segments.pop()
    p.duration = 40
    fs.writeFileSync(podFile(), JSON.stringify(p, null, 2))
    await podUntil('the other journey and the broken link: 3 problems', () => pod().notices.pod === '3 problems' && problems().length === 3, MOVE_MS)
    assert.doesNotMatch(String(ctx.api.journeyRow('pod')!.tooltip), /podcast/i, 'the row\'s tooltip: nothing about a podcast that plays')
    const ws = problems()
    assert.ok(ws.every((d) => d.severity === vscode.DiagnosticSeverity.Warning), 'warnings only')
    const link = ws.find((d) => d.code === 'step')!
    assert.equal(link.range.start.line, lineOf(podFile(), '"step": "nope"'), 'the squiggle on the segment\'s step')
    await toggle()
    await podUntil('paused', () => !pod().playing, QUICK_MS)
    fs.writeFileSync(podFile(), good)
    await podUntil('back to the fixture\'s one warning', () => pod().notices.pod === '1 problem' && problems().length === 1, MOVE_MS)
  }, { consoleClean: true }),

  // An audio that can't be decoded (text named .mp3) is said in the panel, and in the Problems view on the podcast's
  // "audio", as every other problem of a podcast is.
  podTest('broken file › an audio that can\'t be decoded is in the Problems view', async () => {
    writePodJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('pod'), LOAD_MS)
    const good = fs.readFileSync(podFile(), 'utf8')
    const damaged = path.join(journeysDir(), 'pod-damaged.mp3')
    fs.writeFileSync(damaged, 'not audio\n'.repeat(800))
    fs.writeFileSync(podFile(), JSON.stringify({ ...JSON.parse(good), audio: 'pod-damaged.mp3' }, null, 2))
    const isDamaged = (d: vscode.Diagnostic) => /pod-damaged\.mp3 .*looks cut off or damaged/.test(d.message)
    try {
      await podUntil('the podcast reads the other audio', () => pod().journeys.includes('pod') && !problems().some(isDamaged), MOVE_MS)
      await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
      await podUntil('the panel says the audio looks damaged', () => /pod-damaged\.mp3 .*looks cut off or damaged/.test(pod().notices.pod ?? ''), LOAD_MS)
      await podUntil('and the Problems view', () => problems().some(isDamaged), MOVE_MS)
      const d = problems().find(isDamaged)!
      assert.equal(d.range.start.line, lineOf(podFile(), '"audio"'), 'on the podcast\'s "audio"')
      assert.equal(d.severity, vscode.DiagnosticSeverity.Warning, 'a warning')
    } finally {
      fs.writeFileSync(podFile(), good)
      fs.rmSync(damaged, { force: true })
    }
    await podUntil('back to the fixture\'s one warning', () => problems().length === 1 && !problems().some(isDamaged), MOVE_MS)
  }),
]
