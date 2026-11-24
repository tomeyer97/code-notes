// The editor while it plays, on the journey "podlisten": the step card, the follow lock, the view hold, the editor
// groups, what pauses it, the journey edited under it, quick ⏭, End Journey. Source: src/podcast/player.ts,
// follow.ts; src/tour/walk.ts, card.ts, panelLayout.ts. Each test watches the workbench console: no error from the
// extension's pages.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { sleep } from '../../helpers'
import { journey, step, writeJourney } from '../../fixtures'
import { ctx, journeysDir, tour } from '../context'
import { podcastFile, writeListenJourney } from './fixtures'
import {
  AFTER_OWN_MOVE_MS, at, closeAllButPanel, editorLayout, groupsShowing, listenTo, noChangeFor, outlast, pause, play,
  podTest, seek, seekTo, send, startPlaying, toggle,
} from './player'
import { codeEditor, codeFile, litLine, LOAD_MS, MOVE_MS, onScreen, pod, podUntil, QUICK_MS } from './state'
import { listenAudio } from './webview'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** "podlisten" as it is first written (the tests that rewrite it put it back). */
const writeListenOnce = () => { if (!fs.existsSync(podcastFile('podlisten'))) writeListenJourney() }
const listening = () => listenTo('podlisten', writeListenOnce)

