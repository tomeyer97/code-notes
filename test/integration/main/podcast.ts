// Listening: a journey with a podcast file next to it plays in the Listen view (the panel's player is its remote, so
// closing the panel never stops it), and the walk follows the voice
// (the step's code opens, the animation's beat lights its line); seeking anywhere puts the walk exactly where it is at
// that time, backwards too, the last of quick seeks only, and the extension is told where the audio really is; Next
// while it plays moves the audio; the audio goes on in a background tab; a step the podcast skips keeps the walk there
// and ▶ goes on after it; each journey's place is kept (another journey, a rewritten podcast file). The audio is a
// 40 s tone (test/fixtures/podcast/tone.mp3), so this also proves VS Code's own Electron plays mp3 from the workspace
// (fetched whole, as a blob) and seeks in it. Source: src/podcast/, media/journey-podcast.js.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { sleep, test, windowShot } from '../helpers'
import { journey, step, writeJourney, writeLines } from '../fixtures'
import { ctx, journeysDir, tour, wsPath } from './context'
import { waiter } from '../helpers'
import { ui } from '../devtools'
import { markTimes, marksAt } from '../../../src/podcast/model'

/* eslint-disable @typescript-eslint/no-explicit-any */
const pod = () => ctx.api.podcast() as any
/** The suite's wait, printing the podcast's state (and the walk's) on a timeout. */
const until = waiter({ dump: () => ({ podcast: pod(), step: tour().step, map: tour().map, beat: tour().beat, file: codeFile() }) })
const send = (m: object) => ctx.api.listenSend({ type: 'podcastCmd', ...m })
const seek = (to: number) => send({ action: 'seek', to })
const codeEditor = () => vscode.window.visibleTextEditors.find((e) => e.viewColumn !== tour().mapColumn && e.document.uri.scheme === 'file')
const codeFile = () => path.basename(codeEditor()?.document.uri.fsPath ?? '')
/** The line lit by the animation (1-based), 0: none. */
const litLine = () => { const b = tour().beat; return b ? b.line + 1 : 0 }

/** The journey panel's frame (a webview: an iframe in an iframe), over the DevTools connection. */
async function panelFrame(): Promise<import('playwright').Frame> {
  const page = await ui()
  return until('the journey panel\'s frame', async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => { const d = (globalThis as any).document; return !!d.querySelector('.pod') && !d.querySelector('.ls-player') })) return f } catch { /* detached */ } }
    return undefined
  }, 10000)
}

/** The Listen view's frame (where the audio is). */
async function listenFrame(): Promise<import('playwright').Frame> {
  const page = await ui()
  return until('the Listen view\'s frame', async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!(globalThis as any).document.querySelector('.ls-player .pod audio'))) return f } catch { /* detached */ } }
    return undefined
  }, 10000)
}

/** What the audio itself says (in the Listen view): its time, paused, the player's note or error. */
async function panelAudio(): Promise<{ t: number; paused: boolean; note: string; blob: boolean }> {
  const f = await listenFrame()
  return f.evaluate(() => {
    const d = (globalThis as any).document
    const a = d.querySelector('.pod audio')
    const e = d.querySelector('.pod-err')
    return { t: a.currentTime, paused: a.paused, note: e.hidden ? '' : e.textContent, blob: a.src.startsWith('blob:') }
  })
}

/** The journey "podgap": three steps, the podcast says nothing about step 2 (its own copy of the tone). */
function writeGapJourney(g3start = 9) {
  writeJourney(journeysDir(), journey('podgap', [
    step('src/pod.ts', 1, 3, { id: 'g1', title: 'one' }),
    step('src/pod.ts', 4, 6, { id: 'g2', title: 'two, not in the podcast' }),
    step('src/pod2.ts', 1, 1, { id: 'g3', title: 'three' }),
  ], { title: 'Pod gap' }))
  fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), path.join(journeysDir(), 'podgap.mp3'))
  writeGapPodcast(g3start)
}
function writeGapPodcast(g3start: number) {
  const seg = (id: string, at: unknown, start: number, end: number) => ({ id, at, speaker: 'host', text: `Part ${id}.`, start, end })
  fs.writeFileSync(path.join(journeysDir(), 'podgap.podcast.json'), JSON.stringify({
    version: 1, title: 'Pod gap', journey: { id: 'podgap' }, audio: 'podgap.mp3', duration: 40,
    segments: [seg('intro', null, 0, 2.8), seg('g1', { step: 'g1' }, 3, g3start - 0.2), seg('g3', { step: 'g3' }, g3start, 20), seg('outro', null, 21, 39)],
  }))
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

/** The journey "podauto": one step, a podcast that never leaves the map (all its parts on no step). */
function writeAutoJourney() {
  writeLines(wsPath('src', 'auto.ts'), ['export const auto = 1'])
  writeJourney(journeysDir(), journey('podauto', [step('src/auto.ts', 1, 1, { id: 'u1', title: 'auto' })], { title: 'Pod auto' }))
  fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), path.join(journeysDir(), 'podauto.mp3'))
  fs.writeFileSync(path.join(journeysDir(), 'podauto.podcast.json'), JSON.stringify({
    version: 1, title: 'Pod auto', journey: { id: 'podauto' }, audio: 'podauto.mp3', duration: 40,
    segments: [{ id: 'a', at: null, speaker: 'host', text: 'All on the map.', start: 0, end: 39 }],
  }))
}

/**
 * The webviews' frames (the frame inside each webview's iframe) and where their iframes are, found without running
 * anything inside a webview: a script the test runs in a page (Playwright's evaluate) counts there as a click.
 */
async function webviewFrames(): Promise<{ f: import('playwright').Frame; x: number; h: number }[]> {
  const out: { f: import('playwright').Frame; x: number; h: number }[] = []
  for (const f of (await ui()).frames()) {
    const outer = f.parentFrame()
    if (!outer || !outer.parentFrame()) continue
    const b = await (await outer.frameElement()).boundingBox().catch(() => null)
    if (b && b.height > 50) out.push({ f, x: b.x, h: b.height })
  }
  return out
}
/** The journey panel's frame: the webview in the editor area (the side bar's are left of it). */
async function panelFrameQuiet(): Promise<import('playwright').Frame> {
  const editor = await (await ui()).locator('.part.editor').boundingBox()
  return until('the journey panel\'s frame', async () => (await webviewFrames()).find((w) => w.x >= editor!.x - 1)?.f, 10000)
}
/** A real click (the mouse, through the window) on `sel` in frame `f`; its place is read 5.5 s before, so the
 *  reading's own activation is over by the click. */
async function realClick(f: import('playwright').Frame, sel: string): Promise<void> {
  const b = await f.locator(sel).boundingBox()
  assert.ok(b, `${sel} on screen`)
  await sleep(5500)
  await (await ui()).mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}
/** The audio in frame `f` plays: its own clock moves. */
async function audioMoves(f: import('playwright').Frame, what: string): Promise<void> {
  const t = () => f.evaluate(() => { const a = (globalThis as any).document.querySelector('.pod audio'); return a && a.getAttribute('src') ? a.currentTime : -1 })
  const t0 = await t()
  await sleep(1200)
  const t1 = await t()
  assert.ok(t0 >= 0 && t1 > t0 + 0.6, `${what}: the audio's clock moves (${t0} → ${t1})`)
}

