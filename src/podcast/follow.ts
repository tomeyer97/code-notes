// The follow lock (docs/podcast-format.md, "Reading around while it plays"): while a podcast plays, the editor follows
// the voice. When the reader scrolls, clicks or types in the narrated code themselves, it stops following: beats are
// still lit where they are, but nothing scrolls or opens under the reader; the step card says "Follow along" to snap
// back, and the next step locks it again. The extension's own moves (a step opening, a beat brought on screen) are told
// apart by a short window after each one.

import * as vscode from 'vscode'

/** After a move of the extension's own, editor changes for this long are its own (a step opening settles, then its
 *  card is brought into view: see walk.ts keepCardInView). */
const OWN_MOVE_MS = 1500
/** A scroll by the reader moves the first visible line at least this far (a resize or a fold moves it less). */
const SCROLL_LINES = 3

export class FollowLock implements vscode.Disposable {
  /** The editor follows the voice. */
  locked = true
  private ownUntil = 0
  /** The first visible line of each editor where the extension last left it (to see a scroll: the reader's scroll
   *  is measured from there, so a slow scroll in small steps counts too). */
  private tops = new WeakMap<vscode.TextEditor, number>()
  private readonly subs: vscode.Disposable[] = []

  /**
   * `active`: a podcast plays and the walk follows it; `narrated(e)`: `e` shows the walk's code (not the panel, not
   * another group the reader works in); `changed`: the lock was opened or closed.
   */
  constructor(private readonly active: () => boolean, private readonly narrated: (e: vscode.TextEditor) => boolean, private readonly changed: () => void) {
    this.subs.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const byReader = e.kind === vscode.TextEditorSelectionChangeKind.Mouse || e.kind === vscode.TextEditorSelectionChangeKind.Keyboard
        if (byReader) this.readerMoved(e.textEditor, 'clicked')
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const top = e.visibleRanges[0]?.start.line ?? 0
        const was = this.tops.get(e.textEditor)
        // The extension's own moves (and the first sight of an editor, or any scroll while it does not follow) set where
        // it was left; the reader's scroll is measured from there.
        if (was === undefined || Date.now() < this.ownUntil || !this.locked || !this.active() || !this.narrated(e.textEditor)) { this.tops.set(e.textEditor, top); return }
        if (Math.abs(top - was) >= SCROLL_LINES) { this.tops.set(e.textEditor, top); this.readerMoved(e.textEditor, 'scrolled') }
      }),
    )
  }

  /** The extension moves the editor now (and for a moment after): not the reader. */
  ourMove(): void {
    this.ownUntil = Date.now() + OWN_MOVE_MS
  }

  /** Follow again (a new step, the map, "Follow along"). */
  relock(): void {
    if (this.locked) return
    this.locked = true
    this.changed()
  }

  /** The reader moved in the narrated code: the editor stops following until the next step. */
  private readerMoved(e: vscode.TextEditor, how: string): void {
    if (!this.locked || Date.now() < this.ownUntil || !this.active() || !this.narrated(e)) return
    this.locked = false
    this.lastUnlock = how
    this.changed()
  }

  /** How the reader last opened the lock (tests, the log). */
  lastUnlock = ''

  dispose(): void { for (const s of this.subs) s.dispose() }
}
