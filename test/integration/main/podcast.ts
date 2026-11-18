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

export const podcastTests = [
  test('podcast: a journey with a podcast file can be played; Play opens the panel and the mp3 plays in VS Code', async () => {
    writePodJourney()
    await until('the podcast is found next to its journey (and not listed as a journey)', () => pod().journeys.includes('pod') && !ctx.api.snapshot().journeys.some((j: any) => /podcast/.test(j.id)), 10000)
    console.log(`    (VS Code window focused: ${vscode.window.state.focused})`)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await until('the panel shows it', () => tour().map === 'pod' && pod().mapVisible, 10000)
    await until('the Listen view has its audio', () => pod().hostAlive && pod().hostKey !== undefined, 10000)
    // VS Code's webviews play audio only after a click or key in them: the first Play asks for one in the Listen
    // view, its ▶ focused.
    await until('the first Play, from a command: refused until a click in the Listen view', () => pod().error === 'NotAllowedError' || pod().playing, 10000)
    if (!pod().playing) {
      const f = await listenFrame()
      await until('▶ has the keyboard', async () => (await f.evaluate(() => (globalThis as any).document.activeElement?.className)) === 'pod-b play', 5000)
      assert.match(await f.evaluate(() => (globalThis as any).document.querySelector('.pod-err').textContent), /Space/)
      await windowShot('podcast-first-play', { wait: 300 })
      await f.click('.pod-b.play')
    }
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
    // At 14 s: marks 1-4 are lit (10.88, 12.38, 13.88 twice); 3 and 4 are said with the same words: both the focus.
    const want = [
      markAt(3, 'needsModel(steps)', 1, 'dim'),
      markAt(3, 'strict', 2, 'dim'),
      markAt(4, 'reject(400)', 1, 'focus'),
      { line: 4, col: 2, endLine: 5, endCol: MARK_LINES[5].length, text: '}\n  return ok()', style: 'focus' },
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
    await until('"right there": two places at once', () => pod().marks.filter((m: any) => m.style === 'focus').length === 2, 5000)
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
    codeEditor()!.revealRange(new vscode.Range(90, 0, 90, 0), vscode.TextEditorRevealType.AtTop)
    await until('not following', () => pod().follow === false, 5000)
    const top = codeEditor()!.visibleRanges[0].start.line
    await until('line 180 lit', () => pod().marks.some((m: any) => m.line === 179), 6000)
    await sleep(500)
    assert.ok(Math.abs(codeEditor()!.visibleRanges[0].start.line - top) <= 1 && !shows(179), 'the editor stayed where the reader is')
    await vscode.commands.executeCommand('codeNotes.podcastToggle')
    await until('paused', () => !pod().playing)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
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
  // A new Listen view may need one click on ▶ (the webview plays only after one); `error` may be a stale
  // NotAllowedError, so playing on its own is waited for first. One click only: a second would pause it.
  if (!(await until('playing on its own', () => pod().playing, 3000).catch(() => false))) {
    const f = await listenFrame()
    await until('▶ has the keyboard', async () => (await f.evaluate(() => (globalThis as any).document.activeElement?.className)) === 'pod-b play', 5000)
    await f.click('.pod-b.play')
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
