// Podcast mode: a journey with a podcast file next to it plays in the journey panel, and the walk follows the voice
// (the step's code opens, the animation's beat lights its line); seeking anywhere puts the walk exactly where it is at
// that time, backwards too, the last of quick seeks only; Next while it plays moves the audio; the audio goes on in a
// background tab. The audio is a 40 s tone (test/fixtures/podcast/tone.mp3), so this also proves VS Code's own
// Electron plays mp3 from the workspace and seeks in it. Source: src/podcast/, media/journey-podcast.js.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { sleep, test } from '../helpers'
import { journey, step, writeJourney, writeLines } from '../fixtures'
import { ctx, journeysDir, tour, wsPath } from './context'
import { waiter } from '../helpers'
import { ui } from '../devtools'

/* eslint-disable @typescript-eslint/no-explicit-any */
const pod = () => ctx.api.podcast() as any
/** The suite's wait, printing the podcast's state (and the walk's) on a timeout. */
const until = waiter({ dump: () => ({ podcast: pod(), step: tour().step, map: tour().map, beat: tour().beat, file: codeFile() }) })
const send = (m: object) => ctx.api.mapSend({ type: 'podcastCmd', ...m })
const seek = (to: number) => send({ action: 'seek', to })
const codeEditor = () => vscode.window.visibleTextEditors.find((e) => e.viewColumn !== tour().mapColumn && e.document.uri.scheme === 'file')
const codeFile = () => path.basename(codeEditor()?.document.uri.fsPath ?? '')
/** The line lit by the animation (1-based), 0: none. */
const litLine = () => { const b = tour().beat; return b ? b.line + 1 : 0 }

/** The journey panel's frame (a webview: an iframe in an iframe), over the DevTools connection. */
async function panelFrame(): Promise<import('playwright').Frame> {
  const page = await ui()
  return until('the journey panel\'s frame', async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!(globalThis as any).document.querySelector('.pod'))) return f } catch { /* detached */ } }
    return undefined
  }, 10000)
}

/** The journey "pod" (step 1 and 2 with animations, step 3 without) and its podcast, the tone next to it. */
function writePodJourney() {
  writeLines(wsPath('src', 'pod.ts'), ['export function one() {', '  return 1', '}', 'export function two() {', '  return 2', '}'])
  writeLines(wsPath('src', 'pod2.ts'), ['export const three = 3'])
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'one()', checks: ['a', 'b', 'c'] }]
  const beat = (caption: string, line: number, text: string) => ({ focus: 'svc', caption, code: { file: 'src/pod.ts', line, text } })
  writeJourney(journeysDir(), journey('pod', [
    step('src/pod.ts', 1, 3, { id: 'p1', title: 'one returns 1', scene: { actors, wires: [], beats: [beat('Opens.', 1, 'export function one() {'), beat('Returns.', 2, 'return 1'), beat('Closes.', 3, '}')] } }),
    step('src/pod.ts', 4, 6, { id: 'p2', title: 'two returns 2', scene: { actors, wires: [], beats: [beat('Opens.', 4, 'export function two() {'), beat('Returns.', 5, 'return 2')] } }),
    step('src/pod2.ts', 1, 1, { id: 'p3', title: 'three' }),
  ], { title: 'Pod' }))
  const seg = (id: string, at: unknown, start: number, end: number) => ({ id, at, speaker: 'host', text: `Part ${id}.`, start, end })
  fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), path.join(journeysDir(), 'pod.mp3'))
  fs.writeFileSync(path.join(journeysDir(), 'pod.podcast.json'), JSON.stringify({
    version: 1, title: 'Pod', journey: { id: 'pod' }, audio: 'pod.mp3', duration: 40,
    segments: [
      seg('intro', null, 0, 2.8),
      seg('a1', { step: 'p1', beat: 1 }, 3, 5.8),
      seg('a3', { step: 'p1', beat: 3 }, 6, 8.8),
      seg('b', { step: 'p2' }, 9, 11.8),
      seg('b2', { step: 'p2', beat: 2 }, 12, 14.8),
      seg('c', { step: 'p3' }, 15, 17.8),
      seg('c4', { step: 'p3', beat: 4 }, 18, 20.8), // p3 has no animation: the step only
      seg('outro', null, 21, 39),
    ],
  }))
}

