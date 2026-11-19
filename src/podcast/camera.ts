// Camera moves (docs/podcast-format.md, "Camera moves"): while a podcast plays, the narrated editor scrolls or
// switches files when the next mark or beat is out of view. Quick moves leave no time to read what was just lit, so
// every such move goes through here: a heads-up cue at the editor's edge shortly before ("↓ 340", "↑ 212",
// "→ main.ts"); before leaving, the latest mark or beat of the view on screen must have been lit READ seconds (the
// audio waits); after arriving, the audio waits SETTLE seconds more with the new mark lit. A wait is a hold, not a
// pause: the player, the status item, the rows and the step card go on showing it playing; the edge cue is all that
// says it. No waits for the reader's own seeks, under the follow lock, or on the map: the player decides that
// (`move`'s `wait`).
//
// The walk never lags the voice: the hold is checked against the audio's own reports. When the audio did not stop
// (its time still moving PAUSE_CHECK_MS after asking), the wait is dropped and the walk is put where the audio is now
// (`resync`), and waits stay off for WAITS_OFF_MS; the same when the reader plays on, or looks around (the follow
// lock), during one. A dropped wait's move is never made late: the walk goes to what is said now.

import * as vscode from 'vscode'

/** The heads-up shows this long (s) before a move. */
export const CUE_LEAD_S = 0.8

/** After asking the audio to hold, its time may still move this long (ms): then it did not stop. */
export const PAUSE_CHECK_MS = 250
/** After a hold that did not stop the audio, no waits for this long (ms): the moves go at once. */
export const WAITS_OFF_MS = 30000

/** What the player does for the camera: hold the audio, play on, where the audio is (its own reports), the walk put
 *  where the audio is now, the log. */
export interface CameraHost {
  hold(): void
  resume(): void
  /** The audio's time now (s) and whether it is playing, from its last report. */
  audio(): { t: number; playing: boolean }
  resync(): void
  log(line: string): void
}

/** How a wait ended: its time ran out; the reader played on or looked around (`skip`, `release`: the walk goes to
 *  the audio's time); the audio did not stop (`abandon`: the same); a seek, a pause, the session over (`cancel`). */
type End = 'time' | 'skip' | 'release' | 'abandon' | 'cancel'

/** Seconds from a setting (0 or more; anything else: the default). */
function seconds(key: string, def: number): number {
  const v = vscode.workspace.getConfiguration('codeNotes.listen').get<number>(key)
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def
}
export const readBeforeMove = () => seconds('readBeforeMove', 2.5)
export const settleAfterMove = () => seconds('settleAfterMove', 0.8)

/** Where a move goes, from the editor on screen: "↓ 340", "↑ 212" (1-based lines) or "→ main.ts". */
export function cueText(e: vscode.TextEditor, uri: string, line: number): { text: string; line: number } | undefined {
  const vis = e.visibleRanges
  if (!vis.length) return undefined
  const first = vis[0].start.line, last = vis[vis.length - 1].end.line
  if (e.document.uri.toString() !== uri) return { text: `→ ${uri.split('/').pop()}`, line: last }
  if (vis.some((r) => line >= r.start.line && line <= r.end.line)) return undefined
  return line > last ? { text: `↓ ${line + 1}`, line: last } : { text: `↑ ${line + 1}`, line: first }
}