export const podcastTests = [
  test('podcast: ▶ starts the sound wherever it was pressed, with no click in the Listen view first', async () => {
    // VS Code lets a webview's audio play only after a click or a key in that webview (a click in the workbench or in
    // another webview does not count). Nothing here has been clicked yet.
    await cameraWaits(0, 0)
    writeAutoJourney()
    await until('the podcast is found', () => pod().journeys.includes('podauto'), 10000)
    if (pod().mapVisible) await closePanel()
    assert.deepEqual(pod().unlocked, { listen: false, panel: false }, 'no click in either player yet')

    // 1. From a command (a Journeys row's ▶ Listen, the palette, the key): no webview may play yet. The audio goes to
    // the panel that opens, paused there, the panel and its ▶ take the keyboard: Space plays it. No hint text.
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podauto')
    await until('refused in the Listen view: in the panel, paused, the panel focused', () => pod().hostIn === 'panel' && !pod().playing && pod().mapVisible && pod().error === 'NotAllowedError', 10000)
    const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input
    await until('the panel is the active editor', () => tab() instanceof vscode.TabInputWebview && /codeNotes\.journey/.test((tab() as vscode.TabInputWebview).viewType), 5000)
    await sleep(800) // the focus inside the panel settles (▶)
    await (await ui()).keyboard.press('Space')
    await until('Space in the panel: playing', () => pod().playing && pod().t > 0.5, 8000)
    const pf = await panelFrameQuiet()
    await audioMoves(pf, 'played in the panel')
    assert.equal(await pf.evaluate(() => { const e = (globalThis as any).document.querySelector('.pod-err'); return e.hidden ? '' : e.textContent }), '', 'no hint or error line')
    assert.ok(pod().unlocked.panel && !pod().unlocked.listen, `the panel unlocked, the Listen view not: ${JSON.stringify(pod().unlocked)}`)

    // 2. Closing the panel: the audio goes to the Listen view, which may not play yet: it waits there, paused, where
    // it was (the one start that still needs a click: the status item or ▶ opens the panel again).
    const tClose = pod().t
    await closePanel()
    await until('back in the Listen view, paused there', () => pod().hostIn === 'listen' && !pod().playing && pod().hostAlive, 8000)
    assert.ok(Math.abs(pod().t - tClose) < 2, `kept its place: ${tClose} → ${pod().t}`)

    // 3. A new panel (its audio locked too): one real click on its ▶ plays, there.
    await vscode.commands.executeCommand('codeNotes.podcastOpen')
    await until('the panel shows it', () => tour().map === 'podauto' && pod().mapVisible, 10000)
    assert.ok(!pod().unlocked.panel, 'a new panel: its audio locked')
    const pf2 = await panelFrameQuiet()
    await realClick(pf2, '.pod-b.play')
    await until('the click on the panel\'s ▶: playing in the panel', () => pod().playing && pod().hostIn === 'panel', 8000)
    await audioMoves(pf2, 'the panel\'s ▶')
    assert.ok(Math.abs(pod().t - tClose) < 4, `on from where it was: ${tClose} → ${pod().t}`)

    // 4. Then a start from a command plays at once (the panel's audio may play now).
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podauto')
    await until('a command plays at once', () => pod().playing, 4000)
    await audioMoves(pf2, 'started by a command')

    // 5. One click in the Listen view (its ▶, a remote now: it pauses) unlocks it for the window: the panel closing
    // then hands it the audio, and later starts play there with no click.
    const lf = await listenFrame()
    await realClick(lf, '.pod-b.play')
    await until('the Listen view\'s ▶ paused it; the Listen view unlocked', () => !pod().playing && pod().unlocked.listen, 8000)
    await closePanel()
    await until('the audio back in the Listen view', () => pod().hostIn === 'listen' && pod().hostAlive, 8000)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podauto')
    await until('a command plays in the Listen view at once', () => pod().playing && pod().hostIn === 'listen', 6000)
    await audioMoves(await listenFrame(), 'in the Listen view')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('podcast: a journey with a podcast file can be played; Play opens the panel and the mp3 plays in VS Code', async () => {
    // The walk's own timing is tested with the camera's waits off; the camera tests (at the end) turn them on.
    await cameraWaits(0, 0)
    writePodJourney()
    await until('the podcast is found next to its journey (and not listed as a journey)', () => pod().journeys.includes('pod') && !ctx.api.snapshot().journeys.some((j: any) => /podcast/.test(j.id)), 10000)
    console.log(`    (VS Code window focused: ${vscode.window.state.focused})`)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await until('the panel shows it', () => tour().map === 'pod' && pod().mapVisible, 10000)
    await until('the Listen view has its audio', () => pod().hostAlive && pod().hostKey !== undefined, 10000)
    // The Listen view was clicked once (the test before): it plays at once.
    await until('playing, the time moving', () => pod().playing && pod().t > 0.6, 10000)
    assert.equal(tour().step, 0, 'the intro: no step open')
    assert.match(pod().item, /^\$\(unmute\) Listening · Intro · 0:0\d$/, `the status bar: ${pod().item}`)
    // The voice reaches step 1: its code opens, the animation lights beat 1's line.
    await until('3 s: step 1 opened on its first beat', at(1, 'pod.ts', 1), 8000)
    await windowShot('podcast-playing', { wait: 300 })
    assert.match(pod().item, /^\$\(unmute\) Listening · 0:0\d$/, `the status bar: the time (the walk's item beside it says 1/3): ${pod().item}`)
    // Space for the podcast (Ctrl+' Space): paused, and the walk stays.
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await sleep(500)
    assert.equal(tour().step, 1, 'pausing the podcast does not end the walk')
    assert.match(pod().item, /^\$\(debug-pause\) Paused · 0:0\d$/, `paused: ${pod().item}`)
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
      // What the extension (and the status bar) has is what the audio itself says.
      const a = await panelAudio()
      assert.ok(Math.abs(a.t - t) < 0.5 && Math.abs(a.t - pod().t) < 0.5, `seek to ${t}s: the audio says ${a.t}, the extension has ${pod().t}`)
    }
    assert.ok((await panelAudio()).blob, 'the audio was loaded whole (a blob)')
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
    await seek(19)
    await until('step 3', at(3, 'pod2.ts', 0), 8000)
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
    // (Step 3's 6 s in pod2.ts are held from step 2 while playing, VIEW_HOLD_S: the recap, 19 s, is not.)
    await until('crossing 21 s while hidden: the recap, the walk ended', () => tour().step === 0 && pod().t > 21, 8000)
    const groups = () => vscode.window.tabGroups.all.map((g) => `${g.viewColumn}:${g.tabs.map((t) => `${t.label}${t.isActive ? '*' : ''}`).join(',')}`).join(' | ')
    assert.ok(!pod().mapVisible, `the panel was not brought back to front: ${groups()}`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  }),

  test('podcast: a long recording: a seek 9 minutes in plays from there', async () => {
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

  test('podcast: Next onto a step the podcast skips: the walk stays there, the audio pauses and says so; ▶ goes on after it', async () => {
    writeGapJourney()
    await until('its podcast is found', () => pod().journeys.includes('podgap'), 10000)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podgap')
    await until('playing podgap', () => pod().playing && pod().session === 'podgap', 10000)
    await seek(4)
    await until('step 1', () => tour().step === 1 && pod().t >= 4, 8000)
    // Playing, Next is the player's ⏭ (one transport): the next part, step 3. Paused, it is the walk's Next.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('playing: Next is ⏭, step 3 at 9 s', () => tour().step === 3 && pod().t >= 9 && pod().playing, 8000)
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('⏮: step 1 again', () => tour().step === 1 && pod().t < 9, 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Next: step 2, the audio paused', () => tour().step === 2 && !pod().playing, 5000)
    await sleep(1200)
    assert.equal(tour().step, 2, 'the walk stays on step 2 (no late report takes it back)')
    assert.ok(!pod().playing, 'still paused')
    assert.match((await panelAudio()).note, /isn't in the podcast/)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('▶: on after step 2, at step 3\'s part (9 s), not back to step 1', () => pod().playing && tour().step === 3 && pod().t >= 9 && pod().t < 12, 8000)
    assert.equal((await panelAudio()).note, '', 'the note went once it played on')
  }),

  test('podcast: the podcast file rewritten: the same moment of the same part, still playing; walk and audio agree', async () => {
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    const t0 = pod().t
    // Step 3's part now starts 2 s earlier: the same place in it is 2 s earlier.
    writeGapPodcast(7)
    await until(`the time follows its part: ${(t0 - 2).toFixed(1)}`, () => Math.abs(pod().t - (t0 - 2)) < 0.3, 8000)
    const a = await panelAudio()
    assert.ok(Math.abs(a.t - (t0 - 2)) < 0.3, `the audio is there too: ${a.t}`)
    assert.equal(tour().step, 3, 'the walk stays on step 3')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    writeGapPodcast(9)
    await sleep(1500)
    assert.ok(pod().playing && (await panelAudio()).paused === false, 'rewritten while playing: it plays on')
    assert.equal(tour().step, 3, 'still step 3')
    assert.ok(pod().t >= 9, `the same moment, moved back with its part: ${pod().t}`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('podcast: each journey\'s place is kept: another journey, then ▶ goes on where it was', async () => {
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await until('pod in the panel, playing', () => pod().session === 'pod' && pod().playing, 10000)
    await seek(13)
    await until('step 2', () => tour().step === 2 && pod().t >= 13, 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    const kept = pod().t
    // Another journey: the walk leaves pod.
    await vscode.commands.executeCommand('codeNotes.startJourney', 'podgap')
    await until('walking podgap', () => tour().journey === 'podgap' || tour().map === 'podgap', 8000)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await until(`▶ pod: on from ${kept.toFixed(1)}, step 2 (not 0:00)`, () => pod().session === 'pod' && pod().playing && pod().t >= kept - 0.3 && pod().t < kept + 3 && tour().step === 2, 10000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('podcast: the intro closes the walk\'s code tab; a seek onto a beat in another file opens that file, never the step\'s first', async () => {
    const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'one()', checks: ['a'] }]
    writeJourney(journeysDir(), journey('podbeat', [
      step('src/pod.ts', 1, 3, { id: 'b1', title: 'one', scene: { actors, wires: [], beats: [
        { focus: 'svc', caption: 'Here.', code: { file: 'src/pod.ts', line: 2, text: 'return 1' } },
        { focus: 'svc', caption: 'There.', code: { file: 'src/pod2.ts', line: 1, text: 'export const three = 3' } },
      ] } }),
    ], { title: 'Pod beat' }))
    fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), path.join(journeysDir(), 'podbeat.mp3'))
    const seg = (id: string, at: unknown, start: number, end: number) => ({ id, at, speaker: 'host', text: id, start, end })
    fs.writeFileSync(path.join(journeysDir(), 'podbeat.podcast.json'), JSON.stringify({
      version: 1, title: 'Pod beat', journey: { id: 'podbeat' }, audio: 'podbeat.mp3', duration: 40,
      segments: [seg('intro', null, 0, 2.8), seg('here', { step: 'b1', beat: 1 }, 3, 5.8), seg('there', { step: 'b1', beat: 2 }, 6, 20), seg('outro', null, 21, 39)],
    }))
    await until('its podcast is found', () => pod().journeys.includes('podbeat'), 10000)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podbeat')
    await until('playing podbeat', () => pod().playing && pod().session === 'podbeat', 10000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(4)
    await until('step 1, beat 1: pod.ts line 2 lit', at(1, 'pod.ts', 2), 8000)
    const walkTabs = () => vscode.window.tabGroups.all.filter((g) => g.viewColumn !== tour().mapColumn).flatMap((g) => g.tabs)
      .filter((t) => t.isPreview && t.input instanceof vscode.TabInputText && /pod2?\.ts$/.test(t.input.uri.path)).map((t) => t.label)
    assert.ok(walkTabs().length > 0, 'the walk opened its code in a preview tab')
    await seek(1)
    await until('the intro: no step, the walk\'s preview tab closed', () => tour().step === 0 && !pod().applying && walkTabs().length === 0, 8000)
    // Every file the code group shows from here on.
    const shown: string[] = []
    const note = (u: vscode.Uri) => { if (u.scheme === 'file') shown.push(path.basename(u.fsPath)) }
    const subs = [
      vscode.window.onDidChangeVisibleTextEditors((es) => { for (const e of es) if (e.viewColumn !== tour().mapColumn) note(e.document.uri) }),
      vscode.window.tabGroups.onDidChangeTabs((e) => { for (const t of [...e.opened, ...e.changed]) if (t.input instanceof vscode.TabInputText) note(t.input.uri) }),
    ]
    const sub = { dispose: () => subs.forEach((x) => x.dispose()) }
    try {
      await seek(7)
      await until('step 1, beat 2: pod2.ts line 1 lit', at(1, 'pod2.ts', 1), 8000)
      await sleep(300)
    } finally { sub.dispose() }
    assert.ok(!shown.includes('pod.ts'), `the step's own file was never shown first: ${shown.join(' → ')}`)
  }),

  test('podcast: closing the panel keeps it playing; the status item opens the map again, its player where the audio is', async () => {
    await vscode.commands.executeCommand('codeNotes.showMap')
    await until('the panel', () => pod().mapVisible)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing, 5000)
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await until('the panel closed', () => !pod().mapVisible && tour().map === undefined, 5000)
    const t0 = pod().t
    await sleep(1500)
    assert.ok(pod().playing && pod().t > t0 + 0.8, `still playing without the panel: ${t0} → ${pod().t}`)
    assert.ok(pod().itemShown && /Listening/.test(pod().item), `the status item stays: ${pod().item}`)
    assert.equal((await panelAudio()).paused, false, 'the audio itself plays on')
    // The status item's click: the map again, its player showing the audio's time and that it plays.
    await vscode.commands.executeCommand('codeNotes.podcastOpen')
    await until('the map back', () => pod().mapVisible, 8000)
    const f = await panelFrame()
    await until('the panel\'s player shows it playing, at the audio\'s time', async () => {
      const s = await f.evaluate(() => { const d = (globalThis as any).document; return { on: d.querySelector('.pod-b.play')?.dataset.on, time: d.querySelector('.pod-now')?.textContent } })
      const [m, sec] = String(s.time ?? '0:0').split(':').map(Number)
      return s.on === 'true' && Math.abs(m * 60 + sec - pod().t) <= 1.5
    }, 8000)
    // The panel's ▶ pauses the audio in the Listen view.
    await f.click('.pod-b.play')
    await until('paused from the panel', () => !pod().playing, 5000)
  }),

  // ---------- broken podcast files (src/podcast/validate.ts, load.ts) ----------

  test('podcast: a half-written podcast file mid-play keeps the last good version playing, and says so', async () => {
    watchConsole()
    await playPod()
    const good = fs.readFileSync(podFile(), 'utf8')
    // An agent or editor caught mid-write: the file cut off.
    fs.writeFileSync(podFile(), good.slice(0, 120))
    await until('the panel says the file has errors', () => /last good version/.test(pod().notices.pod ?? ''), 8000)
    const t0 = pod().t
    await sleep(1200)
    assert.ok(pod().playing && pod().t > t0 + 0.6, `still playing: ${t0} → ${pod().t}`)
    assert.match(pod().item, /\$\(warning\)/, `the status item says it: ${pod().item}`)
    assert.match(await panelText('.pod-note'), /last good version/)
    const errs = diagnostics()
    assert.equal(errs[0]?.severity, vscode.DiagnosticSeverity.Error, 'an error in the Problems view')
    assert.match(errs[0].message, /not valid JSON: line \d+, column \d+/)
    // Written in full again: read again, nothing to say.
    fs.writeFileSync(podFile(), good)
    await until('the file is good again (the fixture\'s one warning: beat 4 of a step without an animation)', () => pod().notices.pod === "1 part can't be shown" && diagnostics().length === 1, 8000)
    assert.ok(pod().playing, 'it played on throughout')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('podcast: a podcast file that can\'t be played leaves a trace: a greyed ▶ with the reason, "Podcast unavailable" in the panel', async () => {
    const good = fs.readFileSync(podFile(), 'utf8')
    await playPod()
    // Paused (playing, a broken file keeps the last good version: the test before).
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    fs.writeFileSync(podFile(), good.replace('"version":1', '"version":2'))
    await until('unavailable: version 2', () => /version 2/.test(pod().broken.pod ?? ''), 8000)
    await until('the status item went with it', () => !pod().itemShown, 5000)
    const row = ctx.api.journeyRow('pod')!
    assert.match(row.contextValue!, /;podcastBroken/, 'the greyed ▶')
    assert.doesNotMatch(row.contextValue!, /;podcast(;|$)/, 'not the ▶ that plays')
    assert.match(row.tooltip!, /Podcast unavailable: version 2: this player reads version 1/)
    await until('the panel: one line, "Podcast unavailable", and Show why', async () => /Podcast unavailable/.test(await panelText('.pod-note')) && !(await panelVisible('.pod-tl')), 5000)
    // The row's ▶ is there, greyed (disabled): hovered, in the Journeys view.
    await vscode.commands.executeCommand('codeNotes.journeys.focus')
    const page = await ui()
    const rowSel = '.monaco-list-row[aria-label^="Pod,"], .monaco-list-row[aria-label^="Pod "], .monaco-list-row[aria-label="Pod"]'
    await until('the row in the Journeys view', async () => (await page.locator(rowSel).count()) > 0, 5000)
    await page.locator(rowSel).first().hover()
    const play = await until('its greyed ▶', async () => page.locator(rowSel).first().evaluate((r) => {
      const a = r.querySelector('.actions .codicon-play')?.closest('.action-label')
      return a ? { disabled: a.classList.contains('disabled') || a.getAttribute('aria-disabled') === 'true', title: a.getAttribute('aria-label') ?? '' } : undefined
    }), 5000)
    assert.ok(play.disabled, `the ▶ is disabled: ${JSON.stringify(play)}`)
    await windowShot('podcast-unavailable', { wait: 300 })
    const before = pod().why
    await (await panelFrame()).click('.pod-why')
    await until('Show why: the Problems view', () => pod().why === before + 1, 5000)
    assert.equal(diagnostics()[0]?.range.start.character, good.indexOf('"version"'), 'the error on the version')
    // Play and Space say why, never nothing.
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    assert.ok(!pod().playing)
    // Invalid JSON, 0 segments: each its own reason.
    fs.writeFileSync(podFile(), good.slice(0, 50))
    await until('unavailable: not JSON', () => /not valid JSON/.test(pod().broken.pod ?? ''), 8000)
    fs.writeFileSync(podFile(), JSON.stringify({ ...JSON.parse(good), segments: [] }))
    await until('unavailable: segments empty', () => /"segments" is empty/.test(pod().broken.pod ?? ''), 8000)
    fs.writeFileSync(podFile(), good)
    await until('playable again: the ▶, the player', async () => pod().journeys.includes('pod') && !pod().broken.pod && await panelVisible('.pod-tl'), 8000)
    assert.match(ctx.api.journeyRow('pod')!.contextValue!, /;podcast$/)
  }),

  test('podcast: the audio removed, then put back: the podcast goes and comes back without touching its file', async () => {
    const mp3 = path.join(journeysDir(), 'pod.mp3')
    fs.renameSync(mp3, `${mp3}.away`)
    await until('unavailable: the audio isn\'t there', () => /pod\.mp3 isn't there/.test(pod().broken.pod ?? ''), 8000)
    assert.equal(diagnostics()[0]?.range.start.character, fs.readFileSync(podFile(), 'utf8').indexOf('"audio"'), 'the error on "audio"')
    fs.renameSync(`${mp3}.away`, mp3)
    await until('back: the podcast plays again', () => pod().journeys.includes('pod') && !pod().broken.pod, 8000)
  }),

  test('podcast: what is wrong with one that plays is said in the player, the row and the Problems view', async () => {
    const good = fs.readFileSync(podFile(), 'utf8')
    const p = JSON.parse(good)
    p.journey.id = 'podlong'
    p.segments[2].at = { step: 'nope' }
    p.segments.push({ id: 'late', at: null, text: 'late', start: 300, end: 600 })
    p.duration = 600
    fs.writeFileSync(podFile(), JSON.stringify(p, null, 2))
    // The panel loads the 40 s audio and reports its length: the file says 10 minutes.
    await until('the player says it in plain words', () => /The audio is 0:40 long but the episode is 10:00/.test(pod().notices.pod ?? ''), 10000)
    assert.equal(pod().links.pod, 2, 'two parts can\'t be shown (the fixture\'s beat 4 of a step without one, and "nope")')
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await until('the note in the panel', async () => /The audio is 0:40 long/.test(await panelText('.pod-note')), 5000)
    p.segments.pop()
    p.duration = 40
    fs.writeFileSync(podFile(), JSON.stringify(p, null, 2))
    await until('the other journey and the broken link', () => pod().notices.pod === 'Written for “Pod long” · 2 parts can\'t be shown', 8000)
    assert.match(ctx.api.journeyRow('pod')!.tooltip!, /Podcast: Written for “Pod long” · 2 parts can't be shown/)
    const ws = diagnostics()
    assert.ok(ws.every((d) => d.severity === vscode.DiagnosticSeverity.Warning), 'warnings only')
    const link = ws.find((d) => d.code === 'step')!
    assert.equal(link.range.start.line, lineOf(podFile(), '"step": "nope"'), 'the squiggle on the segment\'s step')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing, 5000)
    fs.writeFileSync(podFile(), good)
    await until('back to the fixture\'s one warning', () => pod().notices.pod === "1 part can't be shown" && diagnostics().length === 1, 8000)
    const errors = consoleErrors()
    assert.deepEqual(errors, [], `console errors from the extension's panel:\n${errors.join('\n')}`)
  }),

  // ---------- the editor while it plays (src/podcast/player.ts, follow.ts; src/tour/walk.ts, card.ts, panelLayout.ts) ----------

  test('listening: the one-line card with one transport, the follow lock, a view held at least 8 s', async () => {
    watchConsole()
    writeListenJourney()
    await until('its podcast is found', () => pod().journeys.includes('podlisten'), 10000)
    await closeAllButPanel()
    await playIt('podlisten')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(4.5)
    await until('step 1, listen.ts line 12 lit', at(1, 'listen.ts', 12), 8000)
    // Paused: the full card, with ▶.
    await until('the full card, ▶ Play on it', () => /▶ Play/.test(tour().card?.body ?? '') && /codeNotes\.askStep/.test(tour().card?.body ?? ''), 5000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    // Playing: one line: ⏸, narrating, the beat, the player's ⏮ ⏭ (the card's own Ask, More go).
    await until('the one-line card', () => /narrating · beat 1\/4/.test(tour().card?.body ?? ''), 5000)
    const body = tour().card!.body as string
    assert.match(body, /codeNotes\.podcastToggle/)
    assert.match(body, /⏮.*codeNotes\.previousStep/)
    assert.match(body, /⏭.*codeNotes\.nextStep/)
    assert.doesNotMatch(body, /codeNotes\.askStep|Follow along/)
    assert.equal(tour().card!.label, '1/3 · listen one', 'the header line stays')
    // The reader scrolls away on their own (well after the walk's own move).
    await sleep(1700)
    const ed = codeEditor()!
    ed.revealRange(new vscode.Range(185, 0, 185, 0), vscode.TextEditorRevealType.AtTop)
    await until('not following: the card says Follow along', () => pod().follow === false && /Follow along/.test(tour().card?.body ?? ''), 5000)
    const top = () => codeEditor()!.visibleRanges[0].start.line
    const away = top()
    assert.ok(away >= 170, `scrolled: ${away}`)
    // Beat 2 (line 150, same file) at 12 s: lit, but the editor isn't moved.
    await until('beat 2 lit at line 150', () => litLine() === 150, 12000)
    await sleep(500)
    const onScreen = codeEditor()!.visibleRanges.some((r) => r.contains(new vscode.Position(149, 0)))
    assert.ok(Math.abs(top() - away) <= 3 && !onScreen, `the editor stayed where the reader is (${away} → ${top()}, ${codeFile()}, follow ${pod().follow})`)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    await until('Follow along: back at line 150', () => pod().follow === true && codeEditor()!.visibleRanges.some((r) => r.contains(new vscode.Position(149, 0))), 5000)
    // The view hold: beat 3 (20–23 s) is in listen2.ts for 3 s: held; step 2 at 23 s is listen.ts again.
    const shown: string[] = []
    const sub = vscode.window.onDidChangeVisibleTextEditors((es) => { for (const e of es) if (e.viewColumn !== tour().mapColumn && e.document.uri.scheme === 'file') shown.push(path.basename(e.document.uri.fsPath)) })
    try {
      await until('step 2 at 23 s', () => tour().step === 2 && pod().t >= 23, 15000)
    } finally { sub.dispose() }
    assert.ok(!shown.includes('listen2.ts'), `a 3 s part in another file was held: ${shown.join(' → ')}`)
    assert.equal(codeFile(), 'listen.ts')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    // A seek shows its time exactly, held or not.
    await seek(21)
    await until('seek to 21 s: beat 3 in listen2.ts', at(1, 'listen2.ts', 1), 8000)
  }),

  test('listening: the map\'s moments give the map the editor; the code comes back in one group beside it, never on a draft', async () => {
    await seek(1)
    await until('the intro: no step, only the panel\'s group', () => tour().step === 0 && !pod().applying && vscode.window.tabGroups.all.length === 1, 8000)
    const layout = await editorLayout()
    assert.equal(layout.length, 1, 'the map has the editor area')
    await seek(5)
    await until('step 1: the code beside the panel', () => tour().step === 1 && codeFile() === 'listen.ts' && vscode.window.tabGroups.all.length === 2, 8000)
    await sleep(500)
    const two = await editorLayout()
    const share = two[tour().mapColumn! - 1] / two.reduce((a, b) => a + b, 0)
    assert.ok(share > 0.2 && share < 0.5, `the panel at the walk's width again: ${share}`)
    // A draft of the reader's in a group of its own.
    const draft = await vscode.workspace.openTextDocument({ content: 'my notes while listening' })
    await vscode.window.showTextDocument(draft, { viewColumn: vscode.window.tabGroups.all.length + 1, preview: false, preserveFocus: true })
    const draftGroup = () => vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === draft.uri.toString()))
    await seek(1)
    await until('the intro again: the walk\'s code closed', () => tour().step === 0 && !pod().applying && !groupsShowing('listen.ts').length, 8000)
    await seek(5)
    await until('step 1 again', () => tour().step === 1 && !pod().applying && groupsShowing('listen.ts').length === 1, 8000)
    await sleep(400)
    assert.ok(!draftGroup()!.tabs.some((t) => t.input instanceof vscode.TabInputText && /listen\.ts$/.test(t.input.uri.path)), 'never in the draft\'s group')
    assert.equal(groupsShowing('listen.ts').length, 1, 'in one group only')
    // The draft put away (not saved).
    await vscode.window.showTextDocument(draft, { viewColumn: draftGroup()!.viewColumn, preserveFocus: false })
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
    await until('the draft closed', () => !draftGroup(), 5000)
  }),

  test('listening: focusing the panel, ‹ Journeys and the row of the journey you\'re in change no width and keep it playing; Ctrl+\' V makes room for the map', async () => {
    await until('two groups', () => vscode.window.tabGroups.all.length === 2, 5000)
    // The panel dragged down to VS Code's minimum (220 px): focusing a group that narrow made VS Code expand it.
    const panelAt = () => tour().mapColumn! - 1
    // Two groups side by side, nothing else (the draft's group, empty, may linger in the layout).
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] })
    await until('two groups in the layout', async () => (await editorLayout()).length === 2, 5000)
    const start = await editorLayout()
    const total = start.reduce((a, b) => a + b, 0)
    const sized = (px: number) => ({ orientation: 0, groups: start.map((_, i) => ({ size: i === panelAt() ? px / total : 1 - px / total })) })
    await vscode.commands.executeCommand('vscode.setEditorLayout', sized(400))
    await sleep(800)
    await vscode.commands.executeCommand('vscode.setEditorLayout', sized(150))
    await until('the panel at the minimum', async () => (await editorLayout())[panelAt()] <= 221, 5000)
    await sleep(1000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    const before = await editorLayout()
    const same = async (what: string) => {
      await sleep(700)
      const now = await editorLayout()
      assert.equal(now.length, before.length, `${what}: the groups`)
      now.forEach((w, i) => assert.ok(Math.abs(w - before[i]) <= 2, `${what}: group ${i + 1} was ${before[i]} px, now ${w} px`))
    }
    const focusPanel = ['workbench.action.focusFirstEditorGroup', 'workbench.action.focusSecondEditorGroup'][panelAt()]
    await vscode.commands.executeCommand(focusPanel)
    await same('the panel focused (Ctrl+1/2)')
    await vscode.commands.executeCommand(['workbench.action.focusFirstEditorGroup', 'workbench.action.focusSecondEditorGroup'][1 - panelAt()])
    ctx.api.mapSend({ type: 'test', click: '.homeb' })
    await same('‹ Journeys')
    // The row of the journey you're in (and Open Journey… on it): its panel to the front, nothing closed, still playing.
    await vscode.commands.executeCommand('codeNotes.openJourney', 'podlisten')
    await until('its panel, the walk, still playing', () => tour().map === 'podlisten' && pod().mapVisible && pod().playing && pod().session === 'podlisten', 5000)
    await same('its row clicked')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    // The narrow panel: Ctrl+' V gives it the room for the map's boxes (asked for).
    await vscode.commands.executeCommand('codeNotes.showMap')
    await until('Ctrl+\' V: room for the map', async () => (await editorLayout())[tour().mapColumn! - 1] >= 295, 5000)
    assert.equal(tour().map, 'podlisten', 'the same panel')
  }),

  test('listening: a question or a note being written pauses it, and the code stays under it', async () => {
    await seek(5)
    await until('step 1', at(1, 'listen.ts', 12), 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    void vscode.commands.executeCommand('codeNotes.askStep')
    await until('Ask: the box, the podcast paused', () => !!ctx.api.askBox() && !pod().playing && pod().held === 'question', 5000)
    const t0 = pod().t
    await sleep(1500)
    assert.ok(Math.abs(pod().t - t0) < 0.3 && tour().step === 1 && codeFile() === 'listen.ts', 'nothing moves under the box')
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
    await until('the box put away', () => !ctx.api.askBox(), 5000)
    assert.ok(!pod().playing, 'still paused: ▶ (on the card) goes on')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    // A note: Ctrl+' C on the narrated code.
    const ed = await vscode.window.showTextDocument(codeEditor()!.document, { viewColumn: codeEditor()!.viewColumn, preserveFocus: false })
    ed.selection = new vscode.Selection(12, 0, 12, 0)
    await vscode.commands.executeCommand('codeNotes.add')
    await until('a note: paused', () => !pod().playing && pod().held === 'note', 5000)
    const t1 = pod().t
    await sleep(2000)
    assert.ok(Math.abs(pod().t - t1) < 0.3 && tour().step === 1 && codeFile() === 'listen.ts', 'the draft\'s editor stays: nothing moves')
  }),

  test('listening: the journey edited under it keeps the step by id; a removed step shows what the podcast says at its time', async () => {
    await seek(25)
    await until('step 2 (L2)', () => tour().step === 2 && codeFile() === 'listen.ts' && !pod().applying, 8000)
    await sleep(300)
    const t0 = pod().t
    // Steps 1 and 2 swapped: L2 is step 1 now.
    writeListenJourney(['L2', 'L1', 'L3'])
    await until('the walk on L2, now step 1', () => tour().step === 1 && tour().card?.title === 'listen two', 8000)
    await sleep(1200)
    assert.ok(Math.abs(pod().t - t0) < 0.3, `the audio stayed at ${t0.toFixed(1)}: ${pod().t}`)
    writeListenJourney()
    await until('back: L2 is step 2', () => tour().step === 2 && tour().card?.title === 'listen two', 8000)
    // L2 removed: its part keeps the view before it (beat 3 of L1, listen2.ts).
    writeListenJourney(['L1', 'L3'])
    const shows = (name: string) => vscode.window.visibleTextEditors.some((e) => e.viewColumn !== tour().mapColumn && path.basename(e.document.uri.fsPath) === name)
    await until('the view before the removed step\'s part: step 1, beat 3 in listen2.ts', () => tour().step === 1 && shows('listen2.ts') && litLine() === 1 && !pod().applying, 8000)
    assert.ok(Math.abs(pod().t - t0) < 0.3, 'the audio stayed')
    writeListenJourney()
    await until('the journey back', () => ctx.api.snapshot().journeys.some((j: any) => j.id === 'podlisten' && j.steps === 3), 8000)
  }),

  test('listening: quick ⏭ ⏭ open only the last target; a beat it doesn\'t narrate pauses it', async () => {
    await seek(1)
    await until('the intro', () => tour().step === 0 && !pod().applying, 8000)
    const steps: number[] = []
    const poll = setInterval(() => { if (steps[steps.length - 1] !== tour().step) steps.push(tour().step) }, 15)
    try {
      send({ action: 'part', dir: 1 })
      await sleep(80)
      send({ action: 'part', dir: 1 })
      await until('two ⏭: step 2', () => tour().step === 2 && !pod().applying, 8000)
      await sleep(400)
    } finally { clearInterval(poll) }
    assert.deepEqual(steps, [0, 2], `step 1 never opened on the way: ${steps.join(' → ')}`)
    // Ctrl+' A in the intro is ⏮ too (F85): from the intro after seeking there.
    await seek(1)
    await until('the intro', () => tour().step === 0 && !pod().applying, 8000)
    await vscode.commands.executeCommand('codeNotes.next')
    await until('Ctrl+\' D in the intro: step 1', () => tour().step === 1, 8000)
    // Beat 4 of step 1 isn't narrated: picked in the animation while playing, it is shown and the audio pauses.
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await until('its move done', () => !pod().applying, 5000)
    await sleep(600)
    ctx.api.mapMessage({ type: 'beat', n: 1, i: 3, user: true })
    await until('paused, saying so', async () => !pod().playing && /Beat 4 isn't narrated/.test((await panelAudio()).note), 5000)
    await sleep(800)
    assert.equal(tour().step, 1, 'the walk stays')
    assert.equal(litLine(), 14, 'beat 4 lit')
  }),

  test('listening: End Journey ends the session (▶ says where it goes on); in a journey without a podcast the key says so; nothing piles up', async () => {
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('ended: paused, no session, no status item', () => !pod().playing && !pod().session && !pod().itemShown, 5000)
    const kept = pod().t
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('▶ again: on from where it was, the walk back', () => pod().playing && pod().session === 'podlisten' && tour().step > 0 && pod().t >= kept - 0.3, 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    // Another journey, without a podcast: Ctrl+' Space doesn't end it and restart this podcast.
    writeJourney(journeysDir(), journey('nopod', [step('src/listen.ts', 1, 2, { id: 'n1', title: 'no podcast' })], { title: 'No pod' }))
    await until('nopod read', () => ctx.api.snapshot().journeys.some((j: any) => j.id === 'nopod'), 8000)
    await vscode.commands.executeCommand('codeNotes.startJourney', 'nopod')
    await until('walking nopod', () => tour().journey === 'nopod' && tour().step === 1, 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await sleep(1200)
    assert.equal(tour().journey, 'nopod', 'its walk goes on')
    assert.ok(!pod().playing, 'no other podcast started')
    // Many seeks later: one walk tab, one panel (F99: editors and webviews are released).
    await playIt('podlisten')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing, 5000)
    // From no code tabs (the note test before pins the tab its draft is in: the reader's own, kept beside the walk's).
    await closeAllButPanel()
    for (const t of [5, 25, 13, 1, 21, 33, 5, 25, 13, 21, 1, 5]) { await seek(t); await sleep(250) }
    await until('settled', () => !pod().applying, 8000)
    await sleep(500)
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    const webviews = tabs.filter((t) => t.input instanceof vscode.TabInputWebview)
    const code = tabs.filter((t) => t.input instanceof vscode.TabInputText && /listen2?\.ts$/.test(t.input.uri.path))
    assert.equal(webviews.length, 1, `one panel: ${tabs.map((t) => t.label).join(', ')}`)
    assert.ok(code.length <= 1, `one walk tab: ${code.map((t) => `${t.label} (group ${t.group.viewColumn}${t.isPreview ? ', preview' : ''})`).join(', ')}`)
    const errors = consoleErrors()
    assert.deepEqual(errors, [], `console errors from the extension's panel:\n${errors.join('\n')}`)
  }),
  // ---------- marks: highlights as the words are said (src/podcast/marks.ts) ----------

  test('marks: a seek shows exactly the marks said by then, to the character, the newest the focus; back again takes them away', async () => {
    writeMarksJourney()
    await until('its podcast is found', () => pod().journeys.includes('podmarks'), 10000)
    await closeAllButPanel()
    await playIt('podmarks')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(14)
    await until('step 1, its beat on line 3', () => tour().journey === 'podmarks' && tour().step === 1 && codeFile() === 'marks.ts' && litLine() === 3 && !pod().applying, 8000)
    // At 14 s: marks 1-4 are lit (10.88, 12.38, 13.88 twice); 3 and 4 are said with the same words: both the focus
    // (4 is whole lines: each line from its text).
    const want = [
      markAt(3, 'needsModel(steps)', 1, 'dim'),
      markAt(3, 'strict', 2, 'dim'),
      markAt(4, 'reject(400)', 1, 'focus'),
      { line: 4, col: 2, endLine: 4, endCol: 3, text: '}', style: 'focus' },
      { line: 5, col: 2, endLine: 5, endCol: MARK_LINES[5].length, text: 'return ok()', style: 'focus' },
    ]
    await until('the four marks at 14 s', () => sameMarks(pod().marks, want), 5000)
    // Back to 11 s: only the first, now the focus.
    await seek(11)
    await until('back at 11 s: one mark, the focus', () => sameMarks(pod().marks, [{ ...want[0], style: 'focus' }]), 5000)
    await seek(10.5)
    await until('before the first mark: none', () => pod().marks.length === 0, 5000)
    assert.equal(litLine(), 3, 'the beat\'s own line stays lit')
  }),

  test('marks: playing, each lights on time (0.12 s before its word); the next segment clears them', async () => {
    await seek(12)
    await until('at 12 s: the first mark', () => pod().marks.length === 1 && !pod().applying, 5000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    // "strict is set" lights at 10 + 2.5 - 0.12 = 12.38 s (as the audio says it, not the last report).
    let audioT = -1
    await until('"strict" lit', async () => {
      if (!pod().marks.some((m: any) => m.text === 'strict')) return false
      audioT = (await panelAudio()).t
      return true
    }, 5000)
    assert.ok(audioT >= 12.38 - 0.1 && audioT <= 12.38 + 0.5, `lit at ${audioT.toFixed(2)} s (due 12.38)`)
    await until('"right there": two places at once', () => pod().marks.filter((m: any) => m.style === 'focus').length === 3, 5000)
    await seek(19.4)
    await until('the next segment: none lit', () => pod().t > 20.1 && pod().marks.length === 0, 6000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('marks: an off-screen mark is scrolled to, but never under a reader looking around (the follow lock)', async () => {
    const shows = (line: number) => codeEditor()!.visibleRanges.some((r) => r.contains(new vscode.Position(line, 0)))
    // Following: "at the end" (line 180, far down) lights at 15.88 s and is brought on screen.
    await seek(14.5)
    await until('the beat on screen', () => litLine() === 3 && !pod().applying && shows(2), 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await until('line 180 lit and on screen', () => pod().marks.some((m: any) => m.line === 179 && m.style === 'focus') && shows(179), 5000)
    // Looking around: the reader scrolls away; the mark lights where it is, the editor stays.
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(12)
    await until('back on the beat, line 180 not lit', () => shows(2) && !pod().applying && !pod().marks.some((m: any) => m.line === 179), 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await sleep(1700)
    codeEditor()!.revealRange(new vscode.Range(40, 0, 40, 0), vscode.TextEditorRevealType.AtTop)
    await until('not following', () => pod().follow === false, 5000)
    const top = codeEditor()!.visibleRanges[0].start.line
    await until('line 180 lit', () => pod().marks.some((m: any) => m.line === 179), 6000)
    await sleep(500)
    const now = codeEditor()!.visibleRanges[0]
    assert.ok(Math.abs(now.start.line - top) <= 1 && !shows(179), `the editor stayed where the reader is (top ${top} → ${now.start.line}-${now.end.line})`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
  }),
  // ---------- camera moves: time to read before the code moves, a heads-up, a moment after (src/podcast/camera.ts) ----------

  test('camera: a mark out of view waits for the read time, shows a heads-up first, settles after; one in view never waits', async () => {
    await cameraWaits(2.5, 0.8)
    writeCamJourney()
    await until('its podcast is found', () => pod().journeys.includes('podcam'), 10000)
    await closeAllButPanel()
    await playIt('podcam')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(4.3)
    await until('step 1, its beat on line 3', () => tour().journey === 'podcam' && litLine() === 3 && !pod().applying, 8000)
    await sleep(1600)
    const shows = (line: number) => !!codeEditor()?.visibleRanges.some((r) => r.contains(new vscode.Position(line, 0)))
    const before = pod().camera.waits.length
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    // Watched every 30 ms: the cue, the wait, line 200 on screen.
    const seen: { cueAt?: number; waitAt?: number; shownAt?: number; note?: string; pausedInWait?: boolean; shownPlaying?: boolean } = {}
    const t0 = Date.now()
    await until('the move to line 200 made, the wait over', async () => {
      const c = pod().camera
      if (c.cue === '↓ 200' && seen.cueAt === undefined) seen.cueAt = Date.now() - t0
      if (c.waiting && seen.waitAt === undefined) {
        seen.waitAt = Date.now() - t0
        await sleep(300)
        const a = await panelAudio()
        seen.pausedInWait = a.paused && pod().camera.waiting !== undefined
        seen.note = a.note
        seen.shownPlaying = pod().playing && /Listening/.test(pod().item)
      }
      if (shows(199) && seen.shownAt === undefined) seen.shownAt = Date.now() - t0
      return c.waits.length > before && c.waits[before].ended === 'time' && pod().playing
    }, 12000)
    const w = pod().camera.waits[before]
    assert.equal(w.where, '↓ 200', `the first wait is the move to line 200 (line 5, in view, never waited): ${JSON.stringify(pod().camera.waits.slice(before))}`)
    // Line 5 lit at 5.88 s; line 200 due at 6.88 s: 1.5 s of the 2.5 s read time left, then 0.8 s settle.
    assert.ok(w.read >= 1.0 && w.read <= 2.2, `read wait ${JSON.stringify(pod().camera.waits.slice(before))} ${JSON.stringify(seen)}`)
    assert.ok(w.settle >= 0.7 && w.settle <= 1.3, `settle ${w.settle}`)
    assert.ok(seen.cueAt !== undefined && seen.shownAt !== undefined && seen.cueAt < seen.shownAt, `the heads-up before the move: ${JSON.stringify(seen)}`)
    assert.ok(seen.pausedInWait, 'the audio waits')
    assert.equal(seen.note, '', 'no line under the player: the edge cue says it')
    assert.ok(seen.shownPlaying, 'a wait is no pause: still Listening')
    assert.ok(shows(199), 'line 200 on screen')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('camera: no wait after the reader\'s own seek, none under the follow lock; playing on ends a wait, Space in one pauses', async () => {
    const shows = (line: number) => !!codeEditor()?.visibleRanges.some((r) => r.contains(new vscode.Position(line, 0)))
    // A seek right before the far mark: it moves without waiting.
    await seek(6.5)
    await until('back on the beat', () => litLine() === 3 && !pod().applying && shows(2), 8000)
    let n = pod().camera.waits.length
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('line 200 lit and on screen', () => pod().marks.some((m: any) => m.line === 199) && shows(199), 5000)
    assert.equal(pod().camera.waits.length, n, `no wait after a seek: ${JSON.stringify(pod().camera.waits.slice(n))}`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    // The follow lock: the reader scrolls away; the far mark lights where it is, nothing waits, nothing moves.
    await seek(4.3)
    await until('back on the beat', () => litLine() === 3 && !pod().applying && shows(2), 8000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await sleep(1600)
    codeEditor()!.revealRange(new vscode.Range(100, 0, 100, 0), vscode.TextEditorRevealType.AtTop)
    await until('not following', () => pod().follow === false, 5000)
    n = pod().camera.waits.length
    await until('line 200 lit', () => pod().marks.some((m: any) => m.line === 199), 6000)
    await sleep(600)
    assert.ok(pod().playing && pod().camera.waits.length === n && !shows(199), `under the follow lock: no wait, no move (${JSON.stringify(pod().camera)})`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    // Played on during a wait (a headset key, another ▶): it plays on at once, the walk at the audio's time.
    await seek(4.3)
    await until('back on the beat', () => litLine() === 3 && !pod().applying && shows(2), 8000)
    await sleep(1600)
    n = pod().camera.waits.length
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('a wait', () => pod().camera.waiting === 'read', 6000)
    await send({ action: 'play' })
    await until('played on: no wait, line 200 on screen', () => pod().audible && !pod().camera.waiting && shows(199), 3000)
    assert.equal(pod().camera.waits[n]?.ended, 'skip')
    // Space in a wait is the reader's pause (the player showed ⏸): paused, the move dropped.
    await seek(4.3)
    await until('back on the beat', () => litLine() === 3 && !pod().applying && shows(2), 8000)
    await sleep(1600)
    n = pod().camera.waits.length
    await until('a wait', () => pod().camera.waiting === 'read', 6000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused by the reader', () => !pod().playing && !pod().camera.waiting, 3000)
    assert.equal(pod().camera.waits[n]?.ended, 'cancel')
    await sleep(600)
    assert.ok((await panelAudio()).paused && !pod().playing, 'it stays paused: the wait does not resume it')
    await cameraWaits(0, 0)
  }),

  // ---------- the walk keeps time with the voice: waits hold the audio wherever the Listen view is; never a lag ----------

  test('camera: playing on through out-of-view moves with the Listen view collapsed and the panel closed: the audio holds in each wait, nothing says paused, the marks are the audio\'s after each move', async () => {
    await cameraWaits(1.2, 0.6)
    writeWalkJourney()
    await until('its podcast is found', () => pod().journeys.includes('podwalk'), 10000)
    await closeAllButPanel()
    await playIt('podwalk')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(WALK_FROM)
    await until('step 1 on its beat', () => tour().journey === 'podwalk' && litLine() === 3 && !pod().applying, 8000)
    // The map panel closed (the audio plays on in the Listen view), the Listen view collapsed.
    await closePanel()
    await setListenCollapsed(true)
    await sleep(1600)
    const before = pod().camera.waits.length
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    const ticks = await watchPlay(() => pod().camera.waits.length - before >= 4 && !pod().camera.waiting, 30000)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await setListenCollapsed(false)
    checkWaits(ticks, pod().camera.waits.slice(before), 4)
  }),

  test('camera: a hold the audio ignores is dropped within ~300 ms and the walk goes to what is said now; waits are off for a while after', async () => {
    await cameraWaits(2.5, 0.8)
    await seek(WALK_FROM)
    await until('back on the beat', () => litLine() === 3 && !pod().applying, 8000)
    await sleep(2600)
    const before = pod().camera.waits.length
    ctx.api.listenIgnorePauses(true)
    try {
      await vscode.commands.executeCommand('codeNotes.podcastToggle')
      const ticks = await watchPlay(() => pod().marks.some((m: any) => m.line === WALK_LINES[3] - 1 && m.style === 'focus') && !pod().camera.waiting, 20000)
      const waits = pod().camera.waits.slice(before)
      assert.equal(waits[0]?.ended, 'abandon', `the first wait is dropped: ${JSON.stringify(waits)}`)
      assert.equal(waits.length, 1, `then no more waits (they stay off): ${JSON.stringify(waits)}`)
      assert.ok(ticks.every((k) => !k.paused), 'the audio never stopped')
      // From the moment the wait began, the walk is the audio's again within ~300 ms, and stays so.
      const start = ticks.findIndex((k) => k.waiting)
      assert.ok(start >= 0, 'a wait began')
      const late = ticks.filter((k, i) => i > start && k.ms - ticks[start].ms > 350 && !k.marksMatch)
      assert.equal(late.length, 0, `the marks lag the audio after the wait was dropped: ${JSON.stringify(late.slice(0, 3))}`)
      const lag = ticks.filter((k) => Math.abs(k.audioNow - k.t) > 0.3)
      assert.equal(lag.length, 0, `the extension's time is the audio's (±0.3 s): ${JSON.stringify(lag.slice(0, 3))}`)
    } finally {
      ctx.api.listenIgnorePauses(false)
    }
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('camera: a wait is no pause (card one line, status Listening, ⏸ in the players, no line under them); the reader scrolling in small steps opens the follow lock and ends the wait; the card changing size does not', async () => {
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    // A long read time: the wait starts before the code moves (the reader's scroll is theirs then).
    await cameraWaits(6, 0.8)
    await openPanel('podwalk')
    await seek(WALK_FROM)
    await until('back on the beat', () => litLine() === 3 && !pod().applying, 8000)
    await sleep(1600)
    const n = pod().camera.waits.length
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('a wait', () => pod().camera.waiting === 'read', 8000)
    await sleep(300)
    const a = await panelAudio()
    assert.ok(a.paused, 'the audio holds')
    assert.equal(a.note, '', 'no line under the player')
    assert.match(pod().item, /^\$\(unmute\) Listening/, `the status item: ${pod().item}`)
    assert.match(tour().card?.body ?? '', /narrating/, 'the step card stays one line')
    assert.equal(await playButtonOn(await listenFrame()), 'true', 'the Listen view shows ⏸')
    assert.equal(await playButtonOn(await panelFrame()), 'true', 'the panel shows ⏸')
    assert.equal(await panelText('.pod-err'), '', 'no line under the panel\'s player')
    // The reader scrolls one line at a time: together it is a scroll.
    const ed = codeEditor()!
    const top0 = ed.visibleRanges[0].start.line
    await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false })
    for (let i = 1; i <= 5; i++) {
      await vscode.commands.executeCommand('editorScroll', { to: 'down', by: 'line', value: 1 })
      await sleep(120)
    }
    await until('not following; the wait ended, playing on', () => pod().follow === false && !pod().camera.waiting && pod().audible, 3000)
    assert.equal(pod().camera.waits[n]?.ended, 'release')
    assert.ok(ed.visibleRanges[0].start.line >= top0 + 3, `the reader stays where they scrolled (${top0} → ${ed.visibleRanges[0].start.line})`)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    // Pause and play with the card on screen: its size changes, nobody scrolled.
    await sleep(1700)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await until('the full card', () => !/narrating/.test(tour().card?.body ?? ''), 3000)
    await sleep(1700)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('playing', () => pod().playing)
    await sleep(800)
    assert.equal(pod().follow, true, `the card changing size is not the reader (${pod().unlock})`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('camera: a mark brought on screen keeps column 1 in view; the code scrolls right only for a mark that starts past the edge', async () => {
    await cameraWaits(0, 0)
    writeWideJourney()
    await until('its podcast is found', () => pod().journeys.includes('podwide'), 10000)
    await playIt('podwide')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await seek(4.2)
    await until('step 1 on its beat', () => tour().journey === 'podwide' && litLine() === 2 && !pod().applying, 8000)
    await sleep(1600)
    // The reader's editor scrolled right before (as after an earlier long line).
    const ed = codeEditor()!
    ed.revealRange(new vscode.Range(1, 250, 1, 251), vscode.TextEditorRevealType.Default)
    await until('scrolled right', async () => (await scrollLeft('wide1')) > 100, 3000)
    await sleep(1600)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    // A long mark starting at column 9 on line 150: shown from column 1.
    await until('line 150 lit and on screen', () => pod().marks.some((m: any) => m.line === 149) && ed.visibleRanges.some((r) => r.contains(new vscode.Position(149, 0))), 6000)
    await sleep(1000)
    assert.equal(await scrollLeft('wide150'), 0, `column 1 in view: ${JSON.stringify(await editorBox('wide150'))}`)
    // A mark starting at column 260 on line 300: scrolled right just enough to show its start.
    await until('line 300 lit and on screen', () => pod().marks.some((m: any) => m.line === 299) && ed.visibleRanges.some((r) => r.contains(new vscode.Position(299, 0))), 6000)
    await until('scrolled right to it', async () => (await scrollLeft('wide300')) > 0, 3000).catch(() => undefined)
    await sleep(400)
    const left = await scrollLeft('wide300')
    const view = await editorBox('wide300')
    assert.ok(left > 0 && view.markLeft >= view.left && view.markLeft < view.right, `the mark's start is shown (scrollLeft ${left}, ${JSON.stringify(view)})`)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
  }),

  test('long run: 10 minutes at 2× with camera waits and out-of-view moves: the extension\'s time, the captions and the marks are the audio\'s at the end', async () => {
    await cameraWaits(1.0, 0.4)
    writeLongJourney()
    await until('its podcast is found', () => pod().journeys.includes('podlong'), 10000)
    // Ten minutes of audio take a moment to load (it is fetched whole) before it plays on its own; from the start.
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podlong')
    await until('the panel shows it', () => tour().map === 'podlong' && pod().mapVisible, 10000)
    if (!(await until('playing on its own', () => pod().playing && pod().session === 'podlong', 12000).catch(() => false))) await (await listenFrame()).click('.pod-b.play')
    await until('playing', () => pod().playing && pod().session === 'podlong', 10000)
    await seek(0)
    await until('from the start', () => pod().t < 3 && pod().playing, 8000)
    await send({ action: 'rate', rate: 2 })
    await until('at 2×', () => pod().playing, 5000)
    const before = pod().camera.waits.length
    const drift: { at: number; ext: number }[] = []
    await until('near the end', async () => {
      const a = await panelAudio()
      drift.push({ at: a.t, ext: pod().audioNow })
      return a.t > LONG_S - 25
    }, (LONG_S / 2) * 1000 + 60000)
    const waits = pod().camera.waits.slice(before)
    assert.ok(waits.filter((w: any) => w.ended === 'time').length >= 5, `camera waits made: ${JSON.stringify(waits.slice(0, 8))}`)
    // At the end, playing: one moment, read together.
    const f = await listenFrame()
    const pf = await panelFrame()
    const a = await f.evaluate(() => { const d = (globalThis as any).document; return { t: d.querySelector('.pod audio').currentTime, cap: d.querySelector('.pod-cap-t').textContent } })
    const ext = pod().audioNow
    const pcap = await pf.evaluate(() => (globalThis as any).document.querySelector('.pod-cap-t').textContent)
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await sleep(400)
    const worst = Math.max(...drift.slice(20).map((d) => Math.abs(d.at - d.ext)))
    console.log(`    (long run: ${waits.length} waits; extension time vs audio at the end ${(ext - a.t).toFixed(3)} s, worst while playing ${worst.toFixed(3)} s)`)
    assert.ok(Math.abs(ext - a.t) < 0.3, `the extension's time ${ext} vs the audio's ${a.t}`)
    const seg = LONG_SEGS.find((x) => a.t >= x.start && a.t < x.end)!
    assert.ok(seg && a.cap && seg.text.includes(a.cap.trim()), `the Listen view's caption is the segment at ${a.t}: "${a.cap}" in "${seg?.text}"`)
    assert.ok(pcap && seg.text.includes(pcap.trim()), `the panel's caption too: "${pcap}"`)
    const paused = await f.evaluate(() => (globalThis as any).document.querySelector('.pod audio').currentTime)
    const want = expectedFocus(LONG_SEGS, paused)
    const got = pod().marks.filter((m: any) => m.style === 'focus').map((m: any) => m.line + 1)
    assert.deepEqual(got, want, `the lit marks are the audio's at ${paused}`)
  }),
]

const podFile = () => path.join(journeysDir(), 'pod.podcast.json')
const diagnostics = () => vscode.languages.getDiagnostics(vscode.Uri.file(podFile()))
/** The 0-based line of the first line of `file` with `text`. */
const lineOf = (file: string, text: string) => fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(text))
async function panelText(sel: string): Promise<string> {
  const f = await panelFrame()
  return f.evaluate((s) => { const e = (globalThis as any).document.querySelector(s); return e && !e.hidden ? e.textContent : '' }, sel)
}
async function panelVisible(sel: string): Promise<boolean> {
  const f = await panelFrame()
  return f.evaluate((s) => { const e = (globalThis as any).document.querySelector(s); return !!e && e.getClientRects().length > 0 }, sel)
}

/** "pod" in the panel, playing (a new panel needs one click in it first). */
async function playPod(): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
  await until('the panel shows it', () => tour().map === 'pod' && pod().mapVisible, 10000)
  if (!(await until('playing on its own', () => pod().playing, 3000).catch(() => false))) {
    // A new Listen view's audio may not play before a click in it: the panel has the audio then, its ▶ focused.
    await until('in the panel, its ▶ focused', () => pod().hostIn === 'panel', 5000)
    await sleep(500)
    await (await ui()).keyboard.press('Space')
  }
  await until('playing', () => pod().playing && pod().session === 'pod', 10000)
}

/** The workbench's console errors and uncaught errors from here on (the panel's frames included). */
let seen: string[] | undefined
function watchConsole(): void {
  if (seen) return
  seen = []
  void ui().then((page) => {
    page.on('console', (m) => { if (m.type() === 'error') seen!.push(`${m.location().url}: ${m.text()}`) })
    page.on('pageerror', (e) => seen!.push(`uncaught: ${e.message}`))
  })
}
/** The errors seen that come from the extension (its panel, its media files). */
const consoleErrors = () => (seen ?? []).filter((e) => /vscode-webview|code-notes|journey-|podcast/i.test(e))

/** The journey "podlisten": step L1 (listen.ts, an animation of 4 beats: line 12, line 150, listen2.ts line 1, line 14
 *  never narrated), L2 (listen.ts 100–110), L3 (listen2.ts); `order`: the steps' order in the file (ids). */
function writeListenJourney(order = ['L1', 'L2', 'L3']) {
  writeLines(wsPath('src', 'listen.ts'), Array.from({ length: 220 }, (_, i) => `export const l${i + 1} = ${i + 1} // ${'x'.repeat(30)}`))
  writeLines(wsPath('src', 'listen2.ts'), ['export const other = 1', 'export const two = 2'])
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'one()', checks: ['a'] }]
  const beat = (caption: string, file: string, line: number, text: string) => ({ focus: 'svc', caption, code: { file, line, text } })
  const steps: Record<string, ReturnType<typeof step>> = {
    L1: step('src/listen.ts', 10, 20, { id: 'L1', title: 'listen one', scene: { actors, wires: [], beats: [
      beat('Here.', 'src/listen.ts', 12, `export const l12 = 12 // ${'x'.repeat(30)}`),
      beat('Far down.', 'src/listen.ts', 150, `export const l150 = 150 // ${'x'.repeat(30)}`),
      beat('Elsewhere.', 'src/listen2.ts', 1, 'export const other = 1'),
      beat('Not told.', 'src/listen.ts', 14, `export const l14 = 14 // ${'x'.repeat(30)}`),
    ] } }),
    L2: step('src/listen.ts', 100, 110, { id: 'L2', title: 'listen two' }),
    L3: step('src/listen2.ts', 1, 2, { id: 'L3', title: 'listen three' }),
  }
  writeJourney(journeysDir(), journey('podlisten', order.map((id) => steps[id]), { title: 'Pod listen' }))
  const mp3 = path.join(journeysDir(), 'podlisten.mp3')
  if (!fs.existsSync(mp3)) fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), mp3)
  const file = path.join(journeysDir(), 'podlisten.podcast.json')
  if (fs.existsSync(file)) return
  const seg = (id: string, at: unknown, start: number, end: number) => ({ id, at, speaker: 'host', text: `Part ${id}.`, start, end })
  fs.writeFileSync(file, JSON.stringify({
    version: 1, title: 'Pod listen', journey: { id: 'podlisten' }, audio: 'podlisten.mp3', duration: 40,
    segments: [
      seg('intro', null, 0, 3.8),
      seg('b1', { step: 'L1', beat: 1 }, 4, 11.8),
      seg('b2', { step: 'L1', beat: 2 }, 12, 19.8),
      seg('b3', { step: 'L1', beat: 3 }, 20, 22.8),
      seg('l2', { step: 'L2' }, 23, 30.8),
      seg('outro', null, 31, 40),
    ],
  }))
}

/** The marks journey's code: line 3 has the check, 4 the return that rejects, 180 the end (1-based). */
const MARK_LINES = Array.from({ length: 200 }, (_, i) => `export const m${i + 1} = ${i + 1}`)
MARK_LINES[2] = '  if (needsModel(steps) && mode === strict && strict) {'
MARK_LINES[3] = '    return reject(400)'
MARK_LINES[4] = '  }'
MARK_LINES[5] = '  return ok()'
MARK_LINES[179] = 'export const end = done() // the end'

/** A mark expected on `line` (1-based): the `nth` occurrence of `text` there. */
function markAt(line: number, text: string, nth: number, style: 'focus' | 'dim') {
  const l = MARK_LINES[line - 1]
  let col = -text.length
  for (let k = 0; k < nth; k++) col = l.indexOf(text, col + text.length)
  return { line: line - 1, col, endLine: line - 1, endCol: col + text.length, text, style }
}

/** The marks lit are exactly `want` (any order). */
function sameMarks(got: any[], want: object[]): boolean {
  const key = (m: any) => JSON.stringify([m.line, m.col, m.endLine, m.endCol, m.text, m.style])
  return got.length === want.length && want.every((w) => got.some((g) => key(g) === key(w)))
}

/** The journey "podmarks": one step (src/marks.ts, a beat on line 3) whose part (10-20 s) has five marks: "requires a
 *  model" (needsModel(steps)), "strict is set" (the second "strict"), "right there" twice (the return, re-found a line
 *  up from where it says; lines 5-6, whole), "at the end" (line 180). */
function writeMarksJourney() {
  writeLines(wsPath('src', 'marks.ts'), MARK_LINES)
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'check()', checks: ['a'] }]
  writeJourney(journeysDir(), journey('podmarks', [step('src/marks.ts', 1, 10, { id: 'M1', title: 'marks one', scene: { actors, wires: [], beats: [
    { focus: 'svc', caption: 'The check.', code: { file: 'src/marks.ts', line: 3, text: MARK_LINES[2] } },
  ] } })], { title: 'Pod marks' }))
  const mp3 = path.join(journeysDir(), 'podmarks.mp3')
  if (!fs.existsSync(mp3)) fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), mp3)
  fs.writeFileSync(path.join(journeysDir(), 'podmarks.podcast.json'), JSON.stringify({
    version: 1, title: 'Pod marks', journey: { id: 'podmarks' }, audio: 'podmarks.mp3', duration: 40,
    segments: [
      { id: 'intro', at: null, speaker: 'host', text: 'Hello.', start: 0, end: 3.8 },
      { id: 'm0', at: { step: 'M1', beat: 1 }, speaker: 'host', text: 'Here.', start: 4, end: 9.8 },
      { id: 'm1', at: { step: 'M1', beat: 1 }, speaker: 'host', text: 'If it requires a model and strict is set, it is rejected right there, at the end.', start: 10, end: 19.8, marks: [
        { phrase: 'requires a model', at: 1, lines: [3, 3], match: 'needsModel(steps)' },
        { phrase: 'strict is set', at: 2.5, lines: [3, 3], match: 'strict', nth: 2 },
        { phrase: 'right there', at: 4, lines: [5, 5], match: 'reject(400)' },
        { phrase: 'right there', at: 4, lines: [5, 6] },
        { phrase: 'at the end', at: 6, lines: [180, 180], match: 'done()' },
      ] },
      { id: 'outro', at: null, speaker: 'host', text: 'Bye.', start: 20, end: 40 },
    ],
  }))
}

/** The camera's waits (codeNotes.listen.readBeforeMove, settleAfterMove; 0: off). */
async function cameraWaits(read: number, settle: number): Promise<void> {
  const c = vscode.workspace.getConfiguration('codeNotes.listen')
  await c.update('readBeforeMove', read, vscode.ConfigurationTarget.Global)
  await c.update('settleAfterMove', settle, vscode.ConfigurationTarget.Global)
}

/** The journey "podcam": one step (src/cam.ts, its beat on line 3) whose part (4-30 s) has marks on line 3 (4.88 s),
 *  line 5 (5.88 s, in view), line 200 (6.88 s, far below) and line 3 again (7.88 s, far above by then). */
function writeCamJourney() {
  const lines = Array.from({ length: 220 }, (_, i) => `export const c${i + 1} = ${i + 1}`)
  writeLines(wsPath('src', 'cam.ts'), lines)
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'cam()', checks: ['a'] }]
  writeJourney(journeysDir(), journey('podcam', [step('src/cam.ts', 1, 10, { id: 'C1', title: 'camera one', scene: { actors, wires: [], beats: [
    { focus: 'svc', caption: 'Here.', code: { file: 'src/cam.ts', line: 3, text: lines[2] } },
  ] } })], { title: 'Pod cam' }))
  const mp3 = path.join(journeysDir(), 'podcam.mp3')
  if (!fs.existsSync(mp3)) fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), mp3)
  fs.writeFileSync(path.join(journeysDir(), 'podcam.podcast.json'), JSON.stringify({
    version: 1, title: 'Pod cam', journey: { id: 'podcam' }, audio: 'podcam.mp3', duration: 40,
    segments: [
      { id: 'intro', at: null, speaker: 'host', text: 'Hello.', start: 0, end: 3.8 },
      { id: 'c1', at: { step: 'C1', beat: 1 }, speaker: 'host', text: 'Three, five, far down, and back up.', start: 4, end: 30, marks: [
        { phrase: 'Three', at: 1, lines: [3, 3] },
        { phrase: 'five', at: 2, lines: [5, 5] },
        { phrase: 'far down', at: 3, lines: [200, 200] },
        { phrase: 'back up', at: 4, lines: [3, 3] },
      ] },
      { id: 'outro', at: null, speaker: 'host', text: 'Bye.', start: 30, end: 40 },
    ],
  }))
}

/** Every editor closed but the journey panel. */
async function closeAllButPanel(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => !(t.input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(t.input.viewType)))
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
}

/** The editor groups' widths (px), side by side. */
async function editorLayout(): Promise<number[]> {
  const l = await vscode.commands.executeCommand<{ groups: { size?: number }[] }>('vscode.getEditorLayout')
  return l.groups.map((g) => Math.round(g.size ?? 0))
}

/** The groups with a tab on a file named `name`. */
const groupsShowing = (name: string) => vscode.window.tabGroups.all.filter((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && path.basename(t.input.uri.fsPath) === name))

/** Journey `id`'s podcast in the panel, playing (a new panel needs one click in it first). */
async function playIt(id: string): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.playPodcast', id)
  await until('the panel shows it', () => tour().map === id && pod().mapVisible, 10000)
  // The audio is in the Listen view: a new one may need one click on its own ▶ (a webview plays only after one).
  if (!(await until('playing on its own', () => pod().playing && pod().session === id, 3000).catch(() => false))) {
    const f = await listenFrame()
    await until('▶ has the keyboard', async () => (await f.evaluate(() => (globalThis as any).document.activeElement?.className)) === 'pod-b play', 5000)
    await f.click('.pod-b.play')
  }
  await until('playing', () => pod().playing && pod().session === id, 10000)
}

// ---------- the walk keeping time with the voice: fixtures and watching ----------

interface TSeg { id: string; start: number; end: number; text: string; marks?: { phrase: string; at: number; lines: [number, number]; match?: string }[] }

/** The focus marks' lines (1-based) lit at second `t` of `segs` (the segment's marks timed as the player times them). */
function expectedFocus(segs: TSeg[], t: number): number[] {
  const seg = [...segs].reverse().find((x) => t >= x.start)
  if (!seg?.marks || t >= seg.end) return []
  const times = markTimes(seg)
  const { lit, focusFrom } = marksAt(times, t)
  return seg.marks.slice(focusFrom, lit).map((m) => m.lines[0])
}
/** Second `t` is this close to a mark lighting (s): what is lit then may be either side of it. */
const nearMark = (segs: TSeg[], t: number, by = 0.2) => segs.some((x) => markTimes(x).some((m) => Math.abs(m - t) < by))

/** "podwalk": one step (src/walk.ts, its beat on line 3) whose part (4-38 s) lights marks far apart: line 5 (in view),
 *  then 300, 20, 350, 40, 380 (each out of view of the one before). */
const WALK_LINES = [5, 300, 20, 350, 40, 380]
const WALK_FROM = 4.3
const WALK_SEGS: TSeg[] = [
  { id: 'intro', start: 0, end: 3.8, text: 'Hello.' },
  { id: 'w1', start: 4, end: 38, text: 'Alpha here, beta far down, gamma up, delta down, epsilon up, zeta down.', marks: [
    { phrase: 'Alpha', at: 1, lines: [5, 5] }, { phrase: 'beta', at: 4, lines: [300, 300] }, { phrase: 'gamma', at: 8, lines: [20, 20] },
    { phrase: 'delta', at: 12, lines: [350, 350] }, { phrase: 'epsilon', at: 16, lines: [40, 40] }, { phrase: 'zeta', at: 20, lines: [380, 380] },
  ] },
  { id: 'outro', start: 38.2, end: 40, text: 'Bye.' },
]
function writeWalkJourney() {
  writeLines(wsPath('src', 'walk.ts'), Array.from({ length: 420 }, (_, i) => `export const walk${i + 1} = ${i + 1}`))
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'walk()', checks: ['a'] }]
  writeJourney(journeysDir(), journey('podwalk', [step('src/walk.ts', 1, 10, { id: 'W1', title: 'walk one', scene: { actors, wires: [], beats: [
    { focus: 'svc', caption: 'Here.', code: { file: 'src/walk.ts', line: 3, text: 'export const walk3 = 3' } },
  ] } })], { title: 'Pod walk' }))
  writePodcast('podwalk', 'Pod walk', WALK_SEGS.map((x) => ({ ...x, at: x.marks ? { step: 'W1', beat: 1 } : null })), 40, tonePath())
}

/** "podwide": src/wide.ts of long lines (each starts with its tag, "/* wide<n> *\/"); marks on line 150 (a short match
 *  at column 15) and line 300 (FARMARK, past column 260). */
function writeWideJourney() {
  writeLines(wsPath('src', 'wide.ts'), Array.from({ length: 320 }, (_, i) => `/* wide${i + 1} */ export const w${i + 1} = '${'x'.repeat(240)}${i + 1 === 300 ? 'FARMARK' : 'yyyyyyy'}${'z'.repeat(60)}'`))
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'wide()', checks: ['a'] }]
  const l2 = `/* wide2 */ export const w2 = '${'x'.repeat(240)}yyyyyyy${'z'.repeat(60)}'`
  writeJourney(journeysDir(), journey('podwide', [step('src/wide.ts', 1, 5, { id: 'X1', title: 'wide one', scene: { actors, wires: [], beats: [
    { focus: 'svc', caption: 'Here.', code: { file: 'src/wide.ts', line: 2, text: l2 } },
  ] } })], { title: 'Pod wide' }))
  writePodcast('podwide', 'Pod wide', [
    { id: 'intro', at: null, start: 0, end: 3.8, text: 'Hello.' },
    { id: 'x1', at: { step: 'X1', beat: 1 }, start: 4, end: 38, text: 'This constant, and that far mark.', marks: [
      { phrase: 'This constant', at: 3.5, lines: [150, 150], match: 'export const w150' },
      { phrase: 'that far mark', at: 6.5, lines: [300, 300], match: 'FARMARK' },
    ] },
    { id: 'outro', at: null, start: 38.2, end: 40, text: 'Bye.' },
  ], 40, tonePath())
}

/** "podlong": ten minutes (the tone fifteen times), one step (src/long.ts), a part every 20 s whose two marks are far
 *  apart (lines 10 and 300, then 350 and 30, …). */
const LONG_S = 601
const LONG_SEGS: TSeg[] = [{ id: 'intro', start: 0, end: 3.8, text: 'Hello.' }]
for (let k = 0, t = 4; t + 20 <= 585; k++, t += 20) {
  const [a, b] = k % 2 ? [350, 30] : [10, 300]
  LONG_SEGS.push({ id: `p${k}`, start: t, end: t + 19.8, text: `Part ${k + 1}. Here is one thing, and then another thing far away, said slowly.`, marks: [
    { phrase: 'one thing', at: 2, lines: [a, a] }, { phrase: 'another thing', at: 10, lines: [b, b] },
  ] })
}
LONG_SEGS.push({ id: 'outro', start: 585, end: LONG_S - 0.5, text: 'That was all.' })
function writeLongJourney() {
  writeLines(wsPath('src', 'long.ts'), Array.from({ length: 420 }, (_, i) => `export const long${i + 1} = ${i + 1}`))
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'long()', checks: ['a'] }]
  writeJourney(journeysDir(), journey('podlong', [step('src/long.ts', 1, 10, { id: 'G1', title: 'long one', scene: { actors, wires: [], beats: [
    { focus: 'svc', caption: 'Here.', code: { file: 'src/long.ts', line: 3, text: 'export const long3 = 3' } },
  ] } })], { title: 'Pod long' }))
  const mp3 = path.join(journeysDir(), 'podlong.mp3')
  if (!fs.existsSync(mp3)) fs.writeFileSync(mp3, longTone(15))
  writePodcast('podlong', 'Pod long', LONG_SEGS.map((x) => ({ ...x, at: x.marks ? { step: 'G1', beat: 1 } : null })), LONG_S, mp3)
}

const tonePath = () => path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3')
/** The tone `n` times over: its MPEG frames repeated (its first frame, the length header, left out: the player
 *  measures the stream itself). */
function longTone(n: number): Buffer {
  const d = fs.readFileSync(tonePath())
  let i = d.subarray(0, 3).toString() === 'ID3' ? 10 + ((d[6] << 21) | (d[7] << 14) | (d[8] << 7) | d[9]) : 0
  const BR = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const SR = [22050, 24000, 16000]
  const frames: Buffer[] = []
  while (i + 4 <= d.length && d[i] === 0xff && (d[i + 1] & 0xe0) === 0xe0) {
    const len = Math.floor((72 * BR[(d[i + 2] >> 4) & 15] * 1000) / SR[(d[i + 2] >> 2) & 3]) + ((d[i + 2] >> 1) & 1)
    frames.push(d.subarray(i, i + len))
    i += len
  }
  const body = Buffer.concat(frames.slice(1))
  return Buffer.concat(Array.from({ length: n }, () => body))
}

/** A podcast file for journey `id`, its audio a copy of `audio` (kept if there). */
function writePodcast(id: string, title: string, segments: object[], duration: number, audio: string) {
  const mp3 = path.join(journeysDir(), `${id}.mp3`)
  if (audio !== mp3 && !fs.existsSync(mp3)) fs.copyFileSync(audio, mp3)
  fs.writeFileSync(path.join(journeysDir(), `${id}.podcast.json`), JSON.stringify({
    version: 1, title, journey: { id }, audio: `${id}.mp3`, duration,
    segments: segments.map((x: any) => ({ speaker: 'host', ...x })),
  }))
}

/** The journey panel closed (the audio plays on in the Listen view). */
async function closePanel(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(t.input.viewType))
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
  await until('the panel closed', () => !pod().mapVisible, 5000)
}
/** The panel open on the journey listened to. */
async function openPanel(id: string): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.podcastOpen')
  await until('the panel shows it', () => tour().map === id && pod().mapVisible, 10000)
}
/** The Listen view's section collapsed (or open again) in the side bar, as a click on its header does. */
async function setListenCollapsed(collapsed: boolean): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.listen.focus')
  const page = await ui()
  const h = page.locator('.pane-header', { hasText: /^\s*listen/i }).first()
  if (((await h.getAttribute('aria-expanded')) === 'true') === collapsed) await h.click()
  await until(`the Listen view ${collapsed ? 'collapsed' : 'open'}`, async () => ((await h.getAttribute('aria-expanded')) === 'true') !== collapsed, 3000)
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
}
/** The play button's state in a player (its data-on: 'true' shows ⏸). */
async function playButtonOn(f: import('playwright').Frame): Promise<string> {
  return f.evaluate(() => (globalThis as any).document.querySelector('.pod-b.play').dataset.on)
}
/** The workbench's code editor showing a line tagged `tag`: how far it is scrolled right (px). */
async function scrollLeft(tag: string): Promise<number> {
  return (await editorBox(tag)).scrollLeft
}
async function editorBox(tag: string): Promise<{ scrollLeft: number; left: number; right: number; markLeft: number }> {
  const page = await ui()
  return page.evaluate((tg) => {
    const d = (globalThis as any).document
    for (const ed of d.querySelectorAll('.monaco-editor')) {
      const lines = ed.querySelector('.view-lines')
      if (!lines || !lines.textContent.includes(tg)) continue
      const box = ed.querySelector('.overflow-guard').getBoundingClientRect()
      const mini = ed.querySelector('.minimap')
      const right = box.right - (mini ? mini.getBoundingClientRect().width : 0) - 14
      let markLeft = -1
      const w = d.createTreeWalker(lines, 4)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const k = n.textContent.indexOf('FARMARK')
        if (k < 0) continue
        const r = d.createRange()
        r.setStart(n, k)
        r.setEnd(n, k + 1)
        markLeft = r.getBoundingClientRect().left
      }
      return { scrollLeft: -parseFloat(ed.querySelector('.lines-content').style.left || '0'), left: box.left, right, markLeft }
    }
    return { scrollLeft: -1, left: 0, right: 0, markLeft: -1 }
  }, tag)
}

/** One look while it plays: the audio's own time and state (Listen view), the extension's, the marks. */
interface Tick { ms: number; t: number; paused: boolean; waiting: string | undefined; playing: boolean; item: string; audioNow: number; focus: number[]; marksMatch: boolean }
/** Plays on until `done()`, looking every ~40 ms. */
async function watchPlay(done: () => boolean, ms: number, segs = WALK_SEGS): Promise<Tick[]> {
  const f = await listenFrame()
  const out: Tick[] = []
  const t0 = Date.now()
  while (!done()) {
    if (Date.now() - t0 > ms) throw new Error(`watching it play: not done in ${ms} ms: ${JSON.stringify(pod().camera.waits)}`)
    const a = await f.evaluate(() => { const x = (globalThis as any).document.querySelector('.pod audio'); return { t: x.currentTime, paused: x.paused } })
    const p = pod()
    const focus = p.marks.filter((m: any) => m.style === 'focus').map((m: any) => m.line + 1).sort((x: number, y: number) => x - y)
    const want = expectedFocus(segs, a.t).sort((x, y) => x - y)
    out.push({ ms: Date.now() - t0, t: a.t, paused: a.paused, waiting: p.camera.waiting, playing: p.playing, item: p.item, audioNow: p.audioNow,
      focus, marksMatch: JSON.stringify(focus) === JSON.stringify(want) || nearMark(segs, a.t) })
    await sleep(40)
  }
  return out
}
/** The waits watched: at least `min` made in full; in each, after its first 300 ms, the audio stood still and nothing
 *  said paused; after each, the marks lit are those at the audio's time. */
function checkWaits(ticks: Tick[], waits: any[], min: number): void {
  assert.ok(waits.filter((w) => w.ended === 'time').length >= min, `waits made: ${JSON.stringify(waits)}`)
  const runs: Tick[][] = []
  let cur: Tick[] | undefined
  for (const k of ticks) {
    if (k.waiting) { if (!cur) runs.push(cur = []); cur.push(k) } else cur = undefined
  }
  assert.ok(runs.length >= min, `waits seen while playing: ${runs.length}`)
  for (const run of runs) {
    const held = run.filter((k) => k.ms - run[0].ms > 300)
    if (!held.length) continue
    const ts = held.map((k) => k.t)
    assert.ok(Math.max(...ts) - Math.min(...ts) < 0.05 && held.every((k) => k.paused), `the audio stood still in the wait from ${run[0].t.toFixed(2)} s: ${JSON.stringify(held.map((k) => [k.t.toFixed(2), k.paused]))}`)
    assert.ok(run.every((k) => k.playing && /Listening/.test(k.item)), `nothing said paused in the wait: ${JSON.stringify(run.map((k) => [k.playing, k.item]))}`)
    const end = run[run.length - 1].ms
    const after = ticks.filter((k) => k.ms > end + 150 && k.ms < end + 1500)
    const off = after.filter((k) => !k.marksMatch)
    assert.equal(off.length, 0, `after the wait at ${run[0].t.toFixed(2)} s the marks are the audio's: ${JSON.stringify(off.slice(0, 3))}`)
  }
}
