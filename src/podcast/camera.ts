// Camera moves while a podcast plays (docs/podcast-format.md, "Camera moves"): the heads-up cue at the editor's edge,
// and the wait around a move (read, the move, settle) during which the audio holds. The rules are cameraRules.ts.

import * as vscode from 'vscode'
import { cfg } from '../platform/settings'
import { afterWait, audioKeptPlaying, ListenSettings, listenSettingsFrom, PAUSE_CHECK_MS, WaitEnd, WAITS_OFF_MS } from './cameraRules'

export { CUE_LEAD_S } from './cameraRules'

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

/** The listen settings (`codeNotes.listen.*`). */
export const listenSettings = (): ListenSettings => listenSettingsFrom((key) => cfg().get(`listen.${key}`))

/** Where a move goes, from the editor on screen: "↓ 340", "↑ 212" (1-based lines) or "→ main.ts". */
export function cueText(e: vscode.TextEditor, uri: string, line: number): { text: string; line: number } | undefined {
  const vis = e.visibleRanges
  if (!vis.length) return undefined
  const first = vis[0].start.line, last = vis[vis.length - 1].end.line
  if (e.document.uri.toString() !== uri) return { text: `→ ${uri.split('/').pop()}`, line: last }
  if (vis.some((r) => line >= r.start.line && line <= r.end.line)) return undefined
  return line > last ? { text: `↓ ${line + 1}`, line: last } : { text: `↑ ${line + 1}`, line: first }
}

/** A wait: none; sleeping through its read or settle stage (`end` cuts it short); or between them, the move being
 *  made (`ended`: how it was asked to end meanwhile). */
type WaitState =
  | { at: 'none' }
  | { at: 'read' | 'settle'; end: (how: WaitEnd) => void }
  | { at: 'moving'; ended?: WaitEnd }

/** A wait as recorded (the log, the integration tests): where, how long each stage was (s), how it ended. */
export interface WaitRecord { where: string; read: number; settle: number; ended: WaitEnd | 'waiting' }

