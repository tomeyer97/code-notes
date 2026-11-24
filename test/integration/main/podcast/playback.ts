// Playing a podcast: where ▶ may start the sound, the walk following the voice, seeks, Next, the audio in a
// background tab, a long recording, a step the podcast skips, a rewritten podcast file, each journey's place, the
// panel closed and restored. Source: src/podcast/, media/journey-podcast.js, media/listen.js.
import * as vscode from 'vscode'
import * as path from 'path'
import assert from 'assert'
import { sleep, windowShot } from '../../helpers'
import { ui } from '../../devtools'
import { ctx, tour } from '../context'
import { WAV_S, writeAutoJourney, writeBeatJourney, writeGapJourney, writeGapPodcast, writePodJourney, writeWavJourney } from './fixtures'
import { at, closePanel, noChangeFor, pause, play, podTest, seek, seekTo, shots, startPlaying, toggle, listenTo } from './player'
import { LOAD_MS, MOVE_MS, pod, podUntil, QUICK_MS } from './state'
import { audioMoves, frameOf, listenAudio, realClick } from './webview'

/* eslint-disable @typescript-eslint/no-explicit-any */
const isPanelTab = (input: unknown) => input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(input.viewType)

export const playbackTests = [
  // VS Code lets a webview's audio play only after a click or a key in that webview (a click in the workbench or in
  // another webview does not count). Nothing has been clicked yet in this window, so this test runs first: the
  // unlock it makes lasts for the window. ▶ from a command plays in the panel after Space there; the panel closed,
  // the audio waits in the Listen view; a new panel plays after one real click on its ▶; one click in the Listen view
  // unlocks it too. No webview runs a test script before its click (`quiet`).
  podTest('podcast › ▶ plays wherever it is pressed', async () => {
    writeAutoJourney()
    await podUntil('the podcast is found', () => pod().journeys.includes('podauto'), LOAD_MS)
    if (pod().mapVisible) await closePanel()
    assert.deepEqual(pod().unlocked, { listen: false, panel: false }, 'no click in either player yet')
    await vscode.commands.executeCommand('codeNotes.journeys.focus')
    // Nothing listened to: no Listen view (nor its focus command), no transport in the palette, a plain row.
    assert.ok(!pod().listening && !pod().hostAlive, 'no Listen view before a journey is listened to')
    const idle = ctx.api.journeyRow('podauto')!
    assert.match(idle.description ?? '', /^♪ 0:40( · |$)/, `the row: its length: ${idle.description}`)
    assert.match(idle.contextValue!, /;podcast$/, 'its ▶ Listen')
    assert.doesNotMatch(String(idle.tooltip), /podcast|Listen/i, 'no podcast line in the tooltip')
    await shots('listen-idle', true)

    // 1. From a command (a Journeys row's ▶ Listen, the palette, the key): no webview may play yet. The audio goes to
    // the panel that opens, paused there, the panel and its ▶ take the keyboard: Space plays it. No hint text.
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podauto')
    await podUntil('refused in the Listen view: in the panel, paused, the panel focused', () => pod().hostIn === 'panel' && !pod().playing && pod().mapVisible && pod().error === 'NotAllowedError', LOAD_MS)
    const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input
    await podUntil('the panel is the active editor', () => isPanelTab(tab()), QUICK_MS)
    await sleep(800) // the focus inside the panel settles on its ▶ (no event for it)
    await (await ui()).keyboard.press('Space')
    await podUntil('Space in the panel: playing', () => pod().playing && pod().t > 0.5, MOVE_MS)
    const pf = await frameOf('journey', { quiet: true })
    await audioMoves(pf, 'played in the panel')
    assert.equal(await pf.evaluate(() => { const e = (globalThis as any).document.querySelector('.pod-err'); return e.hidden ? '' : e.textContent }), '', 'no hint or error line')
    assert.ok(pod().unlocked.panel && !pod().unlocked.listen, `the panel unlocked, the Listen view not: ${JSON.stringify(pod().unlocked)}`)

    // 2. Closing the panel: the audio goes to the Listen view, which may not play yet: it waits there, paused, where
    // it was (the one start that still needs a click: the status item or ▶ opens the panel again).
    const tClose = pod().t
    await closePanel()
    await podUntil('back in the Listen view, paused there', () => pod().hostIn === 'listen' && !pod().playing && pod().hostAlive, MOVE_MS)
    assert.ok(Math.abs(pod().t - tClose) < 2, `kept its place: ${tClose} → ${pod().t}`)
    assert.ok(pod().listening && pod().itemShown, 'paused with the panel closed: the Listen view and the status item')
    assert.match(pod().item, /^Paused · 0:\d\d$/, `the status item: ${pod().item}`)
    const paused = ctx.api.journeyRow('podauto')!
    assert.match(paused.description ?? '', /^♪ 0:40/, 'the row: its length')
    assert.doesNotMatch(paused.description ?? '', /Paused|Listening|step/, `the row says no more while paused: ${paused.description}`)
    assert.match(paused.contextValue!, /;podcast$/, 'its ▶ goes on where it was')
    await shots('listen-panel-closed-paused')

    // 3. A new panel (its audio locked too): one real click on its ▶ plays, there.
    await vscode.commands.executeCommand('codeNotes.podcastOpen')
    await podUntil('the panel shows it', () => tour().map === 'podauto' && pod().mapVisible, LOAD_MS)
    assert.ok(!pod().unlocked.panel, 'a new panel: its audio locked')
    const pf2 = await frameOf('journey', { quiet: true })
    await realClick(pf2, '.pod-b.play')
    await podUntil('the click on the panel\'s ▶: playing in the panel', () => pod().playing && pod().hostIn === 'panel', MOVE_MS)
    await audioMoves(pf2, 'the panel\'s ▶')
    assert.ok(Math.abs(pod().t - tClose) < 4, `on from where it was: ${tClose} → ${pod().t}`)

    // 4. Then a start from a command plays at once (the panel's audio may play now).
    await pause()
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podauto')
    await podUntil('a command plays at once', () => pod().playing, 4000)
    await audioMoves(pf2, 'started by a command')

    // 5. One click in the Listen view (its ▶, a remote now: it pauses) unlocks it for the window: the panel closing
    // then hands it the audio, and later starts play there with no click.
    await realClick(await frameOf('listen'), '.pod-b.play')
    await podUntil('the Listen view\'s ▶ paused it; the Listen view unlocked', () => !pod().playing && pod().unlocked.listen, MOVE_MS)
    await closePanel()
    await podUntil('the audio back in the Listen view', () => pod().hostIn === 'listen' && pod().hostAlive, MOVE_MS)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podauto')
    await podUntil('a command plays in the Listen view at once', () => pod().playing && pod().hostIn === 'listen', 6000)
    await audioMoves(await frameOf('listen'), 'in the Listen view')
    await pause()
  }),

  // Play opens the panel and the mp3 plays in VS Code's own Electron (fetched whole, as a blob); the status item and
  // the Journeys row while it plays; the voice reaches step 1 (its code opens, the animation lights beat 1's line);
  // pausing keeps the walk.
  podTest('podcast › plays in VS Code and the walk follows', async () => {
    writePodJourney()
    await podUntil('the podcast is found next to its journey (and not listed as a journey)', () => pod().journeys.includes('pod') && !ctx.api.snapshot().journeys.some((j: any) => /podcast/.test(j.id)), LOAD_MS)
    await startPlaying('pod')
    await podUntil('the Listen view has its audio', () => pod().hostAlive && pod().hostKey !== undefined, LOAD_MS)
    await podUntil('playing, the time moving', () => pod().playing && pod().t > 0.6, LOAD_MS)
    assert.equal(tour().step, 0, 'the intro: no step open')
    assert.match(pod().item, /^Listening · 0:0\d$/, `the status item's text: ${pod().item}`)
    assert.ok(!pod().itemShown, 'no status item while the panel (the player) is on screen')
    const row = ctx.api.journeyRow('pod')!
    assert.match(row.description ?? '', /^♪ 0:40/, 'the row: its length')
    assert.doesNotMatch(row.description ?? '', /Paused|Listening|step/, `the row says no more while it plays: ${row.description}`)
    assert.match(row.contextValue!, /;podcastPlaying$/, 'no ▶ and no ⏸ on the row while it plays')
    assert.notEqual(row.icon, 'unmute', 'no speaker icon')
    await podUntil('3 s: step 1 opened on its first beat', at(1, 'pod.ts', 1), MOVE_MS)
    await windowShot('podcast-playing', { wait: 300 })
    assert.ok(!tour().statusShown, 'the walk\'s "1/3" item steps aside while it is listened to')
    // Space for the podcast (Ctrl+' Space): paused, and the walk stays.
    await pause()
    await noChangeFor(500, 'the walk ending on a pause')
    assert.equal(tour().step, 1, 'pausing the podcast does not end the walk')
    assert.match(pod().item, /^Paused · 0:0\d$/, `paused: ${pod().item}`)
    assert.ok(!pod().itemShown && !tour().statusShown, 'paused, the panel on screen: no status item at all')
    await shots('listen-panel-open-paused', true)
  }),

  // A seek anywhere, forwards or backwards, puts the walk exactly where it is at that time; the extension's time is
  // what the audio itself says.
  podTest('podcast › a seek puts the walk at that time', async () => {
    await listenTo('pod', writePodJourney)
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
      await seekTo(t, `seek to ${t}s: the audio there, step ${n}, ${file ?? 'no file'}, line ${line} lit`, () => Math.abs(pod().t - t) < 0.5 && at(n, file, line)())
      const a = await listenAudio()
      assert.ok(Math.abs(a.t - t) < 0.5 && Math.abs(a.t - pod().t) < 0.5, `seek to ${t}s: the audio says ${a.t}, the extension has ${pod().t}`)
    }
    assert.ok((await listenAudio()).blob, 'the audio was loaded whole (a blob)')
    assert.ok(!pod().playing, 'seeking while paused stays paused')
  }),

  // Quick seeks (a drag, keys held) move the walk once, to the last one.
  podTest('podcast › quick seeks move the walk once', async () => {
    await listenTo('pod', writePodJourney)
    const before = pod().moves
    for (const t of [13, 4, 16, 1, 19, 10, 7]) { await seek(t); await sleep(30) } // 30 ms apart, as a drag sends them
    await podUntil('the last seek wins: step 1, beat 3', at(1, 'pod.ts', 3), MOVE_MS)
    await noChangeFor(400, 'a late move from an older seek')
    assert.ok(at(1, 'pod.ts', 3)(), 'and stays there (no late move from an older seek)')
    assert.ok(pod().moves - before <= 4, `fewer moves than seeks: ${pod().moves - before}`)
  }),

  // Next or Previous while it plays moves the audio to that step's first part; ← → skip 15 s.
  podTest('podcast › Next while playing moves the audio', async () => {
    await listenTo('pod', writePodJourney)
    await seekTo(4, 'step 1', at(1, 'pod.ts', 1))
    await play()
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await podUntil('Next: step 2 and the audio at its first part (9 s)', () => tour().step === 2 && pod().t >= 9 && pod().t < 11, MOVE_MS)
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await podUntil('Previous: step 1 and the audio at 3 s', () => tour().step === 1 && pod().t >= 3 && pod().t < 5.5, MOVE_MS)
    assert.ok(pod().playing, 'still playing')
    // Back / forward 15 s (Ctrl+' ← →).
    const t0 = pod().t
    await vscode.commands.executeCommand('codeNotes.podcastForward')
    await podUntil('forward 15 s', () => pod().t > t0 + 13, QUICK_MS)
    await vscode.commands.executeCommand('codeNotes.podcastBack')
    await podUntil('back 15 s', () => pod().t < t0 + 5, QUICK_MS)
    await pause()
  }),

  // The audio keeps playing, and the walk following it, while the panel is a background tab; it is not brought back
  // to the front.
  podTest('podcast › plays on in a background tab', async () => {
    await listenTo('pod', writePodJourney)
    await seekTo(19, 'step 3', at(3, 'pod2.ts', 0))
    // Another editor in the panel's group, in front of it. Not a file: those the extension moves out of the panel's
    // group. The Settings editor.
    const panelGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => isPanelTab(t.input)))!
    await vscode.commands.executeCommand(panelGroup.viewColumn === 1 ? 'workbench.action.focusFirstEditorGroup' : 'workbench.action.focusSecondEditorGroup')
    await vscode.commands.executeCommand('workbench.action.openSettings2')
    await podUntil('the panel is hidden', () => !pod().mapVisible)
    await toggle()
    await podUntil('playing while hidden', () => pod().playing, QUICK_MS)
    const t0 = pod().t
    await podUntil(`the time moves on while hidden (from ${t0})`, () => pod().t > t0 + 1.8, QUICK_MS)
    // (Step 3's 6 s in pod2.ts are held from step 2 while playing, VIEW_HOLD_S: the recap, 19 s, is not.)
    await podUntil('crossing 21 s while hidden: the recap, the walk ended', () => tour().step === 0 && pod().t > 21, MOVE_MS)
    const groups = () => vscode.window.tabGroups.all.map((g) => `${g.viewColumn}:${g.tabs.map((t) => `${t.label}${t.isActive ? '*' : ''}`).join(',')}`).join(' | ')
    assert.ok(!pod().mapVisible, `the panel was not brought back to front: ${groups()}`)
    await pause()
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  }),

  // A long recording (ten minutes of silence, a 4.8 MB WAV): a seek 9 minutes in plays from there.
  podTest('podcast › a long recording seeks 9 minutes in', async () => {
    writeWavJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podwav'), LOAD_MS)
    await startPlaying('podwav')
    await seek(WAV_S - 60)
    await podUntil('9 minutes in: step 2, the audio there and going on', () => tour().step === 2 && pod().t > 540.5 && pod().t < 545, LOAD_MS)
    await pause()
  }),

  // Next onto a step the podcast skips: the walk stays there, the audio pauses and says so; ▶ goes on after it.
  podTest('podcast › a step it skips pauses there', async () => {
    writeGapJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podgap'), LOAD_MS)
    await startPlaying('podgap')
    await seekTo(4, 'step 1', () => tour().step === 1 && pod().t >= 4)
    // Playing, Next is the player's ⏭ (one transport): the next part, step 3. Paused, it is the walk's Next.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await podUntil('playing: Next is ⏭, step 3 at 9 s', () => tour().step === 3 && pod().t >= 9 && pod().playing, MOVE_MS)
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await podUntil('⏮: step 1 again', () => tour().step === 1 && pod().t < 9, MOVE_MS)
    await pause()
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await podUntil('Next: step 2, the audio paused', () => tour().step === 2 && !pod().playing, QUICK_MS)
    await noChangeFor(1200, 'a late report taking the walk back')
    assert.equal(tour().step, 2, 'the walk stays on step 2 (no late report takes it back)')
    assert.ok(!pod().playing, 'still paused')
    assert.match((await listenAudio()).note, /isn't in the podcast/)
    await toggle()
    await podUntil('▶: on after step 2, at step 3\'s part (9 s), not back to step 1', () => pod().playing && tour().step === 3 && pod().t >= 9 && pod().t < 12, MOVE_MS)
    assert.equal((await listenAudio()).note, '', 'the note went once it played on')
    await pause()
  }),

  // The podcast file rewritten: the same moment of the same part, still playing; walk and audio agree.
  podTest('podcast › a rewritten file keeps the moment', async () => {
    await listenTo('podgap', writeGapJourney)
    if (tour().step !== 3) await seekTo(10, 'step 3', () => tour().step === 3 && !pod().applying)
    const t0 = pod().t
    // Step 3's part now starts 2 s earlier: the same place in it is 2 s earlier.
    writeGapPodcast(7)
    await podUntil(`the time follows its part: ${(t0 - 2).toFixed(1)}`, () => Math.abs(pod().t - (t0 - 2)) < 0.3, MOVE_MS)
    const a = await listenAudio()
    assert.ok(Math.abs(a.t - (t0 - 2)) < 0.3, `the audio is there too: ${a.t}`)
    assert.equal(tour().step, 3, 'the walk stays on step 3')
    await play()
    writeGapPodcast(9)
    await noChangeFor(1500, 'the rewrite stopping it')
    assert.ok(pod().playing && (await listenAudio()).paused === false, 'rewritten while playing: it plays on')
    assert.equal(tour().step, 3, 'still step 3')
    assert.ok(pod().t >= 9, `the same moment, moved back with its part: ${pod().t}`)
    await pause()
  }),

  // Each journey's place is kept: another journey, then ▶ goes on where it was.
  podTest('podcast › each journey keeps its place', async () => {
    writePodJourney()
    writeGapJourney()
    await startPlaying('pod')
    await seekTo(13, 'step 2', () => tour().step === 2 && pod().t >= 13)
    await pause()
    const kept = pod().t
    // Another journey: the walk leaves pod.
    await vscode.commands.executeCommand('codeNotes.startJourney', 'podgap')
    await podUntil('walking podgap', () => tour().journey === 'podgap' || tour().map === 'podgap', MOVE_MS)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'pod')
    await podUntil(`▶ pod: on from ${kept.toFixed(1)}, step 2 (not 0:00)`, () => pod().session === 'pod' && pod().playing && pod().t >= kept - 0.3 && pod().t < kept + 3 && tour().step === 2, LOAD_MS)
    await pause()
  }),

  // The intro closes the walk's code tab; a seek onto a beat in another file opens that file, never the step's
  // first.
  podTest('podcast › a beat in another file opens that file', async () => {
    writeBeatJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podbeat'), LOAD_MS)
    await startPlaying('podbeat')
    await pause()
    await seekTo(4, 'step 1, beat 1: pod.ts line 2 lit', at(1, 'pod.ts', 2))
    const walkTabs = () => vscode.window.tabGroups.all.filter((g) => g.viewColumn !== tour().mapColumn).flatMap((g) => g.tabs)
      .filter((t) => t.isPreview && t.input instanceof vscode.TabInputText && /pod2?\.ts$/.test(t.input.uri.path)).map((t) => t.label)
    assert.ok(walkTabs().length > 0, 'the walk opened its code in a preview tab')
    await seekTo(1, 'the intro: no step, the walk\'s preview tab closed', () => tour().step === 0 && !pod().applying && walkTabs().length === 0)
    // Every file the code group shows from here on.
    const shown: string[] = []
    const note = (u: vscode.Uri) => { if (u.scheme === 'file') shown.push(path.basename(u.fsPath)) }
    const subs = [
      vscode.window.onDidChangeVisibleTextEditors((es) => { for (const e of es) if (e.viewColumn !== tour().mapColumn) note(e.document.uri) }),
      vscode.window.tabGroups.onDidChangeTabs((e) => { for (const t of [...e.opened, ...e.changed]) if (t.input instanceof vscode.TabInputText) note(t.input.uri) }),
    ]
    try {
      await seekTo(7, 'step 1, beat 2: pod2.ts line 1 lit', at(1, 'pod2.ts', 1))
      await noChangeFor(300, 'pod.ts shown after it')
    } finally { subs.forEach((x) => x.dispose()) }
    assert.ok(!shown.includes('pod.ts'), `the step's own file was never shown first: ${shown.join(' → ')}`)
  }),

  // Closing the panel keeps it playing; the status item opens the map again, its player where the audio is.
  podTest('podcast › plays on with the panel closed', async () => {
    await listenTo('podbeat', writeBeatJourney)
    await vscode.commands.executeCommand('codeNotes.showMap')
    await podUntil('the panel', () => pod().mapVisible)
    await toggle()
    await podUntil('playing', () => pod().playing, QUICK_MS)
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await podUntil('the panel closed', () => !pod().mapVisible && tour().map === undefined, QUICK_MS)
    const t0 = pod().t
    await podUntil(`still playing without the panel (from ${t0})`, () => pod().playing && pod().t > t0 + 0.8, QUICK_MS)
    assert.ok(pod().itemShown && /^Listening · \d:\d\d$/.test(pod().item), `the status item, the panel closed: ${pod().item}`)
    await shots('listen-panel-closed-playing')
    assert.equal((await listenAudio()).paused, false, 'the audio itself plays on')
    // The status item's click: the map again, its player showing the audio's time and that it plays.
    await vscode.commands.executeCommand('codeNotes.podcastOpen')
    await podUntil('the map back', () => pod().mapVisible, MOVE_MS)
    const f = await frameOf('journey')
    await podUntil('the panel\'s player shows it playing, at the audio\'s time', async () => {
      const s = await f.evaluate(() => { const d = (globalThis as any).document; return { on: d.querySelector('.pod-b.play')?.dataset.on, time: d.querySelector('.pod-now')?.textContent } })
      const [m, sec] = String(s.time ?? '0:0').split(':').map(Number)
      return s.on === 'true' && Math.abs(m * 60 + sec - pod().t) <= 1.5
    }, MOVE_MS)
    // The panel's ▶ pauses the audio in the Listen view.
    await f.click('.pod-b.play')
    await podUntil('paused from the panel', () => !pod().playing, QUICK_MS)
  }),

  // A journey panel closed while VS Code restores it after a reload: nothing throws (it threw "Webview is disposed"
  // and failed the activation), the map and the place are kept.
  podTest('podcast › a restored panel closed at once', async () => {
    await listenTo('podbeat', writeBeatJourney)
    const map = tour().map
    const t0 = pod().t
    assert.ok(map && pod().session, 'a journey listened to, its map open')
    // VS Code hands the old panel over, the journeys are still being read, and the tab is closed meanwhile.
    let journeysRead!: () => void
    const ready = new Promise<void>((r) => { journeysRead = r })
    const panel = vscode.window.createWebviewPanel('codeNotes.journey', 'Restored', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true })
    const restoring = ctx.api.restorePanel(panel, ready)
    panel.dispose()
    journeysRead()
    await restoring
    assert.equal(tour().map, map, 'the open map is still the map')
    assert.ok(pod().mapVisible, 'and still on screen')
    assert.ok(Math.abs(pod().t - t0) < 0.5 && pod().session, `the listening place kept: ${t0} → ${pod().t}`)
    await toggle()
    await podUntil('it still plays', () => pod().playing, QUICK_MS)
    await toggle()
    await podUntil('paused', () => !pod().playing, QUICK_MS)
  }),
]
