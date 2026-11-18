// Camera moves (docs/podcast-format.md, "Camera moves"): while a podcast plays, the narrated editor scrolls or
// switches files when the next mark or beat is out of view. Quick moves leave no time to read what was just lit, so
// every such move goes through here: a heads-up cue at the editor's edge shortly before ("↓ 340", "↑ 212",
// "→ main.ts"); before leaving, the latest mark or beat of the view on screen must have been lit READ seconds (the
// audio waits, saying so in the player); after arriving, the audio waits SETTLE seconds more with the new mark lit.
// ▶ or Space during a wait skips it. No waits for the reader's own seeks, under the follow lock, or on the map: the
// player decides that (`move`'s `wait`).

import * as vscode from 'vscode'

/** The heads-up shows this long (s) before a move. */
export const CUE_LEAD_S = 0.8

/** What the player does for the camera: pause the audio, play on, the player's quiet note line, the log. */
export interface CameraHost {
  pause(): void
  resume(): void
  note(text: string): void
  log(line: string): void
}

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
  /** A wait in progress: its stage, and how to end it early (`skipped`: the reader played on; else cancelled). */
  private wait: { stage: 'read' | 'settle'; end: (how: 'time' | 'skip' | 'cancel') => void; ended?: 'time' | 'skip' | 'cancel' } | undefined
  /** The audio resumed by the camera itself (its own play report is not the reader's ▶). */
  private resuming = false
  private readonly cueDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' },
    isWholeLine: true,
  })
  private cueOn: { editor: vscode.TextEditor; text: string; uri: string; line: number } | undefined
  private readonly subs: vscode.Disposable[]
  private cueTimer: NodeJS.Timeout | undefined
  /** The waits made (tests, the log): where, how long each stage was (s), how it ended. */
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

  get waiting(): 'read' | 'settle' | undefined { return this.wait?.stage }
  get cue(): string | undefined { return this.cueOn?.text }

  /**
   * A camera move: `go` makes it. With `wait`, first the read time left (the view's latest light must have been on
   * screen readBeforeMove s), then the move, then settleAfterMove s; the audio paused meanwhile, said in the player.
   */
  async move(go: () => Promise<void>, where: string, wait: boolean): Promise<void> {
    this.clearCue()
    const read = Math.max(0, readBeforeMove() * 1000 - (Date.now() - this.lastLit))
    const settle = settleAfterMove() * 1000
    if (!wait || this.wait || (read <= 0 && settle <= 0)) {
      await go()
      this.lit()
      return
    }
    const rec = { where, read: 0, settle: 0, ended: 'time' }
    this.waits.push(rec)
    if (this.waits.length > 50) this.waits.shift()
    this.host.pause()
    this.host.note(`Waiting to move ${where} · ▶ goes on`)
    const t0 = Date.now()
    let how = await this.sleep('read', read)
    rec.read = (Date.now() - t0) / 1000
    if (how === 'cancel') { rec.ended = 'cancel'; this.host.note(''); return }
    await go()
    this.lit()
    if (how === 'skip') { rec.ended = 'skip'; this.host.note(''); return }
    const t1 = Date.now()
    how = await this.sleep('settle', settle)
    rec.settle = (Date.now() - t1) / 1000
    rec.ended = how
    this.host.note('')
    if (how !== 'time') return
    this.resuming = true
    this.host.resume()
    this.host.log(`podcast: waited ${rec.read.toFixed(1)} + ${rec.settle.toFixed(1)} s to move ${where}`)
  }

  private sleep(stage: 'read' | 'settle', ms: number): Promise<'time' | 'skip' | 'cancel'> {
    if (ms <= 0) return Promise.resolve('time')
    return new Promise((resolve) => {
      const timer = setTimeout(() => done('time'), ms)
      const done = (how: 'time' | 'skip' | 'cancel') => {
        clearTimeout(timer)
        if (this.wait === w) this.wait = undefined
        resolve(how)
      }
      const w = { stage, end: done }
      this.wait = w
    })
  }

  /** The audio reported playing: the camera's own resume, or the reader's ▶ during a wait (it skips the wait). */
  played(): void {
    if (this.resuming) { this.resuming = false; return }
    this.wait?.end('skip')
  }

  /** A seek, the session over, the walk elsewhere: a wait in progress is dropped (nothing moves, nothing resumes). */
  cancel(): void {
    this.resuming = false
    this.wait?.end('cancel')
    this.clearCue()
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