/** The walk at `step` (0: none), the code group on `file`, the animation's line `line` lit (0: none). */
const at = (step: number, file?: string, line = 0) => () =>
  tour().step === step && (!file || codeFile() === file) && litLine() === line && !pod().applying

export const podcastTests = [
  test('podcast: a journey with a podcast file can be played; Play opens the panel and the mp3 plays in VS Code', async () => {
    writePodJourney()
    await until('the podcast is found next to its journey (and not listed as a journey)', () => pod().journeys.includes('pod') && !ctx.api.snapshot().journeys.some((j: any) => /podcast/.test(j.id)), 10000)
    console.log(`    (VS Code window focused: ${vscode.window.state.focused})`)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await until('the panel shows it', () => tour().map === 'pod' && pod().mapVisible, 10000)
    // VS Code's webviews play audio only after a click or key in them: the first Play asks for one, ▶ focused.
    await until('the first Play, from a command: refused until a click in the panel', () => pod().error === 'NotAllowedError' || pod().playing, 10000)
    if (!pod().playing) {
      const f = await panelFrame()
      await until('▶ has the keyboard', async () => (await f.evaluate(() => (globalThis as any).document.activeElement?.className)) === 'pod-b play', 5000)
      assert.match(await f.evaluate(() => (globalThis as any).document.querySelector('.pod-err').textContent), /Space/)
      await f.click('.pod-b.play')
    }
    await until('playing, the time moving', () => pod().playing && pod().t > 0.6, 10000)
    assert.equal(tour().step, 0, 'the intro: no step open')
    assert.match(pod().item, /^\$\(debug-pause\) Intro · 0:0\d$/, `the status bar: ${pod().item}`)
    // The voice reaches step 1: its code opens, the animation lights beat 1's line.
    await until('3 s: step 1 opened on its first beat', at(1, 'pod.ts', 1), 8000)
    assert.match(pod().item, /^\$\(debug-pause\) 1\/3 · /, `the status bar follows: ${pod().item}`)
    // Space for the podcast (Ctrl+' Space): paused, and the walk stays.
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await sleep(500)
    assert.equal(tour().step, 1, 'pausing the podcast does not end the walk')
    assert.match(pod().item, /^\$\(play\) 1\/3 · /)
  }),

  test('podcast: a seek anywhere, forwards or backwards, puts the walk exactly where it is at that time', async () => {
    // [time, step, file, lit line]
    const points: [number, number, string | undefined, number][] = [
      [13, 2, 'pod.ts', 5], // step 2, beat 2
      [4, 1, 'pod.ts', 1], // back across a step
      [16, 3, 'pod2.ts', 0], // a step without animation: nothing lit
      [19, 3, 'pod2.ts', 0], // beat 4 that step doesn't have: the step only
      [7, 1, 'pod.ts', 3], // far back, to beat 3
      [1, 0, undefined, 0], // the intro: the walk ends, the map shows
      [10, 2, 'pod.ts', 0], // step 2 without its animation
      [30, 0, undefined, 0], // the recap
      [6.5, 1, 'pod.ts', 3],
    ]
    for (const [t, n, file, line] of points) {
      await seek(t)
      await until(`seek to ${t}s: the audio there, step ${n}, ${file ?? 'no file'}, line ${line} lit`, () => Math.abs(pod().t - t) < 0.5 && at(n, file, line)(), 8000)
    }
    assert.ok(!pod().playing, 'seeking while paused stays paused')
  }),

  test('podcast: quick seeks (a drag, keys held) move the walk once, to the last one', async () => {
    const before = pod().moves
    for (const t of [13, 4, 16, 1, 19, 10, 7]) { await seek(t); await sleep(30) }
    await until('the last seek wins: step 1, beat 3', at(1, 'pod.ts', 3), 8000)
    await sleep(400)
    assert.ok(at(1, 'pod.ts', 3)(), 'and stays there (no late move from an older seek)')
    assert.ok(pod().moves - before <= 4, `fewer moves than seeks: ${pod().moves - before}`)
  }),

  test('podcast: Next or Previous while it plays moves the audio to that step\'s first part', async () => {
    await seek(4)
    await until('step 1', at(1, 'pod.ts', 1), 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Next: step 2 and the audio at its first part (9 s)', () => tour().step === 2 && pod().t >= 9 && pod().t < 11, 8000)
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('Previous: step 1 and the audio at 3 s', () => tour().step === 1 && pod().t >= 3 && pod().t < 5.5, 8000)
    assert.ok(pod().playing, 'still playing')
    // Back / forward 15 s (Ctrl+' ← →).
    const t0 = pod().t
    await vscode.commands.executeCommand('codeNotes.podcastForward')
    await until('forward 15 s', () => pod().t > t0 + 13, 5000)
    await vscode.commands.executeCommand('codeNotes.podcastBack')
    await until('back 15 s', () => pod().t < t0 + 5, 5000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('podcast: the audio keeps playing, and the walk following it, while the panel is a background tab', async () => {
    await seek(13)
    await until('step 2', at(2, 'pod.ts', 5), 8000)
    // Another editor in the panel's group, in front of it.
    const panelGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(t.input.viewType)))!
    console.log(`    (panel in group ${panelGroup.viewColumn}, tour().mapColumn ${tour().mapColumn})`)
    // Not a file: those the extension moves out of the panel's group. The Settings editor, in front of the panel.
    await vscode.commands.executeCommand(panelGroup.viewColumn === 1 ? 'workbench.action.focusFirstEditorGroup' : 'workbench.action.focusSecondEditorGroup')
    await vscode.commands.executeCommand('workbench.action.openSettings2')
    await until('the panel is hidden', () => !pod().mapVisible)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing while hidden', () => pod().playing, 5000)
    const t0 = pod().t
    await sleep(2500)
    assert.ok(pod().t > t0 + 1.8, `the time moved on while hidden: ${t0} → ${pod().t}`)
    await until('crossing 15 s while hidden: step 3 opened', () => tour().step === 3 && codeFile() === 'pod2.ts', 8000)
    const groups = () => vscode.window.tabGroups.all.map((g) => `${g.viewColumn}:${g.tabs.map((t) => `${t.label}${t.isActive ? '*' : ''}`).join(',')}`).join(' | ')
    assert.ok(!pod().mapVisible, `the panel was not brought back to front: ${groups()}`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  }),

  test('podcast: a long recording: a seek 9 minutes in plays from there (the panel loads the audio in ranges)', async () => {
    // 10 minutes of silence, 8 kHz 8-bit mono WAV (4.8 MB), and a journey of one step for it.
    const secs = 600, rate = 8000
    const wav = Buffer.alloc(44 + secs * rate, 128)
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + secs * rate, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28)
    wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(secs * rate, 40)
    fs.writeFileSync(path.join(journeysDir(), 'podlong.wav'), wav)
    writeJourney(journeysDir(), journey('podlong', [step('src/pod.ts', 1, 3, { id: 'l1' }), step('src/pod2.ts', 1, 1, { id: 'l2' })], { title: 'Pod long' }))
    fs.writeFileSync(path.join(journeysDir(), 'podlong.podcast.json'), JSON.stringify({
      version: 1, title: 'Long', journey: { id: 'podlong' }, audio: 'podlong.wav', duration: secs,
      segments: [{ id: 'a', at: { step: 'l1' }, text: 'a', start: 0, end: 300 }, { id: 'b', at: { step: 'l2' }, text: 'b', start: 300, end: 600 }],
    }))
    await until('its podcast is found', () => pod().journeys.includes('podlong'), 10000)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podlong')
    await until('the panel shows it', () => tour().map === 'podlong', 10000)
    await until('playing (this panel was clicked already)', () => pod().playing && pod().session === 'podlong', 10000)
    await seek(540)
    await until('9 minutes in: step 2, the audio there and going on', () => tour().step === 2 && pod().t > 540.5 && pod().t < 545, 10000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('podcast: closing the panel stops it; the status item goes', async () => {
    await vscode.commands.executeCommand('codeNotes.showMap')
    await until('the panel', () => pod().mapVisible)
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await until('the panel closed: no podcast, no status item', () => !pod().mapVisible && !pod().itemShown && !pod().playing, 5000)
  }),
]
