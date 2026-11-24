// Marks: the code highlighted as the words are said, on the journey "podmarks". Source: src/podcast/markLights.ts,
// markScheduler.ts.
import * as vscode from 'vscode'
import assert from 'assert'
import { tour } from '../context'
import { END_LINE, markAt, writeMarksJourney } from './fixtures'
import { AFTER_OWN_MOVE_MS, closeAllButPanel, listenTo, noChangeFor, outlast, pause, play, podTest, seek, seekTo, startPlaying } from './player'
import { codeEditor, codeFile, LOAD_MS, litLine, onScreen, pod, podUntil, QUICK_MS } from './state'
import { listenAudio } from './webview'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The marks lit are exactly `want` (any order). */
function sameMarks(got: any[], want: object[]): boolean {
  const key = (m: any) => JSON.stringify([m.line, m.col, m.endLine, m.endCol, m.text, m.style])
  return got.length === want.length && want.every((w) => got.some((g) => key(g) === key(w)))
}
/** Is a mark lit on `line` (1-based; the snapshot's lines are 0-based), as the focus when `focus`? */
const litOn = (line: number, focus = false) => pod().marks.some((m: any) => m.line === line - 1 && (!focus || m.style === 'focus'))

const onMarks = () => listenTo('podmarks', writeMarksJourney)

export const marksTests = [
  // A seek shows exactly the marks said by then, to the character, the newest the focus; back again takes them away.
  podTest('marks › a seek lights those said by then', async () => {
    writeMarksJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podmarks'), LOAD_MS)
    await closeAllButPanel()
    await startPlaying('podmarks')
    await pause()
    await seekTo(14, 'step 1, its beat on line 3', () => tour().journey === 'podmarks' && tour().step === 1 && codeFile() === 'marks.ts' && litLine() === 3 && !pod().applying)
    // At 14 s: marks 1-4 are lit (10.88, 12.38, 13.88 twice); 3 and 4 are said with the same words: both the focus
    // (4 is whole lines: each line from its text).
    const want = [
      markAt(3, 'needsModel(steps)', 1, 'dim'),
      markAt(3, 'strict', 2, 'dim'),
      markAt(4, 'reject(400)', 1, 'focus'),
      markAt(5, '}', 1, 'focus'),
      markAt(6, 'return ok()', 1, 'focus'),
    ]
    await podUntil('the four marks at 14 s', () => sameMarks(pod().marks, want), QUICK_MS)
    // Back to 11 s: only the first, now the focus.
    await seek(11)
    await podUntil('back at 11 s: one mark, the focus', () => sameMarks(pod().marks, [{ ...want[0], style: 'focus' }]), QUICK_MS)
    await seek(10.5)
    await podUntil('before the first mark: none', () => pod().marks.length === 0, QUICK_MS)
    assert.equal(litLine(), 3, 'the beat\'s own line stays lit')
  }),

  // Playing, each mark lights on time (0.12 s before its word, as the audio says it, not the last report); the next
  // segment clears them.
  podTest('marks › each lights on time while playing', async () => {
    await onMarks()
    await seek(12)
    await podUntil('at 12 s: the first mark', () => pod().marks.length === 1 && !pod().applying, QUICK_MS)
    await play()
    // "strict is set" lights at 10 + 2.5 - 0.12 = 12.38 s.
    await podUntil('"strict" lit', () => pod().marks.some((m: any) => m.text === 'strict'), QUICK_MS)
    const audioT = (await listenAudio()).t
    assert.ok(audioT >= 12.38 - 0.1 && audioT <= 12.38 + 0.5, `lit at ${audioT.toFixed(2)} s (due 12.38)`)
    await podUntil('"right there": two places at once', () => pod().marks.filter((m: any) => m.style === 'focus').length === 3, QUICK_MS)
    await seek(19.4)
    await podUntil('the next segment: none lit', () => pod().t > 20.1 && pod().marks.length === 0, 6000)
    await pause()
  }),

  // An off-screen mark is scrolled to, but never under a reader looking around (the follow lock).
  podTest('marks › an off-screen mark is scrolled to', async () => {
    await onMarks()
    // Following: "at the end" (END_LINE, far down) lights at 15.88 s and is brought on screen.
    await seekTo(14.5, 'the beat on screen', () => litLine() === 3 && !pod().applying && onScreen(3))
    await play()
    await podUntil(`line ${END_LINE} lit and on screen`, () => litOn(END_LINE, true) && onScreen(END_LINE), QUICK_MS)
    // Looking around: the reader scrolls away; the mark lights where it is, the editor stays.
    await pause()
    await seekTo(12, `back on the beat, line ${END_LINE} not lit`, () => onScreen(3) && !pod().applying && !litOn(END_LINE))
    await play()
    await outlast(AFTER_OWN_MOVE_MS, 'the walk\'s own move, so the scroll is the reader\'s')
    codeEditor()!.revealRange(new vscode.Range(40, 0, 40, 0), vscode.TextEditorRevealType.AtTop)
    await podUntil('not following', () => pod().follow === false, QUICK_MS)
    const top = codeEditor()!.visibleRanges[0].start.line
    await podUntil(`line ${END_LINE} lit`, () => litOn(END_LINE), 6000)
    await noChangeFor(500, `the editor moving to line ${END_LINE}`)
    const now = codeEditor()!.visibleRanges[0]
    assert.ok(Math.abs(now.start.line - top) <= 1 && !onScreen(END_LINE), `the editor stayed where the reader is (top ${top} → ${now.start.line}-${now.end.line})`)
    await pause()
    await vscode.commands.executeCommand('codeNotes.podcastFollow')
  }),
]