export class Camera implements vscode.Disposable {
  /** When the view on screen last lit something (a mark, a beat, a step arrived): ms. */
  private lastLit = 0
  private wait: WaitState = { at: 'none' }
  /** Checks, PAUSE_CHECK_MS after the hold was asked, that the audio stopped. */
  private checkTimer: NodeJS.Timeout | undefined
  /** No waits until then (ms): the audio did not hold the last time; said once. */
  private offUntil = 0
  private saidAbandon = false
  /** The audio resumed by the camera itself: its own play report is not the reader's ▶. */
  private resuming = false
  private readonly cueDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' },
    isWholeLine: true,
  })
  private cueOn: { editor: vscode.TextEditor; text: string; uri: string; line: number } | undefined
  private cueTimer: NodeJS.Timeout | undefined
  private readonly subs: vscode.Disposable[]
  /** The last waits made, newest last. */
  readonly waits: WaitRecord[] = []

  constructor(private readonly host: CameraHost) {
    // The reader scrolled the target into view meanwhile: no heads-up needed any more.
    this.subs = [vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const c = this.cueOn
      if (c && e.textEditor === c.editor && !cueText(c.editor, c.uri, c.line)) this.clearCue()
    })]
  }

  /** The view on screen lit something now. */
  lit(): void { this.lastLit = Date.now() }

  get waiting(): 'read' | 'settle' | undefined {
    const w = this.wait
    return w.at === 'none' ? undefined : w.at === 'read' ? 'read' : 'settle'
  }
  get cue(): string | undefined { return this.cueOn?.text }

  /**
   * A camera move: `go` makes it. With `wait`, first the read time left (the view's latest light must have been on
   * screen readBeforeMove s), then the move, then settleAfterMove s; the audio holds meanwhile.
   */
  async move(go: () => Promise<void>, where: string, wait: boolean): Promise<void> {
    this.clearCue()
    const s = listenSettings()
    const read = Math.max(0, s.readBeforeMove * 1000 - (Date.now() - this.lastLit))
    const settle = s.settleAfterMove * 1000
    if (!wait || this.wait.at !== 'none' || (read <= 0 && settle <= 0) || Date.now() < this.offUntil) {
      await go()
      this.lit()
      return
    }
    const rec: WaitRecord = { where, read: 0, settle: 0, ended: 'waiting' }
    this.waits.push(rec)
    if (this.waits.length > 50) this.waits.shift()
    this.wait = { at: 'moving' }
    this.holdAudio()
    let how: WaitEnd = 'time'
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
      this.wait = { at: 'none' }
      rec.ended = how
    }
    this.ended(how, rec)
  }

  /** The audio holds; whether it did is what it says itself: still moving a moment later, the wait is dropped. */
  private holdAudio(): void {
    const from = this.host.audio().t
    this.host.hold()
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined
      if (audioKeptPlaying(from, this.host.audio())) this.end('abandon')
    }, PAUSE_CHECK_MS)
  }

  /** What follows a wait that ended `how` (cameraRules.ts afterWait). `unhold` does nothing when the audio plays
   *  already (the reader played on, or it never stopped). */
  private ended(how: WaitEnd, rec: WaitRecord): void {
    const next = afterWait(how)
    if (!next.resume) return
    if (next.ownResume) this.resuming = true
    this.host.resume()
    if (how === 'time') this.host.log(`podcast: waited ${rec.read.toFixed(1)} + ${rec.settle.toFixed(1)} s to move ${rec.where}`)
    if (next.backOff) {
      this.offUntil = Date.now() + WAITS_OFF_MS
      if (!this.saidAbandon) {
        this.saidAbandon = true
        this.host.log(`podcast: the audio did not stop for a camera wait (to move ${rec.where}); the code follows it without waiting for ${WAITS_OFF_MS / 1000} s`)
      }
    }
    if (next.resync) this.host.resync()
  }

  /** Ends the wait in progress now, or once its move is made. */
  private end(how: WaitEnd): void {
    const w = this.wait
    if (w.at === 'read' || w.at === 'settle') w.end(how)
    else if (w.at === 'moving' && !w.ended) w.ended = how
  }

  private sleep(stage: 'read' | 'settle', ms: number): Promise<WaitEnd> {
    const w = this.wait
    if (w.at === 'moving' && w.ended) return Promise.resolve(w.ended)
    if (ms <= 0) return Promise.resolve('time')
    return new Promise((resolve) => {
      const timer = setTimeout(() => done('time'), ms)
      const done = (how: WaitEnd) => {
        clearTimeout(timer)
        if (this.wait === sleeping) this.wait = { at: 'moving' }
        resolve(how)
      }
      const sleeping: WaitState = { at: stage, end: done }
      this.wait = sleeping
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
   *  nothing resumes), and the heads-up with it. */
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

  /** The heads-up in `editor` in `ms` (pointing at `uri`, 0-based `line`) if that is still out of view then; no
   *  editor: none due (the one scheduled is dropped). The player clears it (clearCue, cancel) when it stops being worth
   *  showing. */
  scheduleCue(ms: number, editor: vscode.TextEditor | undefined, uri: string, line: number): void {
    clearTimeout(this.cueTimer)
    this.cueTimer = undefined
    if (!editor) return
    this.cueTimer = setTimeout(() => {
      this.cueTimer = undefined
      if (!vscode.window.visibleTextEditors.includes(editor)) return
      const c = cueText(editor, uri, line)
      if (!c) return
      const lineText = editor.document.lineAt(Math.min(c.line, editor.document.lineCount - 1))
      editor.setDecorations(this.cueDeco, [{ range: lineText.range, renderOptions: { after: { contentText: c.text } } }])
      this.cueOn = { editor, text: c.text, uri, line }
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