export const listeningTests = [
  // Playing, the step card is its header line only (the player is the transport); a reader scrolling away opens
  // the follow lock (the editor stays where they are, Follow along brings it back); a part shorter than the view
  // hold in another file is held (a view stays at least 8 s); a seek shows its time exactly.
  podTest('listening › header card, follow lock, view hold', async () => {
    writeListenJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podlisten'), LOAD_MS)
    await closeAllButPanel()
    await startPlaying('podlisten')
    await pause()
    await seekTo(4.5, 'step 1, listen.ts line 12 lit', at(1, 'listen.ts', 12))
    // Paused: the full card, with ▶.
    await podUntil('the full card, ▶ Play on it', () => /▶ Play/.test(tour().card?.body ?? '') && /codeNotes\.askStep/.test(tour().card?.body ?? ''), QUICK_MS)
    await toggle()
    // Playing: the header line only (the player is the transport; the card's own Ask, More go).
    await podUntil('the header-only card', () => tour().card?.body === '', QUICK_MS)
    assert.equal(tour().card!.label, '1/3 · listen one', 'the header line stays')
    // The reader scrolls away on their own (well after the walk's own move).
    await outlast(AFTER_OWN_MOVE_MS, 'the walk\'s own move, so the scroll is the reader\'s')
    codeEditor()!.revealRange(new vscode.Range(185, 0, 185, 0), vscode.TextEditorRevealType.AtTop)
    await podUntil('not following: the card says Follow along', () => pod().follow === false && /Follow along/.test(tour().card?.body ?? ''), QUICK_MS)
    const top = () => codeEditor()!.visibleRanges[0].start.line
    const away = top()
    assert.ok(away >= 170, `scrolled: ${away}`)
    // Beat 2 (line 150, same file) at 12 s: lit, but the editor isn't moved.
    await podUntil('beat 2 lit at line 150', () => litLine() === 150, 12000)
    await noChangeFor(500, 'the editor moving to line 150')
    assert.ok(Math.abs(top() - away) <= 3 && !onScreen(150), `the editor stayed where the reader is (${away} → ${top()}, ${codeFile()}, follow ${pod().follow})`)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    await podUntil('Follow along: back at line 150', () => pod().follow === true && onScreen(150), QUICK_MS)
    // The view hold: beat 3 (20–23 s) is in listen2.ts for 3 s: held; step 2 at 23 s is listen.ts again.
    const shown: string[] = []
    const sub = vscode.window.onDidChangeVisibleTextEditors((es) => { for (const e of es) if (e.viewColumn !== tour().mapColumn && e.document.uri.scheme === 'file') shown.push(path.basename(e.document.uri.fsPath)) })
    try {
      await podUntil('step 2 at 23 s', () => tour().step === 2 && pod().t >= 23, 15000)
    } finally { sub.dispose() }
    assert.ok(!shown.includes('listen2.ts'), `a 3 s part in another file was held: ${shown.join(' → ')}`)
    assert.equal(codeFile(), 'listen.ts')
    await pause()
    // A seek shows its time exactly, held or not.
    await seekTo(21, 'seek to 21 s: beat 3 in listen2.ts', at(1, 'listen2.ts', 1))
  }, { consoleClean: true }),

  // The map's moments (the intro) give the map the editor area; the code comes back in one group beside it, never
  // in a group with a draft of the reader's.
  podTest('listening › the map\'s moments, the code beside it', async () => {
    await listening()
    await seekTo(1, 'the intro: no step, only the panel\'s group', () => tour().step === 0 && !pod().applying && vscode.window.tabGroups.all.length === 1)
    const layout = await editorLayout()
    assert.equal(layout.length, 1, 'the map has the editor area')
    await seekTo(5, 'step 1: the code beside the panel', () => tour().step === 1 && codeFile() === 'listen.ts' && vscode.window.tabGroups.all.length === 2)
    const share = async () => { const two = await editorLayout(); return two[tour().mapColumn! - 1] / two.reduce((a, b) => a + b, 0) }
    await podUntil('the panel at the walk\'s width again', async () => { const s = await share(); return s > 0.2 && s < 0.5 }, QUICK_MS)
    // A draft of the reader's in a group of its own.
    const draft = await vscode.workspace.openTextDocument({ content: 'my notes while listening' })
    await vscode.window.showTextDocument(draft, { viewColumn: vscode.window.tabGroups.all.length + 1, preview: false, preserveFocus: true })
    const draftGroup = () => vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === draft.uri.toString()))
    await seekTo(1, 'the intro again: the walk\'s code closed', () => tour().step === 0 && !pod().applying && !groupsShowing('listen.ts').length)
    await seekTo(5, 'step 1 again', () => tour().step === 1 && !pod().applying && groupsShowing('listen.ts').length === 1)
    await noChangeFor(400, 'the code opening in the draft\'s group too')
    assert.ok(!draftGroup()!.tabs.some((t) => t.input instanceof vscode.TabInputText && /listen\.ts$/.test(t.input.uri.path)), 'never in the draft\'s group')
    assert.equal(groupsShowing('listen.ts').length, 1, 'in one group only')
    // The draft put away (not saved).
    await vscode.window.showTextDocument(draft, { viewColumn: draftGroup()!.viewColumn, preserveFocus: false })
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
    await podUntil('the draft closed', () => !draftGroup(), QUICK_MS)
  }, { consoleClean: true }),

  // Focusing the panel, ‹ Journeys and the row of the journey you're in change no group's width and keep it
  // playing (the panel dragged down to VS Code's minimum, 220 px: focusing a group that narrow made VS Code expand
  // it); Ctrl+' V makes room for the map.
  podTest('listening › focusing the panel keeps the widths', async () => {
    await listening()
    if (tour().step !== 1) await seekTo(5, 'step 1: the code beside the panel', () => tour().step === 1 && codeFile() === 'listen.ts')
    await podUntil('two groups', () => vscode.window.tabGroups.all.length === 2, QUICK_MS)
    const panelAt = () => tour().mapColumn! - 1
    // Two groups side by side, nothing else (the draft's group, empty, may linger in the layout).
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] })
    await podUntil('two groups in the layout', async () => (await editorLayout()).length === 2, QUICK_MS)
    const start = await editorLayout()
    const total = start.reduce((a, b) => a + b, 0)
    const sized = (px: number) => ({ orientation: 0, groups: start.map((_, i) => ({ size: i === panelAt() ? px / total : 1 - px / total })) })
    await vscode.commands.executeCommand('vscode.setEditorLayout', sized(400))
    await outlast(800, 'VS Code laying the groups out (no event for it)')
    await vscode.commands.executeCommand('vscode.setEditorLayout', sized(150))
    await podUntil('the panel at the minimum', async () => (await editorLayout())[panelAt()] <= 221, QUICK_MS)
    await outlast(1000, 'VS Code laying the groups out (no event for it)')
    await play()
    const before = await editorLayout()
    const same = async (what: string) => {
      await noChangeFor(700, `${what}: a group resized`)
      const now = await editorLayout()
      assert.equal(now.length, before.length, `${what}: the groups`)
      now.forEach((w, i) => assert.ok(Math.abs(w - before[i]) <= 2, `${what}: group ${i + 1} was ${before[i]} px, now ${w} px`))
    }
    const focusGroup = (i: number) => vscode.commands.executeCommand(['workbench.action.focusFirstEditorGroup', 'workbench.action.focusSecondEditorGroup'][i])
    await focusGroup(panelAt())
    await same('the panel focused (Ctrl+1/2)')
    await focusGroup(1 - panelAt())
    ctx.api.mapSend({ type: 'test', click: '.homeb' })
    await same('‹ Journeys')
    // The row of the journey you're in (and Open Journey… on it): its panel to the front, nothing closed, still playing.
    await vscode.commands.executeCommand('codeNotes.openJourney', 'podlisten')
    await podUntil('its panel, the walk, still playing', () => tour().map === 'podlisten' && pod().mapVisible && pod().playing && pod().session === 'podlisten', QUICK_MS)
    await same('its row clicked')
    await pause()
    // The narrow panel: Ctrl+' V gives it the room for the map's boxes (asked for).
    await vscode.commands.executeCommand('codeNotes.showMap')
    await podUntil('Ctrl+\' V: room for the map', async () => (await editorLayout())[tour().mapColumn! - 1] >= 295, QUICK_MS)
    assert.equal(tour().map, 'podlisten', 'the same panel')
  }, { consoleClean: true }),

  // A question (Ask) or a note being written pauses it, and the code stays under it.
  podTest('listening › a question or a note pauses it', async () => {
    await listening()
    await seekTo(5, 'step 1', at(1, 'listen.ts', 12))
    await play()
    void vscode.commands.executeCommand('codeNotes.askStep')
    await podUntil('Ask: the box, the podcast paused', () => !!ctx.api.askBox() && !pod().playing && pod().held === 'question', QUICK_MS)
    const t0 = pod().t
    await noChangeFor(1500, 'the audio or the walk moving under the box')
    assert.ok(Math.abs(pod().t - t0) < 0.3 && tour().step === 1 && codeFile() === 'listen.ts', 'nothing moves under the box')
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
    await podUntil('the box put away', () => !ctx.api.askBox(), QUICK_MS)
    assert.ok(!pod().playing, 'still paused: ▶ (on the card) goes on')
    await play()
    // A note: Ctrl+' C on the narrated code.
    const ed = await vscode.window.showTextDocument(codeEditor()!.document, { viewColumn: codeEditor()!.viewColumn, preserveFocus: false })
    ed.selection = new vscode.Selection(12, 0, 12, 0)
    await vscode.commands.executeCommand('codeNotes.add')
    await podUntil('a note: paused', () => !pod().playing && pod().held === 'note', QUICK_MS)
    const t1 = pod().t
    await noChangeFor(2000, 'the audio or the walk moving under the draft')
    assert.ok(Math.abs(pod().t - t1) < 0.3 && tour().step === 1 && codeFile() === 'listen.ts', 'the draft\'s editor stays: nothing moves')
  }, { consoleClean: true }),

  // The journey edited under it keeps the step by id; a removed step shows what the podcast says at its time.
  podTest('listening › the journey edited under it', async () => {
    await listening()
    await seekTo(25, 'step 2 (L2)', () => tour().step === 2 && codeFile() === 'listen.ts' && !pod().applying)
    await outlast(300, 'the seek\'s last time report')
    const t0 = pod().t
    // Steps 1 and 2 swapped: L2 is step 1 now.
    writeListenJourney(['L2', 'L1', 'L3'])
    await podUntil('the walk on L2, now step 1', () => tour().step === 1 && tour().card?.title === 'listen two', MOVE_MS)
    await noChangeFor(1200, 'the audio moving after the journey changed')
    assert.ok(Math.abs(pod().t - t0) < 0.3, `the audio stayed at ${t0.toFixed(1)}: ${pod().t}`)
    writeListenJourney()
    await podUntil('back: L2 is step 2', () => tour().step === 2 && tour().card?.title === 'listen two', MOVE_MS)
    // L2 removed: its part keeps the view before it (beat 3 of L1, listen2.ts).
    writeListenJourney(['L1', 'L3'])
    const shows = (name: string) => vscode.window.visibleTextEditors.some((e) => e.viewColumn !== tour().mapColumn && path.basename(e.document.uri.fsPath) === name)
    await podUntil('the view before the removed step\'s part: step 1, beat 3 in listen2.ts', () => tour().step === 1 && shows('listen2.ts') && litLine() === 1 && !pod().applying, MOVE_MS)
    assert.ok(Math.abs(pod().t - t0) < 0.3, 'the audio stayed')
    writeListenJourney()
    await podUntil('the journey back', () => ctx.api.snapshot().journeys.some((j: any) => j.id === 'podlisten' && j.steps === 3), MOVE_MS)
  }, { consoleClean: true }),

  // Quick ⏭ ⏭ open only the last target; Next in the intro opens step 1; a beat it doesn't narrate, picked while
  // playing, is shown and pauses it.
  podTest('listening › quick ⏭ and an untold beat', async () => {
    await listening()
    await seekTo(1, 'the intro', () => tour().step === 0 && !pod().applying)
    const steps: number[] = []
    const poll = setInterval(() => { if (steps[steps.length - 1] !== tour().step) steps.push(tour().step) }, 15)
    try {
      await send({ action: 'part', dir: 1 })
      await sleep(80) // quick: the second ⏭ comes before the first one's move
      await send({ action: 'part', dir: 1 })
      await podUntil('two ⏭: step 2', () => tour().step === 2 && !pod().applying, MOVE_MS)
      await noChangeFor(400, 'step 1 opening late')
    } finally { clearInterval(poll) }
    assert.deepEqual(steps, [0, 2], `step 1 never opened on the way: ${steps.join(' → ')}`)
    // In the intro, after a seek there, Next (Ctrl+' D) opens step 1.
    await seekTo(1, 'the intro', () => tour().step === 0 && !pod().applying)
    await vscode.commands.executeCommand('codeNotes.next')
    await podUntil('Ctrl+\' D in the intro: step 1', () => tour().step === 1, MOVE_MS)
    // Beat 4 of step 1 isn't narrated: picked in the animation while playing, it is shown and the audio pauses.
    await play()
    await podUntil('its move done', () => !pod().applying, QUICK_MS)
    await outlast(600, 'the step\'s own reveal')
    ctx.api.mapMessage({ type: 'beat', n: 1, i: 3, user: true })
    await podUntil('paused, saying so', async () => !pod().playing && /Beat 4 isn't narrated/.test((await listenAudio()).note), QUICK_MS)
    await noChangeFor(800, 'the walk leaving step 1')
    assert.equal(tour().step, 1, 'the walk stays')
    assert.equal(litLine(), 14, 'beat 4 lit')
  }, { consoleClean: true }),

  // End Journey ends the session (▶ goes on where it was); in a journey without a podcast the key doesn't start
  // another one; after many seeks one walk tab and one panel are left (each seek's editors and webviews are closed,
  // not left behind).
  podTest('listening › End Journey, no podcast, nothing piles up', async () => {
    await listening()
    await play()
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await podUntil('ended: paused, no session, no status item', () => !pod().playing && !pod().session && !pod().itemShown, QUICK_MS)
    const kept = pod().t
    await toggle()
    await podUntil('▶ again: on from where it was, the walk back', () => pod().playing && pod().session === 'podlisten' && tour().step > 0 && pod().t >= kept - 0.3, MOVE_MS)
    await pause()
    // Another journey, without a podcast: Ctrl+' Space doesn't end it and restart this podcast.
    writeJourney(journeysDir(), journey('nopod', [step('src/listen.ts', 1, 2, { id: 'n1', title: 'no podcast' })], { title: 'No pod' }))
    await podUntil('nopod read', () => ctx.api.snapshot().journeys.some((j: any) => j.id === 'nopod'), MOVE_MS)
    await vscode.commands.executeCommand('codeNotes.startJourney', 'nopod')
    await podUntil('walking nopod', () => tour().journey === 'nopod' && tour().step === 1, MOVE_MS)
    await toggle()
    await noChangeFor(1200, 'the podcast starting')
    assert.equal(tour().journey, 'nopod', 'its walk goes on')
    assert.ok(!pod().playing, 'no other podcast started')
    // Many seeks later: one walk tab, one panel.
    await startPlaying('podlisten')
    await pause()
    // From no code tabs (a note's draft pins the tab it is in: the reader's own, kept beside the walk's).
    await closeAllButPanel()
    for (const t of [5, 25, 13, 1, 21, 33, 5, 25, 13, 21, 1, 5]) { await seek(t); await sleep(250) } // each seek's move under way
    await podUntil('settled', () => !pod().applying, MOVE_MS)
    await noChangeFor(500, 'a tab opening late')
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    const webviews = tabs.filter((t) => t.input instanceof vscode.TabInputWebview)
    const code = tabs.filter((t) => t.input instanceof vscode.TabInputText && /listen2?\.ts$/.test(t.input.uri.path))
    assert.equal(webviews.length, 1, `one panel: ${tabs.map((t) => t.label).join(', ')}`)
    assert.ok(code.length <= 1, `one walk tab: ${code.map((t) => `${t.label} (group ${t.group.viewColumn}${t.isPreview ? ', preview' : ''})`).join(', ')}`)
  }, { consoleClean: true }),
]
