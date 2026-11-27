// Camera moves: time to read before the code moves (readBeforeMove), a heads-up, a moment after (settleAfterMove);
// the walk keeps time with the voice wherever the Listen view is, never a lag. Source: src/podcast/camera.ts,
// cameraRules.ts, markScheduler.ts.
import * as vscode from 'vscode'
import assert from 'assert'
import { sleep, SCALE } from '../../helpers'
import { ctx, tour } from '../context'
import { CAM_FAR_LINE, Cue, FAR_MARKER, focusAt, LONG_CUES, LONG_S, LONG_SEGS, nearCue, WALK_CUES, WALK_FROM, writeCamJourney, writeLongJourney, writeWalkJourney, writeWideJourney } from './fixtures'
import {
  AFTER_OWN_MOVE_MS, AFTER_SEEK_MS, closeAllButPanel, closePanel, listenTo, noChangeFor, openPanel, outlast, pause, play,
  podTest, seekTo, send, setListenCollapsed, startPlaying, toggle,
} from './player'
import { codeEditor, LOAD_MS, litLine, MOVE_MS, onScreen, pod, podUntil, QUICK_MS } from './state'
import { editorBox, frameOf, listenAudio, playButtonOn, panelText, scrollLeft } from './webview'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Is a mark lit on `line` (1-based; the snapshot's lines are 0-based), as the focus when `focus`? */
const litOn = (line: number, focus = false) => pod().marks.some((m: any) => m.line === line - 1 && (!focus || m.style === 'focus'))

/**
 * Looks (`look`) every ~`every` ms until `done(last look)`, and returns every look: a test records what happened
 * while it plays, then asserts on the record. Fails after `ms`.
 */
async function record<T>(look: () => Promise<T>, done: (last: T) => boolean, ms: number, every = 40): Promise<T[]> {
  const out: T[] = []
  const t0 = Date.now()
  for (;;) {
    const k = await look()
    out.push(k)
    if (done(k)) return out
    if (Date.now() - t0 > ms) throw new Error(`watching it play: not done in ${ms} ms: ${JSON.stringify(pod().camera.waits)}`)
    await sleep(every)
  }
}

/** One look while it plays: the audio's own time and state (Listen view), the extension's, the focus marks. */
interface Tick { ms: number; t: number; paused: boolean; waiting: string | undefined; playing: boolean; item: string; audioNow: number; focus: number[]; marksMatch: boolean }
/** Plays on until `done()`, looking every ~40 ms; `cues`: when which marks light (fixtures.ts). */
async function watchPlay(done: () => boolean, ms: number, cues: Cue[] = WALK_CUES): Promise<Tick[]> {
  const f = await frameOf('listen')
  const t0 = Date.now()
  const ticks = await record<Tick>(async () => {
    const a = await f.evaluate(() => { const x = (globalThis as any).document.querySelector('.pod audio'); return { t: x.currentTime, paused: x.paused } })
    const p = pod()
    const focus = p.marks.filter((m: any) => m.style === 'focus').map((m: any) => m.line + 1).sort((x: number, y: number) => x - y)
    const want = [...focusAt(cues, a.t)].sort((x, y) => x - y)
    return { ms: Date.now() - t0, t: a.t, paused: a.paused, waiting: p.camera.waiting, playing: p.playing, item: p.item, audioNow: p.audioNow,
      focus, marksMatch: JSON.stringify(focus) === JSON.stringify(want) || nearCue(cues, a.t) }
  }, () => done(), ms)
  return ticks.slice(0, -1) // the last look is the one that saw it done
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

const onBeat = (what = 'back on the beat') => seekTo(4.3, what, () => litLine() === 3 && !pod().applying && onScreen(3))
const onWalkBeat = () => seekTo(WALK_FROM, 'back on the beat', () => litLine() === 3 && !pod().applying)

export const cameraTests = [
  // A mark out of view waits for the read time, shows a heads-up first (the edge cue), settles after; one in view
  // never waits. A wait is no pause: the audio holds, the status still says Listening, no line under the player.
  podTest('camera › waits to read before a far move', async () => {
    writeCamJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podcam'), LOAD_MS)
    await closeAllButPanel()
    await startPlaying('podcam')
    await pause()
    await seekTo(4.3, 'step 1, its beat on line 3', () => tour().journey === 'podcam' && litLine() === 3 && !pod().applying)
    await outlast(AFTER_SEEK_MS, 'no camera wait right after a seek')
    const before = pod().camera.waits.length
    await toggle()
    // Watched every 30 ms: the cue, the wait, the far line on screen, the audio.
    const f = await frameOf('listen')
    const t0 = Date.now()
    const looks = await record(async () => {
      const c = pod().camera
      const a = await f.evaluate(() => { const d = (globalThis as any).document; const e = d.querySelector('.pod-err'); return { paused: d.querySelector('.pod audio').paused, note: e.hidden ? '' : e.textContent } })
      return { ms: Date.now() - t0, cue: c.cue, waiting: c.waiting !== undefined, shown: onScreen(CAM_FAR_LINE), paused: a.paused, note: a.note, playing: pod().playing, item: pod().item,
        done: c.waits.length > before && c.waits[before].ended === 'time' && pod().playing }
    }, (k) => k.done, 12000 * SCALE, 30)
    const w = pod().camera.waits[before]
    assert.equal(w.where, `↓ ${CAM_FAR_LINE}`, `the first wait is the move to line ${CAM_FAR_LINE} (line 5, in view, never waited): ${JSON.stringify(pod().camera.waits.slice(before))}`)
    const cueAt = looks.find((k) => k.cue === `↓ ${CAM_FAR_LINE}`)?.ms
    const shownAt = looks.find((k) => k.shown)?.ms
    const waitAt = looks.find((k) => k.waiting)?.ms
    const inWait = waitAt === undefined ? undefined : looks.find((k) => k.waiting && k.ms - waitAt >= 300)
    const seen = { cueAt, waitAt, shownAt, inWait }
    // Line 5 lit at 5.88 s; the far line due at 6.88 s: 1.5 s of the 2.5 s read time left, then 0.8 s settle.
    assert.ok(w.read >= 1.0 && w.read <= 2.2, `read wait ${JSON.stringify(pod().camera.waits.slice(before))} ${JSON.stringify(seen)}`)
    assert.ok(w.settle >= 0.7 && w.settle <= 1.3, `settle ${w.settle}`)
    assert.ok(cueAt !== undefined && shownAt !== undefined && cueAt < shownAt, `the heads-up before the move: ${JSON.stringify(seen)}`)
    assert.ok(inWait?.paused, `the audio waits: ${JSON.stringify(seen)}`)
    assert.equal(inWait.note, '', 'no line under the player: the edge cue says it')
    assert.ok(inWait.playing && /Listening/.test(inWait.item), 'a wait is no pause: still Listening')
    assert.ok(onScreen(CAM_FAR_LINE), `line ${CAM_FAR_LINE} on screen`)
    await pause()
  }, { waits: [2.5, 0.8] }),

  // No wait after the reader's own seek, none under the follow lock; playing on (a headset key, another ▶) ends a
  // wait, Space in one pauses (the move dropped).
  podTest('camera › when it does not wait', async () => {
    await listenTo('podcam', writeCamJourney)
    // A seek right before the far mark: it moves without waiting.
    await seekTo(6.5, 'back on the beat', () => litLine() === 3 && !pod().applying && onScreen(3))
    let n = pod().camera.waits.length
    await toggle()
    await podUntil(`line ${CAM_FAR_LINE} lit and on screen`, () => litOn(CAM_FAR_LINE) && onScreen(CAM_FAR_LINE), QUICK_MS)
    assert.equal(pod().camera.waits.length, n, `no wait after a seek: ${JSON.stringify(pod().camera.waits.slice(n))}`)
    await pause()
    // The follow lock: the reader scrolls away; the far mark lights where it is, nothing waits, nothing moves.
    await onBeat()
    await play()
    await outlast(AFTER_SEEK_MS, 'the seek\'s own move, so the scroll is the reader\'s')
    codeEditor()!.revealRange(new vscode.Range(100, 0, 100, 0), vscode.TextEditorRevealType.AtTop)
    await podUntil('not following', () => pod().follow === false, QUICK_MS)
    n = pod().camera.waits.length
    await podUntil(`line ${CAM_FAR_LINE} lit`, () => litOn(CAM_FAR_LINE), 6000)
    await noChangeFor(600, 'a wait or a move under the follow lock')
    assert.ok(pod().playing && pod().camera.waits.length === n && !onScreen(CAM_FAR_LINE), `under the follow lock: no wait, no move (${JSON.stringify(pod().camera)})`)
    await pause()
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    // Played on during a wait: it plays on at once, the walk at the audio's time.
    await onBeat()
    await outlast(AFTER_SEEK_MS, 'no camera wait right after a seek')
    n = pod().camera.waits.length
    await toggle()
    await podUntil('a wait', () => pod().camera.waiting === 'read', 6000)
    await send({ action: 'play' })
    await podUntil(`played on: no wait, line ${CAM_FAR_LINE} on screen`, () => pod().audible && !pod().camera.waiting && onScreen(CAM_FAR_LINE), 3000)
    assert.equal(pod().camera.waits[n]?.ended, 'skip')
    // Space in a wait is the reader's pause (the player showed ⏸): paused, the move dropped.
    await onBeat()
    await outlast(AFTER_SEEK_MS, 'no camera wait right after a seek')
    n = pod().camera.waits.length
    await podUntil('a wait', () => pod().camera.waiting === 'read', 6000)
    await toggle()
    await podUntil('paused by the reader', () => !pod().playing && !pod().camera.waiting, 3000)
    assert.equal(pod().camera.waits[n]?.ended, 'cancel')
    await noChangeFor(600, 'the wait resuming it')
    assert.ok((await listenAudio()).paused && !pod().playing, 'it stays paused: the wait does not resume it')
  }, { waits: [2.5, 0.8] }),

  // Playing on through out-of-view moves with the Listen view collapsed and the panel closed: the audio holds in
  // each wait, nothing says paused, the marks are the audio's after each move.
  podTest('camera › holds while collapsed', async () => {
    writeWalkJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podwalk'), LOAD_MS)
    await closeAllButPanel()
    await startPlaying('podwalk')
    await pause()
    await seekTo(WALK_FROM, 'step 1 on its beat', () => tour().journey === 'podwalk' && litLine() === 3 && !pod().applying)
    // The map panel closed (the audio plays on in the Listen view), the Listen view collapsed.
    await closePanel()
    await setListenCollapsed(true)
    try {
      await outlast(AFTER_SEEK_MS, 'no camera wait right after a seek')
      const before = pod().camera.waits.length
      await toggle()
      const ticks = await watchPlay(() => pod().camera.waits.length - before >= 4 && !pod().camera.waiting, 30000)
      await pause()
      checkWaits(ticks, pod().camera.waits.slice(before), 4)
    } finally {
      await setListenCollapsed(false)
    }
  }, { waits: [1.2, 0.6] }),

  // A hold the audio ignores is dropped within ~300 ms and the walk goes to what is said now; waits are off for a
  // while after.
  podTest('camera › an ignored hold is dropped', async () => {
    await listenTo('podwalk', writeWalkJourney, { panel: false })
    await onWalkBeat()
    await outlast(2600, 'the seek\'s move and a read time (2.5 s) it may have started')
    const before = pod().camera.waits.length
    ctx.api.listenIgnorePauses(true)
    try {
      await toggle()
      // Until delta (line 350) is the focus.
      const ticks = await watchPlay(() => litOn(350, true) && !pod().camera.waiting, 20000)
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
    await pause()
  }, { waits: [2.5, 0.8] }),

  // A wait is no pause: the card a header line, the status Listening, ⏸ in both players, no line under them. The
  // reader scrolling in small steps opens the follow lock and ends the wait; the card changing size does not. A long
  // read time: the wait starts before the code moves (the reader's scroll is theirs then).
  podTest('camera › a wait is no pause; a scroll ends it', async () => {
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    await listenTo('podwalk', writeWalkJourney, { panel: false })
    await openPanel('podwalk')
    await onWalkBeat()
    await outlast(AFTER_SEEK_MS, 'no camera wait right after a seek')
    const n = pod().camera.waits.length
    await toggle()
    await podUntil('a wait', () => pod().camera.waiting === 'read', MOVE_MS)
    const a = await podUntil('the audio holds', async () => { const x = await listenAudio(); return x.paused && x }, QUICK_MS)
    assert.equal(a.note, '', 'no line under the player')
    assert.match(pod().item, /^Listening: .+ · /, `the status item: ${pod().item}`)
    assert.equal(tour().card?.body ?? '', '', 'the step card stays its header line')
    assert.equal(await playButtonOn(await frameOf('listen')), 'true', 'the Listen view shows ⏸')
    assert.equal(await playButtonOn(await frameOf('journey')), 'true', 'the panel shows ⏸')
    assert.equal(await panelText('.pod-err'), '', 'no line under the panel\'s player')
    // The reader scrolls one line at a time: together it is a scroll.
    const ed = codeEditor()!
    const top0 = ed.visibleRanges[0].start.line
    await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false })
    for (let i = 1; i <= 5; i++) {
      await vscode.commands.executeCommand('editorScroll', { to: 'down', by: 'line', value: 1 })
      await sleep(120) // one line at a time, as a wheel's small steps come
    }
    await podUntil('not following; the wait ended, playing on', () => pod().follow === false && !pod().camera.waiting && pod().audible, 3000)
    assert.equal(pod().camera.waits[n]?.ended, 'release')
    assert.ok(ed.visibleRanges[0].start.line >= top0 + 3, `the reader stays where they scrolled (${top0} → ${ed.visibleRanges[0].start.line})`)
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
    // Pause and play with the card on screen: its size changes, nobody scrolled.
    await outlast(AFTER_OWN_MOVE_MS, 'the follow\'s own move')
    await pause()
    await podUntil('the full card', () => /▶ Play/.test(tour().card?.body ?? ''), 3000)
    await outlast(AFTER_OWN_MOVE_MS, 'the card\'s resize counted as the walk\'s own move')
    await play()
    await noChangeFor(800, 'the follow lock opening')
    assert.equal(pod().follow, true, `the card changing size is not the reader (${pod().unlock})`)
    await pause()
  }, { waits: [6, 0.8] }),

  // A mark brought on screen keeps column 1 in view; the code scrolls right only for a mark that starts past the
  // edge (just enough to show its start).
  podTest('camera › column 1 stays in view', async () => {
    writeWideJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podwide'), LOAD_MS)
    await startPlaying('podwide')
    await pause()
    await seekTo(4.2, 'step 1 on its beat', () => tour().journey === 'podwide' && litLine() === 2 && !pod().applying)
    await outlast(AFTER_SEEK_MS, 'the seek\'s own move')
    // The reader's editor scrolled right before (as after an earlier long line).
    const ed = codeEditor()!
    ed.revealRange(new vscode.Range(1, 250, 1, 251), vscode.TextEditorRevealType.Default)
    await podUntil('scrolled right', async () => (await scrollLeft('wide1')) > 100, 3000)
    await outlast(AFTER_SEEK_MS, 'the reveal counted as the walk\'s own move')
    await toggle()
    const shows = (line: number) => ed.visibleRanges.some((r) => r.contains(new vscode.Position(line - 1, 0)))
    // A long mark starting at column 9 on line 150: shown from column 1.
    await podUntil('line 150 lit and on screen', () => litOn(150) && shows(150), 6000)
    await noChangeFor(1000, 'the editor scrolling right')
    assert.equal(await scrollLeft('wide150'), 0, `column 1 in view: ${JSON.stringify(await editorBox('wide150', FAR_MARKER))}`)
    // A mark starting at column 260 on line 300: scrolled right just enough to show its start.
    await podUntil('line 300 lit and on screen', () => litOn(300) && shows(300), 6000)
    await podUntil('scrolled right to it', async () => (await scrollLeft('wide300')) > 0, 3000).catch(() => undefined) // asserted below, with the numbers
    await outlast(400, 'the editor\'s scroll')
    const left = await scrollLeft('wide300')
    const view = await editorBox('wide300', FAR_MARKER)
    assert.ok(left > 0 && view.markLeft >= view.left && view.markLeft < view.right, `the mark's start is shown (scrollLeft ${left}, ${JSON.stringify(view)})`)
    await pause()
  }),

  // Ten minutes at 2× with camera waits and out-of-view moves: at the end the extension's time, both captions and
  // the lit marks are the audio's.
  podTest('camera › a long run at 2× stays in time', async () => {
    writeLongJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podlong'), LOAD_MS)
    // Ten minutes of audio take a moment to load (it is fetched whole) before it plays on its own; from the start.
    await startPlaying('podlong', { ownMs: 12000 })
    await seekTo(0, 'from the start', () => pod().t < 3 && pod().playing)
    await send({ action: 'rate', rate: 2 })
    await podUntil('at 2×', () => pod().playing, QUICK_MS)
    const before = pod().camera.waits.length
    await podUntil('near the end', async () => (await listenAudio()).t > LONG_S - 25, (LONG_S / 2) * 1000 + 60000)
    const waits = pod().camera.waits.slice(before)
    assert.ok(waits.filter((w: any) => w.ended === 'time').length >= 5, `camera waits made: ${JSON.stringify(waits.slice(0, 8))}`)
    // At the end, playing: one moment, read together.
    const f = await frameOf('listen')
    const pf = await frameOf('journey')
    const a = await f.evaluate(() => { const d = (globalThis as any).document; return { t: d.querySelector('.pod audio').currentTime, cap: d.querySelector('.pod-cap-t').textContent } })
    const ext = pod().audioNow
    const pcap = await pf.evaluate(() => (globalThis as any).document.querySelector('.pod-cap-t').textContent)
    await pause()
    await noChangeFor(400, 'the marks changing after the pause')
    assert.ok(Math.abs(ext - a.t) < 0.3, `the extension's time ${ext} vs the audio's ${a.t} (${waits.length} waits)`)
    const seg = LONG_SEGS.find((x) => a.t >= x.start && a.t < x.end)!
    assert.ok(seg && a.cap && seg.text.includes(a.cap.trim()), `the Listen view's caption is the segment at ${a.t}: "${a.cap}" in "${seg?.text}"`)
    assert.ok(pcap && seg.text.includes(pcap.trim()), `the panel's caption too: "${pcap}"`)
    const paused = await f.evaluate(() => (globalThis as any).document.querySelector('.pod audio').currentTime)
    const got = pod().marks.filter((m: any) => m.style === 'focus').map((m: any) => m.line + 1)
    assert.deepEqual(got, focusAt(LONG_CUES, paused), `the lit marks are the audio's at ${paused}`)
  }, { waits: [1.0, 0.4] }),
]