export class Camera implements vscode.Disposable {
  /** When the view on screen last lit something (a mark, a beat, a step arrived): ms. */
  private lastLit = 0
  /** A wait in progress: its stage, and how to end it early. */
  private wait: { stage: 'read' | 'settle'; end: (how: End) => void } | undefined
  /** The whole wait (both stages) is being made: a move meanwhile goes at once. */
  private busy = false
  /** No waits until then (ms): the audio did not hold the last time. */
  private offUntil = 0
  private saidAbandon = false
  /** How the wait ends, asked between its stages (while the move is made). */
  private pendingEnd: End | undefined
  private checkTimer: NodeJS.Timeout | undefined
  /** The audio resumed by the camera itself (its own play report is not the reader's ▶). */
  private resuming = false
  private readonly cueDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' },
    isWholeLine: true,
  })
  private cueOn: { editor: vscode.TextEditor; text: string; uri: string; line: number } | undefined
  private readonly subs: vscode.Disposable[]
  private cueTimer: NodeJS.Timeout | undefined
  /** The waits made (tests, the log): where, how long each stage was (s), how it ended (`waiting`: not yet). */
  readonly waits: { where: string; read: number; settle: number; ended: string }[] = []

  constructor(private readonly host: CameraHost) {
    // The reader scrolled the target into view meanwhile: no heads-up needed any more.
    this.subs = [vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const c = this.cueOn
      if (c && e.textEditor === c.editor && !cueText(c.editor, c.uri, c.line)) this.clearCue()
    })]
  }

  /** The view on screen lit something now. */
  lit(): void { this.lastLit = Date.now() }

  get waiting(): 'read' | 'settle' | undefined { return this.busy ? this.wait?.stage ?? 'settle' : undefined }
  get cue(): string | undefined { return this.cueOn?.text }

  /**
   * A camera move: `go` makes it. With `wait`, first the read time left (the view's latest light must have been on
   * screen readBeforeMove s), then the move, then settleAfterMove s; the audio paused meanwhile, said in the player.
   */
  async move(go: () => Promise<void>, where: string, wait: boolean): Promise<void> {
    this.clearCue()
    const read = Math.max(0, readBeforeMove() * 1000 - (Date.now() - this.lastLit))
    const settle = settleAfterMove() * 1000
    if (!wait || this.busy || (read <= 0 && settle <= 0) || Date.now() < this.offUntil) {
      await go()
      this.lit()
      return
    }
    const rec = { where, read: 0, settle: 0, ended: 'waiting' }
    this.waits.push(rec)
    if (this.waits.length > 50) this.waits.shift()
    this.busy = true
    this.pendingEnd = undefined
    // The audio holds; whether it did is what it says itself: still moving a moment later, the wait is dropped.
    const from = this.host.audio().t
    this.host.hold()
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined
      const a = this.host.audio()
      if (a.playing && a.t - from > 0.1) this.end('abandon')
    }, PAUSE_CHECK_MS)
    let how: End = 'time'
    try {
      const t0 = Date.now()
      how = await this.sleep('read', read)
      rec.read = (Date.now() - t0) / 1000
      if (how === 'time') {
        await go()
        this.lit()
        const t1 = Date.now()
        // The check still runs while it settles (a read time of 0 asks and moves at once).
        how = await this.sleep('settle', Math.max(settle, this.checkTimer ? PAUSE_CHECK_MS : 0))
        rec.settle = (Date.now() - t1) / 1000
      }
    } finally {
      clearTimeout(this.checkTimer)
      this.checkTimer = undefined
      this.busy = false
      this.pendingEnd = undefined
      rec.ended = how
    }
    if (how === 'cancel') return
    // Played on (the camera's own resume is not the reader's ▶); `unhold` does nothing when the audio plays already
    // (the reader played on, or it never stopped).
    if (how === 'time' || how === 'release') this.resuming = true
    this.host.resume()
    if (how === 'time') {
      this.host.log(`podcast: waited ${rec.read.toFixed(1)} + ${rec.settle.toFixed(1)} s to move ${where}`)
      return
    }
    if (how === 'abandon') {
      this.offUntil = Date.now() + WAITS_OFF_MS
      if (!this.saidAbandon) {
        this.saidAbandon = true
        this.host.log(`podcast: the audio did not stop for a camera wait (to move ${where}); the code follows it without waiting for ${WAITS_OFF_MS / 1000} s`)
      }
    }
    // The move that waited is not made late: the walk goes to what the audio says now.
    this.host.resync()
  }

  /** Ends the wait in progress now, or between its stages (while its move is made). */
  private end(how: End): void {
    if (this.wait) this.wait.end(how)
    else if (this.busy && !this.pendingEnd) this.pendingEnd = how
  }

  private sleep(stage: 'read' | 'settle', ms: number): Promise<End> {
    if (this.pendingEnd) return Promise.resolve(this.pendingEnd)
    if (ms <= 0) return Promise.resolve('time')
    return new Promise((resolve) => {
      const timer = setTimeout(() => done('time'), ms)
      const done = (how: End) => {
        clearTimeout(timer)
        if (this.wait === w) this.wait = undefined
        resolve(how)
      }
      const w = { stage, end: done }
      this.wait = w
    })
  }

  /** The audio reported playing: the camera's own resume, or the reader playing on during a wait (it ends the wait;
   *  the walk goes to the audio's time). */
  played(): void {
    if (this.resuming) { this.resuming = false; return }
    this.end('skip')
  }

  /** The reader looked around in the code during a wait (the follow lock opened): it plays on, nothing waits. */
  release(): void {
    this.end('release')
  }

  /** A seek, the reader's pause, the session over, the walk elsewhere: a wait in progress is dropped (nothing moves,
   *  nothing resumes). */
  cancel(): void {
    this.resuming = false
    this.end('cancel')
    this.clearCue()
  }

  /** A new session, or a seek: waits are on again. */
  reset(): void {
    this.offUntil = 0
    this.saidAbandon = false
  }

  /** The heads-up at `at` ms from now in editor `e` (pointing at `uri`, 0-based `line`) when it is still out of view
   *  then; `ok()`: still worth showing (playing, following). */
  scheduleCue(ms: number, editor: () => vscode.TextEditor | undefined, uri: string, line: number, ok: () => boolean): void {
    clearTimeout(this.cueTimer)
    this.cueTimer = setTimeout(() => {
      const e = editor()
      if (!e || !ok()) return
      const c = cueText(e, uri, line)
      if (!c) return
      const lineText = e.document.lineAt(Math.min(c.line, e.document.lineCount - 1))
      e.setDecorations(this.cueDeco, [{ range: lineText.range, renderOptions: { after: { contentText: c.text } } }])
      this.cueOn = { editor: e, text: c.text, uri, line }
    }, Math.max(0, ms))
  }

  /** No cue shown or waiting. */
  clearCue(): void {
    clearTimeout(this.cueTimer)
    this.cueTimer = undefined
    if (!this.cueOn) return
    this.cueOn.editor.setDecorations(this.cueDeco, [])
    this.cueOn = undefined
  }

  dispose(): void {
    this.cancel()
    for (const d of this.subs) d.dispose()
    this.cueDeco.dispose()
  }
}
